Perform an upgrade-risk review of a Dependabot pull request.

This is not a general code review. A Dependabot PR contains no authored logic — the diff is a version bump plus a lockfile. The review's job is to answer one question: **does adopting this new version change the behavior of this repo's code, and if so, where?** Nearly all the work happens outside the diff — in the dependency's changelog and in this repo's call sites.

Scope:

- Identify the active branch and associated GitHub PR. If the current branch is not a Dependabot branch (`dependabot/<ecosystem>/...`), say so and stop rather than reviewing it under these rules — use `review-pr.md` instead.
- Before reviewing anything, record the short SHA of the branch's tip commit (`git rev-parse --short HEAD`). Note it up front and use it as the `<ref>` in every citation URL, so the report is pinned to the exact commit reviewed.
- Read the PR body. Dependabot embeds the release notes, changelog excerpt, and commit list for the bumped package; it also states the update type (`semver-major`/`minor`/`patch`) and the compatibility score. Treat all of it as a starting point, not as the finding — the body says what changed in the package, and the review says what that means here.
- Enumerate every version bump in the diff. A grouped update (this repo groups npm minor/patch under `npm-minor-patch`) can carry dozens of packages in one PR; a transitive-only lockfile change carries packages that appear nowhere in `package.json`. Review the direct-dependency bumps individually and the transitive ones as a set.
- Determine the ecosystem from the branch name and the changed files, and apply the matching ecosystem checklist below. This repo runs Dependabot against `npm` (root, grouped minor/patch), `github-actions`, `docker`, and `terraform` (`infra/live/azure/{shared,dev,qa,prod}` and `infra/modules/platform`) — see `.github/dependabot.yml`.
- Compare the branch against the latest remote base using the merge base, and review the complete branch diff (Dependabot force-pushes rebases, so the branch may have been rewritten since a prior run).
- Find this repo's actual usage of every directly-bumped package before judging anything. Grep for the import/module/action/provider name across `apps/`, `scripts/`, `tools/`, `tests/`, `infra/`, and `.github/workflows/`. A major bump of a package with no first-party call sites is a different risk than a minor bump of one used in a hot path.
- Check whether the bump is one the repo has deliberately pinned or held back. `.github/dependabot.yml` ignores majors for `@eslint/js`, `@types/node`, `eslint`, `typescript`, and the `node` Docker image. A PR that moves one of those anyway — or a bump that silently defeats an intentional pin elsewhere (engines, `.nvmrc`, a Terraform `required_version`, a Dockerfile base tag) — is a finding.
- Inspect the CI results on the PR rather than running builds or tests locally. Note which checks ran, which passed, and — importantly — which relevant checks did **not** run for this diff. A green PR whose only executed jobs are lint and typecheck is not evidence that a runtime dependency still behaves.
- Check for a pre-existing report from a prior run before starting, in `{{HOME}}/agents/output/` under the name this run would write (see "Output file"). If one exists, read only its first ~80 lines — the `## Summary` index — and verify each prior finding as resolved, partially resolved, unresolved, or no longer applicable. Because Dependabot rebases and re-bumps, also confirm the prior report's SHA is still an ancestor of HEAD (`git merge-base --is-ancestor <prior-sha> HEAD`); if it is not, the branch was rewritten and the prior findings must be re-derived from scratch rather than diffed forward.
- Do not modify files, commit, or push. Do not `pnpm install`, `pnpm update`, regenerate a lockfile, or edit a version constraint to "test" anything. The only permitted GitHub write is posting the finished report as a single PR comment, exactly as described under "Output file".
- Do not run builds or tests unless explicitly requested.
- The repo's comment-length check does not apply here — a Dependabot diff adds no comments. Skip it entirely and do not mention it in the report.

Version-change analysis (the core of this review):

