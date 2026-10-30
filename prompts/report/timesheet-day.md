Build one day's timesheet from the day's recorded work and file it in Skuld, the user's timekeeper. This prompt is the write-side companion to `report-day.md`: that prompt reconstructs what happened, and this one turns it into dated, clock-based entries and posts them. The reader is the user, who will correct anything wrong afterward, so be explicit about which entries are anchored in the record and which were constructed.

Arguments, all optional and in any order:

- A day: a date (`2026-10-19`), a weekday name (most recent one), `yesterday`, or nothing, which means today.
- A work window such as `0900-1800`. The default is 09:00 to 18:00 local time.
- A standup length in minutes. The default is 15, placed first in the window. `no standup` omits it.
- Offline work or meetings with their stated times. Place these as given and never adjust them.
- `preview`: build and show the timesheet, write the output file, and file nothing in Skuld.
- `replace`: delete that day's existing Skuld entries before filing (see Existing entries).
- A client or project override. The default client is `PC` (Port City) and the default project is `Dispatch Intelligence Platform II`.

Step 1: reconstruct the day. Read `{{HOME}}/agents/prompts/report/report-day.md` and follow it in full for the day, including its output file and report structure. Two of its rules are overridden here because this prompt's invocation is the user's request to assign hours: its ban on estimating hours (the user is delegating exactly that) and its "never post anywhere" rule (this prompt posts to Skuld and nowhere else). Everything else in it stands: read-only against repositories and GitHub, sources traced to a record, local timezone, windows computed with `date`.

Step 2: decide what is billable to the client. Only work for the client belongs on the timesheet. For the default client that means work in the Port City repositories (`Port-City/meridian` and its local clones and worktrees), Port City Jira tickets, and reviews of Port City PRs. Work for other clients, the user's own tooling (Skuld, Dispatch the task tracker, pit-crew, Luci), and timesheet or report-day work for any client is not filed. List what you excluded and why in the report so the user can overrule it. If the invocation names a different client, apply the same test to that client.

If the recorded client work totals under about an hour of distinct active minutes, do not build a full-window sheet. Say the record is thin, show what exists, and ask the user how to proceed.

Step 3: learn the house style before writing anything. Call the Skuld API (below) for `GET /clients` and `GET /projects` and confirm the client code and project name exist exactly. Never post a code or name that is not listed, because an unknown one silently creates a new client or project. Then `GET /entries` for the previous 1 to 2 weeks and read how entries typically look: how long a block runs, how terse the note is (for example `Review PRs 884, 910, 911` or `At-risk panel`), how tickets are written, whether the day has gaps. Match that style.

Step 4: build the entries.

- Start with the standup at the window start, then fill the window with no gaps between entries unless the prior weeks or the user's offline items show one. The last entry ends at the window end.
- Every boundary lands on a quarter hour, because Skuld floors starts and ceils ends to 15 minutes. Entries of 30 to 90 minutes read naturally; do not file anything under 15 minutes except the standup.
- Anchor each entry in the record: the PRs reviewed, the branch worked, the ticket moved, with the day's real order of events as the spine.
- The record rarely covers the whole window. When the user asks for it (or the window is wider than the recorded activity), extend the heaviest recorded activity into the unrecorded stretches, earlier or later, and for today only, extrapolate whatever is in progress now forward to the window end. For a past day there is no in-progress work, so extend the last substantial block instead. Never invent a different kind of work than the record shows, never file activity under a ticket the record does not tie it to, and never move an offline item the user timed.
- Ticket numbers come only from the record: the user's prompts, branch names, PR titles, commit subjects, or a prior-week entry for the same work. Leave `ticket` empty rather than guess. Separate multiple tickets with `, `.
- Notes are terse, sentence-case, in the user's own phrasing where they have one, and name no tool or model as the author or reviewer of anything.
- Name the task, not just the PR number, for the user's own work. Check who authored each PR (`gh pr view <n> --json author`) before deciding: a PR the user authored is described by what it does, such as `Address findings on ETL refresh and approved-driver hold PRs`, never `Address review findings on PRs 925, 926, 929`. Drop the word "review" and the numbers there. Reviews of other people's PRs keep their numbers (`Review PRs 884, 913`), and a Dependabot PR is described as dependency maintenance. Never file a vague note such as `open PRs` or `Address findings`: find the task in the record, and if the record does not name one, leave the note as the record words it and list it under the things to check.
- No two consecutive entries may carry the same note, and near-duplicates (`QA Postgres disk full, ...` twice in a row) should be reworded to say what differs or filed as one longer block.

