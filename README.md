# pit-crew

Prompts, scripts, and scheduled jobs that service the repo so agents can review PRs and keep the shop running.

This is the source of truth for the code-review prompts I run through Claude Code (and
other agents). The prompts live here; the local machine points at a rendered copy of
this repo rather than holding its own.

## Layout

| Path | What's in it |
| --- | --- |
| `prompts/review/` | Code-review prompts, plus agent-specific execution notes. Agent-agnostic except where noted. |
| `commands/claude/` | Claude Code slash commands that invoke the prompts. See [commands/claude/README.md](commands/claude/README.md). |
| `scripts/` | The two directions. `deploy-reviews.sh` renders sources into a runnable copy; `sanitize.sh` brings tested edits back. |
| `deploy/` | Generated, gitignored. The rendered output — the only place real home paths exist. |

`prompts/` is grouped by job so later families (triage, release, maintenance) sit
alongside `review/` rather than crowding it.

## Sanitization

**No machine-specific path appears anywhere in this repo, including its git history.**
Every home directory root is written as the literal placeholder `{{HOME}}`:

```
gh pr comment <number> --body-file {{HOME}}/agents/output/PR-<number>.md
```

Nothing that reads these files expands the placeholder on its own. Claude Code does not
expand `{{HOME}}`, `$HOME`, or `~` inside a command file, and an agent reading a prompt
treats the path as literal text. Substitution happens at deploy time instead:

```bash
scripts/deploy-reviews.sh
```

That renders `prompts/` and `commands/` into `deploy/`, substituting `{{HOME}}` for
`$HOME`, and fails loudly if any placeholder survives. `deploy/` is gitignored — it is
the only directory holding real paths, and it never goes back to GitHub.

Override the target with `HOME_SUBSTITUTE=/Users/other scripts/deploy-reviews.sh` to
render for a different account, or `DEPLOY_DIR=...` to render elsewhere.

### Two placeholder conventions, deliberately different

The example line above contains three placeholders, and they are not the same kind of
thing:

| Syntax | Resolved by | When | Example |
| --- | --- | --- | --- |
| `{{NAME}}` | `scripts/deploy-reviews.sh` | Deploy time, before any agent reads the file | `{{HOME}}` |
| `<name>` | The agent, from context it discovers | Run time, mid-review | `<number>`, `<owner>`, `<ref>` |

Angle brackets were the prompts' own convention long before any of this existed — there
are over a hundred of them. A deploy-time placeholder written as `<HOME>` would be
visually indistinguishable from them while behaving completely differently, so
deploy-time substitution gets its own syntax.

This is what lets the deploy script's safety check stay honest: it greps for **any**
`{{...}}` in the rendered output and refuses to finish if one survives, so a placeholder
added later is caught without anyone remembering to update the check. It never touches
`<...>`, which must reach the agent intact.

## The review prompts

| Prompt | Use |
| --- | --- |
| `prompts/review/review-local.md` | Review uncommitted / local branch work before a PR exists. |
| `prompts/review/review-pr.md` | Review a single GitHub PR and post the report as a PR comment. |
| `prompts/review/review-stack.md` | Review a whole stack of PRs, posting one report on the top layer. |
| `prompts/review/review-dependabot.md` | Review a Dependabot bump, accounting for rebases and re-bumps. |
| `prompts/review/claude-code-notes.md` | Claude Code–specific execution notes. Loaded alongside the prompt above when running under Claude Code; not applicable to other agents. |

### Report output

The PR-writing prompts write their full report to `{{HOME}}/agents/output/` before posting
anything to GitHub, so a failed post never loses the review. That directory is
referenced by absolute path — deliberately, so it stays stable across clones and
worktrees rather than following the repo you happen to be reviewing.

## Setting up a machine

```bash
git clone git@github.com:MickeyMullin/pit-crew.git
cd pit-crew
scripts/deploy-reviews.sh
ln -sfn "$PWD/deploy/prompts" "$HOME/agents/prompts"
cp deploy/commands/claude/review-*.md "$HOME/.claude/commands/"
mkdir -p "$HOME/agents/output"
```

The script prints those last two commands with real paths filled in; it does not run
them, since both write outside the repo.

## The two directions

Sources are committed and always use `{{HOME}}`. `deploy/` is gitignored, holds real
paths, and is what actually runs. Changes flow **both ways**, and each direction has a
script. Never move files between them by hand.

```
                   scripts/deploy-reviews.sh  ->
  prompts/review/*.md                              deploy/prompts/review/*.md
  commands/claude/*.md                             deploy/commands/claude/*.md
  (committed, {{HOME}})                            (gitignored, real paths, runs)
                   <-  scripts/sanitize.sh
```

### Direction 1: you edited a source, and want to run it

```bash
scripts/deploy-reviews.sh
```

Renders sources into `deploy/`, substituting `{{HOME}}`. Refuses to finish if any
placeholder survives.

### Direction 2: you edited the live copy, tested it, and want to commit it

This is the normal way to change a prompt. Edit the deployed file, run a real review
against it, and once it behaves, bring the tested version back:

```bash
scripts/sanitize.sh --dry-run    # what would change
scripts/sanitize.sh              # write it over the sources
git diff -- prompts commands     # review before committing
git add -A && git commit
```

`sanitize.sh` replaces the real home path with `{{HOME}}`, then verifies the round trip
file by file — re-rendering what it produced must reproduce the deployed file exactly,
or it writes nothing. It refuses to run when the sources have uncommitted changes
(pass `--force` to override), and aborts if any real path survives into the sources.
It does not `git add`; read the diff yourself.

## Rules

These hold for anyone working in this repo, human or agent:

1. **Never commit a real home directory path.** Sources use `{{HOME}}`. This is the
   reason the repo is shaped this way.
2. **Never hand-edit a file in `deploy/` and expect it to survive.**
   `deploy-reviews.sh` deletes and rebuilds that directory. Run `sanitize.sh` to
   preserve the change first.
3. **Never hand-edit a source file to swap paths.** Both directions are scripted, and
   both verify themselves. A manual `sed` is how a real path reaches history.
4. **Never move a file directly between the sources and `deploy/`** with `cp` or an
   editor. Use the scripts.
5. **Read `git diff` before committing after `sanitize.sh`.** The substitution is
   textual and rewrites every occurrence of the home path.
6. `<name>` placeholders in prompts are the agent's, resolved at run time. Leave them
   alone. Only `{{NAME}}` is substituted by these scripts.

## Which command do I want?

| Situation | Run |
| --- | --- |
| Fresh machine, nothing set up | See "Setting up a machine" above |
| Changed a file in `prompts/` or `commands/` | `scripts/deploy-reviews.sh` |
| Changed a deployed file and tested it | `scripts/sanitize.sh` |
| Not sure whether anything drifted | `scripts/sanitize.sh --dry-run` |
| Deployed copy looks wrong or stale | `scripts/deploy-reviews.sh` to rebuild it |
| Pulled changes from GitHub | `scripts/deploy-reviews.sh` |

Both scripts are idempotent and safe to run when nothing has changed; they report
`0 changed` and exit successfully.
