// src/autoreviewlog.ts
// the auto-review log (section 10 of DESIGN.md, The log): a kept record of what the scheduler decided and why, one line per decision, in a table of its own in the cache database. A decision that repeats what its lane last said (about the same run, when it names one) extends that line's stretch instead of adding one, and a run's own decision, a skip aside, is written once whenever it is seen. The pure builders the scheduler hands it come first; the store after them takes the database handle and the clock
import type { DatabaseSync } from 'node:sqlite'
import type { QueueReason, Session, Tick, TickSkip, TickState } from './cache.ts'
import type { Clock, Config } from './config.ts'
import { doneText } from './launcher.ts'
import type { RunModels } from './models.ts'
import { iso } from './time.ts'

// how many days the log keeps, unless the config's autoReviewLogDays says otherwise. It is the same 14 days the owner has chosen for deleting stored reports (a weekly sweep of what closed 14 or more days before, for section 10 of DESIGN.md, Report storage), a cleanup not built yet; when that cleanup lands it shares this constant, so the two stay the same number
export const autoReviewLogDays = 14

// the most lines the log ever holds, whatever the days say, so a flapping PR cannot grow it without bound; the oldest go first
export const logEntryCeiling = 2000

export const logDaysOf = (config: Pick<Config, 'autoReviewLogDays'>): number => config.autoReviewLogDays ?? autoReviewLogDays

export type LogLane = 'tick' | 'pr' | 'sweep'

export const logDecisions = ['checked', 'queued', 'retried', 'started', 'skipped', 'dropped', 'finished', 'failed', 'failedTwice', 'stopped'] as const
export type LogDecision = typeof logDecisions[number]

// why a tick did no work: a recorded tick's skip, the window closed or the master switch off (no tick at all), or waiting runs that found no room under the review cap or the concurrency
export type TickLogReason = TickSkip | 'outsideHours' | 'off' | 'capFull'
// why a qualifying PR was not queued, or a queued one not started
export type PrSkipReason = 'alreadyReviewed' | 'inFlight' | 'ownersRun' | 'stoppedAtHead' | 'postUnknown' | 'optedOut' | 'postInFlight'
// every reason a line may carry: those above, a check's outcome, a queue reason, why a row was dropped, and how a run finished
export type LogReason = TickLogReason | PrSkipReason | 'nothingNew' | 'queued' | QueueReason | 'closed' | 'ready' | 'superseded' | 'done' | 'needsInput'

export type LogRun = { kind: 'run' | 'sweep', id: number }

export type LogEntry = {
  id: number
  repo: string
  lane: LogLane
  // the PR, null for a tick-level line and a sweep's
  number: number | null
  // the PR's title as the cache had it when the line was written
  title: string | null
  decision: LogDecision
  reason: string | null
  // what else the line says: a check's counts, a run's outcome or note
  note: string | null
  head: string | null
  run: LogRun | null
  // the model that ran the review, as the run's record names it at the spawn (a pair when a tandem run's record holds both roles); null for a line that ran nothing, and for a line stored before the log kept it
  model: string | null
  tick: number | null
  // when the line began, and when its stretch was last seen; the same for a line seen once
  at: string
  lastAt: string
  count: number
}

export type NewLogEntry = {
  repo: string
  lane: LogLane
  decision: LogDecision
  at: string
  number?: number | null
  title?: string | null
  reason?: string | null
  note?: string | null
  head?: string | null
  run?: LogRun | null
  model?: string | null
  tick?: number | null
  // starts a line of its own even when it repeats what its lane last said, because something in between ended that stretch
  fresh?: boolean
}

// the pure builders

