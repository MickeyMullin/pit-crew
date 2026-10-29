Machine-readable output: a review invoked with `--emit-json=<run-dir>` records its progress and its outcome as JSON files in `<run-dir>`, for the program that started the run and is watching it. This file is loaded by `review-pr.md`, `review-stack.md`, `review-dependabot.md`, and `review-dependabot-sweep.md`, and by `prompts/fix/fix-pr.md`, when the invocation carries the flag. It adds two files and changes nothing else: everything in the calling prompt applies as written, and the human-readable report is written, printed, and posted, or not posted, exactly as it would be without the flag (for `fix-pr`, the fixes are pushed, or not pushed, exactly as they would be).

The flag:

- `--emit-json=<run-dir>`, where `<run-dir>` is the absolute path of a directory that already exists. The caller creates it. You never create it, and you write nothing in it except `events.jsonl` and `result.json`.
- **Check it before anything else, then remove it from the invocation before resolving the target.** `805 --emit-json=/path/to/run` names PR 805. If the value is missing or empty, is not an absolute path, or does not name an existing directory (`test -d <run-dir>`), that is bad usage: say what is wrong with it and stop, before resolving the target, writing nothing anywhere. Never substitute a directory of your own choosing, and never create the one named.
- **It is never passed on to a tandem secondary**, whether launched or started by hand, and a secondary writes no JSON: its one file is its draft, as `tandem.md` says. Leave the flag out of every secondary invocation you launch or give the user to start. An invocation that carries both `--emit-json` and `--tandem-secondary` is bad usage: say so and stop. Under tandem mode the primary alone writes to `<run-dir>`, and the consolidation is the primary's `consolidate` step.
- **A repeated invocation does not carry it.** When the calling prompt's "Re-reviews" section repeats the prior invocation on a terse request to go again, leave `--emit-json` out: that run directory belongs to the earlier run, whose result the caller has already read. Say in chat that it was not carried, as the calling prompt requires for any dropped flag. A run directory comes only from an invocation that names one.
- **Continuing the same run is not a repeat.** When a run stopped to ask (see "Stopping to ask") and the user answers that question in the same session, the session continues the same invocation. Keep the same `<run-dir>`, append further events to the same `events.jsonl`, and write `result.json` again at the run's new end, replacing the earlier one.

Files:

- Both files are UTF-8 JSON and nothing else: no comments, no Markdown fences, no text before or after the JSON.
- Write them with whatever means of writing files you have. Never edit an existing line of `events.jsonl` by hand (see "Progress").

Progress, `<run-dir>/events.jsonl`:

- Append one line each time a step starts, finishes, or is skipped. Each line is one JSON object on a single line, ending in a newline, with exactly these four fields:

```
{ "at": "<ISO 8601 UTC>", "step": "resolveBase" | "review" | "consolidate" | "writeReport" | "post", "state": "started" | "done" | "skipped", "note": "<text>" | null }
```

```
{"at":"2026-10-28T14:03:12Z","step":"consolidate","state":"skipped","note":"no tandem review"}
```

- `at` is the UTC time at which you append the line, to the second, as `date -u +%Y-%m-%dT%H:%M:%SZ` prints it.
- The steps, always in this order:
  - `resolveBase`: resolving the target and the base it is compared against, through the merge base. The calling prompt marks where it starts and ends.
  - `review`: the review itself, from the prior-report read through the final findings. Under tandem mode it ends when your own draft is written.
  - `consolidate`: tandem mode's consolidation, from waiting for the secondaries through the consolidated findings. Without tandem mode, and in a prompt that has no tandem mode, record it once as `skipped` with the note `no tandem review`.
  - `writeReport`: writing the report file, unsuffixed under tandem mode.
  - `post`: deciding the post and making it, under the calling prompt's posting rules. The calling prompt marks where it starts.
