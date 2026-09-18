---
name: codebase-mine
description: >
  This skill should be used when the user asks to "check the backend code", "find this in the codebase",
  "what does the route actually accept", "look at the Zod schema", "mine the repo for the API contract",
  "verify against the source", or when close-gaps assigns gaps to the backend codebase. It reads the developer's
  local Pivotly core backend checkout to extract routes, validators, DB contracts, error handling, enums, and
  limits — after confirming the repo is on main and up to date.
metadata:
  version: "0.1.0"
---

# Codebase Mine

Read the backend to answer contract questions the docs left open. Read-only: never run the app, never modify files, never check out branches — ask the user to do git operations.

## Preflight (always)
1. Call `forge_git_state`. If `ready` is false, relay each reminder to the user and wait: switch to `main`, `git pull`, or explicitly confirm mining the current branch. Record `branch` and `last_commit` for provenance.
2. If it reports that no backend repo path is stored, ask the user for the absolute path to their checkout and store it with `forge_config_set(backend_path)` — see the **forge-setup** skill. Never ask them to set an environment variable. Then re-run `forge_git_state`.

## Where to look — layer map
Search in this order; each layer answers different questions. Use grep/glob on the checkout; do not read whole directories.

| Question | Layer | Typical files / patterns |
|---|---|---|
| Exact route path, method, middleware, route-level authorization | Router | `*route*.ts`, `*router*.ts`, `routes/**`, `app.use(`, `router.post(`, `checkAuthorization(` |
| Which params REST accepts, which are stripped, required vs optional, defaults, enums | REST validator | `*.schema.ts`, `zod`, `z.object(`, `.strict()`, `.passthrough()`, `.default(` |
| What the DB function accepts (superset), `additionalProperties`, required combos | DB contract seed | `cfg_schemas*`, `*.seed.*`, JSON-schema files, `additionalProperties` |
| Enum values that exist at DB level (incl. rejected/internal ones) | Migrations / SQL | `migrations/**`, `CREATE TYPE`, `ENUM (`, `fnc_*`, `RAISE EXCEPTION` |
| Error envelope shape, status-code mapping, error messages | Service / controller / error middleware | `errorHandler`, `HttpError`, `res.status(`, `throw new`, `message:` |
| Limits: bundle size, max page size, upload size, hard caps | Config + validator + SQL guards | `MAX_`, `limit`, `hard_cap`, `.max(`, `array_length`, multer `limits` |
| Auth: how user_id is injected, claims required | Middleware | `auth*`, `jwt`, `req.user`, `claims`, `domain.delete` |
| Response `meta`/`pagination` fields actually set | Response builder | `meta:`, `pagination:`, `has_more`, `total_records` |

## Method
- Start from the **route file** for the endpoint in question; follow imports to validator → controller → service → SQL. Stop when the gap is answered.
- Compare the REST validator against the DB contract explicitly when a gap concerns "why doesn't parameter X work" — drift between them is the usual cause.
- For error codes, list every `throw`/`res.status` on the code path and the condition that triggers it.
- For enums, prefer the migration `CREATE TYPE` (source of truth) and note which values the REST layer additionally rejects.

## Evidence format
Each answer records `path:line-range` and a ≤3-line excerpt (paraphrase long blocks). Mark confidence `confirmed` when the line directly states it, `inferred` when derived. Never paste secrets, real connection strings, or customer fixtures.

## Output
A gap→answer table with evidence and confidence, plus a **Drift found** list (REST vs DB, code vs docs) for the user to file as bugs or doc fixes. Hand back to `close-gaps` if running under it; otherwise present directly.

## Pitfalls
- A branch other than `main` may contain unmerged contracts. Mine only after the user confirms, and label provenance with the branch.
- Generated files (`dist/`, `*.d.ts`, `node_modules/`) are not sources. Skip them.
- A validator using plain `z.object` strips unknown keys silently; one using `.strict()` errors. This single detail decides whether an "ignored parameter" is a bug or expected — always check which.
