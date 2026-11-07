// src/autoreview.ts
import { basename, dirname, join } from 'node:path'
import type { Cache, QueueReason, Run, RunStatus, Session, Sweep, Tick, TickChanges, TickSkip, TickState } from './cache.ts'
import { expandHome, tildePath, weekdayNames } from './config.ts'
import type { ActiveHours, AutoReviewSettings, Clock, Config, WeekdayName } from './config.ts'
import { attentionOrder, isMine, selfReviewOf } from './derive.ts'
import type { OpenRow, OtherRow } from './derive.ts'
import { fetchViewerLogin } from './github.ts'
import type { Gh, RawOpenPr, Runner } from './github.ts'
import { defaultRun, gitConfigEnv, isDependabot, mayPost, parseResult, remoteNamesRepo, stepsOf } from './launcher.ts'
import type { Launcher, LauncherFs, StartRequest } from './launcher.ts'
import type { Poller, Timers } from './poller.ts'
import { scanReports } from './reports.ts'
import type { ReportInfo } from './reports.ts'
import { sweepCommand, sweepRequest } from './sweeps.ts'
import { addDays, clockChangeOn, instantAt, iso, localDateOf, minute, minutesOfDay, startOfDate, startOfDay, weekdayOf } from './time.ts'
import type { LocalDate } from './time.ts'

// auto-review (section 10 of DESIGN.md). The pure half comes first: qualification, the queue, the retry rule, the daily limit, and the worktree sweep's selection, each function taking its inputs explicitly (rows, settings, run records, the clock as a number, and report lookups) and doing no I/O. The scheduler runtime after it is what calls them: createScheduler holds the one timer, runs the ticks, and starts each run in a worktree of its own through the launcher's engine, with every outside dependency passed in

export { weekdayNames }
export type { ActiveHours, AutoReviewSettings, WeekdayName }

export const defaultAutoReview = (): AutoReviewSettings => ({
  enabled: false,
  intervalMinutes: 15,
  activeHours: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '18:00' },
  others: true,
  own: false,
  dependabot: false,
  concurrency: 1,
  dailyLimit: 10,
  post: { others: false, dependabot: false },
})

// active hours and days

const minutesOf = (hhmm: string): number => {
  const [hours = '0', minutes = '0'] = hhmm.split(':')
  return Number(hours) * 60 + Number(minutes)
}

// the chosen local days, from inclusive to exclusive, in the machine's zone, read off the wall clock; a window never crosses midnight, so one with from not before to is never active
export const isActiveAt = (hours: ActiveHours, ms: number, timeZone: string): boolean => {
  const weekday = weekdayNames[weekdayOf(localDateOf(ms, timeZone))]
  const minutes = minutesOfDay(ms, timeZone)
  return weekday !== undefined && hours.days.includes(weekday) && minutes >= minutesOf(hours.from) && minutes < minutesOf(hours.to)
}

// the instants a date's window opens at, in order: usually one, at from, and none when the clocks go forward over all of it. When the clocks go back over part of it, it may open again where they land or at the repeat of from
const opensOn = (hours: ActiveHours, date: LocalDate, timeZone: string): number[] => {
  const first = instantAt(date, minutesOf(hours.from), timeZone)
  const change = clockChangeOn(date, timeZone)
  const candidates = change === null ? [first] : [first, change.at, first + change.repeats]
  const opens = candidates.filter((at) => isActiveAt(hours, at, timeZone) && !isActiveAt(hours, at - minute, timeZone))
  return [...new Set(opens)].sort((a, b) => a - b)
}

// the first instant after ms where the window opens, for the one timer held outside active hours; null when none ever will, because no day is chosen or from is not before to. Two weeks, since the clocks can leave the only chosen day with no active instant
export const nextActiveStart = (hours: ActiveHours, ms: number, timeZone: string): number | null => {
  const today = localDateOf(ms, timeZone)
  for (let offset = 0; offset <= 14; offset += 1) {
    const date = addDays(today, offset)
    const weekday = weekdayNames[weekdayOf(date)]
    if (weekday === undefined || !hours.days.includes(weekday)) continue
    const start = opensOn(hours, date, timeZone).find((at) => at > ms)
    if (start !== undefined) return start
  }
  return null
}

// run and sweep records, as far as the pure rules read them. The scheduler maps its rows onto these

export type AutoRunStatus = RunStatus

export type AutoRun = {
  id: number
  // its repository: PR numbers repeat across repositories, and the cache holds runs of every one it has had, so only rows of this one can settle this run
  repo: string
  origin: 'manual' | 'auto'
  // the pit-crew command, which tells a manual review-pr from a stack review or a fix or update session
  command: string
  number: number
  // the head the run reviewed, full or short; null before it is known. An auto run's is known from when it is queued; a manual review's comes from its result
  headOid: string | null
  status: AutoRunStatus
  // when it really started; null while it is only queued, and for a run that was stopped, skipped, or failed before it started, such as worktreeFailed. A launcher row's started_at holds the time it was queued until then, so the scheduler's mapping does not copy it for those
  startedAt: string | null
  // whether the run was allowed to post (false for a --no-post run)
  posting: boolean
  // the post step started, the result records a post, or the result reads ghFailed
  postStarted: boolean
  posted: boolean
  ghFailed: boolean
  // set by a caller that knows the run is settled for a reason these records and the open list do not show, such as its session having ended
  settled?: boolean
}

export type AutoSweep = {
  id: number
  repo: string
  origin: 'manual' | 'auto'
  status: AutoRunStatus
  startedAt: string | null
  settled?: boolean
}

// a queued run has not started, and neither has one stopped or skipped on its way there
const hasStarted = (entry: { status: AutoRunStatus, startedAt: string | null }): boolean =>
  entry.startedAt !== null && entry.status !== 'queued' && entry.status !== 'skipped'

// the rows of the last sweep the scheduler ran, from its result.json: each PR and the head it was swept at
export type SweepMemoryRow = { number: number, head: string }

// heads appear in full and short forms, so one matches the other as a prefix
export const sameHead = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (a == null || b == null || a === '' || b === '') return false
  const left = a.toLowerCase()
  const right = b.toLowerCase()
  return left.startsWith(right) || right.startsWith(left)
}

const autoRunsFor = (runs: readonly AutoRun[], row: { number: number, headSha: string }): AutoRun[] =>
  runs.filter((entry) => entry.origin === 'auto' && entry.number === row.number && sameHead(entry.headOid, row.headSha))

