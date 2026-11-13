// src/cache.ts
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite'
import type { Clock, ExtraInstructions, RunnerName } from './config.ts'
import type { ClosedResult, GhErrorKind, OpenPage, RawOpenPr } from './github.ts'
import type { RunResultJson, StepSlot } from './launcher.ts'

// why a run was queued (section 10 of DESIGN.md, What qualifies)
export type QueueReason = 'requested' | 'new' | 'pushed' | 'selfReview' | 'dependabot'

// bump on any schema change; an older cache file's GitHub tables are dropped and rebuilt, since they hold nothing GitHub cannot give back. runs and sweeps are the exception: they survive a rebuild, and a change to their columns needs a migration of its own (version 5 added runs.steps with ALTER TABLE). Version 6 added latestOpinionatedReviews to the open-PR query: a cached row written before it lacks the field, and the rebuild empties prs so no such row is derived. Version 7 added the sweeps table and changed no GitHub table. Version 10 added the database ids of timeline comments and reviews to the open-PR query, which the Last activity links read, so the GitHub tables are rebuilt again. Version 11 added runs.report_hash and runs.post_attempted_at, for Post it, and changed no GitHub table. Version 12 added the database id of the latest reviews to the open-PR query, which the Changes requested links read, so the GitHub tables are rebuilt again. Version 13 added GitHub's stack marker (stack and stackEntry) to the open-PR query, which the stack chip, the Review stack start, and the stack report lookup read in place of the base-branch guess, so the GitHub tables are rebuilt again. Version 14 added the ticks table and auto-review's columns on runs and sweeps (origin, tick, reason, queued_at, posting, and worktree on both, and head_oid on runs), changing no GitHub table; a row from before it reads as a manual run. Version 15 added runs.extra_instructions, the extra review instructions a run used and where they came from, and changed no GitHub table; a row from before it reads as having none. Version 16 added the workflow run's identity (databaseId, createdAt, and runAttempt, and the workflow's databaseId) to the check runs of the open-PR query, which the CI readings use to drop a superseded run, so the GitHub tables are rebuilt again
export const schemaVersion = 16

// the last version that changed what the GitHub tables hold; a cache at this version or later keeps them through a bump, since a bump after it only adds tables
export const githubTablesVersion = 16

export class CacheError extends Error {
  override name = 'CacheError'
}

export type SnapshotKind = 'open-page' | 'closed'
// what started a cycle (section 3 of DESIGN.md, Runtime)
export type Trigger = 'active' | 'interval' | 'manual' | 'config' | 'autoReview'
export const triggers: readonly Trigger[] = ['active', 'interval', 'manual', 'config', 'autoReview']
export type CycleState = 'running' | 'finished' | 'failed'
// why a cycle failed: gh's own kinds, a server stopped mid-cycle, or a fault in Pit View itself
export type CycleErrorKind = GhErrorKind | 'interrupted' | 'internal'
export type RowState = 'current' | 'pending' | 'stale'
export type SectionState = RowState | 'loading'

export type Cycle = {
  id: number
  repo: string
  trigger: Trigger
  state: CycleState
  startedAt: string
  finishedAt: string | null
  error: string | null
  // null on success, and on failures recorded without a kind
  errorKind: CycleErrorKind | null
  pagesDone: number
  // distinct open PRs this cycle has written so far
  prsUpdated: number
  // null until the first open-PR page reports the total
  prsTotal: number | null
}

// error is set only when state is stale: the error of the cycle that failed to reach the row
export type RowFreshness = { state: RowState, fetchedAt: string, error: string | null }
export type SectionFreshness = { state: SectionState, fetchedAt: string | null, error: string | null }

export type CachedPr = {
  repo: string
  number: number
  // closed means it left the open list; the closed search reports what happened to it
  state: 'open' | 'closed'
  updatedAt: string
  headOid: string
  fetchedAt: string
  // the cycle that last fetched it
  cycle: number
  lastSeenAt: string
  pr: RawOpenPr
  freshness: RowFreshness
}

export type CachedClosed = { cycle: number, fetchedAt: string, result: ClosedResult }

// everything GET /api/view needs from the cache, read in one call
export type CachedView = {
  repo: string
  // the latest cycle for this repo, running or not; null before the first
  cycle: Cycle | null
  lastSuccessAt: string | null
  defaultBranch: string | null
  // open rows, most recently updated first
  open: CachedPr[]
  // the latest successful closed search, whichever cycle it came from
  closed: CachedClosed | null
  sections: { open: SectionFreshness, closed: SectionFreshness }
}

export type FinishResult = {
  cycle: Cycle
  // PR numbers that left the open list; set only when the cycle succeeded
  removed: number[]
  // open rows the cycle did not reach; set only when the cycle failed
  stale: CachedPr[]
}

// a review session's state; queued waits for a slot under the cap on concurrent reviews, and skipped is a scheduled run dropped before it started
export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'needsInput' | 'stopped' | 'skipped'
export const runStatuses: readonly RunStatus[] = ['queued', 'running', 'done', 'failed', 'needsInput', 'stopped', 'skipped']

// who started a session
export type Origin = 'manual' | 'auto'

// what a review session and a sweep share: Pit View's record of one launched process
export type Session = {
  id: number
  repo: string
  // the pit-crew command, such as review-pr, and its arguments without --emit-json
  command: string
  args: string[]
  // what the Agent cell calls it: Review, Re-review, Self-review
  label: string
  runner: RunnerName
  // the session's working directory and the run directory, both written with ~
  cwd: string
  dir: string
  // Claude's is known at start; Codex's arrives with its first event
  sessionId: string | null
  pid: number | null
  // the process's start time as ps prints it, so a reused pid is never mistaken for the run
  pidStartedAt: string | null
  startedAt: string
  // the newest events.jsonl line: its time, step and state
  lastStepAt: string | null
  step: string | null
  stepState: string | null
  // the five step slots folded from events.jsonl, or null before the first line (and for runs
  // from before version 5)
  steps: StepSlot[] | null
  finishedAt: string | null
  status: RunStatus
  // result.json as parsed and checked, or null when there is none
  result: RunResultJson | null
  // why it failed or stopped: a kind such as noResult, optionally followed by ': ' and detail
  note: string | null
  // Claude's latest total_cost_usd; Codex reports none
  costUsd: number | null
  // the command that resumes the session, once its id is known
  resume: string | null
  // what section 10 of DESIGN.md records: who started it, the tick that queued it, why, when, whether it was allowed to post, and its worktree written with ~ while one remains
  origin: Origin
  tick: number | null
  reason: QueueReason | null
  queuedAt: string | null
  posting: boolean
  worktree: string | null
}

