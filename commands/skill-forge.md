---
description: Run a full skill-forge session — draft a skill from reference docs, then close its gaps from the backend repo, the running API, and Google Drive
---

Run the **forge-run** skill now.

Preflight with `forge_config_status` (and `forge_git_state` if a checkout is stored) without asking for anything. Then take the reference documents from the arguments below — uploaded files, a local path, or Drive document names — draft with **doc-to-skill**, offer the bounded gap loop (**close-gaps**, at most two passes), and write `SKILL.md` + `SOURCES.md` (and `references/` only if needed) to the output location.

$ARGUMENTS

Collect settings only when a stage needs them: `forge_auth_login` (one-time browser sign-in) before any live API probe, `forge_config_collect(keys: ["backend_path"])` before mining the repo. Never ask the developer to paste a token, set an environment variable, or edit a file.
