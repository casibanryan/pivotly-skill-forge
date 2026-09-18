/**
 * pivotly-skill-forge MCP server
 *
 * Seven small tools that need either credentials or a live process — everything else
 * (reading code, writing skills) is done by the host's own file tools.
 *
 *   forge_config_status — what is configured, where each value came from, what is missing
 *   forge_config_collect— prompt the developer for missing settings, one input at a time
 *   forge_config_set    — store backend URL / repo path; token goes to session memory only
 *   forge_config_clear  — forget one or all stored values
 *   forge_health        — is the backend up, what version, does it serve an API spec
 *   forge_request       — authenticated HTTP request to the backend; token never leaves this process
 *   forge_openapi       — fetch + normalize the served OpenAPI/Swagger document
 *   forge_git_state     — branch, dirty status, commits behind origin/main for the backend repo
 *
 * The backend URL and checkout path live in ~/.pivotly-skill-forge/config.json (see config.ts).
 * The dev token never does: it is prompted for once per session and held in this process's
 * memory, so nothing token-shaped is ever written to disk. Every setting is collected through
 * a real input prompt (MCP elicitation), not by asking the model to request it in chat.
 * Environment variables of the same name still work as a fallback for CI, but no developer has
 * to set one to install the plugin.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CONFIG_KEYS,
  CONFIG_PATH,
  DEFAULT_API_BASE_URL,
  clearSessionToken,
  getSessionToken,
  loadConfig,
  purgeLegacyStoredToken,
  readStored,
  setSessionToken,
  tokenHint,
  validateApiBaseUrl,
  validateBackendPath,
  validateToken,
  writeStored,
  type ConfigKey,
  type StoredConfig,
} from "./config.js";

const execFileP = promisify(execFile);

// Candidate locations for a served API description. Checked in order.
const SPEC_PATHS = [
  "/api/v3/openapi.json",
  "/api/openapi.json",
  "/openapi.json",
  "/swagger.json",
  "/api-docs",
  "/api/v3/docs-json",
  "/docs-json",
];
const HEALTH_PATHS = ["/health", "/healthz", "/api/health", "/api/v3/health", "/"];

const SETUP_HINT =
  "Call forge_config_collect to prompt the developer for it directly, one input at a time — do not ask for values in conversation, " +
  "and never tell them to set an environment variable or edit a file. /skill-forge-setup walks through every setting.";

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

function redact(s: string, token: string): string {
  return token ? s.split(token).join("<redacted-token>") : s;
}

function text(payload: unknown, token?: string) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  // Default to re-reading the token so a response can never leak it, even on paths that
  // did not otherwise need the config.
  const t = token ?? loadConfig().token.value;
  return { content: [{ type: "text" as const, text: redact(body, t) }] };
}

function assertSamePath(path: string): string {
  // Only relative paths against the configured base URL are allowed; refuse absolute URLs
  // so the token can never be sent anywhere except the configured backend.
  if (/^[a-z]+:\/\//i.test(path)) {
    throw new Error("Absolute URLs are not allowed; pass a path relative to the configured backend URL.");
  }
  return path.startsWith("/") ? path : `/${path}`;
}

async function doFetch(
  baseUrl: string,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ status: number; headers: Record<string, string>; body: string; ms: number }> {
  const url = `${baseUrl}${assertSamePath(path)}`;
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

async function isGitRepo(path: string): Promise<boolean> {
  try {
    await execFileP("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/** Config as reported to the model. The token value itself is never included. */
