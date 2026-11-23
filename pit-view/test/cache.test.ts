// test/cache.test.ts
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { CacheError, githubTablesVersion, openCache, schemaVersion } from '../src/cache.ts'
import type { Cache, CacheOptions, NewRun, NewSweep, Run } from '../src/cache.ts'
import { createGh, fetchClosedPrs, fetchOpenPrs } from '../src/github.ts'
import type { ClosedResult, OpenPage } from '../src/github.ts'
import { scenario } from './fixtures/scenario.ts'
import { fixtureRunner, tempDir } from './helpers.ts'

const second = 1000
const minute = 60 * second

// a clock the test moves by hand
const handClock = (start = scenario.now) => {
  let at = Date.parse(start)
  return { clock: { now: () => at }, tick: (ms: number) => { at += ms } }
}

// both open pages and the closed search, fetched through github.ts from the fixtures
const fetched = async (): Promise<{ pages: OpenPage[], closed: ClosedResult }> => {
  const gh = createGh(fixtureRunner().runner)
  const pages: OpenPage[] = []
  await fetchOpenPrs(gh, scenario.repo, (page) => {
    pages.push(page)
  }, { pageSize: scenario.pageSize })
  const closed = await fetchClosedPrs(gh, scenario.repo, scenario.yesterdayFrom, scenario.now)
  return { pages, closed }
}

const memoryCache = (options: Partial<CacheOptions> = {}) => {
  const time = handClock()
  const cache = openCache({ path: ':memory:', clock: time.clock, ...options })
  return { cache, tick: time.tick }
}

// one whole successful cycle, a second apart per response
const fullCycle = (cache: Cache, tick: (ms: number) => void, pages: OpenPage[], closed: ClosedResult) => {
  const cycle = cache.startCycle(scenario.repo, 'manual')
  for (const page of pages) {
    tick(second)
    cache.writeOpenPage(cycle.id, page)
  }
  tick(second)
  cache.writeClosed(cycle.id, closed)
  tick(second)
  return cache.finishCycle(cycle.id)
}

// a copy of a page without some PRs, still reporting itself as the last page
const without = (page: OpenPage, numbers: number[]): OpenPage => ({
  ...page,
  hasNextPage: false,
  prs: page.prs.filter((pr) => !numbers.includes(pr.number)),
})

const states = (cache: Cache) => Object.fromEntries(cache.readView(scenario.repo).open.map((row) => [row.number, row.freshness.state]))
const count = (cache: Cache, table: string): number => Number(cache.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n)

test('a new cache has the schema, its version, and nothing fetched', () => {
  const { cache } = memoryCache()
  const tables = cache.db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' ORDER BY name').all()
  assert.deepEqual(tables.map((row) => row.name), ['cycles', 'meta', 'post_marks', 'posted_heads', 'prs', 'runs', 'snapshots', 'sweeps', 'ticks'])
  assert.equal(cache.db.prepare('SELECT value FROM meta WHERE key = \'schemaVersion\'').get()?.value, String(schemaVersion))

  const view = cache.readView(scenario.repo)
  assert.equal(view.cycle, null)
  assert.equal(view.lastSuccessAt, null)
  assert.deepEqual(view.open, [])
  assert.equal(view.closed, null)
  assert.deepEqual(view.sections, {
    open: { state: 'loading', fetchedAt: null, error: null },
    closed: { state: 'loading', fetchedAt: null, error: null },
  })
  cache.close()
})

test('a successful cycle stores every page and the closed search, all current', async () => {
  const { pages, closed } = await fetched()
  const { cache, tick } = memoryCache()
  const result = fullCycle(cache, tick, pages, closed)

  assert.deepEqual(result.removed, [])
  assert.deepEqual(result.stale, [])
  assert.equal(result.cycle.state, 'finished')
  assert.deepEqual(
    { pagesDone: result.cycle.pagesDone, prsUpdated: result.cycle.prsUpdated, prsTotal: result.cycle.prsTotal },
    { pagesDone: 2, prsUpdated: scenario.openTotal, prsTotal: scenario.openTotal },
  )

  const view = cache.readView(scenario.repo)
  assert.equal(view.open.length, scenario.openTotal)
  assert.ok(view.open.every((row) => row.freshness.state === 'current' && row.state === 'open'))
  assert.equal(view.defaultBranch, scenario.defaultBranch)
  assert.equal(view.lastSuccessAt, '2026-10-26T14:05:42Z')
  assert.equal(view.cycle?.id, result.cycle.id)
  // most recently updated first, as GitHub sent them
  assert.deepEqual(view.open.map((row) => row.number), [...pages[0]!.prs, ...pages[1]!.prs].map((pr) => pr.number))
  // each row carries the time its own page arrived
  assert.equal(view.open.find((row) => row.number === 118)?.fetchedAt, '2026-10-26T14:05:39Z')
  assert.equal(view.open.find((row) => row.number === 104)?.fetchedAt, '2026-10-26T14:05:40Z')
  assert.deepEqual(view.open.find((row) => row.number === 101)?.pr, pages[0]!.prs.find((pr) => pr.number === 101))

  assert.deepEqual(view.closed?.result, closed)
  assert.equal(view.closed?.fetchedAt, '2026-10-26T14:05:41Z')
  assert.deepEqual(view.sections, {
    open: { state: 'current', fetchedAt: '2026-10-26T14:05:39Z', error: null },
    closed: { state: 'current', fetchedAt: '2026-10-26T14:05:41Z', error: null },
  })
  cache.close()
})

test('raw responses are kept as snapshots', async () => {
  const { pages, closed } = await fetched()
  const { cache, tick } = memoryCache()
  const { cycle } = fullCycle(cache, tick, pages, closed)
  const rows = cache.db.prepare('SELECT cycle, repo, kind, page, ok, error, payload FROM snapshots ORDER BY id').all()
  assert.deepEqual(rows.map((row) => [row.cycle, row.repo, row.kind, row.page, row.ok, row.error]), [
    [cycle.id, scenario.repo, 'open-page', 1, 1, null],
    [cycle.id, scenario.repo, 'open-page', 2, 1, null],
    [cycle.id, scenario.repo, 'closed', null, 1, null],
  ])
  assert.deepEqual(JSON.parse(String(rows[1]?.payload)), pages[1]!.raw)
  cache.close()
})

test('while a cycle runs, rows it has reached are current and the rest pending', async () => {
  const { pages, closed } = await fetched()
  const { cache, tick } = memoryCache()
  fullCycle(cache, tick, pages, closed)

  tick(5 * minute)
  const next = cache.startCycle(scenario.repo, 'manual')
  assert.equal(cache.runningCycle()?.id, next.id)
  let view = cache.readView(scenario.repo)
  assert.equal(view.cycle?.state, 'running')
  assert.equal(view.cycle?.prsTotal, null)
  assert.ok(view.open.every((row) => row.freshness.state === 'pending'))
  assert.equal(view.sections.open.state, 'pending')
  assert.equal(view.sections.closed.state, 'pending')

  tick(second)
  const written = cache.writeOpenPage(next.id, pages[0]!)
  assert.deepEqual(written.map((row) => row.number), pages[0]!.prs.map((pr) => pr.number))
  assert.ok(written.every((row) => row.freshness.state === 'current' && row.fetchedAt === '2026-10-26T14:10:43Z'))

  view = cache.readView(scenario.repo)
  assert.deepEqual(
    { pagesDone: view.cycle?.pagesDone, prsUpdated: view.cycle?.prsUpdated, prsTotal: view.cycle?.prsTotal },
    { pagesDone: 1, prsUpdated: 9, prsTotal: scenario.openTotal },
  )
  const byState = states(cache)
  for (const pr of pages[0]!.prs) assert.equal(byState[pr.number], 'current')
  for (const pr of pages[1]!.prs) assert.equal(byState[pr.number], 'pending')
  assert.equal(view.sections.open.state, 'pending')
  // the section is as old as its oldest row, still from the first cycle
  assert.equal(view.sections.open.fetchedAt, '2026-10-26T14:05:40Z')

  tick(second)
  cache.writeClosed(next.id, closed)
  assert.equal(cache.readView(scenario.repo).sections.closed.state, 'current')

  tick(second)
  cache.writeOpenPage(next.id, pages[1]!)
  // the open list is complete, so the section is current before the cycle ends
  assert.equal(cache.readView(scenario.repo).sections.open.state, 'current')
  assert.equal(cache.finishCycle(next.id).cycle.state, 'finished')
  // a kind is kept only with an error
  assert.equal(cache.cycle(next.id)?.errorKind, null)
  cache.close()
})

test('a cycle failing partway keeps every row and marks the unreached ones stale', async () => {
  const { pages, closed } = await fetched()
  const { cache, tick } = memoryCache()
  fullCycle(cache, tick, pages, closed)
  const firstSuccess = cache.readView(scenario.repo).lastSuccessAt

  tick(5 * minute)
  const cycle = cache.startCycle(scenario.repo, 'manual')
  tick(second)
  cache.writeOpenPage(cycle.id, pages[0]!)
  tick(second)
  cache.recordError(cycle.id, 'open-page', 2, 'gh api graphql failed: dial tcp: no such host')
  const result = cache.finishCycle(cycle.id, 'gh api graphql failed: dial tcp: no such host', 'network')

  assert.equal(result.cycle.state, 'failed')
  assert.equal(result.cycle.errorKind, 'network')
  assert.equal(cache.latestCycle(scenario.repo)?.errorKind, 'network')
  assert.deepEqual(result.removed, [])
  assert.deepEqual(result.stale.map((row) => row.number), pages[1]!.prs.map((pr) => pr.number))
  assert.ok(result.stale.every((row) => row.freshness.state === 'stale'))

  const view = cache.readView(scenario.repo)
  assert.equal(view.open.length, scenario.openTotal)
  assert.equal(view.lastSuccessAt, firstSuccess)
  const stale = view.open.find((row) => row.number === 104)
  assert.deepEqual(stale?.freshness, {
    state: 'stale',
    fetchedAt: '2026-10-26T14:05:40Z',
    error: 'gh api graphql failed: dial tcp: no such host',
  })
  assert.equal(view.open.find((row) => row.number === 118)?.freshness.state, 'current')
  assert.equal(view.sections.open.state, 'stale')
  assert.equal(view.sections.open.error, 'gh api graphql failed: dial tcp: no such host')
  // the closed search was never reached, so it falls back to the cycle's error
  assert.deepEqual(view.sections.closed, {
    state: 'stale',
    fetchedAt: '2026-10-26T14:05:41Z',
    error: 'gh api graphql failed: dial tcp: no such host',
  })
  assert.deepEqual(view.closed?.result, closed)
  cache.close()
})

test('a section reports its own failed response over the cycle error', async () => {
  const { pages } = await fetched()
  const { cache, tick } = memoryCache()
  const cycle = cache.startCycle(scenario.repo, 'manual')
  for (const page of pages) cache.writeOpenPage(cycle.id, page)
  tick(second)
  cache.recordError(cycle.id, 'closed', null, 'GitHub GraphQL error: search timed out')
  cache.finishCycle(cycle.id, 'closed search failed')

  const view = cache.readView(scenario.repo)
  // the open list was complete before the failure
  assert.equal(view.sections.open.state, 'current')
  assert.ok(view.open.every((row) => row.freshness.state === 'current'))
  assert.deepEqual(view.sections.closed, { state: 'loading', fetchedAt: null, error: 'GitHub GraphQL error: search timed out' })
  cache.close()
})

test('a first cycle that fails leaves the sections loading with its error', () => {
  const { cache, tick } = memoryCache()
  const cycle = cache.startCycle(scenario.repo, 'manual')
  tick(second)
  cache.finishCycle(cycle.id, 'gh auth token failed: not logged in')
  const view = cache.readView(scenario.repo)
  assert.equal(view.cycle?.state, 'failed')
  assert.equal(view.cycle?.error, 'gh auth token failed: not logged in')
  assert.deepEqual(view.sections.open, { state: 'loading', fetchedAt: null, error: 'gh auth token failed: not logged in' })
  assert.equal(view.sections.closed.state, 'loading')
  cache.close()
})

