# Commands

The prompts in [`prompts/`](../prompts/) are agent-agnostic. This directory holds the thin wrappers that let each agent invoke them by name, and there are two shapes of wrapper because the agents do not agree on one.

| Agent | Source here | Form | Installed to |
| --- | --- | --- | --- |
| Claude Code | `claude/<name>.md` | One flat markdown file per slash command | `~/.claude/commands/<name>.md` |
| Hermes | `skills/<name>/SKILL.md` | A skill directory with YAML frontmatter | `~/.hermes/skills/pit-crew/<name>/` |
| Codex (ChatGPT) | `skills/<name>/SKILL.md` | The same | `~/.codex/skills/<name>/` |

Hermes and Codex both read `SKILL.md` skill directories, so they share one source tree rather than each getting a near-identical copy to keep in sync. Claude Code needs its own, because its command files are flat markdown with no frontmatter and they additionally load `claude-code-notes.md`, which is Claude Code–specific and does not apply to the other two.

Every wrapper does the same small job: point the agent at the prompt file and tell it to follow that file rather than improvise. The prompt is where the real content lives; these files change rarely.

## Placeholder

These files are sanitized. The home directory root is written as the literal placeholder `{{HOME}}`:

```
Follow the instructions in `{{HOME}}/agents/prompts/review/review-pr.md` in full.
```

No agent expands `{{HOME}}`, `$HOME`, or `~` inside a command or skill file — the path must already be literal by the time the agent reads it. So substitution happens when the command is deployed, not when it runs.

## Installing

From the repo root:

```bash
scripts/deploy-reviews.sh --install
```

That renders every wrapper with `{{HOME}}` replaced, then installs for **each agent it finds on this machine**, backing up whatever was there first. An agent counts as found when its own directory exists — `~/.claude`, `~/.hermes/skills`, `~/.codex`. The run prints which agents it installed for and which it skipped, so a machine with only one of the three is a normal outcome, not an error.

To install for specific agents instead, name them:

```bash
scripts/deploy-reviews.sh --install=claude,codex
```

Naming an agent that is not installed here is an error rather than a skip: you asked for it explicitly, so a silent no-op would be the wrong answer.

Without `--install` the wrappers are rendered but **not** installed, and the run says so. This is the step people forget. Prompts take effect the moment they are rendered, because `agents/prompts` points into `deploy/`. Commands do not — each agent reads them from its own directory, so a command change stays invisible until it is installed.

If your directories are somewhere else, override the target per agent:

| Agent | Variable | Default |
| --- | --- | --- |
| Claude Code | `CLAUDE_COMMANDS_TARGET` | `$HOME/.claude/commands` |
| Hermes | `HERMES_SKILLS_TARGET` | `$HOME/.hermes/skills/pit-crew` |
| Codex | `CODEX_SKILLS_TARGET` | `$HOME/.codex/skills` |

`COMMANDS_TARGET` still works as an alias for `CLAUDE_COMMANDS_TARGET`.

Verify what landed:

```bash
grep -rl '{{HOME}}' ~/.claude/commands ~/.hermes/skills/pit-crew ~/.codex/skills 2>/dev/null && echo "unsubstituted placeholders remain" || echo ok
```

This assumes the prompts are deployed to `$HOME/agents/prompts/`. If your checkout lives elsewhere, see `HOME_SUBSTITUTE` in the root README.

## Why Hermes gets an extra directory level

Hermes discovers a `SKILL.md` at any depth under its skills directory and treats the directory above a skill as its category, so these install under `pit-crew/` rather than loose among your other skills. That groups them, matches the convention its own bundled skills use, and makes uninstalling them one `rm -r ~/.hermes/skills/pit-crew`. Codex takes its skills at the top level beside its own, so it gets no wrapper directory.

Hermes can also read skills from outside its own directory — set `skills.external_dirs` in `~/.hermes/config.yaml` to point at `deploy/commands/skills`, and skill changes take effect on render, with no install step. That is yours to configure; the scripts do not edit agent config files.

## Updating

Commands and skills are small and change rarely; the prompts they point at are where the real churn is. To change one:

1. Edit the file **here**, keeping `{{HOME}}` as the placeholder — never commit a real home directory path back.
2. `scripts/deploy-reviews.sh --install`
3. Commit and push.

Going the other direction — you edited an installed file directly and it works. **This one is yours to run, not an agent's**: it is the one place a file moves between the trees by hand, and it exists because the edit you are rescuing lives outside the repo entirely. Scope the copy if files from other tools share that directory — it copies whatever matches.

```bash
cp ~/.claude/commands/*.md deploy/commands/claude/
cp -R ~/.codex/skills/review-pr deploy/commands/skills/
scripts/sanitize.sh --dry-run
scripts/sanitize.sh
git diff -- commands
```

`sanitize.sh` re-placeholders the paths and verifies the round trip. Do **not** hand-write a reverse `sed` over these files: it rewrites every occurrence of your home path textually, and a missed one is exactly the leak this setup exists to prevent.

Do this before the next render, not after — rendering rebuilds `deploy/` from the sources. It refuses when `deploy/` holds unsanitized edits, and backs the tree up either way, so a mistake here is recoverable.

See the root README's "The two directions" and "Rules" for the full workflow.

## Arguments

Two of these take an argument. `review-stack` takes the stack number, or any PR number in the stack. `report-day` takes the day to report on — a date, a weekday name, `yesterday`, or nothing for today — plus anything else worth telling it, such as the meetings that left no trace on the machine. The rest take none.

Claude Code's command files interpolate it as `$ARGUMENTS`. The skills have no equivalent placeholder — a skill receives the invocation text as written — so each one tells the agent what to look for in the invocation and what to do when it carries nothing.
