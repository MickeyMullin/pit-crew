# Claude Code execution notes

Notes specific to running these prompts under Claude Code. Not applicable to other agents.

## Bash command batching

Claude Code's permission system matches on command prefixes. Wrapping multiple
commands in a shell function, `for` loop, `while` loop, or other shell construct
(e.g. `show(){ ...; }; show a b`) cannot be pre-approved and forces a manual
prompt for the whole batch. When using Bash for citation verification, issue
plain single commands or a straight `;`-separated list instead.
