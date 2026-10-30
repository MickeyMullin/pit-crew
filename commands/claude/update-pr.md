---
description: "Bring your own PR up to date with the primary branch: rebase its branch onto it by default, merge it in only when a rebase is not workable (others have commits on the branch, or it is part of a stack), resolve conflicts, and push. A rebase is pushed only with --force-with-lease; the push is its only GitHub write. Stops to ask when a conflict needs judgment. Add --head=<sha> to pin the head you saw, and --emit-json=<run-dir> to also write machine-readable progress and results to that directory."
argument-hint: "[PR number | branch | PR URL] [--head=<sha>] [--emit-json=<run-dir>]"
---

Follow the instructions in `{{HOME}}/agents/prompts/update/update-pr.md` in full. You are running as Claude Code — also read and apply `{{HOME}}/agents/prompts/review/claude-code-notes.md`.

TARGET: $ARGUMENTS

Treat that as the PR to update, per the prompt's Target section: a PR number, a branch name, or a PR URL. If it is empty, take the PR of the currently checked-out branch, as the prompt's Arguments section says; the update is still made in a throwaway worktree, never in this checkout.

A `--head=<sha>` or `--emit-json=<run-dir>` flag in the arguments is not part of the target: follow the prompt's Arguments and Machine-readable output sections, remove the flags, and resolve the rest. Any other flag is bad usage under the prompt's Arguments section.