// the duplicate-run guard: the report names the head (section 5's detection, whoever ran it), or an auto run at that head has ended done, is waiting for input, or is already queued or running. A stopped run is not reviewed at its head: stoppedAtHead holds that PR back instead
export const isReviewedAtHead = (row: { number: number, headSha: string }, report: ReportInfo | undefined, runs: readonly AutoRun[]): boolean =>
  selfReviewOf(report, row.headSha).state === 'current'
  || autoRunsFor(runs, row).some((entry) => entry.status === 'done' || entry.status === 'needsInput' || entry.status === 'queued' || entry.status === 'running')

// an auto run for this PR is queued or running, at whatever head, so the tick leaves the PR alone until it ends; once it has, the PR is judged afresh at its current head
const hasLiveAutoRun = (number: number, runs: readonly AutoRun[]): boolean =>
  runs.some((entry) => entry.origin === 'auto' && entry.number === number && (entry.status === 'queued' || entry.status === 'running'))

// the owner stopped an auto run at this head, so the PR is left alone at it, unless a review-pr run of this PR and head, started by hand, finished after that stop. One still in flight has not run yet, and one that failed, waits for input, or was stopped did not get the PR past the stop. A stack review does not count: its report is not this PR's, so the guard would not see it and an auto run would start at the head the owner stopped. Dependabot PRs never reach this rule
const stoppedAtHead = (row: { number: number, headSha: string }, runs: readonly AutoRun[]): boolean =>
  autoRunsFor(runs, row).some((stopped) => stopped.status === 'stopped' && !runs.some((other) =>
    other.origin === 'manual' && other.status === 'done' && other.number === row.number && other.id > stopped.id && other.command === 'review-pr' && sameHead(other.headOid, row.headSha)))

export type RetryDecision = 'retry' | 'failedTwice' | 'postUnknown'

// what to do about a PR whose auto runs at one head have failed; failures holds every such failed run, the newest last. A run that was allowed to post is never retried once it may have posted
export const retryDecision = (failures: readonly AutoRun[]): RetryDecision => {
  const newest = [...failures].sort((a, b) => a.id - b.id).at(-1)
  if (newest !== undefined && newest.posting && (newest.postStarted || newest.posted || newest.ghFailed)) return 'postUnknown'
  return failures.length >= 2 ? 'failedTwice' : 'retry'
}

// the queue

export type { QueueReason }

// a PR run to start, or the Dependabot sweep (which carries the PRs it covers and no number)
export type QueueItem =
  | { kind: 'others' | 'own', number: number, reason: Exclude<QueueReason, 'dependabot'>, retry: boolean, headSha: string }
  | { kind: 'dependabot', reason: 'dependabot', prs: number[], number?: never, retry?: never, headSha?: never }

export type QueueInput = {
  // the open rows the tick derived from the cache it just brought up to date, which qualify others' and own PRs; a PR missing here may still be open, since others' drafts are hidden
  rows: readonly OpenRow[]
  // every open PR in that cache, whatever the rows hide or however they group it; the sweep reads this
  openPrs: readonly RawOpenPr[]
  settings: AutoReviewSettings
  // report lookup by PR number (scanReports or findReport), for others' PRs
  reports: ReadonlyMap<number, ReportInfo>
  // every recorded run and sweep of the tick's repository that may matter, since PR numbers repeat across repositories. Manual runs count only as what supersedes a stopped auto run; a manual sweep counts as what holds the slot, settles a waiting one, or clears the failure count
  runs: readonly AutoRun[]
  sweeps: readonly AutoSweep[]
  // the last scheduler sweep's rows, or null when it has none
  lastSweepRows: readonly SweepMemoryRow[] | null
}

// a PR the tick qualified and left alone; failedTwice and postUnknown are recorded as a note on its newest failed run, and stopped is what that run's status already says
export type LeftForOwner = { number: number, outcome: 'failedTwice' | 'postUnknown' | 'stopped' }

export type QueueResult = {
  // new runs to queue, in order: others, then own, then the sweep
  items: QueueItem[]
  // the tick row's counts
  qualified: number
  alreadyCurrent: number
  leftForOwner: LeftForOwner[]
  // a sweep is due and its two attempts have failed, so it is recorded as failedTwice on the newest of them and not retried
  sweepFailedTwice: boolean
}

const isOthersCandidate = (row: OpenRow): row is OtherRow => row.section === 'others' && row.group === 'yourMove'

const isOwnCandidate = (row: OpenRow): boolean =>
  row.section === 'mine' && row.stage !== 'draft' && (row.selfReview.state === 'none' || row.selfReview.state === 'stale')

// others' PRs are queued flags first and then most recent activity, which is section 5's rule for every group but Your move; the group is overridden so the shared comparator applies it
const queueOrder = (a: OtherRow, b: OtherRow): number => attentionOrder({ ...a, group: 'bots' }, { ...b, group: 'bots' })

const othersReason = (row: OtherRow): Exclude<QueueReason, 'dependabot'> => {
  if (row.flags.some((flag) => flag.kind === 'requestedOfYou')) return 'requested'
  return row.flags.some((flag) => flag.kind === 'reReview') ? 'pushed' : 'new'
}

// whichever open Dependabot PRs there are, when one is new or at a new head since the last sweep
const sweepIsDue = (dependabot: readonly RawOpenPr[], last: readonly SweepMemoryRow[] | null): number[] => {
  const due = last === null || dependabot.some((pr) => !last.some((seen) => seen.number === pr.number && sameHead(seen.head, pr.headRefOid)))
  return due ? dependabot.map((pr) => pr.number) : []
}

// a needsInput or failed sweep waits for the owner until it is settled: a newer sweep of its own repository has started, or the caller knows its session ended
const sweepSettled = (record: AutoSweep, sweeps: readonly AutoSweep[]): boolean =>
  record.settled === true || sweeps.some((other) => other.repo === record.repo && other.id > record.id && hasStarted(other))

// at most one sweep is queued or running, and a scheduled one waiting for input holds the worktree the owner may be answering in, which a new sweep would settle
const sweepHeld = (sweeps: readonly AutoSweep[]): boolean =>
  sweeps.some((entry) => entry.status === 'queued' || entry.status === 'running' || (entry.origin === 'auto' && entry.status === 'needsInput' && !sweepSettled(entry, sweeps)))

// scheduled sweeps that failed since the newest sweep that ended done, whoever started that one. A sweep has no head to start over at, so success is what clears the count
const sweepFailures = (sweeps: readonly AutoSweep[]): number => {
  const cleared = Math.max(-Infinity, ...sweeps.filter((entry) => entry.status === 'done').map((entry) => entry.id))
  return sweeps.filter((entry) => entry.origin === 'auto' && entry.status === 'failed' && entry.id > cleared).length
}

