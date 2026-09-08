Perform a PR-quality code review of an entire stack of PRs as one cumulative tree, rather than layer by layer.

This prompt is the companion to `review-pr.md`. Use this one to answer "does the end state of this stack work?"; use `review-pr.md` to answer "does this single layer stand on its own?". They are different questions and several rules below are deliberately the inverse of that prompt's.

Setup:

- Take the stack identity from the user: a stack number, or any PR number in the stack. Resolve the whole stack with `gh api "repos/{owner}/{repo}/stacks?pull_request={number}"`, which returns the ordered list of PRs bottom to top plus the stack's trunk target in `base.ref`.
- If the user gives no identity at all, list the repo's stacks with `gh api repos/{owner}/{repo}/stacks --jq '.[] | "\(.number)\t\(.open)\t\(.pull_requests|map(.number)|join(\",\"))"'` and ask which one, unless exactly one is open.
- A stack object carries both a `number` and an `id`. Use `number` everywhere in this review — it is the repo-scoped identifier the UI shows, drawn from the same sequence as PRs and issues (so it appears as a "missing" PR number). `id` is a global database key and is not useful in a report.
- The stack is linear: the top layer's head branch already contains every layer below it. **Check out the top layer's head branch** — not the bottom, and not the trunk. That branch is the cumulative tree, and it is the only checkout this review needs.
- `git fetch origin` first, then check out the top layer's head branch fresh from the remote. Do not review a stale local copy; a rebase cascading up from a lower layer moves every branch above it.
- Before reviewing anything, record the short SHA of the checked-out tip (`git rev-parse --short HEAD`). Note it up front and use it as the `<ref>` in every citation URL. This is also what makes a later re-review cheap: the next run can diff its own HEAD against the SHA recorded in the prior report.
- Verify the stack is coherent before trusting the tip as "the whole stack". For each layer's head SHA from the stack object, confirm it is an ancestor of the tip: `git merge-base --is-ancestor <layer-sha> HEAD`. If any layer is not an ancestor, the stack is mid-rebase or has diverged — stop, report exactly which layers are detached, and do not present the review as covering the stack.
- Resolve the review base as the merge base with the stack's trunk: `git merge-base origin/<trunk-ref> HEAD`, where `<trunk-ref>` is the stack object's `base.ref`. Every diff, every gate invocation, and every "is this new?" judgment in this review uses that merge base, never an individual PR's `base.ref`.
- Check whether the tip still composes cleanly with the latest trunk.

Triage before reading (do this first, it decides where the effort goes):

- Pull each layer's size and title (`gh api repos/{owner}/{repo}/pulls/{n} --jq '...'`) and sort the layers into three buckets. Report the bucketing in the closing notes so the reader can see what got depth and what did not.
- **Full review**: layers that change runtime behavior, schema, routes, auth, or move large amounts of production logic. These get the complete priority list below.
- **Claim verification**: layers whose PR asserts a mechanical no-op ("zero plan diff", "byte-identical", "pure move", "lossless dedup"). Do not read these line by line. Verify the assertion instead — normalized diff, file-content hashing before and after the move, or a count of test cases removed versus re-homed. A claim that holds ends that layer; a claim that fails is a finding at the priority its real impact warrants.
- **Additive-only skim**: layers that add tests, gates, or CI config and touch no production file. Read these only against priority 7 (tests that provide false confidence). A new gate that cannot fail, or a suite whose assertions pass against a deliberately broken implementation, is the finding to look for here.
- A layer that ships a migration _and_ the code that reads what it creates is a deploy-ordering question, not just a migration question. Check statically whether the deploy pipeline applies migrations before the application rolls, and whether the new objects are additive (safe to apply ahead of the app) or replace something the currently-deployed app still reads. Runtime verification is out of scope; the ordering guarantee in the pipeline config is not.
- Migrations are never mechanical. Any layer adding or altering a migration is a full review regardless of size, and the review must check ordering across layers: whether a later layer's migration assumes an earlier layer's migration has been applied, and whether the sequence is safe when the stack merges as one tree.

Scope:

- Review the cumulative diff against the merge base, not any individual layer's diff, and not only the most recent commits.
- **This is the inverse of `review-pr.md`'s rule about lower layers.** Cross-layer defects are the entire reason this review exists. A seam introduced in an early layer, consumed incorrectly in a middle layer, with a caller left unmigrated in a late layer, is invisible to every per-layer review and visible only here. Actively hunt for that shape.
- Specifically look for: callers left pointing at a pre-refactor API that still exists; a shape or type that two layers define differently; a helper extracted in one layer and re-implemented in another; config or env keys renamed in one layer and still read by the old name elsewhere; dead code that the stack orphaned but did not delete.
- Trace every seam the stack introduces to all of its consumers across the whole tree. Grep for the pre-refactor symbol names across the tip to find the stragglers — a refactor that is "complete" per its own layer is often incomplete per the tree.
- Inspect relevant callers, schemas, APIs, tests, workflows, and surrounding code needed to understand the changes.
- **Attribute every finding to the layer that introduced it.** A finding the reader cannot act on is worth much less: they need to know which PR to push the fix to. Use `git log --oneline -S'<distinctive string>' <merge-base>..HEAD` or `git blame` on the cited lines, then map the commit back to a layer by branch. State the layer as "introduced in #NNN (Stack NN)". If a finding emerges from the interaction of two layers and belongs to neither alone, say so and name both.
- Do not modify files, commit, or push. The only permitted GitHub write is posting the finished report as a single PR comment, exactly as described under "Output file" — no inline review comments, no approvals, no edits to any PR body.
- **The fix mode that `review-pr.md` and `review-local.md` have is deliberately not available here, and must not be improvised.** Those prompts may fix their own findings; this one may not, on any stack, under any authorship, however mechanical the fix looks. A stack is an ordered set of dependent branches: a fix belongs in the layer that introduced the problem, changing that layer invalidates every layer above it, and restacking is a rewrite of branches that may already be pushed and reviewed. That is not a one-pass automatic operation. Report the findings and let a human decide where each fix belongs. If asked to fix something during a stack review, say that this prompt does not do that, and point at `review-pr.md` run against the specific layer instead.
- Do not run builds or tests unless explicitly requested. You may inspect existing CI results, and should note whether the stack's own canary or integration branch (if one exists) is green.
- **Run the repo's comment-length check — it is exempt from the "no builds or tests" rule above.** `scripts/check-comment-length.mjs` (the `pnpm check:comments` gate) needs no build and is strictly read-only: it shells out only to `git diff --name-only`, `git ls-files --others`, `git blame`, `git rev-list`, and `git config`. It never writes, stages, or checks anything out, so it is safe to run against any working tree.
- Scope it to the stack's authors, not to yourself. Its default scope attributes blocks to the local `git config user.email` — the reviewer's. Collect the distinct author emails across the whole stack (`gh api repos/{owner}/{repo}/pulls/{n}/commits --jq '.[].commit.author.email'` over the layers, deduped) and run `COMMENT_AUTHOR=<email> node scripts/check-comment-length.mjs <merge-base>` once per email, or fall back to `COMMENT_SCOPE=all`.
- Pass the merge base resolved above as `<base-ref>`. Do not let it fall back to the script's `origin/main` default unless that is genuinely the stack's trunk.
- `COMMENT_SCOPE=all` never misses a block, but it reports every long block in every touched file, including pre-existing ones that are not this stack's problem. Untracked files also count in full under any scope. Whichever scope you use, confirm a flagged block is actually added by the cumulative diff before reporting it.
- Exit 1 means violations; exit 2 means the check could not run (no git email, unfetchable base). Exit 2 is a tooling problem on your side — fix the invocation or say the check did not run, never report it as a finding.
- Check for a pre-existing report from a prior run before starting (see "Output file" for the name). If one exists, read only its first ~80 lines first — that covers the `## Summary` index, which is enough to enumerate the previous findings. Read a specific finding's full section only when the summary line is too terse to tell what to re-verify.
- **If the file is absent, fall back to the PR comments before concluding there is no prior run.** Treat the comment thread as a partial history only: under "Output file" a report is posted automatically only when the verdict is "approve" *and* the top PR is not yours, and otherwise only if the user said yes when asked. An absent comment therefore means nothing on its own — a prior run may have found plenty and simply not been asked to post it. The file, which is written every run regardless of verdict, is the complete record. It is normally present regardless of which clone or worktree this runs from — output always lives at the fixed path `{{HOME}}/agents/output/`, not anywhere repo-relative — so an absent file means a genuinely different environment: another machine or a headless/cloud run.
- Resolve the current reviewer's login with `gh api user --jq '.login'`, then fetch the top PR's comments with `gh api repos/{owner}/{repo}/issues/<top-pr>/comments --paginate`. Take the **most recent** comment that is both authored by that login and begins with the `Reviewed stack:` marker line. Other people and bots comment on these PRs — an unfiltered "latest comment" is the wrong thing to read, and a report from a different reviewer carries triage decisions and finding ids that this run did not make and cannot verify.
- If no comment matches both filters, there is no usable prior run: do a full cold review and say so. Do not fall back to a comment that matches only one of the two filters.
- Read the prior `Review state` block from whichever source you found, and treat its `tip_sha` and `base_sha` as the inputs to the scoping rules below. If both a local file and a PR comment exist and their `tip_sha` values disagree, prefer the **file**: the write happens before the post, so a newer file means the previous run wrote its report but failed to post it. Say so in the closing notes — that prior report never reached the PR, and the reader may want it posted.
- Scope the re-review from the prior report's `Review state` block (see "Output file"). Which path you take depends on whether the stack was restacked since that run — test it with `git merge-base --is-ancestor <prior-tip-sha> HEAD`.
- **Fast-forward case** (prior tip is an ancestor, i.e. commits were only added on top): use `git diff <prior-tip-sha>..HEAD` and `git log --oneline <prior-tip-sha>..HEAD`. Concentrate on what changed, but still confirm the unchanged areas remain consistent with the prior conclusions rather than assuming them.
- **Restack case** (prior tip is not an ancestor — a fix landed in a lower layer and rewrote every SHA above it, or layers merged and the trunk moved): do **not** diff the two tips against each other; that output is dominated by rebase noise and is unusable. Use `git range-diff <prior-base-sha>..<prior-tip-sha> <current-base-sha>..HEAD` instead, where the base SHAs are the recorded and freshly-resolved merge bases. Range-diff pairs up equivalent commits across the two histories and shows only where their content genuinely differs — that difference is the actual re-review surface.
- After a restack, distinguish layers that were _edited_ from layers that were merely _rebased_. A layer whose head SHA changed but whose patch content did not needs no re-reading. Compare the recorded per-layer head SHA against the current one, and where they differ, check whether the content actually moved (`git patch-id`, or the range-diff pairing above). Say in the closing notes which layers were edited and which only shifted, so the reader can see the re-review was scoped and not merely asserted to be.
- **If layers have merged since the prior run**, the stack has shrunk and the trunk has advanced. Re-resolve the stack from the API rather than trusting the recorded layer list, note which layers are now merged, and re-resolve the merge base — the cumulative diff now covers less ground than it did, and code that was in scope last run may now be in the trunk. Do not re-report findings against code that has merged: those are trunk findings now, and belong in a follow-up PR rather than in this stack's review.
- **A carried-forward finding attributed to a merged layer is not actionable as written.** The author cannot push a fix to a merged PR. When an unresolved finding's layer has merged, re-attribute it: say it was introduced in #NNN (now merged) and that the fix needs a new PR against the trunk, or against the lowest still-open layer that touches the same file. State which.
- Carry forward the prior run's triage where the evidence still holds. A layer whose content did not move and whose mechanical-no-op claim was verified last run does not need that claim re-verified — record it as carried forward, with the run it was verified in. Re-verify from scratch any layer whose content changed.
- If previous findings exist, explicitly verify whether each one is resolved, and classify each as resolved, partially resolved, unresolved, or no longer applicable (with a one-line reason). Carry any still-unresolved finding forward into this run's Findings section as a fresh finding with re-derived citations — do not simply reference the old report.
- If you build a combined diff, patch file, or any other scratch artifact to make the review easier to read, treat it as disposable working material only — use it to _locate_ changes, never as the source of a line number you report. See citation rules below.

