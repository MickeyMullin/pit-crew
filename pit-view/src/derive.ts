// src/derive.ts
import type { Clock, Config, Person, TicketSystem } from './config.ts'
import type {
  GhErrorKind, RawCheckContext, RawClosedPr, RawIssueRef, RawOpenPr, RawReview, RawReviewer, RawTimelineItem,
} from './github.ts'
import type { AgentCell } from './launcher.ts'
import type { ReportInfo } from './reports.ts'
import { closedRanges, iso } from './time.ts'
import type { Range } from './time.ts'

// row shapes, exactly as the API in section 3 of DESIGN.md serves them

export type PersonView = {
  login: string
  alias: string
  initials: string
  // config data, null for people not listed in config.people
  color: string | null
  avatarUrl: string | null
}

export type ReviewerState = 'approved' | 'changes' | 'commented' | 'requested'
export type Reviewer = PersonView & { state: ReviewerState, team?: true }

export type Ticket = { system: string, label: string, url?: string }

export type Stack = { position: number, size: number }

export type IssueKind = 'changesRequested' | 'conflicts' | 'ciFailing' | 'ciRunning' | 'ciCanceled' | 'ciNotRun'
export type Issue = { kind: IssueKind, label: string, count?: number, url?: string, tip?: string }

export type MergeStateKind = 'ready' | 'needsReview' | 'needsApproval' | 'checking' | 'blocked' | 'draft'
export type MergeState = { state: MergeStateKind, label: string }

export type LastActivity = { at: string, actor: string | null, text: string }

export type FreshnessState = 'current' | 'pending' | 'stale'
export type Freshness = { state: FreshnessState, fetchedAt: string }

// this row's own one-PR refresh: on its way, or failed with GitHub's reason; null otherwise
export type RowRefresh =
  | { state: 'running', startedAt: string }
  | { state: 'failed', at: string, error: string, errorKind: GhErrorKind | 'internal' }

export type PrBase = {
  number: number
  url: string
  title: string
  author: PersonView
  headRef: string
  baseRef: string
  // whether baseRef is the repository's primary branch, the only base a merge is offered for
  primaryBase: boolean
  headOid: string
  // the full head SHA, which a merge confirmation is bound to (headOid is the short form shown)
  headSha: string
  createdAt: string
  additions: number
  deletions: number
  changedFiles: number
  tickets: Ticket[]
  stack: Stack | null
  reviewers: Reviewer[]
  issues: Issue[]
  merge: MergeState
  lastActivity: LastActivity
  freshness: Freshness
  refresh: RowRefresh | null
  // phase 2: the Agent cell (section 8 of DESIGN.md); null when the derivation has no runs to read
  agent: AgentCell | null
}

export type Flag =
  | { kind: 'reReview', label: string, count?: number }
  | { kind: 'requestedOfYou', label: string }

export type OtherGroup = 'yourMove' | 'readyToMerge' | 'waitingOnAuthor' | 'bots'
export type OtherRow = PrBase & { section: 'others', group: OtherGroup, flags: Flag[] }

export type MineGroup = 'changesRequested' | 'readyToMerge' | 'awaitingReview' | 'drafts'
// reReviewRequested and updatedNotRequested: changes were requested and the viewer has answered
export type MineStage = 'changesRequested' | 'reReviewRequested' | 'updatedNotRequested' | 'awaitingReview' | 'approved' | 'draft'

export type SelfReview = {
  state: 'current' | 'stale' | 'none'
  reviewedOid: string | null
  headOid: string
  tandem: boolean
  file: string | null
  at: string | null
}

// the latest changes-requested review, for the Mine call-out banner and its tile
export type ChangesRequestedBy = { login: string, alias: string, at: string }

export type MineRow = PrBase & {
  section: 'mine'
  group: MineGroup
  stage: MineStage
  selfReview: SelfReview
  changesRequested: ChangesRequestedBy | null
}

export type OpenRow = MineRow | OtherRow

export type Group<K extends string, R> = { key: K, label: string, sub: string, collapsible: boolean, rows: R[] }
export type MineSection = { groups: Group<MineGroup, MineRow>[] }
export type OthersSection = { groups: Group<OtherGroup, OtherRow>[] }

export type ClosedBy =
  | { alias: string, login: string, text: string }
  | { label: string, text: string }

export type ClosedRow = {
  number: number
  url: string
  title: string
  author: PersonView
  outcome: 'merged' | 'closed'
  closedBy: ClosedBy
  closedAt: string
  tickets: Ticket[]
}

export type ClosedRange = Range & { rows: ClosedRow[] }
export type ClosedView = { today: ClosedRange, yesterday: ClosedRange }

export type Tiles = {
  yourMove: number
  mineChangesRequested: number
  mineChangesRequestedDetail: { number: number, by: string, at: string } | null
  mineReadyToMerge: number
  waitingOnAuthor: number
  closedToday: number
  closedPrevious: { count: number, merged: number, closed: number, label: string }
}

