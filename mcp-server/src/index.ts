/**
 * pivotly-skill-forge MCP server
 *
 * Seven small tools that need either credentials or a live process — everything else
 * (reading code, writing skills) is done by the host's own file tools.
 *
 *   forge_config_status — what is configured, where each value came from, what is missing
 *   forge_config_set    — store backend URL / token / repo path, collected interactively
 *   forge_config_clear  — forget one or all stored values
 *   forge_health        — is the backend up, what version, does it serve an API spec
 *   forge_request       — authenticated HTTP request to the backend; token never leaves this process
 *   forge_openapi       — fetch + normalize the served OpenAPI/Swagger document
 *   forge_git_state     — branch, dirty status, commits behind origin/main for the backend repo
 *
 * Configuration lives in ~/.pivotly-skill-forge/config.json (see config.ts) and is collected
 * by Claude on first use. Environment variables of the same name still work as a fallback for
 * CI, but no developer has to set one to install the plugin.
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
  loadConfig,
  readStored,
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
  "Collect it by asking the user in conversation; /skill-forge-setup walks through every setting. Nothing needs to go in the environment or into a file by hand.";

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
      backend.problem = "Stored path is not a git checkout. Ask the user for the right one and call forge_config_set(backend_path).";
    }
  }

  const notes: string[] = [];
  if (missing.includes("token")) notes.push("No token stored: forge_request and authenticated probes are unavailable.");
  if (missing.includes("backend_path")) notes.push("No backend repo path stored: forge_git_state and codebase-mine are unavailable.");
  if (cfg.apiBaseUrl.source === "default") {
    notes.push(`No backend URL stored; using the default ${DEFAULT_API_BASE_URL}. Confirm it with the user if a probe fails.`);
  }

  return {
    config_path: CONFIG_PATH,
    api_base_url: { value: cfg.apiBaseUrl.value, source: cfg.apiBaseUrl.source },
    token: { configured: Boolean(cfg.token.value), hint: tokenHint(cfg.token.value) || undefined, source: cfg.token.source },
    backend_path: backend,
    missing,
    notes,
    next_action: missing.length ? SETUP_HINT : undefined,
  };
}

const server = new McpServer({ name: "pivotly-skill-forge", version: "0.2.0" });

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
  "Store one or more skill-forge settings for this developer, collected by asking them in conversation — no environment variables, no file editing. Each value is validated before it is written (the URL is parsed and must be a local/dev host; backend_path must exist and be a git checkout) and takes effect immediately with no restart. The token is written to a private file and is never echoed back. Ask for values one at a time, and only for the settings the current task actually needs.",
  {
    api_base_url: z.string().optional().describe("Base URL of the developer's running Pivotly backend, e.g. http://localhost:3000"),
    token: z
      .string()
      .optional()
      .describe("Dev bearer token for that backend. Stored in the plugin's private config file (mode 600) and redacted from every tool output."),
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
        stored.token = v.value;
        applied.push(`token = ${tokenHint(v.value as string)}`);
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
        ? "Tell the user in plain language what was rejected and why, ask for a corrected value, then call forge_config_set again."
        : undefined,
    });
  },
);

/* ------------------------------------------------------------------ */
/* forge_config_clear                                                  */
/* ------------------------------------------------------------------ */
server.tool(
  "forge_config_clear",
  "Forget stored skill-forge settings — one key, or all of them. Use it when the developer rotates their token, switches backend checkouts, or wants the machine left clean. Only touches this plugin's own config file; never the backend or the repo.",
  {
    keys: z
      .array(z.enum(["api_base_url", "token", "backend_path"]))
      .optional()
      .describe("Which settings to forget. Omit to clear all of them — confirm with the user first."),
  },
  async ({ keys }) => {
    const target = (keys?.length ? keys : CONFIG_KEYS) as ConfigKey[];
    const stored = readStored();
    const removed = target.filter((k) => stored[k] !== undefined);
    for (const k of target) delete stored[k];
    try {
      writeStored(stored);
    } catch (e) {
      return text({ error: `Could not write ${CONFIG_PATH}: ${String(e)}` });
    }
    return text({
      cleared: removed,
      not_stored: target.filter((k) => !removed.includes(k)),
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
          ? `Nothing answered at the default ${BASE_URL}, and no backend URL is stored. Ask the user whether the backend is running and on which port, then store it with forge_config_set(api_base_url).`
          : `Backend not reachable at ${BASE_URL}. Ask the user to start the core backend, or to correct the URL — then store it with forge_config_set(api_base_url).`;
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
            "The stored token was rejected. Tell the user it was rejected (never quote it), ask for a current dev token, and store it with forge_config_set(token).";
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
        next_action: `Ask the user for their Pivotly dev token and store it with forge_config_set(token). ${SETUP_HINT}`,
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
        next_action: `Ask the user for the absolute path to their Pivotly backend checkout and store it with forge_config_set(backend_path). ${SETUP_HINT}`,
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
        next_action: "Ask the user for the correct backend checkout path and store it with forge_config_set(backend_path).",
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

const transport = new StdioServerTransport();
await server.connect(transport);
