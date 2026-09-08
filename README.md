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
| `backups/` | Generated, gitignored. Timestamped copies of whatever a deploy replaced. One-step undo. |

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
| `prompts/review/review-local.md` | Review uncommitted / local branch work before a PR exists. May fix its findings — see below. |
| `prompts/review/review-pr.md` | Review a single GitHub PR and post the report as a PR comment. On **your own** PR with findings, it may instead fix, verify, commit, and push — see below. |
| `prompts/review/review-stack.md` | Review a whole stack of PRs, posting one report on the top layer. Never fixes; posts automatically only on "approve". |
| `prompts/review/review-dependabot.md` | Review a Dependabot bump, accounting for rebases and re-bumps. |
| `prompts/review/claude-code-notes.md` | Claude Code–specific execution notes. Loaded alongside the prompt above when running under Claude Code; not applicable to other agents. |

### Fix mode

Two prompts can write; one deliberately cannot.

| Prompt | Can fix? | What it does with findings |
| --- | --- | --- |
| `review-local` | Yes | WIP-commits your in-flight work, then edits the tree. Offers three ways to finish. |
| `review-pr` | Yes, own PR only | Fixes, verifies, commits, pushes, re-reviews once. |
| `review-stack` | **No** | Reports only. Posts to the top PR automatically on "approve" alone. |

Both fixing prompts share the same shape: assess whether the current model and effort
suit the findings and say so; fix and verify; re-review **once** from scratch, because a
fix can introduce a new problem. If that second pass finds anything at all, stop and ask
rather than fixing again. The count lives in the report's `Fix attempts:` line, so the
bound survives across separate invocations rather than only within one session. Any stop
that offers to delegate must supply a ready-to-paste handoff prompt with real paths,
branch, and SHAs resolved.

They stop and ask when a higher-effort model is warranted, or when a finding needs
design judgment — concurrency, security, architecture, data migration — rather than a
mechanical correction.

**`review-pr` additionally gates on authorship**, matching `gh api user` against the PR
author login. It never infers ownership from the checked-out branch: a reviewer
routinely has someone else's branch checked out, which is exactly when a wrong guess
would push commits to a PR that isn't theirs. Bot-authored PRs, Dependabot included,
fail that check. On a stacked PR, a fix belonging in a lower layer is a stop-and-ask,
never a patch applied one layer up.

**`review-local` is the one to run first**, before a PR exists. It has no authorship gate
— uncommitted local work is yours by definition — but it is the only one editing changes
that exist in no commit and no remote, so it protects them with git rather than around
it: before touching anything it commits your in-flight work as a WIP commit and records
the SHAs either side of it. Its own fixes stay uncommitted on top, so the boundary
between your work and its stays visible in `git diff`.

It then offers three ways to finish, and runs none of them unasked:

| You want | It offers |
| --- | --- |
| The fixes, uncommitted | `git reset --mixed <pre-WIP>` — as if you'd made them by hand |
| The fixes discarded | `git reset --hard <WIP>` then `git reset --mixed <pre-WIP>` |
| The fixes committed | `git commit --amend` onto the WIP, with a real message you supply |

The `--hard` is safe only because it targets the WIP commit holding all your work; the
prompt is required to say so, and to note that restoring returns everything unstaged, so
a partly staged index is not reconstructed. Nothing else is relaxed — it still may not
run `stash`, `checkout`, `reset`, or `clean` itself.

**`review-stack` deliberately has no fix mode**, and the prompt says so explicitly so it
is not improvised back in. A fix belongs in the layer that introduced the problem,
changing that layer invalidates every layer above it, and restacking rewrites branches
that may already be reviewed. That is not a one-pass automatic operation.

It also posts automatically **only** on an "approve" verdict. Both "fix before merge" and
"do not merge" write the report and print it, then ask before commenting: each means the
stack is still moving, so posting pins a findings list to a top PR whose SHAs the fixes
will invalidate, and puts a public verdict on someone's stack before its author has read
it. An "approve" does not go stale that way and has nothing to respond to.

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
scripts/deploy-reviews.sh            # render into deploy/
scripts/deploy-reviews.sh --install  # and install the commands into ~/.claude/commands
```

Renders sources into `deploy/`, substituting `{{HOME}}`. Prompts take effect
immediately, because `agents/prompts` points into `deploy/`; **commands do not** — they
must be copied into `~/.claude/commands/`, which is what `--install` does.

It renders to a staging directory and swaps it in only after every check passes, so an
interrupted run cannot leave a half-rendered tree for an agent to read. It refuses to
run at all if `deploy/` holds edits that never made it back to the sources — rendering
would discard them and `deploy/` is gitignored, so nothing else would have them. Run
`sanitize.sh` to keep those edits, or `--force` to discard them deliberately.

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

### Backups and undo

Every deploy first copies what it is about to replace into `backups/<timestamp>/` — the
outgoing `deploy/` tree, and with `--install` the commands already in
`~/.claude/commands/`. Neither of those has a git safety net, so this directory is their
only undo. The run prints the exact restore commands:

```bash
cp -R backups/<timestamp>/deploy/. deploy/
cp -R backups/<timestamp>/claude-commands/. ~/.claude/commands/
```

`backups/` is gitignored and grows on every run; prune it whenever you like. The
committed sources are not backed up here — git already covers those.

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
| Changed a file in `prompts/` | `scripts/deploy-reviews.sh` |
| Changed a file in `commands/` | `scripts/deploy-reviews.sh --install` |
| Changed a deployed file and tested it | `scripts/sanitize.sh` |
| Not sure whether anything drifted | `scripts/sanitize.sh --dry-run` |
| Deployed copy looks wrong or stale | `scripts/deploy-reviews.sh` to rebuild it |
| Pulled changes from GitHub | `scripts/deploy-reviews.sh --install` |
| Need to undo a deploy | `cp -R backups/<timestamp>/deploy/. deploy/` |
| Deploy refused: unsanitized edits | `scripts/sanitize.sh` to keep them, `--force` to discard |

Both scripts are idempotent and safe to run when nothing has changed; they report
`0 changed` and exit successfully.
