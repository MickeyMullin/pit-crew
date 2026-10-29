// src/actions.ts
import type { Cache } from './cache.ts'
import type { Config } from './config.ts'
import { fetchViewerLogin, GhError } from './github.ts'
import type { Gh, GhErrorKind } from './github.ts'

// direct actions (section 9 of DESIGN.md): explicit GitHub writes on the viewer's own open PRs,
// each through gh with the viewer's own token. This module decides whether an action is allowed
// and what gh is asked; it never trusts the page, so every rule is checked here again.
// merge is a known action name that is not offered yet: its merge method is undecided
export const actionNames = ['merge', 'markReady', 'convertToDraft', 'requestReview'] as const
export type ActionName = typeof actionNames[number]

// the actions this build performs
export const offeredActions: readonly ActionName[] = ['markReady', 'convertToDraft', 'requestReview']

export type ActionRequest =
  | { action: 'markReady' }
  | { action: 'convertToDraft' }
  | { action: 'requestReview', reviewer: string }

export type ActionResult = { number: number, action: ActionName, done: true, reviewer?: string }

export type ActionErrorCode =
  | 'badRequest' | 'notOpen' | 'notYours' | 'notAllowed' | 'unavailable' | 'identityMismatch' | 'identityUnknown' | 'busy' | 'ghFailed'

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

const usage = 'send { "action": "markReady" | "convertToDraft" } or { "action": "requestReview", "reviewer": "<login from people>" }'

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

// the body, checked field by field: an unknown field is refused rather than ignored
export const parseAction = (body: unknown): ActionRequest => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ActionError('badRequest', usage)
  const { action, reviewer, ...rest } = body as Record<string, unknown>
  if (typeof action !== 'string' || !actionNames.includes(action as ActionName)) {
    throw new ActionError('badRequest', `action must be one of ${actionNames.join(', ')}; ${usage}`)
  }
  if (action === 'merge') throw new ActionError('unavailable', 'merge is not offered yet: its merge method is undecided')
  const extra = Object.keys(rest)[0]
  if (extra !== undefined) throw new ActionError('badRequest', `unknown field ${extra}; ${usage}`)
  if (action === 'requestReview') {
    if (typeof reviewer !== 'string' || reviewer === '') throw new ActionError('badRequest', `requestReview needs a reviewer; ${usage}`)
    return { action, reviewer }
  }
  if (reviewer !== undefined) throw new ActionError('badRequest', `${action} takes no reviewer; ${usage}`)
  return { action: action as 'markReady' | 'convertToDraft' }
}

// exactly what gh is asked for each action. A review request goes through gh api because
// gh pr edit also reads the PR's projects, which needs a token scope the others do not
export const ghArgs = (repo: string, number: number, request: ActionRequest): string[] => {
  switch (request.action) {
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
