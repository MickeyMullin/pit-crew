Perform a PR-quality code review of all commits on the currently checked-out local branch.

Scope:

- Identify the active branch and associated GitHub PR.
- Before reviewing anything, record the short SHA of the branch's tip commit (`git rev-parse --short HEAD`). Note it up front and use it as the `<ref>` in every citation URL, so the report is pinned to the exact commit reviewed. This is also what makes a later re-review cheap: the next run can diff its own HEAD against the SHA recorded in the prior report.
- Determine whether the PR is part of a stack by checking the PR resource's `stack` field (e.g. `gh api repos/{owner}/{repo}/pulls/{number} --jq '.stack'`), not by inspecting the base branch — a bottom-layer PR targets the default branch just like a standalone PR, so the base alone can't distinguish them. A `null` value means this is a standalone PR; skip the stack-specific steps below.
- If the PR is part of a stack, read its position and size from the `stack` object, and read its immediate base branch from the PR's own `base.ref` (the layer directly below it, not `stack.base.ref`, which is the stack's ultimate trunk target).
- If the PR is part of a stack, also resolve the full stack via `gh api "repos/{owner}/{repo}/stacks?pull_request={number}"` to get the ordered list of PRs bottom to top. Note the PR directly above this one (if any) and its number/branch in the closing notes — this review does not cover that PR's diff, but a consumer existing one layer up is useful context for judging whether this layer's public surface (exports, schema, API shape) is being changed in a way that's likely to break it.
- Compare the branch against the latest remote PR base using the merge base. For a stacked PR, "PR base" means the current base branch identified above, re-resolved fresh — do not assume it is `main`/`master`, and do not reuse a base ref you resolved earlier in a prior run, since a rebase cascading down from a lower layer can move it between reviews.
- Review the complete branch diff, not only the most recent commit.
- Inspect relevant callers, schemas, APIs, tests, workflows, and surrounding code needed to understand the changes. For a stacked PR, this includes code introduced by lower layers in the stack when it's a direct caller or dependency of this layer's changes.
- Check whether the branch still composes cleanly with the latest base branch.
- If the PR is stacked, check for layering violations: any place this layer's diff depends on code, types, schemas, or config that exists only in a branch above it in the stack (or doesn't exist in this branch or any branch below it). This is a correctness defect, not a style note — it means the layer cannot stand on its own if merged up to that point in the stack.
- Check for a pre-existing report from a prior run before starting the review. Look in `{{HOME}}/agents/output/` for the file this run would write to (see the naming rules under "Output file" — PR number first, e.g. `{{HOME}}/agents/output/PR-482.md`, falling back to the sanitized branch name). If the exact name is absent, list the directory and look for a near match on the PR number or branch before concluding there is none.
- If a prior report exists, read only its first ~80 lines first — that covers the `## Summary` index, which is enough to enumerate the previous findings without pulling a long Findings section into context. Read the specific finding's full section only when the summary line is too terse to tell what to re-verify, and prefer grepping the report for a file path over reading it end to end.
- If the prior report records the commit SHA it reviewed, use `git diff <prior-sha>..HEAD` and `git log --oneline <prior-sha>..HEAD` to scope the re-review: concentrate on what changed since, but still confirm the unchanged areas of the diff are consistent with the prior conclusions rather than assuming them.
- If previous findings exist for this branch, explicitly verify whether each one is resolved, and classify each as resolved, partially resolved, unresolved, or no longer applicable (with a one-line reason). Carry any still-unresolved finding forward into this run's Findings section as a fresh finding with re-derived citations — do not simply reference the old report.
- Do not modify files, commit, or push, and do not post anything other than the finished report, once, in exactly one of the three forms described under "Posting the report" — no inline review comments, no second comment restating the verdict, no edits to the PR body, no merges. The verdict is carried by the form the report is posted in, never by a follow-up message. The **one** exception is the fix mode described under "Fixing your own PR", which applies only when the PR's author is you and the review produced findings; it is off by default and you must confirm authorship explicitly before entering it.
- Do not run builds or tests unless explicitly requested. You may inspect existing CI results.
- **Check comment-block length — it is exempt from the "no builds or tests" rule above**, because it is a read of the diff rather than an execution of anything. Flag any comment block this PR adds whose text runs past 500 characters, counting a run of consecutive single-line comments or one block comment as a single block.
- Scope it to this PR's own diff against its real base branch — reuse the base already resolved above, and do not fall back to the repo's default branch, which is the wrong base for a stacked PR. Confirm a flagged block is genuinely added by this PR before reporting it; a long comment that was already there belongs to whoever wrote it.
- If the repo enforces its own comment-length gate and it is read-only and needs no build, prefer running that over judging by eye, and use its limit rather than 500 if the two differ.
- If you build a combined diff, patch file, or any other scratch artifact to make the review easier to read, treat it as disposable working material only — use it to _locate_ changes, never as the source of a line number you report. See citation rules below.

