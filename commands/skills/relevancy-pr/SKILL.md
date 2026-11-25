---
name: relevancy-pr
description: Judge whether your own PR is still relevant against its base branch as it stands now, judged by the problem or feature its body states, and whether its changes need updates because of what landed there since it branched. Read-only, with no edit, no commit, no push, no rebase, and no GitHub write of any kind. When updates are needed, it writes a ready-made prompt for a Fix session. Add --emit-json=<run-dir> to also write machine-readable progress and results to that directory.
---

# Judge whether your own PR is still relevant

Follow the instructions in `{{HOME}}/agents/prompts/relevancy/relevancy-pr.md` in full. That file is the whole specification for this task — read it before doing anything else, and follow it as written rather than substituting your own process.

The invocation may name the PR to judge — a PR number, a branch name, or a PR URL. Pass it to the prompt and follow its Target section, which confirms the PR is yours and reads its code through git's object store. If the invocation names nothing, the prompt takes the PR of the currently checked-out branch, as its Arguments section says; that is its default, not an error.

If the invocation includes `--emit-json=<run-dir>`, that flag is not part of the target. The prompt's Machine-readable output section covers it: remove the flag, read the shared file the section names, and resolve the rest as the target. Any other flag is bad usage under the prompt's Arguments section.

The prompt is written to be agent-agnostic. `claude-code-notes.md` sits beside the review prompts and is **not** part of this skill: it covers Claude Code's own execution quirks and does not apply here. Ignore any instruction in the prompt to load it unless you are in fact running as Claude Code.

If the prompt file is not there, stop and say so rather than improvising from this description. Its path is fixed when the skill is installed, so a missing file means the install is incomplete — not that you should carry on without it.
