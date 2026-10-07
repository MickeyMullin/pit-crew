Tandem mode: two or more agents review the same target independently, and one of them merges the results into the single report that gets posted. This file is loaded by `review-pr.md`, `review-local.md`, and `review-stack.md` when the invocation asks for tandem mode. It changes only what those prompts say it changes; everything else in the calling prompt applies as written.

Roles:

- **Primary**: invoked with `--tandem`. Starts the secondaries, reviews the target, writes its own draft, waits for the secondaries, consolidates, and then carries on with the calling prompt's posting and fix sections using the consolidated report. There is exactly one primary per review. The flag picks the secondaries:
  - `--tandem`: launch the launcher's default secondary (see "Launching secondaries" below).
  - `--tandem=<id>[,<id>...]`: launch these launcher entries instead, e.g. `--tandem=codex` or `--tandem=codex,hermes-kimi`.
  - `--tandem=manual`: launch nothing. The user starts each secondary by hand and tells you when it is done.
- **Secondary**: invoked with `--tandem-secondary`, or `--tandem-secondary@<sha>` to pin the commit (see "Same target" below), when started by hand; or started headless by the launcher (see "Launched secondaries"). Reviews the target and produces one draft. That is the whole of its job.
- **Remove the flag from the invocation before resolving the target.** `805 --tandem=codex` names PR 805; the flag is not part of a branch name or a PR number.
- **Your reviewer id** names your draft. For a primary, and for a secondary started by hand, it is the name of the agent you are running as, capitalized: `Claude`, `Codex`, `Hermes`. For a launched secondary it is the launcher entry id, such as `codex`. It is used only in file and worktree names, never in any report text.

What a secondary may do:

- Run the calling prompt's review in full: target resolution, scope, required passes, citation rules, response format.
- Write exactly one file, its draft (see "Files" below), plus the throwaway worktree the calling prompt already permits.
- **Nothing else.** A secondary never posts anything to GitHub, in any form, whatever the verdict or authorship. It never enters fix mode, never edits a file under review, never commits, and never pushes. Under `review-local.md` it never makes the WIP commit. Under `review-stack.md` it does not offer to post. Every section of the calling prompt about posting, fixing, handing off, or offering outcomes is skipped entirely.
- Omit the `Fix attempts:` line from the draft. That count belongs to the primary's consolidated report and is the primary's to maintain.
- End the chat response by naming the draft's path, the verdict the findings would produce (approve, request changes, comment, or for `review-local.md` the readiness recommendation), and that nothing was posted.
- Remove the worktree when the draft is written, as the calling prompt describes.

Launched secondaries:

A secondary can also be started headless by `{{HOME}}/agents/bin/tandem-secondary`, which says so at the top of its instructions. A launched secondary runs read-only and offline, so the launcher does for it everything that needs GitHub or a write. These rules replace the ones above and below wherever they conflict:

- **The worktree already exists**, pinned to the code under review, and its path is in your instructions. Review there. Do not create, fetch into, or remove a worktree, and do not run the calling prompt's worktree setup or cleanup.
- **Do not run `gh` or `git fetch`.** You have no network access and both will fail. The launcher's context file holds what the calling prompt would otherwise read from GitHub: the repository, the PR's metadata and description, its author, base and head, its CI check status, the stack object, and whether the code still merges cleanly with its base (`git merge-tree` cannot run in the sandbox, so the launcher runs it). Use the file wherever the calling prompt says to call `gh`. If the review needs something the file does not hold, do not guess: say in the closing notes' validation bullet what could not be checked and why.
- **Do not write the draft.** You cannot, and you do not need to. Your final message is the draft: the complete report, beginning with its `Reviewed commit:`, `Reviewed stack:`, or `Reviewed tree:` line, with nothing before or after it. The launcher writes it to the suffixed path after checking it.
- **Read the prior report as usual.** Reading `{{HOME}}/agents/output/` works; only writing is blocked.
- **A repo check that needs to write** (a cache, a build directory) may fail under the sandbox. Note the failure in the validation bullet; do not work around it.
- **Never start another secondary.** The launcher refuses to run inside a secondary, but do not try.

