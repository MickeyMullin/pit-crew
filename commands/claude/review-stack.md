---
description: "Review a whole stack of stacked PRs as one cumulative tree and offer to post one report on the top layer. Reports only; never fixes. Add --tandem to launch a second reviewer and consolidate (--tandem=<id> picks it, --tandem=manual means you start it yourself), or --tandem-secondary to be that second reviewer."
argument-hint: "[stack number | PR number | branch | PR URL] [--tandem[=<id>,... | =manual] | --tandem-secondary[@sha]]"
---

Follow the instructions in `{{HOME}}/agents/prompts/review/review-stack.md` in full. You are
running as Claude Code — also read and apply `{{HOME}}/agents/prompts/review/claude-code-notes.md`.

The stack identity is: $ARGUMENTS

Treat that as the stack number, any PR number in the stack, a branch name belonging
to any layer, or a PR URL, per the prompt's Setup section. If it is empty, follow the
prompt's rule for a missing identity — list the repo's stacks and ask which one,
unless exactly one is open.

A `--tandem[=<id>,...]`, `--tandem=manual`, or `--tandem-secondary[@<sha>]` flag in the arguments is not part of the stack identity: follow the prompt's Tandem mode section, remove the flag, and resolve the rest.
