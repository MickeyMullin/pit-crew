---
name: update-pr
description: Bring your own PR up to date with the primary branch. Rebases its branch onto it by default, merges it in only when a rebase is not workable (others have commits on the branch, or it is part of a stack), resolves conflicts, and pushes. A rebase is pushed only with --force-with-lease, and the push is its only GitHub write. Stops to ask when a conflict needs judgment. Add --head=<sha> to pin the head you saw, and --emit-json=<run-dir> to also write machine-readable progress and results to that directory.
---

# Update your own PR from the primary branch

Follow the instructions in `{{HOME}}/agents/prompts/update/update-pr.md` in full. That file is the whole specification for this task — read it before doing anything else, and follow it as written rather than substituting your own process.

The invocation may name the PR to update — a PR number, a branch name, or a PR URL. Pass it to the prompt and follow its Target section, which confirms the PR is yours and makes the update in a throwaway worktree. If the invocation names nothing, the prompt takes the PR of the currently checked-out branch, as its Arguments section says; that is its default, not an error.

If the invocation includes `--head=<sha>` or `--emit-json=<run-dir>`, those flags are not part of the target. The prompt's Arguments and Machine-readable output sections cover them: remove the flags, read the shared file the latter names when `--emit-json` is present, and resolve the rest as the target. Any other flag is bad usage under the prompt's Arguments section.

The prompt is written to be agent-agnostic. `claude-code-notes.md` sits beside the review prompts and is **not** part of this skill: it covers Claude Code's own execution quirks and does not apply here. Ignore any instruction in the prompt to load it unless you are in fact running as Claude Code.

If the prompt file is not there, stop and say so rather than improvising from this description. Its path is fixed when the skill is installed, so a missing file means the install is incomplete — not that you should carry on without it.
