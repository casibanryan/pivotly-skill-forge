# pivotly-skill-forge

Generate AI-client skills from Pivotly reference documents, then close the gaps those documents leave using the sources that actually know the answer: the backend codebase, the running API, and the org's Google Drive.

```
/skill-forge  (forge-run)
  preflight ─► reference docs ─► doc-to-skill ─► SKILL.md (with UNKNOWNs) ─► close-gaps (≤2 passes) ─┬─► codebase-mine   (backend checkout)
                                                                                                      ├─► api-verify      (running backend, signed in)
                                                                                                      └─► drive-collect   (Google Drive, "Product development")
                                                                                                                   │
                                                                                                SKILL.md + SOURCES.md (+ references/ if large)
```

## Skills
| Skill | Purpose |
|---|---|
| `forge-run` | **The session.** Preflight → docs → draft → bounded gap loop → write with provenance. `/skill-forge` runs it |
| `doc-to-skill` | Convert reference/tool docs into one portable SKILL.md; marks what the docs don't say |
| `close-gaps` | Classify gaps by source, run the three below, regenerate with provenance |
| `codebase-mine` | Read the backend checkout (routes → Zod → controllers → SQL) after confirming `main` is current |
| `api-verify` | Probe the running backend as the signed-in user; capture real envelopes and error codes |
| `drive-collect` | Find dependent reference docs on Google Drive and stage them |
| `forge-setup` | Sign in, detect the backend URL, store the checkout path — runs itself when something is missing. `/skill-forge-setup` |

## MCP server (`skill-forge`, TypeScript, stdio, zero runtime dependencies)
| Tool | What it does |
|---|---|
| `forge_config_status` | Backend URL, checkout path, OIDC settings in use, who is signed in and until when — never returns token material |
| `forge_auth_login` | **Sign in** — opens the Microsoft Entra ID sign-in in the browser (Authorization Code + PKCE, loopback redirect) and saves access + refresh token |
| `forge_auth_logout` | Discard the saved sign-in |
| `forge_config_collect` | Prompt for the backend URL / checkout path, one input field at a time, in the host UI |
| `forge_config_set` | Store a value already in hand; validates each; `oidc_*` overrides for another tenant or a write scope |
| `forge_config_clear` | Forget one setting or all of them |
| `forge_health` | Reachability with **auto-detection** of the local port, sign-in acceptance via `GET /api/v3/me/`, served OpenAPI discovery |
| `forge_request` | Authenticated request to the backend; relative paths only; token auto-attached, silently refreshed, redacted |
| `forge_openapi` | Served OpenAPI (`/api/documentation/json`, ~435 operations) or the checkout's `openapi.json`, normalized; use `filter` |
| `forge_git_state` | Branch, dirty files, commits behind `origin/main`, last commit — read-only |

