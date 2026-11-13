// src/actions.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Cache, Run } from './cache.ts'
import type { Config } from './config.ts'
import { deriveIssues, deriveMerge, isPrimaryBase, offersMerge } from './derive.ts'
import { GhError, GhTimeoutError, WriteIdentityError } from './github.ts'
import type { Gh, GhErrorKind, RawOpenPr, WriteLimits } from './github.ts'
import { currentOffers, isHttpUrl, offersFix, postArgs, stackRunCover } from './launcher.ts'
import type { Posted, PostForm, PostGuard, RunView, UpdateAction } from './launcher.ts'
import { nameInText, resolveModels } from './models.ts'
import { parseReviewedCommit, readReport, reportHash, ReportReadError } from './reports.ts'

// direct actions (section 9 of DESIGN.md): explicit GitHub writes on the viewer's own open PRs, each through gh with the viewer's own token. This module decides whether an action is allowed and what gh is asked; it never trusts the page, so every rule is checked here again. merge is always a squash into the repository's primary branch; the method is fixed, not a setting, and a PR whose base is anything else (a stacked PR's parent, a release branch) is refused. update writes nothing itself: it starts an agent session through the launcher, which brings the PR's branch up to date with the primary branch and pushes it. resolveConflicts is that same session, asked for on a PR the cache holds as conflicting
export const actionNames = ['merge', 'markReady', 'convertToDraft', 'requestReview', 'update', 'resolveConflicts'] as const
export type ActionName = typeof actionNames[number]

// every request names the repository the confirmation displayed; a merge also names the full head SHA and the base branch it displayed, and an update or a resolveConflicts all of those and the viewer
type SessionRequest<A extends UpdateAction> = { action: A, repo: string, viewer: string, headSha: string, base: string }
export type ActionRequest =
  | { action: 'merge', repo: string, headSha: string, base: string }
  | SessionRequest<'update'>
  | SessionRequest<'resolveConflicts'>
  | { action: 'markReady', repo: string }
  | { action: 'convertToDraft', repo: string }
  | { action: 'requestReview', repo: string, reviewer: string }

// an update or a resolveConflicts answers once its session has started, with the run
export type ActionResult =
  | { number: number, action: Exclude<ActionName, UpdateAction>, done: true, reviewer?: string }
  | { number: number, action: UpdateAction, started: true, run: RunView }

// the actions that start the Update session rather than write through gh
const updateActions: readonly string[] = ['update', 'resolveConflicts'] satisfies UpdateAction[]
const isUpdateAction = (action: string): action is UpdateAction => updateActions.includes(action)

export type ActionErrorCode =
  | 'badRequest' | 'unknownRun' | 'notOpen' | 'notYours' | 'notAllowed' | 'stale' | 'identityMismatch' | 'identityUnknown' | 'busy' | 'ghFailed'

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

// why a merge of this cached PR is not allowed, or null when it is: the page's rule (mergeOffered in public/mergeoffer.ts) applied to the row the PR derives to, then the primary-branch check, so the page offers Merge exactly when this allows it
export const mergeRefusal = (number: number, pr: RawOpenPr, defaultBranch: string | null): ActionError | null => {
  const issues = deriveIssues(pr)
  const merge = deriveMerge(pr, issues)
  if (merge.state === 'draft') return new ActionError('notAllowed', `#${number} is a draft; mark it ready for review before merging`)
  const primary = isPrimaryBase(pr.baseRefName, defaultBranch)
  if (!offersMerge(pr, merge, issues, primary)) {
    if (!primary && offersMerge(pr, merge, issues, true)) {
      return new ActionError('notAllowed', `#${number} targets ${pr.baseRefName}, not the primary branch (${defaultBranch ?? 'master or main'}); Pit View merges only into the primary branch`)
    }
    return new ActionError('notAllowed', `#${number} is not ready to merge: its merge state is ${merge.label}${issues.length === 0 ? '' : ` (${issues.map((issue) => issue.label).join(', ')})`}`)
  }
  return null
}