export const buildQueue = ({ rows, openPrs, settings, reports, runs, sweeps, lastSweepRows }: QueueInput): QueueResult => {
  // Dependabot is told by its author, not by the bots list, and only ever goes through the sweep
  const dependabot = openPrs.filter(isDependabot)
  const reviewable = rows.filter((row) => !dependabot.some((pr) => pr.number === row.number))
  const items: QueueItem[] = []
  const leftForOwner: LeftForOwner[] = []
  let qualified = 0
  let alreadyCurrent = 0
  let sweepFailedTwice = false
  const consider = (row: OpenRow, kind: 'others' | 'own', reason: Exclude<QueueReason, 'dependabot'>): void => {
    qualified += 1
    if (isReviewedAtHead(row, reports.get(row.number), runs)) {
      alreadyCurrent += 1
      return
    }
    if (hasLiveAutoRun(row.number, runs)) return
    if (stoppedAtHead(row, runs)) {
      leftForOwner.push({ number: row.number, outcome: 'stopped' })
      return
    }
    const failures = autoRunsFor(runs, row).filter((entry) => entry.status === 'failed')
    const decision = failures.length === 0 ? 'retry' : retryDecision(failures)
    if (decision !== 'retry') {
      leftForOwner.push({ number: row.number, outcome: decision })
      return
    }
    items.push({ kind, number: row.number, reason, retry: failures.length > 0, headSha: row.headSha })
  }
  if (settings.others) {
    for (const row of reviewable.filter(isOthersCandidate).sort(queueOrder)) consider(row, 'others', othersReason(row))
  }
  if (settings.own) {
    for (const row of reviewable.filter(isOwnCandidate).sort(attentionOrder)) consider(row, 'own', 'selfReview')
  }
  // a sweep reviews the whole set, one attempt and one retry
  if (settings.dependabot && !sweepHeld(sweeps)) {
    const prs = sweepIsDue(dependabot, lastSweepRows)
    if (prs.length > 0) {
      qualified += 1
      if (sweepFailures(sweeps) >= 2) sweepFailedTwice = true
      else items.push({ kind: 'dependabot', reason: 'dependabot', prs })
    }
  }
  return { items, qualified, alreadyCurrent, leftForOwner, sweepFailedTwice }
}

// why the scheduler starts no sweep for now, which the view shows so the owner can see scheduled sweeps stopped: one waits for input, or two have failed since the last that ended done. A sweep in flight or a new one queued is no hold
export const sweepHoldOf = (sweeps: readonly AutoSweep[]): 'needsInput' | 'failedTwice' | null => {
  if (sweeps.some((entry) => entry.origin === 'auto' && entry.status === 'needsInput' && !sweepSettled(entry, sweeps))) return 'needsInput'
  return sweepFailures(sweeps) >= 2 ? 'failedTwice' : null
}

// the check before a queued run starts: a PR that left the open list closed and is dropped, and one still there, a draft included, runs and records the head it is at now, which may have moved. It moves that one run to the new head and asks for no other, so it never gives a PR a second live run
export type Recheck = { action: 'start', headSha: string | null } | { action: 'drop', note: 'closed' }

export const recheckQueued = (item: QueueItem, openPrs: readonly RawOpenPr[]): Recheck => {
  if (item.kind === 'dependabot') return { action: 'start', headSha: null }
  const pr = openPrs.find((candidate) => candidate.number === item.number)
  return pr === undefined ? { action: 'drop', note: 'closed' } : { action: 'start', headSha: pr.headRefOid }
}

// the daily limit and the slots a tick may fill

// auto runs and sweeps that started on ms's local day, each attempt once; manual ones, queued ones, skipped ones, and any that never started never count
export const startedToday = (runs: readonly AutoRun[], sweeps: readonly AutoSweep[], ms: number, timeZone: string): number => {
  const from = startOfDay(ms, timeZone)
  const to = startOfDate(addDays(localDateOf(ms, timeZone), 1), timeZone)
  return [...runs, ...sweeps].filter((entry) => {
    if (entry.origin !== 'auto' || !hasStarted(entry)) return false
    const at = Date.parse(entry.startedAt ?? '')
    return at >= from && at < to
  }).length
}

export type StartBudgetInput = {
  concurrency: number
  // scheduled runs and sweeps in flight now
  inFlight: number
  dailyLimit: number
  startedToday: number
  // the review cap's room, as the launcher answers it
  capRoom: number
}

// how many queued runs may start now; at the daily limit the tick skips as dailyLimit
export const startBudget = (input: StartBudgetInput): { count: number, skip: 'dailyLimit' | null } => {
  if (input.startedToday >= input.dailyLimit) return { count: 0, skip: 'dailyLimit' }
  return { count: Math.max(0, Math.min(input.concurrency - input.inFlight, input.dailyLimit - input.startedToday, input.capRoom)), skip: null }
}

// the worktree sweep (section 10, Worktrees)

export type WorktreeKind = 'run' | 'sweep'
export type WorktreeEntry = { path: string, kind: WorktreeKind, id: number }

const trimSlashes = (path: string): string => path.length > 1 ? path.replace(/\/+$/, '') : path

// the worktree Pit View makes for a run or a scheduled sweep: run-<id> or sweep-<id>, directly inside its folder
export const worktreePath = (dir: string, kind: WorktreeKind, id: number): string => `${trimSlashes(dir)}/${kind}-${id}`

// the paths in `git worktree list --porcelain`
export const parseWorktreeList = (porcelain: string): string[] =>
  porcelain.split(/\r?\n/).filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length))

const worktreeName = /^(run|sweep)-(\d+)$/

export type OrphanInput = {
  // the repository in effect, the only one openPrs describes
  repo: string
  // the paths git lists, which are resolved
  listed: readonly string[]
  // Pit View's worktrees folder, resolved the same way, because git lists resolved paths
  dir: string
  runs: readonly AutoRun[]
  sweeps: readonly AutoSweep[]
  // every open PR in the cache, which shows whether a PR closed or moved on; null until a listing has completed (the cache was just built, or rebuilt, and its runs were kept), when neither can be told
  openPrs: readonly RawOpenPr[] | null
}