export type Counts = { mine: { open: number, drafts: number }, others: { open: number } }

// everything a derivation reads besides the PRs themselves
export type DeriveContext = {
  config: Config
  clock: Clock
  // the machine's IANA zone; used when config.todayStartsAt is local
  timeZone: string
  // self-review reports for the viewer's PRs, from scanReports
  reports?: ReadonlyMap<number, ReportInfo>
  // per-row freshness from the cache; defaults to current as of now
  freshness?: (number: number) => Freshness
  // one-PR refreshes running or failed, from the poller; defaults to none
  refresh?: (number: number) => RowRefresh | null
  // the Agent cell, from the poller's runs; defaults to null
  agent?: (pr: RawOpenPr, stack: Stack | null) => AgentCell | null
}

const same = (a: string | null | undefined, b: string | null | undefined): boolean =>
  a != null && b != null && a.toLowerCase() === b.toLowerCase()

const shortSha = (oid: string): string => oid.slice(0, 7)

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`

// people

const youAlias = 'You'

const initialsOf = (login: string): string => {
  const parts = login.split(/[-_.\s]+/).filter((part) => part !== '')
  const letters = parts.length > 1 ? parts.slice(0, 2).map((part) => part[0]).join('') : login.slice(0, 2)
  return letters.toUpperCase()
}

const githubAvatar = (login: string): string => `https://github.com/${encodeURIComponent(login)}.png`

// the server's loopback route for a person whose avatar is an image under ~
export const localAvatarUrl = (login: string): string => `/api/avatar/${encodeURIComponent(login)}`

// initials-only people get no image; a local image is served by the server, never by path
const avatarFor = (person: Person | undefined, login: string, avatarUrl: string | null): string | null => {
  if (person === undefined || person.avatar === 'github') return avatarUrl ?? githubAvatar(login)
  if (person.avatar === 'initials') return null
  return localAvatarUrl(person.login)
}

export const personView = (login: string, avatarUrl: string | null, config: Config): PersonView => {
  const person = config.people.find((entry) => same(entry.login, login))
  return {
    login,
    alias: same(login, config.viewer) ? youAlias : person?.alias ?? login,
    initials: person?.initials ?? initialsOf(login),
    color: person?.color ?? null,
    avatarUrl: avatarFor(person, login, avatarUrl),
  }
}

export const viewerView = (config: Config): PersonView => personView(config.viewer, null, config)

const ghost = 'ghost'

const aliasOf = (login: string | null, config: Config): string => login === null ? 'Someone' : personView(login, null, config).alias

// bots and ownership

export const isBotLogin = (login: string | null | undefined, config: Config): boolean =>
  login != null && config.bots.some((bot) => bot !== '' && login.toLowerCase().includes(bot.toLowerCase()))

export const isMine = (pr: { author: { login: string } | null }, config: Config): boolean => same(pr.author?.login, config.viewer)

// reviewer pips

const reviewStates: Partial<Record<RawReview['state'], ReviewerState>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes',
  COMMENTED: 'commented',
}

const reviewerLogin = (reviewer: RawReviewer): string => reviewer.__typename === 'Team' ? reviewer.name : reviewer.login

const reviewTime = (review: RawReview): number => {
  const time = Date.parse(review.submittedAt ?? '')
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time
}

// one review per reviewer, the newest across latestReviews and latestOpinionatedReviews. GitHub drops a
// reviewer from latestReviews once a review is re-requested of them, but latestOpinionatedReviews keeps
// their approval or change request, so reading latestReviews alone loses what the reviewer decided. On a
// tie the review from latestReviews wins, so it stays the one GitHub reports for the reviewer. A review
// with no author cannot be matched to a reviewer; it counts once, when both lists hold the same one.
// A comment-only review is neither: unless keepDecision is false, it never displaces the same reviewer's approval or change request, which a comment does not withdraw.
const newestReviews = (pr: RawOpenPr, keepDecision: boolean): RawReview[] => {
  const decided = (review: RawReview): boolean => review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED'
  const newest = new Map<string, RawReview>()
  for (const review of [...pr.latestReviews.nodes, ...pr.latestOpinionatedReviews.nodes]) {
    const key = review.author === null
      ? `ghost:${review.state}:${review.submittedAt}:${review.commit?.oid ?? ''}`
      : review.author.login.toLowerCase()
    const seen = newest.get(key)
    if (seen === undefined) newest.set(key, review)
    else if (keepDecision && review.state === 'COMMENTED' && decided(seen)) continue
    else if (keepDecision && seen.state === 'COMMENTED' && decided(review)) newest.set(key, review)
    else if (reviewTime(review) > reviewTime(seen)) newest.set(key, review)
  }
  return [...newest.values()]
}