test('PRs absent from a complete open list are removed when the cycle succeeds', async () => {
  const { pages, closed } = await fetched()
  const { cache, tick } = memoryCache()
  fullCycle(cache, tick, pages, closed)

  tick(5 * minute)
  const result = fullCycle(cache, tick, [pages[0]!, without(pages[1]!, [110, 116])], closed)
  assert.deepEqual(result.removed, [110, 116])
  const view = cache.readView(scenario.repo)
  assert.equal(view.open.length, scenario.openTotal - 2)
  assert.ok(!view.open.some((row) => row.number === 110 || row.number === 116))
  assert.equal(cache.db.prepare('SELECT state FROM prs WHERE number = 110').get()?.state, 'closed')

  // a PR that reopens comes back as open
  tick(5 * minute)
  assert.deepEqual(fullCycle(cache, tick, pages, closed).removed, [])
  assert.equal(cache.readView(scenario.repo).open.length, scenario.openTotal)
  cache.close()
})

test('a failed cycle removes nothing, even with a short open list', async () => {
  const { pages, closed } = await fetched()
  const { cache, tick } = memoryCache()
  fullCycle(cache, tick, pages, closed)

  tick(5 * minute)
  const cycle = cache.startCycle(scenario.repo, 'manual')
  cache.writeOpenPage(cycle.id, without(pages[0]!, [118]))
  const result = cache.finishCycle(cycle.id, 'closed search failed')
  assert.deepEqual(result.removed, [])
  assert.equal(cache.readView(scenario.repo).open.length, scenario.openTotal)
  cache.close()
})

test('a successful cycle that never saw the last page removes nothing', async () => {
  const { pages, closed } = await fetched()
  const { cache, tick } = memoryCache()
  fullCycle(cache, tick, pages, closed)

  tick(5 * minute)
  const cycle = cache.startCycle(scenario.repo, 'manual')
  cache.writeOpenPage(cycle.id, pages[0]!)
  const result = cache.finishCycle(cycle.id)
  assert.deepEqual(result.removed, [])
  assert.equal(states(cache)[104], 'stale')
  assert.equal(cache.readView(scenario.repo).sections.open.state, 'stale')
  cache.close()
})

test('only one cycle runs at a time, and a finished cycle takes no writes', async () => {
  const { pages, closed } = await fetched()
  const { cache } = memoryCache()
  const cycle = cache.startCycle(scenario.repo, 'manual')
  assert.throws(() => cache.startCycle(scenario.repo, 'manual'), CacheError)
  assert.throws(() => cache.startCycle('octo-example/other', 'manual'), CacheError)
  cache.finishCycle(cycle.id)
  assert.throws(() => cache.writeOpenPage(cycle.id, pages[0]!), CacheError)
  assert.throws(() => cache.writeClosed(cycle.id, closed), CacheError)
  assert.throws(() => cache.finishCycle(cycle.id), CacheError)
  assert.throws(() => cache.writeOpenPage(999, pages[0]!), CacheError)
  // a rejected write leaves nothing behind
  assert.equal(count(cache, 'snapshots'), 0)
  assert.equal(count(cache, 'prs'), 0)
  cache.close()
})

test('each repo sees only its own rows and cycles', async () => {
  const { pages, closed } = await fetched()
  const { cache, tick } = memoryCache()
  fullCycle(cache, tick, pages, closed)
  tick(minute)
  const other = cache.startCycle('octo-example/other', 'manual')
  cache.writeOpenPage(other.id, without(pages[1]!, []))
  cache.finishCycle(other.id)

  const view = cache.readView(scenario.repo)
  assert.equal(view.open.length, scenario.openTotal)
  assert.notEqual(view.cycle?.id, other.id)
  assert.ok(view.open.every((row) => row.freshness.state === 'current'))
  const otherView = cache.readView('octo-example/other')
  assert.equal(otherView.open.length, pages[1]!.prs.length)
  assert.equal(otherView.closed, null)
  assert.equal(otherView.sections.closed.state, 'loading')
  cache.close()
})

test('retention keeps the newest cycles and snapshots, and the latest good closed search', async () => {
  const { pages, closed } = await fetched()
  const { cache, tick } = memoryCache({ keepCycles: 4, keepSnapshotCycles: 2 })
  fullCycle(cache, tick, pages, closed)
  // drop 118 so its row is closed, and is pruned once its cycle falls out of the window
  tick(minute)
  fullCycle(cache, tick, [{ ...without(pages[0]!, [118]), hasNextPage: true }, pages[1]!], closed)
  const closedCycle = cache.latestCycle(scenario.repo)!.id
  for (let index = 0; index < 4; index += 1) {
    tick(minute)
    const cycle = cache.startCycle(scenario.repo, 'manual')
    cache.writeOpenPage(cycle.id, without(pages[0]!, [118]))
    cache.finishCycle(cycle.id, 'closed search failed')
  }

  const cycles = cache.db.prepare('SELECT id FROM cycles ORDER BY id').all().map((row) => Number(row.id))
  assert.equal(cycles.length, 4)
  const snapshotCycles = new Set(cache.db.prepare('SELECT cycle FROM snapshots').all().map((row) => Number(row.cycle)))
  // the last two cycles, plus the first cycle's closed search, which is still the latest good one
  assert.deepEqual([...snapshotCycles].sort((a, b) => a - b), [closedCycle, ...cycles.slice(-2)].sort((a, b) => a - b))
  const view = cache.readView(scenario.repo)
  assert.deepEqual(view.closed?.result, closed)
  assert.equal(view.sections.closed.state, 'stale')
  // the closed row's last fetch fell outside the kept cycles
  assert.equal(cache.db.prepare('SELECT count(*) AS n FROM prs WHERE number = 118').get()?.n, 0)
  // lastSuccessAt outlives its cycle row
  assert.notEqual(view.lastSuccessAt, null)
  cache.close()
})

test('reopening a file cache finds its rows and fails a cycle the last server left running', async () => {
  const { pages, closed } = await fetched()
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'state', 'cache.sqlite')
    const time = handClock()
    const first = openCache({ path, clock: time.clock })
    fullCycle(first, time.tick, pages, closed)
    const running = first.startCycle(scenario.repo, 'manual')
    first.writeOpenPage(running.id, pages[0]!)
    first.close()

    time.tick(minute)
    const second = openCache({ path, clock: time.clock })
    const cycle = second.cycle(running.id)
    assert.equal(cycle?.state, 'failed')
    assert.match(cycle?.error ?? '', /^interrupted/)
    assert.equal(cycle?.errorKind, 'interrupted')
    assert.equal(second.runningCycle(), null)
    const view = second.readView(scenario.repo)
    assert.equal(view.open.length, scenario.openTotal)
    assert.equal(states(second)[104], 'stale')
    assert.ok(second.startCycle(scenario.repo, 'manual').id > running.id)
    second.close()
  } finally {
    await cleanup()
  }
})

test('a cache file from another schema version is rebuilt empty', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const old = new DatabaseSync(path)
    old.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    old.exec('INSERT INTO meta (key, value) VALUES (\'schemaVersion\', \'0\')')
    old.exec('CREATE TABLE prs (repo TEXT, number INTEGER)')
    old.exec('INSERT INTO prs VALUES (\'octo-example/orbit\', 1)')
    old.close()

    const cache = openCache({ path, clock: handClock().clock })
    assert.equal(cache.db.prepare('SELECT value FROM meta WHERE key = \'schemaVersion\'').get()?.value, String(schemaVersion))
    assert.equal(count(cache, 'prs'), 0)
    assert.deepEqual(cache.readView(scenario.repo).open, [])
    cache.close()
  } finally {
    await cleanup()
  }
})

test('every cycle records the trigger that started it', () => {
  const { cache, tick } = memoryCache()
  for (const trigger of ['active', 'interval', 'manual', 'config', 'autoReview'] as const) {
    const cycle = cache.startCycle(scenario.repo, trigger)
    assert.equal(cycle.trigger, trigger)
    tick(second)
    assert.equal(cache.finishCycle(cycle.id).cycle.trigger, trigger)
  }
  const stored = cache.db.prepare('SELECT trigger FROM cycles ORDER BY id').all().map((row) => row.trigger)
  assert.deepEqual(stored, ['active', 'interval', 'manual', 'config', 'autoReview'])
  assert.equal(cache.readView(scenario.repo).cycle?.trigger, 'autoReview')
  // a value outside the list never reaches the table
  assert.throws(() => cache.startCycle(scenario.repo, 'cron' as never), CacheError)
  assert.equal(cache.runningCycle(), null)
  cache.close()
})

test('a version 1 cache, whose cycles have no trigger, is rebuilt', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const old = new DatabaseSync(path)
    old.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    old.exec('INSERT INTO meta (key, value) VALUES (\'schemaVersion\', \'1\')')
    old.exec('CREATE TABLE cycles (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, ok INTEGER, error TEXT, pages_done INTEGER NOT NULL DEFAULT 0, prs_updated INTEGER NOT NULL DEFAULT 0, prs_total INTEGER)')
    old.exec('INSERT INTO cycles (repo, started_at) VALUES (\'octo-example/orbit\', \'2026-10-26T14:00:00Z\')')
    old.close()

    const cache = openCache({ path, clock: handClock().clock })
    assert.equal(count(cache, 'cycles'), 0)
    assert.equal(cache.startCycle(scenario.repo, 'active').trigger, 'active')
    cache.close()
  } finally {
    await cleanup()
  }
})

// runs (phase 2)

const newRun = (number: number, patch: Partial<NewRun> = {}): NewRun => ({
  repo: scenario.repo, number, command: 'review-pr', args: [String(number)], label: 'Review', runner: 'claude', cwd: '~/dev/orbit',
  sessionId: null, pid: null, pidStartedAt: null, startedAt: '2026-10-26T14:00:00Z', lastStepAt: null, step: null, stepState: null,
  finishedAt: null, status: 'running', result: null, note: null, costUsd: null, resume: null, ...patch,
})

test('runs are recorded with their folder named by id, updated in place, and read per PR newest first', () => {
  const { cache } = memoryCache()
  const first = cache.createRun(newRun(106, { args: ['106', '--no-post'] }), (id) => `~/.local/state/pit-view/runs/${id}`)
  assert.equal(first.id, 1)
  assert.equal(first.dir, '~/.local/state/pit-view/runs/1')
  assert.deepEqual(first.args, ['106', '--no-post'])
  const result = { schema: 'pit-crew/review-result@1', status: 'done' } as unknown as NonNullable<Run['result']>
  const done = cache.updateRun(first.id, { status: 'done', finishedAt: '2026-10-26T14:10:00Z', result, costUsd: 0.42, step: 'post', stepState: 'skipped' })
  assert.deepEqual([done.status, done.costUsd, done.result, done.step, done.stepState], ['done', 0.42, result, 'post', 'skipped'])
  const second = cache.createRun(newRun(106), (id) => `~/runs/${id}`)
  const other = cache.createRun(newRun(113), (id) => `~/runs/${id}`)
  cache.createRun(newRun(106, { repo: 'octo-example/other' }), (id) => `~/runs/${id}`)
  assert.deepEqual(cache.runsFor(scenario.repo, 106).map((run) => run.id), [second.id, first.id])
  assert.deepEqual([...cache.latestRuns(scenario.repo).entries()].map(([number, run]) => [number, run.id]).sort(), [[106, second.id], [113, other.id]])
  assert.deepEqual(cache.runningRuns().map((run) => run.id), [second.id, other.id, 4])
  assert.throws(() => cache.updateRun(99, { status: 'done' }), CacheError)
  cache.close()
})

