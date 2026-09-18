---
name: review-pr
description: Review one GitHub PR against its real base branch and post the report as an approval, a request-changes review, or a comment, depending on the findings.
---

# Review a pull request

Follow the instructions in `{{HOME}}/agents/prompts/review/review-pr.md` in full. That file is the whole specification for this task — read it before doing anything else, and follow it as written rather than substituting your own review process.

The invocation may name what to review — a PR number, a branch name, or a PR URL. Pass it to the prompt and follow its Target section, which resolves the form and reviews it in a throwaway worktree. If the invocation names nothing, the prompt reviews the current checkout instead; that is its default, not an error.

The prompt is written to be agent-agnostic. `claude-code-notes.md` sits beside it in the same directory and is **not** part of this skill: it covers Claude Code's own execution quirks and does not apply here. Ignore any instruction in the prompt to load it unless you are in fact running as Claude Code.

If the prompt file is not there, stop and say so rather than improvising from this description. Its path is fixed when the skill is installed, so a missing file means the install is incomplete — not that you should carry on without it.
