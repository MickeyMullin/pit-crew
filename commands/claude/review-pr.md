---
description: "Review one GitHub PR against its real base branch and post the report as an approval, a request-changes review, or a comment, depending on the findings. Add --tandem to review alongside another agent and post one consolidated report, or --tandem-secondary to be that other agent."
argument-hint: "[PR number | branch | PR URL] [--tandem | --tandem-secondary[@sha]]"
---

Follow the instructions in `{{HOME}}/agents/prompts/review/review-pr.md` in full. You are
running as Claude Code — also read and apply `{{HOME}}/agents/prompts/review/claude-code-notes.md`.

TARGET: $ARGUMENTS

Treat that as the PR to review, per the prompt's Target section: a PR number, a branch
name, or a PR URL. If it is empty, review the currently checked-out branch, which is the
prompt's default and needs no worktree.

A `--tandem` or `--tandem-secondary[@<sha>]` flag in the arguments is not part of the target: follow the prompt's Tandem mode section, remove the flag, and resolve the rest.
