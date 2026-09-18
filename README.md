# pit-crew

Prompts, scripts, and scheduled jobs that service the repo so agents can review PRs and keep the shop running.

This is the source of truth for the code-review prompts I run through Claude Code,
Hermes, and Codex. The prompts themselves are agent-agnostic; each agent gets a thin
wrapper that invokes them by name. The prompts live here; the local machine points at a
rendered copy of this repo rather than holding its own.

## Layout

| Path | What's in it |
| --- | --- |
| `prompts/review/` | Code-review prompts, plus agent-specific execution notes. Agent-agnostic except where noted. |
| `prompts/document/` | Documentation prompts: build a handover dossier for an area, and derive a client-facing version of it. |
| `prompts/report/` | Reporting prompts: reconstruct a day's work from the machine's own records. |
| `commands/claude/` | Claude Code slash commands that invoke the prompts. |
| `commands/skills/` | The same commands as `SKILL.md` skills, for Hermes and Codex. Both read the same format, so they share one tree. See [commands/README.md](commands/README.md). |
| `scripts/` | The two directions. `deploy-reviews.sh` renders sources into a runnable copy; `sanitize.sh` brings tested edits back. |
| `TODO.md` | Open decisions not yet made. |
| `LICENSE` | MIT. |
| `deploy/` | Generated, gitignored. The rendered output — the only place real home paths exist. |
| `backups/` | Generated, gitignored. Timestamped copies of whatever a deploy replaced. One-step undo. |

`prompts/` is grouped by job so later families (triage, release, maintenance) sit
alongside `review/`, `document/`, and `report/` rather than crowding them. The scripts walk `prompts/`
recursively, so adding a family is just adding a directory — nothing needs teaching.

## Sanitization

**No machine-specific path appears anywhere in this repo, including its git history.**
Every home directory root is written as the literal placeholder `{{HOME}}`:

```
gh pr comment <number> --body-file {{HOME}}/agents/output/PR-<number>.md
```

Nothing that reads these files expands the placeholder on its own. No agent expands
`{{HOME}}`, `$HOME`, or `~` inside a command or skill file, and an agent reading a prompt
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
| `prompts/review/review-pr.md` | Review a single GitHub PR and post the report — as an approval, a request-changes review, or a comment, depending on what it found. On **your own** PR with findings, it may instead fix, verify, commit, and push — see below. |
| `prompts/review/review-stack.md` | Review a whole stack of PRs, posting one report on the top layer — as an approval, a request-changes review, or a comment. Never fixes, and never posts without being asked. |
| `prompts/review/review-dependabot.md` | Review a Dependabot bump, accounting for rebases and re-bumps. |
| `prompts/review/claude-code-notes.md` | Claude Code–specific execution notes. Loaded alongside the prompt above when running under Claude Code; the Hermes and Codex skills say explicitly not to load it. |

### Fix mode

Two prompts can write; one deliberately cannot.

| Prompt | Can fix? | What it does with findings |
| --- | --- | --- |
| `review-local` | Yes | WIP-commits your in-flight work, then edits the tree. Offers three ways to finish. |
| `review-pr` | Yes, own PR only | Fixes, verifies, commits, pushes, re-reviews once. Never comments on your own PR unasked. |
| `review-stack` | **No** | Reports only. Never posts on any stack unasked. |

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

**On someone else's PR, the verdict is the form of the post**, not a line of prose in it:
any P0 or P1 submits a request-changes review, a clean or P3-only review submits an
approval, and a P2 in between posts a plain comment. One post, carrying the whole report.

**On your own PR, `review-pr` never posts on its own initiative** — no comment, no
approval, no request-changes. Findings get fixed rather than reported back to you; a
clean review is reported in chat. Either way the report file is still written — it is the
durable record, and the chat response is the notification. GitHub rejects a self-approval
outright, and an "approve, no findings" comment on your own PR only adds noise to a
thread other people have to scan. It posts unprompted only on someone else's PR, or on
yours after asking and being told yes.