// one review session Pit View started (section 8 of DESIGN.md, Launching runs); resolvedByHand is set when the owner's re-read replaced the outcome recorded at exit, and firstNote keeps the note recorded at exit once a failed re-read replaced it (an empty string when that note was null); reportHash is the SHA-256 of the report a review finished with, null when it named none or the report could not be read, and postAttemptedAt is when Post it began a post, written before gh runs and cleared only when GitHub refused it; headOid is the head a scheduled run was queued for, or last moved to
export type Run = Session & { number: number, resolvedByHand: boolean, firstNote: string | null, reportHash: string | null, postAttemptedAt: string | null, headOid: string | null, extraInstructions: ExtraInstructions | null }

// one Dependabot sweep Pit View started (section 8, Sweeps): a record of its own with no PR number
export type Sweep = Session

type AutoFields = 'origin' | 'tick' | 'reason' | 'queuedAt' | 'posting' | 'worktree'
export type NewRun = Omit<Run, 'id' | 'dir' | 'steps' | 'resolvedByHand' | 'firstNote' | 'reportHash' | 'postAttemptedAt' | 'headOid' | 'extraInstructions' | AutoFields> & Partial<Pick<Run, 'headOid' | 'extraInstructions' | AutoFields>>
export type NewSweep = Omit<Sweep, 'id' | 'dir' | 'steps' | AutoFields> & Partial<Pick<Sweep, AutoFields>>
export type RunChanges = Partial<Omit<Session, 'id' | 'repo'>> & { resolvedByHand?: boolean, firstNote?: string | null, reportHash?: string | null, postAttemptedAt?: string | null, headOid?: string | null, extraInstructions?: ExtraInstructions | null }

// one scheduler tick (section 10 of DESIGN.md, Recording). state and finishedAt are null while it runs; interrupted is a tick the server stopped under or that failed on its own, and the rest are the spec's reasons to skip
export type TickState = 'ran' | 'skipped'
export type TickSkip = 'identityMismatch' | 'noClone' | 'fetchFailed' | 'dailyLimit' | 'interrupted'
export type Tick = {
  id: number
  repo: string
  startedAt: string
  finishedAt: string | null
  state: TickState | null
  skipReason: TickSkip | null
  // the cycle it joined or started, a plain number since cycles are pruned; null when it reused the cache or skipped before that step
  cycle: number | null
  // counts, null when it skipped before computing them
  qualified: number | null
  alreadyCurrent: number | null
  queued: number | null
}
export type TickChanges = Partial<Omit<Tick, 'id' | 'repo' | 'startedAt'>>

export type Cache = {
  // starts a cycle; only one may run at a time across all repos
  startCycle: (repo: string, trigger: Trigger) => Cycle
  // stores one open-PR page as it arrives and returns the rows it wrote, all current
  writeOpenPage: (cycleId: number, page: OpenPage) => CachedPr[]
  // stores the closed search, which covers both Closed ranges
  writeClosed: (cycleId: number, result: ClosedResult) => CachedClosed
  // takes the ordering number of a one-PR refresh; call it before the GitHub read begins and hand it to writePr or closePr
  beginRefresh: () => number
  // stores one PR fetched on its own, outside any cycle, stamped with the repo's latest cycle so it reads as current; returns the row as written. A stale read (section 3 of DESIGN.md, the prs row) writes nothing: it returns the row already there, or null when there is none. ticket is beginRefresh's number; without one the write takes its number now
  writePr: (repo: string, pr: RawOpenPr, defaultBranch: string | null, ticket?: number) => CachedPr | null
  // marks a PR found closed or merged on its own as gone from the open list; false when it was not open or the read is stale
  closePr: (repo: string, number: number, ticket?: number) => boolean
  // stores a failed response, so the section can report the error it hit
  recordError: (cycleId: number, kind: SnapshotKind, page: number | null, error: string) => void
  // a null error marks the cycle successful; one that reached the last page of the open list also removes the PRs absent from it and sets the repo's floor
  finishCycle: (cycleId: number, error?: string | null, errorKind?: CycleErrorKind | null) => FinishResult
  readView: (repo: string) => CachedView
  cycle: (id: number) => Cycle | null
  latestCycle: (repo: string) => Cycle | null
  runningCycle: () => Cycle | null
  prune: () => void
  // runs: the row is written first, so its id names the run directory dirOf returns
  createRun: (run: NewRun, dirOf: (id: number) => string) => Run
  updateRun: (id: number, changes: RunChanges) => Run
  getRun: (id: number) => Run | null
  // one PR's runs, newest first
  runsFor: (repo: string, number: number, limit?: number) => Run[]
  // the newest run of each PR in a repo
  latestRuns: (repo: string) => Map<number, Run>
  // every run still recorded as running, in any repo
  runningRuns: () => Run[]
  // every run still waiting in the queue, in any repo, oldest first
  queuedRuns: () => Run[]
  // deletes all but the newest keepRuns finished runs and returns them, so their folders can go
  pruneRuns: () => Run[]
  // sweeps: the same, in a table of their own with ids of their own
  createSweep: (sweep: NewSweep, dirOf: (id: number) => string) => Sweep
  updateSweep: (id: number, changes: RunChanges) => Sweep
  getSweep: (id: number) => Sweep | null
  // a repo's sweeps, newest first
  sweepsFor: (repo: string, limit?: number) => Sweep[]
  // every sweep still recorded as running, in any repo
  runningSweeps: () => Sweep[]
  // sweeps waiting in the review queue, which a restart fails
  queuedSweeps: () => Sweep[]
  // deletes all but the newest keepSweeps finished sweeps and returns them, so their folders can go
  pruneSweeps: () => Sweep[]
  // every recorded run and sweep in any repo, oldest first, for the scheduler's rules and its worktree sweep
  allRuns: () => Run[]
  allSweeps: () => Sweep[]
  // ticks: the row is written first, so what it queues can name it; the oldest beyond keepTicks go
  createTick: (repo: string) => Tick
  updateTick: (id: number, changes: TickChanges) => Tick
  // a repo's ticks, newest first
  ticksFor: (repo: string, limit?: number) => Tick[]
  latestTick: (repo: string) => Tick | null
  close: () => void
  // the open handle, for tests and diagnostics
  db: DatabaseSync
}