const runnerNames: Readonly<Record<string, string>> = { claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes' }

// what a run's record says ran the review, in the owner's words: the registry id (or the model's name, or Codex's own default) and the runner, and for a record of several roles each under its role, in the order recorded, so a record that holds both roles of a tandem run reads as its pair. Null for a run with no record, which is every run that never reached its spawn
export const modelText = (models: RunModels | null | undefined): string | null => {
  const roles = models?.roles ?? []
  if (roles.length === 0) return null
  const named = (role: RunModels['roles'][number]): string => `${role.id ?? role.model ?? 'Codex default'} (${runnerNames[role.runner] ?? role.runner})`
  return roles.length === 1 ? named(roles[0]!) : roles.map((role) => `${role.role}: ${named(role)}`).join(' · ')
}

export type TickOutcome = { state: TickState, skipReason: TickSkip | null, qualified: number | null, alreadyCurrent: number | null, queued: number | null }

// a finished tick's line: one that skipped carries its reason; one that ran is a check, of nothing new or of what it queued, unless runs were waiting and none found room, which is a cap-full skip
export const tickEntry = (tick: Pick<Tick, 'id' | 'repo' | 'startedAt'>, outcome: TickOutcome, capFull: boolean): NewLogEntry => {
  const counts = outcome.qualified === null ? null : `${outcome.qualified} qualified, ${outcome.alreadyCurrent ?? 0} already current, queued ${outcome.queued ?? 0}`
  const base = { repo: tick.repo, lane: 'tick' as const, note: counts, tick: tick.id, at: tick.startedAt }
  if (outcome.state === 'skipped') return { ...base, decision: 'skipped', reason: outcome.skipReason ?? 'interrupted' }
  if (capFull) return { ...base, decision: 'skipped', reason: 'capFull' }
  return { ...base, decision: 'checked', reason: (outcome.queued ?? 0) > 0 ? 'queued' : 'nothingNew' }
}

// what a scheduled run's or sweep's status says it did, or null for a queued row (the tick writes its queued line) and for anything the owner started
export const sessionEntry = (kind: 'run' | 'sweep', session: Session & { number?: number, headOid?: string | null, models?: RunModels | null }): NewLogEntry | null => {
  if (session.origin !== 'auto' || session.status === 'queued') return null
  const pr = kind === 'run' && typeof session.number === 'number'
  const base = {
    repo: session.repo,
    lane: pr ? 'pr' as const : 'sweep' as const,
    number: pr ? session.number ?? null : null,
    head: pr ? session.headOid ?? null : null,
    run: { kind, id: session.id },
    tick: session.tick,
  }
  const ended = session.finishedAt ?? session.lastStepAt ?? session.startedAt
  // a sweep's row holds no models, so its lines name none; a run's holds them from its spawn, and a run that failed before it holds none
  const model = kind === 'run' ? modelText(session.models) : null
  switch (session.status) {
    case 'running':
      return { ...base, model, decision: 'started', reason: session.reason, note: null, at: session.startedAt }
    case 'done':
      return { ...base, model, decision: 'finished', reason: 'done', note: doneText(session, session.reason === 'selfReview'), at: ended }
    case 'needsInput':
      return { ...base, model, decision: 'finished', reason: 'needsInput', note: doneText(session, false), at: ended }
    case 'failed':
      return { ...base, model, decision: 'failed', reason: null, note: session.note, at: ended }
    case 'stopped':
      return { ...base, model, decision: 'stopped', reason: null, note: null, at: ended }
    case 'skipped':
      return { ...base, decision: 'dropped', reason: session.note, note: null, at: ended }
    default:
      return null
  }
}

// the store

export type AutoReviewLog = {
  // writes one line, or extends the stretch it repeats; null when the run's decision is already written (which only fills in the model the line lacked)
  record: (entry: NewLogEntry) => LogEntry | null
  // drops the lines last seen more than days ago; answers how many went
  prune: (days: number) => number
  // a repository's lines last seen within days, newest first
  list: (repo: string, days: number) => LogEntry[]
}

export type AutoReviewLogOptions = {
  // the cache's own handle: the log lives in the cache file, beside the tables it describes
  db: DatabaseSync
  clock: Clock
  ceiling?: number
}

// kept across a rebuild of the GitHub tables, like runs and ticks, and created when missing, so it needs no schema version of its own: a bump would drop and refetch the GitHub tables for nothing, since the log is no GitHub table and what it holds of GitHub's text (a PR's title) is copied again with each line. A column added later is added to a table that lacks it (the model column below), as the runs table's later columns are; AUTOINCREMENT so a pruned id is never reused
const logSchema = [
  'CREATE TABLE IF NOT EXISTS autoreview_log (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, lane TEXT NOT NULL, number INTEGER, title TEXT, decision TEXT NOT NULL, reason TEXT, note TEXT, head TEXT, run_kind TEXT, run_id INTEGER, tick INTEGER, at TEXT NOT NULL, last_at TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1, model TEXT)',
  'CREATE INDEX IF NOT EXISTS autoreview_log_by_lane ON autoreview_log (repo, lane, number, id)',
  'CREATE INDEX IF NOT EXISTS autoreview_log_by_run ON autoreview_log (run_kind, run_id, decision)',
  'CREATE INDEX IF NOT EXISTS autoreview_log_by_time ON autoreview_log (repo, last_at)',
]

type Row = Record<string, unknown>

const text = (row: Row, key: string): string | null => typeof row[key] === 'string' ? row[key] : null
const whole = (row: Row, key: string): number | null => row[key] === null || row[key] === undefined ? null : Number(row[key])

const toEntry = (row: Row): LogEntry => {
  const runKind = text(row, 'run_kind')
  const runId = whole(row, 'run_id')
  return {
    id: Number(row.id),
    repo: String(row.repo),
    lane: String(row.lane) as LogLane,
    number: whole(row, 'number'),
    title: text(row, 'title'),
    decision: String(row.decision) as LogDecision,
    reason: text(row, 'reason'),
    note: text(row, 'note'),
    head: text(row, 'head'),
    model: text(row, 'model'),
    run: (runKind === 'run' || runKind === 'sweep') && runId !== null ? { kind: runKind, id: runId } : null,
    tick: whole(row, 'tick'),
    at: String(row.at),
    lastAt: String(row.last_at),
    count: Number(row.count),
  }
}

const dayMs = 24 * 60 * 60_000

export const openAutoReviewLog = ({ db, clock, ceiling = logEntryCeiling }: AutoReviewLogOptions): AutoReviewLog => {
  for (const statement of logSchema) db.exec(statement)
  // a table made before the log named its models has no such column; its lines read as naming none, and nothing rewrites them
  if (!(db.prepare('PRAGMA table_info(autoreview_log)').all() as Row[]).some((column) => column.name === 'model')) db.exec('ALTER TABLE autoreview_log ADD COLUMN model TEXT')
  const get = (sql: string, params: Record<string, string | number | null>): Row | undefined => db.prepare(sql).get(params) as Row | undefined

  const since = (days: number): string => iso(clock.now() - days * dayMs)

  const record = (entry: NewLogEntry): LogEntry | null => {
    const fields = {
      repo: entry.repo,
      lane: entry.lane,
      number: entry.number ?? null,
      title: entry.title ?? null,
      decision: entry.decision,
      reason: entry.reason ?? null,
      note: entry.note ?? null,
      head: entry.head ?? null,
      runKind: entry.run?.kind ?? null,
      runId: entry.run?.id ?? null,
      model: entry.model ?? null,
      tick: entry.tick ?? null,
      at: entry.at,
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      let id: number | null = null
      if (fields.runId !== null && fields.decision !== 'skipped') {
        // a run's decision is one line, however many times its row is seen
        const written = get('SELECT id, model FROM autoreview_log WHERE run_kind = $runKind AND run_id = $runId AND decision = $decision', { runKind: fields.runKind, runId: fields.runId, decision: fields.decision })
        if (written !== undefined) {
          // the row names its model only once the run has spawned, a moment after it is marked running, so a line written in that moment learns it here
          if (written.model === null && fields.model !== null) db.prepare('UPDATE autoreview_log SET model = $model WHERE id = $id').run({ id: Number(written.id), model: fields.model })
          db.exec('COMMIT')
          return null
        }
      } else if (entry.fresh !== true) {
        // a decision that repeats what its lane last said, about the same run when it names one, extends that line's stretch
        const last = get('SELECT * FROM autoreview_log WHERE repo = $repo AND lane = $lane AND number IS $number ORDER BY id DESC LIMIT 1', { repo: fields.repo, lane: fields.lane, number: fields.number })
        if (last !== undefined && last.run_kind === fields.runKind && last.run_id === fields.runId && last.decision === fields.decision && text(last, 'reason') === fields.reason && text(last, 'head') === fields.head) {
          id = Number(last.id)
          db.prepare('UPDATE autoreview_log SET last_at = max(last_at, $at), count = count + 1, note = $note, tick = coalesce($tick, tick), title = coalesce($title, title) WHERE id = $id')
            .run({ id, at: fields.at, note: fields.note, tick: fields.tick, title: fields.title })
        }
      }
      if (id === null) {
        id = Number(db.prepare('INSERT INTO autoreview_log (repo, lane, number, title, decision, reason, note, head, run_kind, run_id, model, tick, at, last_at) VALUES ($repo, $lane, $number, $title, $decision, $reason, $note, $head, $runKind, $runId, $model, $tick, $at, $at)')
          .run(fields).lastInsertRowid)
        db.prepare('DELETE FROM autoreview_log WHERE id NOT IN (SELECT id FROM autoreview_log ORDER BY id DESC LIMIT $keep)').run({ keep: ceiling })
      }
      const row = get('SELECT * FROM autoreview_log WHERE id = $id', { id })
      db.exec('COMMIT')
      return row === undefined ? null : toEntry(row)
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const prune = (days: number): number => Number(db.prepare('DELETE FROM autoreview_log WHERE last_at < $since').run({ since: since(days) }).changes)

  const list = (repo: string, days: number): LogEntry[] =>
    (db.prepare('SELECT * FROM autoreview_log WHERE repo = $repo AND last_at >= $since ORDER BY last_at DESC, id DESC').all({ repo, since: since(days) }) as Row[]).map(toEntry)

  return { record, prune, list }
}