test('pruning keeps the newest runs and never one still running', () => {
  const { cache } = memoryCache({ keepRuns: 2 })
  const old = cache.createRun(newRun(101), (id) => `~/runs/${id}`)
  const finished = cache.createRun(newRun(102, { status: 'failed' }), (id) => `~/runs/${id}`)
  cache.createRun(newRun(103, { status: 'done' }), (id) => `~/runs/${id}`)
  cache.createRun(newRun(104, { status: 'done' }), (id) => `~/runs/${id}`)
  assert.deepEqual(cache.pruneRuns().map((run) => run.id), [finished.id])
  assert.equal(cache.getRun(old.id)?.status, 'running')
  assert.deepEqual(cache.pruneRuns(), [])
  cache.close()
})

test('a queued run is never pruned, is not counted as running, and is listed as queued', () => {
  const { cache } = memoryCache({ keepRuns: 1 })
  const waiting = cache.createRun(newRun(101, { status: 'queued' }), (id) => `~/runs/${id}`)
  const done = cache.createRun(newRun(102, { status: 'done' }), (id) => `~/runs/${id}`)
  cache.createRun(newRun(103, { status: 'done' }), (id) => `~/runs/${id}`)
  assert.deepEqual(cache.pruneRuns().map((run) => run.id), [done.id])
  assert.equal(cache.getRun(waiting.id)?.status, 'queued')
  assert.deepEqual(cache.runningRuns(), [])
  assert.deepEqual(cache.queuedRuns().map((run) => run.id), [waiting.id])
  cache.close()
})

test('a version 3 cache is rebuilt with runs, and a rebuild keeps the runs it finds', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const old = new DatabaseSync(path)
    old.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    old.exec('INSERT INTO meta (key, value) VALUES (\'schemaVersion\', \'3\')')
    old.exec('CREATE TABLE prs (repo TEXT, number INTEGER)')
    old.exec('INSERT INTO prs VALUES (\'octo-example/orbit\', 1)')
    old.close()
    let cache = openCache({ path, clock: handClock().clock })
    assert.equal(count(cache, 'prs'), 0)
    assert.equal(count(cache, 'runs'), 0)
    const kept = cache.createRun(newRun(106), (id) => `~/runs/${id}`)
    // a later version's rebuild drops the GitHub tables only
    cache.db.exec('UPDATE meta SET value = \'2\' WHERE key = \'schemaVersion\'')
    cache.close()
    cache = openCache({ path, clock: handClock().clock })
    assert.deepEqual(cache.runsFor(scenario.repo, 106).map((run) => run.id), [kept.id])
    // ids are never reused, so a run folder never names two runs
    assert.equal(cache.createRun(newRun(106), (id) => `~/runs/${id}`).id, kept.id + 1)
    cache.close()
  } finally {
    await cleanup()
  }
})

test('a run keeps its step slots, null until the first event', () => {
  const { cache } = memoryCache()
  const created = cache.createRun(newRun(106), (id) => `~/runs/${id}`)
  assert.equal(created.steps, null)
  const steps = [
    { step: 'resolveBase', state: 'done', at: '2026-10-26T14:01:00Z', note: null },
    { step: 'review', state: 'started', at: '2026-10-26T14:02:00Z', note: 'primary at work' },
    { step: 'consolidate', state: 'pending', at: null, note: null },
    { step: 'writeReport', state: 'pending', at: null, note: null },
    { step: 'post', state: 'pending', at: null, note: null },
  ] as const
  assert.deepEqual(cache.updateRun(created.id, { steps: [...steps] }).steps, steps)
  assert.deepEqual(cache.getRun(created.id)?.steps, steps)
  assert.equal(cache.updateRun(created.id, { steps: null }).steps, null)
  cache.close()
})

test('a version 4 cache gains runs.steps in place: its runs stay, with no steps recorded', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const old = new DatabaseSync(path)
    old.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    old.exec('INSERT INTO meta (key, value) VALUES (\'schemaVersion\', \'4\')')
    old.exec('CREATE TABLE prs (repo TEXT, number INTEGER)')
    old.exec('CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, number INTEGER NOT NULL, command TEXT NOT NULL, args TEXT NOT NULL, label TEXT NOT NULL, runner TEXT NOT NULL, cwd TEXT NOT NULL, dir TEXT NOT NULL, session_id TEXT, pid INTEGER, pid_started_at TEXT, started_at TEXT NOT NULL, last_step_at TEXT, step TEXT, step_state TEXT, finished_at TEXT, status TEXT NOT NULL, result TEXT, note TEXT, cost_usd REAL, resume TEXT)')
    old.exec('INSERT INTO runs (repo, number, command, args, label, runner, cwd, dir, started_at, status, step, step_state) VALUES (\'octo-example/orbit\', 106, \'review-pr\', \'["106"]\', \'Review\', \'claude\', \'~/dev/orbit\', \'~/runs/1\', \'2026-10-26T14:00:00Z\', \'done\', \'post\', \'done\')')
    old.close()
    const cache = openCache({ path, clock: handClock().clock })
    assert.equal(count(cache, 'prs'), 0)
    const kept = cache.getRun(1)
    assert.deepEqual([kept?.status, kept?.step, kept?.steps], ['done', 'post', null])
    assert.equal(cache.updateRun(1, { steps: [] }).steps?.length, 0)
    assert.equal(cache.db.prepare('SELECT value FROM meta WHERE key = \'schemaVersion\'').get()?.value, String(schemaVersion))
    cache.close()
    // opening it again changes nothing, and a fresh file has the column from the start
    const again = openCache({ path, clock: handClock().clock })
    assert.equal(again.getRun(1)?.steps?.length, 0)
    again.close()
  } finally {
    await cleanup()
  }
})

test('a version 5 cache lacks latestOpinionatedReviews, so its cached PRs are dropped and fetched again: its runs stay', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const first = openCache({ path, clock: handClock().clock })
    const created = first.createRun(newRun(106), (id) => `~/runs/${id}`)
    first.close()
    const old = new DatabaseSync(path)
    old.exec('INSERT INTO prs (repo, number, state, updated_at, head_oid, fetched_at, cycle, last_seen_at, data) VALUES (\'octo-example/orbit\', 106, \'open\', \'2026-10-26T12:00:00Z\', \'abc\', \'2026-10-26T12:00:00Z\', 1, \'2026-10-26T12:00:00Z\', \'{"number":106,"latestReviews":{"nodes":[]}}\')')
    old.exec('UPDATE meta SET value = \'5\' WHERE key = \'schemaVersion\'')
    assert.equal(old.prepare('SELECT count(*) AS n FROM prs').get()?.n, 1)
    old.close()
    const cache = openCache({ path, clock: handClock().clock })
    assert.equal(count(cache, 'prs'), 0)
    assert.equal(cache.getRun(created.id)?.id, created.id)
    assert.equal(cache.db.prepare('SELECT value FROM meta WHERE key = \'schemaVersion\'').get()?.value, String(schemaVersion))
    cache.close()
  } finally {
    await cleanup()
  }
})

test('a version 9 cache lacks the event ids of the timeline, so its cached PRs are dropped and fetched again: its runs stay', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const first = openCache({ path, clock: handClock().clock })
    const created = first.createRun(newRun(106), (id) => `~/runs/${id}`)
    first.close()
    const old = new DatabaseSync(path)
    old.exec('INSERT INTO prs (repo, number, state, updated_at, head_oid, fetched_at, cycle, last_seen_at, data) VALUES (\'octo-example/orbit\', 106, \'open\', \'2026-10-26T12:00:00Z\', \'abc\', \'2026-10-26T12:00:00Z\', 1, \'2026-10-26T12:00:00Z\', \'{"number":106}\')')
    old.exec('UPDATE meta SET value = \'9\' WHERE key = \'schemaVersion\'')
    old.close()
    const cache = openCache({ path, clock: handClock().clock })
    assert.equal(count(cache, 'prs'), 0)
    assert.equal(cache.getRun(created.id)?.id, created.id)
    assert.equal(cache.db.prepare('SELECT value FROM meta WHERE key = \'schemaVersion\'').get()?.value, String(schemaVersion))
    cache.close()
  } finally {
    await cleanup()
  }
})

test('a version 11 cache lacks the database ids of the latest reviews, so its cached PRs are dropped and fetched again: its runs stay', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const first = openCache({ path, clock: handClock().clock })
    const created = first.createRun(newRun(106), (id) => `~/runs/${id}`)
    first.close()
    const old = new DatabaseSync(path)
    old.exec('INSERT INTO prs (repo, number, state, updated_at, head_oid, fetched_at, cycle, last_seen_at, data) VALUES (\'octo-example/orbit\', 106, \'open\', \'2026-10-26T12:00:00Z\', \'abc\', \'2026-10-26T12:00:00Z\', 1, \'2026-10-26T12:00:00Z\', \'{"number":106}\')')
    old.exec('UPDATE meta SET value = \'11\' WHERE key = \'schemaVersion\'')
    old.close()
    const cache = openCache({ path, clock: handClock().clock })
    assert.equal(count(cache, 'prs'), 0)
    assert.equal(cache.getRun(created.id)?.id, created.id)
    assert.equal(cache.db.prepare('SELECT value FROM meta WHERE key = \'schemaVersion\'').get()?.value, String(schemaVersion))
    cache.close()
  } finally {
    await cleanup()
  }
})

test('a version 12 cache lacks GitHub\'s stack marker, so its cached PRs are dropped and fetched again: its runs and sweeps stay', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const first = openCache({ path, clock: handClock().clock })
    const created = first.createRun(newRun(106), (id) => `~/runs/${id}`)
    const sweep = first.createSweep(newSweep(), (id) => `~/sweeps/${id}`)
    first.close()
    const old = new DatabaseSync(path)
    old.exec('INSERT INTO prs (repo, number, state, updated_at, head_oid, fetched_at, cycle, last_seen_at, data) VALUES (\'octo-example/orbit\', 106, \'open\', \'2026-10-26T12:00:00Z\', \'abc\', \'2026-10-26T12:00:00Z\', 1, \'2026-10-26T12:00:00Z\', \'{"number":106}\')')
    old.exec('UPDATE meta SET value = \'12\' WHERE key = \'schemaVersion\'')
    old.close()
    assert.ok(schemaVersion >= 13)
    const cache = openCache({ path, clock: handClock().clock })
    assert.equal(count(cache, 'prs'), 0)
    assert.equal(cache.getRun(created.id)?.id, created.id)
    assert.deepEqual(cache.sweepsFor(scenario.repo).map((entry) => entry.id), [sweep.id])
    assert.equal(cache.db.prepare('SELECT value FROM meta WHERE key = \'schemaVersion\'').get()?.value, String(schemaVersion))
    cache.close()
  } finally {
    await cleanup()
  }
})

test('a version 7 cache gains runs.resolved_by_hand in place: its runs stay, not resolved by hand, and the flag is stored', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const first = openCache({ path, clock: handClock().clock })
    const created = first.createRun(newRun(106), (id) => `~/runs/${id}`)
    first.close()
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE runs DROP COLUMN resolved_by_hand')
    old.exec('UPDATE meta SET value = \'7\' WHERE key = \'schemaVersion\'')
    old.close()
    const cache = openCache({ path, clock: handClock().clock })
    assert.equal(cache.getRun(created.id)?.resolvedByHand, false)
    assert.equal(cache.updateRun(created.id, { resolvedByHand: true }).resolvedByHand, true)
    assert.equal(cache.db.prepare('SELECT value FROM meta WHERE key = \'schemaVersion\'').get()?.value, String(schemaVersion))
    cache.close()
    const again = openCache({ path, clock: handClock().clock })
    assert.equal(again.getRun(created.id)?.resolvedByHand, true)
    again.close()
  } finally {
    await cleanup()
  }
})

const newSweep = (patch: Partial<NewSweep> = {}): NewSweep => ({
  repo: scenario.repo, command: 'review-dependabot-sweep', args: [scenario.repo, '--parallel', '1'], label: 'Dependabot sweep', runner: 'claude', cwd: '~/dev/orbit',
  sessionId: null, pid: null, pidStartedAt: null, startedAt: '2026-10-26T14:00:00Z', lastStepAt: null, step: null, stepState: null,
  finishedAt: null, status: 'running', result: null, note: null, costUsd: null, resume: null, ...patch,
})