export const latestReviewsOf = (pr: RawOpenPr): RawReview[] => newestReviews(pr, true)

// reviews by anyone but the author, with a state that counts (not dismissed or pending)
const countedReviews = (pr: RawOpenPr): RawReview[] =>
  latestReviewsOf(pr).filter((review) =>
    review.author !== null && !same(review.author.login, pr.author?.login) && reviewStates[review.state] !== undefined)

// latest review per reviewer, then pending requests; a re-requested reviewer shows as requested
export const reviewerPips = (pr: RawOpenPr, config: Config): Reviewer[] => {
  const pips: Reviewer[] = []
  for (const review of countedReviews(pr)) {
    const login = review.author?.login ?? ghost
    const state = reviewStates[review.state] ?? 'commented'
    if (!pips.some((pip) => same(pip.login, login))) pips.push({ ...personView(login, null, config), state })
  }
  for (const request of pr.reviewRequests.nodes) {
    const reviewer = request.requestedReviewer
    if (reviewer === null) continue
    const login = reviewerLogin(reviewer)
    const existing = pips.find((pip) => same(pip.login, login))
    if (existing !== undefined) {
      existing.state = 'requested'
      continue
    }
    if (reviewer.__typename === 'Team') {
      pips.push({ login, alias: login, initials: initialsOf(login), color: null, avatarUrl: null, state: 'requested', team: true })
    } else {
      pips.push({ ...personView(login, null, config), state: 'requested' })
    }
  }
  return pips
}

// flags (Others' only)

export const viewerReview = (pr: RawOpenPr, config: Config): RawReview | undefined =>
  newestReviews(pr, false).find((review) => same(review.author?.login, config.viewer) && review.state !== 'PENDING')

// a user, not a team, with a pending review request
const isRequestedOf = (pr: RawOpenPr, login: string | undefined): boolean =>
  pr.reviewRequests.nodes.some(({ requestedReviewer: reviewer }) =>
    reviewer !== null && reviewer.__typename !== 'Team' && same(reviewer.login, login))

export const isRequestedOfViewer = (pr: RawOpenPr, config: Config): boolean => isRequestedOf(pr, config.viewer)

// commits after oid in the last-30 window; null when oid is outside it (force push or rebase)
const commitsSince = (pr: RawOpenPr, oid: string | null | undefined): number | null => {
  if (oid == null) return null
  const nodes = pr.recentCommits.nodes
  const index = nodes.findIndex((node) => node.commit.oid === oid)
  return index === -1 ? null : nodes.length - 1 - index
}

export const deriveFlags = (pr: RawOpenPr, config: Config): Flag[] => {
  const flags: Flag[] = []
  const review = viewerReview(pr, config)
  if (review !== undefined && review.commit?.oid !== pr.headRefOid) {
    const count = commitsSince(pr, review.commit?.oid)
    flags.push(count === null || count === 0
      ? { kind: 'reReview', label: 'Re-review · new commits' }
      : { kind: 'reReview', label: `Re-review · ${plural(count, 'push', 'pushes')} since yours`, count })
  }
  if (isRequestedOfViewer(pr, config)) flags.push({ kind: 'requestedOfYou', label: 'Requested of you' })
  return flags
}

// issue chips

const failingConclusions = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE'])
const failingStates = new Set(['FAILURE', 'ERROR'])
const runningStatuses = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED'])
const runningStates = new Set(['PENDING', 'EXPECTED'])

const isFailing = (context: RawCheckContext): boolean => context.__typename === 'CheckRun'
  ? context.conclusion !== null && failingConclusions.has(context.conclusion)
  : failingStates.has(context.state)

const isRunning = (context: RawCheckContext): boolean => context.__typename === 'CheckRun'
  ? context.status !== 'COMPLETED' && runningStatuses.has(context.status)
  : runningStates.has(context.state)

const isCanceled = (context: RawCheckContext): boolean => context.__typename === 'CheckRun' && context.conclusion === 'CANCELLED'

const contextsOf = (pr: RawOpenPr): RawCheckContext[] => pr.headCommit.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []

export const deriveIssues = (pr: RawOpenPr): Issue[] => {
  const issues: Issue[] = []
  if (pr.reviewDecision === 'CHANGES_REQUESTED') issues.push({ kind: 'changesRequested', label: 'Changes requested' })
  if (pr.mergeable === 'CONFLICTING') issues.push({ kind: 'conflicts', label: 'Conflicts' })
  const contexts = contextsOf(pr)
  const failing = contexts.filter(isFailing)
  const first = failing[0]
  if (first !== undefined) {
    const issue: Issue = { kind: 'ciFailing', label: `CI failing · ${failing.length}`, count: failing.length }
    const url = first.__typename === 'CheckRun' ? first.detailsUrl : first.targetUrl
    if (url !== null) issue.url = url
    issue.tip = `Open the failing job: ${first.__typename === 'CheckRun' ? first.name : first.context}`
    issues.push(issue)
  }
  const running = contexts.filter(isRunning).length
  if (running > 0) issues.push({ kind: 'ciRunning', label: `CI running · ${running}`, count: running })
  const canceled = contexts.filter(isCanceled).length
  if (canceled > 0 && failing.length === 0) issues.push({ kind: 'ciCanceled', label: `CI canceled · ${canceled}`, count: canceled })
  if (contexts.length === 0) issues.push({ kind: 'ciNotRun', label: 'CI not run' })
  return issues
}

