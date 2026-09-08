# Claude Code commands

Slash commands that invoke the prompts in [`prompts/review/`](../../prompts/review/).
Each is a thin wrapper: it points Claude Code at the prompt file and tells it to also
load `claude-code-notes.md`.

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
scripts/deploy-reviews.sh
cp deploy/commands/claude/review-*.md "$HOME/.claude/commands/"
```

The script renders the commands into `deploy/commands/claude/` with `{{HOME}}` replaced,
and refuses to finish if any placeholder survives. It stops short of the copy because
that writes outside the repo; it prints the exact command with paths filled in.

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
2. Commit and push.
3. Re-run the two install commands above.

Going the other direction — you edited `~/.claude/commands/` directly and want the
change in the repo — re-placeholder it on the way back:

```bash
for f in ~/.claude/commands/review-*.md; do sed "s|$HOME|{{HOME}}|g" "$f" > "commands/claude/$(basename "$f")"; done
git diff commands/claude/
```

Read that diff before committing. The reverse substitution is textual and rewrites every
occurrence of your home path, not only the intended one — and a missed one is exactly
the leak this setup exists to prevent.

## Arguments

`review-stack.md` is the only command that takes an argument (`$ARGUMENTS`) — the stack
number, or any PR number in the stack. The others take none.