Launching secondaries (primary only):

Unless the flag was `--tandem=manual`, the primary starts its secondaries itself with `{{HOME}}/agents/bin/tandem-secondary`, one run per secondary. `tandem-secondary --list` shows the entries and which is the default.

- **Launch after setup and before your own review.** First do everything the calling prompt does before reviewing: resolve the target, fetch, create the worktree (or, with no named target, settle on the current checkout), record the short tip SHA, and record your start time. For `review-local.md`, compute the `Reviewed tree:` hash now, since it is the pin. Only then launch, so the secondary reviews exactly what you will.
- **The command**, with every value resolved:

```
{{HOME}}/agents/bin/tandem-secondary --mode pr|local|stack --target <target> --sha <short-sha or tree hash> --worktree <path> --draft <unsuffixed report path with -<id> before .md> [--entry <id>]
```

  - `--target`: the PR number for `pr`; the stack number or the PR number you resolved it from for `stack`; the branch name for `local`.
  - `--worktree`: your worktree, or the checkout itself when you are reviewing in place (always, for `review-local.md`).
  - `--draft`: for example `{{HOME}}/agents/output/PR-805-codex.md`. Name it with the entry id, not the agent name.
  - `--entry`: one run per id named in `--tandem=<id>,...`. Omit it for a bare `--tandem` and the launcher uses its default; read the id it chose from its summary line.
- **Run it in the background and do not wait for it before starting your own review.** A real review takes minutes. Use your environment's way to start a command in the background and be told when it exits. If your environment has none, do not run it in the foreground: fall back to `--tandem=manual`, say so, and give the user each secondary's invocation to start by hand.
- **Leave the reviewed code alone until every launched secondary has exited.** It is reading the same worktree, or for `review-local.md` the same live tree. Do not remove the worktree, check anything out in it, or, under `review-local.md`, make the WIP commit or edit any file.
- **The launcher's last line of output is its verdict**: `tandem-secondary: ok ...` or `tandem-secondary: failed ... reason=<why>`, with the draft and log paths. Read that line; do not judge by exit code alone.
- **On `failed`, never consolidate silently without that secondary.** Tell the user the entry, the reason, and the log path, and ask whether to consolidate without it, re-run it, or start it by hand.
- Do not start a secondary for the re-review after a fix; that review is yours alone (see "Consolidating").

Files:

- Each reviewer, primary included, writes its draft to the calling prompt's report path with `-<reviewer id>` inserted before `.md`:
  - `review-pr.md`: `{{HOME}}/agents/output/PR-<number>-<reviewer id>.md`
  - `review-local.md`: `{{HOME}}/agents/output/local-<branch>-<reviewer id>.md`
  - `review-stack.md`: `{{HOME}}/agents/output/STACK-<number>-<reviewer id>.md`
- **These names are case-insensitive on macOS.** `PR-805-codex.md` from the launcher and `PR-805-Codex.md` from Codex started by hand are the same file. Do not run the same agent both ways in one review.
- Overwrite a draft left by an earlier tandem run. Drafts are working material and are never posted.
- **Only the primary writes the unsuffixed report path**, and only with the consolidated result. That file is the one that gets posted, carries `Fix attempts:`, and serves as the prior report for the next run.
- **A suffixed draft is never a prior report.** When the calling prompt looks for a prior report, including any near-match search of `{{HOME}}/agents/output/`, ignore any file whose name carries a reviewer-id suffix after the PR number, stack number, or branch (`PR-805-Codex.md`, `PR-805-codex-xhigh.md`). A draft may hold findings the consolidation rejected, and treating it as history would resurrect them.
- Add `-<reviewer id>` to the worktree directory name too, so two reviewers starting in the same second cannot collide: `{{HOME}}/agents/worktrees/<repo>-<branch>-<timestamp>-<reviewer id>`. Launched secondaries share the primary's worktree and create none.

