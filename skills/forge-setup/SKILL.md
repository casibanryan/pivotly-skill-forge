---
name: forge-setup
description: >
  This skill should be used when the user asks to "set up skill forge", "configure the plugin", "connect my
  backend", "change the backend URL", "update my dev token", "point this at a different checkout", "why does
  forge_health say not configured", or when any forge_* tool reports a missing setting (no token stored, no
  backend repo path, backend not reachable). It collects the developer's backend URL, dev bearer token, and
  backend checkout path in conversation and stores them with forge_config_set — no environment variables, no
  files to edit.
metadata:
  version: "0.1.0"
---

# Forge Setup

Installing the plugin is the whole install. Every per-developer value is collected here, by asking, and stored in the developer's own config file (`~/.pivotly-skill-forge/config.json`, mode 600). Values take effect immediately — no restart.

**Never** tell the developer to set an environment variable, create a `.env`, or edit a config file by hand. If that is the answer you are about to give, use `forge_config_set` instead.

## The three settings

| Setting | What to ask for | Needed by |
|---|---|---|
| `api_base_url` | The URL their local backend runs on. Offer `http://localhost:3000` as the default — accepting it is one keystroke. | `forge_health`, `forge_request`, `forge_openapi`, api-verify |
| `token` | Their **dev** bearer token for that backend. | `forge_request`, authenticated probes |
| `backend_path` | Absolute path to their Pivotly backend git checkout. | `forge_git_state`, codebase-mine, the session hook |

## Procedure

### 1. Start from what is already there
Call `forge_config_status` first. Only ask for what is missing or what the developer said they want to change. Never re-ask for a value that is already stored — say what is set (the token shows only as `••••1234`) and move on.

### 2. Ask only for what the task needs
Collect settings when the work needs them, not all three up front:
- Reading the repo (codebase-mine) → `backend_path` alone.
- Probing the API (api-verify) → `api_base_url` + `token`.
- A full close-gaps run or an explicit "set it all up" → all three.

Ask one at a time, in plain language, with the default or an example visible. Use the host's question UI if it offers one; otherwise ask in the message and wait.

### 3. Store each answer as it arrives
Call `forge_config_set` with the value. It validates before writing and reports what it applied and what it rejected:
- A non-local `api_base_url` is **refused**. Relay the refusal, ask whether it is genuinely a dev environment, and only retry with `allow_remote: true` after the developer says yes. Never pass `allow_remote` on your own initiative.
- `backend_path` must exist and be a git checkout. `~`, quoted paths, and Git Bash / WSL spellings (`/c/…`, `/mnt/c/…`) are normalized for them.
- A placeholder-looking token is refused. Ask for the real one.

Relay a rejection as the plain sentence it is, then ask again. Do not work around a refusal.

### 4. Confirm it actually works
After storing, verify rather than assert:
- Token or URL set → call `forge_health`. Report `reachable`, whether the token was accepted, and whether a spec is served. If it is unreachable, the usual cause is the backend not running — ask before assuming the URL is wrong.
- `backend_path` set → call `forge_git_state`. Relay any reminders (wrong branch, behind `origin/main`, dirty files).

Close with one line of what is now configured and what it unlocks. If something is still missing, say which skill stays unavailable until it is set.

## Handling the token
The developer pastes the token into the conversation, so it lands in the transcript. That is the accepted trade-off for a dev-only tool — do not lecture about it, but do keep your side clean:
- Never echo the token, quote it back, or write it into a file, skill, or commit.
- Refer to it as "your dev token" or by its `••••1234` hint.
- After storing it, the MCP server redacts it from every tool output automatically.
- If a developer would rather not paste it, they can write `{"token": "…"}` into the config file themselves — offer this only if they raise the concern.

If a stored token is rejected (`forge_health` shows `accepted: false`), say it was rejected, never quote it, and ask for a current one.

## Changing and clearing
- Rotated token, moved checkout, different port → `forge_config_set` with just that key.
- Leaving the machine, or wiping a bad value → `forge_config_clear`. Confirm before clearing everything; clearing the token alone needs no ceremony.
- The config is per developer and global to their machine, not per project. Changing it affects every project where they use this plugin — mention that when they switch a value.

## Pitfalls
- The settings are read fresh on every call. If a tool still reports a value missing right after a successful `forge_config_set`, the write itself failed — check the `saved_to` path in the response instead of suggesting a restart.
- Environment variables of the same name still work as a fallback for CI. If `forge_config_status` reports `source: "env"`, a stored value would override it — worth saying only if the developer is confused about which value is in play.
- If the `forge_*` tools do not exist at all, the MCP server is not built. Offer `cd mcp-server && npm install && npm run build`, then a session restart. No amount of configuring fixes that one.
