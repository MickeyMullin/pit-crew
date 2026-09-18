---
name: report-day
description: Reconstruct one day's work from agent transcripts, git history, and GitHub activity, shaped for filling in a timesheet. Read-only; never posts anywhere.
---

# Report a day's work

Follow the instructions in `{{HOME}}/agents/prompts/report/report-day.md` in full. That file is the whole specification for this task — read it before doing anything else, and follow it as written rather than substituting your own reporting process.

The invocation may carry the day to report on — a date, a weekday name, `yesterday`, or nothing for today — plus anything else worth knowing, such as meetings that left no trace on the machine. Pass all of it to the prompt, which places offline work as given rather than inferring it.

The prompt is written to be agent-agnostic. `claude-code-notes.md` sits beside it in the same directory and is **not** part of this skill: it covers Claude Code's own execution quirks and does not apply here. Ignore any instruction in the prompt to load it unless you are in fact running as Claude Code.

If the prompt file is not there, stop and say so rather than improvising from this description. Its path is fixed when the skill is installed, so a missing file means the install is incomplete — not that you should carry on without it.