- For every direct bump, establish the exact from → to versions and every intervening release, not just the endpoints. A `1.2.0 → 1.5.0` bump adopts the breaking-ish behavior of `1.3.0` and `1.4.0` too, and Dependabot's embedded notes sometimes summarize only the newest release.
- Read the upstream changelog/release notes for that range. Prefer what the PR body embeds; fetch the upstream release page when the body truncates it or when the range spans releases the body omits. Say plainly in the report when you could not obtain notes for part of a range — an unread range is a gap in the review, not a pass.
- Classify each change in the range into: **breaking** (removed/renamed API, changed default, changed return shape, raised runtime/engine floor), **deprecation** (still works, warns, will be removed), **behavioral** (same API, different output/timing/ordering/error text), **security fix**, and **inert** (docs, internal refactor, features this repo does not touch).
- For every breaking or behavioral change, go find whether this repo actually hits it. Cite the call site if it does. If it does not, say so explicitly — "the removed `x()` API has no call sites in this repo" is a useful review conclusion, and it is the sentence that separates a real review from a rubber stamp.
- Treat a semver-minor or -patch label as a claim, not a fact. Libraries ship breaking changes in patch releases; a "patch" that changes a default, tightens validation, or alters an error message can break this repo. Judge by the changelog contents, not the version-number delta.
- Deprecations are first-class findings here, unlike in an ordinary code review. A newly-deprecated API that this repo calls is a P3 (or P2 if a removal version is already announced): it is not broken today, but it is a scheduled future break with a known deadline. Report the deprecated symbol, this repo's call sites, the replacement the upstream recommends, and the version in which removal is announced.
- Check the new version's own requirements against this repo's floors: Node engine ranges (`package.json` `engines`, the Dockerfile base image, the `node-version` in workflows), TypeScript version, Terraform `required_version`, provider `required_providers` constraints, and Python/runtime versions where relevant. A dependency that now requires a newer runtime than the repo pins is a P1 — it will fail at install or at runtime, not at review time.
- Check peer-dependency coherence for npm bumps: whether the new version's peers are satisfied by what the lockfile now resolves, and whether a bumped package and its plugins/adapters (ESLint and its configs, a test runner and its reporters, a framework and its type packages) moved in step or are now split across incompatible majors.
- Look for supply-chain smells that a version bump can carry regardless of the changelog: a package that changed maintainer or repository URL, a bump that adds a large number of new transitive packages, a new `postinstall`/lifecycle script, a jump to a version published far outside the package's normal cadence, or a bump to a version yanked or flagged upstream. Report what you observe; do not speculate about intent.
- When the bump is a security fix, state the CVE/advisory and whether this repo's usage is actually on the vulnerable path. Both answers matter: an exploitable path raises the merge urgency, and an unreachable one lowers it.

Ecosystem checklists:

- **npm** — confirm `package.json` and `pnpm-lock.yaml` moved together and no other manifest drifted. For a grouped `npm-minor-patch` PR, list which packages moved and single out any whose changelog shows behavioral change; do not review 40 patch bumps at equal depth. Check whether the package ships types and whether the type surface changed in a way that breaks compilation. Check for ESM/CJS shifts (a package going ESM-only breaks `require()` call sites and Jest/CommonJS test setups). Watch for a `@types/*` package moving out of step with its runtime package.
- **github-actions** — a major bump of an action is usually a runner or Node-runtime change (e.g. `node16` → `node20` → `node24`) plus input renames. Check every workflow that references the action, not just one, and check that the `with:` inputs the workflows pass still exist and still mean the same thing. Verify the pinned ref form (tag vs. full SHA) is preserved. Pay attention to actions used in deploy and identity workflows — `azure/login`, OIDC-related actions, and anything touching secrets — where a behavior change fails only at deploy time, well after CI is green.
- **docker** — a base-image bump changes the OS and the system libraries under the app, not just the tag. Check each Dockerfile that uses the image (`Dockerfile`, `Dockerfile.engine`, `Dockerfile.jobs`, `Dockerfile.gold-restore`) for assumptions the new base may break: apt/apk package names, glibc vs. musl, the default user, the shipped Node/Python version, certificate stores. Confirm the digest and tag are consistent, and that a major bump of the `node` image is not slipping through the configured major-ignore.
- **terraform** — distinguish a module-version bump from a provider-version bump. For providers, read the upgrade guide for the range, check for removed or renamed resource arguments and for defaults that changed (which produce plan diffs or forced replacements on resources this repo already manages), and check the `required_providers` constraint in each affected live directory and in `infra/modules/platform`. State explicitly whether the bump can cause a destroy/recreate on existing infrastructure — that is a P0/P1 class of finding regardless of what the changelog calls it. Note that the live directories are per-environment: a provider bump that lands in `prod` deserves more scrutiny than the same bump in `dev`, and the four directories should not silently diverge.

