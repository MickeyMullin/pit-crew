---
description: "Sweep every open Dependabot PR in a repo: review each one, find the PRs that must land together, and end with one table of recommendations and a merge order. Approves only bumps with nothing above P3 and green CI; never merges or pushes. Add --no-post to write the report without posting anything, and --emit-json=<run-dir> to also write machine-readable progress and results to that directory."
argument-hint: "[owner/repo] [PR numbers...] [--parallel N] [--force] [--no-post] [--emit-json=<run-dir>]"
model: sonnet
---

Follow the instructions in `{{HOME}}/agents/prompts/review/review-dependabot-sweep.md` in full. You are
running as Claude Code — also read and apply `{{HOME}}/agents/prompts/review/claude-code-notes.md`, including its "Running a Dependabot sweep" section.

ARGUMENTS: $ARGUMENTS

Read those per the prompt's Arguments section: an optional `owner/repo`, optional PR numbers to limit the sweep, `--parallel N` for how many reviewers run at once, and `--force` to review every PR fresh. All are optional and may come in any order. If the arguments are empty, sweep every open Dependabot PR in the repo of the current working directory, two reviewers at a time, reusing the verdicts of PRs unchanged since their last report.

A `--no-post` flag in the arguments does not name the repository or the PRs to sweep: follow the prompt's No-post mode section, remove the flag, and read the rest per its Arguments section.

A `--emit-json=<run-dir>` flag in the arguments does not name the repository or the PRs to sweep: follow the prompt's Machine-readable output section, remove the flag, and read the rest per its Arguments section.
