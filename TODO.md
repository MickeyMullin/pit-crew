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

`codex exec` (non-interactive, present in codex-cli 0.151.0) is the obvious mechanism for Codex. Open questions before building it: whether Codex's sandbox can reach `gh` and write to `{{HOME}}/agents/output/` (if not, have it print the report and let the primary write the file), how long a Codex review runs and whether a background command survives that long under each primary agent, and where the per-secondary launch command lives. A small registry in `tandem.md`, shaped like the `agents=` registry in `scripts/deploy-reviews.sh`, keeps it agent-agnostic. Run Phase 1 on a few more PRs first, so the consolidation rules settle before the launch is automated.
