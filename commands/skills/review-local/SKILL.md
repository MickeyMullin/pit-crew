---
name: review-local
description: Review uncommitted or unpushed local work before a PR exists, with an optional fix mode that WIP-commits your in-flight work first. Add --tandem to review alongside another agent and consolidate, or --tandem-secondary to be that other agent.
---

# Review local work

Follow the instructions in `{{HOME}}/agents/prompts/review/review-local.md` in full. That file is the whole specification for this task — read it before doing anything else, and follow it as written rather than substituting your own review process.

If the invocation includes `--tandem` or `--tandem-secondary`, the prompt's Tandem mode section covers it: you are one of several agents reviewing the same target, and the prompt says which files you may write and what you must not do.

The prompt is written to be agent-agnostic. `claude-code-notes.md` sits beside it in the same directory and is **not** part of this skill: it covers Claude Code's own execution quirks and does not apply here. Ignore any instruction in the prompt to load it unless you are in fact running as Claude Code.

If the prompt file is not there, stop and say so rather than improvising from this description. Its path is fixed when the skill is installed, so a missing file means the install is incomplete — not that you should carry on without it.
