/**
 * Config store for pivotly-skill-forge.
 *
 * Per-developer values live in a JSON file in the home directory, not in the environment,
 * so installing the plugin is the whole install: Claude collects anything missing
 * interactively the first time a tool needs it.
 *
 * Resolution order per value: config file → environment variable → built-in default.
 * The file wins so that a value the developer just set takes effect immediately, even if
 * a stale variable is still exported in their shell.
 *
 * Authentication is NOT a config value. The access token comes from an OIDC browser
 * sign-in (see auth.ts) and is cached separately in token.json next to this file. The
 * only token-shaped thing here is the optional manual override (session memory or the
 * PIVOTLY_MCP_TOKEN env var), kept for CI and for hosts without a browser.
 *
 * Nothing here is cached: every tool call re-reads the file, so configuring and using a
 * value in the same session works without restarting the server.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ConfigKey =
  | "api_base_url"
  | "backend_path"
  | "oidc_issuer"
  | "oidc_client_id"
  | "oidc_scopes"
  | "oidc_redirect_uri"
  | "token";

export const CONFIG_KEYS: ConfigKey[] = [
  "api_base_url",
  "backend_path",
  "oidc_issuer",
  "oidc_client_id",
  "oidc_scopes",
  "oidc_redirect_uri",
  "token",
];

/** Everything except the manual token override may be written to config.json. */
export const PERSISTED_KEYS: ConfigKey[] = [
  "api_base_url",
  "backend_path",
  "oidc_issuer",
  "oidc_client_id",
  "oidc_scopes",
  "oidc_redirect_uri",
];

export type StoredConfig = Partial<Record<ConfigKey, string>>;

/* ---------------------------------------------------------------- */
/* Built-in defaults                                                 */
/* ---------------------------------------------------------------- */

/** The backend's own .env.example defaults PORT to 3000. */
export const DEFAULT_API_BASE_URL = "http://localhost:3000";

/**
 * Ports Pivotly developers actually run the core backend on. Probed in this order when no
 * URL is stored, so the first session finds the backend without asking.
 */
export const API_URL_CANDIDATES = ["http://localhost:3000", "http://localhost:8080", "http://localhost:8081"];

/**
 * Pivotly's Microsoft Entra ID registration, shared by every developer.
 *
 * These are the same values the Portal frontend ships to every browser (NEXT_PUBLIC_*)
 * and the pivotly-backend plugin puts in its .mcp.json, and they are not secrets: this is
 * a public client (no client secret exists), and the issuer and scope are discoverable.
 * Shipping them as defaults is what makes sign-in zero-config. They can still be
 * overridden per developer (another tenant, a write scope) via forge_config_set.
 */
export const DEFAULT_OIDC_ISSUER = "https://login.microsoftonline.com/39f6cf5e-725d-4087-a1e3-e7b4442c867e/v2.0";
export const DEFAULT_OIDC_CLIENT_ID = "3043e9d3-28e6-4002-ab31-c07fcf418205";
export const DEFAULT_OIDC_SCOPES = "openid offline_access profile https://pivotlyidentityplatformdev.onmicrosoft.com/api/api.read";
/**
 * Must be registered on the app as a "Mobile and desktop applications" (public client)
 * redirect. A Single-Page-Application redirect will NOT work for a native client: the code
 * exchange is refused with AADSTS9002327. Port 8642 is the one registered for Pivotly's
 * plugins; 53682 is the alternate the pivotly-backend plugin also registers.
 */
export const DEFAULT_OIDC_REDIRECT_URI = "http://localhost:8642/callback";
export const OIDC_REDIRECT_FALLBACK_PORTS = [53682];

const DEFAULTS: Partial<Record<ConfigKey, string>> = {
  api_base_url: DEFAULT_API_BASE_URL,
  oidc_issuer: DEFAULT_OIDC_ISSUER,
  oidc_client_id: DEFAULT_OIDC_CLIENT_ID,
  oidc_scopes: DEFAULT_OIDC_SCOPES,
  oidc_redirect_uri: DEFAULT_OIDC_REDIRECT_URI,
};

/** Env vars kept as a fallback for CI and containers; never required for normal use. */
const ENV_FALLBACK: Record<ConfigKey, string> = {
  api_base_url: "PIVOTLY_API_BASE_URL",
  backend_path: "PIVOTLY_BACKEND_PATH",
  oidc_issuer: "PIVOTLY_OIDC_ISSUER",
  oidc_client_id: "PIVOTLY_OIDC_CLIENT_ID",
  oidc_scopes: "PIVOTLY_OIDC_SCOPES",
  oidc_redirect_uri: "PIVOTLY_OIDC_REDIRECT_URI",
  token: "PIVOTLY_MCP_TOKEN",
};

export const CONFIG_PATH =
  process.env.PIVOTLY_SKILL_FORGE_CONFIG?.trim() ||
  join(homedir(), ".pivotly-skill-forge", "config.json");

