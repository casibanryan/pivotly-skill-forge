/**
 * OIDC sign-in for pivotly-skill-forge.
 *
 * Authorization Code + PKCE against Pivotly's Microsoft Entra ID tenant, using the same
 * public client the Portal frontend and the pivotly-backend plugin use. The flow:
 *
 *   forge_auth_login → loopback HTTP server on the registered redirect port
 *                    → system browser opens the Microsoft sign-in page
 *                    → redirect lands on the loopback with ?code=…&state=…
 *                    → code exchanged for tokens at the token endpoint (PKCE verifier proves
 *                      it was this process that started the flow; no client secret exists)
 *                    → tokens cached at TOKEN_CACHE_PATH, mode 600
 *
 * `offline_access` in the scope yields a refresh token, so after the first sign-in every
 * later session is silent: an expired access token is refreshed without a browser. A
 * refresh that the IdP rejects (revoked, expired after ~90 days idle, password changed)
 * drops the cache and asks for one more browser round-trip.
 *
 * Implemented with Node built-ins only (crypto, http, fetch) so the committed bundle stays
 * dependency-free. The token response arrives over TLS straight from the issuer's token
 * endpoint and is bound to our PKCE verifier, so the id_token is checked for nonce, aud and
 * iss but its signature is not independently verified here — the backend verifies every
 * access token against the tenant's JWKS on each request, which is the check that matters.
 *
 * stdout is the JSON-RPC transport. Everything diagnostic goes to stderr.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import {
  OIDC_REDIRECT_FALLBACK_PORTS,
  TOKEN_CACHE_PATH,
  getSessionToken,
  idHint,
  loadConfig,
  type Config,
} from "./config.js";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface AccountInfo {
  name?: string;
  email?: string;
  oid?: string;
  sub?: string;
  tid?: string;
}

export interface TokenCache {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  scope?: string;
  /** Epoch seconds. */
  expires_at: number;
  /** Epoch seconds. */
  obtained_at: number;
  issuer: string;
  client_id: string;
  account?: AccountInfo;
}

interface Metadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number | string;
  scope?: string;
  refresh_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

export type TokenSource = "session" | "env" | "cache" | "refresh";

export type AcquireResult =
  | { ok: true; token: string; source: TokenSource; account?: AccountInfo; expires_in_s?: number }
  | { ok: false; needs_login: true; reason: string; detail?: string };

export type LoginOutcome = { ok: true; cache: TokenCache } | { ok: false; error: string; hint?: string; aad_code?: string };

