/**
 * pivotly-skill-forge MCP server
 *
 * Small tools that need either credentials or a live process — everything else (reading
 * code, writing skills) is done by the host's own file tools.
 *
 *   forge_config_status — what is configured, who is signed in, what is missing
 *   forge_config_collect— prompt the developer for missing settings, one input at a time
 *   forge_config_set    — store backend URL / repo path / OIDC overrides
 *   forge_config_clear  — forget one or all stored values (incl. the saved sign-in)
 *   forge_auth_login    — sign in to Pivotly in the browser (Microsoft Entra ID, PKCE)
 *   forge_auth_logout   — discard the saved sign-in
 *   forge_health        — is the backend up, does it accept the sign-in, does it serve a spec
 *   forge_request       — authenticated HTTP request to the backend; token never leaves this process
 *   forge_openapi       — fetch + normalize the served OpenAPI document (or the checkout's copy)
 *   forge_git_state     — branch, dirty status, commits behind origin/main for the backend repo
 *
 * The backend URL and checkout path live in ~/.pivotly-skill-forge/config.json (config.ts).
 * Credentials come from an OIDC browser sign-in and are cached next to it in token.json,
 * mode 600 (auth.ts). Nothing is ever typed into the chat, and no environment variable is
 * required — the env vars of the same name exist only as a CI fallback.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  API_URL_CANDIDATES,
  CONFIG_KEYS,
  CONFIG_PATH,
  DEFAULT_API_BASE_URL,
  TOKEN_CACHE_PATH,
  clearSessionToken,
  idHint,
  loadConfig,
  purgeLegacyStoredToken,
  readStored,
  setSessionToken,
  tokenHint,
  validateApiBaseUrl,
  validateBackendPath,
  validateOidcClientId,
  validateOidcIssuer,
  validateOidcRedirectUri,
  validateOidcScopes,
  validateToken,
  writeStored,
  type ConfigKey,
  type StoredConfig,
} from "./config.js";
import {
  LOGIN_TIMEOUT_MS,
  acquireToken,
  authStatus,
  consumeLogin,
  currentLogin,
  logout,
  redactionSecrets,
  startLogin,
  waitForLogin,
  type AcquireResult,
} from "./auth.js";

const execFileP = promisify(execFile);

/**
 * Where the core backend serves its OpenAPI document. /api/documentation/json is the real
 * one (fastify-swagger, unauthenticated); the rest are common conventions kept as fallbacks
 * for other builds.
 */
const SPEC_PATHS = [
  "/api/documentation/json",
  "/api/v3/documentation/json",
  "/documentation/json",
  "/api/v3/openapi.json",
  "/api/openapi.json",
  "/openapi.json",
  "/swagger.json",
  "/api-docs",
  "/docs-json",
];
const HEALTH_PATHS = ["/health", "/api/health", "/healthz", "/api/v3/health", "/"];
/** Cheapest route that requires a verified bearer token and says who it belongs to. */
const ME_PATH = "/api/v3/me/";

const SETUP_HINT =
  "Call forge_config_collect to prompt the developer for it directly, one input at a time — do not ask for values in conversation, " +
  "and never tell them to set an environment variable or edit a file. /skill-forge-setup walks through every setting.";
const LOGIN_HINT =
  "Call forge_auth_login: it opens the Microsoft sign-in page in the developer's browser and saves the result, so this is a one-time step " +
  "(later sessions refresh silently). Never ask them to paste a token.";

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

/* ------------------------------------------------------------------ */
/* Output helpers                                                      */
/* ------------------------------------------------------------------ */

function redact(s: string): string {
  let out = s;
  for (const secret of redactionSecrets()) out = out.split(secret).join("<redacted-token>");
  return out;
}

/** Every tool result passes through here, so a token can never reach the model by accident. */
function text(payload: unknown) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text: redact(body) }] };
}

function assertRelativePath(path: string): string {
  // Only relative paths against the configured base URL are allowed; refuse absolute URLs
  // so the token can never be sent anywhere except the configured backend.
  if (/^[a-z]+:\/\//i.test(path)) {
    throw new Error("Absolute URLs are not allowed; pass a path relative to the configured backend URL.");
  }
  return path.startsWith("/") ? path : `/${path}`;
}

interface FetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  ms: number;
}