**`review-pr` gates all of that on authorship**, matching `gh api user` against the PR
author login, on every run rather than only when findings exist. It never infers ownership from the checked-out branch: a reviewer
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

Its posting rules mirror `review-pr`'s, including the form: a P0 or P1 is a
request-changes review, a clean or P3-only stack is an approval, a P2 in between is a
plain comment — one post, on the top layer's PR only.

**Whether** it posts is a separate question from **how**, and that is where it diverges:
`review-stack` posts nothing without being told to, for any verdict. It writes the
report, prints it, names the form it would use, and asks. Each form has its own reason
for that. A findings verdict means the stack is still moving, so posting pins a list of
problems to a top PR whose SHAs the fixes will invalidate. A request-changes review goes
further and blocks that PR until someone dismisses it. And an approval is a real review —
on someone else's stack it can satisfy a required-review gate, so it may be the thing
that lets the stack merge, which is not a decision to make on a reviewer's behalf.

Naming the form is the point of asking: "post the report?" and "submit an approval that
may unblock this stack?" are different questions. On your own top PR it does not even
ask, since GitHub rejects a self-approval and a self-addressed comment is just noise.

Authorship is checked against the **top layer's** PR, the only one this review ever
comments on, and never inferred from the checkout — this prompt checks out the top
branch as a matter of course. On your own stack it therefore never posts unprompted, for
any verdict. One case it raises rather than deciding silently: if your stack contains
layers by other authors, an approve is the verdict they might want recorded, so it says
so and offers to post. The authorship check grants nothing else — it decides posting
only, and never licenses fixing.

### Reviewing a branch you don't have checked out

`review-pr` and `review-stack` both take a target, so you do not have to set up a
worktree by hand first:

```
/review-pr 482
/review-pr atomic-feedback-lineage
/review-pr https://github.com/MickeyMullin/example/pull/482
/review-stack 13
```

Each accepts a PR number, a branch name, or a PR URL; `review-stack` also takes a stack
number, and resolves a branch or PR to the stack containing it. A bare number is read as
a PR number first, since branches named for a number are rare. A branch with no PR stops
the run and points at `review-local`, which is the prompt for work that has not become a
PR yet.

**A named target is reviewed in a throwaway worktree** under `{{HOME}}/agents/worktrees/`,
never by checking it out in your working copy. That is the whole point of naming one:
your in-flight work is untouched, and a dirty tree does not block the review. The
worktree is detached at `origin/<branch>` — a local branch of that name may be stale, or
checked out elsewhere, which would make the add fail — and it is removed when the review
finishes. If removal refuses because something is in it, the run says so and leaves it
rather than forcing.

`review-pr` with **no** target keeps the original behavior: it reviews the branch you have
checked out, in place, with no worktree. In fix mode from a worktree, it pushes with
`git push origin HEAD:<branch>`, which cannot update the wrong branch.

Citations stay repo-relative either way. The worktree path is scaffolding and never
appears in a report.

### Report output

The PR-writing prompts write their full report to `{{HOME}}/agents/output/` before posting
anything to GitHub, so a failed post never loses the review. That directory is
referenced by absolute path — deliberately, so it stays stable across clones and
worktrees rather than following the repo you happen to be reviewing.

## The documentation prompts

| Prompt | Use |
| --- | --- |
| `prompts/document/document-handoff.md` | Build a self-contained HTML dossier for one area of an application, for an engineer taking ownership of it. |
| `prompts/document/document-client.md` | Transform that dossier into a client-facing overview of the same area. |

Both write to `.local/<area-slug>/` in the target repo, which is gitignored there:
`index.html` for the dossier, `client.html` for the client page. The dossier is the
source of truth; the client page is derived from it and never overwrites it.

### Incremental updates

Every page records the commit it describes in a one-line `doc-provenance` HTML comment,
and shows the reader a visible provenance line (the dossier shows the SHA; the client
page shows only a date). A re-run reads that marker and works from
`git diff <prior-sha>..HEAD` rather than exploring the whole tree again — updating the
sections the changed files feed and leaving the rest alone. If nothing in the area
changed, it rewrites nothing and just records the new commit.