// a needsInput or failed run of the repository in effect waits for the owner until it is settled: a newer run of its own repository has started for the PR, the PR closed or got a new head, or the caller knows its session ended
const runSettled = (record: AutoRun, runs: readonly AutoRun[], openPrs: readonly RawOpenPr[] | null): boolean => {
  if (record.settled === true || runs.some((other) => other.repo === record.repo && other.number === record.number && other.id > record.id && hasStarted(other))) return true
  if (openPrs === null) return false
  const pr = openPrs.find((candidate) => candidate.number === record.number)
  return pr === undefined || (record.headOid !== null && !sameHead(pr.headRefOid, record.headOid))
}

const worktreeKept = (entry: WorktreeEntry, { repo, runs, sweeps, openPrs }: OrphanInput): boolean => {
  const record = entry.kind === 'run' ? runs.find((candidate) => candidate.id === entry.id) : sweeps.find((candidate) => candidate.id === entry.id)
  if (record === undefined) return false
  if (record.status === 'queued' || record.status === 'running') return true
  if (record.status !== 'needsInput' && record.status !== 'failed') return false
  // the open list says nothing about another repository's PRs, so a waiting row of one stays, and the absence of its number from that list is never read as its PR having closed
  if (record.repo !== repo) return true
  if (entry.kind === 'sweep') return !sweepSettled(record, sweeps)
  return !runSettled(record as AutoRun, runs, openPrs)
}

// which of git's listed worktrees the sweep removes and which it leaves. Only entries directly inside the folder and named run-<digits> or sweep-<digits> exactly are looked at; anything else is not in either list, and the caller never removes it
export const selectOrphanWorktrees = (input: OrphanInput): { remove: WorktreeEntry[], keep: WorktreeEntry[] } => {
  const dir = trimSlashes(input.dir)
  const remove: WorktreeEntry[] = []
  const keep: WorktreeEntry[] = []
  for (const path of input.listed) {
    if (dirname(path) !== dir) continue
    const match = worktreeName.exec(basename(path))
    if (match === null) continue
    const entry: WorktreeEntry = { path, kind: match[1] === 'run' ? 'run' : 'sweep', id: Number(match[2]) }
    ;(worktreeKept(entry, input) ? keep : remove).push(entry)
  }
  return { remove, keep }
}

// names in the folder that git no longer lists, for the popover; never deleted
export const unlistedDirectories = (names: readonly string[], dir: string, listed: readonly string[]): string[] => {
  const folder = trimSlashes(dir)
  const known = new Set(listed.filter((path) => dirname(path) === folder).map((path) => basename(path)))
  return names.filter((name) => !known.has(name))
}

// the scheduler runtime

export type AutoReviewState = 'off' | 'idle' | 'running' | 'outsideHours' | 'blocked'

// what GET /api/view and the patches carry (section 10, In the UI)
export type AutoReviewView = {
  enabled: boolean
  state: AutoReviewState
  nextTickAt: string | null
  running: number
  queued: number
  startedToday: number
  lastTick: { at: string, state: TickState | null, skipReason: TickSkip | null, queued: number | null } | null
  posting: { others: boolean, dependabot: boolean }
  // why scheduled sweeps have stopped; null when they have not
  sweepHold: 'needsInput' | 'failedTwice' | null
  // Pit View's worktrees left in place, written with ~, and the names in its folder that git no longer lists
  worktrees: { kept: string[], unlisted: string[] }
}

export type SchedulerOptions = {
  cache: Cache
  gh: Gh
  git: Runner
  fs: LauncherFs
  clock: Clock
  timers: Timers
  timeZone: string
  // the config in effect, viewer resolved
  config: () => Config
  home: string
  stateDir: string
  poller: Pick<Poller, 'refresh' | 'idle' | 'openRows' | 'autoReviewChanged'>
  launcher: Launcher
  sweepLauncher: Launcher<Sweep>
  log?: (line: string) => void
  // reads the reports folder; the real scan when left out
  scan?: typeof scanReports
  // how long a fetch that failed waits before its one more try
  fetchRetryMs?: number
}

