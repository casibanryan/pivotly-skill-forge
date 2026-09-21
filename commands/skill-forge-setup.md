---
description: Set up pivotly-skill-forge — sign in to Pivotly in the browser, detect the backend URL, and store the backend checkout path
---

Run the **forge-setup** skill now.

Start with `forge_config_status` so nothing already available is asked for again. Then, in this order and only for what is missing:
1. `forge_health` — detects and remembers the backend URL on the usual local ports; prompt with `forge_config_collect(keys: ["api_base_url"], force: true)` only if it says several or none answered.
2. `forge_auth_login` — say in one line that a browser window will open for the Microsoft sign-in; it is a one-time step per machine. Then `forge_health` again to confirm `auth.probe.outcome` is `accepted`.
3. `forge_config_collect(keys: ["backend_path"])` — one input field in the host UI; verify with `forge_git_state`.

$ARGUMENTS

If the arguments above name specific settings (for example "sign in", "just the backend path", "switch account"), do only those; "switch account" or "add the write scope" means `forge_auth_login(force: true)`. Never ask the developer to paste a token, set an environment variable, or edit a file.