const usage = 'send { "action": "merge", "repo": "<owner/name shown>", "headSha": "<full head SHA shown>", "base": "<base branch shown>" }, { "action": "update" | "resolveConflicts", "repo": "<owner/name shown>", "viewer": "<login shown>", "headSha": "<full head SHA shown>", "base": "<base branch shown>" }, { "action": "markReady" | "convertToDraft", "repo": "<owner/name shown>" }, or { "action": "requestReview", "repo": "<owner/name shown>", "reviewer": "<login from people>" }'

// "a", "a or b", "a, b, or c": the words for a choice among the items
export const orList = (items: readonly string[]): string =>
  items.length <= 2 ? items.join(' or ') : `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

// the body, checked field by field: an unknown field is refused rather than ignored
export const parseAction = (body: unknown): ActionRequest => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ActionError('badRequest', usage)
  const { action, repo, reviewer, headSha, base, viewer, ...rest } = body as Record<string, unknown>
  if (typeof action !== 'string' || !actionNames.includes(action as ActionName)) {
    throw new ActionError('badRequest', `action must be one of ${orList(actionNames)}; ${usage}`)
  }
  const extra = Object.keys(rest)[0]
  if (extra !== undefined) throw new ActionError('badRequest', `unknown field ${extra}; ${usage}`)
  if (typeof repo !== 'string' || repo === '') throw new ActionError('badRequest', `${action} needs repo, the repository the confirmation showed; ${usage}`)
  if (!isUpdateAction(action) && viewer !== undefined) throw new ActionError('badRequest', `${action} takes no viewer; ${usage}`)
  if (isUpdateAction(action)) {
    if (reviewer !== undefined) throw new ActionError('badRequest', `${action} takes no reviewer; ${usage}`)
    if (typeof viewer !== 'string' || viewer === '') throw new ActionError('badRequest', `${action} needs viewer, the login the confirmation showed; ${usage}`)
    if (typeof headSha !== 'string' || typeof base !== 'string' || base === '') throw new ActionError('badRequest', `${action} needs headSha and base, the head and base branch the confirmation showed; ${usage}`)
    if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new ActionError('badRequest', `headSha must be the full 40-character head SHA the confirmation showed; ${usage}`)
    return { action, repo, viewer, headSha: headSha.toLowerCase(), base }
  }
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

// exactly what gh is asked for each action that writes through gh. Merge uses GitHub's REST merge endpoint rather than `gh pr merge`: that endpoint refuses when branch rules require a queue, so one click cannot silently enable auto-merge or enqueue anything. The method is fixed to squash. The merge carries the head SHA the viewer's confirmation showed as GitHub's `sha` precondition, so a push after that is refused by GitHub (409) instead of merged.
export const ghArgs = (repo: string, number: number, request: Exclude<ActionRequest, { action: UpdateAction }>, headSha = ''): string[] => {
  switch (request.action) {
    case 'merge': return ['api', '--method', 'PUT', `repos/${repo}/pulls/${number}/merge`, '-f', 'merge_method=squash', '-f', `sha=${headSha}`]
    case 'markReady': return ['pr', 'ready', String(number), '--repo', repo]
    case 'convertToDraft': return ['pr', 'ready', String(number), '--undo', '--repo', repo]
    case 'requestReview': return ['api', '--method', 'POST', `repos/${repo}/pulls/${number}/requested_reviewers`, '-f', `reviewers[]=${request.reviewer}`]
  }
}

// the one PR read live just before a merge, read-only, through the token the write then uses
type LivePr = { state?: string, draft?: boolean, merged?: boolean, mergeable?: boolean | null, mergeable_state?: string, base?: { ref?: string }, head?: { sha?: string } }

// the live states a merge may proceed from: GitHub's mergeable answers, never unknown or unstable
const liveMergeableStates: readonly string[] = ['clean', 'has_hooks']

const refuseIfMoved = (number: number, live: LivePr, base: string, headSha: string): void => {
  if (live.state !== 'open' || live.merged === true) throw new ActionError('notAllowed', `#${number} is no longer open; nothing was merged`)
  if (live.base?.ref !== base) throw new ActionError('notAllowed', `#${number} now targets ${live.base?.ref ?? 'another branch'}, not ${base} as you saw; nothing was merged`)
  if (live.head?.sha !== headSha) throw new ActionError('notAllowed', `#${number} has new commits since you saw it; nothing was merged`)
  if (live.draft === true) throw new ActionError('notAllowed', `#${number} is a draft now; nothing was merged`)
  if (live.mergeable !== true || !liveMergeableStates.includes(live.mergeable_state ?? '')) throw new ActionError('notAllowed', `#${number} is not mergeable right now (${live.mergeable_state ?? 'unknown'}); nothing was merged`)
}

