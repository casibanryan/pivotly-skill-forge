---
description: Configure pivotly-skill-forge — backend URL, dev token, and backend checkout path — by answering a few questions
---

Run the **forge-setup** skill now.

Start with `forge_config_status` so already-stored settings are not asked for again, then collect what is missing and store each answer with `forge_config_set`. Verify with `forge_health` and `forge_git_state` before reporting back.

$ARGUMENTS

If the arguments above name specific settings (for example "token" or "just the backend path"), collect only those. If they are empty, set up all three.

Do not ask the developer to set an environment variable or edit a file.