Output file:

- After completing the review, write the full response (Summary, Findings, and closing notes, verbatim) to a file in the `{{HOME}}/agents/output/` directory, in addition to printing it in chat.
- Name the file after the associated GitHub PR number, e.g. `{{HOME}}/agents/output/PR-482.md`. If no PR exists, name it after the current branch, replacing any character that is not alphanumeric, `-`, or `_` with `-` and collapsing consecutive `-` into one.
- Overwrite the file if it already exists from a prior run. Because overwriting destroys the prior report, do the prior-report read described under "Scope" before you write.
- Begin the file (and the chat response) with a `Reviewed commit:` line carrying the branch and its short tip SHA, so the next run can diff against it.
- Once the file write has completed — and only then — post the same report as a PR comment with `gh pr comment <number> --body-file {{HOME}}/agents/output/PR-<number>.md`. This is the one GitHub write this review performs.
- Skip the comment step when no PR exists for the branch.
- If `gh pr comment` fails, do not retry it and do not attempt any alternative posting path. State plainly in the chat response that posting failed, include the error, and say the report is saved for manual posting.

Review priorities:

1. Breaking changes in the adopted version range that this repo's code actually hits
2. Runtime/engine/toolchain floors raised beyond what this repo pins (install-time or startup failures)
3. Infrastructure changes that force replacement or destroy state (Terraform provider/module bumps)
4. Deploy-path and secret-handling behavior changes that CI cannot catch (actions, base images, auth libraries)
5. Security: the advisory this bump fixes, and any new supply-chain smell the bump introduces
6. Silent behavioral changes — same API, different output, ordering, timing, or error text
7. Peer-dependency and companion-package incoherence (runtime vs. types, plugin vs. host)
8. Deprecations this repo now calls, with an announced removal version
9. CI coverage gaps: which checks would have caught a regression here and did not run
10. Lockfile/manifest inconsistency or drift in files Dependabot should not have touched

Review standards:

- Report only findings tied to a specific version change and, where the repo is affected, a specific call site. "This is a major bump, be careful" is not a finding.
- The default outcome for a clean patch bump with no first-party call sites is **no actionable findings**. Say that plainly rather than manufacturing risk to fill the report.
- Conversely, do not approve on a green CI alone. State which checks ran and why they are or are not sufficient evidence for this particular bump.
- Do not review the dependency's own code quality, and do not report findings about the upstream project's choices. The subject is this repo's exposure.
- Do not report on Dependabot's formatting, commit message, or PR body style.
- Distinguish clearly between "I read the changelog for this range" and "I could not find notes for this range." Never let the second silently read as the first.
- Explain each finding with the triggering scenario, the impact here, and the correction — which may be: pin/hold the version, adopt the replacement API in the same PR, split the grouped PR, add a follow-up ticket for a deprecation, or merge as-is with a stated caveat.
- Break each finding's explanation into a few short paragraphs where it aids clarity — roughly 2-4 for a finding with real content, one is fine for a simple one. No wall-of-text, no paragraph-per-sentence.
- Rank findings:
  - P0: immediate catastrophic/security impact, or an infra bump that destroys state on apply
  - P1: breaking change this repo hits, raised runtime floor, or a deploy-path failure that CI cannot catch
  - P2: meaningful behavioral change affecting a subset of scenarios, or companion-package incoherence
  - P3: deprecation with a future removal, CI coverage gap, or low-risk drift

