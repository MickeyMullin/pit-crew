// src/autoreview.ts
import { basename, dirname } from 'node:path'
import type { RunStatus } from './cache.ts'
import { attentionOrder, selfReviewOf } from './derive.ts'
import type { OpenRow, OtherRow } from './derive.ts'
import type { RawOpenPr } from './github.ts'
import { isDependabot } from './launcher.ts'
import type { ReportInfo } from './reports.ts'
import { addDays, clockChangeOn, instantAt, localDateOf, minute, minutesOfDay, startOfDate, startOfDay, weekdayOf } from './time.ts'
import type { LocalDate } from './time.ts'

// the pure half of auto-review (section 10 of DESIGN.md): qualification, the queue, the retry rule, the daily limit, and the worktree sweep's selection. Every function takes its inputs explicitly (rows, settings, run records, the clock as a number, and report lookups) and does no I/O, starts no timer, spawns nothing, and makes no GitHub call; the scheduler runtime calls them

export const weekdayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
export type WeekdayName = typeof weekdayNames[number]

export type ActiveHours = { days: WeekdayName[], from: string, to: string }

// the autoReview key (section 10, Configuration)
export type AutoReviewSettings = {
  enabled: boolean
  intervalMinutes: number
  activeHours: ActiveHours
  others: boolean
  own: boolean
  dependabot: boolean
  concurrency: number
  dailyLimit: number
  post: { others: boolean, dependabot: boolean }
}

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

export type AutoRunStatus = RunStatus | 'skipped'

export type AutoRun = {
  id: number
  origin: 'manual' | 'auto'
  number: number
  // the head the run reviewed, full or short; null before it is known
  headOid: string | null
  status: AutoRunStatus
  // when it really started; null while it is only queued, and for a run stopped or skipped before it started. A launcher row's started_at holds the time it was queued until then, so the scheduler's mapping does not copy it for those
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

// the duplicate-run guard: the report names the head (section 5's detection, whoever ran it), or an auto run at that head has finished, is waiting for input, or is already queued or running
export const isReviewedAtHead = (row: { number: number, headSha: string }, report: ReportInfo | undefined, runs: readonly AutoRun[]): boolean =>
  selfReviewOf(report, row.headSha).state === 'current'
  || autoRunsFor(runs, row).some((entry) => entry.status === 'done' || entry.status === 'needsInput' || entry.status === 'queued' || entry.status === 'running')

export type RetryDecision = 'retry' | 'failedTwice' | 'postUnknown'

// what to do about a PR whose auto runs at one head have failed; failures holds every such failed run, the newest last. A run that was allowed to post is never retried once it may have posted
export const retryDecision = (failures: readonly AutoRun[]): RetryDecision => {
  const newest = [...failures].sort((a, b) => a.id - b.id).at(-1)
  if (newest !== undefined && newest.posting && (newest.postStarted || newest.posted || newest.ghFailed)) return 'postUnknown'
  return failures.length >= 2 ? 'failedTwice' : 'retry'
}

// the queue

export type QueueReason = 'requested' | 'new' | 'pushed' | 'selfReview' | 'dependabot'

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
  // every recorded run and sweep that may matter; manual ones are ignored
  runs: readonly AutoRun[]
  sweeps: readonly AutoSweep[]
  // the last scheduler sweep's rows, or null when it has none
  lastSweepRows: readonly SweepMemoryRow[] | null
}

export type LeftForOwner = { number: number, outcome: 'failedTwice' | 'postUnknown' }

export type QueueResult = {
  // new runs to queue, in order: others, then own, then the sweep
  items: QueueItem[]
  // the tick row's counts
  qualified: number
  alreadyCurrent: number
  leftForOwner: LeftForOwner[]
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

export const buildQueue = ({ rows, openPrs, settings, reports, runs, sweeps, lastSweepRows }: QueueInput): QueueResult => {
  // Dependabot is told by its author, not by the bots list, and only ever goes through the sweep
  const dependabot = openPrs.filter(isDependabot)
  const reviewable = rows.filter((row) => !dependabot.some((pr) => pr.number === row.number))
  const items: QueueItem[] = []
  const leftForOwner: LeftForOwner[] = []
  let qualified = 0
  let alreadyCurrent = 0
  const consider = (row: OpenRow, kind: 'others' | 'own', reason: Exclude<QueueReason, 'dependabot'>): void => {
    qualified += 1
    if (isReviewedAtHead(row, reports.get(row.number), runs)) {
      alreadyCurrent += 1
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
  // a sweep reviews the whole set, and at most one is queued or running
  if (settings.dependabot && !sweeps.some((entry) => entry.status === 'queued' || entry.status === 'running')) {
    const prs = sweepIsDue(dependabot, lastSweepRows)
    if (prs.length > 0) {
      qualified += 1
      items.push({ kind: 'dependabot', reason: 'dependabot', prs })
    }
  }
  return { items, qualified, alreadyCurrent, leftForOwner }
}

// the check before a queued run starts: a PR that left the open list closed and is dropped, and one still there, a draft included, runs and records the head it is at now, which may have moved
export type Recheck = { action: 'start', headSha: string | null } | { action: 'drop', note: 'closed' }

export const recheckQueued = (item: QueueItem, openPrs: readonly RawOpenPr[]): Recheck => {
  if (item.kind === 'dependabot') return { action: 'start', headSha: null }
  const pr = openPrs.find((candidate) => candidate.number === item.number)
  return pr === undefined ? { action: 'drop', note: 'closed' } : { action: 'start', headSha: pr.headRefOid }
}

// the daily limit and the slots a tick may fill

// auto runs and sweeps that started on ms's local day; manual ones, queued ones, and skipped ones never count
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
  // the paths git lists, which are resolved
  listed: readonly string[]
  // Pit View's worktrees folder, resolved the same way, because git lists resolved paths
  dir: string
  runs: readonly AutoRun[]
  sweeps: readonly AutoSweep[]
  // every open PR in the cache, which shows whether a PR closed or moved on; null until a listing has completed (the cache was just built, or rebuilt, and its runs were kept), when neither can be told
  openPrs: readonly RawOpenPr[] | null
}

// a needsInput or failed run waits for the owner until it is settled: a newer run has started for the PR, the PR closed or got a new head, or the caller knows its session ended
const runSettled = (record: AutoRun, runs: readonly AutoRun[], openPrs: readonly RawOpenPr[] | null): boolean => {
  if (record.settled === true || runs.some((other) => other.number === record.number && other.id > record.id && hasStarted(other))) return true
  if (openPrs === null) return false
  const pr = openPrs.find((candidate) => candidate.number === record.number)
  return pr === undefined || (record.headOid !== null && !sameHead(pr.headRefOid, record.headOid))
}

const worktreeKept = (entry: WorktreeEntry, { runs, sweeps, openPrs }: OrphanInput): boolean => {
  const record = entry.kind === 'run' ? runs.find((candidate) => candidate.id === entry.id) : sweeps.find((candidate) => candidate.id === entry.id)
  if (record === undefined) return false
  if (record.status === 'queued' || record.status === 'running') return true
  if (record.status !== 'needsInput' && record.status !== 'failed') return false
  if (entry.kind === 'sweep') return record.settled !== true && !sweeps.some((other) => other.id > record.id && hasStarted(other))
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
