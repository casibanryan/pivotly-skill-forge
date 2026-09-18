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

  // 1. Is the MCP server built? Without this, none of the forge_* tools exist.
  if (!existsSync(join(pluginRoot, "mcp-server", "dist", "index.js"))) {
    say(
      "The skill-forge MCP server is not built yet, so the forge_* tools are unavailable. " +
        "Offer to run: cd " +
        join(pluginRoot, "mcp-server") +
        " && npm install && npm run build — then the session must be restarted to pick up the tools.",
    );
  }

  // 2. What has this developer configured? Settings are collected in conversation.
  const backendPath = value("backend_path", "PIVOTLY_BACKEND_PATH");
  const token = value("token", "PIVOTLY_MCP_TOKEN");
  const apiBaseUrl = value("api_base_url", "PIVOTLY_API_BASE_URL");

  const missing = [];
  if (!apiBaseUrl) missing.push("backend URL");
  if (!token) missing.push("dev token");
  if (!backendPath) missing.push("backend repo path");

  if (missing.length === 3) {
    say(
      "Not configured yet. On the first request that needs the backend, run the forge-setup skill " +
        "(or /skill-forge-setup) to collect the settings in conversation and store them with forge_config_set. " +
        "Do not ask the developer to set environment variables or edit files.",
    );
  } else if (missing.length) {
    say(
      `Partially configured — still missing: ${missing.join(", ")}. ` +
        "Collect what a task needs with forge_config_set when it needs it; /skill-forge-setup covers all of them.",
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