export const CONFIG_DIR = dirname(CONFIG_PATH);

/** OIDC token cache (access + refresh token). Written mode 600, never committed anywhere. */
export const TOKEN_CACHE_PATH =
  process.env.PIVOTLY_SKILL_FORGE_TOKEN_CACHE?.trim() || join(CONFIG_DIR, "token.json");

/* ---------------------------------------------------------------- */
/* Manual token override (session memory / env) — the CI escape hatch */
/* ---------------------------------------------------------------- */

let sessionToken = "";

export function setSessionToken(value: string): void {
  sessionToken = value.trim();
}

export function clearSessionToken(): void {
  sessionToken = "";
}

export function getSessionToken(): string {
  return sessionToken;
}

/* ---------------------------------------------------------------- */
/* Resolution                                                        */
/* ---------------------------------------------------------------- */

export type Source = "config" | "session" | "env" | "default" | "unset";

export interface Resolved {
  value: string;
  source: Source;
}

export interface OidcSettings {
  issuer: Resolved;
  clientId: Resolved;
  scopes: Resolved;
  redirectUri: Resolved;
}

export interface Config {
  apiBaseUrl: Resolved;
  backendPath: Resolved;
  oidc: OidcSettings;
  /** Manual override only. The normal path is the OIDC cache in auth.ts. */
  token: Resolved;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

export function readStored(): StoredConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: StoredConfig = {};
    for (const k of CONFIG_KEYS) {
      const v = (parsed as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    }
    return out;
  } catch {
    // A corrupt or unreadable file behaves like an empty one; setup can rewrite it.
    return {};
  }
}

export function writeStored(next: StoredConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const body: StoredConfig = {};
  // PERSISTED_KEYS, not CONFIG_KEYS: a token passed in here is dropped rather than written.
  // This is the single chokepoint for writes, so no caller can persist one by mistake.
  for (const k of PERSISTED_KEYS) if (next[k]) body[k] = next[k];
  writeFileSync(CONFIG_PATH, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(CONFIG_PATH, 0o600); // no-op on Windows; matters on POSIX where the file pre-existed
  } catch {
    /* best effort */
  }
}

function resolveOne(key: ConfigKey, stored: StoredConfig): Resolved {
  const fromFile = stored[key];
  if (fromFile) return { value: fromFile, source: "config" };
  const fromEnv = process.env[ENV_FALLBACK[key]]?.trim();
  if (fromEnv) return { value: fromEnv, source: "env" };
  const def = DEFAULTS[key];
  if (def) return { value: def, source: "default" };
  return { value: "", source: "unset" };
}

/**
 * Manual token override, deliberately not via resolveOne: the config file is not a source.
 * Session memory first (a value pasted this session), then the env var for unattended CI.
 */
function resolveTokenOverride(): Resolved {
  if (sessionToken) return { value: sessionToken, source: "session" };
  const fromEnv = process.env[ENV_FALLBACK.token]?.trim();
  if (fromEnv) return { value: fromEnv, source: "env" };
  return { value: "", source: "unset" };
}

export function loadConfig(): Config {
  const stored = readStored();
  const api = resolveOne("api_base_url", stored);
  const backend = resolveOne("backend_path", stored);
  const issuer = resolveOne("oidc_issuer", stored);
  return {
    apiBaseUrl: { value: api.value.replace(/\/+$/, ""), source: api.source },
    backendPath: backend.value ? { value: expandHome(backend.value), source: backend.source } : backend,
    oidc: {
      issuer: { value: issuer.value.replace(/\/+$/, ""), source: issuer.source },
      clientId: resolveOne("oidc_client_id", stored),
      scopes: resolveOne("oidc_scopes", stored),
      redirectUri: resolveOne("oidc_redirect_uri", stored),
    },
    token: resolveTokenOverride(),
  };
}

/**
 * Versions before 0.2 wrote a pasted token into config.json. Upgrading must not leave a
 * credential lying in a file the developer was told is no longer used. Returns true when
 * one was actually found and removed.
 */
export function purgeLegacyStoredToken(): boolean {
  try {
    if (!existsSync(CONFIG_PATH)) return false;
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const legacy = (parsed as Record<string, unknown>).token;
    if (typeof legacy !== "string" || !legacy.trim()) return false;
    writeStored(readStored()); // writeStored drops the token by construction
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- */
/* Validation used by forge_config_set / forge_config_collect        */
/* ---------------------------------------------------------------- */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "host.docker.internal"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  return LOCAL_HOSTS.has(h) || h.endsWith(".local") || h.endsWith(".localhost") || /^192\.168\./.test(h) || /^10\./.test(h);
}

export interface Validation {
  ok: boolean;
  value?: string;
  error?: string;
  warning?: string;
}

export function validateApiBaseUrl(raw: string, allowRemote: boolean): Validation {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return { ok: false, error: "api_base_url is empty." };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: `Not a valid URL: ${trimmed}. Include the scheme, e.g. http://localhost:8081` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: `Unsupported scheme '${url.protocol}'. Use http:// or https://` };
  }
  if (!isLocalHost(url.hostname) && !allowRemote) {
    return {
      ok: false,
      error:
        `'${url.hostname}' is not a local host. skill-forge probes and may write to this backend, so it must never point at production. ` +
        "If this really is a dev environment, ask the user to confirm and call forge_config_set again with allow_remote: true.",
    };
  }
  return {
    ok: true,
    value: trimmed,
    warning: isLocalHost(url.hostname) ? undefined : `Non-local backend '${url.hostname}' accepted on explicit confirmation. Writes here affect a shared environment.`,
  };
}

