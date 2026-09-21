---
name: forge-run
description: >
  This skill should be used when the user wants a complete skill-forge run end to end: "forge a skill from these
  docs", "start a skill-forge session", "build a skill for the core-data API from the reference docs", "turn
  these PDFs into a skill and fill the gaps", "run skill forge on this folder", "/skill-forge", or hands over
  reference documents and wants a finished SKILL.md with the unknowns closed. It is the top-level orchestrator:
  preflight, draft with doc-to-skill, a bounded gap-closing loop over the backend repo, the running API, and
  Google Drive, then write the skill with provenance.
metadata:
  version: "0.3.0"
---

# Forge Run — the skill-forge session

One session, one skill. Ask for as little as possible up front and collect the rest only when a stage needs it; every stage names what it needs, so nothing is asked twice and nothing is asked that the run never uses.

```
preflight ─► inputs (docs) ─► draft (doc-to-skill) ─► gap loop ≤2 passes ─► write + provenance ─► report
                                                       │ repo   → codebase-mine  (needs backend_path)
                                                       │ live   → api-verify     (needs backend up + sign-in)
                                                       └ docs   → drive-collect / more uploads
```

## Stage 0 — Preflight (no questions yet)
1. `forge_config_status`. Note `auth.signed_in`, the backend URL, the checkout path. Do **not** collect anything missing yet.
2. If a checkout path is stored, `forge_git_state`. Relay reminders (not on `main`, behind `origin/main`, dirty) as a single line; mining waits for the developer to pull. Only the **backend** repo is mined, so only its state matters — do not ask about other repos.
3. If the SessionStart hook already printed sign-in and repo state, use that and skip the calls.

## Stage 1 — Inputs: reference documents only
The one thing a run genuinely needs up front is the documentation. Accept any of:
- files uploaded into the conversation;
- a **local folder or file path** — read the files directly; on later runs the same path is re-read, so nothing has to be re-uploaded;
- a **Google Drive folder or document names** — via `drive-collect`.

Ask one question if the target is unclear: which system/API the skill is for and where the docs are. Do not ask for the backend URL or a sign-in here.

## Stage 2 — Draft
Run **doc-to-skill** on the inputs. It produces one SKILL.md with `UNKNOWN — not in docs` markers and a **Not covered by source docs** section, plus the list of documents the sources reference but did not supply. Present the gap list as a numbered table before going further.

## Stage 3 — Gap loop (bounded)
Ask once: *close the gaps now, or deliver as-is with the unknowns marked?* If yes, run **close-gaps**, which classifies each gap by best source and dispatches:

| Source | Skill | Collect on demand |
|---|---|---|
| Backend code | `codebase-mine` | `forge_config_collect(keys: ["backend_path"])` if no checkout stored; `forge_git_state` must be `ready` or the developer confirms the branch |
| Running API | `api-verify` | `forge_health`; if `auth.signed_in` is false → `forge_auth_login` (say a browser window opens; it is a one-time sign-in); if the backend is down, defer these gaps |
| Missing documents | `drive-collect` (default folder: the org's **Product development** folder), or ask the developer to upload/point to them | Google Drive connector |

Exit the loop when **any** of these holds:
- no gaps remain;
- the developer says stop or skip;
- **two passes** have run (a pass = classify → dispatch → regenerate). More passes rarely close anything the first two did not — the remaining gaps need a person;
- a pass closed nothing new (no source had the answer).

Every filled gap must carry evidence (path:line, request→response, Drive title+date). Never fill from general knowledge.

## Stage 4 — Write
Ask once for the output location if it is not obvious. Defaults:
- inside a repo that already has a `skills/` directory (a plugin or skills repo) → `skills/<skill-name>/`;
- otherwise → `./<skill-name>/` in the current project.

Write:
- `SKILL.md` — the skill itself (doc-to-skill rules; one file unless the body exceeds ~500 lines);
- `references/` — **only** distilled material the SKILL.md explicitly points to (large tables, per-tool detail split out for size). Never copy the raw PDFs/DOCX into the skill folder: they bloat the skill, cannot be loaded usefully by the model, and may carry customer data;
- `SOURCES.md` — provenance: each source document (title, version/date, where it came from: upload / local path / Drive link, sha256 for local files), the backend commit and branch from `forge_git_state`, the backend URL and API version from `forge_health`, and the run date. This is what makes the skill regenerable later.

Never write tokens, hostnames of non-local environments, or real customer data into any of these files.

## Stage 5 — Report
In the reply: what the skill covers, the gap table (id · answer · source · confidence), what is still unknown and what would close it (named document, a person, an endpoint that does not exist yet), and the output paths. Offer to regenerate when more documents arrive.

## Rules
- Lazy collection: a run that is entirely Drive-sourced never needs a sign-in or a checkout — do not ask for them.
- Code beats docs; the running API beats code. Disagreements are reported to the user as bugs, not silently resolved.
- Every mutating call in api-verify is confirmed individually with method, endpoint, payload and plain-language effect; probe records are tagged `skillforge-<date>-…` and offered for cleanup.
- Never probe a non-local backend without the developer's explicit confirmation that it is a dev environment.
