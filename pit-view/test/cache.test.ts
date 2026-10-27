// test/cache.test.ts
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { CacheError, openCache, schemaVersion } from '../src/cache.ts'
import type { Cache, CacheOptions } from '../src/cache.ts'
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
  assert.deepEqual(tables.map((row) => row.name), ['cycles', 'meta', 'prs', 'snapshots'])
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