async function configReport(): Promise<Record<string, unknown>> {
  const cfg = loadConfig();
  const missing: string[] = [];
  if (!cfg.token.value) missing.push("token");
  if (!cfg.backendPath.value) missing.push("backend_path");

  const backend: Record<string, unknown> = { source: cfg.backendPath.source };
  if (cfg.backendPath.value) {
    backend.path = cfg.backendPath.value;
    const ok = await isGitRepo(cfg.backendPath.value);
    backend.is_git_repo = ok;
    if (!ok) {
      backend.problem = "Stored path is not a git checkout. Prompt for the right one with forge_config_collect(keys: [\"backend_path\"], force: true).";
    }
  }

  const notes: string[] = [];
  if (missing.includes("token")) {
    notes.push(
      "No token this session: forge_request and authenticated probes are unavailable. The token is never stored on disk, " +
        "so it is collected once per session — call forge_config_collect(keys: [\"token\"]).",
    );
  }
  if (missing.includes("backend_path")) notes.push("No backend repo path stored: forge_git_state and codebase-mine are unavailable.");
  if (cfg.apiBaseUrl.source === "default") {
    notes.push(`No backend URL stored; using the default ${DEFAULT_API_BASE_URL}. Confirm it with the user if a probe fails.`);
  }

  return {
    config_path: CONFIG_PATH,
    api_base_url: { value: cfg.apiBaseUrl.value, source: cfg.apiBaseUrl.source },
    token: {
      configured: Boolean(cfg.token.value),
      hint: tokenHint(cfg.token.value) || undefined,
      source: cfg.token.source,
      persisted: false,
      scope: "session — held in the server process only, never written to disk, gone when the session ends",
    },
    backend_path: backend,
    missing,
    notes,
    next_action: missing.length ? SETUP_HINT : undefined,
  };
}

const server = new McpServer({ name: "pivotly-skill-forge", version: "0.2.0" });

/* ------------------------------------------------------------------ */
/* Interactive prompts (MCP elicitation)                               */
/* ------------------------------------------------------------------ */

/**
 * Every setting is collected through a real input prompt in the host UI rather than by
 * asking the model to request it in prose. That matters most for the token: a value typed
 * into an elicitation form travels client → server over the protocol, so it need never
 * enter the model's context or the chat transcript, whereas "paste your token in chat"
 * always lands in both.
 *
 * The MCP form schema has no masked/password field type, and the spec discourages using
 * form mode for credentials for that reason — but the alternative here is strictly worse,
 * so the field carries an explicit warning in its description instead.
 *
 * One field per call, deliberately: the developer answers one question at a time.
 */

type PromptKey = ConfigKey;

interface Prompt {
  message: string;
  title: string;
  description: string;
  withDefault?: () => string | undefined;
}

// No `format` constraints here on purpose. The SDK validates the developer's answer against
// requestedSchema and THROWS on a mismatch, which would surface as a protocol failure rather
// than as "that value was not accepted, try again" — and `format: "uri"` rejects perfectly
// reasonable answers like "localhost". Every value is checked by validateFor() instead, which
// produces an explanation the developer can act on and a prompt they can correct.
const PROMPTS: Record<PromptKey, Prompt> = {
  api_base_url: {
    message: "Which URL is your Pivotly backend running on?",
    title: "Backend URL",
    description: `Include the scheme and port, e.g. ${DEFAULT_API_BASE_URL}. Must be a local/dev host — never production.`,
    withDefault: () => DEFAULT_API_BASE_URL,
  },
  token: {
    message: "Paste your Pivotly dev bearer token.",
    title: "Dev bearer token",
    description:
      "Held in the skill-forge server's memory for this session only — never written to disk and never echoed back. " +
      "This field is not masked, so nobody should use a production credential here.",
  },
  backend_path: {
    message: "Where is your Pivotly backend git checkout?",
    title: "Backend checkout path",
    description: "Absolute path to the directory containing .git, e.g. C:\\Users\\you\\dev\\pivotly-core. ~, /c/… and /mnt/c/… are accepted.",
  },
};

function clientSupportsElicitation(): boolean {
  try {
    return Boolean(server.server.getClientCapabilities()?.elicitation);
  } catch {
    return false;
  }
}

/**
 * What the connected host advertised at initialize. Reported when prompts are unavailable so
 * "this host has no elicitation" can be distinguished from "elicitation failed for some other
 * reason" without having to guess which one happened.
 */