const sweepResult = { schema: 'pit-crew/sweep-result@1', status: 'done' } as unknown as NonNullable<Run['result']>

test('a version 6 cache gains sweeps in place: its runs are kept, and its cached PRs are fetched again since the open-PR query has changed since', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const first = openCache({ path, clock: handClock().clock })
    const created = first.createRun(newRun(106), (id) => `~/runs/${id}`)
    first.close()
    // what version 6 left behind: no sweeps table, a cached PR, and a run
    const old = new DatabaseSync(path)
    old.exec('DROP TABLE sweeps')
    old.exec('INSERT INTO prs (repo, number, state, updated_at, head_oid, fetched_at, cycle, last_seen_at, data) VALUES (\'octo-example/orbit\', 106, \'open\', \'2026-10-26T12:00:00Z\', \'abc\', \'2026-10-26T12:00:00Z\', 1, \'2026-10-26T12:00:00Z\', \'{"number":106}\')')
    old.exec('UPDATE meta SET value = \'6\' WHERE key = \'schemaVersion\'')
    old.close()
    const cache = openCache({ path, clock: handClock().clock })
    assert.equal(count(cache, 'prs'), 0)
    assert.equal(cache.getRun(created.id)?.id, created.id)
    assert.equal(count(cache, 'sweeps'), 0)
    assert.equal(cache.db.prepare('SELECT value FROM meta WHERE key = \'schemaVersion\'').get()?.value, String(schemaVersion))
    // a sweep is no run: runs.number stays NOT NULL, and a sweep row has no number at all
    const columns = cache.db.prepare('PRAGMA table_info(runs)').all()
    assert.equal(columns.find((column) => column.name === 'number')?.notnull, 1)
    assert.equal(cache.db.prepare('PRAGMA table_info(sweeps)').all().some((column) => column.name === 'number'), false)
    assert.equal(count(cache, 'runs'), 1)
    cache.close()
  } finally {
    await cleanup()
  }
})

test('a rebuild of the GitHub tables keeps the sweeps it finds, as it keeps the runs', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const first = openCache({ path, clock: handClock().clock })
    const kept = first.createSweep(newSweep(), (id) => `~/sweeps/${id}`)
    first.db.exec('UPDATE meta SET value = \'5\' WHERE key = \'schemaVersion\'')
    first.close()
    const cache = openCache({ path, clock: handClock().clock })
    assert.deepEqual(cache.sweepsFor(scenario.repo).map((sweep) => sweep.id), [kept.id])
    // ids are never reused, so a sweep folder never names two sweeps
    assert.equal(cache.createSweep(newSweep(), (id) => `~/sweeps/${id}`).id, kept.id + 1)
    cache.close()
  } finally {
    await cleanup()
  }
})

test('sweeps are recorded in a table of their own, with ids of their own, updated in place, and read newest first', () => {
  const { cache } = memoryCache()
  const run = cache.createRun(newRun(106), (id) => `~/runs/${id}`)
  const first = cache.createSweep(newSweep(), (id) => `~/.local/state/pit-view/sweeps/${id}`)
  assert.equal(first.id, 1)
  assert.equal(run.id, 1)
  assert.equal(first.dir, '~/.local/state/pit-view/sweeps/1')
  assert.deepEqual(first.args, [scenario.repo, '--parallel', '1'])
  assert.equal('number' in first, false)
  const done = cache.updateSweep(first.id, { status: 'done', finishedAt: '2026-10-26T14:10:00Z', result: sweepResult, costUsd: 1.5, steps: [] })
  assert.deepEqual([done.status, done.costUsd, done.result, done.steps], ['done', 1.5, sweepResult, []])
  const second = cache.createSweep(newSweep(), (id) => `~/sweeps/${id}`)
  cache.createSweep(newSweep({ repo: 'octo-example/other' }), (id) => `~/sweeps/${id}`)
  assert.deepEqual(cache.sweepsFor(scenario.repo).map((sweep) => sweep.id), [second.id, first.id])
  assert.deepEqual(cache.sweepsFor(scenario.repo, 1).map((sweep) => sweep.id), [second.id])
  assert.deepEqual(cache.runningSweeps().map((sweep) => sweep.id), [second.id, 3])
  // the runs table saw none of it
  assert.deepEqual(cache.runningRuns().map((row) => row.id), [run.id])
  assert.throws(() => cache.updateSweep(99, { status: 'done' }), CacheError)
  assert.equal(cache.getSweep(99), null)
  cache.close()
})

test('pruning keeps the newest sweeps and never one still running', () => {
  const { cache } = memoryCache({ keepSweeps: 2 })
  const old = cache.createSweep(newSweep(), (id) => `~/sweeps/${id}`)
  const finished = cache.createSweep(newSweep({ status: 'failed' }), (id) => `~/sweeps/${id}`)
  cache.createSweep(newSweep({ status: 'done' }), (id) => `~/sweeps/${id}`)
  cache.createSweep(newSweep({ status: 'done' }), (id) => `~/sweeps/${id}`)
  assert.deepEqual(cache.pruneSweeps().map((sweep) => sweep.id), [finished.id])
  assert.deepEqual(cache.sweepsFor(scenario.repo).map((sweep) => sweep.id).sort(), [3, 4])
  assert.equal(cache.getSweep(old.id)?.id, old.id)
  cache.close()
})

test('a page fetched before a one-PR refresh does not overwrite what that refresh wrote, and a later cycle still updates the row', async () => {
  const { pages, closed } = await fetched()
  const { cache, tick } = memoryCache()
  fullCycle(cache, tick, pages, closed)
  tick(second)
  const stale = cache.startCycle(scenario.repo, 'manual')
  tick(second)
  // the action finished and its refresh wrote the post-action state while that cycle was running
  const target = pages[0]!.prs[0]!
  const after = { ...target, title: 'after the action', headRefOid: 'f'.repeat(40) }
  cache.writePr(scenario.repo, after, null)
  // a PR merged by the action leaves the open table
  const merged = pages[0]!.prs[1]!
  cache.closePr(scenario.repo, merged.number)
  tick(second)
  // the page was read before the action, so it still says the old state
  cache.writeOpenPage(stale.id, pages[0]!)
  const open = cache.readView(scenario.repo).open
  assert.equal(open.find((row) => row.number === target.number)?.pr.title, 'after the action')
  assert.equal(open.find((row) => row.number === merged.number), undefined)
  assert.equal(cache.finishCycle(stale.id).cycle.state, 'finished')
  assert.equal(cache.readView(scenario.repo).open.find((row) => row.number === merged.number), undefined)

  // a cycle that starts afterwards fetches newer state and wins as usual
  tick(second)
  fullCycle(cache, tick, pages, closed)
  assert.equal(cache.readView(scenario.repo).open.find((row) => row.number === target.number)?.pr.title, target.title)
})

test('a PR on two pages of one cycle still ends as its later copy', async () => {
  const { pages } = await fetched()
  const { cache, tick } = memoryCache()
  const cycle = cache.startCycle(scenario.repo, 'manual')
  tick(second)
  const target = pages[0]!.prs[0]!
  cache.writeOpenPage(cycle.id, pages[0]!)
  tick(second)
  cache.writeOpenPage(cycle.id, { ...pages[1]!, prs: [{ ...target, title: 'later copy' }] })
  assert.equal(cache.readView(scenario.repo).open.find((row) => row.number === target.number)?.pr.title, 'later copy')
})

// a clock that never moves, so every timestamp the cache writes is identical
const frozenCache = () => {
  const cache = openCache({ path: ':memory:', clock: { now: () => Date.parse(scenario.now) } })
  return cache
}

test('with identical timestamps, a page fetched before a one-PR refresh still does not overwrite it', async () => {
  const { pages, closed } = await fetched()
  const cache = frozenCache()
  const target = pages[0]!.prs[0]!
  const merged = pages[0]!.prs[1]!
  const stale = cache.startCycle(scenario.repo, 'manual')
  cache.writePr(scenario.repo, { ...target, title: 'after the action' }, null)
  cache.closePr(scenario.repo, merged.number)
  cache.writeOpenPage(stale.id, pages[0]!)
  const open = cache.readView(scenario.repo).open
  assert.equal(open.find((row) => row.number === target.number)?.pr.title, 'after the action')
  assert.equal(open.find((row) => row.number === merged.number), undefined)
  cache.writeClosed(stale.id, closed)
  cache.finishCycle(stale.id)
  assert.equal(cache.readView(scenario.repo).open.find((row) => row.number === target.number)?.pr.title, 'after the action')
  assert.equal(cache.readView(scenario.repo).open.find((row) => row.number === merged.number), undefined)
})

test('a duplicate page after an intervening one-PR refresh does not overwrite the refreshed row or resurrect a closed PR', async () => {
  const { pages } = await fetched()
  const { cache, tick } = memoryCache()
  const cycle = cache.startCycle(scenario.repo, 'manual')
  tick(second)
  const target = pages[0]!.prs[0]!
  const merged = pages[0]!.prs[1]!
  // both PRs appear on a page first, so the cycle has already written them
  cache.writeOpenPage(cycle.id, pages[0]!)
  tick(second)
  cache.writePr(scenario.repo, { ...target, title: 'after the action' }, null)
  cache.closePr(scenario.repo, merged.number)
  tick(second)
  // the same PRs show up again on a later page of the same cycle, read before the action
  cache.writeOpenPage(cycle.id, { ...pages[1]!, prs: [{ ...target, title: 'older copy' }, merged] })
  const open = cache.readView(scenario.repo).open
  assert.equal(open.find((row) => row.number === target.number)?.pr.title, 'after the action')
  assert.equal(open.find((row) => row.number === merged.number), undefined)
})

test('a cycle that starts after a one-PR refresh updates the row, even at an identical instant', async () => {
  const { pages, closed } = await fetched()
  const cache = frozenCache()
  fullCycle(cache, () => {}, pages, closed)
  const target = pages[0]!.prs[0]!
  const merged = pages[0]!.prs[1]!
  cache.writePr(scenario.repo, { ...target, title: 'after the action' }, null)
  cache.closePr(scenario.repo, merged.number)
  fullCycle(cache, () => {}, pages, closed)
  const open = cache.readView(scenario.repo).open
  assert.equal(open.find((row) => row.number === target.number)?.pr.title, target.title)
  assert.equal(open.find((row) => row.number === merged.number)?.pr.title, merged.title)
})

test('a one-PR refresh that began before a cycle and finishes after the cycle wrote a newer page does not replace the newer row', async () => {
  const { pages, closed } = await fetched()
  const cache = frozenCache()
  const target = pages[0]!.prs[0]!
  const ticket = cache.beginRefresh()
  const cycle = cache.startCycle(scenario.repo, 'manual')
  cache.writeOpenPage(cycle.id, { ...pages[0]!, prs: pages[0]!.prs.map((pr) => pr.number === target.number ? { ...pr, title: 'newer page' } : pr) })
  const returned = cache.writePr(scenario.repo, { ...target, title: 'older refresh' }, null, ticket)
  assert.equal(returned?.pr.title, 'newer page')
  assert.equal(cache.readView(scenario.repo).open.find((row) => row.number === target.number)?.pr.title, 'newer page')
  cache.writeOpenPage(cycle.id, pages[1]!)
  cache.writeClosed(cycle.id, closed)
  cache.finishCycle(cycle.id)
  assert.equal(cache.readView(scenario.repo).open.find((row) => row.number === target.number)?.pr.title, 'newer page')
})

test('a one-PR close that began before a cycle and finishes after the cycle wrote the PR does not close it', async () => {
  const { pages } = await fetched()
  const cache = frozenCache()
  const merged = pages[0]!.prs[1]!
  const ticket = cache.beginRefresh()
  const cycle = cache.startCycle(scenario.repo, 'manual')
  cache.writeOpenPage(cycle.id, pages[0]!)
  assert.equal(cache.closePr(scenario.repo, merged.number, ticket), false)
  assert.equal(cache.readView(scenario.repo).open.find((row) => row.number === merged.number)?.pr.title, merged.title)
})

