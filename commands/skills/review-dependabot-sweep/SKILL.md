---
name: review-dependabot-sweep
description: Sweep every open Dependabot PR in a repo, review each one, find the PRs that must land together, and end with one table of recommendations and a merge order. Approves only clean bumps with green CI; never merges or pushes.
---

# Sweep a repo's Dependabot PRs

Follow the instructions in `{{HOME}}/agents/prompts/review/review-dependabot-sweep.md` in full. That file is the whole specification for this task — read it before doing anything else, and follow it as written rather than substituting your own process.

The invocation may carry any of these, in any order: an `owner/repo` naming the repository to sweep; one or more PR numbers that limit the sweep to those PRs; `--parallel N` (or `--parallel=N`) for how many reviewers run at once; and `--force` to review every PR fresh. Pass them to the prompt and follow its Arguments section. If the invocation carries none of them, sweep every open Dependabot PR in the repository of the current working directory with the prompt's defaults; that is the normal case, not an error.

The prompt is written to be agent-agnostic. `claude-code-notes.md` sits beside it in the same directory and is **not** part of this skill: it covers Claude Code's own execution quirks and does not apply here. Ignore any instruction in the prompt to load it unless you are in fact running as Claude Code.

If the prompt file is not there, stop and say so rather than improvising from this description. Its path is fixed when the skill is installed, so a missing file means the install is incomplete — not that you should carry on without it.
