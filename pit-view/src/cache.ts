// src/cache.ts
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite'
import type { Clock } from './config.ts'
import type { ClosedResult, GhErrorKind, OpenPage, RawOpenPr } from './github.ts'

// bump on any schema change; an older cache file is dropped and rebuilt, since it holds
// nothing GitHub cannot give back
export const schemaVersion = 3

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

export type Cache = {
  // starts a cycle; only one may run at a time across all repos
  startCycle: (repo: string, trigger: Trigger) => Cycle
  // stores one open-PR page as it arrives and returns the rows it wrote, all current
  writeOpenPage: (cycleId: number, page: OpenPage) => CachedPr[]
  // stores the closed search, which covers both Closed ranges
  writeClosed: (cycleId: number, result: ClosedResult) => CachedClosed
  // stores one PR fetched on its own, outside any cycle, stamped with the repo's latest cycle so
  // it reads as current; returns the row as written
  writePr: (repo: string, pr: RawOpenPr, defaultBranch: string | null) => CachedPr
  // marks a PR found closed or merged on its own as gone from the open list; false when it was not open
  closePr: (repo: string, number: number) => boolean
  // stores a failed response, so the section can report the error it hit
  recordError: (cycleId: number, kind: SnapshotKind, page: number | null, error: string) => void
  // a null error marks the cycle successful and removes PRs absent from its full open list
  finishCycle: (cycleId: number, error?: string | null, errorKind?: CycleErrorKind | null) => FinishResult
  readView: (repo: string) => CachedView
  cycle: (id: number) => Cycle | null
  latestCycle: (repo: string) => Cycle | null
  runningCycle: () => Cycle | null
  prune: () => void
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

const tables = ['meta', 'cycles', 'snapshots', 'prs']

type Row = Record<string, SQLOutputValue>
type Params = Record<string, SQLInputValue>

const str = (row: Row, key: string): string => String(row[key])
const strOrNull = (row: Row, key: string): string | null => row[key] === null || row[key] === undefined ? null : String(row[key])
const int = (row: Row, key: string): number => Number(row[key])
const intOrNull = (row: Row, key: string): number | null => row[key] === null || row[key] === undefined ? null : Number(row[key])

// GitHub's form: second precision, Z suffix
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

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
export const openCache = ({ path, clock, keepCycles = 200, keepSnapshotCycles = 50 }: CacheOptions): Cache => {
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
    if (hasMeta && getMeta<number>('schemaVersion') === schemaVersion) return
    transaction(() => {
      for (const table of tables) db.exec(`DROP TABLE IF EXISTS ${table}`)
      for (const statement of schema) db.exec(statement)
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
  }

  const startCycle = (repo: string, trigger: Trigger): Cycle => {
    if (!triggers.includes(trigger)) throw new CacheError(`unknown cycle trigger ${trigger}`)
    const running = runningCycle()
    if (running !== null) throw new CacheError(`cycle ${running.id} is still running`)
    const id = Number(db.prepare('INSERT INTO cycles (repo, trigger, started_at) VALUES ($repo, $trigger, $at)').run({ repo, trigger, at: now() }).lastInsertRowid)
    return requireRunning(id)
  }

  const writeOpenPage = (cycleId: number, page: OpenPage): CachedPr[] => transaction(() => {
    const { repo } = requireRunning(cycleId)
    const at = now()
    insertSnapshot({ cycle: cycleId, repo, kind: 'open-page', page: page.page, at, error: null, payload: JSON.stringify(page.raw) })
    const upsert = db.prepare('INSERT INTO prs (repo, number, state, updated_at, head_oid, fetched_at, cycle, last_seen_at, data) VALUES ($repo, $number, \'open\', $updatedAt, $headOid, $at, $cycle, $at, $data) ON CONFLICT (repo, number) DO UPDATE SET state = \'open\', updated_at = excluded.updated_at, head_oid = excluded.head_oid, fetched_at = excluded.fetched_at, cycle = excluded.cycle, last_seen_at = excluded.last_seen_at, data = excluded.data')
    // a PR updated mid-pagination can appear on two pages; the later copy wins
    const written = new Map<number, CachedPr>()
    for (const pr of page.prs) {
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

  const writePr = (repo: string, pr: RawOpenPr, defaultBranch: string | null): CachedPr => transaction(() => {
    const at = now()
    const latest = latestCycle(repo)
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

  const closePr = (repo: string, number: number): boolean =>
    run('UPDATE prs SET state = \'closed\', fetched_at = $at WHERE repo = $repo AND number = $number AND state = \'open\'', { repo, number, at: now() }) > 0

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
      // only a cycle that saw the whole open list can say what left it
      if (getMeta<Stamp>(metaKey('openListed', repo))?.cycle === cycleId) {
        removed = all('SELECT number FROM prs WHERE repo = $repo AND state = \'open\' AND cycle != $id ORDER BY number', { repo, id: cycleId })
          .map((row) => int(row, 'number'))
        run('UPDATE prs SET state = \'closed\' WHERE repo = $repo AND state = \'open\' AND cycle != $id', { repo, id: cycleId })
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

  migrate()
  closeInterrupted()

  return {
    startCycle,
    writeOpenPage,
    writeClosed,
    writePr,
    closePr,
    recordError,
    finishCycle,
    readView,
    cycle,
    latestCycle,
    runningCycle,
    prune,
    close: () => db.close(),
    db,
  }
}