test('a one-PR refresh that began before a cycle which omitted the PR cannot reopen it when it finishes after the cycle', async () => {
  const { pages, closed } = await fetched()
  const cache = frozenCache()
  fullCycle(cache, () => {}, pages, closed)
  const gone = pages[0]!.prs[1]!
  const ticket = cache.beginRefresh()
  const cycle = cache.startCycle(scenario.repo, 'manual')
  for (const page of pages) cache.writeOpenPage(cycle.id, without(page, [gone.number]))
  cache.writeClosed(cycle.id, closed)
  const finished = cache.finishCycle(cycle.id)
  assert.deepEqual(finished.removed, [gone.number])
  const returned = cache.writePr(scenario.repo, { ...gone, title: 'older open read' }, null, ticket)
  assert.equal(returned?.state, 'closed')
  assert.notEqual(returned?.cycle, cycle.id)
  assert.equal(cache.readView(scenario.repo).open.find((row) => row.number === gone.number), undefined)
  assert.equal(cache.closePr(scenario.repo, gone.number, ticket), false)
})

test('a one-PR refresh that began after a cycle started keeps its row through the cycle\'s finish', async () => {
  const { pages, closed } = await fetched()
  const cache = frozenCache()
  fullCycle(cache, () => {}, pages, closed)
  const kept = pages[0]!.prs[1]!
  const cycle = cache.startCycle(scenario.repo, 'manual')
  const ticket = cache.beginRefresh()
  cache.writeOpenPage(cycle.id, { ...pages[0]!, prs: pages[0]!.prs.filter((pr) => pr.number !== kept.number) })
  cache.writePr(scenario.repo, { ...kept, title: 'refreshed mid-cycle' }, null, ticket)
  cache.writeClosed(cycle.id, closed)
  const finished = cache.finishCycle(cycle.id)
  assert.equal(finished.removed.includes(kept.number), false)
  assert.equal(cache.readView(scenario.repo).open.find((row) => row.number === kept.number)?.pr.title, 'refreshed mid-cycle')
})

const otherRepo = 'octo-example/elsewhere'

// the PR's row as stored, whatever its state, or undefined when there is none
const stored = (cache: Cache, number: number, repo: string = scenario.repo) => cache.db.prepare('SELECT state, cycle FROM prs WHERE repo = ? AND number = ?').get(repo, number)
const inOpenTable = (cache: Cache, number: number, repo: string = scenario.repo): boolean => cache.readView(repo).open.some((row) => row.number === number)

// a whole cycle that reached the last page of an open list without these PRs
const omittingCycle = (cache: Cache, pages: OpenPage[], closed: ClosedResult, numbers: number[], repo: string = scenario.repo) => {
  const cycle = cache.startCycle(repo, 'manual')
  for (const page of pages) cache.writeOpenPage(cycle.id, without(page, numbers))
  cache.writeClosed(cycle.id, closed)
  return cache.finishCycle(cycle.id)
}

test('a one-PR refresh that began before a completed cycle adds no row for a PR the cycle omitted and the cache never held', async () => {
  const { pages, closed } = await fetched()
  const cache = frozenCache()
  const gone = pages[0]!.prs[1]!
  const ticket = cache.beginRefresh()
  const finished = omittingCycle(cache, pages, closed, [gone.number])
  assert.deepEqual(finished.removed, [])
  assert.equal(cache.writePr(scenario.repo, { ...gone, title: 'older open read' }, null, ticket), null)
  assert.equal(stored(cache, gone.number), undefined)
  assert.equal(inOpenTable(cache, gone.number), false)
  assert.equal(cache.closePr(scenario.repo, gone.number, ticket), false)
  // nothing a notification baseline is built from carries the stale row, and the view still holds the cycle's rows
  assert.deepEqual(cache.readView(scenario.repo).open.map((row) => row.cycle).filter((id) => id !== finished.cycle.id), [])
})

for (const cached of [false, true]) {
  test(`a one-PR refresh that began before a cycle and landed during it is removed when the cycle completes without listing the PR (${cached ? 'cached' : 'not cached'} beforehand)`, async () => {
    const { pages, closed } = await fetched()
    const cache = frozenCache()
    if (cached) fullCycle(cache, () => {}, pages, closed)
    const gone = pages[0]!.prs[1]!
    const ticket = cache.beginRefresh()
    const cycle = cache.startCycle(scenario.repo, 'manual')
    // no page of this cycle has spoken yet, so this older read lands and carries the running cycle's id
    assert.equal(cache.writePr(scenario.repo, { ...gone, title: 'older open read' }, null, ticket)?.cycle, cycle.id)
    for (const page of pages) cache.writeOpenPage(cycle.id, without(page, [gone.number]))
    cache.writeClosed(cycle.id, closed)
    assert.deepEqual(cache.finishCycle(cycle.id).removed, [gone.number])
    assert.equal(inOpenTable(cache, gone.number), false)
    assert.equal(cache.writePr(scenario.repo, { ...gone, title: 'older open read' }, null, ticket)?.state, 'closed')
  })
}

test('a failed cycle sets no floor: an older one-PR refresh of a PR it did not list still lands, and a PR it listed still beats that refresh', async () => {
  const { pages } = await fetched()
  const cache = frozenCache()
  const gone = pages[0]!.prs[1]!
  const listed = pages[0]!.prs[0]!
  const ticket = cache.beginRefresh()
  const cycle = cache.startCycle(scenario.repo, 'manual')
  cache.writeOpenPage(cycle.id, without(pages[0]!, [gone.number]))
  assert.deepEqual(cache.finishCycle(cycle.id, 'closed search failed').removed, [])
  assert.equal(cache.writePr(scenario.repo, { ...gone, title: 'older open read' }, null, ticket)?.pr.title, 'older open read')
  assert.equal(inOpenTable(cache, gone.number), true)
  assert.equal(cache.writePr(scenario.repo, { ...listed, title: 'older open read' }, null, ticket)?.pr.title, listed.title)
})

test('a cycle that never saw the last page sets no floor: an older one-PR refresh of a PR it did not list still lands', async () => {
  const { pages } = await fetched()
  const cache = frozenCache()
  const unlisted = pages[1]!.prs[0]!
  const ticket = cache.beginRefresh()
  const cycle = cache.startCycle(scenario.repo, 'manual')
  cache.writeOpenPage(cycle.id, pages[0]!)
  assert.equal(cache.finishCycle(cycle.id).cycle.state, 'finished')
  assert.equal(cache.writePr(scenario.repo, { ...unlisted, title: 'older open read' }, null, ticket)?.pr.title, 'older open read')
  assert.equal(inOpenTable(cache, unlisted.number), true)
})

test('a floor outlives the start of the next cycle and its failure', async () => {
  const { pages, closed } = await fetched()
  const cache = frozenCache()
  const gone = pages[0]!.prs[1]!
  const ticket = cache.beginRefresh()
  omittingCycle(cache, pages, closed, [gone.number])
  const next = cache.startCycle(scenario.repo, 'manual')
  assert.equal(cache.writePr(scenario.repo, gone, null, ticket), null)
  cache.finishCycle(next.id, 'HTTP 502')
  assert.equal(cache.writePr(scenario.repo, gone, null, ticket), null)
  assert.equal(cache.closePr(scenario.repo, gone.number, ticket), false)
  assert.equal(stored(cache, gone.number), undefined)
})

test('a one-PR read that began after the completed cycle started survives, listed or not, and so does one begun after it finished', async () => {
  const { pages, closed } = await fetched()
  const cache = frozenCache()
  const gone = pages[0]!.prs[1]!
  const listed = pages[0]!.prs[0]!
  const late = pages[1]!.prs[0]!
  const cycle = cache.startCycle(scenario.repo, 'manual')
  const ticket = cache.beginRefresh()
  for (const page of pages) cache.writeOpenPage(cycle.id, without(page, [gone.number, late.number]))
  cache.writeClosed(cycle.id, closed)
  // a newer number taken before the finish: the floor is the cycle's start, not the counter when it finishes
  cache.beginRefresh()
  cache.finishCycle(cycle.id)
  // the PR opened after the list was read: it lands after the finish and reads as current
  const written = cache.writePr(scenario.repo, { ...gone, title: 'newer open read' }, null, ticket)
  assert.deepEqual([written?.state, written?.cycle, written?.freshness.state, written?.pr.title], ['open', cycle.id, 'current', 'newer open read'])
  assert.equal(cache.closePr(scenario.repo, listed.number, ticket), true)
  assert.equal(inOpenTable(cache, listed.number), false)
  assert.equal(cache.writePr(scenario.repo, late, null, cache.beginRefresh())?.state, 'open')
  assert.equal(inOpenTable(cache, late.number), true)
})

test('a floor belongs to one repository, keyed exactly as the rows are', async () => {
  const { pages, closed } = await fetched()
  const cache = frozenCache()
  const gone = pages[0]!.prs[1]!
  const ticket = cache.beginRefresh()
  omittingCycle(cache, pages, closed, [gone.number])
  assert.equal(cache.writePr(scenario.repo, gone, null, ticket), null)
  // another repository, and the same name in another case, which SQLite keeps as a row of its own
  for (const repo of [otherRepo, scenario.repo.toUpperCase()]) {
    assert.equal(cache.writePr(repo, gone, null, ticket)?.state, 'open')
    assert.equal(inOpenTable(cache, gone.number, repo), true)
    assert.equal(cache.closePr(repo, gone.number, ticket), true)
    assert.equal(inOpenTable(cache, gone.number, repo), false)
  }
  assert.equal(stored(cache, gone.number), undefined)
})

test('a read that loses to a newer read writes nothing, even when no row is there to return', async () => {
  const { pages } = await fetched()
  const cache = frozenCache()
  const target = pages[0]!.prs[0]!
  const first = cache.beginRefresh()
  const second = cache.beginRefresh()
  // the newer read found it closed, with no row to close
  assert.equal(cache.closePr(scenario.repo, target.number, second), false)
  assert.equal(cache.writePr(scenario.repo, { ...target, title: 'older open read' }, 'older-default', first), null)
  assert.equal(stored(cache, target.number), undefined)
  assert.equal(cache.readView(scenario.repo).defaultBranch, null)
})

test('a stale refresh finding no row after prune adds none, whether a completed cycle or a newer close closed the row', async () => {
  const { pages, closed } = await fetched()
  const cache = openCache({ path: ':memory:', clock: handClock().clock, keepCycles: 2 })
  const gone = pages[0]!.prs[1]!
  const closedByClose = pages[0]!.prs[2]!
  fullCycle(cache, () => {}, pages, closed)

  const beforeCycle = cache.beginRefresh()
  const first = cache.beginRefresh()
  cache.closePr(scenario.repo, closedByClose.number, cache.beginRefresh())
  omittingCycle(cache, pages, closed, [gone.number, closedByClose.number])
  for (let i = 0; i < 3; i += 1) omittingCycle(cache, pages, closed, [gone.number, closedByClose.number])
  assert.equal(stored(cache, gone.number), undefined)
  assert.equal(stored(cache, closedByClose.number), undefined)
  assert.equal(cache.writePr(scenario.repo, gone, null, beforeCycle), null)
  assert.equal(cache.writePr(scenario.repo, closedByClose, null, first), null)
  assert.equal(stored(cache, gone.number), undefined)
  assert.equal(stored(cache, closedByClose.number), undefined)
  cache.close()
})

test('with only failed cycles since, a stale refresh still loses to the newer close of a row that prune deleted', async () => {
  const { pages, closed } = await fetched()
  const cache = openCache({ path: ':memory:', clock: handClock().clock, keepCycles: 2 })
  const target = pages[0]!.prs[0]!
  fullCycle(cache, () => {}, pages, closed)
  const older = cache.beginRefresh()
  cache.closePr(scenario.repo, target.number, cache.beginRefresh())
  for (let i = 0; i < 3; i += 1) cache.finishCycle(cache.startCycle(scenario.repo, 'manual').id, 'HTTP 502')
  assert.equal(stored(cache, target.number), undefined)
  assert.equal(cache.writePr(scenario.repo, target, null, older), null)
  assert.equal(stored(cache, target.number), undefined)
  cache.close()
})