// merge state

export const deriveMerge = (pr: RawOpenPr, issues: readonly Issue[]): MergeState => {
  if (pr.isDraft) return { state: 'draft', label: '—' }
  if (pr.mergeStateStatus === 'CLEAN') return { state: 'ready', label: 'Ready' }
  const reviewed = countedReviews(pr).length > 0
  if (issues.length === 0 && (pr.reviewDecision === null || pr.reviewDecision === 'REVIEW_REQUIRED') && reviewed) {
    return { state: 'needsApproval', label: 'Needs approval' }
  }
  if (issues.length === 0 && !reviewed) return { state: 'needsReview', label: 'Needs review' }
  // GitHub computes mergeability lazily, often only once asked; the next cycle reads it
  if (issues.length === 0 && pr.mergeStateStatus === 'UNKNOWN') return { state: 'checking', label: 'Checking' }
  return { state: 'blocked', label: 'Blocked' }
}

// changes requested

const latestChangesRequest = (pr: RawOpenPr): RawReview | undefined =>
  latestReviewsOf(pr)
    .filter((review) => review.state === 'CHANGES_REQUESTED')
    .sort((a, b) => Date.parse(b.submittedAt ?? '') - Date.parse(a.submittedAt ?? ''))[0]

// true when the head has moved past the latest changes-requested review
const pushedSinceChangesRequest = (pr: RawOpenPr): boolean => {
  const review = latestChangesRequest(pr)
  if (review === undefined) return false
  if (review.commit !== null) return review.commit.oid !== pr.headRefOid
  const head = pr.headCommit.nodes[0]?.commit.committedDate
  return head !== undefined && review.submittedAt !== null && Date.parse(head) > Date.parse(review.submittedAt)
}

// how the viewer answered a changes request on their own PR: re-requested every reviewer whose
// latest review requests changes, or pushed past the latest one; null while it is still theirs to do
export const changesResponse = (pr: RawOpenPr): 'reReviewRequested' | 'updatedNotRequested' | null => {
  const requesting = countedReviews(pr).filter((review) => review.state === 'CHANGES_REQUESTED')
  if (requesting.length > 0 && requesting.every((review) => isRequestedOf(pr, review.author?.login))) return 'reReviewRequested'
  return pushedSinceChangesRequest(pr) ? 'updatedNotRequested' : null
}

const changesRequestedBy = (pr: RawOpenPr, config: Config): ChangesRequestedBy | null => {
  const review = latestChangesRequest(pr)
  if (pr.reviewDecision !== 'CHANGES_REQUESTED' || review === undefined || review.submittedAt === null) return null
  const login = review.author?.login ?? ghost
  return { login, alias: aliasOf(login, config), at: review.submittedAt }
}

// ready to merge: merge state ready, or approved with no issue chips while GitHub is still checking
// mergeability (after a restart or a base branch move), so it is not dropped for a cycle; its merge
// state stays checking, so the row still says the merge is unconfirmed
const groupsAsReady = (pr: RawOpenPr, merge: MergeState): boolean =>
  merge.state === 'ready' || (merge.state === 'checking' && pr.reviewDecision === 'APPROVED')

// Others' groups, in precedence order; null means hidden (others' drafts in v1)
export const otherGroup = (pr: RawOpenPr, issues: readonly Issue[], merge: MergeState, config: Config): OtherGroup | null => {
  if (isBotLogin(pr.author?.login, config)) return 'bots'
  if (pr.isDraft) return null
  if (groupsAsReady(pr, merge)) return 'readyToMerge'
  const has = (kind: IssueKind): boolean => issues.some((issue) => issue.kind === kind)
  if (has('conflicts') || has('ciFailing') || has('ciNotRun')) return 'waitingOnAuthor'
  if (has('changesRequested') && !pushedSinceChangesRequest(pr)) return 'waitingOnAuthor'
  const review = viewerReview(pr, config)
  if (isRequestedOfViewer(pr, config) || review === undefined || review.commit?.oid !== pr.headRefOid) return 'yourMove'
  // reviewed at the head with nothing new: the author's turn
  return 'waitingOnAuthor'
}

