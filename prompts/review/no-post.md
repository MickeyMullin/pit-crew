No-post mode: a review invoked with `--no-post` does everything it does without the flag, except write to GitHub. This file is loaded by `review-pr.md`, and by any other review prompt that lists `--no-post` among its flags, when the invocation carries the flag; a prompt that does not reference this file does not accept it. The flag only removes writes. It relaxes nothing: everything else in the calling prompt applies as written, and where this file and the calling prompt differ, this file wins only by removing a write.

The flag:

- `--no-post` takes no value. Remove it from the invocation before resolving the target: `805 --no-post` names PR 805. A value (`--no-post=<anything>`) is bad usage: say so and stop.
- It is valid with or without `--emit-json`, and under tandem mode, where it binds the primary. It is never passed on to a tandem secondary, which never posts anyway.
- **A repeated invocation carries it.** When the calling prompt's "Re-reviews" section repeats the prior invocation on a terse request to go again, keep `--no-post`, as the tandem flags are kept. It is a safety flag: a terse request is never a reason to start writing to GitHub. Only explicit words in the new message drop it, and then say so in chat before the review starts.

What it removes:

- **No GitHub write of any kind.** No approval, no request-changes review, no comment, on the PR or anywhere else, whatever the findings, the CI status, or the authorship. That covers the post the calling prompt's posting section would make and every post it would make only after asking. Do not offer to post either, since a yes could not be acted on in this run. If the user asks in this session for this run's report to be posted, say that the run carried `--no-post` and that a run without the flag posts under the calling prompt's own rules.
- **No fix mode.** Fix mode pushes commits, so it never starts: no edit to the code under review, no commit, no push, and no handoff prompt for a session to fix. The calling prompt's questions that exist only to decide a fix (whether to fix, at which model or effort, whether to fix again) do not arise, because there is no fix to decide. Say in chat that fix mode was skipped because the run carried `--no-post`.
- **No CI wait.** The wait that exists only to choose the post's form (`gh pr checks <number> --watch`) does not run, since there is no post. A plain read of the checks that the calling prompt asks for as evidence still happens. Report CI as you last read it.
- Reads are unaffected: `gh` reads, `git fetch`, the authorship check against `gh api user`, the prior-report read, and the throwaway worktree, which is a filesystem write the calling prompt already permits and not a GitHub write, all happen as the calling prompt describes.

What it keeps:

- **The report is written to disk exactly as without the flag**: the same path, the same content rules, and at the same point in the run, before the point where the post would have happened. Where the calling prompt's closing notes record how the report was posted, record that it was not posted because the run carried `--no-post`.
- In the chat response, where the calling prompt asks you to state which form was used, say that nothing was posted because the run carried `--no-post`, and name the form the findings would select, with the CI gate as last read.
- **Every other stop-and-ask point still stops**, exactly as the calling prompt says; with `--emit-json`, as `"needsInput"` (see `emit-json.md`).
- **A `--no-post` run is not a fix attempt.** Carry the `Fix attempts:` line forward exactly as the calling prompt's rule says: the prior value unchanged, never incremented and never reset, and the line omitted when no fix has ever been attempted on the branch.
- For every run that omits the flag, nothing here applies: the single permitted write, the posting forms, the CI gate, fix mode, and the one-attempt bound are untouched.

With `--emit-json`:

- Record the `post` step once, as `skipped` with the note `run with --no-post`.
- `result.json` carries `"posted": null` and `"notPostedReason": "noPost"`, which wins over `"ownPr"` and every other reason, and `ci` as last read without waiting. A sweep's `result.json` has no top-level `posted`: it carries `"notPostedReason": "noPost"`, and each row's own `posted`, which is null for every row that is not `reused` (see `review-dependabot-sweep.md`).

In the Dependabot commands:

- `review-dependabot.md` and `review-dependabot-sweep.md` list `--no-post` among their flags. Neither has a fix mode, so the flag removes the post alone: the approval the clean-bump gate would select, the request-changes review, the plain comment, the stale-approval request-changes form, and the wait for CI (`gh pr checks <number> --watch --interval 60`) that exists only to choose among them.
- `review-dependabot-sweep.md` passes `--no-post` to every reviewer it starts, escalated re-runs included, and carries it forward on a terse request to go again. While the flag is set, its skip-unchanged rule omits only the condition that a clean report requires an approval already on the head. Every other reuse condition stays, and a sweep run without the flag applies the full rule again.
- A reviewer started by a sweep with this flag takes it from its brief, as it would from an invocation, and its return says `Posted: not posted: run with --no-post`.