test('a PR last written by an older cycle\'s page is unaffected by a later cycle that proves nothing, and a later page still replaces it', async () => {
  const { pages, closed } = await fetched()
  const cache = frozenCache()
  const target = pages[0]!.prs[0]!
  fullCycle(cache, () => {}, pages, closed)
  const ticket = cache.beginRefresh()
  const failedCycle = cache.startCycle(scenario.repo, 'manual')
  cache.writeOpenPage(failedCycle.id, without(pages[0]!, [target.number]))
  cache.finishCycle(failedCycle.id, 'HTTP 502')
  assert.equal(inOpenTable(cache, target.number), true)
  assert.equal(cache.writePr(scenario.repo, { ...target, title: 'refreshed' }, null, ticket)?.pr.title, 'refreshed')
  fullCycle(cache, () => {}, pages, closed)
  assert.equal(cache.readView(scenario.repo).open.find((row) => row.number === target.number)?.pr.title, target.title)
})

test('of two one-PR refreshes of one PR, the one whose read began later wins whichever finishes first', async () => {
  const { pages } = await fetched()
  const cache = frozenCache()
  const target = pages[0]!.prs[0]!
  const first = cache.beginRefresh()
  const second = cache.beginRefresh()
  cache.writePr(scenario.repo, { ...target, title: 'began second' }, null, second)
  cache.writePr(scenario.repo, { ...target, title: 'began first' }, null, first)
  assert.equal(cache.readView(scenario.repo).open.find((row) => row.number === target.number)?.pr.title, 'began second')
})

test('a one-PR refresh that began after a cycle wrote the PR replaces it, even when it finishes during the cycle', async () => {
  const { pages } = await fetched()
  const cache = frozenCache()
  const target = pages[0]!.prs[0]!
  const cycle = cache.startCycle(scenario.repo, 'manual')
  cache.writeOpenPage(cycle.id, pages[0]!)
  const ticket = cache.beginRefresh()
  cache.writePr(scenario.repo, { ...target, title: 'after the page' }, null, ticket)
  assert.equal(cache.readView(scenario.repo).open.find((row) => row.number === target.number)?.pr.title, 'after the page')
})

test('a one-PR refresh that wrote nothing leaves the running cycle\'s data in place', async () => {
  const { pages } = await fetched()
  const cache = frozenCache()
  const cycle = cache.startCycle(scenario.repo, 'manual')
  cache.writeOpenPage(cycle.id, pages[0]!)
  // a failed refresh calls neither writePr nor closePr, so a later duplicate page still wins as usual
  const target = pages[0]!.prs[0]!
  cache.writeOpenPage(cycle.id, { ...pages[1]!, prs: [{ ...target, title: 'later copy' }] })
  assert.equal(cache.readView(scenario.repo).open.find((row) => row.number === target.number)?.pr.title, 'later copy')
})

test('a version 10 cache gains runs.report_hash and runs.post_attempted_at in place: its runs stay with neither, and both are stored', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const first = openCache({ path, clock: handClock().clock })
    const created = first.createRun(newRun(106), (id) => `~/runs/${id}`)
    first.close()
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE runs DROP COLUMN report_hash')
    old.exec('ALTER TABLE runs DROP COLUMN post_attempted_at')
    old.exec('UPDATE meta SET value = \'10\' WHERE key = \'schemaVersion\'')
    old.close()
    const cache = openCache({ path, clock: handClock().clock })
    assert.equal(cache.getRun(created.id)?.reportHash, null)
    assert.equal(cache.getRun(created.id)?.postAttemptedAt, null)
    const stored = cache.updateRun(created.id, { reportHash: 'c'.repeat(64), postAttemptedAt: '2026-10-26T14:04:00Z' })
    assert.equal(stored.reportHash, 'c'.repeat(64))
    assert.equal(stored.postAttemptedAt, '2026-10-26T14:04:00Z')
    assert.equal(cache.updateRun(created.id, { postAttemptedAt: null }).postAttemptedAt, null)
    assert.equal(cache.db.prepare('SELECT value FROM meta WHERE key = \'schemaVersion\'').get()?.value, String(schemaVersion))
    cache.close()
    const again = openCache({ path, clock: handClock().clock })
    assert.equal(again.getRun(created.id)?.reportHash, 'c'.repeat(64))
    again.close()
  } finally {
    await cleanup()
  }
})

test('a version 8 cache gains runs.first_note in place: its runs stay with no first note, and the field is stored', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const first = openCache({ path, clock: handClock().clock })
    const created = first.createRun(newRun(106), (id) => `~/runs/${id}`)
    first.close()
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE runs DROP COLUMN first_note')
    old.exec('UPDATE meta SET value = \'8\' WHERE key = \'schemaVersion\'')
    old.close()
    const cache = openCache({ path, clock: handClock().clock })
    assert.equal(cache.getRun(created.id)?.firstNote, null)
    assert.equal(cache.updateRun(created.id, { firstNote: 'permissionDenied: Bash' }).firstNote, 'permissionDenied: Bash')
    assert.equal(cache.db.prepare('SELECT value FROM meta WHERE key = \'schemaVersion\'').get()?.value, String(schemaVersion))
    cache.close()
    const again = openCache({ path, clock: handClock().clock })
    assert.equal(again.getRun(created.id)?.firstNote, 'permissionDenied: Bash')
    again.close()
  } finally {
    await cleanup()
  }
})

test('a cache from version 13 gains the ticks table and the auto-review columns on the runs and sweeps it keeps, and its GitHub tables are rebuilt for version 21', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const first = openCache({ path, clock: handClock().clock })
    const created = first.createRun(newRun(106), (id) => `~/runs/${id}`)
    const sweep = first.createSweep(newSweep(), (id) => `~/sweeps/${id}`)
    first.close()
    const old = new DatabaseSync(path)
    old.exec('INSERT INTO prs (repo, number, state, updated_at, head_oid, fetched_at, cycle, last_seen_at, data) VALUES (\'octo-example/orbit\', 106, \'open\', \'2026-10-26T12:00:00Z\', \'abc\', \'2026-10-26T12:00:00Z\', 1, \'2026-10-26T12:00:00Z\', \'{"number":106}\')')
    old.exec('DROP TABLE IF EXISTS ticks')
    for (const column of ['origin', 'tick', 'head_oid', 'reason', 'queued_at', 'posting', 'worktree']) old.exec(`ALTER TABLE runs DROP COLUMN ${column}`)
    for (const column of ['origin', 'tick', 'reason', 'queued_at', 'posting', 'worktree']) old.exec(`ALTER TABLE sweeps DROP COLUMN ${column}`)
    old.exec('UPDATE meta SET value = \'13\' WHERE key = \'schemaVersion\'')
    old.close()
    assert.equal(schemaVersion, 21)
    assert.equal(githubTablesVersion, 21)
    const cache = openCache({ path, clock: handClock().clock })
    // version 21 changed what the GitHub tables hold, so a cache from version 13 refetches its PRs
    assert.equal(count(cache, 'prs'), 0)
    const run = cache.getRun(created.id)
    assert.equal(run?.origin, 'manual')
    assert.equal(run?.tick, null)
    assert.equal(run?.headOid, null)
    assert.equal(run?.reason, null)
    assert.equal(run?.queuedAt, null)
    assert.equal(run?.posting, false)
    assert.equal(run?.worktree, null)
    const kept = cache.getSweep(sweep.id)
    assert.equal(kept?.origin, 'manual')
    assert.equal(kept?.worktree, null)
    assert.deepEqual(cache.ticksFor(scenario.repo), [])
    cache.close()
  } finally {
    await cleanup()
  }
})

test('a version 16 cache gains runs.models in place: its runs read as not recorded, the field is stored whole, and it survives a reopen', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const first = openCache({ path, clock: handClock().clock })
    const created = first.createRun(newRun(106), (id) => `~/runs/${id}`)
    first.close()
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE runs DROP COLUMN models')
    old.exec('UPDATE meta SET value = \'16\' WHERE key = \'schemaVersion\'')
    old.close()
    const cache = openCache({ path, clock: handClock().clock })
    assert.equal(cache.getRun(created.id)?.models, null)
    const models = { roles: [{ role: 'reviewer', id: 'sonnet', runner: 'claude' as const, provider: 'anthropic', model: 'sonnet', fallback: false, outcome: null }], degraded: false }
    assert.deepEqual(cache.updateRun(created.id, { models }).models, models)
    assert.equal(cache.updateRun(created.id, { models: null }).models, null)
    cache.updateRun(created.id, { models })
    assert.equal(cache.db.prepare('SELECT value FROM meta WHERE key = \'schemaVersion\'').get()?.value, String(schemaVersion))
    cache.close()
    const again = openCache({ path, clock: handClock().clock })
    assert.deepEqual(again.getRun(created.id)?.models, models)
    again.close()
  } finally {
    await cleanup()
  }
})

test('a version 17 cache gains sweeps.row_reports and sweeps.post_attempts in place: its sweeps are kept and its cached PRs are refetched, read as no reports recorded and no post begun, and both are stored whole', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const first = openCache({ path, clock: handClock().clock })
    const created = first.createSweep(newSweep({ status: 'done', result: sweepResult }), (id) => `~/sweeps/${id}`)
    const { pages, closed } = await fetched()
    fullCycle(first, () => {}, pages, closed)
    first.close()
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE sweeps DROP COLUMN row_reports')
    old.exec('ALTER TABLE sweeps DROP COLUMN post_attempts')
    old.exec('UPDATE meta SET value = \'17\' WHERE key = \'schemaVersion\'')
    old.close()
    const cache = openCache({ path, clock: handClock().clock })
    assert.equal(schemaVersion, 21)
    assert.equal(cache.getSweep(created.id)?.status, 'done')
    assert.equal(cache.getSweep(created.id)?.rowReports, null)
    assert.deepEqual(cache.getSweep(created.id)?.postAttempts, {})
    assert.equal(cache.readView(scenario.repo).open.length, 0, 'the cached PRs are refetched, since version 21 changed what a row holds')
    const reports = { 114: { hash: 'a'.repeat(64), verdict: 'clean' as const } }
    assert.deepEqual(cache.updateSweep(created.id, { rowReports: reports }).rowReports, reports)
    assert.deepEqual(cache.updateSweep(created.id, { postAttempts: { 114: '2026-10-26T14:00:00Z' } }).postAttempts, { 114: '2026-10-26T14:00:00Z' })
    assert.equal(cache.db.prepare('SELECT value FROM meta WHERE key = \'schemaVersion\'').get()?.value, String(schemaVersion))
    cache.close()
    const again = openCache({ path, clock: handClock().clock })
    assert.deepEqual(again.getSweep(created.id)?.rowReports, reports)
    assert.deepEqual(again.getSweep(created.id)?.postAttempts, { 114: '2026-10-26T14:00:00Z' })
    again.close()
  } finally {
    await cleanup()
  }
})