export type CacheOptions = {
  // ':memory:' in tests; the server passes cacheFile(home) from config.ts
  path: string
  clock: Clock
  keepCycles?: number
  keepSnapshotCycles?: number
  keepRuns?: number
  keepSweeps?: number
  keepTicks?: number
}

const schema = [
  'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  // AUTOINCREMENT so a pruned cycle id is never reused by rows that still name it
  `CREATE TABLE cycles (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, trigger TEXT NOT NULL CHECK (trigger IN (${triggers.map((name) => `'${name}'`).join(', ')})), started_at TEXT NOT NULL, finished_at TEXT, ok INTEGER, error TEXT, error_kind TEXT, pages_done INTEGER NOT NULL DEFAULT 0, prs_updated INTEGER NOT NULL DEFAULT 0, prs_total INTEGER)`,
  'CREATE INDEX cycles_by_repo ON cycles (repo, id)',
  'CREATE TABLE snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, cycle INTEGER NOT NULL, repo TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN (\'open-page\', \'closed\')), page INTEGER, fetched_at TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT, payload TEXT)',
  'CREATE INDEX snapshots_by_cycle ON snapshots (cycle)',
  'CREATE INDEX snapshots_by_kind ON snapshots (repo, kind, ok, id)',
  'CREATE TABLE prs (repo TEXT NOT NULL, number INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN (\'open\', \'closed\')), updated_at TEXT NOT NULL, head_oid TEXT NOT NULL, fetched_at TEXT NOT NULL, cycle INTEGER NOT NULL, last_seen_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (repo, number))',
  'CREATE INDEX prs_by_state ON prs (repo, state)',
]

// kept across rebuilds: no status CHECK, so phase 4's queued and skipped need no rebuild
const runsSchema = [
  'CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, number INTEGER NOT NULL, command TEXT NOT NULL, args TEXT NOT NULL, label TEXT NOT NULL, runner TEXT NOT NULL, cwd TEXT NOT NULL, dir TEXT NOT NULL, session_id TEXT, pid INTEGER, pid_started_at TEXT, started_at TEXT NOT NULL, last_step_at TEXT, step TEXT, step_state TEXT, finished_at TEXT, status TEXT NOT NULL, result TEXT, note TEXT, cost_usd REAL, resume TEXT, steps TEXT, resolved_by_hand INTEGER NOT NULL DEFAULT 0, first_note TEXT, report_hash TEXT, post_attempted_at TEXT, origin TEXT NOT NULL DEFAULT \'manual\', tick INTEGER, head_oid TEXT, reason TEXT, queued_at TEXT, posting INTEGER NOT NULL DEFAULT 0, worktree TEXT, extra_instructions TEXT)',
  'CREATE INDEX IF NOT EXISTS runs_by_pr ON runs (repo, number, id)',
  'CREATE INDEX IF NOT EXISTS runs_by_status ON runs (status)',
]

// kept across rebuilds like runs: a sweep is a record of its own, with the columns of a run except the PR number. Created when missing (version 7), never altered by a bump that only rebuilds the GitHub tables
const sweepsSchema = [
  'CREATE TABLE IF NOT EXISTS sweeps (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, command TEXT NOT NULL, args TEXT NOT NULL, label TEXT NOT NULL, runner TEXT NOT NULL, cwd TEXT NOT NULL, dir TEXT NOT NULL, session_id TEXT, pid INTEGER, pid_started_at TEXT, started_at TEXT NOT NULL, last_step_at TEXT, step TEXT, step_state TEXT, finished_at TEXT, status TEXT NOT NULL, result TEXT, note TEXT, cost_usd REAL, resume TEXT, steps TEXT, origin TEXT NOT NULL DEFAULT \'manual\', tick INTEGER, reason TEXT, queued_at TEXT, posting INTEGER NOT NULL DEFAULT 0, worktree TEXT)',
  'CREATE INDEX IF NOT EXISTS sweeps_by_repo ON sweeps (repo, id)',
  'CREATE INDEX IF NOT EXISTS sweeps_by_status ON sweeps (status)',
]

// kept across rebuilds like runs (version 14); AUTOINCREMENT so a pruned id is never reused by the rows that name it
const ticksSchema = [
  'CREATE TABLE IF NOT EXISTS ticks (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, state TEXT, skip_reason TEXT, cycle INTEGER, qualified INTEGER, already_current INTEGER, queued INTEGER)',
  'CREATE INDEX IF NOT EXISTS ticks_by_repo ON ticks (repo, id)',
]

// the columns version 14 added to a table made before it, each with what it reads as on an earlier row
const autoColumns: readonly (readonly [string, string])[] = [
  ['origin', 'TEXT NOT NULL DEFAULT \'manual\''],
  ['tick', 'INTEGER'],
  ['reason', 'TEXT'],
  ['queued_at', 'TEXT'],
  ['posting', 'INTEGER NOT NULL DEFAULT 0'],
  ['worktree', 'TEXT'],
]

const tables = ['meta', 'cycles', 'snapshots', 'prs']

type Row = Record<string, SQLOutputValue>
type Params = Record<string, SQLInputValue>

const str = (row: Row, key: string): string => String(row[key])
const strOrNull = (row: Row, key: string): string | null => row[key] === null || row[key] === undefined ? null : String(row[key])
const int = (row: Row, key: string): number => Number(row[key])
const intOrNull = (row: Row, key: string): number | null => row[key] === null || row[key] === undefined ? null : Number(row[key])

// GitHub's form: second precision, Z suffix
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

const toSession = (row: Row): Session => {
  const result = strOrNull(row, 'result')
  const steps = strOrNull(row, 'steps')
  const cost = row.cost_usd
  return {
    id: int(row, 'id'),
    repo: str(row, 'repo'),
    command: str(row, 'command'),
    args: JSON.parse(str(row, 'args')) as string[],
    label: str(row, 'label'),
    runner: str(row, 'runner') as RunnerName,
    cwd: str(row, 'cwd'),
    dir: str(row, 'dir'),
    sessionId: strOrNull(row, 'session_id'),
    pid: intOrNull(row, 'pid'),
    pidStartedAt: strOrNull(row, 'pid_started_at'),
    startedAt: str(row, 'started_at'),
    lastStepAt: strOrNull(row, 'last_step_at'),
    step: strOrNull(row, 'step'),
    stepState: strOrNull(row, 'step_state'),
    steps: steps === null ? null : JSON.parse(steps) as StepSlot[],
    finishedAt: strOrNull(row, 'finished_at'),
    status: str(row, 'status') as RunStatus,
    result: result === null ? null : JSON.parse(result) as RunResultJson,
    note: strOrNull(row, 'note'),
    costUsd: cost === null || cost === undefined ? null : Number(cost),
    resume: strOrNull(row, 'resume'),
    origin: str(row, 'origin') === 'auto' ? 'auto' : 'manual',
    tick: intOrNull(row, 'tick'),
    reason: strOrNull(row, 'reason') as QueueReason | null,
    queuedAt: strOrNull(row, 'queued_at'),
    posting: int(row, 'posting') === 1,
    worktree: strOrNull(row, 'worktree'),
  }
}