Output file:

- After completing the review, write the full response (Summary, Findings, and closing notes, verbatim) to `{{HOME}}/agents/output/STACK-<number>.md`, where `<number>` is the stack's repo-scoped `number` (not its `id`), in addition to printing it in chat.
- Overwrite the file if it already exists from a prior run. Because overwriting destroys the prior report, do the prior-report read described under "Scope" before you write.
- Begin the file (and the chat response) with a `Reviewed stack:` line carrying the stack number, the top layer's branch, and its short tip SHA.
- End the file with a `## Review state` section containing a fenced ```json block, wrapped in `<details><summary>Review state (for the next run)</summary>` so it stays collapsed in the PR comment. A tip SHA alone is not enough to scope a re-review after a restack. Record:
  - `stack`, `tip_branch`, `tip_sha`, `base_sha` (the merge base this run diffed against), and `reviewed_at`
  - `layers`: for each layer, its PR number, head SHA, state (open/merged), triage bucket, and — for claim-verification layers — the claim verdict and the tip SHA it was verified at
  - `findings`: for each finding, a stable id, priority, one-line title, and attributed layer(s), so the next run can match them up without re-reading the prose
- Keep the block accurate even when it is tedious: it is the only thing that makes the next run cheap, and a wrong `base_sha` sends the next run's range-diff into noise.
- Once the file write has completed — and only then, never before it and never concurrently with it — post the same report as a single comment on the **top layer's PR** with `gh pr comment <top-pr-number> --body-file {{HOME}}/agents/output/STACK-<number>.md`. The top PR is the one place a reader of the whole stack will look. Do not post it to every layer.
- **Do not post automatically when the merge recommendation is "fix before merge" or "do not merge".** Write the file as always, print the report in chat as always, then say the report was not posted and ask whether to post it to the top PR. Wait for an explicit yes, then post with the command above.
- The reason is the same for both verdicts: each one means the stack is expected to change before it merges, so posting unprompted publishes a list of problems against work that is still moving, and pins it to a top PR whose SHAs the fixes will invalidate. It also puts a public verdict on someone's stack before its author has had a chance to read it. Neither verdict is less actionable than the other; both are simply premature to broadcast.
- **"approve" posts automatically only on a stack that is not yours.** It is a durable record that the stack was reviewed and found sound, it does not go stale the way a findings list does, and there is nothing in it for the author to respond to first — but none of that is worth anything when the author is you, because the comment then tells you what you are already reading while adding noise to a thread other people have to scan.
- **Determine authorship of the top layer's PR before posting anything automatically.** Compare `gh api user --jq '.login'` against `gh pr view <top-pr-number> --json author --jq '.author.login'`. The top PR is the only one this review ever comments on, so it is the only authorship that decides this. Never infer it from the checked-out branch: this prompt checks out the top layer's head branch as a matter of course, so having it checked out says nothing about who wrote it.
- If the top PR is yours and the verdict is "approve", **do not post.** Write the file as always, and say in chat that the stack was reviewed, found sound, and not commented on, naming the stack number, the tip SHA, and where the file was written.
- Taken together: **on your own stack this review never posts on its own initiative**, for any verdict. On someone else's, an approve posts and the other two verdicts still ask first. Either way the file is written every run.
- One case deserves a word rather than a silent decision: a stack whose top PR is yours may still contain layers written by other people, and an approve is the one verdict they might want on the record. When the stack has layers by other authors, say so when you report the clean result and offer to post it — then post only if the user says yes.
- **None of this adds a fix mode.** The authorship check here decides one thing only: whether an approve is posted. It never licenses fixing, committing, or pushing on a stack. That prohibition is absolute and is stated above.
- If a finding is attributed to a specific lower layer, that attribution lives in the report text. Do not post separate per-layer comments; a stack-wide review posted 26 times is noise.
- If `gh pr comment` fails, do not retry it and do not attempt any alternative posting path. State plainly in the chat response that posting the comment failed, include the error, and say the report is saved at `{{HOME}}/agents/output/STACK-<number>.md` for manual posting.

Review priorities:

1. Correctness and behavioral regressions
2. Cross-layer integration defects: unmigrated callers, divergent shapes, orphaned code, seams with a straggler consumer
3. Data loss, stale state, race conditions, error handling, and partial failures
4. Security, authorization, secrets, and environment isolation
5. Production deployment and rollback safety, including migration ordering across layers
6. API/schema compatibility and incorrect assumptions about data
7. Accessibility and keyboard behavior
8. Tests that provide false confidence or fail to exercise the behavior they claim to cover — including gates that cannot fail and dedups that dropped a case
9. Mechanical-no-op claims that do not hold
10. Maintainability issues only when they create a concrete future failure risk
11. Comment blocks this stack adds that exceed the repo's enforced 500-character limit (P3)

Note what is _not_ in this list: layering violations, and whether an individual layer stands alone. Those belong to `review-pr.md` and are out of scope here — this review treats the stack as one merge.

Review standards:

- Report only actionable findings supported by specific code.
- Trace changed values through their consumers rather than reviewing files in isolation. Across 20+ layers this is the difference between a useful review and a summary of commit messages.
- Consider realistic runtime scenarios and failure paths.
- Do not report speculative style preferences.
- Do not flag an issue merely because the implementation is unusual; verify that it can cause incorrect behavior.
- Avoid repeating issues already fixed by a later layer in the stack. A defect introduced in an early layer and corrected before the tip is not a finding — the tree is what merges. Mention such a sequence only if the intermediate state is itself dangerous (e.g. a migration that would leave the database wrong if the stack lands in parts).
- A comment block over the limit is **not** a style preference, and is not subject to the "concrete future failure risk" filter that applies to maintainability findings: it is an enforced repo standard with a command that exits non-zero. Report every confirmed violation as P3, citing the file and the block's first line.
- Recommend the fix as trimming the comment to what a reader of that code needs, and moving failure narratives, measurement history, and rollout reasoning into the PR description. Never recommend raising `COMMENT_MAX_CHARS`.
- The standard covers `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.sql`, `.py`, and `.sh` only. Do not flag a long comment in `.tf`, `.yml`/`.yaml`, or `.md` — those are outside the standard, and `infra/modules/platform/*.tf` carries 50-line headers by design. Long _pre-existing_ blocks are also out of scope; only blocks the cumulative diff adds count.
- Explain the triggering scenario, user/production impact, and an appropriate correction.
- Break each finding's explanation into a few short paragraphs where it aids clarity — e.g., separate the triggering scenario from the impact from the recommended fix. Don't write a single dense wall-of-text paragraph, and don't fragment into a new paragraph per sentence; aim for a happy medium (roughly 2-4 short paragraphs for a finding with enough content to warrant it, one paragraph is fine for a simple finding).
- Rank findings:
  - P0: immediate catastrophic/security impact
  - P1: serious production correctness, security, data-loss, or deployment blocker
  - P2: meaningful defect affecting a subset of users or scenarios
  - P3: lower-risk quality, maintainability, or testing weakness

Citation rules (follow exactly — line-number errors here have caused false citations before, and a cumulative diff across many layers makes them far more likely):

- Every file:line reference must come from a fresh, direct read of the real file at its real path (Read tool, or `grep -n` / `sed -n` against the actual path on disk) taken immediately before you write the citation down. Never reuse line numbers you saw earlier from a concatenated diff, a `git diff` / `git show` patch, a Read of a scratch/tmp file, or from memory of an earlier tool call in the conversation — those numbering schemes do not match the source file.
- Treat any number that came from a diff hunk, a patch file, or a combined review artifact as untrustworthy for citation purposes even if it looks plausible, even if the surrounding content matches. Re-derive it from the real file before it goes in the report.
- Immediately before finalizing the report, re-open (or re-grep) every cited file at its cited range and confirm the quoted line(s) actually contain the content you're describing. If a file is shorter than the cited line number, or the content doesn't match, fix the citation — do not soften or hedge it, correct it.
- Format every citation as a Markdown link whose visible text is the repo-relative path + line range, and whose target is the full clickable GitHub blob URL: `[/<path>#L<start>-L<end>](https://github.com/<owner>/<repo>/blob/<ref>/<path>#L<start>-L<end>)`. The link text must NOT repeat the `https://github.com/<owner>/<repo>/blob/<ref>/` prefix — that noise belongs only in the URL, not the visible label. Use the short tip SHA recorded at the start of the review as `<ref>` by default — only use a branch name or a PR-relative diff link if the user asks for that form specifically.
- Never place a citation link inline in a sentence or run two citation links back-to-back in the same line — Markdown collapses adjacent links into an unreadable run-on with no visual separation, especially with long GitHub URLs. Every citation stands on its own bullet line, even when a finding cites only one file. A one-line parenthetical after a link (e.g. quoting the exact code, or naming which side of a comparison it is) is fine on that same bullet line — just never two links sharing a line.
- When a finding cites more than one file/range, list them as a Markdown bullet list (`- [...]`) directly under the explanation prose, not woven into the paragraph. Do not end the lead-in sentence with a bare trailing colon and a wall of un-bulleted links.
- Prefer the built-in Read tool (with `offset`/`limit`) and the Grep tool for citation verification — they are not permission-gated and are the fastest path. Use Bash only when neither fits.
- When you do use Bash for verification, issue plain single commands (e.g. `sed -n '541,546p' path/to/file.py`) or a straight `;`-separated list of them. Avoid shell constructs (functions, `for`/`while` loops) that bundle multiple commands into one — some agent execution environments cannot evaluate or pre-approve commands bundled this way. See `claude-code-notes.md` if you are running as Claude Code.

Use this response format:

Reviewed stack: `<stack-number>` — `<top-branch>` @ `<short-sha>` (<N> layers, #<lowest>–#<highest>)

## Summary

A terse, bulleted list of every finding, grouped by priority (P1s first, then P2, P3...) and ordered by severity within each group. One line per finding: the concise title/claim, the affected file(s), and the layer it is attributed to — no explanation, no citation link. This must mirror the Findings section exactly (same findings, same order, same count) — it is a scannable index, not a separate pass.

- **P1**
  - Terse finding title (file.ts, other-file.py) — #NNN
- **P2**
  - Terse finding title (file.ts) — #NNN, #MMM

If there are no findings, say "No actionable findings." and omit the rest of this section.

## Findings

**[P1] Concise finding title** — introduced in #NNN (Stack NN)

Explanation with the triggering scenario, impact, and recommended correction, per the citation formatting rules above.

- [/path/to/file.py#L241-L252](https://github.com/<owner>/<repo>/blob/<ref>/path/to/file.py#L241-L252)
- [/path/to/other-file.ts#L535-L536](https://github.com/<owner>/<repo>/blob/<ref>/path/to/other-file.ts#L535-L536) (short parenthetical is fine here, on the same line as this one link)

**[P2] Concise finding title** — emerges between #NNN and #MMM

Explanation...

- [/path/to/file.ts#L75-L77](https://github.com/<owner>/<repo>/blob/<ref>/path/to/file.ts#L75-L77)

If there are no findings, say:

## Summary

No actionable findings.

## Findings

No actionable findings.

Finish with:

---

- Merge recommendation for the stack as a whole: approve, fix before merge, or do not merge
- Whether any P1/P2 findings remain, and which layers they land in — a reader deciding whether to merge the lower half of the stack today needs to know if the blockers are all near the top
- Layer triage: which layers got a full review, which got claim verification (and whether each claim held), which got an additive-only skim, and which were carried forward unchanged from a prior run
- Previous findings, only if a prior report was found: state the short SHA it reviewed, whether this run took the fast-forward or restack path, which layers were edited versus merely rebased, and the per-finding resolved/partially resolved/unresolved/no-longer-applicable verdicts. Don't name the report file or its directory, and don't mention incidental/OS-specific files (e.g. `.DS_Store`) found while checking — none of that is useful to the developer or a future re-review. Omit this bullet entirely when no prior report exists.
- Stack coherence: whether every layer's head was an ancestor of the reviewed tip, and whether the tip is conflict-free with the latest trunk
- What validation was performed, clearly distinguishing inspected CI (including any canary branch) from locally run tests/builds
