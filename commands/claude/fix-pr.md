---
description: "Act on the changes requested on your own PR, from GitHub's unresolved review threads and standing change requests, from your latest self-review's findings, or from both (--source=remote|local|both, default the more recent of the two): triage each, make only the clear fixes in a throwaway worktree, verify them, and push them as new commits. The push is its only GitHub write: no replies, no resolved threads, no reviews, no comments. Skips anything below a severity floor with --severity=P0|P1|P2|P3 (default P3, which fixes everything). Stops to ask when a request needs judgment. Add --emit-json=<run-dir> to also write machine-readable progress and results to that directory. Add --extra-instructions beside --emit-json to also address the relevancy check's fix prompt in that directory's extra-instructions.txt."
argument-hint: "[PR number | branch | PR URL] [--source=remote|local|both] [--severity=P0|P1|P2|P3] [--extra-instructions] [--emit-json=<run-dir>]"
---

Follow the instructions in `{{HOME}}/agents/prompts/fix/fix-pr.md` in full. You are running as Claude Code — also read and apply `{{HOME}}/agents/prompts/review/claude-code-notes.md`.

TARGET: $ARGUMENTS

Treat that as the PR to fix, per the prompt's Target section: a PR number, a branch name, or a PR URL. If it is empty, take the PR of the currently checked-out branch, as the prompt's Arguments section says; the fixes are still made in a throwaway worktree, never in this checkout.

A `--emit-json=<run-dir>` flag in the arguments is not part of the target: follow the prompt's Machine-readable output section, remove the flag, and resolve the rest. The same goes for `--source=<remote|local|both>` and `--severity=<P0|P1|P2|P3>`, which the prompt's Arguments and Sources and severity sections define: pass each through, in any letter case for the severity, and refuse any other value as bad usage. An `--extra-instructions` flag in the arguments is not part of the target either: follow the prompt's Arguments and Relevancy prompt sections, remove the flag, and resolve the rest. Any other flag is bad usage under the prompt's Arguments section.