export const mineGroupAndStage = (pr: RawOpenPr, merge: MergeState): { group: MineGroup, stage: MineStage } => {
  if (pr.isDraft) return { group: 'drafts', stage: 'draft' }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    // once answered, the PR waits on its reviewers like any other
    const response = changesResponse(pr)
    return response === null ? { group: 'changesRequested', stage: 'changesRequested' } : { group: 'awaitingReview', stage: response }
  }
  if (groupsAsReady(pr, merge)) return { group: 'readyToMerge', stage: 'approved' }
  return { group: 'awaitingReview', stage: pr.reviewDecision === 'APPROVED' ? 'approved' : 'awaitingReview' }
}

// self-review

export const selfReviewOf = (report: ReportInfo | undefined, headRefOid: string): SelfReview => {
  const headOid = shortSha(headRefOid)
  if (report === undefined) return { state: 'none', reviewedOid: null, headOid, tandem: false, file: null, at: null }
  const current = report.reviewedSha !== null && headRefOid.toLowerCase().startsWith(report.reviewedSha.toLowerCase())
  return {
    state: current ? 'current' : 'stale',
    reviewedOid: report.reviewedSha,
    headOid,
    tandem: report.tandem,
    file: report.file,
    at: report.at,
  }
}

// last activity

type Activity = { at: string, actor: string | null, kind: RawTimelineItem['__typename'], verb: string }

// bot commits carry a login or name like dependabot[bot], where the bot's other events say dependabot
const commitActor = (item: Extract<RawTimelineItem, { __typename: 'PullRequestCommit' }>): string | null => {
  const author = item.commit.author
  return (author?.user?.login ?? author?.name)?.replace(/\[bot\]$/, '') || null
}

const reviewVerbs: Partial<Record<RawReview['state'], string>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'requested changes',
  COMMENTED: 'commented',
  DISMISSED: 'reviewed',
}

const activityOf = (item: RawTimelineItem, config: Config): Activity | null => {
  switch (item.__typename) {
    case 'PullRequestCommit':
      return { at: item.commit.committedDate, actor: commitActor(item), kind: item.__typename, verb: 'pushed' }
    case 'PullRequestReview': {
      const verb = reviewVerbs[item.state]
      if (verb === undefined) return null
      return { at: item.submittedAt ?? item.createdAt, actor: item.author?.login ?? null, kind: item.__typename, verb }
    }
    case 'IssueComment':
      return { at: item.createdAt, actor: item.author?.login ?? null, kind: item.__typename, verb: 'commented' }
    case 'ReviewRequestedEvent': {
      const reviewer = item.requestedReviewer
      let verb = 'requested a review'
      if (reviewer !== null && reviewer.__typename !== 'Team' && same(reviewer.login, config.viewer)) verb = 'requested your review'
      else if (reviewer !== null) verb = `requested review from ${reviewer.__typename === 'Team' ? reviewer.name : aliasOf(reviewer.login, config)}`
      return { at: item.createdAt, actor: item.actor?.login ?? null, kind: item.__typename, verb }
    }
    case 'ReadyForReviewEvent':
      return { at: item.createdAt, actor: item.actor?.login ?? null, kind: item.__typename, verb: 'marked it ready for review' }
    case 'ConvertToDraftEvent':
      return { at: item.createdAt, actor: item.actor?.login ?? null, kind: item.__typename, verb: 'converted it to a draft' }
    case 'RenamedTitleEvent':
      return { at: item.createdAt, actor: item.actor?.login ?? null, kind: item.__typename, verb: 'edited the title' }
    case 'HeadRefForcePushedEvent':
      return { at: item.createdAt, actor: item.actor?.login ?? null, kind: item.__typename, verb: 'force-pushed' }
    default:
      return null
  }
}

// the most recent timeline event; consecutive commits by one actor count as one push
export const deriveLastActivity = (pr: RawOpenPr, config: Config): LastActivity => {
  const activities = pr.timelineItems.nodes.map((item) => activityOf(item, config))
  let latest = -1
  activities.forEach((activity, index) => {
    const best = activities[latest]
    if (activity !== null && (best == null || Date.parse(activity.at) >= Date.parse(best.at))) latest = index
  })
  const activity = activities[latest]
  if (activity == null) return { at: pr.updatedAt, actor: null, text: 'Updated' }
  const actor = aliasOf(activity.actor, config)
  if (activity.kind !== 'PullRequestCommit') return { at: activity.at, actor, text: `${actor} ${activity.verb}` }
  let count = 1
  for (let index = latest - 1; index >= 0; index -= 1) {
    const earlier = activities[index]
    if (earlier == null || earlier.kind !== 'PullRequestCommit' || earlier.actor !== activity.actor) break
    count += 1
  }
  return { at: activity.at, actor, text: `${actor} pushed ${plural(count, 'commit')}` }
}

// tickets

type TicketSource = {
  title: string
  headRefName: string
  body: string
  closingIssuesReferences: { nodes: RawIssueRef[] }
}

