---
description: "Print a week's company-sheet timesheet table from the day files (preview fallback for missing days). Add `show` to print the saved TSV from disk without regenerating anything. Add `tsv` to write the 7-column file; `reset <day>` (today, a weekday, a date, yesterday) or `reset week` discards saved row edits. Files nothing in Skuld."
argument-hint: "[week | last week] [tsv | show] [reset <day> | reset week] [client and project name] [row edits]"
---

Follow the instructions in `{{HOME}}/agents/prompts/report/timesheet-week.md` in full. You are running as Claude Code — also read and apply `{{HOME}}/agents/prompts/review/claude-code-notes.md`.

ARGUMENTS: $ARGUMENTS