export interface PendingLogin {
  auth_url: string;
  redirect_uri: string;
  browser_opened: boolean;
  started_at: number;
  deadline: number;
  promise: Promise<TokenCache>;
  outcome?: LoginOutcome;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Refresh this long before nominal expiry so an in-flight request never straddles it. */
const SKEW_S = 60;
/** How long the loopback server waits for the developer to finish signing in. */
export const LOGIN_TIMEOUT_MS = 300_000;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15_000;

const log = (line: string) => console.error(`[skill-forge][auth] ${line}`);

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const b64url = (buf: Buffer) => buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const nowS = () => Math.floor(Date.now() / 1000);

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function accountFromClaims(claims: Record<string, unknown> | null): AccountInfo | undefined {
  if (!claims) return undefined;
  const str = (k: string) => (typeof claims[k] === "string" ? (claims[k] as string) : undefined);
  const emails = Array.isArray(claims.emails) ? (claims.emails as unknown[]).find((e) => typeof e === "string") : undefined;
  const preferred = str("preferred_username");
  const email = str("email") ?? str("upn") ?? str("unique_name") ?? (preferred && preferred.includes("@") ? preferred : undefined) ?? (emails as string | undefined);
  const out: AccountInfo = { name: str("name"), email, oid: str("oid"), sub: str("sub"), tid: str("tid") };
  return Object.values(out).some(Boolean) ? out : undefined;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = HTTP_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------------ */
/* AADSTS error explanations                                          */
/* ------------------------------------------------------------------ */

/**
 * Microsoft's error codes are precise but terse. These are the ones a developer can actually
 * hit with this flow, each with the fix rather than a restatement of the code.
 */
const AAD_HINTS: Array<[RegExp, string]> = [
  [/AADSTS50011/, "The redirect URI is not registered on the app. It must be listed under 'Mobile and desktop applications' (a public client), exactly as used, e.g. http://localhost:8642/callback. Try forge_config_set(oidc_redirect_uri: 'http://localhost:53682/callback') if that port is the registered one."],
  [/AADSTS9002327/, "The redirect URI is registered as a Single-Page Application, whose codes can only be redeemed cross-origin from a browser. A native client needs it under 'Mobile and desktop applications' instead."],
  [/AADSTS7000218/, "The app registration requires a client secret. Enable 'Allow public client flows' on the registration (Authentication → Advanced settings) — a plugin has no secret to send."],
  [/AADSTS6500[14]/, "Consent was not granted for the requested scope. Sign in again and accept the consent prompt, or ask an admin to grant it for the tenant."],
  [/AADSTS70011|AADSTS650053|invalid_scope/, "The requested scope is not valid for this app. Check oidc_scopes — the API scope must be spelled exactly as the registration exposes it."],
  [/AADSTS70008|AADSTS50173|AADSTS700082|AADSTS50076|AADSTS50079|AADSTS50158|interaction_required|invalid_grant/, "The saved sign-in is no longer valid (expired, revoked, or extra verification is now required). A fresh browser sign-in fixes it."],
  [/AADSTS900144/, "A required parameter was missing from the authorization request — usually a shell mangled the URL at '&'. Open the auth_url from this tool's output directly rather than via a shell."],
  [/AADSTS50020|AADSTS50034|AADSTS90072/, "That account does not belong to the Pivotly tenant. Sign in with a Pivotly work account."],
  [/AADSTS16000|AADSTS50105|AADSTS50131/, "The account is not assigned to this app or is blocked by a Conditional Access policy. Ask an admin to assign the user to the app registration."],
];

export function explainAadError(...texts: Array<string | undefined>): { code?: string; hint?: string } {
  const joined = texts.filter(Boolean).join(" ");
  const code = /AADSTS\d+/.exec(joined)?.[0];
  for (const [re, hint] of AAD_HINTS) if (re.test(joined)) return { code, hint };
  return { code };
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

const metadataCache = new Map<string, { at: number; meta: Metadata }>();

export async function discover(issuer: string): Promise<Metadata> {
  const key = issuer.replace(/\/+$/, "");
  const hit = metadataCache.get(key);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.meta;

  const url = `${key}/.well-known/openid-configuration`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, { headers: { Accept: "application/json" } });
  } catch (e) {
    throw new Error(`Could not reach the identity provider for discovery at ${url}: ${e instanceof Error ? e.message : String(e)}. Check network/VPN.`);
  }
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status} from ${url}. Check oidc_issuer.`);
  const doc = (await res.json()) as Partial<Metadata>;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.issuer) {
    throw new Error(`OIDC discovery document at ${url} is missing authorization_endpoint/token_endpoint/issuer.`);
  }
  const meta: Metadata = {
    issuer: doc.issuer,
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    end_session_endpoint: doc.end_session_endpoint,
  };
  metadataCache.set(key, { at: Date.now(), meta });
  return meta;
}

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

/** The last cache seen by this process, kept so redaction covers tokens even after logout. */
let lastCache: TokenCache | null = null;

function isCacheShape(v: unknown): v is TokenCache {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return typeof c.access_token === "string" && typeof c.expires_at === "number" && typeof c.issuer === "string" && typeof c.client_id === "string";
}

/**
 * Read the cache if it exists and belongs to the configured registration. A cache from a
 * different issuer or client (a developer switched tenants) is reported as absent rather
 * than used, so the next acquire falls through to a fresh sign-in instead of sending a
 * token the backend will refuse.
 */
export function readCache(cfg: Config = loadConfig()): TokenCache | null {
  try {
    if (!existsSync(TOKEN_CACHE_PATH)) return null;
    const parsed = JSON.parse(readFileSync(TOKEN_CACHE_PATH, "utf8")) as unknown;
    if (!isCacheShape(parsed)) return null;
    lastCache = parsed;
    if (parsed.issuer.replace(/\/+$/, "") !== cfg.oidc.issuer.value || parsed.client_id !== cfg.oidc.clientId.value) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(cache: TokenCache): void {
  mkdirSync(dirname(TOKEN_CACHE_PATH), { recursive: true });
  writeFileSync(TOKEN_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(TOKEN_CACHE_PATH, 0o600);
  } catch {
    /* Windows: no-op */
  }
  lastCache = cache;
}

/** Returns true when a file was actually removed. */
export function clearCache(): boolean {
  try {
    if (!existsSync(TOKEN_CACHE_PATH)) return false;
    rmSync(TOKEN_CACHE_PATH, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function isFresh(cache: TokenCache | null): boolean {
  return Boolean(cache && cache.access_token && cache.expires_at - SKEW_S > nowS());
}

/** Every token this process has seen, for output redaction. Never returned to the model. */
export function redactionSecrets(): string[] {
  const out = new Set<string>();
  const cfg = loadConfig();
  if (cfg.token.value) out.add(cfg.token.value);
  const s = getSessionToken();
  if (s) out.add(s);
  for (const c of [lastCache, readCache(cfg)]) {
    if (!c) continue;
    for (const v of [c.access_token, c.refresh_token, c.id_token]) if (v && v.length >= 8) out.add(v);
  }
  return [...out];
}

/* ------------------------------------------------------------------ */
/* Token endpoint                                                      */
/* ------------------------------------------------------------------ */

async function tokenRequest(meta: Metadata, form: Record<string, string>): Promise<TokenResponse> {
  const body = new URLSearchParams(form).toString();
  let res: Response;
  try {
    res = await fetchWithTimeout(meta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
  } catch (e) {
    throw new Error(`Token endpoint unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let json: TokenResponse = {};
  try {
    json = JSON.parse(text) as TokenResponse;
  } catch {
    /* fall through to the status check */
  }
  if (!res.ok || json.error) {
    const err = new Error(`${json.error ?? `HTTP ${res.status}`}${json.error_description ? `: ${json.error_description}` : ""}`);
    (err as Error & { oauth_error?: string }).oauth_error = json.error ?? `http_${res.status}`;
    throw err;
  }
  return json;
}

