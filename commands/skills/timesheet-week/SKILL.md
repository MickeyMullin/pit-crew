---
name: timesheet-week
description: Print a week's company-sheet timesheet table from the day files (preview fallback for missing days); `tsv` writes the 7-column file. Files nothing in Skuld.
---

# Build a week's company-sheet table

Follow the instructions in `{{HOME}}/agents/prompts/report/timesheet-week.md` in full. That file is the whole specification for this task — read it before doing anything else, and follow it as written rather than substituting your own process.

The invocation may carry the week, `tsv`, `reset today` or `reset week` (discard saved row edits), a client and project name, and chat edits to rows ("shorter", "cut X", "turn 'and' into commas"). Pass all of it to the prompt.

This skill never files or changes anything in Skuld. For a day with no output file it uses `timesheet-day` in `preview` mode.

`claude-code-notes.md` sits beside the review prompts and is **not** part of this skill. Ignore any instruction to load it unless you are in fact running as Claude Code.

If the prompt file is not there, stop and say so rather than improvising from this description.
