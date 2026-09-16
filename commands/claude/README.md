# Claude Code commands

Slash commands that invoke the prompts in [`prompts/`](../../prompts/). Each is a thin
wrapper: it points Claude Code at the prompt file and tells it to also load
`claude-code-notes.md`.

## Placeholder

These files are sanitized. The home directory root is written as the literal
placeholder `{{HOME}}`:

```
Follow the instructions in `{{HOME}}/agents/prompts/review/review-pr.md` in full.
```

Claude Code does **not** expand `{{HOME}}`, `$HOME`, or `~` inside a command file — the
path must be literal by the time Claude Code reads it. So substitution happens when the
command is deployed, not when it runs.

## Installing

From the repo root:

```bash
scripts/deploy-reviews.sh --install
```

That renders the commands with `{{HOME}}` replaced and copies them into
`~/.claude/commands/`, backing up whatever was there first. Without `--install` they are
rendered but **not** installed, and the run says so.

This is the step people forget. Prompts take effect the moment they are rendered,
because `agents/prompts` points into `deploy/`. Commands do not — Claude Code reads them
from `~/.claude/commands/`, so a command change stays invisible until it is installed.
Set `COMMANDS_TARGET` if yours live elsewhere.

This assumes the prompts are deployed to `$HOME/agents/prompts/review/`. If your
checkout lives elsewhere, see `HOME_SUBSTITUTE` in the root README.

Verify what landed:

```bash
grep -rl '{{HOME}}' ~/.claude/commands/ && echo "unsubstituted placeholders remain" || echo ok
```

## Updating

Commands are small and change rarely; the prompts they point at are where the real
churn is. To change one:

1. Edit the file **here**, keeping `{{HOME}}` as the placeholder — never commit a real
   home directory path back.
2. `scripts/deploy-reviews.sh --install`
3. Commit and push.

Going the other direction — you edited `~/.claude/commands/` directly and it works. **This one is yours to run, not an agent's**: it is the one place a file moves between the trees by hand, and it exists because the edit you are rescuing lives outside the repo entirely. Scope the glob if commands from other tools share that directory — it copies whatever matches.

```bash
cp ~/.claude/commands/*.md deploy/commands/claude/
scripts/sanitize.sh --dry-run
scripts/sanitize.sh
git diff -- commands
```

`sanitize.sh` re-placeholders the paths and verifies the round trip. Do **not** hand-run
a reverse `sed` over these files: it rewrites every occurrence of your home path
textually, and a missed one is exactly the leak this setup exists to prevent.

Do this before the next render, not after — rendering rebuilds `deploy/` from the
sources. It now refuses when `deploy/` holds unsanitized edits, and backs the tree up
either way, so a mistake here is recoverable.

See the root README's "The two directions" and "Rules" for the full workflow.

## Arguments

Two commands take an argument (`$ARGUMENTS`). `review-stack.md` takes the stack number,
or any PR number in the stack. `report-day.md` takes the day to report on — a date, a
weekday name, `yesterday`, or nothing for today — plus anything else worth telling it,
such as the meetings that left no trace on the machine. The rest take none.