function toCache(t: TokenResponse, cfg: Config, meta: Metadata, previous?: TokenCache): TokenCache {
  if (!t.access_token) throw new Error("Token response had no access_token.");
  if (t.token_type && !/^bearer$/i.test(t.token_type)) throw new Error(`Unexpected token_type '${t.token_type}' (expected Bearer).`);
  const expiresIn = Number(t.expires_in ?? 3600);
  const idClaims = t.id_token ? decodeJwtPayload(t.id_token) : null;
  const account = accountFromClaims(idClaims) ?? previous?.account ?? accountFromClaims(decodeJwtPayload(t.access_token));
  return {
    access_token: t.access_token,
    // Entra rotates refresh tokens; when a response omits one, the previous stays valid.
    refresh_token: t.refresh_token ?? previous?.refresh_token,
    id_token: t.id_token ?? previous?.id_token,
    token_type: "Bearer",
    scope: t.scope ?? previous?.scope ?? cfg.oidc.scopes.value,
    expires_at: nowS() + (Number.isFinite(expiresIn) ? expiresIn : 3600),
    obtained_at: nowS(),
    issuer: meta.issuer.replace(/\/+$/, "") === cfg.oidc.issuer.value ? cfg.oidc.issuer.value : cfg.oidc.issuer.value,
    client_id: cfg.oidc.clientId.value,
    account,
  };
}

/* ------------------------------------------------------------------ */
/* Refresh                                                             */
/* ------------------------------------------------------------------ */

let refreshing: Promise<TokenCache> | null = null;