Output file:

- After completing the review, write the full response (Summary, Findings, and closing notes, verbatim) to a file in the `{{HOME}}/agents/output/` directory, in addition to printing it in chat.
- Name the file after the associated GitHub PR number if one exists for this branch, e.g. `{{HOME}}/agents/output/PR-482.md`. If no PR exists yet, name it after the current branch instead, e.g. `{{HOME}}/agents/output/atomic-feedback-lineage.md`.
- When deriving the filename from the branch name, replace any character that is not alphanumeric, `-`, or `_` with `-`, and collapse consecutive `-` into one.
- Overwrite the file if it already exists from a prior run on this branch/PR. Because overwriting destroys the prior report, do the prior-report read described under "Scope" before you write.
- Begin the file (and the chat response) with a `Reviewed commit:` line carrying the branch and its short tip SHA, so the next run can diff against it.
- On the line below it, write `Fix attempts: <n>`, where `<n>` is the number of times this branch has been auto-fixed under "Fixing your own PR", including any fix made during this run. Write `Fix attempts: 0` when no fix has been made. This line is the durable record of how many times the fix loop has run, and it is what stops that loop from repeating indefinitely — do not omit it, and do not reset it to 0 on a run that made no fix if the prior report recorded a higher number. Carry the prior value forward.

Posting the report:

- Once the file write has completed — and only then, never before it and never concurrently with it — post the report to the PR, passing the file that was just written. Outside the fix mode described under "Fixing your own PR", which pushes commits to your own branch, this is the only write this review performs, and it happens exactly once.
- **The verdict is expressed by the form of the post, not by its text.** Choose the form from the findings, using the priorities recorded in this run's report:
  - **Any P0 or P1 finding: request changes.** `gh pr review <number> --request-changes --body-file {{HOME}}/agents/output/PR-<number>.md`
  - **No findings at all, or P3 findings only: approve.** `gh pr review <number> --approve --body-file {{HOME}}/agents/output/PR-<number>.md`
  - **At least one P2, but nothing above it: plain comment.** `gh pr comment <number> --body-file {{HOME}}/agents/output/PR-<number>.md`