const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

// Post it (section 8, Launching runs, Blocked post): everything its confirmation showed comes back, and nothing else is taken from the page
// reviewedSha is set only by the post button, for a stored report
export type PostRequest = { repo: string, viewer: string, number: number, headSha: string, form: PostForm, reviewedSha?: string }
export type PostResult = { number: number, runId: number, posted: Posted, run: RunView | null }

const formWords: Readonly<Record<PostForm, string>> = { approve: 'an approval', requestChanges: 'a request for changes', comment: 'a comment' }

const postUsage = 'send { "repo": "<owner/name shown>", "viewer": "<login shown>", "number": 106, "headSha": "<full head SHA shown>", "form": "approve" | "requestChanges" | "comment" } as the confirmation showed them, and for a stored report also "reviewedSha": "<full SHA of the commit the review read>"'

export const parsePost = (body: unknown): PostRequest => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ActionError('badRequest', postUsage)
  const { repo, viewer, number, headSha, form, reviewedSha, ...rest } = body as Record<string, unknown>
  const extra = Object.keys(rest)[0]
  if (extra !== undefined) throw new ActionError('badRequest', `unknown field ${extra}; ${postUsage}`)
  if (typeof repo !== 'string' || repo === '' || typeof viewer !== 'string' || viewer === '' || typeof number !== 'number' || !Number.isInteger(number) || number < 1 ||
    typeof headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(headSha) || (form !== 'approve' && form !== 'requestChanges' && form !== 'comment')) throw new ActionError('badRequest', postUsage)
  // present only on the post button's request, for a stored report: the full commit the report says it reviewed, which is the head only until the head moves
  if ('reviewedSha' in (body as object) && (typeof reviewedSha !== 'string' || !/^[0-9a-f]{40}$/i.test(reviewedSha))) throw new ActionError('badRequest', postUsage)
  return { repo, viewer, number, headSha: headSha.toLowerCase(), form, ...(typeof reviewedSha === 'string' ? { reviewedSha: reviewedSha.toLowerCase() } : {}) }
}

// the reviews on a PR, read live just before a post, one line each: login, commit, and state
const reviewsArgs = (repo: string, number: number): string[] => ['api', '--paginate', `repos/${repo}/pulls/${number}/reviews`, '--jq', '.[] | [.user.login, .commit_id, .state] | @tsv']

// a decided review of this head by this login, so a post would be a second one
export const reviewedHead = (lines: string, viewer: string, headSha: string): boolean =>
  lines.split('\n').some((line) => {
    const [login, commit, state] = line.split('\t')
    return login !== undefined && sameLogin(login, viewer) && commit?.toLowerCase() === headSha && (state === 'APPROVED' || state === 'CHANGES_REQUESTED')
  })

// GitHub answered and refused, so nothing landed; a lost connection, a 5xx, or anything else gh says leaves the post's fate unknown
const refusedByGitHub = (error: unknown): boolean =>
  error instanceof GhError && error.kind !== 'network' && (error.kind === 'auth' || error.kind === 'rateLimit' || /HTTP 4\d\d|GraphQL:/.test(error.stderr))

