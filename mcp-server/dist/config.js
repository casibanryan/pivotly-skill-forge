/**
 * Config store for pivotly-skill-forge.
 *
 * Values live in a per-developer JSON file, not in the environment, so installing the
 * plugin is enough to start: Claude collects the values interactively (forge_config_set)
 * the first time a tool needs them.
 *
 * Resolution order per value: config file → environment variable → built-in default.
 * The file wins so that a value the developer just set takes effect immediately, even if
 * a stale variable is still exported in their shell.
 *
 * Nothing here is cached: every tool call re-reads the file, so configuring and using a
 * value in the same session works without restarting the server.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
export const CONFIG_KEYS = ["api_base_url", "token", "backend_path"];
export const DEFAULT_API_BASE_URL = "http://localhost:3000";
/** Env vars kept as a fallback for CI and containers; never required for normal use. */
const ENV_FALLBACK = {
    api_base_url: "PIVOTLY_API_BASE_URL",
    token: "PIVOTLY_MCP_TOKEN",
    backend_path: "PIVOTLY_BACKEND_PATH",
};
export const CONFIG_PATH = process.env.PIVOTLY_SKILL_FORGE_CONFIG?.trim() ||
    join(homedir(), ".pivotly-skill-forge", "config.json");
function expandHome(p) {
    if (p === "~")
        return homedir();
    if (p.startsWith("~/") || p.startsWith("~\\"))
        return join(homedir(), p.slice(2));
    return p;
}
export function readStored() {
    try {
        if (!existsSync(CONFIG_PATH))
            return {};
        const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return {};
        const out = {};
        for (const k of CONFIG_KEYS) {
            const v = parsed[k];
            if (typeof v === "string" && v.trim())
                out[k] = v.trim();
        }
        return out;
    }
    catch {
        // A corrupt or unreadable file behaves like an empty one; setup can rewrite it.
        return {};
    }
}
export function writeStored(next) {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    const body = {};
    for (const k of CONFIG_KEYS)
        if (next[k])
            body[k] = next[k];
    writeFileSync(CONFIG_PATH, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
        chmodSync(CONFIG_PATH, 0o600); // no-op on Windows; matters on POSIX where the file pre-existed
    }
    catch {
        /* best effort */
    }
}
function resolveOne(key, stored, fallback) {
    const fromFile = stored[key];
    if (fromFile)
        return { value: fromFile, source: "config" };
    const fromEnv = process.env[ENV_FALLBACK[key]]?.trim();
    if (fromEnv)
        return { value: fromEnv, source: "env" };
    if (fallback)
        return { value: fallback, source: "default" };
    return { value: "", source: "unset" };
}
export function loadConfig() {
    const stored = readStored();
    const api = resolveOne("api_base_url", stored, DEFAULT_API_BASE_URL);
    return {
        apiBaseUrl: { value: api.value.replace(/\/+$/, ""), source: api.source },
        token: resolveOne("token", stored),
        backendPath: (() => {
            const r = resolveOne("backend_path", stored);
            return r.value ? { value: expandHome(r.value), source: r.source } : r;
        })(),
    };
}
/* ---------------------------------------------------------------- */
/* Validation used by forge_config_set                               */
/* ---------------------------------------------------------------- */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "host.docker.internal"]);
export function isLocalHost(host) {
    const h = host.toLowerCase();
    return LOCAL_HOSTS.has(h) || h.endsWith(".local") || h.endsWith(".localhost") || /^192\.168\./.test(h) || /^10\./.test(h);
}
export function validateApiBaseUrl(raw, allowRemote) {
    const trimmed = raw.trim().replace(/\/+$/, "");
    if (!trimmed)
        return { ok: false, error: "api_base_url is empty." };
    let url;
    try {
        url = new URL(trimmed);
    }
    catch {
        return { ok: false, error: `Not a valid URL: ${trimmed}. Include the scheme, e.g. http://localhost:3000` };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { ok: false, error: `Unsupported scheme '${url.protocol}'. Use http:// or https://` };
    }
    if (!isLocalHost(url.hostname) && !allowRemote) {
        return {
            ok: false,
            error: `'${url.hostname}' is not a local host. skill-forge probes and may write to this backend, so it must never point at production. ` +
                "If this really is a dev environment, ask the user to confirm and call forge_config_set again with allow_remote: true.",
        };
    }
    return {
        ok: true,
        value: trimmed,
        warning: isLocalHost(url.hostname) ? undefined : `Non-local backend '${url.hostname}' accepted on explicit confirmation. Writes here affect a shared environment.`,
    };
}
export function validateToken(raw) {
    const trimmed = raw.trim().replace(/^Bearer\s+/i, "");
    if (!trimmed)
        return { ok: false, error: "token is empty." };
    if (/^(dev-token-placeholder|<.*>|your[-_]token|xxx+)$/i.test(trimmed)) {
        return { ok: false, error: "That looks like a placeholder, not a real token. Ask the user for the dev bearer token issued by the backend." };
    }
    return { ok: true, value: trimmed };
}
/** Git Bash / WSL spellings of a Windows path that Node itself cannot resolve. */
function windowsEquivalent(p) {
    if (process.platform !== "win32")
        return undefined;
    const m = /^\/(?:mnt\/)?([a-z])\/(.*)$/i.exec(p);
    return m ? `${m[1].toUpperCase()}:/${m[2]}` : undefined;
}
export function validateBackendPath(raw) {
    let p = expandHome(raw.trim().replace(/^["']|["']$/g, ""));
    if (!p)
        return { ok: false, error: "backend_path is empty." };
    if (!existsSync(p)) {
        // Accept a Git Bash / WSL path if the Windows form of it exists.
        const win = windowsEquivalent(p);
        if (win && existsSync(win))
            p = win;
        else
            return { ok: false, error: `Path does not exist: ${p}${win ? ` (also tried ${win})` : ""}` };
    }
    try {
        if (!statSync(p).isDirectory())
            return { ok: false, error: `Not a directory: ${p}` };
    }
    catch (e) {
        return { ok: false, error: `Cannot read path: ${p} (${String(e)})` };
    }
    return { ok: true, value: p };
}
/** Never returns the token itself — only enough to tell two tokens apart. */
export function tokenHint(token) {
    if (!token)
        return "";
    return token.length <= 8 ? `${"•".repeat(token.length)}` : `••••${token.slice(-4)} (${token.length} chars)`;
}
