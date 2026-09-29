---
description: "Review a whole stack of stacked PRs as one cumulative tree and offer to post one report on the top layer. Reports only; never fixes. Add --tandem to review alongside another agent and consolidate, or --tandem-secondary to be that other agent."
argument-hint: "[stack number | PR number | branch | PR URL] [--tandem | --tandem-secondary[@sha]]"
---

Follow the instructions in `{{HOME}}/agents/prompts/review/review-stack.md` in full. You are
running as Claude Code — also read and apply `{{HOME}}/agents/prompts/review/claude-code-notes.md`.

The stack identity is: $ARGUMENTS

Treat that as the stack number, any PR number in the stack, a branch name belonging
to any layer, or a PR URL, per the prompt's Setup section. If it is empty, follow the
prompt's rule for a missing identity — list the repo's stacks and ask which one,
unless exactly one is open.

A `--tandem` or `--tandem-secondary[@<sha>]` flag in the arguments is not part of the stack identity: follow the prompt's Tandem mode section, remove the flag, and resolve the rest.
