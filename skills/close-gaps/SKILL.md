---
name: close-gaps
description: >
  This skill should be used when the user asks to "close the gaps" in a generated skill, "fill in the unknowns",
  "verify this skill against the backend", "complete the skill using the codebase", "resolve the not-covered section",
  or hands over a SKILL.md that contains UNKNOWN markers or a "Not covered by source docs" section and wants it made
  accurate. It is the orchestrator: it classifies each gap by source (backend code, running API, Google Drive docs),
  runs codebase-mine, api-verify, and drive-collect as needed, then regenerates the skill with provenance.
metadata:
  version: "0.1.0"
---

# Close Gaps

Turn a skill that is honest about what it does not know into one that knows. Never guess: every filled gap must cite where the answer came from (file path + line, request + response, or Drive document).

## Inputs
- A SKILL.md produced by `doc-to-skill` (or any skill) containing `UNKNOWN — not in docs` markers and/or a **Not covered by source docs** section.
- Access to some or all of: the backend checkout, the running backend, the Google Drive connector.
- Call `forge_config_status` before dispatching. It reports which of those are reachable; anything missing is collected by asking the user (the **forge-setup** skill), never by telling them to set an environment variable. Collect only what the classified gaps actually need — a run that is entirely Drive-sourced needs none of it.

## Procedure

### 1. Extract the gap list
Parse the skill for every `UNKNOWN` marker and every bullet in "Not covered by source docs". Give each gap an id (`G1`, `G2`…) and quote it. Present the list to the user before doing anything else.

### 2. Classify each gap by best source
| Gap type | First source | Fallback |
|---|---|---|
| Error codes / messages, status codes | `api-verify` (provoke the error, capture it) | `codebase-mine` (route + service error handling) |
| Request/response shape, envelope fields | `api-verify` (real call) | `codebase-mine` (Zod schema, controller) |
| Enum values, defaults, limits (max size, caps) | `codebase-mine` (schema, config, migration) | `api-verify` (probe boundary) |
| Unreachable/undocumented params (REST vs DB drift) | `codebase-mine` (validator vs SQL contract) | — |
| Exact route paths | `forge_openapi` then `codebase-mine` (router files) | — |
| Dependent reference documents named but not supplied | `drive-collect` | ask the user |
| Business rules, policies, domain attribute definitions | `drive-collect` | `codebase-mine` (seed/config data) |
| How the client obtains credentials | ask the user | `codebase-mine` (auth middleware) |

Show the classification table. Let the user drop or reassign gaps.

### 3. Preflight
- Call `forge_git_state`. If not on `main` or behind origin, stop and ask the user to switch/pull (or explicitly confirm mining a non-main branch). Record branch + commit for provenance.
- Call `forge_health`. If the backend is down, run only `codebase-mine` and `drive-collect` gaps now; list `api-verify` gaps as deferred.

### 4. Run source skills, one gap batch at a time
- Follow `codebase-mine` for code gaps, `api-verify` for live gaps, `drive-collect` for document gaps. Batch gaps by source so each skill runs once.
- For each gap record: **answer**, **evidence** (path:line / request→response / doc name+section), **confidence** (`confirmed` = seen directly; `inferred` = derived from adjacent code; `still-unknown`).
- Any write to the dev database goes through the mutation confirmation policy of the skill being verified: show method, endpoint, payload; wait for approval; one approval per call.

### 5. Regenerate
- Edit the SKILL.md in place. Replace each `UNKNOWN` with the answer. Move resolved bullets out of "Not covered". Keep unresolved ones there, now annotated with what was tried.
- Add a **Provenance** section at the end: backend commit, backend URL/version from `forge_health`, Drive docs used, date.
- Do not rewrite content that was already correct; diff-minimal edits keep the user's review small.
- If new source material changes existing claims (not just fills gaps), list those changes separately for the user — they are corrections, not fills.

### 6. Report
Table: gap id · answer (short) · source · confidence. Then the count still unknown and what would close them (e.g. "needs Domain reference for dmc_intake_items — not found on Drive under Pivotly/Docs"). Present the regenerated SKILL.md.

## Rules
- Code beats docs; the running API beats code. When they disagree, the live response is truth for the skill, and the disagreement is a bug report for the user.
- Never fill a gap from memory of "how frameworks usually work". Evidence or `still-unknown`.
- Redact tokens, hostnames of non-local environments, and real customer data from evidence before it enters the skill.
