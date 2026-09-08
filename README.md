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
| `scripts/` | Deployment tooling. `deploy-reviews.sh` renders the sources into a runnable local copy. |
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

## Editing

Edit the sources here — never `deploy/`, whose contents are overwritten on every run.
Keep `{{HOME}}` as the placeholder; committing a real home path defeats the whole
arrangement. Then re-run `scripts/deploy-reviews.sh` to pick the change up locally.

Because `deploy/` sits between the repo and what actually runs, an agent editing a
prompt mid-review edits the rendered copy, not the repo. Bring such a change back by
hand, re-placeholdering the home path.
