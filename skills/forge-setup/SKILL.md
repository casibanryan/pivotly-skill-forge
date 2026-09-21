---
name: forge-setup
description: >
  This skill should be used when the user asks to "set up skill forge", "configure the plugin", "sign in to
  Pivotly", "log in", "connect my backend", "change the backend URL", "point this at a different checkout",
  "switch accounts", "add the write scope", "why does forge_health say not signed in", or when any forge_* tool
  reports a missing setting (not signed in, no backend repo path, backend not reachable). Sign-in is a one-time
  browser round-trip (forge_auth_login, Microsoft Entra ID); the backend URL is auto-detected; the checkout path
  is prompted for in the host UI (forge_config_collect). No environment variables, no files to edit, and no
  tokens typed into the chat.
metadata:
  version: "0.3.0"
---

# Forge Setup

Installing the plugin is the whole install. Everything per-developer is either detected, prompted for in the host's own UI, or obtained by signing in — never typed into the chat, never put in an environment variable, never edited into a file.

## What there is to set up

| Item | How it is obtained | When | Where it lives |
|---|---|---|---|
| **Sign-in** (credentials) | `forge_auth_login` opens the Microsoft sign-in page in the browser; the redirect lands on a loopback port and the plugin saves an access **and refresh** token | **Once per machine.** Later sessions refresh silently; a browser is needed again only if the refresh token is revoked or ~90 days idle | `~/.pivotly-skill-forge/token.json`, mode 600 |
| `api_base_url` | `forge_health` probes the usual local ports (3000, 8080, 8081); when exactly one answers and nothing was stored, it is remembered | Automatic; prompt only if detection finds nothing or several | `~/.pivotly-skill-forge/config.json`, mode 600 |
| `backend_path` | `forge_config_collect(keys: ["backend_path"])` — one input field in the host UI | Once, the first time codebase-mine needs the repo | `config.json` |
| `oidc_*` (issuer, client id, scopes, redirect) | Built-in Pivotly defaults; override with `forge_config_set` only for another tenant or to add a write scope | Rarely | `config.json` when overridden |

The OIDC defaults are Pivotly's public client registration — the same values the Portal frontend ships to every browser — so there is nothing secret to distribute and nothing for a developer to look up.

## Procedure

### 1. Start from what is already there
Call `forge_config_status`. It reports `auth.signed_in` (with account and expiry), the backend URL and where it came from, the checkout path, and a `missing` list. Never ask for anything that is already there.

### 2. Sign in — only when a task needs the API
Reading the repo (codebase-mine) needs no sign-in. Probing the API (api-verify, `forge_request`) does.

- If `auth.signed_in` is false: say in one line that a browser window will open for the Microsoft sign-in, then call `forge_auth_login`. Expect the developer to switch to the browser; the call waits up to two minutes.
- If it returns `status: "waiting_for_sign_in"`, tell the developer to finish in the browser (give them `auth_url` if `browser_opened` is false), then call `forge_auth_login` again to pick up the result.
- If it returns `hint`, relay the hint as-is — it names the fix (unregistered redirect URI, consent, wrong tenant account) — and offer to try again.
- Then call `forge_health`. `auth.probe.outcome`:
  - `accepted` → done; the report shows who the backend thinks the user is.
  - `authenticated_not_provisioned` → the sign-in is fine but this account has no IAM user in this backend's database. Fix: open the Portal frontend against this backend once while signed in as this account (that provisions the user), then re-run `forge_health`. **Do not** re-trigger sign-in — it will not help.
  - `rejected` → `forge_auth_login(force: true)`; if still rejected, the backend validates a different tenant/audience than the plugin signs in to — compare the backend's `OIDC_ISSUER_URL`/`OIDC_AUDIENCE` with `forge_config_status → oidc`.

Switching accounts, or picking up a newly added scope: `forge_auth_login(force: true)`. Signing out: `forge_auth_logout`.

### 3. Backend URL — let detection do it
Call `forge_health`. With nothing stored, it probes the usual local ports and remembers the single one that answers (`auto_configured` in the report). Prompt only when it says so:
- Several answered → ask which is the core backend, then `forge_config_set(api_base_url: …)`.
- None answered → the usual cause is the backend not running; ask before assuming the URL is wrong. Another port → `forge_config_collect(keys: ["api_base_url"], force: true)`; the prompt is pre-filled with whatever answers.

A non-local URL is **refused** unless the user explicitly confirms it is a dev environment; only then re-run with `allow_remote: true`. Never pass it on your own initiative.

### 4. Checkout path — prompt when the repo is first needed
`forge_config_collect(keys: ["backend_path"])`. It must exist and be a git checkout; `~`, quoted paths, and Git Bash / WSL spellings are normalized. Then `forge_git_state` and relay its reminders (branch, behind origin, dirty files).

If `forge_config_collect` reports that the host has no form prompts, only then ask for the path in conversation and store it with `forge_config_set(backend_path)`.

### 5. Confirm
Close with one line: who is signed in, which backend URL, which checkout, and which skill each unlocks. If something is still missing, name the skill that stays unavailable until it is set.

## Hard rules
- **Never ask the developer to paste a token.** `forge_config_set(token)` and the `token` prompt key exist only as a fallback for a machine with no browser at all; say so if you ever use them, and note that such a value lives in memory for this session only.
- Never echo, quote, log, or write down a token. The MCP server redacts every token from every output; refer to the sign-in by the account email `forge_config_status` shows.
- Never tell the developer to set an environment variable, create a `.env`, or edit `config.json` or `token.json` by hand.
- Sign-in is per machine and global to the developer, not per project. Mention that when they switch accounts.

## Pitfalls
- Settings are read fresh on every call. If a tool still reports something missing right after a successful set, the write failed — check `saved_to` rather than suggesting a restart.
- A stale `token.json` from a different issuer/client is ignored, not used. `forge_config_status → auth.note` says so; `forge_auth_login` replaces it.
- Adding a write scope to `oidc_scopes` changes nothing until `forge_auth_login(force: true)` issues a token that carries it. The backend still enforces the user's own role — the scope opens the door, the role decides.
- If the `forge_*` tools do not exist at all, the MCP server is not built. Offer `cd mcp-server && npm install && npm run build`, then a session restart. No amount of configuring fixes that one.