async function doFetch(baseUrl: string, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<FetchResult> {
  const url = `${baseUrl}${assertRelativePath(path)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 15000);
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    const body = await res.text();
    return { status: res.status, headers, body, ms: Date.now() - started };
  } finally {
    clearTimeout(t);
  }
}

function tryJson(s: string): Json | undefined {
  try {
    return JSON.parse(s) as Json;
  } catch {
    return undefined;
  }
}

function pick(h: Record<string, string>, keys: string[]) {
  const out: Record<string, string> = {};
  for (const k of keys) if (h[k]) out[k] = h[k];
  return out;
}

async function isGitRepo(path: string): Promise<boolean> {
  try {
    await execFileP("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Backend discovery                                                   */
/* ------------------------------------------------------------------ */

/** Which of the usual local URLs answers a health probe. Fast: 1.5s per candidate, in parallel. */
async function detectBackends(exclude?: string): Promise<string[]> {
  const candidates = API_URL_CANDIDATES.filter((u) => u !== exclude);
  const results = await Promise.all(
    candidates.map(async (u) => {
      try {
        const r = await doFetch(u, "/health", { method: "GET", timeoutMs: 1500 });
        return r.status < 500 ? u : null;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((u): u is string => Boolean(u));
}

async function probeReachable(baseUrl: string): Promise<{ path: string; status: number; body: Json | string } | null> {
  for (const p of HEALTH_PATHS) {
    try {
      const r = await doFetch(baseUrl, p, { method: "GET", timeoutMs: 5000 });
      return { path: p, status: r.status, body: tryJson(r.body) ?? r.body.slice(0, 300) };
    } catch {
      /* try next */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Config report                                                       */
/* ------------------------------------------------------------------ */

/** Config as reported to the model. No token material is ever included. */
async function configReport(): Promise<Record<string, unknown>> {
  const cfg = loadConfig();
  const auth = authStatus(cfg);
  const missing: string[] = [];
  if (!auth.signed_in) missing.push("sign_in");
  if (!cfg.backendPath.value) missing.push("backend_path");

  const backend: Record<string, unknown> = { source: cfg.backendPath.source };
  if (cfg.backendPath.value) {
    backend.path = cfg.backendPath.value;
    const ok = await isGitRepo(cfg.backendPath.value);
    backend.is_git_repo = ok;
    if (!ok) backend.problem = 'Stored path is not a git checkout. Prompt for the right one with forge_config_collect(keys: ["backend_path"], force: true).';
  }

  const notes: string[] = [];
  if (!auth.signed_in) notes.push(`Not signed in: forge_request and authenticated probes are unavailable. ${LOGIN_HINT}`);
  if (missing.includes("backend_path")) notes.push("No backend repo path stored: forge_git_state and codebase-mine are unavailable.");
  if (cfg.apiBaseUrl.source === "default") {
    notes.push(`No backend URL stored; using the default ${DEFAULT_API_BASE_URL}. forge_health probes the usual local ports and remembers the one that answers.`);
  }
  const oidcSource = [cfg.oidc.issuer, cfg.oidc.clientId, cfg.oidc.scopes, cfg.oidc.redirectUri].some((r) => r.source !== "default") ? "overridden" : "built-in defaults";

  return {
    config_path: CONFIG_PATH,
    token_cache_path: TOKEN_CACHE_PATH,
    api_base_url: { value: cfg.apiBaseUrl.value, source: cfg.apiBaseUrl.source },
    backend_path: backend,
    oidc: {
      issuer: cfg.oidc.issuer.value,
      client_id: idHint(cfg.oidc.clientId.value),
      scopes: cfg.oidc.scopes.value.split(/\s+/),
      redirect_uri: cfg.oidc.redirectUri.value,
      source: oidcSource,
    },
    auth,
    missing,
    notes,
    next_action: missing.includes("sign_in") ? LOGIN_HINT : missing.length ? SETUP_HINT : undefined,
  };
}

const server = new McpServer({ name: "pivotly-skill-forge", version: "0.3.0" });

/* ------------------------------------------------------------------ */
/* Interactive prompts (MCP elicitation)                               */
/* ------------------------------------------------------------------ */

/**
 * Non-credential settings are collected through a real input prompt in the host UI rather
 * than by asking the model to request them in prose. One field per call, deliberately: the
 * developer answers one question at a time.
 *
 * The token prompt still exists as a manual fallback for hosts without a browser, but it is
 * never in the default set — forge_auth_login is the normal path.
 */

type PromptKey = "api_base_url" | "backend_path" | "token";

interface Prompt {
  message: string;
  title: string;
  description: string;
  withDefault?: () => Promise<string | undefined>;
}

// No `format` constraints here on purpose. The SDK validates the developer's answer against
// requestedSchema and THROWS on a mismatch, which would surface as a protocol failure rather
// than as "that value was not accepted, try again" — and `format: "uri"` rejects perfectly
// reasonable answers like "localhost". Every value is checked by validateFor() instead.
const PROMPTS: Record<PromptKey, Prompt> = {
  api_base_url: {
    message: "Which URL is your Pivotly backend running on?",
    title: "Backend URL",
    description: `Include the scheme and port, e.g. ${DEFAULT_API_BASE_URL}. Must be a local/dev host — never production.`,
    // Pre-fill with whatever is actually answering right now, so accepting is one keystroke.
    withDefault: async () => (await detectBackends())[0] ?? DEFAULT_API_BASE_URL,
  },
  backend_path: {
    message: "Where is your Pivotly backend git checkout?",
    title: "Backend checkout path",
    description: "Absolute path to the directory containing .git, e.g. C:\\Users\\you\\dev\\Portal_Independent_Backend. ~, /c/… and /mnt/c/… are accepted.",
  },
  token: {
    message: "Paste a Pivotly bearer token (manual fallback — forge_auth_login is the normal way to sign in).",
    title: "Bearer token (manual override)",
    description:
      "Held in the skill-forge server's memory for this session only — never written to disk and never echoed back. " +
      "This field is not masked. Use this only when a browser sign-in is impossible on this machine.",
  },
};

/**
 * Whether the host can show a *form* prompt specifically — not merely "some elicitation".
 *   Claude Code declares  elicitation: {}           → form (a missing mode means form)
 *   Claude Desktop/Cowork declares  elicitation: { url: {} }  → URL mode only, no form
 */
function clientSupportsElicitation(): boolean {
  try {
    const e = server.server.getClientCapabilities()?.elicitation as Record<string, unknown> | undefined;
    if (!e || typeof e !== "object") return false;
    if (Object.keys(e).length === 0) return true;
    return Boolean(e.form);
  } catch {
    return false;
  }
}

function observedClientCapabilities(): Record<string, unknown> {
  try {
    const caps = server.server.getClientCapabilities();
    return { advertised: caps ? Object.keys(caps) : [], elicitation: caps?.elicitation ?? null };
  } catch (e) {
    return { error: String(e) };
  }
}

type PromptOutcome =
  | { status: "value"; value: string }
  | { status: "declined" | "cancelled" }
  | { status: "invalid"; reason: string }
  | { status: "unsupported"; reason: string };

function validateFor(key: PromptKey, value: string, allowRemote = false) {
  if (key === "api_base_url") return validateApiBaseUrl(value, allowRemote);
  if (key === "token") return validateToken(value);
  return validateBackendPath(value);
}

/** A prompt can block for as long as the developer takes; the SDK default of 60s is far too short. */
const PROMPT_TIMEOUT_MS = 600_000;

async function promptFor(key: PromptKey, retryError?: string): Promise<PromptOutcome> {
  if (!clientSupportsElicitation()) return { status: "unsupported", reason: "This host does not support MCP elicitation prompts." };
  const p = PROMPTS[key];
  const schema: Record<string, unknown> = {
    type: "string",
    title: p.title,
    description: retryError ? `${retryError} — ${p.description}` : p.description,
    minLength: 1,
  };
  const def = await p.withDefault?.();
  if (def) schema.default = def;

  try {
    const res = await server.server.elicitInput(
      {
        mode: "form",
        message: retryError ? `${retryError}\n\n${p.message}` : p.message,
        requestedSchema: { type: "object", properties: { [key]: schema as never }, required: [key] },
      },
      { timeout: PROMPT_TIMEOUT_MS, resetTimeoutOnProgress: true },
    );
    if (res.action !== "accept") return { status: res.action === "decline" ? "declined" : "cancelled" };
    const raw = (res.content as Record<string, unknown> | undefined)?.[key];
    if (typeof raw !== "string" || !raw.trim()) return { status: "cancelled" };
    return { status: "value", value: raw.trim() };
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    const msg = e instanceof Error ? e.message : String(e);
    if (code === -32601 || /does not support/i.test(msg)) return { status: "unsupported", reason: msg };
    return { status: "invalid", reason: msg };
  }
}

/* ------------------------------------------------------------------ */
/* forge_config_status                                                 */
/* ------------------------------------------------------------------ */
server.tool(
  "forge_config_status",
  "Report skill-forge's state for this developer: backend URL, backend repo path, the OIDC settings in use, and who is signed in (account, token expiry, whether a refresh token is saved). Call it at the start of a forge workflow and whenever another tool reports a missing setting. Never returns token material.",
  {},
  async () => text(await configReport()),
);

/* ------------------------------------------------------------------ */
/* forge_config_set                                                    */
/* ------------------------------------------------------------------ */
server.tool(
  "forge_config_set",
  "Store one or more skill-forge settings for this developer — no environment variables, no file editing. Each value is validated before it is written (the URL must be a local/dev host; backend_path must exist and be a git checkout) and takes effect immediately with no restart. The oidc_* keys override the built-in Pivotly Entra ID registration (another tenant, a write scope); changing them invalidates the saved sign-in. `token` is a manual override held in memory for this session only — prefer forge_auth_login. Prefer forge_config_collect for URL/path, which prompts the developer directly; use this tool when you already have a value in hand.",
  {
    api_base_url: z.string().optional().describe("Base URL of the developer's running Pivotly backend, e.g. http://localhost:8081"),
    backend_path: z.string().optional().describe("Absolute path to the local Pivotly backend git checkout"),
    oidc_issuer: z.string().optional().describe("OIDC issuer (Entra: https://login.microsoftonline.com/<tenant>/v2.0). Rarely needed; defaults to Pivotly's tenant."),
    oidc_client_id: z.string().optional().describe("Public client (app registration) id. Rarely needed; defaults to Pivotly's plugin client."),
    oidc_scopes: z.string().optional().describe("Space-separated scopes. Add the API write scope here when the developer needs write access, then forge_auth_login(force: true)."),
    oidc_redirect_uri: z.string().optional().describe("Loopback redirect registered on the app, e.g. http://localhost:8642/callback"),
    token: z
      .string()
      .optional()
      .describe("Manual bearer token override. Kept in the server process for this session only — never written to disk — and redacted from every tool output. Only for hosts where a browser sign-in is impossible."),
    allow_remote: z
      .boolean()
      .default(false)
      .describe("Set only after the user explicitly confirms that a non-local api_base_url is a dev environment. Required for any host that is not localhost or a private address."),
  },
  async ({ api_base_url, backend_path, oidc_issuer, oidc_client_id, oidc_scopes, oidc_redirect_uri, token, allow_remote }) => {
    const inputs = { api_base_url, backend_path, oidc_issuer, oidc_client_id, oidc_scopes, oidc_redirect_uri, token };
    if (Object.values(inputs).every((v) => v === undefined)) {
      return text({ error: "Nothing to set. Pass at least one setting.", config: await configReport() });
    }

    const stored: StoredConfig = readStored();
    const applied: string[] = [];
    const warnings: string[] = [];
    const rejected: string[] = [];
    let oidcChanged = false;

    const apply = (key: ConfigKey, v: { ok: boolean; value?: string; error?: string; warning?: string }, label = key) => {
      if (!v.ok) rejected.push(v.error as string);
      else {
        stored[key] = v.value;
        applied.push(`${label} = ${v.value}`);
        if (v.warning) warnings.push(v.warning);
      }
    };

    if (api_base_url !== undefined) apply("api_base_url", validateApiBaseUrl(api_base_url, allow_remote));
    if (oidc_issuer !== undefined) {
      apply("oidc_issuer", validateOidcIssuer(oidc_issuer));
      oidcChanged = true;
    }
    if (oidc_client_id !== undefined) {
      apply("oidc_client_id", validateOidcClientId(oidc_client_id));
      oidcChanged = true;
    }
    if (oidc_scopes !== undefined) {
      apply("oidc_scopes", validateOidcScopes(oidc_scopes));
      oidcChanged = true;
    }
    if (oidc_redirect_uri !== undefined) apply("oidc_redirect_uri", validateOidcRedirectUri(oidc_redirect_uri));

    if (token !== undefined) {
      const v = validateToken(token);
      if (!v.ok) rejected.push(v.error as string);
      else {
        // Session memory, never `stored` — the token must not reach writeStored at all.
        setSessionToken(v.value as string);
        applied.push(`token = ${tokenHint(v.value as string)} (manual override, this session only, not written to disk)`);
      }
    }

    if (backend_path !== undefined) {
      const v = validateBackendPath(backend_path);
      if (!v.ok) rejected.push(v.error as string);
      else if (!(await isGitRepo(v.value as string))) {
        rejected.push(`${v.value} exists but is not a git checkout. Ask the user for the directory that holds the backend repo (the one containing .git).`);
      } else {
        stored.backend_path = v.value;
        applied.push(`backend_path = ${v.value}`);
      }
    }

    const persisted = applied.some((a) => !a.startsWith("token ="));
    if (persisted) {
      try {
        writeStored(stored);
      } catch (e) {
        return text({ error: `Could not write ${CONFIG_PATH}: ${String(e)}`, applied: [], rejected });
      }
    }
    if (oidcChanged) warnings.push("OIDC settings changed: the saved sign-in (if any) no longer matches and will be ignored. Run forge_auth_login(force: true) to sign in against the new settings.");

    return text({
      saved_to: persisted ? CONFIG_PATH : undefined,
      applied,
      rejected: rejected.length ? rejected : undefined,
      warnings: warnings.length ? warnings : undefined,
      config: await configReport(),
      next_action: rejected.length
        ? "Tell the user in plain language what was rejected and why, then call forge_config_collect for that key with force: true to prompt for a corrected value."
        : undefined,
    });
  },
);

/* ------------------------------------------------------------------ */
/* forge_config_collect                                                */
/* ------------------------------------------------------------------ */
server.tool(
  "forge_config_collect",
  "Collect skill-forge settings by prompting the developer directly, one input at a time, in the host's own UI. This is the preferred way to set up the backend URL and the backend checkout path: call it instead of asking the user for values in conversation. By default it prompts only for what is missing; the URL prompt is pre-filled with whichever local port is actually answering. Each answer is validated as it arrives and a rejected value is re-prompted once. Sign-in is NOT collected here — that is forge_auth_login. The `token` key exists only as a manual fallback for hosts without a browser.",
  {
    keys: z
      .array(z.enum(["api_base_url", "backend_path", "token"]))
      .optional()
      .describe("Which settings to prompt for, in this order. Omit to prompt for the backend URL and checkout path if they are not already available."),
    force: z
      .boolean()
      .default(false)
      .describe("Prompt even for settings that already have a value — use when the developer wants to change one (different port, moved checkout)."),
    allow_remote: z
      .boolean()
      .default(false)
      .describe("Set only after the developer explicitly confirms that a non-local backend URL is a dev environment. Never pass it on your own initiative."),
  },
  async ({ keys, force, allow_remote }) => {
    const cfg = loadConfig();
    const have: Record<PromptKey, boolean> = {
      // A default-sourced URL is not something the developer chose, so it still counts as missing.
      api_base_url: cfg.apiBaseUrl.source === "config" || cfg.apiBaseUrl.source === "env",
      backend_path: Boolean(cfg.backendPath.value),
      token: Boolean(cfg.token.value),
    };
    const order: PromptKey[] = keys?.length ? (keys as PromptKey[]) : ["api_base_url", "backend_path"];
    const wanted = force ? order : order.filter((k) => !have[k]);

    if (!wanted.length) {
      return text({
        prompted: [],
        note: "Everything these settings cover is already available. Pass force: true to change one. Sign-in is separate: forge_auth_login.",
        config: await configReport(),
      });
    }

    if (!clientSupportsElicitation()) {
      const caps = observedClientCapabilities();
      const urlOnly = Boolean((caps.elicitation as Record<string, unknown> | null)?.url);
      return text({
        error: urlOnly
          ? "This host supports only URL-mode elicitation, not the form prompts this tool uses (Claude Desktop/Cowork does this; Claude Code supports form prompts)."
          : "This host does not support input prompts (MCP elicitation).",
        needed: wanted,
        client_capabilities: caps,
        next_action:
          "Fall back to asking the developer for each of these in conversation, one at a time, then store each with forge_config_set. " +
          "Do not tell them to set an environment variable or edit a file. Sign-in still works everywhere via forge_auth_login.",
        config: await configReport(),
      });
    }

    // Values are collected into `pending` and merged onto a FRESH read at write time, so a
    // slow answer cannot clobber anything written in the meantime.
    const pending: StoredConfig = {};
    const collected: string[] = [];
    const rejected: string[] = [];
    const skipped: string[] = [];
    let persistNeeded = false;
    let stoppedAt: string | undefined;

    for (const key of wanted) {
      let outcome = await promptFor(key);

      if (outcome.status === "value") {
        const first = validateFor(key, outcome.value, allow_remote);
        if (!first.ok) outcome = await promptFor(key, first.error);
      } else if (outcome.status === "invalid") {
        outcome = await promptFor(key, `That value was not accepted (${outcome.reason}).`);
      }

      if (outcome.status !== "value") {
        if (outcome.status === "unsupported") {
          stoppedAt = `${key}: ${outcome.reason}`;
          break;
        }
        if (outcome.status === "invalid") {
          rejected.push(`${key}: ${outcome.reason}`);
          continue;
        }
        skipped.push(`${key} (${outcome.status})`);
        stoppedAt = `The developer ${outcome.status === "declined" ? "declined" : "dismissed"} the ${key} prompt.`;
        break;
      }

      const v = validateFor(key, outcome.value, allow_remote);
      if (!v.ok) {
        rejected.push(v.error as string);
        continue;
      }

      if (key === "token") {
        setSessionToken(v.value as string);
        collected.push(`token = ${tokenHint(v.value as string)} (manual override, this session only, not written to disk)`);
      } else if (key === "backend_path") {
        if (!(await isGitRepo(v.value as string))) {
          rejected.push(`${v.value} exists but is not a git checkout — ask for the directory containing .git.`);
          continue;
        }
        pending.backend_path = v.value;
        persistNeeded = true;
        collected.push(`backend_path = ${v.value}`);
      } else {
        pending.api_base_url = v.value;
        persistNeeded = true;
        collected.push(`api_base_url = ${v.value}`);
        if (v.warning) rejected.push(v.warning);
      }
    }

    if (persistNeeded) {
      try {
        writeStored({ ...readStored(), ...pending });
      } catch (e) {
        return text({ error: `Could not write ${CONFIG_PATH}: ${String(e)}`, collected, rejected });
      }
    }

    return text({
      collected,
      rejected: rejected.length ? rejected : undefined,
      skipped: skipped.length ? skipped : undefined,
      stopped: stoppedAt,
      saved_to: persistNeeded ? CONFIG_PATH : undefined,
      config: await configReport(),
      next_action: rejected.length
        ? "Tell the developer in plain language what was rejected, then call forge_config_collect again for that key with force: true."
        : stoppedAt
          ? "Ask the developer whether they want to continue; re-run forge_config_collect when they do."
          : "Verify with forge_health (URL + sign-in) and forge_git_state (checkout path).",
    });
  },
);

/* ------------------------------------------------------------------ */
/* forge_config_clear                                                  */
/* ------------------------------------------------------------------ */
server.tool(
  "forge_config_clear",
  "Forget skill-forge settings — one key, or all of them. `token` clears the saved sign-in (token cache on disk) and any manual override in memory; the oidc_* keys revert to the built-in Pivotly defaults. Use it when the developer switches accounts, switches backend checkouts, or wants the machine left clean. Only touches this plugin's own files; never the backend or the repo.",
  {
    keys: z
      .array(z.enum(["api_base_url", "backend_path", "oidc_issuer", "oidc_client_id", "oidc_scopes", "oidc_redirect_uri", "token"]))
      .optional()
      .describe("Which settings to forget. Omit to clear all of them including the sign-in — confirm with the user first."),
  },
  async ({ keys }) => {
    const target = (keys?.length ? keys : CONFIG_KEYS) as ConfigKey[];
    const stored = readStored();
    const removed: string[] = [];

    if (target.includes("token")) {
      const { removed_cache } = logout();
      if (removed_cache) removed.push("token (saved sign-in)");
      if (loadConfig().token.source === "session") removed.push("token (manual override)");
      clearSessionToken();
    }
    for (const k of target) {
      if (k === "token") continue;
      if (stored[k] !== undefined) removed.push(k);
      delete stored[k];
    }
    try {
      writeStored(stored);
    } catch (e) {
      return text({ error: `Could not write ${CONFIG_PATH}: ${String(e)}` });
    }
    return text({
      cleared: removed,
      not_stored: target.filter((k) => !removed.some((r) => r.startsWith(k))),
      config: await configReport(),
    });
  },
);

/* ------------------------------------------------------------------ */
/* forge_auth_login                                                    */
/* ------------------------------------------------------------------ */
server.tool(
  "forge_auth_login",
  "Sign the developer in to Pivotly. Opens the Microsoft Entra ID sign-in page in their default browser (Authorization Code + PKCE, loopback redirect), waits for them to finish, and saves the result to the token cache — including a refresh token, so this is normally a ONE-TIME step per machine; later sessions refresh silently. Tell the user in one line that a browser window has opened before or right after calling this. If the developer is already signed in, it just reports who. Use force: true to switch accounts or after changing oidc_scopes (e.g. adding a write scope). If it returns status 'waiting_for_sign_in', relay the auth_url in case no window appeared, then call forge_auth_login again to pick up the result.",
  {
    force: z.boolean().default(false).describe("Start a fresh browser sign-in even if a valid sign-in is saved (switch account, pick up new scopes)."),
    open_browser: z.boolean().default(true).describe("Set false on a machine without a browser: the tool then returns the auth_url for the developer to open elsewhere and waits for the redirect on this machine's loopback."),
    wait_seconds: z.number().int().min(5).max(240).default(120).describe("How long this call waits for the sign-in to complete before returning 'waiting_for_sign_in'. The sign-in itself stays open for 5 minutes."),
  },
  async ({ force, open_browser, wait_seconds }) => {
    const cfg = loadConfig();

    if (cfg.token.value) {
      return text({
        signed_in: true,
        source: cfg.token.source,
        note: "A manually supplied token override is active, so browser sign-in is not used. Clear it with forge_config_clear(keys: ['token']) to switch to the saved sign-in.",
        auth: authStatus(cfg),
      });
    }

    // Already signed in (or silently refreshable) and not forcing: no browser.
    if (!force && !currentLogin()) {
      const acq = await acquireToken(cfg);
      if (acq.ok) {
        return text({
          signed_in: true,
          already: true,
          account: acq.account ? { name: acq.account.name, email: acq.account.email } : undefined,
          access_token_expires_in_s: acq.expires_in_s,
          source: acq.source,
          note: "No browser needed — the saved sign-in is valid. Pass force: true to sign in as a different account or with new scopes.",
          next_action: "Call forge_health to confirm the backend accepts it.",
        });
      }
    }

    let pendingLogin;
    try {
      // A sign-in from an earlier call — still waiting, or settled since (success or IdP
      // error) — is reported before anything new starts. Only a consumed/absent one starts
      // a fresh browser round-trip.
      const existing = currentLogin();
      if (existing) pendingLogin = existing;
      else {
        // The old cache is left in place until the new sign-in succeeds: writeCache overwrites
        // it, so a forced sign-in that fails or is abandoned does not leave the developer
        // signed out. prompt=select_account is what lets them pick a different account.
        pendingLogin = await startLogin(cfg, { openBrowser: open_browser, selectAccount: force });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return text({
        error: `Could not start the sign-in: ${msg}`,
        oidc: { issuer: cfg.oidc.issuer.value, client_id: idHint(cfg.oidc.clientId.value), redirect_uri: cfg.oidc.redirectUri.value },
        next_action: "Relay the error. If it mentions the port being in use, another sign-in may still be waiting — ask the developer to finish it or wait a minute. If discovery failed, check network/VPN.",
      });
    }

    const settled = await waitForLogin(pendingLogin, Math.min(wait_seconds * 1000, LOGIN_TIMEOUT_MS));
    if (!settled) {
      return text({
        status: "waiting_for_sign_in",
        browser_opened: pendingLogin.browser_opened,
        auth_url: pendingLogin.auth_url,
        redirect_uri: pendingLogin.redirect_uri,
        seconds_left: Math.max(0, Math.round((pendingLogin.deadline - Date.now()) / 1000)),
        next_action:
          "Tell the developer to complete the Microsoft sign-in in the browser window" +
          (pendingLogin.browser_opened ? "" : " (none was opened automatically — give them the auth_url to open)") +
          ", then call forge_auth_login again to pick up the result.",
      });
    }

    const outcome = pendingLogin.outcome!;
    consumeLogin();
    if (!outcome.ok) {
      return text({
        error: outcome.error,
        aad_error_code: outcome.aad_code,
        hint: outcome.hint,
        redirect_uri_used: pendingLogin.redirect_uri,
        next_action: outcome.hint
          ? "Relay the hint to the developer in plain language; it names the fix. Then call forge_auth_login again."
          : "Relay the error and offer to try again with forge_auth_login.",
      });
    }
    const c = outcome.cache;
    return text({
      signed_in: true,
      account: c.account ? { name: c.account.name, email: c.account.email } : undefined,
      access_token_expires_in_s: Math.max(0, c.expires_at - Math.floor(Date.now() / 1000)),
      refresh_token_saved: Boolean(c.refresh_token),
      scopes: (c.scope ?? cfg.oidc.scopes.value).split(/\s+/).filter(Boolean),
      saved_to: TOKEN_CACHE_PATH,
      note: c.refresh_token
        ? "Saved. Future sessions will refresh silently; no sign-in needed until the refresh token is revoked or idle for ~90 days."
        : "No refresh token was issued (scopes lack offline_access), so sign-in will be needed again in about an hour.",
      next_action: "Call forge_health to confirm the backend accepts the sign-in.",
    });
  },
);

/* ------------------------------------------------------------------ */
/* forge_auth_logout                                                   */
/* ------------------------------------------------------------------ */
server.tool(
  "forge_auth_logout",
  "Discard the saved Pivotly sign-in (deletes the token cache and any in-memory override) so the next authenticated call requires forge_auth_login. Use it when the developer leaves the machine, wants to switch accounts, or a token may have been exposed. Does not sign them out of the browser's Microsoft session.",
  {},
  async () => {
    const { removed_cache } = logout();
    const hadOverride = loadConfig().token.source === "session";
    clearSessionToken();
    return text({
      signed_out: true,
      removed_cache,
      removed_override: hadOverride,
      note: "The browser still holds a Microsoft session, so the next forge_auth_login may complete without a password prompt. That is the IdP's session, not this plugin's.",
      auth: authStatus(),
    });
  },
);

/* ------------------------------------------------------------------ */
/* Auth probe shared by forge_health / forge_request                   */
/* ------------------------------------------------------------------ */

interface MeProbe {
  path: string;
  status: number;
  accepted: boolean;
  outcome: "accepted" | "authenticated_not_provisioned" | "rejected" | "forbidden" | "error";
  user?: Record<string, unknown>;
  detail?: string;
}

function meta(body: Json | undefined): Record<string, unknown> | undefined {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const b = body as Record<string, unknown>;
    return (b.meta as Record<string, unknown> | undefined) ?? ((b.error as Record<string, unknown> | undefined)?.meta as Record<string, unknown> | undefined);
  }
  return undefined;
}

async function probeMe(baseUrl: string, token: string): Promise<MeProbe> {
  try {
    const r = await doFetch(baseUrl, ME_PATH, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, timeoutMs: 8000 });
    const body = tryJson(r.body);
    if (r.status >= 200 && r.status < 300) {
      const data = body && typeof body === "object" && !Array.isArray(body) ? ((body as Record<string, unknown>).data as Record<string, unknown> | undefined) ?? (body as Record<string, unknown>) : undefined;
      const user: Record<string, unknown> = {};
      for (const k of ["id", "email", "display_name", "displayName", "name", "role", "roles"]) if (data && data[k] !== undefined) user[k] = data[k];
      return { path: ME_PATH, status: r.status, accepted: true, outcome: "accepted", user };
    }
    const m = meta(body);
    const code = String(m?.code ?? "");
    const message = body && typeof body === "object" ? String((body as Record<string, unknown>).message ?? "") : r.body.slice(0, 200);
    if (r.status === 401 && (code === "USER_NOT_IN_IAM" || /not.*provision|USER_NOT_IN_IAM/i.test(`${code} ${message}`))) {
      return { path: ME_PATH, status: r.status, accepted: true, outcome: "authenticated_not_provisioned", detail: message || code };
    }
    if (r.status === 401) return { path: ME_PATH, status: r.status, accepted: false, outcome: "rejected", detail: message || code };
    if (r.status === 403) return { path: ME_PATH, status: r.status, accepted: true, outcome: "forbidden", detail: message || code };
    return { path: ME_PATH, status: r.status, accepted: false, outcome: "error", detail: message || code };
  } catch (e) {
    return { path: ME_PATH, status: 0, accepted: false, outcome: "error", detail: String(e) };
  }
}

/* ------------------------------------------------------------------ */
/* forge_health                                                        */
/* ------------------------------------------------------------------ */
server.tool(
  "forge_health",
  "Check whether the developer's Pivotly backend is reachable (auto-detecting the usual local ports when no URL is stored and remembering the one that answers), whether the saved sign-in is accepted by it (via GET /api/v3/me/, distinguishing 'token rejected' from 'signed in but not provisioned in IAM'), and whether an OpenAPI document is served. Call this first in any api-verify workflow; when something is missing it names the exact next tool to call.",
  {},
  async () => {
    let cfg = loadConfig();
    const report: Record<string, unknown> = { base_url: cfg.apiBaseUrl.value, base_url_source: cfg.apiBaseUrl.source };

    // 1. reachability, with discovery when nothing was ever stored
    let health = await probeReachable(cfg.apiBaseUrl.value);
    if (!health) {
      const detected = await detectBackends(cfg.apiBaseUrl.value);
      report.detected_candidates = detected;
      if (detected.length === 1 && cfg.apiBaseUrl.source === "default") {
        // Nothing was configured and exactly one local backend answers: remember it. This is
        // the one config write done without a prompt — a local URL is not a decision the
        // developer needs to be asked to make, and forge_config_status shows where it came from.
        writeStored({ ...readStored(), api_base_url: detected[0] });
        cfg = loadConfig();
        report.auto_configured = `No backend URL was stored and only ${detected[0]} answered a health probe, so it was saved as api_base_url.`;
        report.base_url = cfg.apiBaseUrl.value;
        report.base_url_source = cfg.apiBaseUrl.source;
        health = await probeReachable(cfg.apiBaseUrl.value);
      }
    }
    report.reachable = Boolean(health);
    if (health) report.health = health;
    if (!health) {
      const detected = (report.detected_candidates as string[] | undefined) ?? [];
      report.next_action = detected.length
        ? `Nothing answered at ${cfg.apiBaseUrl.value}, but ${detected.join(" and ")} did. Confirm with the user which is their core backend, then forge_config_set(api_base_url: <that URL>).`
        : cfg.apiBaseUrl.source === "default"
          ? `Nothing answered at the default ${cfg.apiBaseUrl.value} or on ports ${API_URL_CANDIDATES.map((u) => new URL(u).port).join("/")}. Ask whether the backend is running; if it is on another port, prompt for the URL with forge_config_collect(keys: ["api_base_url"], force: true).`
          : `Backend not reachable at ${cfg.apiBaseUrl.value}. Ask the user to start the core backend, or prompt for a corrected URL with forge_config_collect(keys: ["api_base_url"], force: true).`;
      report.auth = authStatus(cfg);
      return text(report);
    }

    // 2. sign-in acceptance
    let acq: AcquireResult = await acquireToken(cfg);
    if (!acq.ok) {
      report.auth = { signed_in: false, reason: acq.reason, detail: acq.detail };
      report.next_action = LOGIN_HINT;
    } else {
      let probe = await probeMe(cfg.apiBaseUrl.value, acq.token);
      // A cached token the backend refuses may simply be stale for this backend; one silent
      // refresh settles whether the sign-in itself is bad.
      if (probe.outcome === "rejected" && acq.source === "cache") {
        const again = await acquireToken(cfg, { forceRefresh: true });
        if (again.ok) {
          acq = again;
          probe = await probeMe(cfg.apiBaseUrl.value, again.token);
        }
      }
      const st = authStatus(cfg);
      report.auth = {
        signed_in: true,
        source: acq.source,
        account: st.account ?? (acq.account ? { name: acq.account.name, email: acq.account.email } : undefined),
        access_token_expires_in_s: acq.expires_in_s,
        has_refresh_token: st.has_refresh_token,
        probe,
      };
      if (probe.outcome === "rejected") {
        report.next_action =
          "The backend rejected the sign-in (401). Usual causes: the backend validates a different tenant/audience than the plugin signed in to, or the token is for another environment. " +
          "Tell the user, then call forge_auth_login(force: true) for a fresh sign-in; if it still fails, compare the backend's OIDC_ISSUER_URL/OIDC_AUDIENCE with forge_config_status → oidc.";
      } else if (probe.outcome === "authenticated_not_provisioned") {
        report.next_action =
          "The sign-in is valid but this account has no IAM user in this backend's database yet (USER_NOT_IN_IAM). Ask the developer to open the Pivotly Portal frontend against this backend once while signed in as this account — that provisions the user — or to run the provisioning route, then call forge_health again. Do not re-trigger sign-in.";
      } else if (probe.outcome === "error") {
        report.next_action = `The /me probe failed (${probe.detail}). The backend is up but may be mid-restart; retry, or probe another authenticated route with forge_request.`;
      }
    }

    // 3. spec discovery (unauthenticated first; fall back to the token if the route needs it)
    const token = acq.ok ? acq.token : "";
    for (const p of SPEC_PATHS) {
      try {
        let r = await doFetch(cfg.apiBaseUrl.value, p, { method: "GET", timeoutMs: 5000 });
        if (r.status === 401 && token) r = await doFetch(cfg.apiBaseUrl.value, p, { method: "GET", headers: { Authorization: `Bearer ${token}` }, timeoutMs: 5000 });
        const j = tryJson(r.body) as Record<string, unknown> | undefined;
        if (r.status === 200 && j && (j.openapi || j.swagger || j.paths)) {
          report.openapi = { path: p, version: j.openapi ?? j.swagger, title: (j.info as Record<string, unknown> | undefined)?.title, path_count: Object.keys((j.paths as object) ?? {}).length };
          break;
        }
      } catch {
        /* next */
      }
    }
    if (!report.openapi) {
      const fromDisk = cfg.backendPath.value && existsSync(join(cfg.backendPath.value, "openapi.json"));
      report.openapi = { found: false, checked: SPEC_PATHS, checkout_copy: fromDisk ? join(cfg.backendPath.value, "openapi.json") : undefined };
    }

    return text(report);
  },
);

/* ------------------------------------------------------------------ */
/* forge_request                                                       */
/* ------------------------------------------------------------------ */
server.tool(
  "forge_request",
  "Send an authenticated HTTP request to the developer's Pivotly backend and return status, headers, timing, and parsed body. Use it to capture real response envelopes and error codes for a skill. Only relative paths are accepted; the signed-in user's bearer token is attached automatically (refreshed silently when expired) and redacted from every output. Mutating requests (POST core-data-write, attachment save/delete, publish) must be confirmed with the user before calling.",
  {
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    path: z.string().describe("Path relative to the configured backend URL, e.g. /api/v3/core-data-read"),
    body: z.unknown().optional().describe("JSON body for POST/PUT/PATCH"),
    query: z.record(z.string()).optional().describe("Query-string parameters"),
    headers: z.record(z.string()).optional().describe("Extra headers (Authorization is set for you and cannot be overridden)"),
    timeout_ms: z.number().int().min(1000).max(60000).default(15000),
  },
  async ({ method, path, body, query, headers, timeout_ms }) => {
    const cfg = loadConfig();
    let acq = await acquireToken(cfg);
    if (!acq.ok) {
      return text({ error: "Not signed in, so authenticated requests cannot be made.", reason: acq.reason, detail: acq.detail, next_action: LOGIN_HINT });
    }

    const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : "";
    const send = async (token: string) => {
      const h: Record<string, string> = { Accept: "application/json", ...(headers ?? {}), Authorization: `Bearer ${token}` };
      const init: RequestInit & { timeoutMs?: number } = { method, headers: h, timeoutMs: timeout_ms };
      if (body !== undefined && method !== "GET") {
        h["Content-Type"] = h["Content-Type"] ?? "application/json";
        init.body = typeof body === "string" ? body : JSON.stringify(body);
      }
      return doFetch(cfg.apiBaseUrl.value, `${assertRelativePath(path)}${qs}`, init);
    };

    try {
      let r = await send(acq.token);
      let refreshed = false;
      // One silent refresh on 401 covers a token that expired between acquire and send.
      if (r.status === 401 && acq.source === "cache") {
        const again = await acquireToken(cfg, { forceRefresh: true });
        if (again.ok) {
          acq = again;
          r = await send(again.token);
          refreshed = true;
        }
      }
      const parsed = tryJson(r.body);
      const m = meta(parsed);
      return text({
        request: { method, path: `${path}${qs}`, has_body: body !== undefined },
        status: r.status,
        ms: r.ms,
        headers: pick(r.headers, ["content-type", "x-request-id", "x-tx-id", "location"]),
        body: parsed ?? r.body.slice(0, 20000),
        body_truncated: parsed === undefined && r.body.length > 20000,
        token_refreshed: refreshed || undefined,
        next_action:
          r.status === 401
            ? String(m?.code) === "USER_NOT_IN_IAM"
              ? "Signed in, but this account is not provisioned in this backend's IAM. See forge_health for the fix; do not re-trigger sign-in."
              : "The backend rejected the sign-in. Call forge_health to diagnose, or forge_auth_login(force: true) for a fresh sign-in."
            : undefined,
      });
    } catch (e) {
      return text({ error: String(e), request: { method, path }, base_url: cfg.apiBaseUrl.value });
    }
  },
);

/* ------------------------------------------------------------------ */
/* forge_openapi                                                       */
/* ------------------------------------------------------------------ */

interface OpenApiDoc {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, Record<string, Record<string, unknown>>>;
}

function inventoryOf(doc: OpenApiDoc, filter?: string) {
  const inventory: unknown[] = [];
  for (const [path, ops] of Object.entries(doc.paths ?? {})) {
    if (filter && !path.includes(filter)) continue;
    for (const [method, opRaw] of Object.entries(ops)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      const op = opRaw as Record<string, unknown>;
      const params = (op.parameters as Array<Record<string, unknown>> | undefined) ?? [];
      const reqBody = op.requestBody as Record<string, unknown> | undefined;
      const content = reqBody?.content as Record<string, Record<string, unknown>> | undefined;
      inventory.push({
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? op.description ?? null,
        tags: op.tags ?? [],
        parameters: params.map((q) => ({ name: q.name, in: q.in, required: Boolean(q.required), type: (q.schema as Record<string, unknown> | undefined)?.type ?? null })),
        request_body: content?.["application/json"]?.schema ?? content?.["multipart/form-data"]?.schema ?? null,
        responses: Object.fromEntries(Object.entries((op.responses as Record<string, Record<string, unknown>> | undefined) ?? {}).map(([code, res]) => [code, res.description ?? ""])),
      });
    }
  }
  return inventory;
}

server.tool(
  "forge_openapi",
  "Fetch the OpenAPI document the backend serves (auto-discovers the path, or takes one; falls back to openapi.json in the backend checkout when nothing is served) and return a normalized inventory: every path+method with summary, parameters, request-body schema, and response codes. Pass filter to narrow to paths containing a substring (e.g. 'core-data', 'attachments', '/me'). The core backend has ~435 operations, so filter before reading.",
  {
    spec_path: z.string().optional().describe("Override the spec path if auto-discovery fails"),
    filter: z.string().optional().describe("Only include paths containing this substring"),
    raw: z.boolean().default(false).describe("Return the raw document instead of the normalized inventory (large — combine with filter, or avoid)"),
  },
  async ({ spec_path, filter, raw }) => {
    const cfg = loadConfig();
    const acq = await acquireToken(cfg);
    const token = acq.ok ? acq.token : "";
    const candidates = spec_path ? [spec_path] : SPEC_PATHS;

    const finish = (doc: OpenApiDoc, source: Record<string, unknown>) => {
      if (raw) return text(doc);
      const operations = inventoryOf(doc, filter);
      return text({ ...source, version: doc.openapi ?? doc.swagger, title: doc.info?.title, api_version: doc.info?.version, count: operations.length, operations });
    };

    for (const p of candidates) {
      try {
        let r = await doFetch(cfg.apiBaseUrl.value, p, { method: "GET", timeoutMs: 8000 });
        if (r.status === 401 && token) r = await doFetch(cfg.apiBaseUrl.value, p, { method: "GET", headers: { Authorization: `Bearer ${token}` }, timeoutMs: 8000 });
        const doc = tryJson(r.body) as OpenApiDoc | undefined;
        if (r.status !== 200 || !doc || !(doc.openapi || doc.swagger || doc.paths)) continue;
        return finish(doc, { source: "served", spec_path: p });
      } catch {
        /* next */
      }
    }

    // Nothing served: the checkout ships a copy, which is at least as current as the last commit.
    if (cfg.backendPath.value) {
      const onDisk = join(cfg.backendPath.value, "openapi.json");
      if (existsSync(onDisk)) {
        try {
          const doc = JSON.parse(readFileSync(onDisk, "utf8")) as OpenApiDoc;
          return finish(doc, { source: "checkout", file: onDisk, note: "The running backend served no spec; this is the checkout's committed copy. Confirm with forge_git_state that the checkout is current." });
        } catch (e) {
          return text({ found: false, checked: candidates, checkout_copy_error: String(e) });
        }
      }
    }

    return text({
      found: false,
      checked: candidates,
      base_url: cfg.apiBaseUrl.value,
      next_action: "No served spec and no openapi.json in the checkout. Fall back to codebase-mine: derive the contract from route files and Zod schemas.",
    });
  },
);

/* ------------------------------------------------------------------ */
/* forge_git_state                                                     */
/* ------------------------------------------------------------------ */
server.tool(
  "forge_git_state",
  "Report the backend repo's git state: current branch, dirty file count, commits behind origin/main, last commit. Run before codebase-mine so extracted contracts match what's actually deployed. Read-only; never checks out, pulls, or resets.",
  { fetch: z.boolean().default(true).describe("Run 'git fetch origin main' first so 'behind' is accurate") },
  async ({ fetch: doFetchRemote }) => {
    const cfg = loadConfig();
    const BACKEND_PATH = cfg.backendPath.value;
    if (!BACKEND_PATH) {
      return text({ error: "No backend repo path is stored.", next_action: `No backend checkout path stored. ${SETUP_HINT}`, config_path: CONFIG_PATH });
    }
    const git = async (...args: string[]) => (await execFileP("git", ["-C", BACKEND_PATH, ...args], { timeout: 20000 })).stdout.trim();
    try {
      await git("rev-parse", "--is-inside-work-tree");
    } catch (e) {
      return text({
        error: `Not a git repo: ${BACKEND_PATH}`,
        detail: String(e),
        next_action: 'Prompt for the correct backend checkout path with forge_config_collect(keys: ["backend_path"], force: true).',
      });
    }
    if (doFetchRemote) {
      try {
        await git("fetch", "origin", "main", "--quiet");
      } catch {
        /* offline is fine */
      }
    }
    const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
    const dirty = (await git("status", "--porcelain")).split("\n").filter(Boolean).length;
    let behind: number | null = null;
    try {
      behind = Number(await git("rev-list", "--count", "HEAD..origin/main"));
    } catch {
      behind = null;
    }
    const last = await git("log", "-1", "--format=%h %ad %s", "--date=short");
    const reminders: string[] = [];
    if (branch !== "main") reminders.push(`On branch '${branch}', not 'main'. Ask the user to switch or confirm intentionally mining this branch.`);
    if (behind && behind > 0) reminders.push(`Local is ${behind} commit(s) behind origin/main. Ask the user to 'git pull' before mining.`);
    if (dirty > 0) reminders.push(`${dirty} uncommitted change(s). Mined contracts may include unmerged work; note this in the skill's provenance.`);
    return text({ path: BACKEND_PATH, branch, dirty_files: dirty, behind_origin_main: behind, last_commit: last, ready: reminders.length === 0, reminders });
  },
);

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

// Earlier versions of this plugin wrote a pasted token into config.json. Upgrading must not
// leave a credential behind in a file the developer is now told is never used. stderr,
// never stdout: stdout is the JSON-RPC transport.
if (purgeLegacyStoredToken()) {
  console.error("[skill-forge] Removed a pasted token left in config.json by an earlier version — sign-in is now via forge_auth_login (browser), cached in token.json.");
}

const transport = new StdioServerTransport();
await server.connect(transport);
