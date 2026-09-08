Perform a PR-quality code review of the work on the currently checked-out local branch, _before_ a pull request exists. The goal is to catch problems while they are still cheap to fix — before the branch is pushed and reviewers are pulled in.

Scope:

- Identify the active branch and resolve the base branch locally: use the repository's default branch (`git symbolic-ref refs/remotes/origin/HEAD`, falling back to `origin/main`, then `origin/master`). There is no PR to read the base from.
- Fetch the latest base ref (read-only: `git fetch origin <base>` is allowed) and compare using the merge base.
- Review the complete branch diff, not only the most recent commit.
- **Include uncommitted work.** Staged changes, unstaged working-tree changes, and new untracked source files are all part of what the dev is about to push, so they are in scope. In each finding, note when the cited code is not yet committed.
- Inspect relevant callers, schemas, APIs, tests, workflows, and surrounding code needed to understand the changes.
- Check whether the branch still composes cleanly with the latest base branch.
- If previous findings exist for this branch (see Output file below), explicitly verify whether each one is resolved. This prompt is meant to be re-run as the dev iterates, so prior-findings verification matters.
- Do not review pre-existing base-branch code that this branch does not touch.

Hard constraints (the working tree is live — treat it as sacred):

- Do not modify files, commit, push, or post anything to GitHub. The **one** exception is the fix mode described under "Fixing what you found", which edits file contents only — it never commits, stages, pushes, or posts, and it never relaxes the git-state rule below.
- **Never run any command that mutates git state or the working tree.** Specifically: no `git stash`, `git checkout`, `git switch`, `git restore`, `git reset`, `git add`, `git clean`, `git rebase`, or `git merge`. The dev has uncommitted work; any of these can destroy it. Use read-only inspection (`git diff`, `git diff --staged`, `git status`, `git log`, `git show`, `git merge-base`, `git ls-files`) only.
- Do not run builds or tests unless explicitly requested. Instead, name the specific test files or commands the dev should run before pushing (see closing notes).
- **One exception: run `pnpm check:comments`.** It satisfies the constraints above rather than weakening them — `scripts/check-comment-length.mjs` needs no build and is strictly read-only, shelling out only to `git diff --name-only`, `git ls-files --others`, `git blame`, `git rev-list`, and `git config`. It never writes, stages, or checks anything out, so it cannot touch the dev's uncommitted work.
- Run it with no arguments. The dev is the author, so the script's default scope — blocks attributed to `git config user.email` and new on this branch vs `origin/main` — is already correct, and uncommitted and untracked lines always count as theirs. Do not set `COMMENT_AUTHOR` or `COMMENT_SCOPE`.
- Exit 1 means violations; exit 2 means the check could not run (no git email, unfetchable base). Exit 2 is a tooling problem, not a defect in the branch — say the check did not run, never report it as a finding.
- If you build a combined diff, patch file, or any other scratch artifact to make the review easier to read, treat it as disposable working material only — use it to _locate_ changes, never as the source of a line number you report. See citation rules below.

Output file:

- After completing the review, write the full response (Summary, Findings, and closing notes, verbatim) to a file in the `{{HOME}}/agents/output/` directory, in addition to printing it in chat.
- Name the file `{{HOME}}/agents/output/local-<branch>.md`, e.g. `{{HOME}}/agents/output/local-atomic-feedback-lineage.md`. The `local-` prefix keeps this from colliding with PR-review output for the same branch.
- When deriving the filename from the branch name, replace any character that is not alphanumeric, `-`, or `_` with `-`, and collapse consecutive `-` into one.
- Overwrite the file if it already exists from a prior run on this branch — re-running on the same branch is the expected workflow.
- Begin the file (and the chat response) with a `Fix attempts: <n>` line, where `<n>` is the number of times this branch has been auto-fixed under "Fixing what you found", including any fix made during this run. Write `Fix attempts: 0` when no fix has been made, and carry a prior report's higher value forward rather than resetting it. This line is what bounds the fix loop across separate runs, not merely within one.

Fixing what you found:

This prompt is meant to be run first, before a PR exists, so that problems are fixed while they are still cheap. When this run finds problems, fixing them here is usually the point — but the working tree is live and uncommitted, so the bar for touching it is higher than it would be on a pushed branch, not lower.

- No authorship check is needed. Uncommitted work on a locally checked-out branch is the dev's own by definition; there is no PR and no one else to attribute it to.
- If the review found nothing, this section does not apply.
- Read `Fix attempts:` from the prior report first. If it is 1 or higher, a fix has already been attempted on this branch: **stop and ask** rather than fixing again, exactly as in the "second pass" rule below.

Deciding whether to fix:

- Assess whether the current model and effort level suit the findings you just recorded, and state the assessment and its reasoning in chat before acting. Make the call explicitly rather than defaulting to "yes".
- Proceed when the findings are ones you can resolve completely and verify: a wrong conditional, a missing null guard, an off-by-one, an unhandled error path, a stale comment or doc, a missing test case, a half-applied rename, an incorrect type.
- Stop and ask when a finding needs judgment this setting is not suited to: a concurrency or ordering defect, a security or authorization flaw where a wrong fix looks correct, an architectural or API-shape decision, a data-migration or rollback hazard, anything whose blast radius you cannot bound from the diff, or any finding you recorded with hedged language because you were unsure.
- **If a larger or higher-effort model is warranted, do not proceed.** Stop and ask whether to (a) proceed anyway at the current setting, (b) spawn a subagent at higher effort, or (c) hand it to a separate session, saying which you would recommend and why. Delegated work follows this same section, including the attempt limit.

Making the fix:

- **Back up every file before you first edit it.** Copy each one to `{{HOME}}/agents/output/backups/local-<branch>-<timestamp>/`, preserving its path relative to the repository root, and tell the user that directory in your response. This is not optional and not the same as the safety net a pushed branch has: uncommitted changes exist in no commit, no stash, and no remote, so if a fix makes them worse there is nothing to restore from. The backup is the only undo.
- Fix mode lifts **only** the "do not modify files" rule, and only for files this review flagged. Everything else in "Hard constraints" stands in full. In particular the git-state prohibition is not relaxed by any amount: still no `git stash`, `checkout`, `switch`, `restore`, `reset`, `add`, `clean`, `rebase`, or `merge`. If a fix seems to need one of those, it is out of scope — say so and stop.
- **Do not commit, stage, or push.** Leave the fixes in the working tree exactly as the dev will find them. The staging area reflects the dev's intent about what belongs in which commit, and you do not know that intent; silently staging your edits destroys the distinction between their work and yours.
- Do not touch files outside the findings, and do not make opportunistic improvements you noticed but did not report.
- Be aware the dev may have an editor open on these files. Make the edits in one pass and say plainly which files you changed, so a stale buffer written back over your fix is at least diagnosable.
- Then run the specific tests, build, lint, or type-check that cover what you touched — this run has a reason to, so the "do not run builds or tests" constraint is lifted for verifying your own fixes and nothing else. A fix you have not verified is not a fix; if the checks cannot run, say so and treat it as unverified.

After the fix:

- Re-run this entire prompt against the updated working tree: re-derive the diff and review again from scratch rather than only re-checking what you fixed. A fix can introduce a new problem, and catching that is the main reason this second pass exists.
- Record `Fix attempts: 1` (or the prior value plus one) in the new report.
- If the second pass finds nothing, you are done. Report what was found, what was changed, which files were touched, where the backup is, and what the dev should still run before pushing.
- **If the second pass finds anything at all, stop.** Do not fix again. Report the remaining findings and ask whether to continue. Honour this even when what remains looks trivial or unrelated to the first round.
- Continue only on an explicit instruction in response to that question. A general approval to fix is not consent to a further round; ask again each time.

Handing off:

- Whenever you stop and offer to spawn a subagent or separate session, **also provide a ready-to-paste prompt for it**, in a fenced block, in the same message.
- Resolve every value for real — no `<branch>` or `<file>` placeholders, which belong in citations and make a handoff prompt unusable. Name the absolute repository path, the branch, the absolute path of the report (`{{HOME}}/agents/output/local-<branch>.md`), the backup directory, the findings by their summary lines, the current `Fix attempts:` value, and the fact that the relevant work is uncommitted.
- Carry the constraints forward: instruct the session to read the report first, to follow this prompt's "Fixing what you found" section including the attempt limit and the prohibition on committing, staging, or pushing, and to stop and ask rather than exceed the limit.

Review priorities:

1. Correctness and behavioral regressions
2. Data loss, stale state, race conditions, error handling, and partial failures
3. Security, authorization, secrets, and environment isolation
4. Production deployment and rollback safety
5. API/schema compatibility and incorrect assumptions about data
6. Accessibility and keyboard behavior
7. Tests that provide false confidence or fail to exercise the behavior they claim to cover
8. Pre-push hygiene: leftover debug statements, commented-out code, stray scratch or generated files, credentials or `.env` content staged for commit, TODOs that should be resolved or ticketed, and comment blocks this branch adds that exceed the repo's enforced 500-character limit (`pnpm check:comments`). Report these as P3 unless a secret is involved (then P0/P1). Do not let this become a style review.
9. Maintainability issues only when they create a concrete future failure risk

Review standards:

- Report only actionable findings supported by specific code.
- Trace changed values through their consumers rather than reviewing files in isolation.
- Consider realistic runtime scenarios and failure paths.
- Do not report speculative style preferences.
- A comment block over the limit is **not** a style preference: it is an enforced repo standard with a command that exits non-zero. Report every violation the check reports as P3 pre-push hygiene, citing the file and the block's first line.
- Recommend the fix as trimming the comment to what a reader of that code needs, and moving failure narratives, measurement history, and rollout reasoning into the PR description. Never recommend raising `COMMENT_MAX_CHARS`.
- The standard covers `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.sql`, `.py`, and `.sh` only. Do not flag a long comment in `.tf`, `.yml`/`.yaml`, or `.md` — those are outside the standard, and `infra/modules/platform/*.tf` carries 50-line headers by design. Long _pre-existing_ blocks are also out of scope; the check is branch-scoped, so only blocks this branch adds are violations.
- Do not flag an issue merely because the implementation is unusual; verify that it can cause incorrect behavior.
- Avoid repeating issues already fixed in the working tree.
- Explain the triggering scenario, user/production impact, and an appropriate correction.
- Break each finding's explanation into a few short paragraphs where it aids clarity — e.g., separate the triggering scenario from the impact from the recommended fix. Don't write a single dense wall-of-text paragraph, and don't fragment into a new paragraph per sentence; aim for a happy medium (roughly 2-4 short paragraphs for a finding with enough content to warrant it, one paragraph is fine for a simple finding).
- Rank findings:
  - P0: immediate catastrophic/security impact
  - P1: serious production correctness, security, data-loss, or deployment blocker
  - P2: meaningful defect affecting a subset of users or scenarios
  - P3: lower-risk quality, maintainability, testing, or pre-push hygiene weakness

Citation rules (follow exactly — line-number errors here have caused false citations before):

- Every file:line reference must come from a fresh, direct read of the real file at its real path (Read tool, or `grep -n` / `sed -n` against the actual path on disk) taken immediately before you write the citation down. Never reuse line numbers you saw earlier from a concatenated diff, a `git diff` / `git show` patch, a Read of a scratch/tmp file, or from memory of an earlier tool call in the conversation — those numbering schemes do not match the source file.
- Treat any number that came from a diff hunk, a patch file, or a combined review artifact as untrustworthy for citation purposes even if it looks plausible, even if the surrounding content matches. Re-derive it from the real file before it goes in the report.
- Immediately before finalizing the report, re-open (or re-grep) every cited file at its cited range and confirm the quoted line(s) actually contain the content you're describing. If a file is shorter than the cited line number, or the content doesn't match, fix the citation — do not soften or hedge it, correct it.
- **Cite local paths, not GitHub URLs.** This branch may never have been pushed, so a `github.com/.../blob/<sha>/...` link would point at a commit that does not exist on the remote and would 404. Format every citation as a Markdown link whose visible text is the repo-relative path + line range and whose target is the repo-relative path with a line anchor: `[/<path>#L<start>-L<end>](<path>#L<start>-L<end>)`. These resolve as clickable jumps in the editor.
- Never place a citation link inline in a sentence or run two citation links back-to-back in the same line — Markdown collapses adjacent links into an unreadable run-on. Every citation stands on its own bullet line, even when a finding cites only one file. A one-line parenthetical after a link (e.g. quoting the exact code, naming which side of a comparison it is, or marking it `uncommitted`) is fine on that same bullet line — just never two links sharing a line.
- When a finding cites more than one file/range, list them as a Markdown bullet list (`- [...]`) directly under the explanation prose, not woven into the paragraph. Do not end the lead-in sentence with a bare trailing colon and a wall of un-bulleted links.
- Prefer the built-in Read tool (with `offset`/`limit`) and the Grep tool for citation verification — they are not permission-gated and are the fastest path. Use Bash only when neither fits.
- When you do use Bash for verification, issue plain single commands (e.g. `sed -n '541,546p' path/to/file.py`) or a straight `;`-separated list of them. Avoid shell constructs (functions, `for`/`while` loops) that bundle multiple commands into one — some agent execution environments cannot evaluate or pre-approve commands bundled this way. See `claude-code-notes.md` if you are running as Claude Code.

Use this response format:

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

- [/path/to/file.py#L241-L252](path/to/file.py#L241-L252)
- [/path/to/other-file.ts#L535-L536](path/to/other-file.ts#L535-L536) (uncommitted — staged only)

**[P2] Concise finding title**

Explanation...

- [/path/to/file.ts#L75-L77](path/to/file.ts#L75-L77)

If there are no findings, say:

## Summary

No actionable findings.

## Findings

No actionable findings.

Finish with:

- Readiness recommendation: ready to push and open a PR, fix before pushing, or needs rework
- Whether any P0/P1/P2 findings remain
- Whether previous findings from a prior run on this branch were resolved, when applicable
- Whether the branch is conflict-free with the latest base
- Working-tree state: whether uncommitted or untracked changes were included in the review, and which findings depend on them
- Pre-push checklist: the specific tests, builds, lint, or type-check commands the dev should run against these changes, and any that CI will run that have not been run locally