const fillTemplate = (template: string, values: Record<string, string>): string | undefined => {
  if (template === '') return undefined
  if (template.includes('{baseUrl}') && (values.baseUrl ?? '') === '') return undefined
  return template.replace(/\{(baseUrl|key|repo|n)\}/g, (_, name: string) => values[name] ?? '')
}

const keyMatches = (pattern: string, text: string): string[] => {
  if (pattern === '') return []
  let regex: RegExp
  try {
    regex = new RegExp(pattern, 'gi')
  } catch {
    return []
  }
  return [...new Set([...text.matchAll(regex)].map((match) => match[0].toUpperCase()).filter((key) => key !== ''))]
}

const systemTickets = (system: TicketSystem, source: TicketSource, config: Config): Ticket[] => {
  if (system.source === 'linked-issues') {
    return source.closingIssuesReferences.nodes.map((issue) => ({ system: system.name, label: `#${issue.number}`, url: issue.url }))
  }
  const fromTitle = keyMatches(system.pattern, source.title)
  const keys = fromTitle.length > 0 ? fromTitle : keyMatches(system.pattern, source.headRefName)
  return keys.map((key) => {
    const ticket: Ticket = { system: system.name, label: key }
    const url = fillTemplate(system.linkTemplate, {
      baseUrl: system.baseUrl.replace(/\/+$/, ''), key, repo: config.repo, n: /(\d+)$/.exec(key)?.[1] ?? '',
    })
    if (url !== undefined) ticket.url = url
    return ticket
  })
}

// bot PRs have no tickets; the body is read only for the no-ticket marker
export const deriveTickets = (source: TicketSource, isBot: boolean, config: Config): Ticket[] => {
  const systems = config.tickets.filter((system) => system.enabled)
  if (isBot || systems.length === 0) return []
  const tickets: Ticket[] = []
  for (const system of systems) {
    for (const ticket of systemTickets(system, source, config)) {
      if (!tickets.some((seen) => seen.system === ticket.system && seen.label === ticket.label)) tickets.push(ticket)
    }
  }
  if (tickets.length === 0 && /\bno-ticket\b/i.test(source.body)) tickets.push({ system: 'none', label: 'no-ticket' })
  return tickets
}

// stacks

type StackPr = { number: number, headRefName: string, baseRefName: string }

// recomputed over every open PR, since a PR's base may live on another page; a PR whose head
// is the default branch (a fork's main) never counts as a base
export const deriveStacks = (prs: readonly StackPr[], defaultBranch: string | null): Map<number, Stack> => {
  const byHead = new Map<string, StackPr>()
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    if (pr.headRefName !== defaultBranch && !byHead.has(pr.headRefName)) byHead.set(pr.headRefName, pr)
  }
  const parentOf = (pr: StackPr): StackPr | undefined => {
    const parent = byHead.get(pr.baseRefName)
    return parent === undefined || parent.number === pr.number ? undefined : parent
  }
  // root and depth per PR; a cycle of base links is not a stack
  const placed = new Map<number, { root: number, position: number }>()
  for (const pr of prs) {
    const chain: StackPr[] = [pr]
    const seen = new Set([pr.number])
    let cyclic = false
    for (let parent = parentOf(pr); parent !== undefined; parent = parentOf(parent)) {
      if (seen.has(parent.number)) {
        cyclic = true
        break
      }
      seen.add(parent.number)
      chain.push(parent)
    }
    const root = chain[chain.length - 1]
    if (!cyclic && root !== undefined) placed.set(pr.number, { root: root.number, position: chain.length })
  }
  const sizes = new Map<number, number>()
  for (const { root } of placed.values()) sizes.set(root, (sizes.get(root) ?? 0) + 1)
  const stacks = new Map<number, Stack>()
  for (const [number, { root, position }] of placed) {
    const size = sizes.get(root) ?? 1
    if (size > 1) stacks.set(number, { position, size })
  }
  return stacks
}

// open rows

const freshnessOf = (number: number, ctx: DeriveContext): Freshness =>
  ctx.freshness?.(number) ?? { state: 'current', fetchedAt: iso(ctx.clock.now()) }

// the repository's primary branch: its default branch when that is known, otherwise exactly master or main. A stacked PR's base is its parent's branch and a release branch is neither, so neither is primary
export const isPrimaryBase = (baseRef: string, defaultBranch: string | null): boolean =>
  defaultBranch === null || defaultBranch === '' ? baseRef === 'master' || baseRef === 'main' : baseRef === defaultBranch

