# Instructions for agents working in this repo

Read this before editing any file here.

## The one rule

**No real home directory path may ever be committed.** Committed files write it as the
literal placeholder `{{HOME}}`. Violating this is the single failure mode this repo is
built to prevent — it has already required one history rewrite.

## Two trees, two directions

| Tree | Committed? | Contains | Purpose |
| --- | --- | --- | --- |
| `prompts/`, `commands/` | Yes | `{{HOME}}` placeholders | Source of truth |
| `deploy/` | No (gitignored) | Real absolute paths | What actually runs |

Files move between them **only** via scripts, never by hand:

- `scripts/deploy-reviews.sh` — sources → `deploy/`, substituting `{{HOME}}` → `$HOME`.
- `scripts/sanitize.sh` — `deploy/` → sources, substituting `$HOME` → `{{HOME}}`.

Both verify their own output and exit non-zero on failure. Both are idempotent.

## What to do, by situation

| The user asked you to... | Do this |
| --- | --- |
| Change a prompt or command | Edit the file in `prompts/` or `commands/`, keep `{{HOME}}`, then run `scripts/deploy-reviews.sh` |
| Preserve a change already made in `deploy/` | Run `scripts/sanitize.sh`, then show the user `git diff` |
| Check whether the trees have drifted | Run `scripts/sanitize.sh --dry-run` |
| Rebuild the deployed copy | Run `scripts/deploy-reviews.sh` |
| Commit work | Run `git diff -- prompts commands` and confirm no real path appears, then commit |

## Prohibitions

1. Do not write a real home path into `prompts/` or `commands/`. Use `{{HOME}}`.
2. Do not edit files in `deploy/` expecting persistence — `deploy-reviews.sh` deletes
   and rebuilds that directory. Run `sanitize.sh` first to preserve the change.
3. Do not hand-write a `sed` to convert between the two forms. Both directions are
   scripted and self-verifying; an ad-hoc substitution is how a path leaks.
4. Do not `cp` files between the trees directly.
5. Do not modify `<name>` placeholders such as `<number>`, `<owner>`, `<ref>` in the
   prompts. Those are resolved by the reviewing agent at run time and must survive
   deployment unchanged. Only `{{NAME}}` is build-time.
6. Do not commit `deploy/`. It is gitignored; keep it that way.

## Before you report a change as done

- `scripts/deploy-reviews.sh` exits 0, or you ran `scripts/sanitize.sh` and it exits 0.
- `git grep -I "$HOME" -- prompts commands` returns nothing.
- You showed the user the diff rather than committing silently.

## Editing the prompts themselves

`prompts/review/*.md` are instructions for a reviewing agent, not documentation. They
are precise on purpose: ordering constraints ("only then, never before it"), the single
permitted GitHub write, and the requirement to write the report to disk before posting
it. Preserve that precision. If asked to make one "clearer", do not relax a constraint
into a suggestion.

Full rationale and the human workflow: [README.md](README.md).