async function refresh(cache: TokenCache, cfg: Config): Promise<TokenCache> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const meta = await discover(cfg.oidc.issuer.value);
    const t = await tokenRequest(meta, {
      grant_type: "refresh_token",
      client_id: cfg.oidc.clientId.value,
      refresh_token: cache.refresh_token as string,
      scope: cfg.oidc.scopes.value,
    });
    const next = toCache(t, cfg, meta, cache);
    writeCache(next);
    log(`access token refreshed silently; expires in ${next.expires_at - nowS()}s`);
    return next;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/* ------------------------------------------------------------------ */
/* Acquire                                                             */
/* ------------------------------------------------------------------ */

/**
 * Get a usable access token without any UI. Order: manual override (session paste / env) →
 * fresh cache → silent refresh. Never opens a browser: interactive sign-in is an explicit
 * tool call, so a browser window is never a surprise side effect of an ordinary request.
 */
export async function acquireToken(cfg: Config = loadConfig(), opts: { forceRefresh?: boolean } = {}): Promise<AcquireResult> {
  if (cfg.token.value) return { ok: true, token: cfg.token.value, source: cfg.token.source === "session" ? "session" : "env" };

  const cache = readCache(cfg);
  if (!cache) {
    const raw = existsSync(TOKEN_CACHE_PATH);
    return {
      ok: false,
      needs_login: true,
      reason: raw
        ? "A saved sign-in exists but belongs to a different issuer/client than the current OIDC settings."
        : "Not signed in yet.",
    };
  }
  if (isFresh(cache) && !opts.forceRefresh) {
    return { ok: true, token: cache.access_token, source: "cache", account: cache.account, expires_in_s: cache.expires_at - nowS() };
  }
  if (!cache.refresh_token) {
    return { ok: false, needs_login: true, reason: "The saved access token has expired and no refresh token was issued (scopes lacked offline_access)." };
  }
  try {
    const next = await refresh(cache, cfg);
    return { ok: true, token: next.access_token, source: "refresh", account: next.account, expires_in_s: next.expires_at - nowS() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const oauth = (e as { oauth_error?: string }).oauth_error;
    // invalid_grant means the refresh token itself is dead; keeping it would fail forever.
    if (oauth === "invalid_grant" || /AADSTS/.test(msg)) {
      clearCache();
      const { hint } = explainAadError(msg);
      return { ok: false, needs_login: true, reason: "The saved sign-in could not be refreshed and was discarded.", detail: hint ?? msg };
    }
    // Network / IdP outage: the cache is probably still good, keep it and report.
    return { ok: false, needs_login: true, reason: "Silent refresh failed (identity provider unreachable?).", detail: msg };
  }
}

/* ------------------------------------------------------------------ */
/* Interactive login                                                   */
/* ------------------------------------------------------------------ */

let pending: PendingLogin | null = null;

export function currentLogin(): PendingLogin | null {
  if (pending && !pending.outcome && Date.now() > pending.deadline + 5000) pending = null; // stale, never settled
  return pending;
}

function openBrowser(url: string): boolean {
  try {
    // Windows: rundll32, NOT `cmd /c start` — start splits the URL at '&' and drops scope/
    // redirect_uri (AADSTS900144). macOS: open. Elsewhere: xdg-open.
    const [cmd, args] =
      process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {
      /* reported through browser_opened=false at start; nothing more to do */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Bind the loopback listener on the configured port, falling back only to registered alternates. */
async function listenLoopback(hostname: string, ports: number[]): Promise<{ server: Server; port: number }> {
  let lastErr: unknown;
  for (const port of ports) {
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, hostname, () => resolve());
      });
      return { server, port };
    } catch (e) {
      lastErr = e;
      try {
        server.close();
      } catch {
        /* ignore */
      }
    }
  }
  const code = (lastErr as { code?: string })?.code;
  throw new Error(
    code === "EADDRINUSE"
      ? `Ports ${ports.join(", ")} are all in use. Another sign-in may still be waiting (finish or cancel it), or another app holds the port.`
      : `Could not open the loopback redirect listener on ${hostname}:${ports.join("|")}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

const CALLBACK_PAGE = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;line-height:1.5"><h2>${title}</h2><p>${body}</p></body></html>`;

/**
 * Start an interactive sign-in. Idempotent: while one is pending, returns it instead of
 * opening a second browser tab. The returned promise settles when the redirect arrives and
 * the code is exchanged, or when LOGIN_TIMEOUT_MS passes.
 */
export async function startLogin(cfg: Config, opts: { openBrowser?: boolean; selectAccount?: boolean } = {}): Promise<PendingLogin> {
  const existing = currentLogin();
  if (existing && !existing.outcome) return existing;

  const meta = await discover(cfg.oidc.issuer.value);
  const configured = new URL(cfg.oidc.redirectUri.value);
  const ports = [Number(configured.port), ...OIDC_REDIRECT_FALLBACK_PORTS.filter((p) => p !== Number(configured.port))];
  const { server, port } = await listenLoopback(configured.hostname, ports);
  const redirectUri = `${configured.protocol}//${configured.hostname}:${port}${configured.pathname}`;
  if (port !== Number(configured.port)) log(`configured redirect port ${configured.port} unavailable; using registered alternate ${port}`);

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));

  const authUrl = new URL(meta.authorization_endpoint);
  const params: Record<string, string> = {
    client_id: cfg.oidc.clientId.value,
    response_type: "code",
    response_mode: "query",
    redirect_uri: redirectUri,
    scope: cfg.oidc.scopes.value,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  if (opts.selectAccount) params.prompt = "select_account";
  for (const [k, v] of Object.entries(params)) authUrl.searchParams.set(k, v);

  const startedAt = Date.now();
  const deadline = startedAt + LOGIN_TIMEOUT_MS;

  const promise = new Promise<TokenCache>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("No sign-in completed within 5 minutes. Call forge_auth_login again to start over."))), LOGIN_TIMEOUT_MS);
    timer.unref();

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", `http://${configured.hostname}:${port}`);
      if (req.method !== "GET" || url.pathname !== configured.pathname) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
        return;
      }
      const q = url.searchParams;
      if (q.get("error")) {
        const desc = q.get("error_description") ?? "";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(CALLBACK_PAGE("Sign-in did not complete", "You can close this window and return to your editor."));
        finish(() => reject(Object.assign(new Error(`${q.get("error")}: ${desc}`), { oauth_error: q.get("error") })));
        return;
      }
      if (q.get("state") !== state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(CALLBACK_PAGE("Sign-in rejected", "State mismatch — this response did not come from the sign-in this plugin started."));
        // Do not settle: a stray/forged hit must not cancel the real one still in flight.
        return;
      }
      const code = q.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(CALLBACK_PAGE("Sign-in rejected", "No authorization code in the response."));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(CALLBACK_PAGE("Signed in to Pivotly", "You can close this window and return to your editor."));

      void (async () => {
        try {
          const t = await tokenRequest(meta, {
            grant_type: "authorization_code",
            client_id: cfg.oidc.clientId.value,
            code,
            redirect_uri: redirectUri,
            code_verifier: verifier,
            scope: cfg.oidc.scopes.value,
          });
          if (t.id_token) {
            const claims = decodeJwtPayload(t.id_token);
            if (!claims) throw new Error("id_token could not be decoded.");
            if (claims.nonce !== nonce) throw new Error("id_token nonce mismatch — response did not match this sign-in attempt.");
            if (claims.aud !== cfg.oidc.clientId.value) throw new Error(`id_token audience '${String(claims.aud)}' is not this client.`);
            if (typeof claims.iss === "string" && claims.iss.replace(/\/+$/, "") !== cfg.oidc.issuer.value) {
              throw new Error(`id_token issuer '${claims.iss}' does not match the configured issuer.`);
            }
          }
          const cache = toCache(t, cfg, meta);
          writeCache(cache);
          log(`signed in as ${cache.account?.email ?? cache.account?.name ?? "(unknown account)"}; access token expires in ${cache.expires_at - nowS()}s; refresh token ${cache.refresh_token ? "present" : "ABSENT"}`);
          finish(() => resolve(cache));
        } catch (e) {
          finish(() => reject(e));
        }
      })();
    });
  });

  const browserOpened = opts.openBrowser === false ? false : openBrowser(authUrl.toString());
  log(`sign-in started; redirect ${redirectUri}; browser ${browserOpened ? "opened" : "NOT opened"}`);
  if (!browserOpened) log(`open this URL manually: ${authUrl.toString()}`);

  const entry: PendingLogin = { auth_url: authUrl.toString(), redirect_uri: redirectUri, browser_opened: browserOpened, started_at: startedAt, deadline, promise };
  promise.then(
    (cache) => {
      entry.outcome = { ok: true, cache };
    },
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      const { code, hint } = explainAadError(msg);
      entry.outcome = { ok: false, error: msg, hint, aad_code: code };
    },
  );
  pending = entry;
  return entry;
}

