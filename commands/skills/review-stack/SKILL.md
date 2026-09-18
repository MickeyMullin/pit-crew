---
name: review-stack
description: Review a whole stack of stacked PRs layer by layer and post one report on the top layer. Reports only; never fixes.
---

# Review a stack of PRs

Follow the instructions in `{{HOME}}/agents/prompts/review/review-stack.md` in full. That file is the whole specification for this task — read it before doing anything else, and follow it as written rather than substituting your own review process.

The invocation may carry the stack identity — a stack number, any PR number in the stack, a branch name belonging to any layer, or a PR URL. Treat it that way, per the prompt's Setup section, which resolves the form and reviews the stack in a throwaway worktree. If the invocation carries none, follow the prompt's rule for a missing identity: list the repo's stacks and ask which one, unless exactly one is open.

The prompt is written to be agent-agnostic. `claude-code-notes.md` sits beside it in the same directory and is **not** part of this skill: it covers Claude Code's own execution quirks and does not apply here. Ignore any instruction in the prompt to load it unless you are in fact running as Claude Code.

If the prompt file is not there, stop and say so rather than improvising from this description. Its path is fixed when the skill is installed, so a missing file means the install is incomplete — not that you should carry on without it.
