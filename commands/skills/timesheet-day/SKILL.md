---
name: timesheet-day
description: Build one day's timesheet from the day's recorded work (agent transcripts, git, GitHub) and file it in Skuld as clock-based entries. Add `preview` to file nothing.
---

# Build and file a day's timesheet

Follow the instructions in `{{HOME}}/agents/prompts/report/timesheet-day.md` in full. That file is the whole specification for this task — read it before doing anything else, and follow it as written rather than substituting your own timesheet process.

The invocation may carry the day, a work window, a standup length, `preview` or `replace`, and offline work with its times. Pass all of it to the prompt.

The prompt is written to be agent-agnostic. `claude-code-notes.md` sits beside the review prompts and is **not** part of this skill: it covers Claude Code's own execution quirks and does not apply here. Ignore any instruction in the prompt to load it unless you are in fact running as Claude Code.

If the prompt file is not there, stop and say so rather than improvising from this description. Its path is fixed when the skill is installed, so a missing file means the install is incomplete — not that you should carry on without it.