- Never post the report as a comment and then say the changes are requested, and never post a review and then repeat the verdict in a separate comment. One post, carrying the whole report as its body. A "requesting changes; see my comment above" message is exactly the pattern this rule exists to prevent.
- **An approval still carries the whole report, P3s included.** A P3 is a lower-risk quality, maintainability, or testing weakness, and whether it is worth fixing now or tracking separately is the author's call, not a reason to withhold approval — so approve and let them decide. Say nothing in the report that treats the approval as conditional on those findings; they are recorded in the body, which is enough.
- What an approval must never do is launder a real defect. Never approve to be agreeable, and never rank a finding P3 because P3 is the rank that approves — the priority comes from the finding's risk, judged before you know which form it selects. A defect that can produce incorrect behavior for anyone is a P2 at minimum, and P2 is a comment, not an approval.
- A request-changes review blocks the PR until a human dismisses or re-reviews it. That is intended: a P0 or P1 is a blocker by definition. Do not downgrade the form to a comment because the author is in a hurry, because CI is green, or because the fix looks easy.
- **Do not post anything when the PR is authored by you**, whatever the review concluded — no comment, no approval, no request-changes. GitHub rejects a self-approval outright, and the rest is noise in a thread other people have to scan. Write the file as normal, then follow "Fixing your own PR". The file write is never skipped; only the post is.
- Skip the post entirely when no PR exists for the branch (the report was named after the branch instead); there is nothing to post to.
- If the `gh` command fails, do not retry it, do not fall back to a different form (in particular, do not downgrade a failed `--request-changes` to a plain comment), and do not attempt any alternative posting path. State plainly in the chat response which form you attempted, include the error, and say the report is saved at `{{HOME}}/agents/output/PR-<number>.md` for manual posting.
- State in the chat response which form was used, so the record of what landed on the PR is visible without opening it.

Fixing your own PR:

This section changes what happens at the end of a review of a PR you wrote. It never applies to anyone else's PR. **Determine authorship on every run, whether or not the review found anything** — it decides both whether findings get fixed and whether the report gets posted at all.

- **Confirm authorship explicitly before anything else here applies.** Compare `gh api user --jq '.login'` against `gh pr view <number> --json author --jq '.author.login'`. Enter this mode only on an exact match. If the two differ, either lookup fails, or the PR is authored by a bot or an org account, this is not your PR: post the report as described under "Posting the report" and stop. Never infer authorship from the branch name, from `git config user.email`, or from the fact that the branch is checked out locally — a reviewer routinely has someone else's branch checked out, which is precisely when a wrong guess would push commits to a PR that is not theirs.
- **If the review produced no findings, do not post anything either — including an approval.** Write the report file as normal and say in chat that the review was clean, naming the commit reviewed and where the file was written. GitHub will not accept an approval from the author, and a comment on your own PR saying "approve, no findings" tells you something you are already reading. The file is the durable record; the chat response is the notification. Nothing else about this section applies to a clean review.
- The rule is therefore simple: **on your own PR, this review never posts on its own initiative** — not for findings, which it fixes instead, and not for a clean result, which it reports in chat. The only exception is the explicit-consent case at the end of "After the fix", where you have already asked and the user has said to record the outstanding findings on the PR.
- Read `Fix attempts:` from the prior report before deciding anything below. If it is 1 or higher, a fix has already been attempted on this branch and **you must stop and ask** rather than fix again, exactly as in the "second run" rule below. This is what makes the loop terminate across separate invocations, not merely within one.

Deciding whether to fix:

- Before fixing anything, assess whether the current model and effort level are appropriate to the findings you just recorded. State the assessment and its reasoning in chat before acting on it. This is a judgment call, so make it explicitly rather than defaulting to "yes".
- Proceed with the fix when the findings are ones you can resolve completely and verify: a wrong conditional, a missing null guard, an off-by-one, an unhandled error path, a stale comment or doc, a missing test case, a mechanical rename left half-applied, an obviously incorrect type.
- Stop and ask when a finding needs judgment the current setting is not suited to: a concurrency or ordering defect whose fix depends on the surrounding execution model; a security or authorization flaw where a wrong fix looks correct; an architectural or API-shape problem where the right answer is a design decision, not a patch; a data-migration or rollback hazard; anything whose blast radius you cannot bound from the diff alone; or a finding you recorded with hedged language because you were unsure.
- Also stop and ask if the findings are individually simple but numerous enough that fixing them is a different task from reviewing them, or if two findings suggest conflicting fixes.
- **If a larger or higher-effort model than the current one is warranted, do not proceed.** Stop and ask the user whether to (a) proceed anyway at the current setting, (b) spawn a subagent at a higher effort to address the findings, or (c) hand it to a separate session. Say which model or effort you would recommend and why. If the user picks (b) or (c), the delegated work follows this same section, including the attempt limit.