function observedClientCapabilities(): Record<string, unknown> {
  try {
    const caps = server.server.getClientCapabilities();
    return {
      advertised: caps ? Object.keys(caps) : [],
      elicitation: caps?.elicitation ?? null,
    };
  } catch (e) {
    return { error: String(e) };
  }
}

type PromptOutcome =
  | { status: "value"; value: string }
  | { status: "declined" | "cancelled" }
  | { status: "invalid"; reason: string }
  | { status: "unsupported"; reason: string };

/** Validate a prompted value with the same rules forge_config_set applies. */
function validateFor(key: PromptKey, value: string, allowRemote = false) {
  if (key === "api_base_url") return validateApiBaseUrl(value, allowRemote);
  if (key === "token") return validateToken(value);
  return validateBackendPath(value);
}

/**
 * A prompt can block for as long as the developer takes to find a token in a password
 * manager. The SDK's default request timeout is 60s, which would discard a perfectly good
 * answer and abort the run, so ask for a much longer one.
 */
const PROMPT_TIMEOUT_MS = 600_000;

/** Ask the developer for one value. Never throws; each failure mode is a distinct outcome. */
async function promptFor(key: PromptKey, retryError?: string): Promise<PromptOutcome> {
  if (!clientSupportsElicitation()) {
    return { status: "unsupported", reason: "This host does not support MCP elicitation prompts." };
  }
  const p = PROMPTS[key];
  const schema: Record<string, unknown> = {
    type: "string",
    title: p.title,
    description: retryError ? `${retryError} — ${p.description}` : p.description,
    minLength: 1,
  };
  const def = p.withDefault?.();
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
    // Not every throw means the host lacks prompts, and treating them alike is how a bad
    // answer gets reported as a missing capability and abandons the remaining settings.
    // -32601 / "does not support" is a real capability failure; anything else is this one
    // prompt going wrong, which the caller can retry.
    const code = (e as { code?: unknown })?.code;
    const msg = e instanceof Error ? e.message : String(e);
    if (code === -32601 || /does not support/i.test(msg)) {
      return { status: "unsupported", reason: msg };
    }
    return { status: "invalid", reason: msg };
  }
}

/* ------------------------------------------------------------------ */
/* forge_config_status                                                 */
/* ------------------------------------------------------------------ */
server.tool(
  "forge_config_status",
  "Report which skill-forge settings this developer has stored (backend URL, dev token, backend repo path), where each value came from, and what is still missing. Call it at the start of a forge workflow and whenever another tool reports a missing setting. Never returns the token itself.",
  {},
  async () => text(await configReport()),
);