const prBase = (pr: RawOpenPr, ctx: DeriveContext, stacks: ReadonlyMap<number, Stack>, issues: Issue[], merge: MergeState, defaultBranch: string | null): PrBase => ({
  number: pr.number,
  url: pr.url,
  title: pr.title,
  author: personView(pr.author?.login ?? ghost, pr.author?.avatarUrl ?? null, ctx.config),
  headRef: pr.headRefName,
  baseRef: pr.baseRefName,
  primaryBase: isPrimaryBase(pr.baseRefName, defaultBranch),
  headOid: shortSha(pr.headRefOid),
  headSha: pr.headRefOid,
  createdAt: pr.createdAt,
  additions: pr.additions,
  deletions: pr.deletions,
  changedFiles: pr.changedFiles,
  tickets: deriveTickets(pr, isBotLogin(pr.author?.login, ctx.config), ctx.config),
  stack: stacks.get(pr.number) ?? null,
  reviewers: reviewerPips(pr, ctx.config),
  issues,
  merge,
  lastActivity: deriveLastActivity(pr, ctx.config),
  freshness: freshnessOf(pr.number, ctx),
  refresh: ctx.refresh?.(pr.number) ?? null,
  agent: ctx.agent?.(pr, stacks.get(pr.number) ?? null) ?? null,
})

// one open PR as a Mine or Others' row; null for rows hidden in v1 (others' drafts)
export const deriveOpenRow = (pr: RawOpenPr, ctx: DeriveContext, stacks: ReadonlyMap<number, Stack>, defaultBranch: string | null = null): OpenRow | null => {
  const issues = deriveIssues(pr)
  const merge = deriveMerge(pr, issues)
  if (isMine(pr, ctx.config)) {
    return {
      ...prBase(pr, ctx, stacks, issues, merge, defaultBranch),
      section: 'mine',
      ...mineGroupAndStage(pr, merge),
      selfReview: selfReviewOf(ctx.reports?.get(pr.number), pr.headRefOid),
      changesRequested: changesRequestedBy(pr, ctx.config),
    }
  }
  const group = otherGroup(pr, issues, merge, ctx.config)
  if (group === null) return null
  return { ...prBase(pr, ctx, stacks, issues, merge, defaultBranch), section: 'others', group, flags: deriveFlags(pr, ctx.config) }
}

// every open PR, with stacks computed across all of them
export const deriveOpenRows = (prs: readonly RawOpenPr[], defaultBranch: string | null, ctx: DeriveContext): OpenRow[] => {
  const stacks = deriveStacks(prs, defaultBranch)
  return prs.map((pr) => deriveOpenRow(pr, ctx, stacks, defaultBranch)).filter((row) => row !== null)
}

// attention order: Re-review, then Requested of you, then most recent activity first
const flagRank = (row: OpenRow): number => {
  if (row.section !== 'others') return 2
  if (row.flags.some((flag) => flag.kind === 'reReview')) return 0
  return row.flags.some((flag) => flag.kind === 'requestedOfYou') ? 1 : 2
}

export const attentionOrder = (a: OpenRow, b: OpenRow): number =>
  flagRank(a) - flagRank(b) || Date.parse(b.lastActivity.at) - Date.parse(a.lastActivity.at) || b.number - a.number

const mineGroups: Omit<Group<MineGroup, MineRow>, 'rows'>[] = [
  { key: 'changesRequested', label: 'Changes requested', sub: 'your move', collapsible: false },
  { key: 'readyToMerge', label: 'Ready to merge', sub: 'approved and mergeable', collapsible: false },
  { key: 'awaitingReview', label: 'Awaiting review', sub: 'waiting on reviewers or checks', collapsible: false },
  { key: 'drafts', label: 'Drafts', sub: 'not ready for review', collapsible: true },
]

const otherGroups: Omit<Group<OtherGroup, OtherRow>, 'rows'>[] = [
  { key: 'yourMove', label: 'Your move', sub: 'requested of you, not reviewed by you, or pushed since your review', collapsible: false },
  { key: 'readyToMerge', label: 'Ready to merge', sub: 'only the author can act', collapsible: false },
  { key: 'waitingOnAuthor', label: 'Waiting on author', sub: 'conflicts, failing CI, changes requested, or nothing new since your review', collapsible: false },
  { key: 'bots', label: 'Bots', sub: 'dependency updates', collapsible: true },
]

// the bot group takes the bot's alias when only one bot appears
const botGroupLabel = (rows: readonly OtherRow[]): string => {
  const aliases = [...new Set(rows.map((row) => row.author.alias))]
  return aliases.length === 1 && aliases[0] !== undefined ? aliases[0] : 'Bots'
}

// every group is present, empty or not, in display order; rows in attention order
export const groupRows = (rows: readonly OpenRow[]): { mine: MineSection, others: OthersSection } => {
  const sorted = [...rows].sort(attentionOrder)
  const mine = sorted.filter((row) => row.section === 'mine')
  const others = sorted.filter((row) => row.section === 'others')
  return {
    mine: { groups: mineGroups.map((group) => ({ ...group, rows: mine.filter((row) => row.group === group.key) })) },
    others: {
      groups: otherGroups.map((group) => {
        const groupRows = others.filter((row) => row.group === group.key)
        return { ...group, label: group.key === 'bots' ? botGroupLabel(groupRows) : group.label, rows: groupRows }
      }),
    },
  }
}

