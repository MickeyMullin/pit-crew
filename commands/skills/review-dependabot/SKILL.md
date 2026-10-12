---
name: review-dependabot
description: Review a Dependabot dependency bump, accounting for rebases and re-bumps of the same PR. Approves automatically when the bump has nothing above P3 and green CI.
---

# Review a Dependabot bump

Follow the instructions in `{{HOME}}/agents/prompts/review/review-dependabot.md` in full. That file is the whole specification for this task — read it before doing anything else, and follow it as written rather than substituting your own review process.

The invocation may name the PR to review — a PR number or a PR URL. Pass it to the prompt and follow its Target section, which reviews it in a throwaway worktree. The invocation may also carry the head SHA to pin that worktree to, a statement that the clone is already fetched, and a sibling note naming related Dependabot PRs; none of those are part of the target. If the invocation names no PR, the prompt reviews the current checkout instead; that is its default, not an error.

The prompt is written to be agent-agnostic. `claude-code-notes.md` sits beside it in the same directory and is **not** part of this skill: it covers Claude Code's own execution quirks and does not apply here. Ignore any instruction in the prompt to load it unless you are in fact running as Claude Code.

If the prompt file is not there, stop and say so rather than improvising from this description. Its path is fixed when the skill is installed, so a missing file means the install is incomplete — not that you should carry on without it.