/* ------------------------------------------------------------------ */
/* forge_config_set                                                    */
/* ------------------------------------------------------------------ */
server.tool(
  "forge_config_set",
  "Store one or more skill-forge settings for this developer, collected by asking them in conversation — no environment variables, no file editing. Each value is validated before it is written (the URL is parsed and must be a local/dev host; backend_path must exist and be a git checkout) and takes effect immediately with no restart. The token is held in memory for this session only and is never written to disk or echoed back. Prefer forge_config_collect, which prompts the developer directly; use this tool when you already have a value in hand.",
  {
    api_base_url: z.string().optional().describe("Base URL of the developer's running Pivotly backend, e.g. http://localhost:3000"),
    token: z
      .string()
      .optional()
      .describe("Dev bearer token for that backend. Kept in the server process for this session only — never written to disk — and redacted from every tool output."),
    backend_path: z.string().optional().describe("Absolute path to the local Pivotly backend git checkout"),
    allow_remote: z
      .boolean()
      .default(false)
      .describe("Set only after the user explicitly confirms that a non-local api_base_url is a dev environment. Required for any host that is not localhost or a private address."),
  },
  async ({ api_base_url, token, backend_path, allow_remote }) => {
    if (api_base_url === undefined && token === undefined && backend_path === undefined) {
      return text({
        error: "Nothing to set. Pass at least one of api_base_url, token, backend_path.",
        config: await configReport(),
      });
    }

    const stored: StoredConfig = readStored();
    const applied: string[] = [];
    const warnings: string[] = [];
    const rejected: string[] = [];

    if (api_base_url !== undefined) {
      const v = validateApiBaseUrl(api_base_url, allow_remote);
      if (!v.ok) rejected.push(v.error as string);
      else {
        stored.api_base_url = v.value;
        applied.push(`api_base_url = ${v.value}`);
        if (v.warning) warnings.push(v.warning);
      }
    }

    if (token !== undefined) {
      const v = validateToken(token);
      if (!v.ok) rejected.push(v.error as string);
      else {
        // Session memory, never `stored` — the token must not reach writeStored at all.
        setSessionToken(v.value as string);
        applied.push(`token = ${tokenHint(v.value as string)} (this session only, not written to disk)`);
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

    if (applied.length) {
      try {
        writeStored(stored);
      } catch (e) {
        return text({ error: `Could not write ${CONFIG_PATH}: ${String(e)}`, applied: [], rejected });
      }
    }

    return text({
      saved_to: applied.length ? CONFIG_PATH : undefined,
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
  "Collect skill-forge settings by prompting the developer directly, one input at a time, in the host's own UI. This is the preferred way to set anything up: call it instead of asking the user for values in conversation. By default it prompts only for what is missing — the backend URL, the dev token (session-only), and the backend checkout path. Each answer is validated as it arrives and a rejected value is re-prompted once. Returns what was collected; never returns the token.",
  {
    keys: z
      .array(z.enum(["api_base_url", "token", "backend_path"]))
      .optional()
      .describe("Which settings to prompt for, in this order. Omit to prompt for everything not already available."),
    force: z
      .boolean()
      .default(false)
      .describe("Prompt even for settings that already have a value — use when the developer wants to change one (rotated token, different port, moved checkout)."),
    allow_remote: z
      .boolean()
      .default(false)
      .describe(
        "Set only after the developer explicitly confirms that a non-local backend URL is a dev environment. Without it a non-local URL is refused, and refused again on every retry. Never pass it on your own initiative.",
      ),
  },
  async ({ keys, force, allow_remote }) => {
    const cfg = loadConfig();
    const have: Record<ConfigKey, boolean> = {
      // A default-sourced URL is not something the developer chose, so it still counts as missing.
      api_base_url: cfg.apiBaseUrl.source !== "default" && cfg.apiBaseUrl.source !== "unset",
      token: Boolean(cfg.token.value),
      backend_path: Boolean(cfg.backendPath.value),
    };
    const order: ConfigKey[] = keys?.length ? (keys as ConfigKey[]) : ["api_base_url", "token", "backend_path"];
    const wanted = force ? order : order.filter((k) => !have[k]);

    if (!wanted.length) {
      return text({
        prompted: [],
        note: "Everything these settings cover is already available this session. Pass force: true to change one.",
        config: await configReport(),
      });
    }

    if (!clientSupportsElicitation()) {
      return text({
        error: "This host does not support input prompts (MCP elicitation).",
        needed: wanted,
        // Report what the host actually advertised, so "no prompts" can be told apart from
        // "prompts, but something else went wrong" without guessing.
        client_capabilities: observedClientCapabilities(),
        next_action:
          "Fall back to asking the developer for each of these in conversation, one at a time, then store each with forge_config_set. " +
          "Say once, plainly, that a token typed into chat stays in the transcript. " +
          "Do not tell them to set an environment variable or edit a file.",
        config: await configReport(),
      });
    }

    // Values are collected into `pending` and merged onto a FRESH read at write time. Reading
    // the file up front and writing it back after the prompts would span however long the
    // developer takes to answer, silently clobbering anything written in the meantime.
    const pending: StoredConfig = {};
    const collected: string[] = [];
    const rejected: string[] = [];
    const skipped: string[] = [];
    let persistNeeded = false;
    let stoppedAt: string | undefined;

    for (const key of wanted) {
      let outcome = await promptFor(key);

      // One retry, carrying the error into the prompt so the developer sees why. Covers both
      // a value our own rules reject and a prompt the client itself refused.
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
          continue; // one bad answer must not abandon the remaining settings
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
        collected.push(`token = ${tokenHint(v.value as string)} (this session only, not written to disk)`);
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
          : "Verify with forge_health (URL/token) and forge_git_state (checkout path).",
    });
  },
);

/* ------------------------------------------------------------------ */
/* forge_config_clear                                                  */
/* ------------------------------------------------------------------ */
server.tool(
  "forge_config_clear",
  "Forget skill-forge settings — one key, or all of them. Clearing the token just drops it from session memory (it was never on disk). Use it when the developer rotates their token, switches backend checkouts, or wants the machine left clean. Only touches this plugin's own config file; never the backend or the repo.",
  {
    keys: z
      .array(z.enum(["api_base_url", "token", "backend_path"]))
      .optional()
      .describe("Which settings to forget. Omit to clear all of them — confirm with the user first."),
  },
  async ({ keys }) => {
    const target = (keys?.length ? keys : CONFIG_KEYS) as ConfigKey[];
    const stored = readStored();
    const removed: ConfigKey[] = [];

    // The token lives in memory, not in the file, so clearing it is a separate action.
    if (target.includes("token")) {
      if (getSessionToken()) removed.push("token");
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
      not_stored: target.filter((k) => !removed.includes(k)),
      note: removed.includes("token") ? "The token was only ever in memory; nothing token-shaped had to be erased from disk." : undefined,
      config: await configReport(),
    });
  },
);

/* ------------------------------------------------------------------ */
/* forge_health                                                        */
/* ------------------------------------------------------------------ */
server.tool(
  "forge_health",
  "Check whether the developer's Pivotly backend is reachable, which health endpoint answers, whether the stored token is accepted, and whether an OpenAPI/Swagger document is served. Call this first in any api-verify workflow; when a setting is missing it names the one to collect.",
  {},
  async () => {
    const cfg = loadConfig();
    const BASE_URL = cfg.apiBaseUrl.value;
    const TOKEN = cfg.token.value;
    const report: Record<string, unknown> = {
      base_url: BASE_URL,
      base_url_source: cfg.apiBaseUrl.source,
      token_configured: Boolean(TOKEN),
    };

    // 1. reachability
    let reachable = false;
    for (const p of HEALTH_PATHS) {
      try {
        const r = await doFetch(BASE_URL, p, { method: "GET", timeoutMs: 5000 });
        reachable = true;
        report.health = { path: p, status: r.status, body: tryJson(r.body) ?? r.body.slice(0, 300) };
        break;
      } catch {
        /* try next */
      }
    }
    report.reachable = reachable;
    if (!reachable) {
      report.next_action =
        cfg.apiBaseUrl.source === "default"
          ? `Nothing answered at the default ${BASE_URL}, and no backend URL is stored. Ask whether the backend is running, then prompt for the URL with forge_config_collect(keys: [\"api_base_url\"], force: true).`
          : `Backend not reachable at ${BASE_URL}. Ask the user to start the core backend, or prompt for a corrected URL with forge_config_collect(keys: [\"api_base_url\"], force: true).`;
      return text(report, TOKEN);
    }

    // 2. token acceptance — a cheap authenticated read against a route that requires auth
    if (TOKEN) {
      try {
        const r = await doFetch(BASE_URL, "/api/v3/data-views/publications", {
          method: "GET",
          headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
          timeoutMs: 8000,
        });
        report.auth_probe = {
          path: "/api/v3/data-views/publications",
          status: r.status,
          accepted: r.status !== 401 && r.status !== 403,
        };
        if (r.status === 401 || r.status === 403) {
          report.next_action =
            "The token was rejected. Tell the user it was rejected (never quote it), then call forge_config_collect(keys: [\"token\"], force: true) to prompt for a current one — do not ask them to paste it into the chat.";
        }
      } catch (e) {
        report.auth_probe = { error: String(e) };
      }
    } else {
      report.auth_probe = { skipped: "No token stored." };
      report.next_action = `No dev token stored yet. ${SETUP_HINT}`;
    }

    // 3. spec discovery
    for (const p of SPEC_PATHS) {
      try {
        const r = await doFetch(BASE_URL, p, { method: "GET", timeoutMs: 5000 });
        const j = tryJson(r.body) as Record<string, unknown> | undefined;
        if (r.status === 200 && j && (j.openapi || j.swagger || j.paths)) {
          report.openapi = { path: p, version: j.openapi ?? j.swagger, path_count: Object.keys((j.paths as object) ?? {}).length };
          break;
        }
      } catch {
        /* next */
      }
    }
    if (!report.openapi) report.openapi = { found: false, checked: SPEC_PATHS };

    return text(report, TOKEN);
  },
);

/* ------------------------------------------------------------------ */
/* forge_request                                                       */
/* ------------------------------------------------------------------ */
server.tool(
  "forge_request",
  "Send an authenticated HTTP request to the developer's Pivotly backend and return status, headers, timing, and parsed body. Use it to capture real response envelopes and error codes for a skill. Only relative paths are accepted; the stored bearer token is attached automatically and is redacted from every output. Mutating requests (POST core-data-write, attachment save/delete, cursor save) must be confirmed with the user before calling.",
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
    const TOKEN = cfg.token.value;
    if (!TOKEN) {
      return text({
        error: "No dev bearer token is stored, so authenticated requests cannot be made.",
        next_action: `No token this session — it is never stored on disk. ${SETUP_HINT}`,
        config_path: CONFIG_PATH,
      });
    }

    const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : "";
    const h: Record<string, string> = {
      Accept: "application/json",
      ...(headers ?? {}),
      Authorization: `Bearer ${TOKEN}`,
    };
    const init: RequestInit & { timeoutMs?: number } = { method, headers: h, timeoutMs: timeout_ms };
    if (body !== undefined && method !== "GET") {
      h["Content-Type"] = h["Content-Type"] ?? "application/json";
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    try {
      const r = await doFetch(cfg.apiBaseUrl.value, `${assertSamePath(path)}${qs}`, init);
      const parsed = tryJson(r.body);
      return text(
        {
          request: { method, path: `${path}${qs}`, has_body: body !== undefined },
          status: r.status,
          ms: r.ms,
          headers: pick(r.headers, ["content-type", "x-request-id", "x-tx-id", "location"]),
          body: parsed ?? r.body.slice(0, 20000),
          body_truncated: parsed === undefined && r.body.length > 20000,
        },
        TOKEN,
      );
    } catch (e) {
      return text({ error: String(e), request: { method, path }, base_url: cfg.apiBaseUrl.value }, TOKEN);
    }
  },
);

/* ------------------------------------------------------------------ */
/* forge_openapi                                                       */
/* ------------------------------------------------------------------ */
server.tool(
  "forge_openapi",
  "Fetch the OpenAPI/Swagger document the backend serves (auto-discovers the path, or takes one) and return a normalized inventory: every path+method with summary, parameters, request-body schema ref, and response codes. Pass filter to narrow to paths containing a substring (e.g. 'core-data').",
  {
    spec_path: z.string().optional().describe("Override the spec path if auto-discovery fails"),
    filter: z.string().optional().describe("Only include paths containing this substring"),
    raw: z.boolean().default(false).describe("Return the raw document instead of the normalized inventory"),
  },
  async ({ spec_path, filter, raw }) => {
    const cfg = loadConfig();
    const TOKEN = cfg.token.value;
    const candidates = spec_path ? [spec_path] : SPEC_PATHS;
    for (const p of candidates) {
      try {
        const r = await doFetch(cfg.apiBaseUrl.value, p, {
          method: "GET",
          headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
          timeoutMs: 8000,
        });
        const doc = tryJson(r.body) as Record<string, any> | undefined;
        if (r.status !== 200 || !doc || !(doc.openapi || doc.swagger || doc.paths)) continue;
        if (raw) return text(doc, TOKEN);

        const inventory: unknown[] = [];
        for (const [path, ops] of Object.entries<Record<string, any>>(doc.paths ?? {})) {
          if (filter && !path.includes(filter)) continue;
          for (const [method, op] of Object.entries<any>(ops)) {
            if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
            inventory.push({
              method: method.toUpperCase(),
              path,
              summary: op.summary ?? op.description ?? null,
              tags: op.tags ?? [],
              parameters: (op.parameters ?? []).map((q: any) => ({
                name: q.name, in: q.in, required: Boolean(q.required), type: q.schema?.type ?? null,
              })),
              request_body: op.requestBody?.content?.["application/json"]?.schema ?? null,
              responses: Object.fromEntries(
                Object.entries<any>(op.responses ?? {}).map(([code, res]) => [code, res.description ?? ""]),
              ),
            });
          }
        }
        return text({ spec_path: p, version: doc.openapi ?? doc.swagger, title: doc.info?.title, count: inventory.length, operations: inventory }, TOKEN);
      } catch {
        /* next */
      }
    }
    return text(
      {
        found: false,
        checked: candidates,
        base_url: cfg.apiBaseUrl.value,
        next_action: "No served spec. Fall back to codebase-mine: derive the contract from route files and Zod schemas.",
      },
      TOKEN,
    );
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
      return text({
        error: "No backend repo path is stored.",
        next_action: `No backend checkout path stored. ${SETUP_HINT}`,
        config_path: CONFIG_PATH,
      });
    }
    const git = async (...args: string[]) => (await execFileP("git", ["-C", BACKEND_PATH, ...args], { timeout: 20000 })).stdout.trim();
    try {
      await git("rev-parse", "--is-inside-work-tree");
    } catch (e) {
      return text({
        error: `Not a git repo: ${BACKEND_PATH}`,
        detail: String(e),
        next_action: "Prompt for the correct backend checkout path with forge_config_collect(keys: [\"backend_path\"], force: true).",
      });
    }
    if (doFetchRemote) {
      try { await git("fetch", "origin", "main", "--quiet"); } catch { /* offline is fine */ }
    }
    const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
    const dirty = (await git("status", "--porcelain")).split("\n").filter(Boolean).length;
    let behind: number | null = null;
    try { behind = Number(await git("rev-list", "--count", "HEAD..origin/main")); } catch { behind = null; }
    const last = await git("log", "-1", "--format=%h %ad %s", "--date=short");
    const reminders: string[] = [];
    if (branch !== "main") reminders.push(`On branch '${branch}', not 'main'. Ask the user to switch or confirm intentionally mining this branch.`);
    if (behind && behind > 0) reminders.push(`Local is ${behind} commit(s) behind origin/main. Ask the user to 'git pull' before mining.`);
    if (dirty > 0) reminders.push(`${dirty} uncommitted change(s). Mined contracts may include unmerged work; note this in the skill's provenance.`);
    return text({ path: BACKEND_PATH, branch, dirty_files: dirty, behind_origin_main: behind, last_commit: last, ready: reminders.length === 0, reminders });
  },
);

function pick(h: Record<string, string>, keys: string[]) {
  const out: Record<string, string> = {};
  for (const k of keys) if (h[k]) out[k] = h[k];
  return out;
}

// Earlier versions of this plugin wrote the token into config.json. Upgrading must not leave
// a credential behind in a file the developer is now told is never used, so remove it before
// serving anything. stderr, never stdout: stdout is the JSON-RPC transport.
if (purgeLegacyStoredToken()) {
  console.error(
    "[skill-forge] Removed a dev token left in the config file by an earlier version — tokens are now session-only. " +
      "You will be prompted for it once per session.",
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
