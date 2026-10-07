# Claude Code execution notes

Notes specific to running these prompts under Claude Code. Not applicable to other agents.

## Bash command batching

Claude Code's permission system matches on command prefixes. Wrapping multiple
commands in a shell function, `for` loop, `while` loop, or other shell construct
(e.g. `show(){ ...; }; show a b`) cannot be pre-approved and forces a manual
prompt for the whole batch. When using Bash for citation verification, issue
plain single commands or a straight `;`-separated list instead.

## Launching tandem-mode secondaries

When `tandem.md` tells the primary to launch a secondary, start `tandem-secondary` with the Bash tool and `run_in_background: true`, one call per secondary, in the same message if there are several. Then start your own review at once. Do not wait on the call, poll it with `sleep`, watch it with Monitor, or check the draft file in a loop: Claude Code notifies you when a background command exits, and you read the launcher's summary line from the output file that notification names.

If the notification arrives while you are still reviewing, finish your own draft first; the secondary's result keeps. If you finish first, say in chat that your draft is written and which secondaries are still running, then stop until their notifications arrive.