Making the fix:

- Fix mode lifts the "do not modify files, commit, or push" rule and the "do not run builds or tests" rule, for this branch only. Nothing else is lifted: still no inline comments, no submitted review of any kind (no approval, no request-changes), no PR body edits, no merges, no force-pushes, no rebases, no amending or reordering existing commits, and no changes outside what the findings call for. Opportunistic cleanup you noticed but did not report as a finding is out of scope.
- Address the findings, then run the repo's tests, build, lint, and type-check as applicable to what you touched. A fix you have not verified is not a fix. If the repo's checks cannot run, say so plainly and treat the fix as unverified.
- Commit the fixes as one or more new commits on the existing branch, with messages describing what was wrong and why the change is correct. Never amend or force-push: the PR has been pushed and may have been read, and rewriting its history would invalidate the SHAs cited in the report you just wrote.
- **If the PR is part of a stack, be more careful.** Fix only this layer, and only within the files this layer's diff already touches. A finding whose real fix belongs in a lower layer is a stop-and-ask, not something to patch here — patching it in the upper layer papers over the lower one and creates a layering violation of exactly the kind this review is meant to catch. Do not rebase, restack, or touch any other layer, even if the fix appears to require it; say so and stop instead.
- Push the new commits to the PR branch.

After the fix:

- Re-run this entire prompt against the updated branch: re-resolve the tip SHA, re-derive the diff, and review again from scratch. Do not merely re-check the findings you fixed — a fix can introduce a new problem, and that is the main thing this second pass exists to catch.
- Record `Fix attempts: 1` (or the prior value plus one) in the new report.
- **If the second run finds nothing, you are done.** Report in chat what was found, what was fixed, and what was pushed, and confirm the second review was clean. Do not post a PR comment: the findings were resolved rather than raised, and the commits are the record.
- **If the second run finds anything at all, stop.** Do not fix again. Report the remaining findings in chat and ask the user whether to continue attempting fixes. This limit exists to prevent an unbounded fix–review loop, so honour it even when the remaining finding looks trivial and even when it is unrelated to the first round's findings.
- Continue only on an explicit instruction from the user in response to that question. A general prior approval to fix the PR is not consent to a further round; ask again after each subsequent round.
- If the user declines to continue, post the current report on the PR so the outstanding findings are recorded, and say that you did. Post it as a plain `gh pr comment` whatever its findings' priorities — this is your own PR, so the request-changes and approve forms under "Posting the report" do not apply to it.

Handing off:

- Whenever you stop and offer to spawn a subagent or a separate session — whether because a higher-effort model is warranted or because the second run still found problems — **also provide a ready-to-paste prompt for that session**, in a fenced block, as part of the same message. The user should not have to reconstruct the context themselves.
- The suggested prompt must be self-contained and name, explicitly rather than by reference: the absolute path of the repository working directory; the branch; the PR number and URL; the tip SHA the report was written against; the absolute path of the report file (`{{HOME}}/agents/output/PR-<number>.md`); the specific findings to address, by their summary lines; and the current `Fix attempts:` value.
- It must also carry the constraints forward, so the delegated session does not start from a blank slate: instruct it to read the report file first, to follow this prompt's "Fixing your own PR" section including the attempt limit, and to stop and ask rather than exceed it.
- Write real values into that prompt, not placeholders. `<number>`, `<branch>`, and `<ref>` are for citations in the report; a handoff prompt containing them is not usable. Resolve them.
- Shape it roughly like this, with every field filled in:

```
Address the review findings on PR #482 (https://github.com/{owner}/{repo}/pull/482)
in {{HOME}}/dev/{repo}, branch atomic-feedback-lineage, reviewed at commit a1b2c3d.

The full review is at {{HOME}}/agents/output/PR-482.md — read it first.
Fix attempts so far: 1.

Address these findings:
- <summary line of finding 1>
- <summary line of finding 2>

Follow the "Fixing your own PR" section of {{HOME}}/agents/prompts/review/review-pr.md:
verify each fix, commit and push to the existing branch without amending or
force-pushing, then re-review. Stop and ask before exceeding the attempt limit.
```

