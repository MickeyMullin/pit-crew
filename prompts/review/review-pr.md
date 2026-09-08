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
- Do not modify files, commit, or push. The only permitted GitHub write is posting the finished report as a single PR comment, exactly as described under "Output file" — no inline review comments, no approvals, no edits to the PR body.
- Do not run builds or tests unless explicitly requested. You may inspect existing CI results.
- **Run the repo's comment-length check — it is exempt from the "no builds or tests" rule above.** `scripts/check-comment-length.mjs` (the `pnpm check:comments` gate) needs no build and is strictly read-only: it shells out only to `git diff --name-only`, `git ls-files --others`, `git blame`, `git rev-list`, and `git config`. It never writes, stages, or checks anything out, so it is safe to run against any working tree.
- Scope it to the PR author, not to yourself. Its default scope attributes blocks to the local `git config user.email` — the reviewer's, not the author's — so on someone else's PR it silently finds nothing. Resolve the author email from the PR's commits (`gh api repos/{owner}/{repo}/pulls/{number}/commits --jq '.[].commit.author.email'`) and run `COMMENT_AUTHOR=<pr-author-email> node scripts/check-comment-length.mjs <base-ref>`. A PR may carry more than one distinct author email — run the check once per email, or fall back to `COMMENT_SCOPE=all`.
- Pass the PR's real base branch as `<base-ref>`: reuse the base already resolved above for the diff. Do not let it fall back to the script's `origin/main` default, which is the wrong base for a stacked PR.
- `COMMENT_SCOPE=all` never misses a block, but it reports every long block in every touched file, including pre-existing ones that are not this PR's problem. Untracked files also count in full under any scope. Whichever scope you use, confirm a flagged block is actually added by this PR's diff before reporting it.
- Exit 1 means violations; exit 2 means the check could not run (no git email, unfetchable base). Exit 2 is a tooling problem on your side — fix the invocation or say the check did not run, never report it as a finding.
- If you build a combined diff, patch file, or any other scratch artifact to make the review easier to read, treat it as disposable working material only — use it to _locate_ changes, never as the source of a line number you report. See citation rules below.

Output file:

- After completing the review, write the full response (Summary, Findings, and closing notes, verbatim) to a file in the `{{HOME}}/agents/output/` directory, in addition to printing it in chat.
- Name the file after the associated GitHub PR number if one exists for this branch, e.g. `{{HOME}}/agents/output/PR-482.md`. If no PR exists yet, name it after the current branch instead, e.g. `{{HOME}}/agents/output/atomic-feedback-lineage.md`.
- When deriving the filename from the branch name, replace any character that is not alphanumeric, `-`, or `_` with `-`, and collapse consecutive `-` into one.
- Overwrite the file if it already exists from a prior run on this branch/PR. Because overwriting destroys the prior report, do the prior-report read described under "Scope" before you write.
- Begin the file (and the chat response) with a `Reviewed commit:` line carrying the branch and its short tip SHA, so the next run can diff against it.
- Once the file write has completed — and only then, never before it and never concurrently with it — post the same report as a PR comment with `gh pr comment <number> --body-file {{HOME}}/agents/output/PR-<number>.md`, passing the file that was just written. This is the one GitHub write this review performs.
- Skip the comment step when no PR exists for the branch (the report was named after the branch instead); there is nothing to comment on.
- If `gh pr comment` fails, do not retry it and do not attempt any alternative posting path. State plainly in the chat response that posting the comment failed, include the error, and say the report is saved at `{{HOME}}/agents/output/PR-<number>.md` for manual posting.

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
10. Comment blocks this PR adds that exceed the repo's enforced 500-character limit (P3)

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
- Whether any P1/P2 findings remain
- Previous findings, only if a prior report was found: state the short SHA it reviewed and give the per-finding resolved/partially resolved/unresolved/no-longer-applicable verdicts. Don't name the report file or its directory, and don't mention incidental/OS-specific files (e.g. `.DS_Store`) found while checking — none of that is useful to the developer or a future re-review. Omit this bullet entirely when no prior report exists.
- Whether the branch is conflict-free with the latest base
- Stack context, only if the PR is part of a stack: its position in the stack (e.g. "layer 2 of 3"), the current base branch it targets, the PR directly above it if one exists, and whether the layer(s) below it are still open (meaning the base can still move) or already merged. Omit this bullet entirely for a standalone PR — do not state that the stack field is null or otherwise note its inapplicability.
- What validation was performed, clearly distinguishing inspected CI from locally run tests/builds
