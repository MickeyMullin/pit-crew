Follow the instructions in `{{HOME}}/agents/prompts/review/review-pr.md` in full. You are
running as Claude Code — also read and apply `{{HOME}}/agents/prompts/review/claude-code-notes.md`.

TARGET: $ARGUMENTS

Treat that as the PR to review, per the prompt's Target section: a PR number, a branch
name, or a PR URL. If it is empty, review the currently checked-out branch, which is the
prompt's default and needs no worktree.
