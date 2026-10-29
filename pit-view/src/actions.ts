// src/actions.ts
import type { Cache } from './cache.ts'
import type { Config } from './config.ts'
import { deriveIssues, deriveMerge, isPrimaryBase } from './derive.ts'
import { GhError, WriteIdentityError } from './github.ts'
import type { Gh, GhErrorKind } from './github.ts'

// direct actions (section 9 of DESIGN.md): explicit GitHub writes on the viewer's own open PRs,
// each through gh with the viewer's own token. This module decides whether an action is allowed
// and what gh is asked; it never trusts the page, so every rule is checked here again.
// merge is always a squash into the repository's primary branch; the method is fixed, not a
// setting, and a PR whose base is anything else (a stacked PR's parent, a release branch) is refused
export const actionNames = ['merge', 'markReady', 'convertToDraft', 'requestReview'] as const
export type ActionName = typeof actionNames[number]

// every request names the repository the confirmation displayed; a merge also names the full head SHA and the base branch it displayed
export type ActionRequest =
  | { action: 'merge', repo: string, headSha: string, base: string }
  | { action: 'markReady', repo: string }
  | { action: 'convertToDraft', repo: string }
  | { action: 'requestReview', repo: string, reviewer: string }

export type ActionResult = { number: number, action: ActionName, done: true, reviewer?: string }

export type ActionErrorCode =
  | 'badRequest' | 'notOpen' | 'notYours' | 'notAllowed' | 'stale' | 'identityMismatch' | 'identityUnknown' | 'busy' | 'ghFailed'

export class ActionError extends Error {
  override name = 'ActionError'
  code: ActionErrorCode
  // gh's error kind, for a write GitHub refused
  errorKind: GhErrorKind | null
  constructor (code: ActionErrorCode, message: string, errorKind: GhErrorKind | null = null) {
    super(message)
    this.code = code
    this.errorKind = errorKind
  }
}

const usage = 'send { "action": "merge", "repo": "<owner/name shown>", "headSha": "<full head SHA shown>", "base": "<base branch shown>" }, { "action": "markReady" | "convertToDraft", "repo": "<owner/name shown>" } or { "action": "requestReview", "repo": "<owner/name shown>", "reviewer": "<login from people>" }'

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

// the body, checked field by field: an unknown field is refused rather than ignored
export const parseAction = (body: unknown): ActionRequest => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ActionError('badRequest', usage)
  const { action, repo, reviewer, headSha, base, ...rest } = body as Record<string, unknown>
  if (typeof action !== 'string' || !actionNames.includes(action as ActionName)) {
    throw new ActionError('badRequest', `action must be one of ${actionNames.join(', ')}; ${usage}`)
  }
  const extra = Object.keys(rest)[0]
  if (extra !== undefined) throw new ActionError('badRequest', `unknown field ${extra}; ${usage}`)
  if (typeof repo !== 'string' || repo === '') throw new ActionError('badRequest', `${action} needs repo, the repository the confirmation showed; ${usage}`)
  if (action === 'merge') {
    if (reviewer !== undefined) throw new ActionError('badRequest', `merge takes no reviewer; ${usage}`)
    if (typeof headSha !== 'string' || typeof base !== 'string' || base === '') throw new ActionError('badRequest', `merge needs headSha and base, the head and base branch the confirmation showed; ${usage}`)
    if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new ActionError('badRequest', `headSha must be the full 40-character head SHA the confirmation showed; ${usage}`)
    return { action, repo, headSha: headSha.toLowerCase(), base }
  }
  if (headSha !== undefined) throw new ActionError('badRequest', `${action} takes no headSha; ${usage}`)
  if (base !== undefined) throw new ActionError('badRequest', `${action} takes no base; ${usage}`)
  if (action === 'requestReview') {
    if (typeof reviewer !== 'string' || reviewer === '') throw new ActionError('badRequest', `requestReview needs a reviewer; ${usage}`)
    return { action, repo, reviewer }
  }
  if (reviewer !== undefined) throw new ActionError('badRequest', `${action} takes no reviewer; ${usage}`)
  return { action: action as 'markReady' | 'convertToDraft', repo }
}