Two things make that safe rather than merely fast. It verifies the prior SHA is still an
ancestor of HEAD, because after a rebase or squash a diff against it would be fiction —
if it isn't, it rebuilds. And it re-runs the **non-local** verification passes whenever
anything changed anywhere in the repo, not just inside the area: an import deleted in a
distant file is exactly what turns one of the area's exports dead, and that never shows
up in the area's own diff.

Finding ids are stable across runs and resolved findings stay in the table, marked
resolved. Each page keeps a Documentation history section listing every run.

### Client pages and findings

`document-client.md` strips handover framing, internal paths, and engineering furniture,
and leads with a plain-language section a non-technical stakeholder can read start to
finish. It keeps the parts a client actually needs: how each number is computed, where
the data comes from, what was reconciled against what, and what the area deliberately
does not do.

Findings are the one part it will not decide alone. It lists them in chat grouped by
what it would omit, what it would restate as a limitation, and what it must not publish
without explicit say-so — then defaults to omitting. **It will never publish an
access-control or data-exposure finding on its own judgment**, even when other findings
have been approved: that is a security disclosure, and it belongs in a conversation with
a named owner rather than in a document that may be forwarded onward.

## The reporting prompt

| Prompt | Use |
| --- | --- |
| `prompts/report/report-day.md` | Reconstruct one day's work from Claude Code transcripts, git history, and GitHub activity — shaped for filling in a timesheet. |

Takes a date, a weekday name, `yesterday`, or nothing (today). It reads
`~/.claude/projects/**/*.jsonl` for what you asked agents to do, `git log --all` across
your working copies for what landed, and `gh` for the PRs and review comments you posted,
then groups the day into blocks and proposes a timesheet split.

It is strictly read-only apart from its own report, and it never posts anywhere — a day's
record names clients, branches, and unreleased work. Output goes to
`{{HOME}}/agents/output/day-<YYYY-MM-DD>.md`.

Two things it will not do: estimate hours from message volume, or invent the meetings.
Nothing offline reaches the transcripts, so tell it about them in the invocation — it
places them as given, and otherwise just points at the quiet hours where something
clearly happened.

```
/report-day Tuesday. Outside of Claude I had a 9am standup, a 1pm scope meeting, and 3pm co-work.
```

## Setting up a machine

These steps are written to be followed by a person or by an agent, in order, without
consulting anything else. Run them from a shell with `git` available. Every command is
literal apart from the clone path, which is yours to choose.

**1. Clone the repo and render the runnable copy.**

```bash
git clone git@github.com:MickeyMullin/pit-crew.git
cd pit-crew
scripts/deploy-reviews.sh --install
```

`scripts/deploy-reviews.sh` renders `prompts/` and `commands/` into `deploy/`, replacing
`{{HOME}}` with your real home directory. `--install` then installs the command wrappers
for **every supported agent it finds on this machine** and prints which ones it installed
for and which it skipped. Skipping an agent you do not have is the expected outcome, not
a failure. To install for specific agents only, use `--install=claude`, or any
comma-separated subset of `claude,hermes,codex`.

Expected: the run ends with `N file(s) rendered, no placeholders remaining.` and one
`installing <agent> into <path>` block per agent. If it exits non-zero, stop and read the
error — every failure mode it has is described in the message it prints.

**2. Point `agents/prompts` at the rendered copy.**

```bash
mkdir -p "$HOME/agents/output" "$HOME/agents/worktrees"
ln -sfn "$PWD/deploy/prompts" "$HOME/agents/prompts"
```

The command wrappers all reference `$HOME/agents/prompts/...` by absolute path, so this
symlink is what makes them resolve. The deploy script prints this exact line with real
paths filled in but never runs it, because it writes outside the repo. `agents/output/`
is where the review prompts write their reports before posting anything, and
`agents/worktrees/` is where they check out a branch you named rather than one you have
checked out — see "Reviewing a branch you don't have checked out" below.

