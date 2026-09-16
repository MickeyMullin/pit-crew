Reconstruct what the user actually did on a given day, from the machine's own records, and present it in a form they can copy into a timesheet. The reader is the user, recalling their own day — not a manager, not a client. Accuracy about what happened matters more than completeness of narrative, and an honest "this is not recorded anywhere" beats a plausible guess.

Resolving the day:

- `<day>` is whatever the invocation supplied: a date (`2026-09-08`), a weekday name (`Tuesday`, meaning the most recent one), `yesterday`, or nothing at all — which means today.
- Resolve it to a calendar date with `date`, and state the resolved date and weekday in the report. Never assume today's date from context; ask the shell.
- Work in the machine's local timezone throughout. Compute the UTC window once (`date -j` / `date -d` as the platform allows), because every record below stores UTC and getting this wrong shifts the whole day by hours.
- The window is local midnight to local midnight. Note in the report that a block before roughly 02:00 is usually the previous evening's tail, and say so rather than silently folding it into the day.

Hard constraints:

- **Read-only, everywhere.** No commits, no pushes, no GitHub writes, no edits to any repository. This prompt reports on work; it never touches it. The one file it may write is its own output file.
- Do not post the result anywhere — not a PR comment, not an issue, not a chat integration. It is a personal record of the user's day and may name clients, internal branches, and unreleased work.
- Do not attribute anything you cannot source. Every claim in the report traces to a transcript entry, a commit, or a GitHub record. If two sources disagree, say so and cite both.
- Do not estimate hours worked from message counts. Report the spans and the evidence; the user assigns the hours.

Sources, in the order to gather them:

1. **Claude Code transcripts** — `{{HOME}}/.claude/projects/<project-slug>/<session-id>.jsonl`, one JSON object per line. The project slug is the working directory with `/` replaced by `-`, so it identifies both the repo and the worktree.
   - Filter on the `timestamp` field of each entry, **never on file mtime**. Files are touched by later sessions, resumes, and compaction: a file whose mtime falls on the target day routinely contains no entries from that day at all, and a session that ran all day may live in a file last written days later. Walk every file and select by entry timestamp.
   - Prompts come from entries with `"type": "user"`. `message.content` is either a string or a list of blocks; take the `text` of blocks whose type is `text`, and ignore `tool_result` blocks entirely — those are tool output, not the user speaking.
   - Discard anything that is not the user typing: text beginning with `<` (`<ide_opened_file>`, `<local-command-caveat>`, `<system-reminder>`), and the `Skill /x is already loaded above` filler that repeats within a session.
   - **Deduplicate across project slugs.** A worktree-based session records the same prompt under both the main repo's slug and the worktree's slug. The same text within a minute is one event, not two.
   - `<session-id>/subagents/*.jsonl` hold delegated work. Exclude them when listing prompts — the user did not type those — but include them when measuring effort, since they represent real elapsed work the user was waiting on.
2. **Git history** — for each working copy under the user's dev roots, `git log --all` bounded to the day. Sort and unique across clones: the same commit appears in every clone that has fetched it. Report the subject lines; they are usually the clearest statement of what was done.
   - Author date and commit date diverge after a rebase, an amend, or a cherry-pick, which is common on a review-heavy day. Prefer author date, and when a commit's two dates straddle the day boundary, flag it rather than picking one silently.
3. **GitHub activity**, when `gh` is available and the day involved a hosted repo.
   - Confirm the acting account first (`gh auth status`) and say which account and which repository the report covers. A machine with more than one client's login on it will happily answer for the wrong one.
   - PRs the user touched: `gh search prs --repo <owner>/<repo> --author <login> --updated <day>`.
   - Review comments they posted: the repository's issue-comments endpoint with `since` set to the window, filtered to their login. On a review-heavy day this is the single richest source — each comment is a completed review with a timestamp.
   - Remember these timestamps are UTC while the transcript times you are printing are local. Convert before interleaving them.
4. **Anything the invocation supplied.** Meetings, calls, and offline work leave no trace in any of the above. If the user listed them, place them on the timeline as given and never adjust their stated times. If they listed none, do not invent any — but do point at unexplained quiet stretches, since that is usually what they were.

Analysis:

- Build an hourly histogram of transcript entries across the whole day, and count the distinct minutes in which any entry occurred. Report both. Distinct active minutes is a floor on engaged time, never a total: it counts minutes in which something was recorded, and misses reading, thinking, and waiting on a long-running agent.
- A near-empty hour between two busy ones is evidence of something away from the keyboard. Say what the gap suggests and let the user name it; if they already named a meeting at that hour, note that the record agrees with them.
- Group the day into blocks of related work rather than listing sessions. A block is a coherent piece of work — a review sweep, one feature, one investigation — and may span several sessions, repos, and worktrees.
- Cross-reference within each block: the prompt that started it, the commits it produced, the PRs it moved. A block with prompts but no artifacts is investigation or reading, and worth labelling as such rather than dropping.
- Separate work that produced a durable artifact from work that did not. Both count on a timesheet; only one is provable later.

Output file:

- Write the full report to `{{HOME}}/agents/output/day-<YYYY-MM-DD>.md`, in addition to printing it in chat.
- Overwrite a file from a prior run for the same day. Re-running after remembering an offline meeting is the expected workflow.
- Keep intermediate extraction scripts in a scratch directory, never in the repo being reported on.

Report structure:

1. **Header** — the resolved date and weekday, the timezone the times are in, and which sources were actually available (transcripts, git, GitHub, user-supplied meetings). Name the ones that were not, so the user knows what the report cannot see.
2. **Activity shape** — the hourly histogram in one or two lines, the busy spans, and the quiet ones. This is where a meeting-shaped hole gets pointed out.
3. **Blocks**, in chronological order. For each: the local time span, a one-line statement of what the work was, and the specifics underneath — PR numbers, branch names, commit subjects, files, findings. Prefer the user's own words from their prompts over your paraphrase; they will recognise their phrasing faster than a summary of it.
4. **Suggested timesheet split** — a table of buckets with approximate durations, derived from the block spans. Buckets should match how the user bills: by client, by project, or by kind of work. Show meetings as a row referring to their own calendar rather than a number you made up.
5. **Caveats** — anything genuinely ambiguous: after-midnight work, commits whose dates straddle the boundary, blocks whose span you inferred from sparse evidence, work that appears in no artifact. Keep this short and specific. A caveat the user has to think about is worth more than five they will skip.

Judgement:

- The durations in the split are a starting point for the user to correct, and should be presented that way. Round to the quarter hour; false precision on a reconstructed day is worse than an honest range.
- When the day contains work for more than one client or context, keep those buckets separate all the way through, including in the blocks. Merging them is the error that makes the report useless for its actual purpose.
- Personal or off-hours work goes in its own bucket, stated as such, and never folded into a billable one.
- If the record for the day is genuinely thin — a couple of sessions, no commits — say so plainly in two lines rather than inflating it into a structure it cannot support.