- Each step records `started` and then `done`, or a single `skipped` whose `note` gives the reason, such as `no tandem review`, `the PR is yours: nothing is posted on it`, `no PR exists for this branch`, or `run with --no-post`. Append `started` when you begin the step and `done` when it is complete; never append both together after the fact.
- `note` is a short plain-text remark, or null. Use it for a skip's reason, and on `done` for what the caller should see without opening the report, such as the form a post took or a CI wait that gave up. It never names a model, provider, or agent.
- **Append only.** Never rewrite, reorder, or delete a line, including one that turned out to be wrong; append a new one instead. A shell append (`>>`) is the simplest means. If your only means of writing a file rewrites it whole, keep every earlier line byte for byte and add the new line at the end.
- **A step run again is appended again.** When the calling prompt runs its steps a second time within the same run (the re-review after fix mode's fix re-runs the whole prompt, from `resolveBase`), or a continued session resumes a step, append the new lines after the earlier ones. The newest line for a step is its current state. Fix mode's own work (fixing, verifying, committing, pushing) is not a step: it falls between the first pass's `post` and the second pass's `resolveBase`.
- **Stop appending where the run stops.** A run that fails or stops to ask appends nothing after the point where it stopped: a step that had started stays started, and the steps after it get no line at all. Do not mark them skipped.

Response, `<run-dir>/result.json`:

- **Write it as the run's last act**: after the report is written, after any post, and after anything else the run does to files or to GitHub, including removing the worktree when the calling prompt removes it before the run ends. Your closing chat message may follow it; nothing else may. Write it whole, one JSON object. It is written once per end of the run: only a continued session (see "The flag") writes it again, replacing the earlier one.
- A single review writes `pit-crew/review-result@1`. Every field is always present, with null where it does not apply:

```json
{
  "schema": "pit-crew/review-result@1",
  "command": "review-pr",
  "status": "done",
  "target": { "repo": "owner/name", "pr": 101 },
  "reviewed": { "kind": "commit", "sha": "755b78b2c4e1f0a9d3b6e8c7a5f4d2e1b0c9a8f7" },
  "verdict": "changesRequested",
  "recommendation": null,
  "findings": [ { "priority": "P1", "summary": "Retry loop never backs off", "files": ["src/retry.ts"] } ],
  "ci": "green",
  "fixAttempts": 0,
  "posted": { "form": "requestChanges", "url": "https://github.com/owner/name/pull/101#pullrequestreview-1" },
  "notPostedReason": null,
  "report": "~/agents/output/PR-101.md",
  "question": null,
  "error": null
}
```

- `schema`: `"pit-crew/review-result@1"`.
- `command`: `"review-pr"`, `"review-stack"`, or `"review-dependabot"`, the calling prompt's name without `.md`.
- `status`: `"done"` when the run reached its end under the calling prompt, including when its post failed; `"needsInput"` when it stopped to ask (see "Stopping to ask"); `"failed"` when it cannot complete (see "Failing").
- `target`: for `review-pr` and `review-dependabot`, `{ "repo": "<owner>/<name>", "pr": <number> }`, with `pr` null when the reviewed branch has no PR. For `review-stack`, `{ "repo": "<owner>/<name>", "stack": [<PR numbers, bottom to top>], "top": <top PR number> }`. Null when the run stopped before resolving its target.
- `reviewed`: `{ "kind": "commit", "sha": "<full SHA>" }`, the full 40-character SHA of the commit the review read: the tip whose short form begins the report (`git rev-parse HEAD` in the worktree, or in the checkout when reviewing in place). Under fix mode, the commit the last review pass read. Null when the run stopped before reading anything.
- `verdict`: `"changesRequested"` when the report has any P0, P1, or P2 finding; `"clean"` when it has no findings, or P3 only. It follows from the findings alone, whatever form was or would have been posted. Null when no report was written.
- `recommendation`: `review-dependabot` only, the report's merge recommendation: `approve` as `"approve"`, `fix before merge` as `"fixBeforeMerge"`, `hold` as `"hold"`, `do not merge` as `"doNotMerge"`. Null for the other commands, and when no report was written.
- `findings`: one object per finding in the report's Summary index, in the same order and the same count: `{ "priority": "P0" | "P1" | "P2" | "P3", "summary": "<the finding's title>", "files": ["<path>", ...] }`. `files` holds the file paths the summary line names, as it names them and in its order, or `[]` when it names none. Anything else in the line's parenthetical, such as a package name in `review-dependabot`, stays in `summary`, in parentheses after the title; `review-stack`'s layer attribution is left out. `[]` when the report has no actionable findings, and when no report was written.
- `ci`: the status the posting rules' CI gate read, after any wait for it: `"green"` (every check concluded and passed), `"failed"`, `"pending"` (not all concluded when last read, including a wait that errored out), or `"none"` (no checks configured). With `--no-post`, the status as the run last read it without waiting. Null when the run read no CI status, as on your own PR, where no post is considered, or when it stopped first.
- `fixAttempts`: the number on the `Fix attempts:` line of the report this run wrote; 0 when the line is absent or no report was written.
- `posted`: `{ "form": "approve" | "requestChanges" | "comment", "url": "<URL>" }` when the post landed, otherwise null. The URL is the review's or comment's own, as `gh` printed it. If `gh` printed none, read it back once: the `html_url` of the newest entry authored by the active login (`gh api user --jq .login`) in `gh api repos/{owner}/{repo}/pulls/<number>/reviews` for a review, or in `gh api repos/{owner}/{repo}/issues/<number>/comments` for a comment. That read is not a write. If neither gives a URL, use the PR's URL.
- `notPostedReason`: null when the post landed. Otherwise exactly one of:
  - `"noPost"`: the run carried `--no-post` (see `no-post.md`). This reason wins over every other.
  - `"ownPr"`: the PR, or for `review-stack` the top PR, is the active login's own, so the calling prompt does not post on it.
  - `"awaitingAnswer"`: the run stopped to ask before posting, whether at `review-stack`'s offer to post or at any earlier stop to ask.
  - `"ghFailed"`: the post was attempted and `gh` failed. The error goes in `error`, and `status` is still `"done"`.
  - It is null as well when nothing was posted for a reason not in this list: the run failed before the post, no PR exists to post to, or the user declined the offer to post. The `post` step's note, or `error`, says which.
- `report`: the report file's path, with the home directory written as `~` (`~/agents/output/PR-482.md`). Under tandem mode, the consolidated report at the unsuffixed path, never a draft. Null when no report was written.
- `question`: when `status` is `"needsInput"`, the question exactly as you asked it in chat, with the choices you offered; otherwise null.
- `error`: when `status` is `"failed"`, what failed and where; when the post failed, `gh`'s error; otherwise null.

The sweep's response, `pit-crew/sweep-result@1`:

- This schema applies only to `review-dependabot-sweep.md`, which loads this file when its invocation carries the flag. That prompt says what each of the five steps above covers in a sweep, and how each field below is filled; its step meanings replace the single-review ones above, so a sweep records `consolidate` for its synthesis across PRs rather than skipping it. The sweep never passes `--emit-json` to its reviewers: the sweep alone writes to `<run-dir>`.
- With the flag, the sweep still writes its Markdown summary and prints it, and additionally writes the same content to `<run-dir>/result.json`, as its last act, under the rules above. Every field is always present, with null where it does not apply:
  - `schema`: `"pit-crew/sweep-result@1"`.
  - `command`: `"review-dependabot-sweep"`.
  - `status`: `"done"`, `"failed"` (with `error`), or `"needsInput"` (with `question`). A sweep that finishes with some reviews failed is `"done"`, its failures counted and noted per row.
  - `repo`: `"<owner>/<name>"`.
  - `notPostedReason`: `null` when the sweep may post, or `"noPost"` when it ran with `--no-post` (see `no-post.md`). The name and the values mirror `review-result@1`; no other reason applies to a sweep. A sweep run with `--no-post` sets it whether or not any row was reviewed.
  - `counts`: `{ "swept", "fresh", "reused", "failed" }`, the numbers on the summary's first line.
  - `rows`: one object per PR, sorted by number: `{ "number", "url", "title", "head" (the full SHA), "bump" (the return structure's `Bump` text), "recommendation" (as in `review-result@1`), "ci" (as in `review-result@1`), "findings" ([`{ "priority", "summary" }`], at most four), "escalation" (the trigger, or null), "posted" (as in `review-result@1`; under `--no-post` null for every row that is not `reused`), "reused" (true when the row reused an unchanged report), "report" (the path, with `~`), "notes" (the table's Notes text) }`.
  - `mergeOrder`: `[ { "action", "prs": [<numbers>] } ]`, the summary's Merge order and actions, in order.
  - `summary`: the Markdown summary's path, with the home directory written as `~`.
  - `question`, `error`: as in `review-result@1`.

The fix's response, `pit-crew/fix-result@1`:

- This schema applies only to `prompts/fix/fix-pr.md`, which loads this file when its invocation carries the flag. That prompt says what each of the five steps above covers in a fix, and where each is recorded; its step meanings replace the single-review ones above, so a fix records `consolidate` for making the fixes and running the checks rather than skipping it as `no tandem review`, and `post` for the push.
- `fix-pr`'s stops to ask (a request that needs judgment, a local branch holding unpushed commits, a failed check, checks that cannot run, a fix that needs a file outside its rules) are stops to ask under "Stopping to ask" below. Its instructions to stop and say so are failures under "Failing" below, and so is a refused push: for `fix-pr`, the rule that a failed post is not a failure of the run does not apply.
- `result.json` is written as the run's last act, under the rules above: after the report is written and updated, after any push, and after the worktree is removed. Every field is always present, with null where it does not apply:

```json
{
  "schema": "pit-crew/fix-result@1",
  "command": "fix-pr",
  "status": "done",
  "target": { "repo": "owner/name", "pr": 101, "branch": "fix/example" },
  "head": { "sha": "755b78b2c4e1f0a9d3b6e8c7a5f4d2e1b0c9a8f7" },
  "requests": [ { "id": "PRRT_kwDOexample", "kind": "thread", "author": "reviewer-login", "path": "src/retry.ts", "line": 12, "outdated": false, "url": "https://github.com/owner/name/pull/101#discussion_r1", "summary": "Back off between retries", "triage": "clear", "outcome": "fixed", "commits": ["9f8e7d6c5b4a39281706f5e4d3c2b1a098765432"] } ],
  "checks": [ { "name": "pnpm test", "result": "passed" } ],
  "pushed": { "branch": "fix/example", "head": "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432", "commits": [ { "sha": "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432", "subject": "Back off between retries" } ] },
  "notPushedReason": null,
  "worktree": null,
  "report": "~/agents/output/FIX-101.md",
  "question": null,
  "error": null
}
```

- `schema`: `"pit-crew/fix-result@1"`.
- `command`: `"fix-pr"`.
- `status`: `"done"` when the run reached its end: the fixes were pushed, there was nothing to fix, or the owner, answering a stop, told it to discard its commits. `"needsInput"` when it stopped to ask; `"failed"` when it cannot complete, a refused push included.
- `target`: `{ "repo": "<owner>/<name>", "pr": <number>, "branch": "<the PR's head branch>" }`. Null when the run stopped before resolving its target.
- `head`: `{ "sha": "<full SHA>" }`, the full 40-character SHA of the PR head the run read and triaged against, and at which any worktree was created. When the run started again because the head moved, the head of the pass that ended the run. Null when the run stopped before reading it.
- `requests`: one object per request, in the report's order (threads in file order, then review bodies), the same requests as the report's Requests section, or the stop's list when no report was written:
  - `id`: the review thread's GraphQL node id, or the review's.
  - `kind`: `"thread"` or `"review"` (the body of a reviewer's standing change request).
  - `author`: the login of the reviewer whose ask it is: for a thread, the first comment's author other than the owner. Null when GitHub gives no login.
  - `path`: the thread's repo-relative path; null for a review.
  - `line`: the thread's `line`, or its `originalLine` when the thread is outdated; null for a review, or a thread on a whole file.
  - `outdated`: true when the thread is outdated; false for a current thread and for a review.
  - `url`: the URL of the thread's first comment, or of the review.
  - `summary`: the request in one line.
  - `triage`: `"needsJudgment"`, `"noChange"`, `"disagree"`, `"outOfScope"`, or `"clear"`, as `fix-pr.md` defines them; for a request the owner settled at a stop, still the triage the run gave it.
  - `outcome`: `"fixed"` when a commit answers it, pushed or not (`pushed` says which); `"notFixed"` when the run settled it without a fix (`noChange`, `disagree`, `outOfScope`, or the owner's answer); `"awaitingAnswer"` when the run stopped to ask before it was settled.
  - `commits`: the full SHAs of the commits that answer it, or `[]`.
  - `[]` when the PR had no request, and when the run stopped before gathering.
- `checks`: one object per check in the verifying run, in the order run: `{ "name": "<the command as run>", "result": "passed" | "failed" | "notRun" }`, with `notRun` for a check that applied but could not run. `[]` when no fix was made.
- `pushed`: `{ "branch": "<branch>", "head": "<full SHA of the new head>", "commits": [ { "sha": "<full SHA>", "subject": "<subject line>" } ] }`, the commits in the order made, when the push landed; otherwise null.
- `notPushedReason`: null when the push landed. Otherwise exactly one of:
  - `"nothingToFix"`: triage left no request to fix, and the run finished `"done"`.
  - `"awaitingAnswer"`: the run stopped to ask before touching code, or because a fix needs a file outside its rules.
  - `"checksFailed"`: a check failed, including a commit hook that refused a commit.
  - `"checksNotRun"`: the checks could not run, so the fix is unverified, including a dependency install that failed before any fix was made.
  - `"pushFailed"`: the push was refused. `status` is `"failed"`, and git's error goes in `error`.
  - When a check failed or could not run, that reason is used over `"awaitingAnswer"`, as the report's `Push:` line does. A run the owner told to discard its commits keeps the reason of the stop it answered.
  - It is null as well when the run failed before deciding the push, as at any stop to say so; `error` says why.
- `worktree`: the throwaway worktree's path, with the home directory written as `~`, when the run left one behind: commits not pushed, or a removal that refused. Otherwise null.
- `report`: `~/agents/output/FIX-<number>.md`, with the home directory written as `~`. Null when no report was written, as at a stop to ask before touching code.
- `question`, `error`: as in `review-result@1`; `error` also carries git's error for a refused push.

Stopping to ask:

- **Wherever the calling prompt, or `tandem.md`, says to stop and ask, a run with the flag stops there too.** That includes a closed or merged PR under `review-pr.md`; a missing stack identity with more than one stack open; whether to fix, and at which model or effort; the one-attempt bound when the re-review after a fix finds anything; a tandem secondary that failed, or a draft that fails its checks; an unreachable pinned SHA; a prior invocation that cannot be repeated as written; and `review-stack`'s closing offer to post, which waits for an explicit yes.
- At such a point, ask in chat exactly as the calling prompt says, append no further events, and write `result.json` with `"status": "needsInput"` and the question in `question`. Fill every other field with what the run has reached: a report already written keeps its `verdict`, `findings`, `fixAttempts`, and `report`. Then stop.
- **Never answer your own question and never pick a default.** Do not choose the option listed first or the one you would recommend, and do not read silence, a missing user, or a program watching as consent. The flag means a program is watching, not that nobody will answer: the answer comes from the user, in this session or in a new run.
- **`review-stack`'s offer to post**: the `post` step was started when you began deciding the post, as that prompt marks, and it stays started. Ask, naming the form as that prompt requires, and write `result.json` as `"needsInput"`, with `posted` null, `notPostedReason` `"awaitingAnswer"`, and the offer, form included, in `question`. If the user answers in the same session, append `post` `done` with the form, or `skipped` with the note `declined`, and write `result.json` again. Where that prompt does not offer at all (an approve verdict on your own top PR), append `post` `skipped` with the reason and finish as `"done"`, with `notPostedReason` `"ownPr"`.
- A prompt's instruction to stop and say so, with no question, is not a stop to ask. It is a failure.

Failing:

- A run that cannot complete has failed: the calling prompt says to stop and say so (a repository with no clone here, a branch with no PR, a branch that is not Dependabot's or a Dependabot PR that is closed or merged, a stack whose layers are not ancestors of its tip), a command it depends on fails in a way the prompt gives no rule for, or the report file cannot be written. A failed post is not a failure of the run; the calling prompt's rule for it applies, and `notPostedReason` is `"ghFailed"`.
- Say so in chat as the calling prompt directs, append no further events, and write `result.json` with `"status": "failed"` and what failed in `error`, every other field filled as far as the run reached.
- If `result.json` itself cannot be written, say so in chat. The caller treats a run with no valid `result.json` as failed.

What the flag never changes:

- The single permitted GitHub write per review, and the sweep's list of things it must never do.
- Writing the report to disk before posting it: only then, never before it and never concurrently with it.
- The one-attempt bound on fix mode, and the `Fix attempts:` line that carries it.
- `review-pr` fixing only the viewer's own PR, confirmed by matching `gh api user` against the PR author login, never inferred from a checked-out branch.
- `review-stack` never fixing, on any stack, under any authorship.
- `fix-pr` acting only on the viewer's own PR, confirmed the same way; its push as its only GitHub write; its one fix attempt; and its report written before the push.
- Where the report goes, what it says, and when it is written. The JSON describes the run; it never replaces the report or the chat response.
- The no-attribution rules, which apply to both files exactly as to the report: no model, provider, or agent names anywhere in them, and escalation is reported by its trigger, never by which model ran.