test('a version 18 cache gains the post_marks table in place, keeping its sweeps and refetching its cached PRs, and a PR\'s mark withholds until it is resolved or cleared and outlives a reopen', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const first = openCache({ path, clock: handClock().clock })
    const created = first.createSweep(newSweep({ status: 'done', result: sweepResult }), (id) => `~/sweeps/${id}`)
    const { pages, closed } = await fetched()
    fullCycle(first, () => {}, pages, closed)
    first.close()
    const old = new DatabaseSync(path)
    old.exec('DROP TABLE post_marks')
    old.exec('UPDATE meta SET value = \'18\' WHERE key = \'schemaVersion\'')
    old.close()
    const cache = openCache({ path, clock: handClock().clock })
    assert.equal(schemaVersion, 21)
    assert.equal(cache.getSweep(created.id)?.status, 'done')
    assert.equal(cache.readView(scenario.repo).open.length, 0, 'the cached PRs are refetched, since version 21 changed what a row holds')
    assert.deepEqual([...cache.unresolvedPostMarks(scenario.repo)], [])
    cache.beginPostMark(scenario.repo, 114, 'sweep 1')
    assert.deepEqual([...cache.unresolvedPostMarks(scenario.repo)], [114])
    assert.deepEqual([...cache.unresolvedPostMarks('other-org/other-repo')], [])
    assert.throws(() => cache.beginPostMark(scenario.repo, 114, 'run 9'), /by sweep 1 was begun earlier and may have landed/)
    cache.close()
    const again = openCache({ path, clock: handClock().clock })
    assert.deepEqual([...again.unresolvedPostMarks(scenario.repo)], [114])
    again.resolvePostMark(scenario.repo, 114)
    assert.deepEqual([...again.unresolvedPostMarks(scenario.repo)], [])
    again.beginPostMark(scenario.repo, 114, 'run 9')
    again.clearPostMark(scenario.repo, 114, 'run 9')
    assert.deepEqual([...again.unresolvedPostMarks(scenario.repo)], [])
    assert.equal(again.db.prepare('SELECT COUNT(*) AS n FROM post_marks').get()?.n, 0)
    // a mark another source took over since the post began is not that post's to take off
    again.beginPostMark(scenario.repo, 114, 'run 9')
    again.db.prepare('UPDATE post_marks SET source = \'sweep 4, head not on record\' WHERE number = 114').run()
    again.clearPostMark(scenario.repo, 114, 'run 9')
    assert.equal(again.unresolvedPostMark(scenario.repo, 114), 'sweep 4, head not on record')
    again.close()
  } finally {
    await cleanup()
  }
})

// the heads of the posted-head tests: what a run reviewed, a sweep row's head, and the head a moved-head post went onto
const shaX = 'abcdef0123456789abcdef0123456789abcdef01'
const shaY = '1234567890abcdef1234567890abcdef12345678'
const shaZ = '0fedcba9876543210fedcba9876543210fedcba9'

const reviewOf = (number: number, sha: string, posted: { form: string, url: string } | null): NonNullable<Run['result']> => ({
  schema: 'pit-crew/review-result@1', command: 'review-pr', status: 'done', target: { repo: scenario.repo, pr: number }, reviewed: { kind: 'commit', sha }, verdict: 'clean', recommendation: null,
  findings: [], ci: 'green', fixAttempts: 0, posted, notPostedReason: posted === null ? 'noPost' : null, report: `~/agents/output/PR-${number}.md`, question: null, error: null,
}) as unknown as NonNullable<Run['result']>

const sweepOfRows = (rows: { number: number, head: string, posted: { form: string, url: string } | null }[]): NonNullable<Run['result']> =>
  ({ schema: 'pit-crew/sweep-result@1', status: 'done', repo: scenario.repo, rows }) as unknown as NonNullable<Run['result']>

const comment = { form: 'comment', url: 'https://github.com/octo-example/orbit/pull/1#issuecomment-1' }

test('a post is on record at its head once a run or a sweep row records it or a mark is resolved with that head, in lowercase and per repository, and the record outlives the run and the sweep', () => {
  const { cache } = memoryCache()
  assert.deepEqual(cache.postRecords(scenario.repo), new Map())
  const run = cache.createRun(newRun(107, { status: 'done' }), (id) => `~/runs/${id}`)
  cache.updateRun(run.id, { result: reviewOf(107, shaX, null) })
  assert.equal(cache.postRecords(scenario.repo).get(107), undefined, 'a review that did not post records nothing')
  cache.updateRun(run.id, { result: reviewOf(107, shaX, comment) })
  cache.createSweep(newSweep({ status: 'done', result: sweepOfRows([{ number: 113, head: shaY, posted: comment }, { number: 201, head: shaZ, posted: null }]) }), (id) => `~/sweeps/${id}`)
  cache.beginPostMark(scenario.repo, 108, 'run 3')
  assert.deepEqual(cache.postRecords(scenario.repo).get(108), { unknown: true, heads: new Set() })
  cache.resolvePostMark(scenario.repo, 108, [shaZ.toUpperCase(), shaX])
  cache.db.exec('DELETE FROM runs')
  cache.db.exec('DELETE FROM sweeps')
  assert.deepEqual(cache.postRecords(scenario.repo), new Map([
    [107, { unknown: false, heads: new Set([shaX]) }],
    [108, { unknown: false, heads: new Set([shaZ, shaX]) }],
    [113, { unknown: false, heads: new Set([shaY]) }],
  ]))
  assert.deepEqual(cache.postRecords('octo-example/other'), new Map())
  cache.close()
})

// the marks a cache holds, by PR, with their sources and whether they are resolved
const marksOf = (cache: Cache): { number: number, source: string, resolved: boolean }[] =>
  cache.db.prepare('SELECT number, source, resolved_at FROM post_marks ORDER BY number').all().map((row) => ({ number: Number(row.number), source: String(row.source), resolved: row.resolved_at !== null }))

const headsOf = (cache: Cache): Record<number, string[]> => {
  const heads: Record<number, string[]> = {}
  for (const row of cache.db.prepare('SELECT number, head FROM posted_heads ORDER BY number, head').all()) heads[Number(row.number)] = [...heads[Number(row.number)] ?? [], String(row.head)]
  return heads
}

test('a post whose head cannot be established marks its PR as of unknown outcome, and a post from Pit View is on record at the head it went onto as well as the one its report reviewed', () => {
  const { cache } = memoryCache()
  const stored = (number: number, result: NonNullable<Run['result']>, patch: Partial<Run> = {}): Run => {
    const created = cache.createRun(newRun(number, { status: 'done' }), (id) => `~/runs/${id}`)
    return cache.updateRun(created.id, { ...patch, result })
  }
  // #120: a review that posted itself and names no reviewed commit; #121: one whose reviewed commit is not a full SHA
  const noCommit = stored(120, { ...reviewOf(120, shaX, comment), reviewed: null } as NonNullable<Run['result']>)
  const shortCommit = stored(121, reviewOf(121, 'abcdef0', comment))
  // #122: a post from Pit View, begun from the run, whose result does not say which head it went onto
  const noLanding = stored(122, reviewOf(122, shaX, comment), { postAttemptedAt: '2026-10-26T14:05:00Z' })
  // #123: a post from Pit View that names the head it went onto, a moved one
  stored(123, reviewOf(123, shaX, { ...comment, head: shaY.toUpperCase() } as typeof comment), { postAttemptedAt: '2026-10-26T14:06:00Z' })
  // #124: a landing head that is not a full SHA
  const badLanding = stored(124, reviewOf(124, shaX, { ...comment, head: '1234567' } as typeof comment))
  // #131: a stack review started from #130 that posted on its top layer
  const stack = cache.createRun(newRun(130, { status: 'done', command: 'review-stack' }), (id) => `~/runs/${id}`)
  cache.updateRun(stack.id, { result: { ...reviewOf(130, shaZ, comment), command: 'review-stack', target: { repo: scenario.repo, stack: [130, 131], top: 131 } } as NonNullable<Run['result']> })
  // the rows of a sweep: #140 a short head, #141 no head, #142 a post begun from the row with no landing head, #143 one with a moved landing head, and #144 a post the sweep made itself
  const sweep = cache.createSweep(newSweep({ status: 'done' }), (id) => `~/sweeps/${id}`)
  cache.updateSweep(sweep.id, {
    postAttempts: { 142: '2026-10-26T14:07:00Z', 143: '2026-10-26T14:08:00Z' },
    result: sweepOfRows([
      { number: 140, head: 'abcdef0', posted: comment },
      { number: 141, head: undefined as unknown as string, posted: comment },
      { number: 142, head: shaX, posted: comment },
      { number: 143, head: shaX, posted: { ...comment, head: shaY } as typeof comment },
      { number: 144, head: shaX, posted: comment },
    ]),
  })
  const unknown = (source: string): string => `${source}, head not on record`
  assert.deepEqual(marksOf(cache), [
    { number: 120, source: unknown(`run ${noCommit.id}`), resolved: false },
    { number: 121, source: unknown(`run ${shortCommit.id}`), resolved: false },
    { number: 122, source: unknown(`run ${noLanding.id}`), resolved: false },
    { number: 124, source: unknown(`run ${badLanding.id}`), resolved: false },
    { number: 140, source: unknown(`sweep ${sweep.id}`), resolved: false },
    { number: 141, source: unknown(`sweep ${sweep.id}`), resolved: false },
    { number: 142, source: unknown(`sweep ${sweep.id}`), resolved: false },
  ])
  assert.deepEqual(headsOf(cache), { 122: [shaX], 123: [shaY, shaX].sort(), 124: [shaX], 131: [shaZ], 142: [shaX], 143: [shaY, shaX].sort(), 144: [shaX] })
  for (const number of [120, 121, 122, 124, 140, 141, 142]) assert.equal(cache.postRecords(scenario.repo).get(number)?.unknown, true, `#${number}`)
  // a post from Pit View resolves only the mark it began, so a post with no head on record recorded while it was in flight keeps the PR marked
  cache.beginPostMark(scenario.repo, 150, 'sweep 9')
  const during = stored(150, { ...reviewOf(150, shaX, comment), reviewed: null } as NonNullable<Run['result']>)
  cache.resolvePostMark(scenario.repo, 150, [shaZ], 'sweep 9')
  assert.deepEqual(marksOf(cache).find((mark) => mark.number === 150), { number: 150, source: unknown(`run ${during.id}`), resolved: false })
  cache.beginPostMark(scenario.repo, 151, 'sweep 9')
  cache.resolvePostMark(scenario.repo, 151, [shaZ], 'sweep 9')
  assert.equal(cache.postRecords(scenario.repo).get(151)?.unknown, false)
  // a resolved mark is made unresolved again by a post with no head on record
  stored(151, { ...reviewOf(151, shaX, comment), reviewed: null } as NonNullable<Run['result']>)
  assert.equal(cache.postRecords(scenario.repo).get(151)?.unknown, true)
  cache.close()
})

test('a stored result and the post it names are one write: when the post cannot be put on record, the result is not stored either', () => {
  const { cache } = memoryCache()
  const run = cache.createRun(newRun(107, { status: 'done' }), (id) => `~/runs/${id}`)
  cache.updateRun(run.id, { result: reviewOf(107, shaX, null) })
  const sweep = cache.createSweep(newSweep({ status: 'done', result: sweepOfRows([{ number: 113, head: shaY, posted: null }]) }), (id) => `~/sweeps/${id}`)
  cache.db.exec('CREATE TEMP TRIGGER no_head BEFORE INSERT ON posted_heads BEGIN SELECT RAISE(ABORT, \'disk I/O error\'); END')
  cache.db.exec('CREATE TEMP TRIGGER no_mark BEFORE INSERT ON post_marks BEGIN SELECT RAISE(ABORT, \'disk I/O error\'); END')
  assert.throws(() => cache.updateRun(run.id, { result: reviewOf(107, shaX, comment), note: 'posted' }), /disk I\/O error/)
  assert.equal((cache.getRun(run.id)?.result as { posted: unknown } | null)?.posted, null, 'the run still reads as not posted')
  assert.equal(cache.getRun(run.id)?.note, null)
  assert.throws(() => cache.updateRun(run.id, { result: { ...reviewOf(107, shaX, comment), reviewed: null } as NonNullable<Run['result']> }), /disk I\/O error/)
  assert.equal((cache.getRun(run.id)?.result as { posted: unknown } | null)?.posted, null)
  assert.throws(() => cache.updateSweep(sweep.id, { result: sweepOfRows([{ number: 113, head: shaY, posted: comment }]) }), /disk I\/O error/)
  assert.equal((cache.getSweep(sweep.id)?.result as { rows: { posted: unknown }[] } | null)?.rows[0]?.posted, null)
  assert.throws(() => cache.createRun({ ...newRun(108, { status: 'done' }), result: reviewOf(108, shaX, comment) }, (id) => `~/runs/${id}`), /disk I\/O error/)
  assert.equal(cache.runsFor(scenario.repo, 108).length, 0, 'a run created with a post it cannot record is not created')
  cache.db.exec('DROP TRIGGER no_head')
  cache.db.exec('DROP TRIGGER no_mark')
  cache.updateRun(run.id, { result: reviewOf(107, shaX, comment) })
  assert.deepEqual(headsOf(cache), { 107: [shaX] })
  cache.close()
})

