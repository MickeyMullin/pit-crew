---
description: "Review a Dependabot dependency bump, accounting for rebases and re-bumps of the same PR. Approves automatically when the bump has nothing above P3 and green CI. Add --no-post to write the report without posting anything, and --emit-json=<run-dir> to also write machine-readable progress and results to that directory."
argument-hint: "[PR number | PR URL] [head SHA] [sibling context] [--no-post] [--emit-json=<run-dir>]"
---

Follow the instructions in `{{HOME}}/agents/prompts/review/review-dependabot.md` in full. You are
running as Claude Code — also read and apply `{{HOME}}/agents/prompts/review/claude-code-notes.md`.

TARGET: $ARGUMENTS

Treat that as the PR to review, per the prompt's Target section: a PR number or a PR URL, reviewed in a throwaway worktree. It may also carry the head SHA to pin the worktree to, a statement that the clone is already fetched, and a sibling note naming related Dependabot PRs; none of those are part of the target. If it is empty, review the currently checked-out branch, which is the prompt's default and needs no worktree.

A `--no-post` flag in the arguments is not part of the target either: follow the prompt's No-post mode section, remove the flag, and resolve the rest.

A `--emit-json=<run-dir>` flag in the arguments is not part of the target either: follow the prompt's Machine-readable output section, remove the flag, and resolve the rest.
