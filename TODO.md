# TODO

Open items, each one a decision someone still has to make rather than a task already
scoped. Delete an entry when it is done or deliberately declined.

## Slash commands for the document prompts

`prompts/document/` has no entries in `commands/claude/`, so `document-handoff.md` and
`document-client.md` can only be invoked by pointing an agent at the file. The four
review prompts all have wrappers.

Both take an argument — the area name — so they would follow `review-stack.md`'s shape,
which passes `$ARGUMENTS` through with a note on what to do when it is empty. For these
two, empty should probably mean "ask which area", since unlike a stack there is no
single-open-candidate to fall back on.

Adding them is `commands/claude/document-handoff.md` and `document-client.md`, then
`scripts/deploy-reviews.sh --install`.

## Whether `review-dependabot.md` should be able to fix

`review-pr.md` and `review-local.md` can fix their own findings; `review-stack.md`
explicitly cannot. `review-dependabot.md` has never been part of that conversation and
currently cannot.

Note it could not fix under `review-pr`'s rules anyway: those PRs are authored by
`dependabot[bot]`, and the authorship gate excludes bot accounts by design. So enabling
it would mean a deliberate carve-out rather than an extension of the existing rule.

The argument for: a bump that needs a lockfile regenerated or a single call site updated
is exactly the mechanical work fix mode handles well, and it is tedious by hand. The
argument against: the prompt's current constraints are unusually strict for good reason
— it explicitly forbids `pnpm install`, `pnpm update`, regenerating a lockfile, or
editing a version constraint "to test" anything — and fix mode would have to lift
precisely the rules that make the review trustworthy.

## `backups/` has no rotation

`scripts/deploy-reviews.sh` creates `backups/<timestamp>/` on every run and never removes
one. Currently 15 directories, about 2 MB. It is gitignored and harmless, but it grows
without bound and nothing prunes it.

Either add a retention flag to the script (keep the last N), or leave it manual and note
that `rm -rf backups/*` is always safe once a deploy has been verified. Deciding not to
add rotation is a fine outcome; the point is that nothing currently says so.

## Stale migration backups on this machine

Not repository state, but left over from the original cutover and easy to forget:

- `~/agents/prompts.bak-20260908`
- `~/.claude/commands.bak-20260908`

Both were the pre-migration copies, kept as a diff baseline while the repo was being
built. They have served that purpose — the deployed prompts were verified byte-identical
to them — and can be deleted whenever.

## Tandem mode: let the primary launch the secondary

Tandem mode (`prompts/review/tandem.md`) currently needs each agent launched by hand: `/review-pr 805 --tandem` in Claude Code and `$review-pr 805 --tandem-secondary` in Codex, with the user telling the primary when the secondary is done. The next step is for the primary to start the secondary itself, in the background, pinned to the primary's SHA and worktree, and to treat the process exiting as the done signal.

Smoke-tested 2026-10-07 against a throwaway meridian worktree, codex-cli 0.151.0:

- **`-s read-only -C <worktree>` covers everything a secondary reads.** Worktree files, `git rev-parse`/`git log` (even though the worktree's `.git` lives outside the workspace), and files outside the workspace such as a context file all worked.
- **Read-only blocks the network and every write.** `gh` failed with `error connecting to api.github.com`, `git fetch` failed, and writes inside the worktree and to `{{HOME}}/agents/output/` both failed with `Operation not permitted`.
- **`-o <file>` still delivers the draft.** Codex writes the final message itself, outside the sandbox, so the draft lands in `{{HOME}}/agents/output/` with no write access granted. Only the final message is captured, so the secondary must end with the complete report and nothing else.
- **Exit code 0 means nothing.** Codex exited 0 while most probes failed. Validate the draft (exists, non-empty, reviewed SHA matches), never the exit code.
- **The sandbox makes git warn about `DARWIN_USER_TEMP_DIR` on every command.** Harmless, but noisy enough that Codex reported it as output. Set `TMPDIR=/tmp`.
- **Fallback if a secondary ever needs GitHub:** `-s workspace-write -c sandbox_workspace_write.network_access=true --add-dir <output dir>` made `gh` work, keychain auth included, and allowed writing the draft, while writes elsewhere stayed blocked. Two catches: `--add-dir` rejects a path with a symlink component, and `{{HOME}}/agents/output` is a symlink, so resolve it with `pwd -P`. And the `-C` directory becomes writable, so point `-C` at an empty scratch directory rather than the shared worktree.
- **Timing:** about 90 seconds for nine trivial probes at low effort, so a real review at high effort will run for minutes. Run it in the background.

Design that follows: the secondary only reads. The launcher (`bin/tandem-secondary`, rendered to `{{HOME}}/agents/bin/`) runs outside the sandbox, fetches the GitHub context the review needs into a file, starts the secondary read-only and offline against the primary's worktree, captures the draft with `-o`, and validates it before installing it at the suffixed path. Done since: `tandem.md` and `claude-code-notes.md` now have the primary start the launcher in the background and wait for it (`--tandem`, `--tandem=<id>,...`, `--tandem=manual`), and launched drafts are named by entry id. Still open: the comparison log (one line per secondary per review in `{{HOME}}/agents/output/tandem-log.jsonl`: PR, SHA, entry, model, effort, elapsed, findings raised, kept, merged, dropped, re-ranked, unique), launch commands for agents other than Codex (`hermes -z ... -m ... --provider ...`, `claude -p --model ...`), and a primary other than Claude Code, which needs its own way to run a command in the background.
