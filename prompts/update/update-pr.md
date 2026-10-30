Bring one of your own pull requests up to date with the repository's primary branch (its default branch, `main` or `master`): rebase the PR's branch onto it by default, merge the primary branch into it instead only when a rebase is not workable, resolve any conflicts, and push the result to the PR's branch. This command never reviews the code, never changes anything but what the update and its conflicts need, and never acts on anyone else's PR.

**Pushing the PR's branch is the only GitHub write this command performs, and it happens at most once per run.** A rebase is pushed only with `--force-with-lease`, pinned to the head SHA the run read, so a push that anyone made since is never overwritten; a merge is pushed without force. No other branch is ever pushed, the primary branch least of all, and no commit already on the primary branch is ever rewritten. No review, comment, or reply of any kind, no edit to the PR's title, body, labels, reviewers, base, or draft state, no merge of the PR, and no workflow re-run. Every `gh` call this command makes is a read. `gh api graphql` carries a `query` only, never a `mutation`. Every other `gh api` call passes `--method GET` whenever it passes any field or input (`-f`, `-F`, `--field`, `--raw-field`, or `--input`), because `gh api` switches to `POST` as soon as one is given.

Arguments:

- The invocation may carry, in any order:
  - one target: a PR number, with or without a leading `#` (`482`, `#482`), a branch name (`atomic-feedback-lineage`), or a GitHub PR URL (`https://github.com/<owner>/<repo>/pull/482`), resolved under "Target" below.
  - `--head=<sha>`: the full 40-character head SHA you saw when you asked for the update. The run refuses to touch the branch unless the PR's head is still exactly that commit, and uses it as the push's lease.
  - `--emit-json=<run-dir>`: also record the run's progress and result as JSON in that directory, as "Machine-readable output" below describes. It is checked and removed before anything else is read.
- **Anything else is bad usage: say what you could not read and stop**, rather than guessing. That includes any other flag (there is no `--merge`, `--rebase`, `--force`, or `--no-verify`), a second target, a `--head` that is not a full 40-character hexadecimal SHA, and a flag with a value it does not take. The method is never the caller's to choose: "Choosing the method" below decides it.
- **If the invocation names no target, take the PR of the branch checked out in this working directory** (`gh pr view --json number,headRefName,author,state`), say which PR that is, and proceed exactly as if its number had been named. That still means a throwaway worktree: this command never rebases, merges, commits, or pushes from the checkout it was started in. If the checked-out branch has no PR, stop and say so.

Re-runs:

- **A terse request to go again repeats the prior invocation** with the same target, after fetching the latest remote state. Explicit words in the new message win.
- **Neither `--emit-json` nor `--head` carries over.** The run directory belongs to the earlier run, and the head you confirmed then may no longer be the head; a repeated run reads the head afresh and leases on that. Say so in chat before starting. A session that continues after a stop to ask, with you answering the question, is not a repeat: it keeps both (see `emit-json.md`).

Machine-readable output:

- If the invocation contains `--emit-json=<run-dir>`, read `{{HOME}}/agents/prompts/review/emit-json.md` in full before doing anything else, check the run directory as it says, remove the flag, and read what remains under "Arguments" above. That file says what to write to `<run-dir>` and when, and holds this command's `pit-crew/update-result@1` schema; it changes nothing this prompt allows or requires. Without the flag, ignore it.
- With the flag, record each of the five steps as `emit-json.md` describes, at the points this prompt marks. Record `resolveBase` `started` before resolving the target. In this command the steps cover:
  - `resolveBase`: resolving the PR, the clone, authorship, state, and push-target checks, the fetch, the head SHA, and the primary branch with its SHA.
  - `review`: choosing the method.
  - `consolidate`: the rebase or merge, resolving its conflicts, and the checks.
  - `writeReport`: this command writes no report file, so it is always recorded once as `skipped` with the note `no report file`, right after `consolidate` ends or is skipped.
  - `post`: the push, from the decision whether to push through the push landing.