## Hook
`SessionStart` runs `hooks/scripts/session-check.mjs`: is the server built, is the developer signed in (account + expiry, from the cache's metadata only), which settings are stored, and the backend repo's branch/status — so Claude reminds you to be on `main` and pulled before mining. Plain Node, no dependencies, no network, never fails a session.

## Setup
1. Install the plugin and start a session. That is the install.
2. Connect **Google Drive** in the host's connectors (only needed for `drive-collect`).

There is nothing to build and nothing to configure by hand. `mcp-server/dist/index.js` is committed as a single dependency-free bundle, so the server starts on any machine with Node 18+ straight from a sync or clone. Everything per-developer is detected, prompted for, or obtained by signing in:

| Item | How | When | Where it lives |
|---|---|---|---|
| **Sign-in** | `forge_auth_login` — a browser window opens on the Microsoft sign-in page; you sign in with your Pivotly work account; done | **Once per machine.** A refresh token is saved, so later sessions are silent | `~/.pivotly-skill-forge/token.json`, mode `600` |
| Backend URL | `forge_health` probes `localhost:3000/8080/8081` and remembers the one that answers | Automatic | `~/.pivotly-skill-forge/config.json`, mode `600` |
| Backend checkout path | `forge_config_collect` — one input field in your editor | Once, when a skill first mines the repo | `config.json` |

Run `/skill-forge-setup` to do it all up front, or just run `/skill-forge` and answer when asked. To change something later, just say so ("switch account", "point it at port 4000", "I moved the checkout").

The sign-in uses Pivotly's existing Entra ID registration — the same public client (`3043e9d3…`), tenant, and `api.read` scope the Portal frontend uses — built in as defaults. It is a public client, so there is no secret anywhere in this repo. `forge_config_set(oidc_scopes: …)` + `forge_auth_login(force: true)` picks up an additional scope (e.g. a write scope) when you have been granted one.

## Prerequisites for a full gap-closing run
- Backend checkout on `main`, pulled (the hook and `forge_git_state` nag otherwise).
- Backend running locally against a **dev** database. `api-verify` may write to it, but confirms every mutating call and tags probe records `skillforge-<date>-…`.
- Your account provisioned in that backend's IAM. `forge_health` tells the two apart: `rejected` (token problem) vs `authenticated_not_provisioned` (open the Portal frontend against this backend once and it provisions you).
- Never point the backend URL at production — a non-local host is refused unless you explicitly confirm it is a dev environment.

## Working on the MCP server
```bash
cd mcp-server && npm install && npm run build   # typecheck with tsc, then bundle with esbuild
npm run dev                                     # rebuild on save
```
**Commit `mcp-server/dist/index.js` with every source change.** The plugin is distributed by syncing this repo and `node_modules/` is gitignored, so a plain `tsc` build — which leaves `import … from "@modelcontextprotocol/sdk/…"` in its output — cannot start on a synced copy. `npm run build` inlines the dependencies and fails if any bare import survives; the hook checks for a *runnable* bundle and says so if a stale one is ever committed.

Source layout: `src/config.ts` (settings, validation, defaults), `src/auth.ts` (OIDC discovery, PKCE, loopback callback, refresh, cache, AADSTS hints), `src/index.ts` (tools).

## Portability
The skills are standard Agent Skills (`SKILL.md`) and work in Claude Code, Cowork, Cursor, Copilot, Codex. The MCP server is standard MCP and can be registered in any MCP-capable client; the browser sign-in works in any host (it needs a browser on the machine, not a host UI feature). The `.claude-plugin/` + `.mcp.json` wrapper is Claude-specific. The one-field prompts (`forge_config_collect`) need a host with MCP form elicitation (Claude Code has it; Cowork does not, and the tool says so and falls back to asking).

## Security notes
- **No pasted tokens.** Credentials come from an interactive OIDC sign-in with PKCE against Pivotly's tenant; the token response goes IdP → this process over TLS and never through the chat. The backend verifies every access token against the tenant's JWKS on each request.
- The token cache (`token.json`) holds the signed-in user's own access + refresh token, mode `600`, in your home directory. It is gitignored here and belongs to nothing in this repo. `forge_auth_logout` deletes it. A pasted token left in `config.json` by a pre-0.2 version is removed automatically on startup.
- Every tool output is passed through a redactor that knows every token the process has seen (access, refresh, id, manual override). `forge_config_status` shows the account email, never a token.
- `forge_request` refuses absolute URLs, so a token can only ever go to the configured backend. A non-local backend URL is refused unless explicitly confirmed as dev.
- The OIDC defaults are non-secret public-client values. The redirect URI must be registered on the app under **Mobile and desktop applications** (`http://localhost:8642/callback`; `53682` is the registered alternate); a Single-Page-Application redirect is refused by Entra for a native client, and the tool explains that if it happens.
- Environment variables (`PIVOTLY_MCP_TOKEN`, `PIVOTLY_API_BASE_URL`, `PIVOTLY_BACKEND_PATH`, `PIVOTLY_OIDC_*`) still work as a fallback for unattended CI, but no developer has to set one.
- `forge_git_state` and the hook never mutate the repo.