Mark each entry in your own working notes as `anchored` (the record places it in that span), `extended` (real work moved into an unrecorded stretch), or `extrapolated` (the in-progress work projected forward). Show that column to the user in the report; it is not sent to Skuld.

Step 5: file the entries. Skip this step for `preview`, and also if `GET /api/health` fails: the API is reachable only from the LAN, so say it was unreachable, still write the output file, and stop.

- Existing entries: `GET /entries?from=<day>&to=<day>` first. If the day already has entries, file nothing, show them next to what you would have filed, and ask. Under `replace`, list the ids and notes you are about to delete, delete only those with `DELETE /entries/:id`, and then file. Never edit or delete entries on any other day.
- Convert local wall-clock times to UTC yourself, using the offset `date +%z` reports for that day, never an assumed one. The API's own example uses US Central; do not copy it.
- POST is not idempotent. Post each entry exactly once, in order, from one script kept in a scratch directory outside any repository. Stop at the first error and report which entries were already created, so a retry does not duplicate them.
- Each entry: `date` (local calendar day), `startedAt` and `endedAt` (UTC ISO 8601 with `.000Z`), `client`, `project`, `note`, `ticket`.
- Afterward, `GET /entries` for the day again and verify the count, the stored times, and that the total equals the window length minus any intentional gap. Report any mismatch plainly.

The Skuld API, in full as far as this task needs. Base URL `https://skuld.home.vorheim.com`, all routes under `/api`, JSON bodies with `Content-Type: application/json`, no auth.

- Entry: `{ id, date, startedAt, endedAt, note, ticket, client, project, createdAt }`.
- `GET /api/entries?from=YYYY-MM-DD&to=YYYY-MM-DD`: both params required and inclusive, filtered on `date`, returned ordered by date then start.
- `POST /api/entries`: required `date`, `startedAt`, `endedAt`, `client`; optional `note`, `ticket`, `project`. Returns the entry as stored, with rounded times.
- `PUT /api/entries/:id`: partial update. `DELETE /api/entries/:id`: returns `{ "deleted": true }` or 404.
- `GET /api/clients`, `GET /api/projects`, `GET /api/health`.
- Errors come back as `{ "error": "..." }` with 400 (end not after start, or unknown client), 404, or 409; a schema failure is a 422 with the framework's own payload.
- Overlapping entries are accepted rather than rejected, which is why the existing-entries check comes first.

Output: print the report-day report as that prompt specifies, then the timesheet as a table with columns for start, end, hours, note, ticket, and basis (`anchored`, `extended`, or `extrapolated`), then the Skuld entry ids that were created and the total hours. Write the timesheet section to `{{HOME}}/agents/output/timesheet-<YYYY-MM-DD-DOW>.md` (`DOW` is the lowercase three-letter weekday), overwriting a prior run for the same day, and include the ids so any entry can be removed later. After the table, print the day's row for the company timesheet and include it in the output file. The company sheet takes one row per day, so the day's Skuld notes are consolidated into a single line. Tab-separated, in a `tsv` code block, with these columns: the day as `Mon, 10/26/2026`; the total hours as a whole number (the standup's time counts); the consolidated note; two empty columns; the ticket or tickets, `, `-separated, or empty; and the project's full sheet name, `PortCity Logistics - Dispatch Intelligence Platform II` for the default project (for any other client or project, use the name the user gives, and ask if there is none). Rules for the consolidated note, which exists to be short enough to type into the sheet:

- Omit the standup. Its hours stay in the total and in Skuld; only its words go.
- Merge duplicates and near-duplicates, and fold repeated work on one thing (`Address findings`, `Resolve conflicts`, `CI fix`, `Merge`) into one item per thing.
- Drop PR numbers for the user's own work, as above. List reviews of other people's PRs once, as `Review PRs 884, 913, 970`, with ranges as `992–996` (en dash, full numbers); fold re-reviews into the plain review. When a day has many reviews with no numbers worth keeping, roll them up by theme (`Review PRs on ETL and refresh performance, portal on the core database`).
- Keep the order of the day's real work where it costs nothing, put the largest items first otherwise, and prefer a theme over a list of minor items. No parenthetical detail.

This row is a rendering for the sheet only. Never write it back into Skuld, and never edit or delete Skuld entries to match it. On a `preview` run, print it as well.

End with a short list of things the user should check: the excluded work, any extended or extrapolated span that is large, and any ticket left blank.