export type Scheduler = {
  // the sweep at server startup, in the background, and the one timer; no GitHub call
  start: () => void
  // Run now: the tick it started or joined, or null while auto-review is off
  runNow: () => { started: boolean, tick: number } | null
  // a saved config may have moved the next tick
  configChanged: () => void
  // a run or a sweep started, stepped, or settled
  sessionChanged: (kind: WorktreeKind, session: Session) => void
  view: () => AutoReviewView | null
  // resolves once no tick, sweep, or worktree removal is in progress
  idle: () => Promise<void>
  // clears the timer; a tick in progress starts nothing more
  stop: () => void
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? ''

// setTimeout takes no longer than this, so a longer wait is planned again when it ends
const longestTimer = 2 ** 31 - 1

// a cache younger than this is reused rather than fetched again
const reuseMs = 60_000

const blockedBy: readonly (TickSkip | null)[] = ['identityMismatch', 'noClone', 'dailyLimit']

const isLive = (session: { status: RunStatus }): boolean => session.status === 'queued' || session.status === 'running'

// a launcher row's started_at holds the time it was queued until it starts, and keeps it when it never did, which a row with no process shows: the rules read null then
const startedAtOf = (session: Session): string | null => {
  if (session.status === 'queued') return null
  if (session.status === 'running') return session.startedAt
  return session.pid === null ? null : session.startedAt
}

export const toAutoRun = (run: Run, settled: ReadonlySet<number> = new Set()): AutoRun => {
  const result = run.result?.schema === 'pit-crew/review-result@1' ? run.result : null
  const postSlot = stepsOf(run).find((slot) => slot.step === 'post')?.state
  return {
    id: run.id,
    repo: run.repo,
    origin: run.origin,
    command: run.command,
    number: run.number,
    // a manual review's head comes from what it reviewed, and one with none does not supersede a stop
    headOid: run.headOid ?? result?.reviewed?.sha ?? null,
    status: run.status,
    startedAt: startedAtOf(run),
    posting: run.posting,
    postStarted: postSlot === 'started' || postSlot === 'done',
    posted: result?.posted != null,
    ghFailed: result?.notPostedReason === 'ghFailed',
    settled: settled.has(run.id),
  }
}

export const toAutoSweep = (sweep: Sweep, settled: ReadonlySet<number> = new Set()): AutoSweep => ({
  id: sweep.id,
  repo: sweep.repo,
  origin: sweep.origin,
  status: sweep.status,
  startedAt: startedAtOf(sweep),
  settled: settled.has(sweep.id),
})

// what the last sweep the scheduler ran that left a result said about each PR; read defensively, since its rows are checked only as a list
const lastSweepRowsOf = (sweeps: readonly Sweep[]): SweepMemoryRow[] | null => {
  const last = [...sweeps].filter((sweep) => sweep.origin === 'auto' && sweep.result?.schema === 'pit-crew/sweep-result@1').sort((a, b) => b.id - a.id)[0]
  if (last?.result?.schema !== 'pit-crew/sweep-result@1') return null
  return (last.result.rows as unknown[]).flatMap((row): SweepMemoryRow[] => {
    const { number, head } = (row ?? {}) as { number?: unknown, head?: unknown }
    return typeof number === 'number' && typeof head === 'string' ? [{ number, head }] : []
  })
}

const keptWord = 'worktreeKept'
const keptNote = (path: string): string => `${keptWord}: ${path}`
const withKept = (note: string | null, path: string): string => note === null || note === '' ? keptNote(path) : note.includes(keptNote(path)) ? note : `${note}; ${keptNote(path)}`
const withoutKept = (note: string | null): string | null => note?.replace(new RegExp(`(?:^|; )${keptWord}: .*$`), '') || null

export const createScheduler = (options: SchedulerOptions): Scheduler => {
  const { cache, gh, git, fs, clock, timers, timeZone, config, home, stateDir, poller, launcher, sweepLauncher } = options
  const log = options.log ?? (() => {})
  const scan = options.scan ?? scanReports
  const fetchRetryMs = options.fetchRetryMs ?? 5000
  const folder = join(stateDir, 'worktrees')

  let stopped = false
  let armed: { at: number, handle: unknown } | null = null
  let ticking: { id: number, done: Promise<void> } | null = null
  // what the last sweep found in the folder that git no longer lists
  let unlisted: string[] = []
  // waiting or failed sessions the last read of their folders found to have ended
  let settledRuns: ReadonlySet<number> = new Set()
  let settledSweeps: ReadonlySet<number> = new Set()
  // work in the background that idle waits for; sweeps go one at a time
  const pending = new Set<Promise<unknown>>()
  let sweeping: Promise<void> = Promise.resolve()
  const removing = new Map<string, Promise<void>>()

  const track = <T>(work: Promise<T>): Promise<T> => {
    const held = work.catch(() => {}).finally(() => pending.delete(held))
    pending.add(held)
    return work
  }

  const now = (): string => iso(clock.now())

  const announce = (): void => {
    try {
      poller.autoReviewChanged()
    } catch (error) {
      log(`auto-review: cannot announce its state: ${messageOf(error)}`)
    }
  }

  const cloneOf = (settings: Config): string | null => settings.cloneDir === undefined ? null : expandHome(settings.cloneDir, home)

  const engineOf = (kind: WorktreeKind): Launcher<Session> => (kind === 'run' ? launcher : sweepLauncher) as unknown as Launcher<Session>

  const rowOf = (kind: WorktreeKind, id: number): Session | null => kind === 'run' ? cache.getRun(id) : cache.getSweep(id)

  // the owner's session has ended when its folder holds a result it did not hold when the run settled, one no longer asking a question. This reads as settled only: it releases what the waiting run held and never changes the outcome recorded, since only the owner's re-read does that
  const sessionEnded = async (session: Session): Promise<boolean> => {
    const text = await fs.readFile(join(expandHome(session.dir, home), 'result.json')).catch(() => null)
    if (text === null) return false
    const parsed = parseResult(text)
    return parsed.ok && parsed.value.status !== 'needsInput' && JSON.stringify(parsed.value) !== JSON.stringify(session.result)
  }

  const readSettled = async (): Promise<void> => {
    const waiting = (session: Session): boolean => session.origin === 'auto' && (session.status === 'needsInput' || session.status === 'failed')
    const ended = async (sessions: readonly Session[]): Promise<Set<number>> => {
      const answers = await Promise.all(sessions.filter(waiting).map(async (session) => [session.id, await sessionEnded(session)] as const))
      return new Set(answers.flatMap(([id, answer]) => answer ? [id] : []))
    }
    settledRuns = await ended(cache.allRuns())
    settledSweeps = await ended(cache.allSweeps())
  }

  // never with --force: a worktree that refuses holds something unexpected, so it stays, and the row says so. Each path has one removal at a time
  const remove = (kind: WorktreeKind, id: number, path: string): Promise<void> => {
    const key = `${kind}-${id}`
    const running = removing.get(key)
    if (running !== undefined) return running
    const job = (async (): Promise<void> => {
      const clone = cloneOf(config())
      if (clone === null) return
      const before = rowOf(kind, id)
      const answer = await git(['-C', clone, 'worktree', 'remove', path], { env: gitConfigEnv(before?.command ?? sweepCommand) })
      if (stopped) return
      // git no longer knowing the path means it is already gone
      const gone = answer.code === 0 || answer.stderr.includes('is not a working tree')
      const row = rowOf(kind, id)
      if (!gone) log(`auto-review: left ${tildePath(path, home)} in place: ${firstLine(answer.stderr)}`)
      if (row === null) return
      if (gone) {
        if (row.status === 'needsInput' || row.status === 'failed') await engineOf(kind).resumeInClone(id)
        if (!stopped) engineOf(kind).annotate(id, { worktree: null, note: withoutKept(row.note) })
        return
      }
      const note = withKept(row.note, row.worktree ?? tildePath(path, home))
      if (note !== row.note) engineOf(kind).annotate(id, { note })
    })().catch((error: unknown) => log(`auto-review: cannot remove ${tildePath(path, home)}: ${messageOf(error)}`)).finally(() => removing.delete(key))
    removing.set(key, job)
    return track(job)
  }

  // the sweep (section 10, Worktrees): only what git lists directly inside the folder, by its record, and never a GitHub call
  const sweepOnce = async (): Promise<void> => {
    const settings = config()
    const clone = cloneOf(settings)
    if (clone === null) {
      unlisted = []
      return
    }
    const listing = await git(['-C', clone, 'worktree', 'list', '--porcelain'])
    if (listing.code !== 0) {
      log(`auto-review: cannot list the worktrees of ${settings.cloneDir}: ${firstLine(listing.stderr)}`)
      return
    }
    // git lists resolved paths, so the folder is compared resolved
    const dir = await fs.realpath(folder).catch(() => folder)
    await readSettled()
    const runs = cache.allRuns()
    const sweeps = cache.allSweeps()
    const cached = cache.readView(settings.repo)
    const { remove: doomed } = selectOrphanWorktrees({
      repo: settings.repo,
      listed: parseWorktreeList(listing.stdout),
      dir,
      runs: runs.map((run) => toAutoRun(run, settledRuns)),
      sweeps: sweeps.map((sweep) => toAutoSweep(sweep, settledSweeps)),
      // until a listing has completed the open list cannot say a PR closed or moved on
      openPrs: cached.lastSuccessAt === null ? null : cached.open.map((row) => row.pr),
    })
    for (const entry of doomed) {
      if (stopped) return
      await remove(entry.kind, entry.id, entry.path)
    }
    if (stopped) return
    const pruned = await git(['-C', clone, 'worktree', 'prune'])
    if (pruned.code !== 0) log(`auto-review: cannot prune worktree metadata: ${firstLine(pruned.stderr)}`)
    const relisted = await git(['-C', clone, 'worktree', 'list', '--porcelain'])
    if (relisted.code !== 0 || stopped) return
    const listed = parseWorktreeList(relisted.stdout)
    unlisted = unlistedDirectories(await fs.list(folder), dir, listed)
    // a row whose worktree git no longer lists has none, whatever took it
    const known = new Set(listed.filter((path) => dirname(path) === dir).map((path) => basename(path)))
    const forget = async (kind: WorktreeKind, session: Session): Promise<void> => {
      if (session.worktree === null || isLive(session) || session.repo !== settings.repo || known.has(`${kind}-${session.id}`)) return
      if (session.status === 'needsInput' || session.status === 'failed') await engineOf(kind).resumeInClone(session.id)
      engineOf(kind).annotate(session.id, { worktree: null, note: withoutKept(session.note) })
    }
    for (const run of cache.allRuns()) await forget('run', run)
    for (const sweep of cache.allSweeps()) await forget('sweep', sweep)
  }

  const sweepWorktrees = (): Promise<void> => {
    sweeping = sweeping.then(sweepOnce).catch((error: unknown) => log(`auto-review: the worktree sweep failed: ${messageOf(error)}`)).finally(announce)
    return track(sweeping)
  }

  // the worktree a run starts in: the slot is already held, so the fetch and the add happen with the cap as it will be
  const fetchOrigin = async (clone: string, env: Readonly<Record<string, string>>): Promise<void> => {
    const fetchOnce = () => git(['-C', clone, 'fetch', 'origin'], { env })
    let answer = await fetchOnce()
    if (answer.code === 0) return
    // one that lost a race fails while leaving the refs right, and the next succeeds
    await new Promise<void>((resume) => timers.set(resume, fetchRetryMs))
    if (stopped) throw new Error('the server is stopping')
    answer = await fetchOnce()
    if (answer.code !== 0) throw new Error(`git fetch failed: ${firstLine(answer.stderr)}`)
  }

  const prepare = (kind: WorktreeKind, repo: string) => async (session: Session): Promise<string> => {
    const settings = config()
    const clone = cloneOf(settings)
    if (clone === null) throw new Error('cloneDir is not set')
    const branch = cache.readView(repo).defaultBranch
    if (branch === null) throw new Error(`no default branch is cached for ${repo}`)
    await fs.mkdir(folder)
    const env = gitConfigEnv(session.command)
    await fetchOrigin(clone, env)
    if (stopped) throw new Error('the server is stopping')
    const path = worktreePath(folder, kind, session.id)
    const answer = await git(['-C', clone, 'worktree', 'add', '--detach', path, `origin/${branch}`], { env })
    if (answer.code !== 0) throw new Error(`git worktree add failed: ${firstLine(answer.stderr)}`)
    return path
  }

  const othersArgs = (number: number, noPost: boolean): string[] => [String(number), ...(noPost ? ['--no-post'] : [])]

  const sweepArgsNow = (repo: string, settings: AutoReviewSettings): string[] => [...(sweepRequest(repo).args), ...(settings.post.dependabot ? [] : ['--no-post'])]

  // what each PR's run is built with is decided here alone, from the settings in effect: a run of the viewer's own PR always takes --no-post, and any other takes it unless post.others is on. A switch turned off after this is the launcher's to catch, at the spawn
  const runArgs = (pr: RawOpenPr | undefined, number: number, reason: QueueReason | null, settings: Config): string[] => {
    const own = reason === 'selfReview' || (pr !== undefined && isMine(pr, settings))
    return othersArgs(number, own || settings.autoReview?.post.others !== true)
  }

  const queueItems = (items: readonly QueueItem[], tick: number, settings: Config, auto: AutoReviewSettings, clone: string, open: readonly RawOpenPr[]): number => {
    for (const item of items) {
      if (item.kind === 'dependabot') {
        const args = sweepArgsNow(settings.repo, auto)
        sweepLauncher.queueScheduled({ ...sweepRequest(settings.repo), args }, clone, { tick, reason: 'dependabot', headOid: null, posting: mayPost(sweepCommand, args) })
        continue
      }
      const pr = open.find((candidate) => candidate.number === item.number)
      if (pr === undefined) continue
      const args = runArgs(pr, item.number, item.reason, settings)
      const request: StartRequest = { repo: settings.repo, number: item.number, command: 'review-pr', args, label: defaultRun(pr, settings).label }
      launcher.queueScheduled(request, clone, { tick, reason: item.reason, headOid: item.headSha, posting: mayPost('review-pr', args) })
    }
    return items.length
  }

  // the note a PR left for the owner carries, on its newest failed run, ahead of how that run failed; written once
  const leaveNote = <T extends Session>(engine: Launcher<T>, failures: readonly T[], word: string): void => {
    const newest = [...failures].sort((a, b) => b.id - a.id)[0]
    if (newest === undefined || newest.note?.startsWith(word) === true) return
    engine.annotate(newest.id, { note: newest.note === null || newest.note === '' ? word : `${word}: ${newest.note}` })
  }

  const records = (repo: string): { runs: Run[], sweeps: Sweep[], autoRuns: AutoRun[], autoSweeps: AutoSweep[] } => {
    const runs = cache.allRuns().filter((run) => run.repo === repo)
    const sweeps = cache.allSweeps().filter((sweep) => sweep.repo === repo)
    return { runs, sweeps, autoRuns: runs.map((run) => toAutoRun(run, settledRuns)), autoSweeps: sweeps.map((sweep) => toAutoSweep(sweep, settledSweeps)) }
  }

  const inFlight = (): number => [...cache.runningRuns(), ...cache.runningSweeps()].filter((session) => session.origin === 'auto').length

  // one queued row started as the settings now say, or dropped; true when the next may be tried
  const startRun = async (run: Run, settings: Config, open: readonly RawOpenPr[]): Promise<boolean> => {
    const recheck = recheckQueued({ kind: 'others', number: run.number, reason: 'new', retry: false, headSha: run.headOid ?? '' }, open)
    if (recheck.action === 'drop') {
      launcher.skipQueued(run.id, recheck.note)
      return true
    }
    const pr = open.find((candidate) => candidate.number === run.number)
    const args = runArgs(pr, run.number, run.reason, settings)
    const request: StartRequest = { repo: run.repo, number: run.number, command: run.command, args, label: run.label, runner: run.runner }
    const started = await launcher.startScheduled(run.id, request, { args, posting: mayPost(run.command, args), headOid: recheck.headSha }, prepare('run', run.repo))
    return await afterStart('run', started)
  }

  const startSweep = async (sweep: Sweep, settings: Config, auto: AutoReviewSettings): Promise<boolean> => {
    const args = sweepArgsNow(sweep.repo, auto)
    const request: StartRequest = { ...sweepRequest(settings.repo, sweep.runner), args }
    const started = await sweepLauncher.startScheduled(sweep.id, request, { args, posting: mayPost(sweep.command, args) }, prepare('sweep', sweep.repo))
    return await afterStart('sweep', started)
  }

  // a start the cap took back at the last moment leaves its row queued with a fresh worktree, which goes, since it starts over when it next fits. Anything but a run now running ends the tick's starts
  const afterStart = async (kind: WorktreeKind, session: Session | null): Promise<boolean> => {
    if (session?.status === 'queued' && session.worktree !== null) await remove(kind, session.id, expandHome(session.worktree, home))
    return session?.status === 'running'
  }

  const optedIn = (reason: QueueReason | null, auto: AutoReviewSettings): boolean =>
    reason === 'dependabot' ? auto.dependabot : reason === 'selfReview' ? auto.own : auto.others

  // the tick's last step: as many as fit, one at a time, each read afresh, since a save, the cap, and the clock may all move meanwhile. Answers whether the day's limit had been reached before any started
  const startQueued = async (repo: string, exempt: boolean, open: readonly RawOpenPr[]): Promise<boolean> => {
    const budget = (auto: AutoReviewSettings): ReturnType<typeof startBudget> => {
      const { autoRuns, autoSweeps } = records(repo)
      return startBudget({
        concurrency: auto.concurrency,
        inFlight: inFlight(),
        dailyLimit: auto.dailyLimit,
        startedToday: startedToday(autoRuns, autoSweeps, clock.now(), timeZone),
        capRoom: launcher.queueing().review ? 0 : 1,
      })
    }
    const opening = config().autoReview
    if (opening === undefined || budget(opening).skip !== null) return opening !== undefined
    const candidates: ({ kind: 'run', row: Run } | { kind: 'sweep', row: Sweep })[] = [
      ...cache.queuedRuns().filter((run) => run.origin === 'auto' && run.repo === repo).map((row) => ({ kind: 'run' as const, row })),
      ...cache.queuedSweeps().filter((sweep) => sweep.origin === 'auto' && sweep.repo === repo).map((row) => ({ kind: 'sweep' as const, row })),
    ]
    for (const candidate of candidates) {
      const settings = config()
      const auto = settings.autoReview
      if (stopped || auto === undefined || !auto.enabled || settings.repo !== repo) break
      // a run in flight when the window closes finishes, and nothing new starts until it reopens; Run now is the one tick exempt
      if (!exempt && !isActiveAt(auto.activeHours, clock.now(), timeZone)) break
      if (budget(auto).count === 0) break
      // an opt-in turned off since it was queued keeps it waiting, and starts nothing the owner has just said not to
      if (!optedIn(candidate.row.reason, auto)) continue
      const next = candidate.kind === 'run' ? await startRun(candidate.row, settings, open) : await startSweep(candidate.row, settings, auto)
      if (!next) break
    }
    return false
  }

  const runTick = async (tick: Tick, exempt: boolean): Promise<void> => {
    const { repo } = tick
    const finish = (changes: TickChanges): void => {
      if (!stopped) cache.updateTick(tick.id, { ...changes, finishedAt: now() })
    }
    const skip = (skipReason: TickSkip, changes: TickChanges = {}): void => finish({ ...changes, state: 'skipped', skipReason })
    const first = config()
    // the commands post as whichever account gh uses
    let login = ''
    try {
      login = await fetchViewerLogin(gh)
    } catch (error) {
      log(`auto-review: cannot confirm which account gh uses: ${messageOf(error)}`)
      return skip('identityMismatch')
    }
    if (stopped) return
    if (login.toLowerCase() !== first.viewer.toLowerCase()) return skip('identityMismatch')
    const clone = cloneOf(first)
    if (clone === null) return skip('noClone')
    const remotes = await git(['-C', clone, 'remote', '-v']).catch((error: unknown) => {
      log(`auto-review: cannot run git: ${messageOf(error)}`)
      return null
    })
    if (stopped) return
    if (remotes === null || remotes.code !== 0 || !remoteNamesRepo(remotes.stdout, repo)) return skip('noClone')
    await sweepWorktrees()
    if (stopped) return
    // joins a running cycle, reuses a recent success, or starts one
    const recent = (): boolean => {
      const at = cache.readView(repo).lastSuccessAt
      return at !== null && clock.now() - Date.parse(at) <= reuseMs
    }
    let cycle: number | null = null
    if (cache.runningCycle() !== null || !recent()) {
      cycle = poller.refresh('autoReview').cycle
      if (cycle === null) return skip('fetchFailed')
      await poller.idle()
      if (stopped) return
      if (cache.latestCycle(repo)?.state !== 'finished') return skip('fetchFailed', { cycle })
    }
    const settings = config()
    const auto = settings.autoReview
    // a save during the fetch can have turned it off, or left this repository
    if (auto === undefined || !auto.enabled || settings.repo !== repo) return skip('interrupted', { cycle })
    const cached = cache.readView(repo)
    const open = cached.open.map((row) => row.pr)
    let reports: ReadonlyMap<number, ReportInfo>
    try {
      reports = await scan(expandHome(settings.reportsDir, home), open.map((pr) => ({ number: pr.number, headRefName: pr.headRefName })))
    } catch (error) {
      log(`auto-review: cannot scan ${settings.reportsDir}: ${messageOf(error)}`)
      return skip('fetchFailed', { cycle })
    }
    if (stopped) return
    await readSettled()
    if (stopped) return
    const { runs, sweeps, autoRuns, autoSweeps } = records(repo)
    // a run of the PR the owner has in flight would refuse a start, and a queued row would hide it from the Agent cell
    const ownersRun = (number: number): boolean => launcher.busy({ repo, number }) && !autoRuns.some((run) => run.origin === 'auto' && run.number === number && isLive(run))
    const rows = poller.openRows().filter((row) => !ownersRun(row.number))
    const queue = buildQueue({ rows, openPrs: open, settings: auto, reports, runs: autoRuns, sweeps: autoSweeps, lastSweepRows: lastSweepRowsOf(sweeps) })
    for (const left of queue.leftForOwner) {
      if (left.outcome === 'stopped') continue
      const head = open.find((pr) => pr.number === left.number)?.headRefOid
      leaveNote(launcher, runs.filter((run) => run.origin === 'auto' && run.number === left.number && run.status === 'failed' && sameHead(run.headOid, head)), left.outcome)
    }
    if (queue.sweepFailedTwice) leaveNote(sweepLauncher, sweeps.filter((sweep) => sweep.origin === 'auto' && sweep.status === 'failed'), 'failedTwice')
    const queued = queueItems(queue.items, tick.id, settings, auto, clone, open)
    const counts: TickChanges = { cycle, qualified: queue.qualified, alreadyCurrent: queue.alreadyCurrent, queued }
    announce()
    const limited = await startQueued(repo, exempt, open)
    if (limited) return skip('dailyLimit', counts)
    finish({ ...counts, state: 'ran' })
  }

  const disarm = (): void => {
    if (armed !== null) timers.clear(armed.handle)
    armed = null
  }

  // the one timer, on no client's schedule: the next tick inside the window, one interval after the last began, or when the window next opens. A server start never ticks at once, since it makes no GitHub call, so a due time already past is one interval from now
  const plan = (): void => {
    disarm()
    if (stopped || ticking !== null) return
    const settings = config()
    const auto = settings.autoReview
    if (auto !== undefined) {
      const at = clock.now()
      let due: number | null = null
      if (isActiveAt(auto.activeHours, at, timeZone)) {
        // a cache that cannot be read keeps the clock going, as a tick that has not happened yet
        let last: Tick | null = null
        try {
          last = cache.latestTick(settings.repo)
        } catch (error) {
          log(`auto-review: cannot read the last tick: ${messageOf(error)}`)
        }
        const interval = auto.intervalMinutes * minute
        const after = last === null ? at + interval : Date.parse(last.startedAt) + interval
        const next = after > at ? after : at + interval
        due = isActiveAt(auto.activeHours, next, timeZone) ? next : null
      }
      const when = due ?? nextActiveStart(auto.activeHours, at, timeZone)
      if (when !== null) {
        const wanted = when
        armed = {
          at: wanted,
          handle: timers.set(() => {
            armed = null
            fire(wanted)
          }, Math.min(longestTimer, Math.max(0, wanted - at))),
        }
      }
    }
    announce()
  }

  const fire = (wanted: number): void => {
    const auto = config().autoReview
    // only a due time reached, while on and inside the window, ticks; a wait cut short by the longest timer or a disabled clock plans again
    if (stopped || auto === undefined || !auto.enabled || clock.now() < wanted || !isActiveAt(auto.activeHours, clock.now(), timeZone)) return plan()
    try {
      begin(false)
    } catch (error) {
      // nothing a timer runs may throw; the next interval tries again
      log(`auto-review: cannot begin a tick: ${messageOf(error)}`)
      plan()
    }
  }

  const begin = (exempt: boolean): number => {
    disarm()
    const tick = cache.createTick(config().repo)
    const entry = { id: tick.id, done: Promise.resolve() }
    ticking = entry
    announce()
    entry.done = runTick(tick, exempt).catch((error: unknown) => {
      log(`auto-review: tick ${tick.id} failed: ${messageOf(error)}`)
      if (!stopped) cache.updateTick(tick.id, { finishedAt: now(), state: 'skipped', skipReason: 'interrupted' })
    }).finally(() => {
      ticking = null
      plan()
    })
    return tick.id
  }

  const view = (): AutoReviewView | null => {
    const settings = config()
    const auto = settings.autoReview
    if (auto === undefined) return null
    const { runs, sweeps, autoRuns, autoSweeps } = records(settings.repo)
    const sessions: Session[] = [...runs, ...sweeps].filter((session) => session.origin === 'auto')
    const running = sessions.filter((session) => session.status === 'running').length
    const last = cache.latestTick(settings.repo)
    const at = clock.now()
    let state: AutoReviewState = 'idle'
    if (!auto.enabled) state = 'off'
    else if (running > 0 || ticking !== null) state = 'running'
    else if (!isActiveAt(auto.activeHours, at, timeZone)) state = 'outsideHours'
    else if (last !== null && blockedBy.includes(last.skipReason)) state = 'blocked'
    return {
      enabled: auto.enabled,
      state,
      nextTickAt: auto.enabled && armed !== null ? iso(armed.at) : null,
      running,
      queued: sessions.filter((session) => session.status === 'queued').length,
      startedToday: startedToday(autoRuns, autoSweeps, at, timeZone),
      lastTick: last === null ? null : { at: last.startedAt, state: last.state, skipReason: last.skipReason, queued: last.queued },
      posting: auto.post,
      sweepHold: sweepHoldOf(autoSweeps),
      worktrees: {
        kept: sessions.flatMap((session) => session.note?.includes(keptWord) === true && session.worktree !== null ? [session.worktree] : []),
        unlisted,
      },
    }
  }

  const sessionChanged = (kind: WorktreeKind, session: Session): void => {
    // only once its process is gone, which a settle has proved; a refusal is left for the next sweep
    if (session.origin === 'auto' && session.worktree !== null && (session.status === 'done' || session.status === 'stopped') && session.note?.includes(keptWord) !== true) {
      void remove(kind, session.id, expandHome(session.worktree, home))
    }
    announce()
  }

  return {
    start: () => {
      void sweepWorktrees()
      plan()
    },
    runNow: () => {
      if (ticking !== null) return { started: false, tick: ticking.id }
      if (config().autoReview?.enabled !== true) return null
      return { started: true, tick: begin(true) }
    },
    configChanged: plan,
    sessionChanged,
    view,
    idle: async () => {
      while (ticking !== null || pending.size > 0) await Promise.all([ticking?.done, ...pending])
    },
    stop: () => {
      stopped = true
      disarm()
    },
  }
}