Same target:

- Every draft must describe the same code, or merging them produces citations that do not match anything. The primary enforces this; a secondary makes it checkable.
- **`review-pr.md` and `review-stack.md`**: the draft's first line is already `Reviewed commit:` or `Reviewed stack:` with the short tip SHA. A secondary invoked with `--tandem-secondary@<sha>` creates its worktree at that SHA instead of `origin/<branch>` (fetch first; if the SHA is not reachable, stop and say so), and says in chat if the branch tip has moved past it.
- **`review-local.md`**: the tree includes uncommitted work, so a SHA alone does not identify it. Every draft, and the primary's own, begins with a `Reviewed tree:` line carrying the branch, the short HEAD SHA, and the output of `git diff HEAD | git hash-object --stdin`, taken at the start of the review. This hash does not cover the contents of untracked files; say so if the review relied on one.
- Record the time you started, in UTC, as the first thing you do. The primary uses its own start time to reject stale drafts.

Consolidating (primary only):

- Write your own draft first, then wait for the secondaries. For a launched secondary, wait for its launcher to exit and read its summary line, as described under "Launching secondaries". For one started by hand, say which you are waiting for, name the path it will write, and wait for the user to tell you it is done. Never poll the directory in a loop.
- **When a secondary is done, check its draft before reading its findings**, even when the launcher already validated it. It must exist, have been modified after your recorded start time, and carry the same `Reviewed commit:`, `Reviewed stack:`, or `Reviewed tree:` value as your own draft. If any check fails, stop and say which one, and ask whether to proceed without that draft or re-run it. Never consolidate drafts of different code.
- **Merge by root cause, not by title.** Two findings describing the same defect through different symptoms or different citations become one finding. Keep the clearer explanation, and combine the triggering scenarios when each adds something.
- **Every finding raised by only one reviewer is verified against the code before it goes in or comes out.** A secondary's finding does not enter the report on the secondary's word, and it is not dropped because you missed it. If you had considered the same code and dismissed it, re-examine it: keep the finding unless you can name the specific code that refutes it.
- **On a priority disagreement, take the higher priority** unless you can refute the higher one with code. Consolidation must never lower a finding into a rank that selects a lighter posting form; the calling prompt's rule against ranking a finding P3 because P3 approves applies here with the same force.
- **Re-derive every citation from a fresh read**, under the calling prompt's citation rules. A secondary's report is another numbering source you did not produce; treat its line numbers as untrustworthy, exactly like a diff hunk.
- **Apply the calling prompt's required passes to any recommended fix you merge or rewrite.** A merged recommendation is a new recommendation.
- Merge the closing notes: the union of the validation actually performed (inspected CI, gates run, required passes), with no claim of work neither reviewer did. Keep one merge recommendation, derived from the consolidated findings.
- **The consolidated report reads as one review.** It does not mention tandem mode, the number of reviewers, which reviewer found what, which findings were dropped, or any agent or model name. The no-attribution rule in the calling prompt's output section applies to it in full.
- Report the consolidation to the user in chat instead: which findings came from which draft, which were merged, which were dropped or re-ranked and why, and any finding you first dismissed and then kept. Chat is where attribution belongs; the report is not.
- Write the consolidated report to the unsuffixed path, then continue with the calling prompt from its posting section (for `review-local.md`, from "Fixing what you found"). The verdict, the posting form, the CI gate, the authorship checks, fix mode, and the `Fix attempts:` bound all run on the consolidated findings exactly as they would on a single review.
- **In fix mode, the re-review after fixing is a single-agent review by the primary.** Tandem mode covers the first review only. Say so in chat, so the user can run another tandem round instead if they want one.
- Remove your worktree only after the consolidated report is written and posted or declined, as the calling prompt describes. You need it for the fresh citation reads above.
