# Build a week's company-sheet table from the day files

This task renders one Sunday-to-Saturday week of company-timesheet rows from work already recorded. It files nothing: never write to Skuld, and never edit or delete Skuld entries to match what is printed. Skuld is read only, to total hours.

Arguments: an optional week (a date inside it, `last week`, or `this week`; default is the current Sunday-to-Saturday week), optional `tsv`, optional `show` (or `view`; see Show what is on disk), optional `reset <day>` or `reset week` (see Saved hand edits), optional client and project name (default `PortCity Logistics - Dispatch Intelligence Platform II`; for any other project use the name the user gives, and ask if there is none), and any chat edit requests.

## Show what is on disk (`show`)

`show` only displays what a previous run left behind. It reads, regenerates nothing, and writes nothing: no day files, no preview runs, no Skuld reads, no edits-file or TSV writes.

1. Work out the week as usual (default: the current Sunday-to-Saturday week).
2. Read `{{HOME}}/agents/output/timesheet-week-<YYYY-MM-DD>.tsv` (the week's Sunday). If it exists, print its contents verbatim in a `tsv` code block, state the file path and its modified time, then print the same rows as a Markdown table (date, hours, task, tickets) with the one-line client and project header and a total row.
3. If the TSV is missing, say so, and list the `timesheet-week-*.tsv` files that do exist so the user can pick one. Do not build the week. Tell the user `/timesheet-week tsv` would.
4. If a saved edits file exists for the week, add one line naming the dates with saved edits.
5. If a day file for the week is newer than the TSV, add one line saying the TSV may be stale and which days changed. Do not refresh it.

`show` combined with chat edits or a reset does nothing for those parts; say that edits and resets need a normal run.

## Gather the days

1. Work out the week's Sunday and the seven dates through Saturday.
2. For each Monday through Friday (and Sunday or Saturday when a day file exists), read `{{HOME}}/agents/output/timesheet-<YYYY-MM-DD-dow>.md` (`dow` is the lowercase three-letter weekday). From the `tsv` block that file holds for the company sheet row, take hours, note, and tickets. Do not regenerate a row that exists from the day's records. A day file written before the current note rules may hold a long note: re-render its words under those rules (shorten, reorder, no `and`, no parentheticals) without inventing work, and say so. A saved hand edit always wins over both.
3. For a weekday with no file, run the `timesheet-day` task for that day in `preview` mode, following `{{HOME}}/agents/prompts/report/timesheet-day.md`, and use its company-sheet row. Say which days were generated this way. Preview files nothing in Skuld. If preview stops to ask because recorded work is thin, do not guess: leave that day's row empty and flag it. A weekend day with no file stays an empty row; do not generate it.
4. Read each day's Skuld hours (read only) and compare. Total the week's hours from Skuld and from the rows, and say so on one line. Flag every weekday with no entries, and every row with a blank ticket.

## Saved hand edits

The user edits rows by hand and expects those edits to survive reruns. Keep them in `{{HOME}}/agents/output/timesheet-week-<YYYY-MM-DD>.edits.json`, where the date is the week's Sunday. It is a JSON object keyed by date (`2026-11-16`) whose values hold only the fields the user changed (`task`, `hours`, `tickets`). It lives beside the TSV and never in Skuld.

- When the user pastes or states a replacement for a row, or asks for a change to it ("shorter", "cut X", "turn 'and' into commas"), apply it to that row, save the result in the edits file, and reprint the table.
- A change that names no row applies to every row that has no saved edit. A row with a saved edit is changed only when the request names that row.
- `reset <day>` discards the saved edit for one day. `<day>` follows the `timesheet-day` rules: a date (`2026-11-27`), a weekday name (the most recent one, or that week's day when the invocation names a week), `yesterday`, or `today`; a bare `reset` means today. Resolve it with the local clock. If the day is not in the week being rendered, say so and change nothing. That day's row is then rebuilt from its day file, or from a `timesheet-day` preview when there is none, and every other row keeps its saved edits. Use it when a day was edited early and has since been completed.
- `reset week` discards every saved edit for the week, by deleting that week's `.edits.json`, and rebuilds all seven rows from the day files (preview for a weekday with none) as if the week had never been run. It never touches the day files, the TSV from an earlier run (until `tsv` overwrites it), or Skuld. State which saved edits were discarded, by date, so the user can see what was lost.
- A reset applies before anything else in the run, and the table or TSV that follows reflects it. Chat edits made in the same invocation are applied after the reset and saved as new edits.
- On every run, read the edits file first and apply it over the day-file rows, so a rerun never overwrites the user's wording. Say how many rows came from saved edits.
- When a day file is newer than a saved edit for the same date, keep the saved edit and mention that the day was regenerated.

## Default output: the Markdown table

A one-line header naming the client and project and the week (`PortCity Logistics - Dispatch Intelligence Platform II, week of Sun 11/15/2026`), then a table with columns date, hours, task, tickets, one row per day Sunday through Saturday, and a total row. Then the one-line Skuld total check and the flags. Reprint the whole table after every change. This is the iteration view; write no TSV file unless `tsv` is given.

The task text follows the note rules in `timesheet-day.md`: real work first, `PR reviews` last, `; ` between items, `, ` inside an item, never `and`, no parentheticals, no PR numbers for the user's own work, no standup words, no small one-off fixes. Hold chat edits to the same rules. Ticket keys are written in full and separated by `, `.

## `tsv` argument

Emit the TSV in a `tsv` code block and also write it to `{{HOME}}/agents/output/timesheet-week-<YYYY-MM-DD>.tsv` (the week's Sunday), overwriting a prior file, so tabs survive copying. State the path. One line per day, Sunday first through Saturday, seven tab-separated columns:

1. the date as `Mon, 11/16/2026`;
2. hours (to the quarter hour, no whole-number rounding, for example `8.75`);
3. the task note;
4. empty;
5. empty;
6. tickets, `, `-separated;
7. the client and project name.

Sunday and Saturday with no day file are rows with an empty hours, task, and ticket field (a weekend day that has a file is written like any other day) and the date and project name still in place: `Sun, 11/15/2026` then tabs for the empty fields (still seven columns) and the project name. A weekday with no work is flagged, not silently emptied. Write real tab characters and no trailing newline problems: end each line with a single newline. After writing the file, read it back and confirm each line has seven fields.

## End

Print the flags (days with no entries, blank tickets, days generated by preview, Skuld total differing from the rows' total) and stop.