/** Wait up to `ms` for a pending login to settle. Returns whether it did. */
export async function waitForLogin(p: PendingLogin, ms: number): Promise<boolean> {
  if (p.outcome) return true;
  await Promise.race([p.promise.catch(() => undefined), new Promise((r) => setTimeout(r, ms))]);
  return Boolean(p.outcome);
}

/** Drop a settled login so the next forge_auth_login starts fresh. */
export function consumeLogin(): void {
  if (pending?.outcome) pending = null;
}

/* ------------------------------------------------------------------ */
/* Status / logout                                                     */
/* ------------------------------------------------------------------ */

export interface AuthStatus {
  signed_in: boolean;
  source: TokenSource | "none";
  account?: { name?: string; email?: string };
  access_token_expires_in_s?: number;
  access_token_expired?: boolean;
  has_refresh_token?: boolean;
  scopes?: string[];
  cache_path: string;
  issuer: string;
  client_id_hint: string;
  redirect_uri: string;
  pending_login?: { seconds_left: number; browser_opened: boolean };
  note?: string;
}

/** Everything the model may know about the sign-in. Contains no token material. */
export function authStatus(cfg: Config = loadConfig()): AuthStatus {
  const base = {
    cache_path: TOKEN_CACHE_PATH,
    issuer: cfg.oidc.issuer.value,
    client_id_hint: idHint(cfg.oidc.clientId.value),
    redirect_uri: cfg.oidc.redirectUri.value,
  };
  const p = currentLogin();
  const pendingInfo = p && !p.outcome ? { seconds_left: Math.max(0, Math.round((p.deadline - Date.now()) / 1000)), browser_opened: p.browser_opened } : undefined;

  if (cfg.token.value) {
    return {
      ...base,
      signed_in: true,
      source: cfg.token.source === "session" ? "session" : "env",
      note: "Using a manually supplied token (override). forge_auth_login is not consulted while it is set; clear it with forge_config_clear(keys: ['token']).",
      pending_login: pendingInfo,
    };
  }
  const cache = readCache(cfg);
  if (!cache) {
    return {
      ...base,
      signed_in: false,
      source: "none",
      pending_login: pendingInfo,
      note: existsSync(TOKEN_CACHE_PATH)
        ? "A saved sign-in exists but is for a different issuer/client than the current OIDC settings; sign in again."
        : undefined,
    };
  }
  const expiresIn = cache.expires_at - nowS();
  const fresh = isFresh(cache);
  return {
    ...base,
    signed_in: fresh || Boolean(cache.refresh_token),
    source: "cache",
    account: cache.account ? { name: cache.account.name, email: cache.account.email } : undefined,
    access_token_expires_in_s: Math.max(0, expiresIn),
    access_token_expired: !fresh,
    has_refresh_token: Boolean(cache.refresh_token),
    scopes: (cache.scope ?? cfg.oidc.scopes.value).split(/\s+/).filter(Boolean),
    pending_login: pendingInfo,
    note: !fresh && cache.refresh_token ? "Access token expired; it will be refreshed silently on the next call." : !fresh ? "Access token expired and no refresh token — sign in again." : undefined,
  };
}

export function logout(): { removed_cache: boolean } {
  const removed = clearCache();
  pending = null;
  return { removed_cache: removed };
}
