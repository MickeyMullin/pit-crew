// src/actions.ts
import type { Cache } from './cache.ts'
import type { Config } from './config.ts'
import { deriveIssues, deriveMerge } from './derive.ts'
import { fetchViewerLogin, GhError } from './github.ts'
import type { Gh, GhErrorKind } from './github.ts'

// direct actions (section 9 of DESIGN.md): explicit GitHub writes on the viewer's own open PRs,
// each through gh with the viewer's own token. This module decides whether an action is allowed
// and what gh is asked; it never trusts the page, so every rule is checked here again.
// merge is always a squash into the PR's base branch; the method is fixed, not a setting
export const actionNames = ['merge', 'markReady', 'convertToDraft', 'requestReview'] as const
export type ActionName = typeof actionNames[number]

export type ActionRequest =
  | { action: 'merge' }
  | { action: 'markReady' }
  | { action: 'convertToDraft' }
  | { action: 'requestReview', reviewer: string }

export type ActionResult = { number: number, action: ActionName, done: true, reviewer?: string }

export type ActionErrorCode =
  | 'badRequest' | 'notOpen' | 'notYours' | 'notAllowed' | 'identityMismatch' | 'identityUnknown' | 'busy' | 'ghFailed'

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

const usage = 'send { "action": "merge" | "markReady" | "convertToDraft" } or { "action": "requestReview", "reviewer": "<login from people>" }'

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

// the body, checked field by field: an unknown field is refused rather than ignored
export const parseAction = (body: unknown): ActionRequest => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ActionError('badRequest', usage)
  const { action, reviewer, ...rest } = body as Record<string, unknown>
  if (typeof action !== 'string' || !actionNames.includes(action as ActionName)) {
    throw new ActionError('badRequest', `action must be one of ${actionNames.join(', ')}; ${usage}`)
  }
  const extra = Object.keys(rest)[0]
  if (extra !== undefined) throw new ActionError('badRequest', `unknown field ${extra}; ${usage}`)
  if (action === 'requestReview') {
    if (typeof reviewer !== 'string' || reviewer === '') throw new ActionError('badRequest', `requestReview needs a reviewer; ${usage}`)
    return { action, reviewer }
  }
  if (reviewer !== undefined) throw new ActionError('badRequest', `${action} takes no reviewer; ${usage}`)
  return { action: action as 'merge' | 'markReady' | 'convertToDraft' }
}

// exactly what gh is asked for each action. A merge is a squash into the PR's base branch, with no
// branch deletion, admin override, auto-merge or message override. A review request goes through
// gh api for being one REST call with a fixed argument list, not because of any token scope
export const ghArgs = (repo: string, number: number, request: ActionRequest): string[] => {
  switch (request.action) {
    case 'merge': return ['pr', 'merge', String(number), '--squash', '--repo', repo]
    case 'markReady': return ['pr', 'ready', String(number), '--repo', repo]
    case 'convertToDraft': return ['pr', 'ready', String(number), '--undo', '--repo', repo]
    case 'requestReview': return ['api', '--method', 'POST', `repos/${repo}/pulls/${number}/requested_reviewers`, '-f', `reviewers[]=${request.reviewer}`]
  }
}

const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

export type ActionsOptions = {
  cache: Cache
  gh: Gh
  // the config in effect, read afresh at every action
  config: () => Config
  // starts the targeted refresh of one PR (the poller's); not awaited
  refreshPr: (number: number) => Promise<unknown>
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

  const refresh = (number: number): void => {
    options.refreshPr(number).catch((error: unknown) => log(`PR #${number}: refresh after an action failed: ${messageOf(error)}`))
  }

  const run = async (number: number, body: unknown): Promise<ActionResult> => {
    const request = parseAction(body)
    const config = options.config()
    const { repo, viewer } = config
    const row = cache.readView(repo).open.find((entry) => entry.number === number)
    if (row === undefined) throw new ActionError('notOpen', `#${number} is not an open PR in ${repo} that Pit View has fetched`)
    const author = row.pr.author?.login ?? ''
    if (viewer === '' || !sameLogin(author, viewer)) throw new ActionError('notYours', `#${number} is not your PR; direct actions apply to your own PRs only`)
    let reviewer: string | undefined
    if (request.action === 'merge') {
      // the state the row shows, derived again from the cached PR rather than taken from the page
      const merge = deriveMerge(row.pr, deriveIssues(row.pr))
      if (merge.state === 'draft') throw new ActionError('notAllowed', `#${number} is a draft; mark it ready for review before merging`)
      if (merge.state !== 'ready') throw new ActionError('notAllowed', `#${number} is not ready to merge: its merge state is ${merge.label}`)
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
      // gh writes as whichever account it is signed in as, and this machine holds more than one
      let login: string
      try {
        login = await fetchViewerLogin(gh)
      } catch (error) {
        throw new ActionError('identityUnknown', `cannot confirm which account gh uses: ${messageOf(error)}`, error instanceof GhError ? error.kind : null)
      }
      if (!sameLogin(login, viewer)) throw new ActionError('identityMismatch', `gh is signed in as ${login || 'nobody'}, but the viewer is ${viewer}; switch with gh auth switch before acting`)
      const checked: ActionRequest = reviewer === undefined ? request : { action: 'requestReview', reviewer }
      try {
        await gh.run(ghArgs(repo, number, checked))
      } catch (error) {
        // the cache may be what is wrong, so the row is read again before the refusal is shown
        refresh(number)
        throw new ActionError('ghFailed', messageOf(error), error instanceof GhError ? error.kind : null)
      }
      log(`PR #${number}: ${request.action}${reviewer === undefined ? '' : ` ${reviewer}`}`)
      refresh(number)
      return { number, action: request.action, done: true, ...(reviewer === undefined ? {} : { reviewer }) }
    } finally {
      inFlight.delete(key)
    }
  }

  return { run }
}