// how long the post path waits for gh: a read (the token, the account lookup, a read before the write) and the write itself. Applied to the post only; every other gh call keeps the runner's own behavior
export const postReadDeadlineMs = 30_000
export const postWriteDeadlineMs = 60_000

const readTimedOutMessage = 'GitHub did not answer in time; nothing was posted'
const writeTimedOutMessage = 'The post to GitHub timed out and may or may not have gone through. Check the pull request before posting again.'

export type ActionsOptions = {
  cache: Cache
  gh: Gh
  // the post's deadlines, for tests to shorten; the named constants when absent
  postDeadlines?: WriteLimits
  // the config in effect, read afresh at every action
  config: () => Config
  // starts the targeted refresh of one PR, in the repository the write used, that is certain to start after the write (the poller's refreshPrAfterWrite); not awaited
  refreshPr: (repo: string, number: number) => Promise<unknown>
  // starts the Update session through the launcher, labeled for the action that asked for it, which makes the identity, clone, and one-run-per-PR checks and throws LaunchError when one refuses
  startUpdate: (repo: string, number: number, headSha: string, action: UpdateAction) => Promise<RunView>
  // the folder reportsDir resolves to, read afresh at every post
  reportsFolder: () => string
  // where a post's private copy of its report goes
  tempFolder: string
  // puts a run's mark on the record just before gh writes and takes it off when GitHub refused; a failure to put it there stops the post
  markPost: (id: number, posting: boolean) => void
  // records a post on its run; a failure here is logged, since the post has landed by then, and the mark keeps it from being made twice
  recordPost: (id: number, posted: Posted) => RunView
  // the posts in flight, shared with the launcher: held from before a post's first asynchronous step until its write has settled and been recorded or has failed, during which the launcher admits no run of the PR and no stack run covering it
  posts: PostGuard
  log: (line: string) => void
}

export type Actions = {
  // validates and performs one action; throws ActionError, and answers once gh has finished
  run: (number: number, body: unknown) => Promise<ActionResult>
  // Post it: validates and posts one blocked run's saved report; throws ActionError on a refusal and answers once gh has finished
  post: (id: number, body: unknown) => Promise<PostResult>
}

