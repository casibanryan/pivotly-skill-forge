/**
 * SessionStart hook for pivotly-skill-forge.
 *
 * Prints, into session context: whether the MCP server is built, whether the developer is
 * signed in to Pivotly (from the token cache's metadata — never the tokens), which settings
 * are stored, and — once a backend checkout is known — its git state, so Claude reminds the
 * developer to be on main and pulled before mining.
 *
 * Plain Node with no dependencies, no network, and no bash, so it runs identically on
 * Windows and POSIX and works before anything is built. That is also why config resolution
 * is duplicated from mcp-server/src/config.ts in miniature.
 *
 * Never fails the session — every failure path still exits 0.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const say = (line) => console.log(`[skill-forge] ${line}`);

const BUILTINS = new Set(builtinModules);
/** True for "fs" and "node:fs" alike — both resolve without anything installed. */
const isNodeBuiltin = (spec) => {
  const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
  return BUILTINS.has(bare) || BUILTINS.has(bare.split("/")[0]);
};

const CONFIG_PATH = process.env.PIVOTLY_SKILL_FORGE_CONFIG?.trim() || join(homedir(), ".pivotly-skill-forge", "config.json");
const TOKEN_CACHE_PATH = process.env.PIVOTLY_SKILL_FORGE_TOKEN_CACHE?.trim() || join(dirname(CONFIG_PATH), "token.json");

function readJson(file) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function value(key, envName) {
  const fromFile = readJson(CONFIG_PATH)[key];
  if (typeof fromFile === "string" && fromFile.trim()) return fromFile.trim();
  const fromEnv = process.env[envName]?.trim();
  return fromEnv || "";
}

function git(repo, args, timeout = 8000) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

try {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT?.trim() || resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

  // 1. Can the MCP server actually start? Without it, none of the forge_* tools exist.
  //
  // dist/index.js is committed as a dependency-free esbuild bundle precisely because
  // node_modules/ is gitignored: a plain tsc build leaves bare imports like
  // "@modelcontextprotocol/sdk/..." in the output, which a freshly synced plugin cannot
  // resolve, so Node exits with ERR_MODULE_NOT_FOUND before the transport opens and the host
  // reports only that the connection closed. So check for a *runnable* bundle, not a file.
  const serverRoot = join(pluginRoot, "mcp-server");
  const serverEntry = join(serverRoot, "dist", "index.js");
  const rebuild = `cd "${serverRoot}" && npm install && npm run build`;

  if (!existsSync(serverEntry)) {
    say(`The skill-forge MCP server is not built, so the forge_* tools are unavailable. Offer to run: ${rebuild} — then the session must be restarted to pick up the tools.`);
  } else {
    let unresolvable = [];
    try {
      const built = readFileSync(serverEntry, "utf8");
      unresolvable = [
        ...new Set(
          [...built.matchAll(/^\s*(?:import|export)[^;]*?from\s*["']([^"'.][^"']*)["']/gm)]
            .map((m) => m[1])
            .filter((spec) => !isNodeBuiltin(spec))
            .filter((spec) => !existsSync(join(serverRoot, "node_modules", spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/")))),
        ),
      ];
    } catch {
      /* unreadable build — say nothing rather than guess */
    }
    if (unresolvable.length) {
      say(
        `The skill-forge MCP server cannot start: dist/index.js imports ${unresolvable.join(", ")}, which is not installed, so every forge_* tool is missing this session. ` +
          `This is a stale unbundled build. Offer to run: ${rebuild} — then the session must be restarted.`,
      );
    }
  }

  // 2. Sign-in state, from the cache's metadata only. Tokens are never read into this output.
  if (process.env.PIVOTLY_MCP_TOKEN?.trim()) {
    say("A manual PIVOTLY_MCP_TOKEN override is set in the environment; browser sign-in is bypassed while it is.");
  } else {
    const cache = readJson(TOKEN_CACHE_PATH);
    if (typeof cache.access_token === "string" && typeof cache.expires_at === "number") {
      const who = cache.account?.email || cache.account?.name || "a Pivotly account";
      const secondsLeft = Math.round(cache.expires_at - Date.now() / 1000);
      const expiry = secondsLeft > 0 ? `access token valid for ~${Math.max(1, Math.round(secondsLeft / 60))} min` : "access token expired";
      const refresh = cache.refresh_token ? "refreshes silently" : "no refresh token — forge_auth_login will be needed when it expires";
      say(`Signed in to Pivotly as ${who} (${expiry}; ${refresh}). No sign-in step needed this session.`);
    } else {
      say(
        "Not signed in to Pivotly. The first task that needs the backend should call forge_auth_login, which opens the Microsoft sign-in in the browser once and saves a refresh token — " +
          "no pasted tokens, no environment variables. Reads that only need the repo (codebase-mine) work without it.",
      );
    }
  }

  // 3. What has this developer configured? Settings are collected by prompting.
  const backendPath = value("backend_path", "PIVOTLY_BACKEND_PATH");
  const apiBaseUrl = value("api_base_url", "PIVOTLY_API_BASE_URL");

  if (!apiBaseUrl && !backendPath) {
    say(
      "No backend URL or checkout path stored yet. forge_health finds the backend on the usual local ports by itself; " +
        "the checkout path is prompted for with forge_config_collect when a task first needs the repo. Do not ask for values in conversation, set environment variables, or edit files.",
    );
  } else if (!backendPath) {
    say("Backend URL stored; no backend checkout path yet — forge_config_collect(keys: [\"backend_path\"]) prompts for it when codebase-mine needs it.");
  } else if (!apiBaseUrl) {
    say("Backend checkout path stored; no backend URL yet — forge_health will detect it on the usual local ports and remember it.");
  }

  // 4. Backend repo state, once we know where it is.
  if (!backendPath) process.exit(0);

  if (!existsSync(backendPath)) {
    say(`Stored backend path no longer exists: ${backendPath}. Prompt for the current one with forge_config_collect(keys: ["backend_path"], force: true).`);
    process.exit(0);
  }
  try {
    git(backendPath, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    say(`Stored backend path is not a git repo: ${backendPath}. Verify it with the developer before mining.`);
    process.exit(0);
  }

  const branch = git(backendPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirty = git(backendPath, ["status", "--porcelain"]).split("\n").filter(Boolean).length;
  try {
    // Hard cap: the hook itself is killed at 20s, and a slow-but-alive remote would consume
    // the whole budget and discard everything already printed.
    git(backendPath, ["fetch", "origin", "main", "--quiet"], 5000);
  } catch {
    /* offline is fine */
  }
  let behind = "?";
  try {
    behind = git(backendPath, ["rev-list", "--count", "HEAD..origin/main"]);
  } catch {
    /* no origin/main */
  }

  say(`backend repo: ${backendPath} | branch=${branch} | dirty_files=${dirty} | behind_origin_main=${behind}`);
  if (branch !== "main") {
    say(`Reminder: mining should run on 'main'. Before codebase-mine, ask the developer to switch (or confirm they intentionally want branch '${branch}').`);
  }
  if (behind !== "0" && behind !== "?") {
    say(`Reminder: local branch is ${behind} commit(s) behind origin/main. Ask the developer to 'git pull' before mining so extracted contracts match what is deployed.`);
  }
} catch {
  // A hook must never break a session.
}
process.exit(0);
