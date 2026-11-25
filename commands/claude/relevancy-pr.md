---
description: "Judge whether your own PR is still relevant against its base branch as it stands now, judged by the problem or feature its body states, and whether its changes need updates because of what landed there since it branched. Read-only: no edit, no commit, no push, no rebase, and no GitHub write of any kind. When updates are needed, it writes a ready-made prompt for a Fix session. Add --emit-json=<run-dir> to also write machine-readable progress and results to that directory."
argument-hint: "[PR number | branch | PR URL] [--emit-json=<run-dir>]"
---

Follow the instructions in `{{HOME}}/agents/prompts/relevancy/relevancy-pr.md` in full. You are running as Claude Code — also read and apply `{{HOME}}/agents/prompts/review/claude-code-notes.md`.

TARGET: $ARGUMENTS

Treat that as the PR to judge, per the prompt's Target section: a PR number, a branch name, or a PR URL. If it is empty, take the PR of the currently checked-out branch, as the prompt's Arguments section says; the code is still read through git's object store, never from this checkout.

A `--emit-json=<run-dir>` flag in the arguments is not part of the target: follow the prompt's Machine-readable output section, remove the flag, and resolve the rest. Any other flag is bad usage under the prompt's Arguments section.
