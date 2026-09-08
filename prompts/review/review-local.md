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

- Do not modify files, commit, push, or post anything to GitHub.
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
