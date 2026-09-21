---
name: api-verify
description: >
  This skill should be used when the user asks to "verify against the running API", "hit the endpoint and see",
  "capture the real response", "what does the API actually return", "probe the error codes", "check the live
  contract", or when close-gaps assigns gaps to the live backend. It uses the skill-forge MCP tools (forge_health,
  forge_openapi, forge_request) against the developer's running Pivotly core backend to capture real envelopes,
  status codes, and limits. Requires the backend to be running locally.
metadata:
  version: "0.1.0"
---

# API Verify

Prove the contract by calling it. The running API is the highest-authority source: when it disagrees with the docs or the code, the response wins for the skill, and the disagreement is reported to the user.

## Prerequisites
- The user's backend running locally. `forge_health` finds it on the usual ports (3000/8080/8081) and remembers the URL; nothing to type.
- A Pivotly sign-in (`forge_auth_login`, one-time browser step; refreshes silently afterwards). The MCP server attaches the signed-in user's bearer token and redacts it from all output.
- If either is missing, `forge_health` says so and names the tool to call — see the **forge-setup** skill. Never ask the user to paste a token or set an environment variable.
- Dev database. Writes are permitted on this environment (user decision), but **every mutating call still requires per-call confirmation** — show method, endpoint, plain-language effect, and payload; wait for approval.

## Procedure

### 1. Health first
Call `forge_health`. If not reachable → stop, tell the user to start the backend (or pick the URL it detected). If `auth.signed_in` is false → `forge_auth_login` (say a browser window opens), then `forge_health` again. Read `auth.probe.outcome`: `accepted` → continue; `authenticated_not_provisioned` → the account has no IAM user in this backend yet — the developer opens the Portal frontend against it once; do not re-sign-in; `rejected` → `forge_auth_login(force: true)`, and stop if still rejected. Note `openapi.path`.

### 2. Discover
If a spec is served, call `forge_openapi` with `filter` for the area under test (e.g. `core-data`, `attachments`, `data-views`). Use it to confirm exact paths and declared response codes; declared ≠ observed, so still probe.

### 3. Probe plan
For each gap, design the minimal request that answers it. Present the plan as a table (gap · method · path · body · expected observation) before running. Order: reads → read-error probes → writes → write-error probes → cleanup.

Standard probes for a data-plane skill:
| Gap | Probe |
|---|---|
| Success envelope shape | one valid read; record every top-level key and `meta`/`pagination` fields |
| Unknown-domain error | read with `domain: "__skillforge_nonexistent__"` |
| Permission-denied error | write to a domain the token lacks `domain.delete` on, or `operation: delete` if applicable |
| Invalid enum error | write with `latency: "staged"` / `operation: "merge"` |
| Oversize bundle | write with 1001 minimal items (confirm first; use insert to a sandbox domain the user names) |
| Stale version token | update with `version_token: "0"` + `require_fww_lock: true` |
| Pagination behavior | read with `limit: 2`, then `offset: 2`; compare `has_more`, `total_records` across `count_mode` values |
| Egress response shape | egress with `sync_mode: incremental`, `limit: 1` |
| Attachment limits | save a small file, then one over a suspected limit (confirm; ask user for a limit to test) |

### 4. Execute with `forge_request`
- Reads: run freely, log each.
- Writes: confirm each call individually. Tag test records so they are identifiable: `source_record_ref` prefixed `skillforge-<date>-` and, where a free text column exists, the value `skill-forge probe`.
- Capture per call: status, timing, `content-type`, full JSON body (trimmed of large arrays beyond 3 items).

### 5. Cleanup
List every record/attachment created. Offer to soft-delete them (confirm each, or one explicit "delete all probe records" approval covering the listed set). Purge only if the user asks.

### 6. Report
Gap → observed answer → evidence (request + response excerpt) → confidence `confirmed`. Add **Contract disagreements**: any place the response differs from the docs or the code, quoted side by side. Hand back to `close-gaps` or present directly.

## Rules
- Never send requests to any host other than the configured base URL (the MCP server enforces this).
- Never probe production. `forge_config_set` refuses a non-local backend URL unless the user has explicitly confirmed it is a dev environment; if `forge_health` reports a `base_url` you cannot confirm is dev, stop and ask.
- Do not loop on failures; a 5xx is itself evidence — record it and move on.
- Trim personal or customer data from captured responses before it enters a skill file.