// a report's text in a new folder only this user can read, for gh to open
const privateCopy = async (tempFolder: string, text: string): Promise<{ folder: string, path: string }> => {
  const folder = await mkdtemp(join(tempFolder, 'pit-view-post-'))
  const path = join(folder, 'report.md')
  try {
    await writeFile(path, text, { mode: 0o600 })
  } catch (error) {
    await rm(folder, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  return { folder, path }
}

export const createActions = (options: ActionsOptions): Actions => {
  const { cache, gh, log } = options
  // one action per PR in flight, so a double click writes once
  const inFlight = new Set<string>()

  const refresh = (repo: string, number: number): void => {
    options.refreshPr(repo, number).catch((error: unknown) => log(`PR #${number}: refresh after an action failed: ${messageOf(error)}`))
  }

  // the Update session: offered on the viewer's own PRs that target the primary branch, bound to the head and base the confirmation displayed, and started through the launcher, never twice at once. resolveConflicts starts the same session, and only on a PR the cache holds as conflicting
  const update = async (number: number, request: Extract<ActionRequest, { action: UpdateAction }>, pr: RawOpenPr, defaultBranch: string | null, config: Config): Promise<ActionResult> => {
    const { repo } = config
    // the session pushes to the PR's branch, and a bot's PR is never the viewer's to rewrite
    if (!offersFix(pr, config)) throw new ActionError('notYours', `#${number} is not your PR; direct actions apply to your own PRs only`)
    const base = pr.baseRefName
    // the cache can have moved on before the page was patched, and then the viewer never saw what is cached: nothing is started
    if (request.base !== base || request.headSha !== pr.headRefOid.toLowerCase()) {
      refresh(repo, number)
      throw new ActionError('stale', `#${number} changed since you saw it (${request.base !== base ? `it now targets ${base}, not ${request.base}` : 'it has new commits'}); nothing was started. Reload its confirmation to see the current state`)
    }
    if (!isPrimaryBase(base, defaultBranch)) {
      throw new ActionError('notAllowed', `#${number} targets ${base}, not the primary branch (${defaultBranch ?? 'master or main'}); Pit View updates only PRs that target the primary branch`)
    }
    // the Conflicts chip's own test, on the cached PR rather than the page's word
    if (request.action === 'resolveConflicts' && pr.mergeable !== 'CONFLICTING') {
      throw new ActionError('notAllowed', `#${number} has no conflicts that GitHub reports; nothing was started. Update branch brings it up to date instead`)
    }
    const key = `${repo}#${number}`
    if (inFlight.has(key)) throw new ActionError('busy', `an action on #${number} is already in progress`)
    inFlight.add(key)
    try {
      const run = await options.startUpdate(repo, number, request.headSha, request.action)
      log(`PR #${number}: update session ${run.id} started (${request.action})`)
      return { number, action: request.action, started: true, run }
    } finally {
      inFlight.delete(key)
    }
  }

  const run = async (number: number, body: unknown): Promise<ActionResult> => {
    const request = parseAction(body)
    const config = options.config()
    const { repo, viewer } = config
    // the repository the confirmation displayed must still be the one in effect: the page learns of a change in Settings only when its feed patch arrives, and #<n> in another repository is another PR. Nothing is read, written, or held in flight
    if (request.repo !== repo) throw new ActionError('stale', `the repository is now ${repo}, not ${request.repo}; the confirmation was for ${request.repo}, so nothing was done`)
    // an update's session pushes as the viewer, so the viewer the confirmation displayed must still be the one in effect too
    if ((request.action === 'update' || request.action === 'resolveConflicts') && !sameLogin(request.viewer, viewer)) {
      throw new ActionError('stale', `the viewer is now ${viewer || 'nobody'}, not ${request.viewer}; the confirmation was for ${request.viewer}, so nothing was started`)
    }
    const cached = cache.readView(repo)
    const row = cached.open.find((entry) => entry.number === number)
    if (row === undefined) throw new ActionError('notOpen', `#${number} is not an open PR in ${repo} that Pit View has fetched`)
    const author = row.pr.author?.login ?? ''
    if (viewer === '' || !sameLogin(author, viewer)) throw new ActionError('notYours', `#${number} is not your PR; direct actions apply to your own PRs only`)
    if (request.action === 'update' || request.action === 'resolveConflicts') return update(number, request, row.pr, cached.defaultBranch, config)
    let reviewer: string | undefined
    let merging: { base: string, headSha: string } | undefined
    if (request.action === 'merge') {
      // the state the row shows, derived again from the cached PR rather than taken from the page
      const refusal = mergeRefusal(number, row.pr, cached.defaultBranch)
      if (refusal !== null) throw refusal
      const base = row.pr.baseRefName
      // the confirmation named a head and a base; the cache can have moved on before the page was patched, and then the viewer never saw what is cached: nothing is written
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
      // gh writes as whichever account it is signed in as, and this machine holds more than one: the write confirms the account with the token it then writes with, and runs once
      const checked: Exclude<ActionRequest, { action: UpdateAction }> = reviewer === undefined ? request : { action: 'requestReview', repo, reviewer }
      try {
        const check = merging === undefined ? undefined : async (read: (args: string[]) => Promise<string>): Promise<void> => {
          // the confirmation named the cached base and head; the PR is read once more, live, and anything that differs refuses before a write is made
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

  const post = async (id: number, body: unknown): Promise<PostResult> => {
    const request = parsePost(body)
    const config = options.config()
    const { repo, viewer } = config
    const { number, headSha, form } = request
    if (request.repo !== repo) throw new ActionError('stale', `the repository is now ${repo}, not ${request.repo}; the confirmation was for ${request.repo}, so nothing was posted`)
    if (!sameLogin(request.viewer, viewer)) throw new ActionError('stale', `the viewer is now ${viewer || 'nobody'}, not ${request.viewer}; the confirmation was for ${request.viewer}, so nothing was posted`)
    const run = cache.getRun(id)
    if (run === null) throw new ActionError('unknownRun', `run ${id} does not exist`)
    if (run.repo !== repo || run.number !== number) throw new ActionError('stale', `run ${id} is not a run of #${number} in ${repo}; the confirmation was for #${number}, so nothing was posted`)
    // the offer as the cache has it at this moment, derived the way the drawer derives it: from the PR's latest run and the stack run that covers it. The requested run must be the run that offer is about, so a run another has superseded, or a stack run now covers, posts nothing, whatever report is still on disk. Everything here is synchronous, so what it answers is true until the caller next awaits
    const current = (): ReturnType<typeof currentOffers> => {
      const cached = cache.readView(repo)
      const row = cached.open.find((entry) => entry.number === number)
      if (row === undefined) throw new ActionError('notOpen', `#${number} is not an open PR in ${repo} that Pit View has fetched; nothing was posted`)
      const latest = cache.latestRuns(repo)
      const offers = currentOffers(row.pr, config, latest.get(number), stackRunCover(latest.values(), cached.open.map((entry) => entry.pr)).get(number))
      if (offers.runId !== id) throw new ActionError('stale', 'This report is no longer the latest for this PR; nothing was posted. Reload the PR to see its current state')
      if (headSha !== row.pr.headRefOid.toLowerCase()) {
        refresh(repo, number)
        throw new ActionError('stale', request.reviewedSha === undefined
          ? `#${number} has new commits since you saw it; nothing was posted. Start a new review for the current head`
          : `#${number} has new commits since the confirmation was shown; nothing was posted. The post button will ask again for the current head`)
      }
      return offers
    }
    // Post it (a blocked post, reviewed at the head) and the post button (a stored report, which may have been reviewed at an earlier head) are told apart by the request: only the button sends reviewedSha
    const offeredBy = (offers: ReturnType<typeof currentOffers>): { offer: { report: string, reportPath: string }, reviewedAt: string } => {
      if (request.reviewedSha === undefined) {
        const blocked = offers.postOffer
        if (blocked === null) throw new ActionError('notAllowed', `run ${id} has no report waiting to be posted on #${number}; nothing was posted`)
        if (blocked.form !== form) throw new ActionError('stale', `this report would now post as ${blocked.form}, not ${form}; nothing was posted. Reload its confirmation to see the current state`)
        return { offer: blocked, reviewedAt: headSha }
      }
      const stored = offers.storedOffer
      if (stored === null) throw new ActionError('notAllowed', `run ${id} has no stored report waiting to be posted on #${number}; nothing was posted`)
      if (stored.reviewedSha !== request.reviewedSha) throw new ActionError('stale', `this report reviewed ${stored.reviewedSha.slice(0, 7)}, not ${request.reviewedSha.slice(0, 7)}; nothing was posted. Reload its confirmation to see the current state`)
      if (!stored.forms.includes(form)) throw new ActionError('stale', `this report offers ${orList(stored.forms.map((offered) => formWords[offered]))}, not ${formWords[form]}; nothing was posted. Reload its confirmation to see the current state`)
      return { offer: stored, reviewedAt: stored.reviewedSha }
    }
    const offers = current()
    // before the mark and the offer, which a post in flight has already changed
    const key = `${repo}#${number}`
    if (inFlight.has(key)) throw new ActionError('busy', `an action on #${number} is already in progress`)
    if (run.postAttemptedAt !== null) throw new ActionError('notAllowed', `run ${id} has already begun its post, which may have landed; nothing was posted. Check #${number} on GitHub`)
    const { offer, reviewedAt } = offeredBy(offers)
    // the hold is taken in the same synchronous block as the check above, ahead of every asynchronous step: from here the launcher admits no run of this PR and no stack run covering it, until the finally below. A run admitted before this point has its row in the cache the check just read, and a start with no row yet is refused where it makes one
    const release = options.posts.hold(repo, number)
    if (release === null) throw new ActionError('busy', `a post for #${number} is already in progress`)
    inFlight.add(key)
    try {
      // the report on disk must be the one this run finished with: a later run of the PR writes the same name. One read: the text checked here is the text posted
      const folder = options.reportsFolder()
      let report: string
      try {
        report = (await readReport(folder, offer.report)).raw
      } catch (error) {
        if (error instanceof ReportReadError) throw new ActionError('notAllowed', `the saved report ${offer.reportPath} cannot be posted (${error.message}); nothing was posted`)
        throw error
      }
      if (reportHash(report) !== run.reportHash) throw new ActionError('notAllowed', `the saved report ${offer.reportPath} has changed since run ${id} finished, so it is no longer that run's review; nothing was posted. Start a new review to post the report as it is now`)
      // a posted report never mentions AI involvement: every registry id and full slug, every vendor, runner, and provider name, every term for AI, every phrase that credits a tool, and the review-mode words (postedTextTerms) are looked for in the very text that gets posted, and one found refuses the post before gh is asked anything. The Post it path and the post button both come through here
      const hit = nameInText(resolveModels(config.models), report)
      if (hit !== null) throw new ActionError('notAllowed', `the saved report ${offer.reportPath} contains "${hit.term}" (${hit.context}), and a posted report never mentions the involvement of AI, a model, a runner, or a provider; nothing was posted. Edit that text out of the report, or start a new review`)
      const named = parseReviewedCommit(report.split('\n').slice(0, 20))
      if (named === null) throw new ActionError('notAllowed', `the saved report ${offer.reportPath} does not say which commit it reviewed; nothing was posted`)
      if (!reviewedAt.startsWith(named)) throw new ActionError('notAllowed', `the saved report ${offer.reportPath} is about another commit (${named}); nothing was posted`)
      let marked = false
      const check = async (read: (args: string[]) => Promise<string>): Promise<void> => {
        let live: LivePr
        let reviews: string
        try {
          live = JSON.parse(await read(['api', `repos/${repo}/pulls/${number}`])) as LivePr
          reviews = await read(reviewsArgs(repo, number))
        } catch (error) {
          if (error instanceof GhError) throw error
          throw new ActionError('ghFailed', `cannot read #${number} before posting: ${messageOf(error)}; nothing was posted`)
        }
        if (live.state !== 'open' || live.merged === true) throw new ActionError('notAllowed', `#${number} is no longer open; nothing was posted`)
        if (live.head?.sha?.toLowerCase() !== headSha) throw new ActionError('notAllowed', `#${number} has new commits since you saw it; nothing was posted`)
        if (reviewedHead(reviews, viewer, headSha)) throw new ActionError('notAllowed', `you have already reviewed this commit of #${number}; nothing was posted`)
        // the offer derived once more from the cache as it is now, with nothing awaited between this reading and the mark below: a run that got in by a path the hold does not cover is seen here, and the hold refuses every run after it
        const again = offeredBy(current())
        if (again.offer.report !== offer.report || again.reviewedAt !== reviewedAt) throw new ActionError('stale', 'This report is no longer the one offered for this PR; nothing was posted. Reload the PR to see its current state')
        // the last step before the write, so a restart can never offer a post that may have landed
        try {
          options.markPost(id, true)
        } catch (error) {
          throw new ActionError('notAllowed', `cannot record that #${number} is being posted (${messageOf(error)}), and without that record it could be posted twice; nothing was posted`)
        }
        marked = true
      }
      // gh reads a private copy of what was checked, so nothing that happens to the report from here on reaches GitHub
      const copy = await privateCopy(options.tempFolder, report).catch((error: unknown) => {
        throw new ActionError('notAllowed', `cannot make a private copy of ${offer.reportPath} (${messageOf(error)}); nothing was posted`)
      })
      let printed: string
      try {
        printed = await gh.write(postArgs(repo, number, form, copy.path), viewer, check, options.postDeadlines ?? { readMs: postReadDeadlineMs, writeMs: postWriteDeadlineMs })
      } catch (error) {
        if (error instanceof GhTimeoutError) {
          refresh(repo, number)
          // a step before the write changed nothing and left no mark, so the report stays postable. The write is different: gh was told to stop, but a post that had already reached GitHub may land, and a stopped gh cannot say. The mark taken before the write stays, so the offer is withdrawn exactly as for any write whose outcome is unknown
          if (error.phase === 'write') {
            log(`PR #${number}: the post of run ${id} timed out, and its outcome is unknown`)
            throw new ActionError('ghFailed', writeTimedOutMessage, 'timeout')
          }
          log(`PR #${number}: the post of run ${id} was refused: ${error.message}`)
          throw new ActionError('ghFailed', readTimedOutMessage, 'timeout')
        }
        if (error instanceof ActionError) {
          refresh(repo, number)
          throw error
        }
        if (error instanceof WriteIdentityError) {
          if (error.login === null) throw new ActionError('identityUnknown', error.message, error.errorKind)
          throw new ActionError('identityMismatch', error.message)
        }
        const kind = error instanceof GhError ? error.kind : null
        if (marked && !refusedByGitHub(error)) {
          refresh(repo, number)
          throw new ActionError('ghFailed', `${messageOf(error)}; the post may have landed, so Post it will not be offered again. Check #${number} on GitHub`, kind)
        }
        if (marked) {
          try {
            options.markPost(id, false)
          } catch (failure) {
            log(`PR #${number}: GitHub refused the post of run ${id}, but its mark could not be taken off: ${messageOf(failure)}`)
          }
        }
        refresh(repo, number)
        throw new ActionError('ghFailed', messageOf(error), kind)
      } finally {
        await rm(copy.folder, { recursive: true, force: true }).catch((error: unknown) => log(`PR #${number}: cannot remove the private copy of its report: ${messageOf(error)}`))
      }
      // gh pr comment prints the comment's URL; gh pr review prints none, so the post links to the PR, as the prompts' own fallback does
      const url = printed.trim().split('\n').at(-1) ?? ''
      const posted: Posted = { form, url: isHttpUrl(url) ? url : `https://github.com/${repo}/pull/${number}` }
      log(`PR #${number}: run ${id} posted its report (${form})`)
      let recorded: RunView | null = null
      try {
        recorded = options.recordPost(id, posted)
      } catch (error) {
        log(`PR #${number}: the post of run ${id} landed but could not be recorded: ${messageOf(error)}`)
      }
      refresh(repo, number)
      return { number, runId: id, posted, run: recorded }
    } finally {
      inFlight.delete(key)
      release()
    }
  }

  return { run, post }
}

// the PR an Update session worked on is read again once the session has settled, however it ended, since it may have pushed; only a session this server watched, so a run that recovery settles at startup makes no GitHub call. Its updated row arrives as the refresh's patches
export const createUpdateWatch = (refreshPr: (repo: string, number: number) => Promise<unknown>, log: (line: string) => void): {
  watch: (run: Pick<Run, 'id' | 'command'>) => void
  change: (run: Pick<Run, 'id' | 'status' | 'repo' | 'number'>) => void
} => {
  const watched = new Set<number>()
  return {
    watch: (run) => {
      if (run.command === 'update-pr') watched.add(run.id)
    },
    change: (run) => {
      if (run.status === 'running' || !watched.delete(run.id)) return
      refreshPr(run.repo, run.number).catch((error: unknown) => log(`PR #${run.number}: refresh after the update session failed: ${messageOf(error)}`))
    },
  }
}
