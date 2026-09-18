# pivotly-skill-forge

Generate AI-client skills from Pivotly reference documents, then close the gaps those documents leave using the sources that actually know the answer: the backend codebase, the running API, and the org's Google Drive.

```
docs ──► doc-to-skill ──► SKILL.md (with UNKNOWNs) ──► close-gaps ──┬─► codebase-mine   (repo)
                                                                    ├─► api-verify      (running backend, MCP tools)
                                                                    └─► drive-collect   (Google Drive connector)
                                                                                 │
                                                                 regenerated SKILL.md + provenance
```

## Skills
| Skill | Purpose |
|---|---|
| `doc-to-skill` | Convert reference/tool docs into one portable SKILL.md; marks what the docs don't say |
| `close-gaps` | Orchestrator: classify gaps by source, run the three below, regenerate with provenance |
| `codebase-mine` | Read the backend checkout (routes → Zod → controllers → SQL) after confirming `main` is current |
| `api-verify` | Probe the running backend with the MCP tools; capture real envelopes and error codes |
| `drive-collect` | Find dependent reference docs on Google Drive and stage them |
| `forge-setup` | Collect your backend URL, dev token, and checkout path by asking — runs itself when something is missing |

## MCP server (`skill-forge`, TypeScript, stdio)
| Tool | What it does |
|---|---|
| `forge_config_status` | What you have configured, where each value came from, what is missing — never returns the token |
| `forge_config_set` | Store backend URL / dev token / checkout path; validates each before writing |
| `forge_config_clear` | Forget one setting or all of them |
| `forge_health` | Reachability, health endpoint, token acceptance, served OpenAPI discovery |
| `forge_request` | Authenticated request to the backend; relative paths only; token auto-attached and redacted |
| `forge_openapi` | Fetch + normalize served OpenAPI/Swagger into a path/method inventory |
| `forge_git_state` | Branch, dirty files, commits behind `origin/main`, last commit — read-only |

## Hook
`SessionStart` runs `hooks/scripts/session-check.mjs`, which reports whether the server is built, which settings you have stored, and your backend repo's branch/status — so Claude reminds you to be on `main` and pulled before mining. Plain Node, no dependencies, never fails a session.

## Setup
1. Install the plugin and start a session.
2. Connect **Google Drive** in the host's connectors (only needed for `drive-collect`).

There is nothing to build. `mcp-server/dist/index.js` is committed as a single dependency-free bundle, so the
server starts on any machine with Node 18+ straight from a sync or clone — no `npm install`, nothing to put in
your environment, and no file to edit. The first time a skill needs your backend, Claude asks for what it needs and stores it:

> **Claude:** What URL is your Pivotly backend running on? (default `http://localhost:3000`)

Run `/skill-forge-setup` to do all of it up front, or just start working and answer when asked. Values land in `~/.pivotly-skill-forge/config.json` (mode `600`, outside the repo) and take effect immediately — no restart.

| Setting | Asked for when | Example |
|---|---|---|
| Backend URL | Probing the API | `http://localhost:3000` |
| Dev bearer token | Authenticated requests | `eyJ…` |
| Backend checkout path | Mining the repo | `/Users/me/src/pivotly-core` |

To change one later, just say so ("point it at port 4000", "I rotated my token"). `PIVOTLY_API_BASE_URL`, `PIVOTLY_MCP_TOKEN`, and `PIVOTLY_BACKEND_PATH` still work as a fallback for CI, but a stored value wins.

## Prerequisites for a full gap-closing run
- Backend checkout on `main`, pulled (the hook and `forge_git_state` will nag otherwise).
- Backend running locally against a **dev** database. `api-verify` may write to it, but confirms every mutating call and tags probe records `skillforge-<date>-…`.
- Never point the backend URL at production — `forge_config_set` refuses any non-local host unless you explicitly confirm it is a dev environment.

## Working on the MCP server
```bash
cd mcp-server && npm install && npm run build   # typecheck with tsc, then bundle with esbuild
npm run dev                                     # rebuild on save
```
**Commit `mcp-server/dist/index.js` with every source change.** The plugin is distributed by syncing this repo
and `node_modules/` is gitignored, so a plain `tsc` build — which leaves `import … from "@modelcontextprotocol/sdk/…"`
in its output — cannot start on a synced copy: Node exits with `ERR_MODULE_NOT_FOUND` before the transport opens,
the host reports only that the connection closed, and every `forge_*` tool silently disappears. `npm run build`
inlines the dependencies and fails the build if any bare import survives. The `SessionStart` hook checks for a
*runnable* bundle rather than a present file, so if a stale unbundled build is ever committed it says so in the
first message of the session instead of leaving you to guess.

## Portability
The skills are standard Agent Skills (`SKILL.md`) and work in Claude Code, Cowork, Cursor, Copilot, Codex. The MCP server is standard MCP and can be registered in any MCP-capable client. The `.claude-plugin/` + `.mcp.json` wrapper is Claude-specific.

## Security notes
- Settings are per developer, stored in your home directory at mode `600`. Nothing secret is ever written into this repo — clone it, and you share no credentials.
- The token is read only by the MCP server process and redacted from every tool output. No tool returns it; `forge_config_status` shows it as `••••1234`.
- `forge_request` refuses absolute URLs, so the token can only ever go to the configured backend.
- `forge_config_set` refuses a non-local backend URL unless you confirm it is a dev environment, so a stray paste cannot point the probes at production.
- `forge_git_state` and the hook never mutate the repo.
- The token is dev-only and you paste it into the conversation, so it lands in that transcript. That is the accepted trade-off for a developer tool. If you would rather it did not, write `{"token": "…"}` into `~/.pivotly-skill-forge/config.json` yourself — everything else still works by asking.