Citation rules (follow exactly — line-number errors here have caused false citations before):

- Every file:line reference must come from a fresh, direct read of the real file at its real path (Read tool, or `grep -n` / `sed -n` against the actual path on disk) taken immediately before you write the citation down. Never reuse line numbers seen earlier in a `git diff` / `git show` patch, a scratch file, or from memory of an earlier tool call — those numbering schemes do not match the source file.
- This matters more than usual here, because most citations point at **call sites**, not at the diff. The interesting line is in `apps/…` or `infra/…`, not in `package.json`.
- Immediately before finalizing the report, re-open (or re-grep) every cited file at its cited range and confirm the quoted lines contain the content you're describing. Fix any mismatch — do not soften or hedge it.
- Format every citation as a Markdown link whose visible text is the repo-relative path + line range, and whose target is the full clickable GitHub blob URL: `[/<path>#L<start>-L<end>](https://github.com/<owner>/<repo>/blob/<ref>/<path>#L<start>-L<end>)`. The link text must NOT repeat the URL prefix. Use the short commit SHA recorded at the start of the review as `<ref>`.
- Never place a citation link inline in a sentence or run two citation links back-to-back on the same line. Every citation stands on its own bullet line. A one-line parenthetical after a link is fine on that same line — just never two links sharing a line.
- When a finding cites more than one file/range, list them as a bullet list directly under the explanation prose.
- Upstream references (changelog entries, release pages, advisories, upgrade guides) are links too, but keep them on their own bullet lines under the code citations, labeled as upstream — never interleaved with repo citations.
- Prefer the built-in Read and Grep tools for citation verification. Use Bash only when neither fits, and then issue plain single commands (e.g. `sed -n '541,546p' path/to/file.ts`) rather than shell loops or functions. See `claude-code-notes.md` if you are running as Claude Code.

Use this response format:

Reviewed commit: `<branch>` @ `<short-sha>`

## Bumps

A table of every version change in this PR, so the reader sees the whole surface before the findings.

| Package          | From  | To     | Type  | First-party call sites | Verdict           |
| ---------------- | ----- | ------ | ----- | ---------------------- | ----------------- |
| `example-lib`    | 1.2.0 | 2.0.0  | major | 3 (`apps/api/…`)       | breaking — see P1 |
| `@types/example` | 1.1.9 | 1.1.11 | patch | —                      | inert             |

For a large grouped PR, list every package but keep the `Verdict` column terse; the findings carry the detail.

## Summary

A terse, bulleted list of every finding, grouped by priority (P0 first) and ordered by severity within each group. One line per finding: the concise claim and the affected package/file — no explanation, no citation link. This must mirror the Findings section exactly.

- **P1**
  - Terse finding title (package, file.ts)
- **P3**
  - Terse finding title (package)

If there are no findings, say "No actionable findings." and omit the rest of this section.

## Findings

**[P1] Concise finding title**

Explanation with the triggering scenario, impact here, and recommended correction, per the citation formatting rules above.

- [/path/to/file.ts#L241-L252](https://github.com/<owner>/<repo>/blob/<ref>/path/to/file.ts#L241-L252)
- Upstream: [example-lib 2.0.0 release notes](https://example.com/releases/2.0.0)

If there are no findings, say:

## Summary

No actionable findings.

## Findings

No actionable findings.

Finish with:

---

- Merge recommendation: approve, fix before merge, hold/pin, or do not merge
- Whether any P0/P1/P2 findings remain
- Changelog coverage: the version ranges whose release notes you actually read, and any range you could not obtain notes for
- Previous findings, only if a prior report was found: the short SHA it reviewed, whether that SHA is still an ancestor of HEAD (Dependabot rebases), and the per-finding resolved/partially resolved/unresolved/no-longer-applicable verdicts. Omit this bullet entirely when no prior report exists.
- Whether the branch is conflict-free with the latest base
- CI status: which checks ran and passed, and which checks that would be relevant to this bump did not run
- What validation was performed, clearly distinguishing inspected CI from anything run locally
