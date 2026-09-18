---
description: Configure pivotly-skill-forge — backend URL, dev token, and backend checkout path — by answering a few questions
---

Run the **forge-setup** skill now.

Start with `forge_config_status` so nothing already available is asked for again, then call `forge_config_collect` to prompt the developer for what is missing — one input at a time, in the host's own UI. Verify with `forge_health` and `forge_git_state` before reporting back.

$ARGUMENTS

If the arguments above name specific settings (for example "token" or "just the backend path"), pass those as `keys`. If they are empty, call `forge_config_collect()` with no keys. If they ask to change something already set, add `force: true`.

Do not ask for values in conversation while the prompts are available, and never tell the developer to set an environment variable or edit a file. The token is session-scoped — expect to prompt for it every session.