- **Already up to date is not a failure.** When the head already contains the primary branch's SHA, record `resolveBase` `done` as usual, then `review` `skipped` and `consolidate` `skipped` with the note `already up to date`, then `writeReport` as above, then `post` `skipped` with the note `already up to date`, and write `result.json` as `"done"`.
- Each of this prompt's instructions to stop and say so is a failure under `emit-json.md`; each instruction to stop and ask is a `"needsInput"` stop. A refused push is a failure here, not the "failed post" that `emit-json.md` treats as done.

Target:

- **First confirm the clone.** Read the repository this working directory points at with `gh repo view --json nameWithOwner`; if that fails, stop and say so. Then confirm that the `origin` remote names that same `<owner>/<repo>` both for fetching (`git remote get-url origin`) and for pushing (`git remote get-url --push origin`); if either names another, stop and say so. This command pushes to `origin` and nowhere else.
- **Then resolve the target**, and say which form you took it as: a URL (whose repo must be this one, or stop and say so), all digits (a PR number, and only if no such PR exists a branch name), or anything else (a branch name), each with `gh pr view <target> --json number,headRefName,baseRefName,author,state,isCrossRepository,headRefOid,url`. If a branch has no PR, stop and say so.
- **Confirm authorship next, before acting on anything else about the PR.** Compare `gh api user --jq '.login'` against `gh pr view <number> --json author --jq '.author.login'`. Continue only on an exact match. If the two differ, either lookup fails, or the PR is authored by a bot or an org account, this is not your PR: stop and say so. Never infer authorship from the branch name, from `git config user.email`, or from the fact that the branch is checked out locally. Call the matched login "the owner" below.
- **If the PR is closed or merged, stop and say so. If it comes from a fork (`isCrossRepository` is true), stop and say so**: its branch is not on `origin`.
- **Resolve the primary branch**: `gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'`. **If the PR's base branch is not the primary branch, stop and say so.** This command updates only PRs that target the primary branch: an upper layer of a stack is brought up to date by updating the layer below it, which is not this command's work. **If the PR's head branch is the primary branch, stop and say so.**
- Fetch, and record what the run reads:

```
git worktree prune
git fetch origin
git rev-parse origin/<branch>
git rev-parse origin/<primary>
```

- The first full 40-character SHA is the **head SHA**, the second the **upstream SHA**. Everything below is pinned to these two. If the head SHA differs from the PR's `headRefOid`, fetch once more and compare again; if they still differ, stop and say so, since the head is moving while you read it.
- **With `--head=<sha>`, the head SHA must be that SHA**, compared without regard to letter case. If it is not, stop and say so, naming both: the branch has moved since you asked for the update, and updating it now would act on commits you have not seen. Never fall back to the newer head.
- **If the head SHA already contains the upstream SHA** (`git merge-base --is-ancestor <upstream-sha> <head-sha>` succeeds), the branch is already up to date: create no worktree, push nothing, say so, and finish.
- With `--emit-json`, record `resolveBase` `done` once the upstream SHA is read, with the PR number, the short head SHA, and the primary branch with its short SHA in its note, and `review` `started` before choosing the method.

Choosing the method:

- **Rebase is the default.** Merge instead only when at least one of these holds, and say which:
  - **The branch is shared**: someone other than the owner has commits on it. Read every commit in the PR with `gh api --method GET --paginate repos/<owner>/<repo>/pulls/<number>/commits`; a commit is someone else's when its `author.login` or its `committer.login` is not the owner's, or is missing, except that a `committer.login` of `web-flow` (GitHub's own committer for commits made in its interface) does not count. Others who have pushed to the branch may have it checked out, and a rebase would rewrite the commits under them.
  - **The branch is part of a stack**: another open PR uses this PR's head branch as its base (`gh pr list --state open --base <branch> --json number,headRefName`). A rebase would leave every layer above it to be restacked.
  - **The branch already holds a merge commit** (`git rev-list --merges --count <merge-base>..<head-sha>` is above 0, where `<merge-base>` is `git merge-base <upstream-sha> <head-sha>`): an earlier update merged, and a rebase would flatten that history.
- Nothing else makes a rebase unworkable: not the number of commits, not the number of conflicts you expect, and not a preference. The method is decided by these rules alone, and is never asked about.
- With `--emit-json`, record `review` `done` with the method and the reason in its note.

Making the update:

- With `--emit-json`, record `consolidate` `started` before the worktree is created.
- **Check that the head has not moved**, then create a throwaway worktree, detached, pinned to the head SHA:

```
git fetch origin
git rev-parse origin/<branch>
git worktree add --detach {{HOME}}/agents/worktrees/<repo>-update-<number>-<timestamp> <head-sha>
```

- If `origin/<branch>` is no longer the head SHA, someone pushed while you chose: stop and say so, as under "Target". Never move on to the newer head.
- **Do everything inside the worktree.** Cite repo-relative paths, never worktree-absolute ones, in chat and in any commit message.
- **Rebase**: `git rebase <upstream-sha>`. **Merge**: `git merge --no-ff -m "Merge <primary> into <branch>" <upstream-sha>`; after resolving its conflicts, `git commit --no-edit` keeps that message. Name the upstream by its SHA, never by a branch name that could move.
- **Commit messages**: a commit you write (a merge commit, or a rebased commit whose conflict you resolved, which keeps its own message) carries no links, no `#<number>` or `GH-<number>` references, no `@` mentions, and no AI attribution: no co-author trailer, no "generated with" line, no model, provider, or agent name. Never `--no-verify`.

Resolving conflicts:

- **Resolve each conflict so the result keeps what both sides meant**: the primary branch's change and the PR's change. A conflict is clear when the two sides change independent or adjacent parts of a file, when one side moved or renamed what the other edited (the edit follows the move), or when both made the same change. Never resolve by taking one side wholesale (`-X ours`, `-X theirs`, or `git checkout --ours` or `--theirs` of a whole file) unless that is the right resolution for that file, and say so when it is.
- **A conflict needs your judgment when** both sides changed the same logic in ways that cannot both hold, when resolving it means dropping either side's behavior, when it is in a file the repository's tooling runs (a package manifest's scripts or dependencies, a lockfile, package-manager config, a task-runner file, CI workflows or config, git hooks, or build or test config that runs code), or when you are unsure.
- **At a conflict that needs judgment, stop and ask.** Abort the rebase or merge (`git rebase --abort` or `git merge --abort`), remove the worktree, which then holds nothing, as "Cleanup" describes, and ask in chat about every conflict that needs judgment: its path, what each side changed, and the choices you see. Do not pick one, and do not resolve the others first while waiting. With `--emit-json`, `consolidate` stays started, and `result.json` is `"needsInput"` with `notPushedReason` `awaitingAnswer`.
- **When the owner answers in the same session**, start again from the head check under "Making the update", resolving those conflicts as the answer directs. Act only on explicit words, never on silence; a conflict the answer does not settle is asked again.
- **Change nothing but the conflicts.** No cleanup, reformatting, dependency change, or fix that the update does not need, even one that looks obviously right.
- Record every file whose conflict you resolved, with one line on how.

Verifying:

- **When any conflict was resolved, run the repo's checks once**, after the rebase or merge has finished: its tests, build, lint, and type check, as applicable to what you touched, found where the repo says (its contributor and agent instructions, its package scripts or Makefile, or its CI workflow). Install dependencies first in the repo's frozen or locked mode (`pnpm install --frozen-lockfile`, `npm ci`, and the like), and run each check in its verifying mode, never one that rewrites files.
- **When no conflict needed resolving, run no checks**: the update replayed or merged commits git could combine by itself, and CI runs on the push.
- **That one run is the verification.** If a check fails, or the checks cannot run, do not edit, commit, or re-run to make them pass: stop and ask under "Pushing".
- With `--emit-json`, record `consolidate` `done` once the update is made and the checks have run, or failed to, with the method, the number of conflicts resolved, and the checks' outcome in its note, then `writeReport` `skipped` with the note `no report file`.

Pushing:

- With `--emit-json`, record `post` `started` when you begin deciding the push, the checks gate included.
- **Check the result before pushing**, and stop and say so if either fails: the new head contains the upstream SHA (`git merge-base --is-ancestor <upstream-sha> HEAD`), so no commit of the primary branch was rewritten or dropped; and the PR still has commits of its own (`git rev-list --count <upstream-sha>..HEAD` is above 0), since a branch reduced to the primary branch would empty the PR.
- **Push only when every check that applies ran and passed.** Otherwise do not push: when a check failed, or the checks could not run, stop and ask whether to push anyway or discard the update. Leave the worktree in place and name it, with its head. With `--emit-json`, `post` stays started, and `result.json` is `"needsInput"` with `notPushedReason` `checksFailed` or `checksNotRun`. When the owner answers, push as below only on an explicit yes; to discard, remove the worktree as "Cleanup" describes, and finish `"done"` with that reason kept.
- Otherwise push, from the worktree, naming the remote branch explicitly:

```
# a rebase: rewritten commits, so a lease on the head SHA the run read
git push --force-with-lease=refs/heads/<branch>:<head-sha> origin HEAD:refs/heads/<branch>
# a merge: new commits only
git push origin HEAD:refs/heads/<branch>
```

- **Never `--force`, a `+` refspec, `--force-with-lease` without the explicit `<branch>:<head-sha>`, `--no-verify`, or any other destination.** The lease names the head SHA, not a remote-tracking ref, so a fetch made meanwhile cannot widen it.
- **A refused push is a failure, never retried.** If the push is refused (the lease failed because the branch moved, a non-fast-forward, a denied permission, or a rejecting hook), do not fetch and rebase again, do not retry, and never force. Leave the worktree in place, say so with git's error and the worktree's path, and stop. With `--emit-json`, `post` stays started, and `result.json` is `"failed"` with `notPushedReason` `pushFailed` and git's error in `error`.
- Once the push lands, read the new head (`git rev-parse HEAD`) and, with `--emit-json`, record `post` `done` with the method and the new short head in its note.
- Your push may set off what the repository does on a push (CI runs, stale approvals dismissed). Those are the repository's doing; mention any you can see.

Cleanup:

- **Remove the worktree once the push has landed**, and at a stop that aborted the rebase or merge: `git worktree remove {{HOME}}/agents/worktrees/<repo>-update-<number>-<timestamp>`. If that refuses because the worktree holds changes, do **not** pass `--force`: say it was left in place, give its path, and say what is in it.
- **Never remove a worktree that holds an update that was not pushed**, at a stop under "Pushing" or after a refused push, until the owner answers to discard it.
- With `--emit-json`, write `<run-dir>/result.json` after this cleanup, as the run's last act, under the `pit-crew/update-result@1` schema in `emit-json.md`. Your closing chat message may follow it; nothing else may.

Closing message:

Begin it with these lines, then a terse list of the conflicts resolved (path and how) and the checks run (command and outcome), or "No conflicts."

```
PR: #<number> `<branch>` @ `<short head SHA>`
Update: rebased onto `<primary>` @ `<short upstream SHA>` | merged `<primary>` @ `<short upstream SHA>` | already up to date
Method: <why rebase, or which rule made it a merge>
Push: pushed `<short new head>` with --force-with-lease | pushed `<short new head>` | not pushed: <reason>
```

No AI attribution anywhere in it: do not say that a model, agent, or tool made, resolved, or found anything.