Review priorities:

1. Correctness and behavioral regressions
2. Data loss, stale state, race conditions, error handling, and partial failures
3. Security, authorization, secrets, and environment isolation
4. Production deployment and rollback safety
5. API/schema compatibility and incorrect assumptions about data
6. Accessibility and keyboard behavior
7. Tests that provide false confidence or fail to exercise the behavior they claim to cover
8. Stack layering violations (dependencies on code that only exists above this layer)
9. Maintainability issues only when they create a concrete future failure risk
10. Comment blocks this PR adds that exceed 500 characters (P3)

Review standards:

- Report only actionable findings supported by specific code.
- Trace changed values through their consumers rather than reviewing files in isolation.
- Consider realistic runtime scenarios and failure paths.
- Do not report speculative style preferences.
- A comment block over the limit is **not** a style preference, and is not subject to the "concrete future failure risk" filter that applies to maintainability findings: it is an enforced repo standard with a command that exits non-zero. Report every confirmed violation as P3, citing the file and the block's first line.
- Recommend the fix as trimming the comment to what a reader of that code needs, and moving failure narratives, measurement history, and rollout reasoning into the PR description. Never recommend raising `COMMENT_MAX_CHARS`.
- The standard covers `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.sql`, `.py`, and `.sh` only. Do not flag a long comment in `.tf`, `.yml`/`.yaml`, or `.md` — those are outside the standard, and `infra/modules/platform/*.tf` carries 50-line headers by design. Long _pre-existing_ blocks are also out of scope; only blocks this PR's diff adds count.
- Do not flag an issue merely because the implementation is unusual; verify that it can cause incorrect behavior.
- Avoid repeating issues already fixed in the current commit.
- Avoid repeating findings that belong to a lower layer of the stack and were already introduced (and presumably already reviewed) there; only flag them here if this layer's diff itself changes or newly depends on the problematic code.
- Explain the triggering scenario, user/production impact, and an appropriate correction.
- Break each finding's explanation into a few short paragraphs where it aids clarity — e.g., separate the triggering scenario from the impact from the recommended fix. Don't write a single dense wall-of-text paragraph, and don't fragment into a new paragraph per sentence; aim for a happy medium (roughly 2-4 short paragraphs for a finding with enough content to warrant it, one paragraph is fine for a simple finding).
- Rank findings:
  - P0: immediate catastrophic/security impact
  - P1: serious production correctness, security, data-loss, or deployment blocker
  - P2: meaningful defect affecting a subset of users or scenarios
  - P3: lower-risk quality, maintainability, or testing weakness

Citation rules (follow exactly — line-number errors here have caused false citations before):