test('a cache whose stored results name posts that are not on record, as a stop between the two writes left it before they were one, is repaired when it opens, and the repair changes nothing on a second open', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const first = openCache({ path, clock: handClock().clock })
    const run = first.createRun(newRun(107, { status: 'done' }), (id) => `~/runs/${id}`)
    first.updateRun(run.id, { result: reviewOf(107, shaX, comment) })
    const unknown = first.createRun(newRun(120, { status: 'done' }), (id) => `~/runs/${id}`)
    first.updateRun(unknown.id, { result: { ...reviewOf(120, shaX, comment), reviewed: null } as NonNullable<Run['result']> })
    const sweep = first.createSweep(newSweep({ status: 'done', result: sweepOfRows([{ number: 113, head: shaY, posted: comment }, { number: 140, head: 'abcdef0', posted: comment }]) }), (id) => `~/sweeps/${id}`)
    // the state a stop after the result's write left: the result is stored, and nothing is on record
    first.db.exec('DELETE FROM posted_heads')
    first.db.exec('DELETE FROM post_marks')
    first.close()
    const cache = openCache({ path, clock: handClock().clock })
    assert.deepEqual(headsOf(cache), { 107: [shaX], 113: [shaY] })
    assert.deepEqual(marksOf(cache), [
      { number: 120, source: `run ${unknown.id}, head not on record`, resolved: false },
      { number: 140, source: `sweep ${sweep.id}, head not on record`, resolved: false },
    ])
    const rows = cache.db.prepare('SELECT * FROM post_marks ORDER BY number').all()
    cache.close()
    const again = openCache({ path, clock: handClock().clock })
    assert.deepEqual(again.db.prepare('SELECT * FROM post_marks ORDER BY number').all(), rows)
    assert.deepEqual(headsOf(again), { 107: [shaX], 113: [shaY] })
    assert.equal(again.getRun(run.id)?.id, run.id, 'the runs and the sweeps are kept as they were')
    again.close()
  } finally {
    await cleanup()
  }
})

for (const from of [18, 19]) {
  test(`a version ${from} cache carries forward the posts its runs and sweeps recorded: a post begun and never recorded marks its PR as of unknown outcome, and a post on record is on record at its head`, async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const path = join(dir, 'cache.sqlite')
      const first = openCache({ path, clock: handClock().clock })
      // #106: a run's post begun and never recorded; #107: a run's post on record at X
      const begun = first.createRun(newRun(106, { status: 'done' }), (id) => `~/runs/${id}`)
      first.updateRun(begun.id, { result: reviewOf(106, shaX, null), postAttemptedAt: '2026-10-26T14:05:00Z' })
      const landed = first.createRun(newRun(107, { status: 'done' }), (id) => `~/runs/${id}`)
      first.updateRun(landed.id, { result: reviewOf(107, shaX, comment), postAttemptedAt: '2026-10-26T14:06:00Z' })
      // #114: a sweep row's post begun and never recorded; #113: a sweep row's post on record at Y; #201: neither
      const sweep = first.createSweep(newSweep({ status: 'done', result: sweepOfRows([{ number: 114, head: shaZ, posted: null }, { number: 113, head: shaY, posted: comment }, { number: 201, head: shaZ, posted: null }]) }), (id) => `~/sweeps/${id}`)
      first.updateSweep(sweep.id, { postAttempts: { 114: '2026-10-26T14:07:00Z', 113: '2026-10-26T14:08:00Z' } })
      first.close()
      const old = new DatabaseSync(path)
      old.exec('DROP TABLE posted_heads')
      if (from === 18) old.exec('DROP TABLE post_marks')
      old.exec(`UPDATE meta SET value = '${from}' WHERE key = 'schemaVersion'`)
      old.close()
      const cache = openCache({ path, clock: handClock().clock })
      assert.equal(schemaVersion, 21)
      // #107's and #113's posts were made from Pit View, and nothing before version 20 recorded the head they went onto, so each marks its PR too, beside the reviewed head on record
      assert.deepEqual([...cache.unresolvedPostMarks(scenario.repo)].sort(), [106, 107, 113, 114])
      assert.deepEqual(cache.postRecords(scenario.repo), new Map([
        [106, { unknown: true, heads: new Set() }],
        [107, { unknown: true, heads: new Set([shaX]) }],
        [113, { unknown: true, heads: new Set([shaY]) }],
        [114, { unknown: true, heads: new Set() }],
      ]))
      assert.deepEqual(cache.db.prepare('SELECT number, source, attempted_at FROM post_marks ORDER BY number').all().map((row) => ({ ...row })), [
        { number: 106, source: `run ${begun.id}`, attempted_at: '2026-10-26T14:05:00Z' },
        { number: 107, source: `run ${landed.id}, head not on record`, attempted_at: '2026-10-26T14:06:00Z' },
        { number: 113, source: `sweep ${sweep.id}, head not on record`, attempted_at: '2026-10-26T14:08:00Z' },
        { number: 114, source: `sweep ${sweep.id}`, attempted_at: '2026-10-26T14:07:00Z' },
      ])
      assert.equal(cache.getRun(begun.id)?.postAttemptedAt, '2026-10-26T14:05:00Z', 'the runs and the sweeps are kept as they were')
      assert.deepEqual(cache.getSweep(sweep.id)?.postAttempts, { 114: '2026-10-26T14:07:00Z', 113: '2026-10-26T14:08:00Z' })
      cache.close()
      // a reopen at the current version carries nothing forward again
      const again = openCache({ path, clock: handClock().clock })
      again.clearPostMark(scenario.repo, 106, `run ${begun.id}`)
      again.close()
      const third = openCache({ path, clock: handClock().clock })
      assert.deepEqual([...third.unresolvedPostMarks(scenario.repo)].sort(), [107, 113, 114])
      third.close()
    } finally {
      await cleanup()
    }
  })
}

test('a new run carries the models it was created with, and one created without them reads as not recorded', () => {
  const cache = openCache({ path: ':memory:', clock: handClock().clock })
  const models = { roles: [{ role: 'reviewer', id: null, runner: 'codex' as const, provider: 'openai', model: null, fallback: false, outcome: null }], degraded: false }
  const withModels = cache.createRun({ ...newRun(106), models }, (id) => `~/runs/${id}`)
  assert.deepEqual(cache.getRun(withModels.id)?.models, models)
  const without = cache.createRun(newRun(107), (id) => `~/runs/${id}`)
  assert.equal(cache.getRun(without.id)?.models, null)
  cache.close()
})

test('a cache from version 15 drops its cached PRs, whose check runs lack the workflow run\'s identity, and keeps every run and sweep', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const first = openCache({ path, clock: handClock().clock })
    const created = first.createRun(newRun(106), (id) => `~/runs/${id}`)
    const sweep = first.createSweep(newSweep(), (id) => `~/sweeps/${id}`)
    first.close()
    const old = new DatabaseSync(path)
    old.exec('INSERT INTO prs (repo, number, state, updated_at, head_oid, fetched_at, cycle, last_seen_at, data) VALUES (\'octo-example/orbit\', 106, \'open\', \'2026-10-26T12:00:00Z\', \'abc\', \'2026-10-26T12:00:00Z\', 1, \'2026-10-26T12:00:00Z\', \'{"number":106}\')')
    old.exec('UPDATE meta SET value = \'15\' WHERE key = \'schemaVersion\'')
    old.close()
    const cache = openCache({ path, clock: handClock().clock })
    assert.equal(count(cache, 'prs'), 0)
    assert.equal(cache.getRun(created.id)?.id, created.id)
    assert.equal(cache.getSweep(sweep.id)?.id, sweep.id)
    assert.equal(cache.db.prepare('SELECT value FROM meta WHERE key = \'schemaVersion\'').get()?.value, String(schemaVersion))
    cache.close()
  } finally {
    await cleanup()
  }
})

test('a run and a sweep keep what auto-review writes on them, and skipped is a status like any other', () => {
  const { cache } = memoryCache()
  const run = cache.createRun({ ...newRun(106), origin: 'auto', tick: 7, headOid: 'abc1234', reason: 'pushed', queuedAt: '2026-10-26T12:00:00Z', posting: true, worktree: '~/w/run-1' }, (id) => `~/runs/${id}`)
  assert.equal(run.origin, 'auto')
  assert.equal(run.tick, 7)
  assert.equal(run.headOid, 'abc1234')
  assert.equal(run.reason, 'pushed')
  assert.equal(run.queuedAt, '2026-10-26T12:00:00Z')
  assert.equal(run.posting, true)
  assert.equal(run.worktree, '~/w/run-1')
  assert.equal(cache.updateRun(run.id, { posting: false, worktree: null, status: 'skipped', note: 'closed' }).posting, false)
  assert.equal(cache.getRun(run.id)?.status, 'skipped')
  const sweep = cache.createSweep({ ...newSweep(), origin: 'auto', tick: 7, reason: 'dependabot', queuedAt: '2026-10-26T12:00:00Z', posting: false, worktree: '~/w/sweep-1' }, (id) => `~/sweeps/${id}`)
  assert.equal(sweep.origin, 'auto')
  assert.equal(sweep.reason, 'dependabot')
  assert.equal(cache.allSweeps()[0]?.id, sweep.id)
  assert.equal(cache.allRuns()[0]?.id, run.id)
  // nothing is written on an ordinary run but its defaults
  const plain = cache.createRun(newRun(107), (id) => `~/runs/${id}`)
  assert.equal(plain.origin, 'manual')
  assert.equal(plain.posting, false)
  cache.close()
})

test('ticks are recorded, read newest first, kept to the last 500, closed at the next open when a tick was cut short, and kept through a rebuild of the GitHub tables', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const clock = handClock().clock
    const first = openCache({ path, clock, keepTicks: 3 })
    const made = [1, 2, 3, 4].map(() => first.createTick(scenario.repo))
    assert.deepEqual(first.ticksFor(scenario.repo).map((tick) => tick.id), [made[3]?.id, made[2]?.id, made[1]?.id])
    const finished = first.updateTick(made[3]?.id ?? 0, { finishedAt: '2026-10-26T14:00:00Z', state: 'ran', cycle: 12, qualified: 3, alreadyCurrent: 1, queued: 2 })
    assert.equal(finished.state, 'ran')
    assert.equal(finished.cycle, 12)
    assert.equal(finished.qualified, 3)
    assert.equal(finished.alreadyCurrent, 1)
    assert.equal(finished.queued, 2)
    assert.equal(first.latestTick(scenario.repo)?.id, made[3]?.id)
    first.close()
    const second = openCache({ path, clock, keepTicks: 3 })
    // made[2] was still open when the server stopped
    const cut = second.ticksFor(scenario.repo).find((tick) => tick.id === made[2]?.id)
    assert.equal(cut?.state, 'skipped')
    assert.equal(cut?.skipReason, 'interrupted')
    assert.notEqual(cut?.finishedAt, null)
    assert.equal(second.createTick(scenario.repo).id, (made[3]?.id ?? 0) + 1)
    second.close()
    const old = new DatabaseSync(path)
    old.exec('UPDATE meta SET value = \'12\' WHERE key = \'schemaVersion\'')
    old.close()
    const third = openCache({ path, clock, keepTicks: 3 })
    assert.equal(third.ticksFor(scenario.repo).length, 3)
    assert.deepEqual(third.ticksFor('octo-example/other'), [])
    third.close()
  } finally {
    await cleanup()
  }
})
