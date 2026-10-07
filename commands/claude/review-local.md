---
description: "Review uncommitted or unpushed local work before a PR exists, with an optional fix mode that WIP-commits your in-flight work first. Add --tandem to launch a second reviewer and consolidate (--tandem=<id> picks it, --tandem=manual means you start it yourself), or --tandem-secondary to be that second reviewer."
argument-hint: "[--tandem[=<id>,... | =manual] | --tandem-secondary]"
---

Follow the instructions in `{{HOME}}/agents/prompts/review/review-local.md` in full. You are
running as Claude Code — also read and apply `{{HOME}}/agents/prompts/review/claude-code-notes.md`.

Invocation arguments: $ARGUMENTS

This prompt takes no target. The only argument it accepts is a tandem-mode flag (`--tandem[=<id>,...]`, `--tandem=manual`, or `--tandem-secondary`), per the prompt's Tandem mode section. Empty arguments are the normal case.