const toRun = (row: Row): Run => {
  const extra = strOrNull(row, 'extra_instructions')
  return { ...toSession(row), number: int(row, 'number'), resolvedByHand: int(row, 'resolved_by_hand') === 1, firstNote: strOrNull(row, 'first_note'), reportHash: strOrNull(row, 'report_hash'), postAttemptedAt: strOrNull(row, 'post_attempted_at'), headOid: strOrNull(row, 'head_oid'), extraInstructions: extra === null ? null : JSON.parse(extra) as ExtraInstructions }
}

const toTick = (row: Row): Tick => ({
  id: int(row, 'id'),
  repo: str(row, 'repo'),
  startedAt: str(row, 'started_at'),
  finishedAt: strOrNull(row, 'finished_at'),
  state: strOrNull(row, 'state') as TickState | null,
  skipReason: strOrNull(row, 'skip_reason') as TickSkip | null,
  cycle: intOrNull(row, 'cycle'),
  qualified: intOrNull(row, 'qualified'),
  alreadyCurrent: intOrNull(row, 'already_current'),
  queued: intOrNull(row, 'queued'),
})

const tickColumns: Record<keyof TickChanges, string> = {
  finishedAt: 'finished_at',
  state: 'state',
  skipReason: 'skip_reason',
  cycle: 'cycle',
  qualified: 'qualified',
  alreadyCurrent: 'already_current',
  queued: 'queued',
}

// a Run's fields to their columns; JSON columns are stored as text
const runColumns: Record<keyof RunChanges, string> = {
  command: 'command',
  args: 'args',
  label: 'label',
  runner: 'runner',
  cwd: 'cwd',
  dir: 'dir',
  sessionId: 'session_id',
  pid: 'pid',
  pidStartedAt: 'pid_started_at',
  startedAt: 'started_at',
  lastStepAt: 'last_step_at',
  step: 'step',
  stepState: 'step_state',
  steps: 'steps',
  finishedAt: 'finished_at',
  status: 'status',
  result: 'result',
  note: 'note',
  costUsd: 'cost_usd',
  resume: 'resume',
  resolvedByHand: 'resolved_by_hand',
  firstNote: 'first_note',
  reportHash: 'report_hash',
  postAttemptedAt: 'post_attempted_at',
  origin: 'origin',
  tick: 'tick',
  reason: 'reason',
  queuedAt: 'queued_at',
  posting: 'posting',
  worktree: 'worktree',
  headOid: 'head_oid',
  extraInstructions: 'extra_instructions',
}

const runValue = (key: keyof RunChanges, value: unknown): SQLInputValue => {
  if (key === 'args' || key === 'result' || key === 'steps' || key === 'extraInstructions') return value === null || value === undefined ? null : JSON.stringify(value)
  if (key === 'resolvedByHand' || key === 'posting') return value === true ? 1 : 0
  return (value ?? null) as SQLInputValue
}

const toCycle = (row: Row): Cycle => {
  const finishedAt = strOrNull(row, 'finished_at')
  return {
    id: int(row, 'id'),
    repo: str(row, 'repo'),
    trigger: str(row, 'trigger') as Trigger,
    state: finishedAt === null ? 'running' : int(row, 'ok') === 1 ? 'finished' : 'failed',
    startedAt: str(row, 'started_at'),
    finishedAt,
    error: strOrNull(row, 'error'),
    errorKind: strOrNull(row, 'error_kind') as CycleErrorKind | null,
    pagesDone: int(row, 'pages_done'),
    prsUpdated: int(row, 'prs_updated'),
    prsTotal: intOrNull(row, 'prs_total'),
  }
}

// a row is current once the latest cycle has fetched it; otherwise it waits on a running
// cycle or was missed by a finished one
const rowFreshness = (cycle: number, fetchedAt: string, latest: Cycle | null): RowFreshness => {
  // with no cycle yet, only a one-PR refresh can have written the row
  if (latest === null || cycle === latest.id) return { state: 'current', fetchedAt, error: null }
  if (latest?.state === 'running') return { state: 'pending', fetchedAt, error: null }
  return { state: 'stale', fetchedAt, error: latest?.error ?? null }
}

// a section is current once the latest cycle has fetched it in full
const sectionFreshness = (
  fetched: boolean,
  fetchedCycle: number | null,
  fetchedAt: string | null,
  latest: Cycle | null,
  error: string | null,
): SectionFreshness => {
  if (!fetched) return { state: 'loading', fetchedAt: null, error }
  if (latest !== null && fetchedCycle === latest.id) return { state: 'current', fetchedAt, error: null }
  if (latest?.state === 'running') return { state: 'pending', fetchedAt, error: null }
  return { state: 'stale', fetchedAt, error }
}

type Stamp = { cycle: number, at: string }
type LastSuccess = { cycle: number, startedAt: string, finishedAt: string }

const metaKey = (name: string, repo: string): string => `${name}:${repo}`