- Every file:line reference must come from a fresh, direct read of the real file at its real path (Read tool, or `grep -n` / `sed -n` against the actual path on disk) taken immediately before you write the citation down. Never reuse line numbers you saw earlier from a concatenated diff, a `git diff` / `git show` patch, a Read of a scratch/tmp file, or from memory of an earlier tool call in the conversation — those numbering schemes do not match the source file.
- Treat any number that came from a diff hunk, a patch file, or a combined review artifact as untrustworthy for citation purposes even if it looks plausible, even if the surrounding content matches. Re-derive it from the real file before it goes in the report.
- Immediately before finalizing the report, re-open (or re-grep) every cited file at its cited range and confirm the quoted line(s) actually contain the content you're describing. If a file is shorter than the cited line number, or the content doesn't match, fix the citation — do not soften or hedge it, correct it.
- Format every citation as a Markdown link whose visible text is the repo-relative path + line range, and whose target is the full clickable GitHub blob URL: `[/<path>#L<start>-L<end>](https://github.com/<owner>/<repo>/blob/<ref>/<path>#L<start>-L<end>)`. The link text must NOT repeat the `https://github.com/<owner>/<repo>/blob/<ref>/` prefix — that noise belongs only in the URL, not the visible label. Use the short commit SHA recorded at the start of the review as `<ref>` by default — only use the branch name or a PR-relative diff link if the user asks for that form specifically.
- Never place a citation link inline in a sentence or run two citation links back-to-back in the same line — Markdown collapses adjacent links into an unreadable run-on with no visual separation, especially with long GitHub URLs. Every citation stands on its own bullet line, even when a finding cites only one file. A one-line parenthetical after a link (e.g. quoting the exact code, or naming which side of a comparison it is) is fine on that same bullet line — just never two links sharing a line.
- When a finding cites more than one file/range, list them as a Markdown bullet list (`- [...]`) directly under the explanation prose, not woven into the paragraph. Do not end the lead-in sentence with a bare trailing colon and a wall of un-bulleted links.
- Prefer the built-in Read tool (with `offset`/`limit`) and the Grep tool for citation verification — they are not permission-gated and are the fastest path. Use Bash only when neither fits.
- When you do use Bash for verification, issue plain single commands (e.g. `sed -n '541,546p' path/to/file.py`) or a straight `;`-separated list of them. Avoid shell constructs (functions, `for`/`while` loops) that bundle multiple commands into one — some agent execution environments cannot evaluate or pre-approve commands bundled this way. See `claude-code-notes.md` if you are running as Claude Code.

Use this response format:

Reviewed commit: `<branch>` @ `<short-sha>`

## Summary

A terse, bulleted list of every finding, grouped by priority (P1s first, then P2, P3...) and ordered by severity within each group. One line per finding: just the concise title/claim and the affected file(s) — no explanation, no citation link. This must mirror the Findings section exactly (same findings, same order, same count) — it is a scannable index, not a separate pass.

- **P1**
  - Terse finding title (file.ts, other-file.py)
- **P2**
  - Terse finding title (file.ts)

If there are no findings, say "No actionable findings." and omit the rest of this section.

## Findings

**[P1] Concise finding title**

Explanation with the triggering scenario, impact, and recommended correction, per the citation formatting rules above.

- [/path/to/file.py#L241-L252](https://github.com/<owner>/<repo>/blob/<ref>/path/to/file.py#L241-L252)
- [/path/to/other-file.ts#L535-L536](https://github.com/<owner>/<repo>/blob/<ref>/path/to/other-file.ts#L535-L536) (short parenthetical is fine here, on the same line as this one link)

**[P2] Concise finding title**

Explanation...

- [/path/to/file.ts#L75-L77](https://github.com/<owner>/<repo>/blob/<ref>/path/to/file.ts#L75-L77)

If there are no findings, say:

## Summary

No actionable findings.

## Findings

No actionable findings.

Finish with:

---

- Merge recommendation: approve, fix before merge, or do not merge
- How the report was posted: as an approval, as a request-changes review, as a plain comment, or not at all (say why) — and note that this must follow from the findings' priorities, per "Posting the report". An approval carrying P3 findings is expected; say so plainly rather than hedging the recommendation above.
- Whether any P1/P2 findings remain
- Previous findings, only if a prior report was found: state the short SHA it reviewed and give the per-finding resolved/partially resolved/unresolved/no-longer-applicable verdicts. Don't name the report file or its directory, and don't mention incidental/OS-specific files (e.g. `.DS_Store`) found while checking — none of that is useful to the developer or a future re-review. Omit this bullet entirely when no prior report exists.
- Whether the branch is conflict-free with the latest base
- Stack context, only if the PR is part of a stack: its position in the stack (e.g. "layer 2 of 3"), the current base branch it targets, the PR directly above it if one exists, and whether the layer(s) below it are still open (meaning the base can still move) or already merged. Omit this bullet entirely for a standalone PR — do not state that the stack field is null or otherwise note its inapplicability.
- What validation was performed, clearly distinguishing inspected CI from locally run tests/builds