export function validateToken(raw: string): Validation {
  const trimmed = raw.trim().replace(/^Bearer\s+/i, "");
  if (!trimmed) return { ok: false, error: "token is empty." };
  if (/^(dev-token-placeholder|<.*>|your[-_]token|xxx+)$/i.test(trimmed)) {
    return { ok: false, error: "That looks like a placeholder, not a real token. Prefer forge_auth_login; a manual token must be a real bearer token." };
  }
  // Interior whitespace or control characters mean the paste was split across lines. Such a
  // value is not a usable bearer token, and it also defeats redaction: responses are serialized
  // with JSON.stringify, which escapes a newline to \n, so the raw token no longer occurs in the
  // text being redacted and would survive into a tool result. Reject it at the gate.
  if (/[\s -]/.test(trimmed)) {
    return {
      ok: false,
      error: "A bearer token cannot contain spaces, newlines, or control characters — the paste was probably split across lines. Ask for it again as a single line.",
    };
  }
  // A very short value is not a real token, and it would turn redaction into a destructive
  // find-and-replace over every response (a 1-character token rewrites ordinary words).
  if (trimmed.length < 8) {
    return { ok: false, error: `That is only ${trimmed.length} characters, which is not a bearer token.` };
  }
  return { ok: true, value: trimmed };
}

export function validateOidcIssuer(raw: string): Validation {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return { ok: false, error: "oidc_issuer is empty." };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: `Not a valid URL: ${trimmed}` };
  }
  if (url.protocol !== "https:" && !isLocalHost(url.hostname)) {
    return { ok: false, error: "The OIDC issuer must be https:// (a token endpoint over plain http would leak the tokens)." };
  }
  return { ok: true, value: trimmed };
}

export function validateOidcClientId(raw: string): Validation {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "oidc_client_id is empty." };
  if (/\s/.test(trimmed)) return { ok: false, error: "A client id cannot contain whitespace." };
  return { ok: true, value: trimmed };
}

export function validateOidcScopes(raw: string): Validation {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { ok: false, error: "oidc_scopes is empty." };
  const warning = parts.includes("offline_access")
    ? undefined
    : "Scopes do not include offline_access, so no refresh token will be issued and sign-in will be required every time the access token expires (about an hour).";
  return { ok: true, value: parts.join(" "), warning };
}

export function validateOidcRedirectUri(raw: string): Validation {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "oidc_redirect_uri is empty." };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: `Not a valid URL: ${trimmed}` };
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, error: "The redirect URI must be a loopback address the plugin can listen on, e.g. http://localhost:8642/callback" };
  }
  if (!url.port) return { ok: false, error: "The redirect URI needs an explicit port, e.g. http://localhost:8642/callback" };
  return { ok: true, value: trimmed };
}

/** Git Bash / WSL spellings of a Windows path that Node itself cannot resolve. */
function windowsEquivalent(p: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  const m = /^\/(?:mnt\/)?([a-z])\/(.*)$/i.exec(p);
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : undefined;
}

export function validateBackendPath(raw: string): Validation {
  let p = expandHome(raw.trim().replace(/^["']|["']$/g, ""));
  if (!p) return { ok: false, error: "backend_path is empty." };
  if (!existsSync(p)) {
    // Accept a Git Bash / WSL path if the Windows form of it exists.
    const win = windowsEquivalent(p);
    if (win && existsSync(win)) p = win;
    else return { ok: false, error: `Path does not exist: ${p}${win ? ` (also tried ${win})` : ""}` };
  }
  try {
    if (!statSync(p).isDirectory()) return { ok: false, error: `Not a directory: ${p}` };
  } catch (e) {
    return { ok: false, error: `Cannot read path: ${p} (${String(e)})` };
  }
  return { ok: true, value: p };
}

/** Never returns the token itself — only enough to tell two tokens apart. */
export function tokenHint(token: string): string {
  if (!token) return "";
  return token.length <= 8 ? `${"•".repeat(token.length)}` : `••••${token.slice(-4)} (${token.length} chars)`;
}

/** First 8 characters of an id — enough to recognise it, not enough to be useful. */
export function idHint(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}