**3. Confirm the install for your agent.** Each agent reads its commands from a different
place, and none of them pick up a change until the file is in that place.

| Agent | What was installed | Verify | Invoke as |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/commands/<name>.md` | `ls ~/.claude/commands` | `/review-pr` |
| Hermes | `~/.hermes/skills/pit-crew/<name>/SKILL.md` | `ls ~/.hermes/skills/pit-crew` | `/review-pr`, or ask for the skill by name |
| Codex | `~/.codex/skills/<name>/SKILL.md` | `ls ~/.codex/skills` | `/review-pr`, or ask for the skill by name |

Claude Code takes flat markdown slash commands; Hermes and Codex take `SKILL.md` skill
directories, and share one source tree because they read the same format. Restart or
reload the agent if it does not see a newly installed command — most discover commands at
startup.

**4. Check that no placeholder survived.** A `{{HOME}}` reaching an installed file means
the render did not substitute it, and the agent will look for a directory literally named
`{{HOME}}`.

```bash
grep -rl '{{HOME}}' ~/.claude/commands ~/.hermes/skills/pit-crew ~/.codex/skills 2>/dev/null && echo "BROKEN: unsubstituted placeholders" || echo ok
```

Expected: `ok`.

**If your directories are elsewhere**, set the target before running the install —
`CLAUDE_COMMANDS_TARGET`, `HERMES_SKILLS_TARGET`, or `CODEX_SKILLS_TARGET`. If your
checkout renders for a different account, set `HOME_SUBSTITUTE`; the install targets
follow it, so the installed files and the account they point at stay consistent.

Per-agent detail, including the Hermes `external_dirs` route that skips the install step
entirely, is in [commands/README.md](commands/README.md).

## The two directions

Sources are committed and always use `{{HOME}}`. `deploy/` is gitignored, holds real
paths, and is what actually runs. Changes flow **both ways**, and each direction has a
script. Never move files between them by hand.

```
                      scripts/deploy-reviews.sh  ->
  prompts/review/*.md                                 deploy/prompts/review/*.md
  commands/claude/*.md                                deploy/commands/claude/*.md
  commands/skills/*/SKILL.md                          deploy/commands/skills/*/SKILL.md
  (committed, {{HOME}})                               (gitignored, real paths, runs)
                      <-  scripts/sanitize.sh
```

### Direction 1: you edited a source, and want to run it

```bash
scripts/deploy-reviews.sh                  # render into deploy/
scripts/deploy-reviews.sh --install        # and install for every agent found here
scripts/deploy-reviews.sh --install=codex  # or for named agents only
```

Renders sources into `deploy/`, substituting `{{HOME}}`. Prompts take effect
immediately, because `agents/prompts` points into `deploy/`; **commands do not** — they
must be copied into each agent's own directory, which is what `--install` does, for every
agent it finds here.

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
outgoing `deploy/` tree, and with `--install` whatever each agent already had installed,
under `<agent>-commands/`. Neither of those has a git safety net, so this directory is
their only undo. The run prints the exact restore commands for the agents it touched:

```bash
cp -R backups/<timestamp>/deploy/. deploy/
cp -R backups/<timestamp>/claude-commands/. ~/.claude/commands/
cp -R backups/<timestamp>/codex-commands/. ~/.codex/skills/
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
| Set up a second agent on a machine | `scripts/deploy-reviews.sh --install` — it installs for whatever it finds |
| Changed a deployed file and tested it | `scripts/sanitize.sh` |
| Not sure whether anything drifted | `scripts/sanitize.sh --dry-run` |
| Deployed copy looks wrong or stale | `scripts/deploy-reviews.sh` to rebuild it |
| Pulled changes from GitHub | `scripts/deploy-reviews.sh --install` |
| Need to undo a deploy | `cp -R backups/<timestamp>/deploy/. deploy/` |
| Deploy refused: unsanitized edits | `scripts/sanitize.sh` to keep them, `--force` to discard |

Both scripts are idempotent and safe to run when nothing has changed; they report
`0 changed` and exit successfully.