// closed rows

export const deriveClosedBy = (pr: RawClosedPr, config: Config): ClosedBy => {
  const closer = pr.timelineItems.nodes[pr.timelineItems.nodes.length - 1]?.actor?.login ?? null
  const verb = pr.merged ? 'merged' : 'closed'
  const login = pr.merged ? pr.mergedBy?.login ?? closer : closer
  if (!pr.merged && login !== null && isBotLogin(pr.author?.login, config) && same(login, pr.author?.login)) {
    return { label: 'superseded', text: 'superseded' }
  }
  if (login === null) return { label: verb, text: verb }
  const alias = aliasOf(login, config)
  return { alias, login, text: `${verb} by ${same(login, config.viewer) ? 'you' : alias}` }
}

export const deriveClosedRow = (pr: RawClosedPr, config: Config): ClosedRow => ({
  number: pr.number,
  url: pr.url,
  title: pr.title,
  author: personView(pr.author?.login ?? ghost, pr.author?.avatarUrl ?? null, config),
  outcome: pr.merged ? 'merged' : 'closed',
  closedBy: deriveClosedBy(pr, config),
  closedAt: pr.closedAt,
  tickets: deriveTickets(pr, isBotLogin(pr.author?.login, config), config),
})

// splits the closed search into Today and Yesterday, newest first; search order is not closedAt order
export const deriveClosed = (prs: readonly RawClosedPr[], ctx: DeriveContext): ClosedView => {
  const { today, yesterday } = closedRanges(ctx.clock, { todayStartsAt: ctx.config.todayStartsAt, timeZone: ctx.timeZone })
  const rows = prs.map((pr) => deriveClosedRow(pr, ctx.config)).sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))
  const todayFrom = Date.parse(today.from)
  const yesterdayFrom = Date.parse(yesterday.from)
  return {
    today: { ...today, rows: rows.filter((row) => Date.parse(row.closedAt) >= todayFrom) },
    yesterday: {
      ...yesterday,
      rows: rows.filter((row) => Date.parse(row.closedAt) >= yesterdayFrom && Date.parse(row.closedAt) < todayFrom),
    },
  }
}

// tiles and counts, from the same rows the tables hold

export const deriveTiles = (rows: readonly OpenRow[], closed: ClosedView): Tiles => {
  const others = (group: OtherGroup) => rows.filter((row) => row.section === 'others' && row.group === group).length
  const mine = rows.filter((row): row is MineRow => row.section === 'mine')
  const changesRequested = mine.filter((row) => row.group === 'changesRequested')
  const latest = changesRequested
    .flatMap((row) => row.changesRequested === null ? [] : [{ number: row.number, by: row.changesRequested.alias, at: row.changesRequested.at }])
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
  const previous = closed.yesterday.rows
  const merged = previous.filter((row) => row.outcome === 'merged').length
  return {
    yourMove: others('yourMove'),
    mineChangesRequested: changesRequested.length,
    mineChangesRequestedDetail: latest ?? null,
    mineReadyToMerge: mine.filter((row) => row.group === 'readyToMerge').length,
    waitingOnAuthor: others('waitingOnAuthor'),
    closedToday: closed.today.rows.length,
    closedPrevious: {
      count: previous.length,
      merged,
      closed: previous.length - merged,
      label: closed.yesterday.isMondayRule ? 'Fri–Sun*' : 'yesterday',
    },
  }
}

// "12 open · 4 drafts": open counts every row in the section, drafts included
export const deriveCounts = (rows: readonly OpenRow[]): Counts => {
  const mine = rows.filter((row) => row.section === 'mine')
  return {
    mine: { open: mine.length, drafts: mine.filter((row) => row.group === 'drafts').length },
    others: { open: rows.length - mine.length },
  }
}

// the derived part of GET /api/view; the server adds version, repo and sync
export type DerivedView = {
  viewer: PersonView
  now: string
  tiles: Tiles
  counts: Counts
  mine: MineSection
  others: OthersSection
  closed: ClosedView
}

export type ViewInput = {
  open: readonly RawOpenPr[]
  defaultBranch: string | null
  closed: readonly RawClosedPr[]
}

export const deriveView = ({ open, defaultBranch, closed }: ViewInput, ctx: DeriveContext): DerivedView => {
  const rows = deriveOpenRows(open, defaultBranch, ctx)
  const closedView = deriveClosed(closed, ctx)
  return {
    viewer: viewerView(ctx.config),
    now: iso(ctx.clock.now()),
    tiles: deriveTiles(rows, closedView),
    counts: deriveCounts(rows),
    ...groupRows(rows),
    closed: closedView,
  }
}
