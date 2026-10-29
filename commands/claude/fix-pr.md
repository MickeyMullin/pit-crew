---
description: "Act on reviewers' requested changes on your own PR: gather the unresolved review threads and standing change requests, triage each, make only the clear fixes in a throwaway worktree, verify them, and push them as new commits. The push is its only GitHub write: no replies, no resolved threads, no reviews, no comments. Stops to ask when a request needs judgment. Add --emit-json=<run-dir> to also write machine-readable progress and results to that directory."
argument-hint: "[PR number | branch | PR URL] [--emit-json=<run-dir>]"
---

Follow the instructions in `{{HOME}}/agents/prompts/fix/fix-pr.md` in full. You are running as Claude Code — also read and apply `{{HOME}}/agents/prompts/review/claude-code-notes.md`.

TARGET: $ARGUMENTS

Treat that as the PR to fix, per the prompt's Target section: a PR number, a branch name, or a PR URL. If it is empty, take the PR of the currently checked-out branch, as the prompt's Arguments section says; the fixes are still made in a throwaway worktree, never in this checkout.

A `--emit-json=<run-dir>` flag in the arguments is not part of the target: follow the prompt's Machine-readable output section, remove the flag, and resolve the rest. Any other flag is bad usage under the prompt's Arguments section.
