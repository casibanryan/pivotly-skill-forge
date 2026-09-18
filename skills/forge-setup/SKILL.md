---
name: forge-setup
description: >
  This skill should be used when the user asks to "set up skill forge", "configure the plugin", "connect my
  backend", "change the backend URL", "update my dev token", "point this at a different checkout", "why does
  forge_health say not configured", "ask me for the token again", or when any forge_* tool reports a missing
  setting (no token this session, no backend repo path, backend not reachable). It collects the developer's
  backend URL, dev bearer token, and backend checkout path through forge_config_collect, which prompts them
  directly in the host UI one input at a time — no environment variables, no files to edit, and nothing typed
  into the chat.
metadata:
  version: "0.1.0"
---

# Forge Setup

Installing the plugin is the whole install. Every per-developer value is collected by **prompting the developer directly** — `forge_config_collect` opens one input field at a time in the host's own UI. Values take effect immediately, no restart.

**Never ask for a setting in conversation when `forge_config_collect` can prompt for it.** A value typed into a prompt goes straight to the MCP server; a value typed into chat is in the transcript forever. That difference is the whole point, and it matters most for the token.

**Never** tell the developer to set an environment variable, create a `.env`, or edit a config file by hand.

## The three settings

| Setting | Prompted for | Where it lives | Needed by |
|---|---|---|---|
| `api_base_url` | Once — the prompt is pre-filled with `http://localhost:3000`, so accepting it is one keystroke | `~/.pivotly-skill-forge/config.json` (mode 600) | `forge_health`, `forge_request`, `forge_openapi`, api-verify |
| `token` | **Once per session** | The server process's memory only — **never written to disk** | `forge_request`, authenticated probes |
| `backend_path` | Once | `~/.pivotly-skill-forge/config.json` (mode 600) | `forge_git_state`, codebase-mine, the session hook |

The token being session-scoped is deliberate, not a limitation: nothing token-shaped is ever on the filesystem to leak, sync to a backup, or need rotating. Re-prompting each session is the cost, and it is one paste.

## Procedure

### 1. Start from what is already there
Call `forge_config_status` first. Only ask for what is missing or what the developer said they want to change. Never re-ask for a value that is already stored — say what is set (the token shows only as `••••1234`) and move on.

### 2. Prompt only for what the task needs
Call `forge_config_collect` with the `keys` the work actually needs, not all three up front:
- Reading the repo (codebase-mine) → `forge_config_collect(keys: ["backend_path"])`.
- Probing the API (api-verify) → `forge_config_collect(keys: ["api_base_url", "token"])`.
- A full close-gaps run or an explicit "set it all up" → `forge_config_collect()` with no keys.

It prompts one input at a time, in the order given, skipping anything already available. Say in one short line what you are about to ask for, then call it — do not narrate each field as it appears.

To change a value the developer already has, pass `force: true` for that key ("point it at port 4000" → `forge_config_collect(keys: ["api_base_url"], force: true)`).

If it returns `error: "This host does not support input prompts"`, that host has no elicitation support. Only then fall back to asking in conversation, one at a time, and storing each with `forge_config_set` — and say once, plainly, that a token typed into chat stays in the transcript.

### 3. Validation happens as each answer arrives
`forge_config_collect` validates every value and re-prompts once with the error shown. `forge_config_set` applies the same rules when you use it directly:
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
The token is entered into a prompt, not into the chat, so it never has to reach the transcript or your context. Keep it that way:
- Never echo the token, quote it back, or write it into a file, skill, or commit.
- Refer to it as "your dev token" or by its `••••1234` hint.
- The MCP server redacts it from every tool output automatically.
- Never ask the developer to paste it into the conversation while `forge_config_collect` is available. If one has already been given in chat, store it with `forge_config_set` and do not repeat it back.
- The prompt field is **not masked** — MCP form elicitation has no password type. Never suggest putting a production credential in it.

If the token is rejected (`forge_health` shows `accepted: false`), say it was rejected, never quote it, and call `forge_config_collect(keys: ["token"], force: true)` for a current one.

At the start of each session the token is simply absent. That is expected — not an error, and not something the developer misconfigured. Prompt for it when the first task needs it.

## Changing and clearing
- Rotated token, moved checkout, different port → `forge_config_collect(keys: [...], force: true)`.
- Leaving the machine, or wiping a bad value → `forge_config_clear`. Confirm before clearing everything; clearing the token alone needs no ceremony and only drops it from memory.
- The config is per developer and global to their machine, not per project. Changing it affects every project where they use this plugin — mention that when they switch a value.

## Pitfalls
- The settings are read fresh on every call. If a tool still reports a value missing right after a successful `forge_config_set`, the write itself failed — check the `saved_to` path in the response instead of suggesting a restart.
- A restart of the MCP server (new session, or the host reconnecting it) clears the token by design. Prompt again; do not treat it as a bug or go looking for it in the config file.
- Environment variables of the same name still work as a fallback for CI. If `forge_config_status` reports `source: "env"`, a stored value would override it — worth saying only if the developer is confused about which value is in play.
- If the `forge_*` tools do not exist at all, the MCP server is not built. Offer `cd mcp-server && npm install && npm run build`, then a session restart. No amount of configuring fixes that one.
