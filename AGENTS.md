# Instructions for agents working in this repo

Read this before editing any file here.

## The one rule

**No real home directory path may ever be committed.** Committed files write it as the
literal placeholder `{{HOME}}`. Violating this is the single failure mode this repo is
built to prevent — it has already required one history rewrite.

## Two trees, two directions

| Tree | Committed? | Contains | Purpose |
| --- | --- | --- | --- |
| `prompts/**`, `commands/**`, `bin/**` | Yes | `{{HOME}}` placeholders | Source of truth (walked recursively; `bin/` holds executables, rendered to `{{HOME}}/agents/bin/` via a symlink into `deploy/bin`) |
| `deploy/` | No (gitignored) | Real absolute paths | What actually runs |
| `backups/` | No (gitignored) | Timestamped copies | Undo for the two above |

Files move between them **only** via scripts, never by hand:

- `scripts/deploy-reviews.sh` — sources → `deploy/`, substituting `{{HOME}}` → `$HOME`.
  Add `--install` to also install the command wrappers for every supported agent found
  on the machine (`--install=<agent>` for a subset).
- `scripts/sanitize.sh` — `deploy/` → sources, substituting `$HOME` → `{{HOME}}`.

Both verify their own output and exit non-zero on failure. Both are idempotent. Before
overwriting anything, `deploy-reviews.sh` copies it into `backups/<timestamp>/` and
prints the restore command; it also refuses to run when `deploy/` holds edits that never
reached the sources, since rendering would discard them.

Exit codes: `0` success, `1` error, `2` bad usage, `3` (`sanitize.sh --dry-run` only)
pending changes exist.

## Pit View (`pit-view/`)

`pit-view/` is Pit View, a local dashboard for the pull requests in one GitHub repository: a separate Node app with its own `package.json`, run with `pnpm start` from `pit-view/` (`pnpm install` once first). `pit-view/DESIGN.md` is its design and progress tracker and the authority for any change there: read it before editing anything under `pit-view/`, follow its code conventions (section 4), and tick its milestones and add to its session log as work lands.

It is not part of either tree above. `scripts/deploy-reviews.sh` and `scripts/sanitize.sh` do not touch it, it must not depend on either, and its own `pnpm` scripts never move files between the sources and `deploy/`. It holds no `{{HOME}}` placeholders: it writes `~` and resolves it at runtime with `os.homedir()`, and its config, cache and the reports it reads live under the home directory, never in the repo.

The one rule covers it too. No real home path may be committed under `pit-view/`, and neither may real client data: colleague logins, PR titles, job URLs, ticket keys, or repository names other than its default config value. Its test fixtures are invented and must stay that way.

## What to do, by situation

| The user asked you to... | Do this |
| --- | --- |
| Change a prompt | Edit it in `prompts/`, keep `{{HOME}}`, then run `scripts/deploy-reviews.sh` |
| Add a new prompt family | Just make the directory under `prompts/` — both scripts walk it recursively; neither needs editing |
| Change a command | Edit it in `commands/`, keep `{{HOME}}`, then run `scripts/deploy-reviews.sh --install` — commands do **not** take effect without the install step |
| Change a command for every agent | `commands/claude/` is Claude Code's flat slash commands; `commands/skills/` is the `SKILL.md` form that Hermes and Codex share. A change to what a command *does* usually belongs in both |
| Add support for another agent | Add a line to the `agents=` registry in `scripts/deploy-reviews.sh` (`name\|source\|target\|form\|env`) and reuse `commands/skills/` if it reads `SKILL.md`. Do not hardcode a second install path |
| Undo a deploy | `cp -R backups/<timestamp>/deploy/. deploy/` |
| Preserve a change already made in `deploy/` | Run `scripts/sanitize.sh`, then show the user `git diff` |
| Check whether the trees have drifted | Run `scripts/sanitize.sh --dry-run` |
| Rebuild the deployed copy | Run `scripts/deploy-reviews.sh` |
| Change Pit View | Read `pit-view/DESIGN.md` first, edit in `pit-view/`, then run `pnpm test` and `pnpm check` from `pit-view/`. Nothing is deployed; neither script is involved |
| Commit work | Run `git diff -- prompts commands bin` and confirm no real path appears, then commit |

## Prohibitions

1. Do not write a real home path into `prompts/` or `commands/`. Use `{{HOME}}`.
2. Do not edit files in `deploy/` expecting persistence — `deploy-reviews.sh` deletes
   and rebuilds that directory. Run `sanitize.sh` first to preserve the change.
3. Do not hand-write a `sed` to convert between the two forms. Both directions are
   scripted and self-verifying; an ad-hoc substitution is how a path leaks.
4. Do not `cp` files between the trees directly.
5. Do not put Claude Code–specific instructions in `commands/skills/` or in a prompt.
   The skills are shared by Hermes and Codex, and each one says explicitly not to load
   `claude-code-notes.md`. That file is Claude Code's alone.
6. Do not modify `<name>` placeholders such as `<number>`, `<owner>`, `<ref>` in the
   prompts. Those are resolved by the reviewing agent at run time and must survive
   deployment unchanged. Only `{{NAME}}` is build-time.
7. Do not commit `deploy/` or `backups/`. Both are gitignored; keep it that way.
8. Do not pass `--force` to either script to get past a refusal. Both refusals mean
   real work is about to be destroyed. Run `sanitize.sh` to preserve it, or ask the
   user. `--force` is theirs to choose, not yours.

## Before you report a change as done

- `scripts/deploy-reviews.sh` exits 0, or you ran `scripts/sanitize.sh` and it exits 0.
- `git grep -I "$HOME" -- prompts commands bin` returns nothing.
- For a change under `pit-view/`, also: `pnpm test` and `pnpm check` pass in `pit-view/`, and `grep -rI --exclude-dir=node_modules "$HOME" pit-view` returns nothing.
- You showed the user the diff rather than committing silently.

## Fix mode

`review-local.md` and `review-pr.md` may fix the problems they find; `review-stack.md`
may not, ever, and its prompt says so explicitly — do not improvise it back in. If you
are running one of these reviews, follow the prompt's own fix section exactly. Its
limits are deliberate, and two matter most:

- **The one-attempt bound.** Re-review once after fixing; if that pass finds anything,
  stop and ask. The count is in the report's `Fix attempts:` line. Honour it even when
  what remains looks trivial — it is what prevents an unbounded fix–review loop.
- **`review-pr` fixes only your own PR**, confirmed by matching `gh api user` against
  the PR author login. Never infer ownership from a checked-out branch.
- **`review-local` may create exactly one commit** — a WIP commit of the user's
  in-flight work, made *before* any edit, so there is something to restore from. Your
  own fixes stay uncommitted on top of it. Offer the finish-up paths; run none of them
  unless asked.

## Editing the prompts themselves

`prompts/review/*.md` are instructions for a reviewing agent, not documentation. They
are precise on purpose: ordering constraints ("only then, never before it"), the single
permitted GitHub write, and the requirement to write the report to disk before posting
it. Preserve that precision. If asked to make one "clearer", do not relax a constraint
into a suggestion.

Full rationale and the human workflow: [README.md](README.md).