// the Pit View SQLite cache: open rows per PR, raw responses per cycle, and cycle history
export const openCache = ({ path, clock, keepCycles = 200, keepSnapshotCycles = 50, keepRuns = 200, keepSweeps = 50, keepTicks = 500 }: CacheOptions): Cache => {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path, { timeout: 5000 })
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
  }

  const now = (): string => iso(clock.now())

  const all = (sql: string, params: Params = {}): Row[] => db.prepare(sql).all(params)
  const get = (sql: string, params: Params = {}): Row | undefined => db.prepare(sql).get(params)
  const run = (sql: string, params: Params = {}): number => Number(db.prepare(sql).run(params).changes)

  const transaction = <T>(work: () => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const getMeta = <T>(key: string): T | null => {
    const row = get('SELECT value FROM meta WHERE key = $key', { key })
    return row === undefined ? null : JSON.parse(str(row, 'value')) as T
  }
  const setMeta = (key: string, value: unknown): void => {
    run('INSERT INTO meta (key, value) VALUES ($key, $value) ON CONFLICT (key) DO UPDATE SET value = excluded.value', {
      key,
      value: JSON.stringify(value),
    })
  }

  const migrate = (): void => {
    const hasMeta = get('SELECT 1 AS found FROM sqlite_master WHERE type = \'table\' AND name = \'meta\'') !== undefined
    const stored = hasMeta ? getMeta<number>('schemaVersion') : null
    if (stored === schemaVersion) return
    transaction(() => {
      // a cache from before the last change to the GitHub tables has them rebuilt; a later one (version 6, on its way to 7) keeps every table it has and only gains the new ones
      if (stored === null || stored < githubTablesVersion) {
        for (const table of tables) db.exec(`DROP TABLE IF EXISTS ${table}`)
        for (const statement of schema) db.exec(statement)
      }
      // version 4 added runs; a newer version keeps the table it finds
      for (const statement of runsSchema) db.exec(statement)
      // version 5 added runs.steps; a table made before it lacks the column
      const columns = db.prepare('PRAGMA table_info(runs)').all().map((column) => String(column.name))
      if (!columns.includes('steps')) db.exec('ALTER TABLE runs ADD COLUMN steps TEXT')
      // version 8 added runs.resolved_by_hand
      if (!columns.includes('resolved_by_hand')) db.exec('ALTER TABLE runs ADD COLUMN resolved_by_hand INTEGER NOT NULL DEFAULT 0')
      // version 9 added runs.first_note
      if (!columns.includes('first_note')) db.exec('ALTER TABLE runs ADD COLUMN first_note TEXT')
      // version 11 added runs.report_hash and runs.post_attempted_at
      if (!columns.includes('report_hash')) db.exec('ALTER TABLE runs ADD COLUMN report_hash TEXT')
      if (!columns.includes('post_attempted_at')) db.exec('ALTER TABLE runs ADD COLUMN post_attempted_at TEXT')
      // version 7 added sweeps
      for (const statement of sweepsSchema) db.exec(statement)
      // version 14 added auto-review's columns and the ticks table
      const sweepColumns = db.prepare('PRAGMA table_info(sweeps)').all().map((column) => String(column.name))
      for (const [name, type] of autoColumns) {
        if (!columns.includes(name)) db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`)
        if (!sweepColumns.includes(name)) db.exec(`ALTER TABLE sweeps ADD COLUMN ${name} ${type}`)
      }
      if (!columns.includes('head_oid')) db.exec('ALTER TABLE runs ADD COLUMN head_oid TEXT')
      if (!columns.includes('extra_instructions')) db.exec('ALTER TABLE runs ADD COLUMN extra_instructions TEXT')
      for (const statement of ticksSchema) db.exec(statement)
      setMeta('schemaVersion', schemaVersion)
    })
  }

  const cycle = (id: number): Cycle | null => {
    const row = get('SELECT * FROM cycles WHERE id = $id', { id })
    return row === undefined ? null : toCycle(row)
  }

  const latestCycle = (repo: string): Cycle | null => {
    const row = get('SELECT * FROM cycles WHERE repo = $repo ORDER BY id DESC LIMIT 1', { repo })
    return row === undefined ? null : toCycle(row)
  }

  const runningCycle = (): Cycle | null => {
    const row = get('SELECT * FROM cycles WHERE finished_at IS NULL ORDER BY id DESC LIMIT 1')
    return row === undefined ? null : toCycle(row)
  }

  const mustCycle = (id: number): Cycle => {
    const found = cycle(id)
    if (found === null) throw new CacheError(`cycle ${id} does not exist`)
    return found
  }

  const requireRunning = (id: number): Cycle => {
    const found = mustCycle(id)
    if (found.state !== 'running') throw new CacheError(`cycle ${id} has already finished`)
    return found
  }

  const toPr = (row: Row, latest: Cycle | null): CachedPr => {
    const fetchedAt = str(row, 'fetched_at')
    const cycleId = int(row, 'cycle')
    return {
      repo: str(row, 'repo'),
      number: int(row, 'number'),
      state: str(row, 'state') === 'open' ? 'open' : 'closed',
      updatedAt: str(row, 'updated_at'),
      headOid: str(row, 'head_oid'),
      fetchedAt,
      cycle: cycleId,
      lastSeenAt: str(row, 'last_seen_at'),
      pr: JSON.parse(str(row, 'data')) as RawOpenPr,
      freshness: rowFreshness(cycleId, fetchedAt, latest),
    }
  }

  const openRows = (repo: string, latest: Cycle | null): CachedPr[] =>
    all('SELECT * FROM prs WHERE repo = $repo AND state = \'open\' ORDER BY updated_at DESC, number DESC', { repo })
      .map((row) => toPr(row, latest))

  const insertSnapshot = (snapshot: {
    cycle: number, repo: string, kind: SnapshotKind, page: number | null, at: string, error: string | null, payload: string | null,
  }): void => {
    run('INSERT INTO snapshots (cycle, repo, kind, page, fetched_at, ok, error, payload) VALUES ($cycle, $repo, $kind, $page, $at, $ok, $error, $payload)', {
      cycle: snapshot.cycle,
      repo: snapshot.repo,
      kind: snapshot.kind,
      page: snapshot.page,
      at: snapshot.at,
      ok: snapshot.error === null ? 1 : 0,
      error: snapshot.error,
      payload: snapshot.payload,
    })
  }

  // an unfinished cycle at open means the previous server stopped mid-cycle
  const closeInterrupted = (): void => {
    run('UPDATE cycles SET finished_at = $at, ok = 0, error = $error, error_kind = \'interrupted\' WHERE finished_at IS NULL', {
      at: now(),
      error: 'interrupted: Pit View stopped before the cycle finished',
    })
    // a tick the server stopped under never finished either
    run('UPDATE ticks SET finished_at = $at, state = \'skipped\', skip_reason = \'interrupted\' WHERE finished_at IS NULL', { at: now() })
  }

  const startCycle = (repo: string, trigger: Trigger): Cycle => {
    if (!triggers.includes(trigger)) throw new CacheError(`unknown cycle trigger ${trigger}`)
    const running = runningCycle()
    if (running !== null) throw new CacheError(`cycle ${running.id} is still running`)
    const id = Number(db.prepare('INSERT INTO cycles (repo, trigger, started_at) VALUES ($repo, $trigger, $at)').run({ repo, trigger, at: now() }).lastInsertRowid)
    cycleSequence.set(id, ++sequence)
    return requireRunning(id)
  }

  // reads are ordered by when they began, which the clock cannot give (it has one-second resolution). One counter owned by this cache instance: a cycle takes a number when it starts, and a one-PR refresh takes one before its GitHub read begins. A PR remembers the number of the newest read that wrote or closed it, and a repo remembers as its floor the start number of its newest cycle whose omissions are authoritative, which is a read of the whole repo. A read may write a PR only if its number is older than neither. Held in memory only: no read runs across a restart
  let sequence = 0
  const cycleSequence = new Map<number, number>()
  const writtenBy = new Map<string, number>()
  // keyed by repo exactly as prs is, so one floor covers exactly the rows of one repo. One running cycle at a time means start numbers finish in order, so the newest floor is also the highest
  const floors = new Map<string, number>()
  const beginRefresh = (): number => ++sequence
  const writerKey = (repo: string, number: number): string => `${repo}#${number}`
  // true when a read numbered order may write the PR, and then records it as the newest writer
  const claim = (repo: string, number: number, order: number): boolean => {
    if (order < (floors.get(repo) ?? 0)) return false
    const key = writerKey(repo, number)
    const newest = writtenBy.get(key)
    if (newest !== undefined && newest > order) return false
    writtenBy.set(key, order)
    return true
  }

  const writeOpenPage = (cycleId: number, page: OpenPage): CachedPr[] => transaction(() => {
    const { repo } = requireRunning(cycleId)
    const at = now()
    const cycleStarted = cycleSequence.get(cycleId) ?? 0
    insertSnapshot({ cycle: cycleId, repo, kind: 'open-page', page: page.page, at, error: null, payload: JSON.stringify(page.raw) })
    const upsert = db.prepare('INSERT INTO prs (repo, number, state, updated_at, head_oid, fetched_at, cycle, last_seen_at, data) VALUES ($repo, $number, \'open\', $updatedAt, $headOid, $at, $cycle, $at, $data) ON CONFLICT (repo, number) DO UPDATE SET state = \'open\', updated_at = excluded.updated_at, head_oid = excluded.head_oid, fetched_at = excluded.fetched_at, cycle = excluded.cycle, last_seen_at = excluded.last_seen_at, data = excluded.data')
    // a PR updated mid-pagination can appear on two pages; the later copy wins
    const written = new Map<number, CachedPr>()
    for (const pr of page.prs) {
      // a page was fetched after its cycle started, so a one-PR refresh whose read began after the cycle started holds newer state than this page can have (even a merge that closed it), and the page does not overwrite it
      if (!claim(repo, pr.number, cycleStarted)) continue
      upsert.run({ repo, number: pr.number, updatedAt: pr.updatedAt, headOid: pr.headRefOid, at, cycle: cycleId, data: JSON.stringify(pr) })
      written.set(pr.number, {
        repo,
        number: pr.number,
        state: 'open',
        updatedAt: pr.updatedAt,
        headOid: pr.headRefOid,
        fetchedAt: at,
        cycle: cycleId,
        lastSeenAt: at,
        pr,
        freshness: { state: 'current', fetchedAt: at, error: null },
      })
    }
    run('UPDATE cycles SET pages_done = pages_done + 1, prs_total = $total, prs_updated = (SELECT count(*) FROM prs WHERE repo = $repo AND cycle = $id AND state = \'open\') WHERE id = $id', {
      id: cycleId,
      repo,
      total: page.totalCount,
    })
    if (page.defaultBranch !== null) setMeta(metaKey('defaultBranch', repo), page.defaultBranch)
    if (!page.hasNextPage) setMeta(metaKey('openListed', repo), { cycle: cycleId, at } satisfies Stamp)
    return [...written.values()]
  })

  const writeClosed = (cycleId: number, result: ClosedResult): CachedClosed => transaction(() => {
    const { repo } = requireRunning(cycleId)
    const at = now()
    insertSnapshot({ cycle: cycleId, repo, kind: 'closed', page: null, at, error: null, payload: JSON.stringify(result) })
    setMeta(metaKey('closedFetched', repo), { cycle: cycleId, at } satisfies Stamp)
    return { cycle: cycleId, fetchedAt: at, result }
  })

  const writePr = (repo: string, pr: RawOpenPr, defaultBranch: string | null, ticket: number = beginRefresh()): CachedPr | null => transaction(() => {
    const at = now()
    const latest = latestCycle(repo)
    // a stale read writes nothing, so any row there stays (and keeps the cycle id it was written with), and with no row there the PR stays absent
    if (!claim(repo, pr.number, ticket)) {
      const kept = get('SELECT * FROM prs WHERE repo = $repo AND number = $number', { repo, number: pr.number })
      return kept === undefined ? null : toPr(kept, latest)
    }
    // no cycle yet is cycle 0, which no real cycle id ever is
    const cycleId = latest?.id ?? 0
    run('INSERT INTO prs (repo, number, state, updated_at, head_oid, fetched_at, cycle, last_seen_at, data) VALUES ($repo, $number, \'open\', $updatedAt, $headOid, $at, $cycle, $at, $data) ON CONFLICT (repo, number) DO UPDATE SET state = \'open\', updated_at = excluded.updated_at, head_oid = excluded.head_oid, fetched_at = excluded.fetched_at, cycle = excluded.cycle, last_seen_at = excluded.last_seen_at, data = excluded.data', {
      repo, number: pr.number, updatedAt: pr.updatedAt, headOid: pr.headRefOid, at, cycle: cycleId, data: JSON.stringify(pr),
    })
    if (defaultBranch !== null) setMeta(metaKey('defaultBranch', repo), defaultBranch)
    return {
      repo,
      number: pr.number,
      state: 'open',
      updatedAt: pr.updatedAt,
      headOid: pr.headRefOid,
      fetchedAt: at,
      cycle: cycleId,
      lastSeenAt: at,
      pr,
      freshness: rowFreshness(cycleId, at, latest),
    }
  })

  const closePr = (repo: string, number: number, ticket: number = beginRefresh()): boolean => {
    if (!claim(repo, number, ticket)) return false
    return run('UPDATE prs SET state = \'closed\', fetched_at = $at WHERE repo = $repo AND number = $number AND state = \'open\'', { repo, number, at: now() }) > 0
  }

  const recordError = (cycleId: number, kind: SnapshotKind, page: number | null, error: string): void => {
    const { repo } = requireRunning(cycleId)
    insertSnapshot({ cycle: cycleId, repo, kind, page, at: now(), error, payload: null })
  }

  const prune = (): void => {
    run('DELETE FROM cycles WHERE id NOT IN (SELECT id FROM cycles ORDER BY id DESC LIMIT $keep)', { keep: keepCycles })
    const cutoff = get('SELECT id FROM cycles ORDER BY id DESC LIMIT 1 OFFSET $skip', { skip: keepSnapshotCycles - 1 })
    if (cutoff !== undefined) {
      // the latest successful closed search per repo stays, since the view is built from it
      run('DELETE FROM snapshots WHERE cycle < $cutoff AND id NOT IN (SELECT max(id) FROM snapshots WHERE kind = \'closed\' AND ok = 1 GROUP BY repo)', {
        cutoff: int(cutoff, 'id'),
      })
    }
    const oldest = get('SELECT min(id) AS id FROM cycles')
    if (oldest !== undefined && oldest.id !== null) {
      run('DELETE FROM prs WHERE state = \'closed\' AND cycle < $oldest', { oldest: int(oldest, 'id') })
    }
  }

  const finishCycle = (cycleId: number, error: string | null = null, errorKind: CycleErrorKind | null = null): FinishResult => transaction(() => {
    const { repo } = requireRunning(cycleId)
    const at = now()
    run('UPDATE cycles SET finished_at = $at, ok = $ok, error = $error, error_kind = $kind WHERE id = $id', {
      id: cycleId,
      at,
      ok: error === null ? 1 : 0,
      error,
      kind: error === null ? null : errorKind,
    })
    const finished = mustCycle(cycleId)
    let removed: number[] = []
    let stale: CachedPr[] = []
    if (error === null) {
      setMeta(metaKey('lastSuccess', repo), { cycle: cycleId, startedAt: finished.startedAt, finishedAt: at } satisfies LastSuccess)
      // only a cycle that saw the whole open list can say what left it, so only that cycle is a read of the whole repo: one that failed or never reached the last page says nothing about a PR it did not list, and leaves the floor where it was
      if (getMeta<Stamp>(metaKey('openListed', repo))?.cycle === cycleId) {
        const cycleStarted = cycleSequence.get(cycleId) ?? 0
        // the cycle wrote each PR it listed with its own number, so a row whose newest read is older is one it did not list, even when that read landed during the cycle and took the cycle's id
        const open = all('SELECT number FROM prs WHERE repo = $repo AND state = \'open\' ORDER BY number', { repo }).map((row) => int(row, 'number'))
        removed = open.filter((number) => (writtenBy.get(writerKey(repo, number)) ?? 0) < cycleStarted)
        for (const number of removed) run('UPDATE prs SET state = \'closed\' WHERE repo = $repo AND number = $number', { repo, number })
        floors.set(repo, cycleStarted)
      }
    } else {
      setMeta(metaKey('lastError', repo), { cycle: cycleId, at, error })
      stale = openRows(repo, finished).filter((row) => row.cycle !== cycleId)
    }
    prune()
    return { cycle: finished, removed, stale }
  })

  const latestClosed = (repo: string): CachedClosed | null => {
    const row = get('SELECT cycle, fetched_at, payload FROM snapshots WHERE repo = $repo AND kind = \'closed\' AND ok = 1 ORDER BY id DESC LIMIT 1', { repo })
    if (row === undefined) return null
    return { cycle: int(row, 'cycle'), fetchedAt: str(row, 'fetched_at'), result: JSON.parse(str(row, 'payload')) as ClosedResult }
  }

  // the error a section reports: its own failed response in the latest cycle, else the cycle's
  const sectionError = (kind: SnapshotKind, latest: Cycle | null): string | null => {
    if (latest === null || latest.state !== 'failed') return null
    const row = get('SELECT error FROM snapshots WHERE cycle = $id AND kind = $kind AND ok = 0 ORDER BY id DESC LIMIT 1', { id: latest.id, kind })
    return (row === undefined ? null : strOrNull(row, 'error')) ?? latest.error
  }

  const readView = (repo: string): CachedView => {
    const latest = latestCycle(repo)
    const open = openRows(repo, latest)
    const closed = latestClosed(repo)
    const listed = getMeta<Stamp>(metaKey('openListed', repo))
    // the open section is as old as its oldest row; with no rows, as old as the last full list
    const oldestRow = open.reduce<string | null>((oldest, row) => oldest === null || row.fetchedAt < oldest ? row.fetchedAt : oldest, null)
    return {
      repo,
      cycle: latest,
      lastSuccessAt: getMeta<LastSuccess>(metaKey('lastSuccess', repo))?.finishedAt ?? null,
      defaultBranch: getMeta<string>(metaKey('defaultBranch', repo)),
      open,
      closed,
      sections: {
        // rows from a cycle that never finished the list still count as fetched
        open: sectionFreshness(listed !== null || open.length > 0, listed?.cycle ?? null, oldestRow ?? listed?.at ?? null, latest, sectionError('open-page', latest)),
        closed: sectionFreshness(closed !== null, closed?.cycle ?? null, closed?.fetchedAt ?? null, latest, sectionError('closed', latest)),
      },
    }
  }

  const getRun = (id: number): Run | null => {
    const row = get('SELECT * FROM runs WHERE id = $id', { id })
    return row === undefined ? null : toRun(row)
  }

  const mustRun = (id: number): Run => {
    const found = getRun(id)
    if (found === null) throw new CacheError(`run ${id} does not exist`)
    return found
  }

  const createRun = (input: NewRun, dirOf: (id: number) => string): Run => transaction(() => {
    const id = Number(db.prepare('INSERT INTO runs (repo, number, command, args, label, runner, cwd, dir, started_at, status) VALUES ($repo, $number, $command, $args, $label, $runner, $cwd, \'\', $startedAt, $status)').run({
      repo: input.repo,
      number: input.number,
      command: input.command,
      args: JSON.stringify(input.args),
      label: input.label,
      runner: input.runner,
      cwd: input.cwd,
      startedAt: input.startedAt,
      status: input.status,
    }).lastInsertRowid)
    const { repo: _repo, number: _number, ...rest } = input
    return updateRun(id, { ...rest, dir: dirOf(id) })
  })

  const updateRun = (id: number, changes: RunChanges): Run => {
    const keys = (Object.keys(changes) as (keyof RunChanges)[]).filter((key) => key in runColumns)
    if (keys.length > 0) {
      const params: Params = { id }
      const sets = keys.map((key) => {
        params[key] = runValue(key, changes[key])
        return `${runColumns[key]} = $${key}`
      })
      if (run(`UPDATE runs SET ${sets.join(', ')} WHERE id = $id`, params) === 0) throw new CacheError(`run ${id} does not exist`)
    }
    return mustRun(id)
  }

  const runsFor = (repo: string, number: number, limit = keepRuns): Run[] =>
    all('SELECT * FROM runs WHERE repo = $repo AND number = $number ORDER BY id DESC LIMIT $limit', { repo, number, limit }).map(toRun)

  const latestRuns = (repo: string): Map<number, Run> =>
    new Map(all('SELECT * FROM runs WHERE id IN (SELECT max(id) FROM runs WHERE repo = $repo GROUP BY number)', { repo })
      .map((row) => [int(row, 'number'), toRun(row)]))

  const runningRuns = (): Run[] => all('SELECT * FROM runs WHERE status = \'running\' ORDER BY id').map(toRun)

  const queuedRuns = (): Run[] => all('SELECT * FROM runs WHERE status = \'queued\' ORDER BY id').map(toRun)

  // a run still in flight or waiting in the queue is never pruned, however old
  const pruneRuns = (): Run[] => transaction(() => {
    const doomed = all('SELECT * FROM runs WHERE status NOT IN (\'running\', \'queued\') AND id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT $keep) ORDER BY id', { keep: keepRuns }).map(toRun)
    for (const gone of doomed) run('DELETE FROM runs WHERE id = $id', { id: gone.id })
    return doomed
  })

  const getSweep = (id: number): Sweep | null => {
    const row = get('SELECT * FROM sweeps WHERE id = $id', { id })
    return row === undefined ? null : toSession(row)
  }

  const mustSweep = (id: number): Sweep => {
    const found = getSweep(id)
    if (found === null) throw new CacheError(`sweep ${id} does not exist`)
    return found
  }

  const createSweep = (input: NewSweep, dirOf: (id: number) => string): Sweep => transaction(() => {
    const id = Number(db.prepare('INSERT INTO sweeps (repo, command, args, label, runner, cwd, dir, started_at, status) VALUES ($repo, $command, $args, $label, $runner, $cwd, \'\', $startedAt, $status)').run({
      repo: input.repo,
      command: input.command,
      args: JSON.stringify(input.args),
      label: input.label,
      runner: input.runner,
      cwd: input.cwd,
      startedAt: input.startedAt,
      status: input.status,
    }).lastInsertRowid)
    const { repo: _repo, ...rest } = input
    return updateSweep(id, { ...rest, dir: dirOf(id) })
  })

  const updateSweep = (id: number, changes: RunChanges): Sweep => {
    const keys = (Object.keys(changes) as (keyof RunChanges)[]).filter((key) => key in runColumns)
    if (keys.length > 0) {
      const params: Params = { id }
      const sets = keys.map((key) => {
        params[key] = runValue(key, changes[key])
        return `${runColumns[key]} = $${key}`
      })
      if (run(`UPDATE sweeps SET ${sets.join(', ')} WHERE id = $id`, params) === 0) throw new CacheError(`sweep ${id} does not exist`)
    }
    return mustSweep(id)
  }

  const sweepsFor = (repo: string, limit = keepSweeps): Sweep[] =>
    all('SELECT * FROM sweeps WHERE repo = $repo ORDER BY id DESC LIMIT $limit', { repo, limit }).map(toSession)

  const runningSweeps = (): Sweep[] => all('SELECT * FROM sweeps WHERE status = \'running\' ORDER BY id').map(toSession)

  const queuedSweeps = (): Sweep[] => all('SELECT * FROM sweeps WHERE status = \'queued\' ORDER BY id').map(toSession)

  // all but the newest sweeps are pruned, but a sweep still in flight or waiting in the queue is never pruned, however old
  const pruneSweeps = (): Sweep[] => transaction(() => {
    const doomed = all('SELECT * FROM sweeps WHERE status NOT IN (\'running\', \'queued\') AND id NOT IN (SELECT id FROM sweeps ORDER BY id DESC LIMIT $keep) ORDER BY id', { keep: keepSweeps }).map(toSession)
    for (const gone of doomed) run('DELETE FROM sweeps WHERE id = $id', { id: gone.id })
    return doomed
  })

  const allRuns = (): Run[] => all('SELECT * FROM runs ORDER BY id').map(toRun)

  const allSweeps = (): Sweep[] => all('SELECT * FROM sweeps ORDER BY id').map(toSession)

  const mustTick = (id: number): Tick => {
    const row = get('SELECT * FROM ticks WHERE id = $id', { id })
    if (row === undefined) throw new CacheError(`tick ${id} does not exist`)
    return toTick(row)
  }

  const createTick = (repo: string): Tick => transaction(() => {
    const id = Number(db.prepare('INSERT INTO ticks (repo, started_at) VALUES ($repo, $at)').run({ repo, at: now() }).lastInsertRowid)
    run('DELETE FROM ticks WHERE id NOT IN (SELECT id FROM ticks ORDER BY id DESC LIMIT $keep)', { keep: keepTicks })
    return mustTick(id)
  })

  const updateTick = (id: number, changes: TickChanges): Tick => {
    const keys = (Object.keys(changes) as (keyof TickChanges)[]).filter((key) => key in tickColumns)
    if (keys.length > 0) {
      const params: Params = { id }
      const sets = keys.map((key) => {
        params[key] = changes[key] ?? null
        return `${tickColumns[key]} = $${key}`
      })
      run(`UPDATE ticks SET ${sets.join(', ')} WHERE id = $id`, params)
    }
    return mustTick(id)
  }

  const ticksFor = (repo: string, limit = keepTicks): Tick[] =>
    all('SELECT * FROM ticks WHERE repo = $repo ORDER BY id DESC LIMIT $limit', { repo, limit }).map(toTick)

  const latestTick = (repo: string): Tick | null => ticksFor(repo, 1)[0] ?? null

  migrate()
  closeInterrupted()

  return {
    startCycle,
    writeOpenPage,
    writeClosed,
    beginRefresh,
    writePr,
    closePr,
    recordError,
    finishCycle,
    readView,
    cycle,
    latestCycle,
    runningCycle,
    prune,
    createRun,
    updateRun,
    getRun,
    runsFor,
    latestRuns,
    runningRuns,
    queuedRuns,
    pruneRuns,
    createSweep,
    updateSweep,
    getSweep,
    sweepsFor,
    runningSweeps,
    queuedSweeps,
    pruneSweeps,
    allRuns,
    allSweeps,
    createTick,
    updateTick,
    ticksFor,
    latestTick,
    close: () => db.close(),
    db,
  }
}