// exactly what gh is asked for each action. Merge uses GitHub's REST merge endpoint rather than
// `gh pr merge`: that endpoint refuses when branch rules require a queue, so one click cannot
// silently enable auto-merge or enqueue anything. The method is fixed to squash.
// The merge carries the head SHA the viewer's confirmation showed as GitHub's `sha` precondition,
// so a push after that is refused by GitHub (409) instead of merged.
export const ghArgs = (repo: string, number: number, request: ActionRequest, headSha = ''): string[] => {
  switch (request.action) {
    case 'merge': return ['api', '--method', 'PUT', `repos/${repo}/pulls/${number}/merge`, '-f', 'merge_method=squash', '-f', `sha=${headSha}`]
    case 'markReady': return ['pr', 'ready', String(number), '--repo', repo]
    case 'convertToDraft': return ['pr', 'ready', String(number), '--undo', '--repo', repo]
    case 'requestReview': return ['api', '--method', 'POST', `repos/${repo}/pulls/${number}/requested_reviewers`, '-f', `reviewers[]=${request.reviewer}`]
  }
}

// the one PR read live just before a merge, read-only, through the token the write then uses
type LivePr = { state?: string, draft?: boolean, merged?: boolean, mergeable?: boolean | null, mergeable_state?: string, base?: { ref?: string }, head?: { sha?: string } }

const refuseIfMoved = (number: number, live: LivePr, base: string, headSha: string): void => {
  if (live.state !== 'open' || live.merged === true) throw new ActionError('notAllowed', `#${number} is no longer open; nothing was merged`)
  if (live.base?.ref !== base) throw new ActionError('notAllowed', `#${number} now targets ${live.base?.ref ?? 'another branch'}, not ${base} as you saw; nothing was merged`)
  if (live.head?.sha !== headSha) throw new ActionError('notAllowed', `#${number} has new commits since you saw it; nothing was merged`)
  if (live.draft === true) throw new ActionError('notAllowed', `#${number} is a draft now; nothing was merged`)
  if (live.mergeable !== true || live.mergeable_state !== 'clean') throw new ActionError('notAllowed', `#${number} is not mergeable right now (${live.mergeable_state ?? 'unknown'}); nothing was merged`)
}

const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

export type ActionsOptions = {
  cache: Cache
  gh: Gh
  // the config in effect, read afresh at every action
  config: () => Config
  // starts the targeted refresh of one PR, in the repository the write used, that is certain to
  // start after the write (the poller's refreshPrAfterWrite); not awaited
  refreshPr: (repo: string, number: number) => Promise<unknown>
  log: (line: string) => void
}

export type Actions = {
  // validates and performs one action; throws ActionError, and answers once gh has finished
  run: (number: number, body: unknown) => Promise<ActionResult>
}

