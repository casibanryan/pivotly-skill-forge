/**
 * SessionStart hook for pivotly-skill-forge.
 *
 * Prints, into session context: whether the MCP server is built, which settings the
 * developer has stored, and — once a backend checkout is known — its git state, so Claude
 * reminds the developer to be on main and pulled before mining.
 *
 * Plain Node with no dependencies and no bash, so it runs identically on Windows and
 * POSIX and works before `npm install`. That is also why config resolution is duplicated
 * from mcp-server/src/config.ts in miniature: this must run before anything is built.
 *
 * Never fails the session — every failure path still exits 0.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const say = (line) => console.log(`[skill-forge] ${line}`);

const CONFIG_PATH =
  process.env.PIVOTLY_SKILL_FORGE_CONFIG?.trim() ||
  join(homedir(), ".pivotly-skill-forge", "config.json");

function stored() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function value(key, envName) {
  const fromFile = stored()[key];
  if (typeof fromFile === "string" && fromFile.trim()) return fromFile.trim();
  const fromEnv = process.env[envName]?.trim();
  return fromEnv || "";
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    timeout: 20000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

try {
  const pluginRoot =
    process.env.CLAUDE_PLUGIN_ROOT?.trim() ||
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

  // 1. Can the MCP server actually start? Without it, none of the forge_* tools exist.
  //
  // "The file exists" is not the same question. dist/index.js is committed as a dependency-free
  // esbuild bundle precisely because node_modules/ is gitignored: a plain `tsc` build leaves bare
  // imports like "@modelcontextprotocol/sdk/..." in the output, which a freshly synced plugin
  // cannot resolve, so Node exits with ERR_MODULE_NOT_FOUND before the transport ever opens. The
  // host then reports only that the connection closed. So check for a *runnable* bundle, not a
  // present file — an existsSync check passes in exactly the case that used to fail silently.
  const serverRoot = join(pluginRoot, "mcp-server");
  const serverEntry = join(serverRoot, "dist", "index.js");
  const rebuild = `cd "${serverRoot}" && npm install && npm run build`;

  if (!existsSync(serverEntry)) {
    say(
      "The skill-forge MCP server is not built, so the forge_* tools are unavailable. " +
        `Offer to run: ${rebuild} — then the session must be restarted to pick up the tools.`,
    );
  } else {
    let unresolvable = [];
    try {
      const built = readFileSync(serverEntry, "utf8");
      unresolvable = [
        ...new Set(
          [...built.matchAll(/^\s*(?:import|export)[^;]*?from\s*["']([^"'.][^"']*)["']/gm)]
            .map((m) => m[1])
            .filter((spec) => !spec.startsWith("node:"))
            .filter((spec) => !existsSync(join(serverRoot, "node_modules", spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/")))),
        ),
      ];
    } catch {
      /* unreadable build — say nothing rather than guess */
    }
    if (unresolvable.length) {
      say(
        `The skill-forge MCP server cannot start: dist/index.js imports ${unresolvable.join(", ")}, ` +
          "which is not installed, so every forge_* tool is missing this session (the host reports only " +
          `that the connection closed). This is a stale unbundled build. Offer to run: ${rebuild} — ` +
          "npm run build bundles the dependencies in. Then the session must be restarted.",
      );
    }
  }

  // 2. What has this developer configured? Settings are collected in conversation.
  const backendPath = value("backend_path", "PIVOTLY_BACKEND_PATH");
  const token = value("token", "PIVOTLY_MCP_TOKEN");
  const apiBaseUrl = value("api_base_url", "PIVOTLY_API_BASE_URL");

  // The token is deliberately not in this list. It is never written to disk — it is prompted
  // for once per session and held in the MCP server's memory — so its absence here is the
  // normal state at the start of every session, not a configuration problem to report.
  const missing = [];
  if (!apiBaseUrl) missing.push("backend URL");
  if (!backendPath) missing.push("backend repo path");

  say(
    "The dev token is session-scoped and never stored: prompt for it with forge_config_collect(keys: [\"token\"]) " +
      "when a task first needs an authenticated call. Do not ask the developer to paste it into the chat.",
  );

  if (missing.length === 2) {
    say(
      "Not configured yet. On the first request that needs the backend, run the forge-setup skill " +
        "(or /skill-forge-setup), which calls forge_config_collect to prompt the developer for each setting " +
        "one at a time. Do not ask for values in conversation, set environment variables, or edit files.",
    );
  } else if (missing.length) {
    say(
      `Partially configured — still missing: ${missing.join(", ")}. ` +
        "Prompt for what a task needs with forge_config_collect when it needs it; /skill-forge-setup covers all of them.",
    );
  }

  // 3. Backend repo state, once we know where it is.
  if (!backendPath) process.exit(0);

  if (!existsSync(backendPath)) {
    say(`Stored backend path no longer exists: ${backendPath}. Ask for the current path and re-store it with forge_config_set(backend_path).`);
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
    git(backendPath, ["fetch", "origin", "main", "--quiet"]);
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