export const createActions = (options: ActionsOptions): Actions => {
  const { cache, gh, log } = options
  // one action per PR in flight, so a double click writes once
  const inFlight = new Set<string>()

  const refresh = (repo: string, number: number): void => {
    options.refreshPr(repo, number).catch((error: unknown) => log(`PR #${number}: refresh after an action failed: ${messageOf(error)}`))
  }

  const run = async (number: number, body: unknown): Promise<ActionResult> => {
    const request = parseAction(body)
    const config = options.config()
    const { repo, viewer } = config
    // the repository the confirmation displayed must still be the one in effect: the page learns of a change in Settings only when its feed patch arrives, and #<n> in another repository is another PR. Nothing is read, written or held in flight
    if (request.repo !== repo) throw new ActionError('stale', `the repository is now ${repo}, not ${request.repo}; the confirmation was for ${request.repo}, so nothing was done`)
    const cached = cache.readView(repo)
    const row = cached.open.find((entry) => entry.number === number)
    if (row === undefined) throw new ActionError('notOpen', `#${number} is not an open PR in ${repo} that Pit View has fetched`)
    const author = row.pr.author?.login ?? ''
    if (viewer === '' || !sameLogin(author, viewer)) throw new ActionError('notYours', `#${number} is not your PR; direct actions apply to your own PRs only`)
    let reviewer: string | undefined
    let merging: { base: string, headSha: string } | undefined
    if (request.action === 'merge') {
      // the state the row shows, derived again from the cached PR rather than taken from the page
      const merge = deriveMerge(row.pr, deriveIssues(row.pr))
      if (merge.state === 'draft') throw new ActionError('notAllowed', `#${number} is a draft; mark it ready for review before merging`)
      if (merge.state !== 'ready') throw new ActionError('notAllowed', `#${number} is not ready to merge: its merge state is ${merge.label}`)
      const base = row.pr.baseRefName
      if (!isPrimaryBase(base, cached.defaultBranch)) {
        throw new ActionError('notAllowed', `#${number} targets ${base}, not the primary branch (${cached.defaultBranch ?? 'master or main'}); Pit View merges only into the primary branch`)
      }
      // the confirmation named a head and a base; the cache can have moved on before the page was
      // patched, and then the viewer never saw what is cached: nothing is written
      if (request.base !== base || request.headSha !== row.pr.headRefOid.toLowerCase()) {
        refresh(repo, number)
        throw new ActionError('stale', `#${number} changed since you saw it (${request.base !== base ? `it now targets ${base}, not ${request.base}` : 'it has new commits'}); nothing was merged. Reload its confirmation to see the current state`)
      }
      merging = { base: request.base, headSha: request.headSha }
    }
    if (request.action === 'markReady' && !row.pr.isDraft) throw new ActionError('notAllowed', `#${number} is not a draft`)
    if (request.action === 'convertToDraft' && row.pr.isDraft) throw new ActionError('notAllowed', `#${number} is already a draft`)
    if (request.action === 'requestReview') {
      const person = config.people.find((entry) => sameLogin(entry.login, request.reviewer))
      if (person === undefined) throw new ActionError('notAllowed', `${request.reviewer} is not in people; choose a reviewer from Settings, People`)
      if (sameLogin(person.login, viewer) || sameLogin(person.login, author)) throw new ActionError('notAllowed', 'you cannot request a review from the PR author')
      reviewer = person.login
    }
    const key = `${repo}#${number}`
    if (inFlight.has(key)) throw new ActionError('busy', `an action on #${number} is already in progress`)
    inFlight.add(key)
    try {
      // gh writes as whichever account it is signed in as, and this machine holds more than one:
      // the write confirms the account with the token it then writes with, and runs once
      const checked: ActionRequest = reviewer === undefined ? request : { action: 'requestReview', repo, reviewer }
      try {
        const check = merging === undefined ? undefined : async (read: (args: string[]) => Promise<string>): Promise<void> => {
          // the confirmation named the cached base and head; the PR is read once more, live, and
          // anything that differs refuses before a write is made
          let live: LivePr
          try {
            live = JSON.parse(await read(['api', `repos/${repo}/pulls/${number}`])) as LivePr
          } catch (error) {
            if (error instanceof GhError) throw error
            throw new ActionError('ghFailed', `cannot read #${number} before merging: ${messageOf(error)}; nothing was merged`)
          }
          refuseIfMoved(number, live, merging!.base, merging!.headSha)
        }
        await gh.write(ghArgs(repo, number, checked, merging?.headSha), viewer, check)
      } catch (error) {
        if (error instanceof ActionError) {
          // the live read disagreed with the cache: nothing was written, and the row is read again
          refresh(repo, number)
          throw error
        }
        if (error instanceof WriteIdentityError) {
          if (error.login === null) throw new ActionError('identityUnknown', error.message, error.errorKind)
          throw new ActionError('identityMismatch', error.message)
        }
        // the cache may be what is wrong, so the row is read again before the refusal is shown
        refresh(repo, number)
        // GitHub answers 409 when the head is no longer the sha the merge named
        if (request.action === 'merge' && error instanceof GhError && /HTTP 409/.test(error.stderr)) {
          throw new ActionError('ghFailed', `GitHub refused: #${number} changed since you saw it (HTTP 409); nothing was merged`, error.kind)
        }
        throw new ActionError('ghFailed', messageOf(error), error instanceof GhError ? error.kind : null)
      }
      log(`PR #${number}: ${request.action}${reviewer === undefined ? '' : ` ${reviewer}`}`)
      refresh(repo, number)
      return { number, action: request.action, done: true, ...(reviewer === undefined ? {} : { reviewer }) }
    } finally {
      inFlight.delete(key)
    }
  }

  return { run }
}
