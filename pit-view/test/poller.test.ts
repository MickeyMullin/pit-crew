// test/poller.test.ts
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { openCache } from '../src/cache.ts'
import { createClients } from '../src/clients.ts'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import type { ClosedView, Counts, MineRow, OpenRow, Tiles } from '../src/derive.ts'
import { createGh } from '../src/github.ts'
import type { RawOpenResponse } from '../src/github.ts'
import { createPoller } from '../src/poller.ts'
import type { Patch, Sync, View } from '../src/poller.ts'
import { scenario } from './fixtures/scenario.ts'
import {
  closedSearch, failed, fakeRunner, fakeTime, field, gatedRunner, githubCalls, ok, openPage1, openPage2, tempDir,
} from './helpers.ts'
import type { FakeRunner } from './helpers.ts'

const second = 1000
const minute = 60 * second

// no real reports folder is ever read: this home does not exist
const nowhere = '/nonexistent/pit-view-test-home'

const baseConfig = (): Config => ({ ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer })

type Edits = {
  page1?: (raw: RawOpenResponse) => RawOpenResponse
  page2?: (raw: RawOpenResponse) => RawOpenResponse
  // a gh failure for page 2 of the open list
  failPage2?: string
  // page 2 waits for this
  page2Gate?: Promise<void>
}

// the fixture gh, with edits the test can change between cycles
const scriptedRunner = (edits: Edits = {}): FakeRunner & { edits: Edits } => {
  const runner = fakeRunner(async (args) => {
    if (args[0] === 'auth' && args[1] === 'token') return ok('gho_fixture_token\n')
    const query = field(args, 'query') ?? ''
    if (query.includes('query OpenPullRequests')) {
      if (field(args, 'after') === undefined) return ok(JSON.stringify((edits.page1 ?? ((raw) => raw))(await openPage1())))
      await edits.page2Gate
      if (edits.failPage2 !== undefined) return failed(edits.failPage2)
      return ok(JSON.stringify((edits.page2 ?? ((raw) => raw))(await openPage2())))
    }
    if (query.includes('query ClosedPullRequests')) return ok(JSON.stringify(await closedSearch()))
    return failed(`no answer for gh ${args.join(' ')}`)
  })
  return { ...runner, edits }
}

const withoutPr = (number: number) => (raw: RawOpenResponse): RawOpenResponse => {
  const repository = raw.data.repository!
  const nodes = repository.pullRequests.nodes.filter((pr) => pr.number !== number)
  return { data: { ...raw.data, repository: { ...repository, pullRequests: { ...repository.pullRequests, totalCount: 17, nodes } } } }
}

const asDraft = (number: number) => (raw: RawOpenResponse): RawOpenResponse => {
  const repository = raw.data.repository!
  const nodes = repository.pullRequests.nodes.map((pr) => pr.number === number ? { ...pr, isDraft: true } : pr)
  return { data: { ...raw.data, repository: { ...repository, pullRequests: { ...repository.pullRequests, nodes } } } }
}

type HarnessOptions = { runner?: FakeRunner, config?: Partial<Config>, home?: string }

const harness = ({ runner = scriptedRunner(), config = {}, home = nowhere }: HarnessOptions = {}) => {
  const time = fakeTime()
  const cache = openCache({ path: ':memory:', clock: time.clock })
  const patches: Patch[] = []
  // a view taken inside each emit, as a page fetching /api/view at that moment would get it
  const views: View[] = []
  const settings = { current: { ...baseConfig(), ...config } }
  const poller = createPoller({
    cache,
    gh: createGh(runner.runner),
    clock: time.clock,
    timers: time.timers,
    config: () => settings.current,
    home,
    timeZone: scenario.timeZone,
    emit: (patch) => {
      patches.push(patch)
      void poller.view().then((view) => views.push(view))
    },
    pageSize: scenario.pageSize,
  })
  return { time, cache, patches, views, settings, poller, runner }
}

const visibleRows = 17

const viewRows = (view: View): Map<number, OpenRow> => {
  const rows: OpenRow[] = [...view.mine.groups.flatMap((group) => group.rows), ...view.others.groups.flatMap((group) => group.rows)]
  return new Map(rows.map((row) => [row.number, row]))
}

// what the page keeps: rows by number plus the merged objects, rebuilt the way section 3 says
type PageState = { version: number, rows: Map<number, OpenRow>, closed: ClosedView, tiles: Tiles, counts: Counts, sync: Sync, repo: string }

const fromView = (view: View): PageState => ({
  version: view.version, rows: viewRows(view), closed: view.closed, tiles: view.tiles, counts: view.counts, sync: view.sync, repo: view.repo,
})

const apply = (state: PageState, patch: Patch): PageState => {
  assert.equal(patch.version, state.version + 1, 'patches arrive with no gap')
  const rows = new Map(state.rows)
  for (const number of patch.removed) rows.delete(number)
  for (const row of patch.rows) rows.set(row.number, row)
  return {
    version: patch.version,
    rows,
    closed: patch.closed ?? state.closed,
    tiles: { ...state.tiles, ...patch.tiles },
    counts: { ...state.counts, ...patch.counts },
    sync: { ...state.sync, ...patch.sync },
    repo: patch.repo ?? state.repo,
  }
}

// a page that loaded at view.version and applied every later patch matches a fresh view
const assertCatchesUp = (view: View, patches: readonly Patch[], final: View): void => {
  const state = patches.filter((patch) => patch.version > view.version).reduce(apply, fromView(view))
  const fresh = fromView(final)
  assert.equal(state.version, fresh.version)
  assert.deepEqual([...state.rows.keys()].sort(), [...fresh.rows.keys()].sort())
  for (const [number, row] of fresh.rows) assert.deepEqual(state.rows.get(number), row, `row ${number}`)
  // Today runs to now, so only its end may differ when no closed search arrived since
  assert.deepEqual({ ...state.closed, today: { ...state.closed.today, to: '' } }, { ...fresh.closed, today: { ...fresh.closed.today, to: '' } })
  assert.deepEqual(state.tiles, fresh.tiles)
  assert.deepEqual(state.counts, fresh.counts)
  assert.deepEqual(state.sync, fresh.sync)
  assert.equal(state.repo, fresh.repo)
}

// the view a page fetching /api/view right after that patch would have received
const viewAt = (views: readonly View[], version: number): View => {
  const view = views.find((candidate) => candidate.version === version)
  assert.ok(view !== undefined, `a view at version ${version}`)
  return view
}

const assertConsecutive = (patches: readonly Patch[]): void => {
  patches.forEach((patch, index) => assert.equal(patch.version, index + 1))
}

const triggers = (cache: ReturnType<typeof openCache>): string[] =>
  cache.db.prepare('SELECT trigger FROM cycles ORDER BY id').all().map((row) => String(row.trigger))

test('nothing runs at start, and no GitHub call happens while no client is active', async () => {
  const { time, poller, patches, runner, cache } = harness()
  const view = await poller.view()
  assert.equal(view.version, 0)
  assert.equal(view.repo, scenario.repo)
  assert.equal(view.autoReview, null)
  assert.equal(view.sync.cycle, null)
  assert.deepEqual(view.sync.ui, { activeClients: 0, nextCycleAt: null })
  assert.deepEqual(view.sync.sections.open, { state: 'loading', fetchedAt: null, error: null })
  assert.equal(view.closed.today.label, 'Today')
  assert.deepEqual(view.counts, { mine: { open: 0, drafts: 0 }, others: { open: 0 } })

  // a hidden page connects; nothing becomes active
  assert.equal(poller.setActive(0, false), null)
  time.advance(3 * 60 * minute)
  assert.equal(githubCalls(runner).length, 0)
  assert.equal(time.pending(), 0)
  assert.deepEqual(patches, [])
  assert.deepEqual(triggers(cache), [])
})

test('a client becoming active starts a cycle whose patches arrive in order and rebuild the view', async () => {
  const { poller, patches, views, cache } = harness()
  const before = await poller.view()
  assert.equal(poller.setActive(1, true), 1)
  await poller.idle()
  const final = await poller.view()

  assertConsecutive(patches)
  assert.equal(final.version, patches.length)
  assert.deepEqual(triggers(cache), ['active'])

  // the start yields sync alone, so the header can say refreshing
  const [start, ...rest] = patches
  assert.deepEqual(start?.rows, [])
  assert.equal(start?.closed, null)
  assert.equal(start?.tiles, undefined)
  assert.deepEqual(start?.sync?.cycle, { id: 1, trigger: 'active', state: 'running', startedAt: scenario.now, finishedAt: null, error: null, errorKind: null, prsUpdated: 0, prsTotal: null })

  // one patch per open page (9 PRs each, one of them a hidden draft), one for the closed search, one at the end
  const pagePatches = rest.filter((patch) => patch.rows.length > 0 && patch.counts !== undefined && patch !== rest[rest.length - 1])
  assert.deepEqual(pagePatches.map((patch) => patch.rows.length + patch.removed.length), [9, 9])
  assert.ok(pagePatches.every((patch) => patch.rows.every((row) => row.freshness.state === 'current')))
  // the hidden draft is removed rather than upserted
  assert.deepEqual(pagePatches[1]?.removed, [119])
  const closedPatch = rest.find((patch) => patch.closed !== null)
  assert.equal(closedPatch?.closed?.yesterday.label, 'Yesterday*')
  assert.ok((closedPatch?.closed?.today.rows.length ?? 0) > 0)
  const end = rest[rest.length - 1]
  assert.equal(end?.sync?.cycle?.state, 'finished')
  assert.equal(end?.sync?.cycle?.prsUpdated, scenario.openTotal)
  assert.deepEqual(end?.removed, [])
  assert.equal(end?.sync?.sections.open.state, 'current')
  assert.equal(end?.sync?.sections.closed.state, 'current')
  assert.equal(end?.sync?.lastSuccessAt, scenario.now)
  assert.equal(viewRows(final).size, visibleRows)

  // a page that loaded before the cycle, or at any patch during it, catches up exactly
  assertCatchesUp(before, patches, final)
  assert.equal(views.length, patches.length)
  for (const view of views) assertCatchesUp(view, patches, final)
})

test('a view taken mid-cycle shows reached rows current and the rest pending', async () => {
  const runner = scriptedRunner()
  const { poller, patches, time } = harness({ runner })
  poller.refresh('manual')
  await poller.idle()
  time.advance(minute)
  let release = (): void => {}
  runner.edits.page2Gate = new Promise((resolve) => {
    release = resolve
  })
  poller.refresh('manual')
  // wait until the second cycle has applied its first page
  while (!patches.some((patch) => patch.sync?.cycle?.id === 2 && patch.sync.cycle.prsUpdated > 0)) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  const mid = await poller.view()
  const rows = viewRows(mid)
  assert.equal(rows.size, visibleRows)
  assert.equal(rows.get(118)?.freshness.state, 'current')
  assert.equal(rows.get(104)?.freshness.state, 'pending')
  assert.equal(rows.get(104)?.freshness.fetchedAt, scenario.now)
  assert.equal(mid.sync.cycle?.state, 'running')
  assert.equal(mid.sync.sections.open.state, 'pending')
  release()
  await poller.idle()
  assert.ok([...viewRows(await poller.view()).values()].every((row) => row.freshness.state === 'current'))
})

test('the active rule refreshes only when the last cycle started more than 30 seconds ago', async () => {
  const { time, poller, runner, cache } = harness()
  assert.equal(poller.setActive(1, true), 1)
  await poller.idle()
  const calls = githubCalls(runner).length

  // the page hides, then returns 20 seconds after the cycle started: cache only
  poller.setActive(0, false)
  time.advance(20 * second)
  assert.equal(poller.setActive(1, true), null)
  assert.equal(githubCalls(runner).length, calls)

  // another 11 seconds and returning again refreshes
  poller.setActive(0, false)
  time.advance(11 * second)
  assert.equal(poller.setActive(1, true), 2)
  await poller.idle()
  assert.deepEqual(triggers(cache), ['active', 'active'])
})

test('interval cycles run every refreshSeconds while a client is active, counted from the last cycle of any trigger', async () => {
  const { time, poller, patches, cache } = harness()
  poller.setActive(1, true)
  await poller.idle()
  const t0 = Date.parse(scenario.now)
  assert.equal(patches[patches.length - 1]?.sync?.ui.nextCycleAt, new Date(t0 + 300 * second).toISOString().replace('.000Z', 'Z'))

  // a manual refresh at +100s postpones the interval to +400s rather than doubling up at +300s
  time.advance(100 * second)
  assert.deepEqual(poller.refresh('manual'), { started: true, cycle: 2 })
  await poller.idle()
  time.advance(250 * second)
  await poller.idle()
  assert.deepEqual(triggers(cache), ['active', 'manual'])
  time.advance(50 * second)
  await poller.idle()
  assert.deepEqual(triggers(cache), ['active', 'manual', 'interval'])
  time.advance(300 * second)
  await poller.idle()
  assert.deepEqual(triggers(cache), ['active', 'manual', 'interval', 'interval'])
  assertConsecutive(patches)
})

test('with every client hidden or paused the timer is cleared and nothing polls', async () => {
  const { time, poller, runner, patches, cache } = harness()
  const clients = createClients()
  const report = (change: { activeCount: number, becameActive: boolean } | null) =>
    change === null ? null : poller.setActive(change.activeCount, change.becameActive)

  // a hidden tab, then a paused one: neither is active
  report(clients.connect('tab-a', { visible: false, paused: false, idle: false }).change)
  const b = clients.connect('tab-b', { visible: true, paused: true, idle: false })
  report(b.change)
  time.advance(2 * 60 * minute)
  assert.equal(githubCalls(runner).length, 0)
  assert.equal(time.pending(), 0)

  // tab b resumes: one active cycle, and the interval timer is set
  assert.equal(report(clients.update('tab-b', { visible: true, paused: false, idle: false })), 1)
  await poller.idle()
  assert.equal(time.pending(), 1)

  // it pauses again: the timer goes, nextCycleAt goes null, and hours pass with no call
  const calls = githubCalls(runner).length
  report(clients.update('tab-b', { visible: true, paused: true, idle: false }))
  assert.equal(time.pending(), 0)
  assert.deepEqual(patches[patches.length - 1]?.sync?.ui, { activeClients: 0, nextCycleAt: null })
  time.advance(5 * 60 * minute)
  assert.equal(githubCalls(runner).length, calls)
  assert.deepEqual(triggers(cache), ['active'])
  assertConsecutive(patches)
})

test('manual and config refreshes are one-shots, and a trigger during a cycle joins it', async () => {
  const runner = gatedRunner(scriptedRunner())
  const { time, poller, cache } = harness({ runner })
  assert.deepEqual(poller.refresh('manual'), { started: true, cycle: 1 })
  assert.deepEqual(poller.refresh('manual'), { started: false, cycle: 1 })
  assert.deepEqual(poller.refresh('config'), { started: false, cycle: 1 })
  // a page becoming active joins too
  assert.equal(poller.setActive(1, true), 1)
  poller.setActive(0, false)
  runner.release()
  await poller.idle()
  assert.deepEqual(triggers(cache), ['manual'])
  // nothing active: no timer follows a one-shot
  assert.equal(time.pending(), 0)
  time.advance(60 * minute)
  assert.deepEqual(triggers(cache), ['manual'])
})

test('a cycle failing partway keeps reached rows current, marks the rest stale and retries at the interval', async () => {
  const runner = scriptedRunner()
  const { time, poller, patches, views } = harness({ runner })
  poller.refresh('manual')
  await poller.idle()
  const page2 = (await openPage2()).data.repository!.pullRequests.nodes.map((pr) => pr.number).filter((number) => number !== 119)

  time.advance(10 * minute)
  runner.edits.failPage2 = 'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host'
  const from = patches.length
  poller.setActive(1, true)
  await poller.idle()
  const cycle = patches.slice(from)
  const end = cycle[cycle.length - 1]!
  assert.equal(end.sync?.cycle?.state, 'failed')
  assert.match(end.sync?.cycle?.error ?? '', /no such host/)
  assert.deepEqual(end.removed, [])
  // the rows it never reached arrive marked stale, with their last fetch time
  assert.deepEqual(end.rows.map((row) => row.number).sort(), [...page2].sort())
  assert.ok(end.rows.every((row) => row.freshness.state === 'stale' && row.freshness.fetchedAt === scenario.now))
  assert.equal(end.sync?.sections.open.state, 'stale')

  const view = await poller.view()
  const rows = viewRows(view)
  assert.equal(rows.size, visibleRows)
  assert.equal(rows.get(118)?.freshness.state, 'current')
  assert.equal(rows.get(104)?.freshness.state, 'stale')
  assert.equal(view.sync.lastSuccessAt, scenario.now)
  assertCatchesUp(viewAt(views, from), patches, view)

  // the next cycle runs at the normal interval, not at once
  runner.edits.failPage2 = undefined
  time.advance(299 * second)
  await poller.idle()
  assert.equal((await poller.view()).sync.cycle?.state, 'failed')
  // gh's own error kind reaches the view, so the page can say what went wrong
  assert.equal((await poller.view()).sync.cycle?.errorKind, 'network')
  time.advance(second)
  await poller.idle()
  const after = await poller.view()
  assert.equal(after.sync.cycle?.trigger, 'interval')
  assert.equal(after.sync.cycle?.state, 'finished')
  assert.ok([...viewRows(after).values()].every((row) => row.freshness.state === 'current'))
  assertConsecutive(patches)
})

test('PRs that leave the open list are removed when the cycle completes; a row turning hidden goes at its page', async () => {
  const runner = scriptedRunner()
  const { poller, patches, views } = harness({ runner })
  poller.refresh('manual')
  await poller.idle()
  const from = patches.length
  runner.edits.page2 = withoutPr(104)
  runner.edits.page1 = asDraft(113)
  poller.refresh('manual')
  await poller.idle()
  const cycle = patches.slice(from + 1)
  const pagePatch = cycle.find((patch) => patch.removed.includes(113))
  assert.ok(pagePatch !== undefined && pagePatch.counts !== undefined)
  const end = cycle[cycle.length - 1]!
  assert.deepEqual(end.removed, [104])
  const view = await poller.view()
  assert.equal(viewRows(view).has(104), false)
  assert.equal(viewRows(view).has(113), false)
  assert.deepEqual(view.counts, { mine: { open: 4, drafts: 1 }, others: { open: 11 } })
  assertCatchesUp(viewAt(views, from), patches, view)
})

test('a cycle that fails removes nothing, even when its first page is short', async () => {
  const runner = scriptedRunner()
  const { poller, patches } = harness({ runner })
  poller.refresh('manual')
  await poller.idle()
  runner.edits.page1 = withoutPr(118)
  runner.edits.failPage2 = 'HTTP 502: Bad Gateway'
  poller.refresh('manual')
  await poller.idle()
  assert.deepEqual(patches[patches.length - 1]?.removed, [])
  assert.equal(viewRows(await poller.view()).get(118)?.freshness.state, 'stale')
})

test('reports are rescanned at the start of every cycle and for own PRs a page brings', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const reports = join(dir, 'agents', 'output')
    await mkdir(reports, { recursive: true })
    await writeFile(join(reports, 'PR-101.md'), 'Reviewed commit: `fix/webhook-retry` @ `e37eacd`\n', 'utf8')
    const { poller, time } = harness({ home: dir })
    poller.refresh('manual')
    await poller.idle()
    const mine = (view: View, number: number) => viewRows(view).get(number) as MineRow
    let view = await poller.view()
    assert.equal(mine(view, 101).selfReview.state, 'current')
    assert.equal(mine(view, 102).selfReview.state, 'none')

    await writeFile(join(reports, 'PR-102.md'), 'Reviewed commit: `docs/local-setup` @ `0badc0d`\n', 'utf8')
    time.advance(minute)
    poller.refresh('manual')
    await poller.idle()
    view = await poller.view()
    assert.equal(mine(view, 102).selfReview.state, 'stale')
    assert.equal(mine(view, 102).selfReview.reviewedOid, '0badc0d')
  } finally {
    await cleanup()
  }
})

test('a saved config change patches the recomputed rows at once and starts a config cycle', async () => {
  const { poller, patches, views, settings, cache } = harness()
  poller.refresh('manual')
  await poller.idle()

  // a new alias: only the rows that show alex-mendez change, and a config cycle follows
  let before = settings.current
  settings.current = { ...before, people: [{ login: 'alex-mendez', alias: 'Alex', initials: 'AM', color: '#0F766E', avatar: 'initials' }] }
  let from = patches.length
  await poller.configChanged(before)
  const aliasPatch = patches[from]!
  assert.ok(aliasPatch.rows.length > 0)
  assert.ok(aliasPatch.rows.every((row) => JSON.stringify(row).includes('"Alex"')))
  assert.deepEqual(aliasPatch.removed, [])
  assert.equal(aliasPatch.repo, undefined)
  await poller.idle()
  assert.deepEqual(triggers(cache), ['manual', 'config'])
  assertCatchesUp(viewAt(views, from), patches, await poller.view())

  // a display-only change recomputes nothing and starts no cycle
  before = settings.current
  settings.current = { ...before, density: 'compact' }
  from = patches.length
  await poller.configChanged(before)
  assert.deepEqual(patches[from]?.rows, [])
  assert.deepEqual(triggers(cache), ['manual', 'config'])

  // another repo: every old row goes at once, from the cache (empty for it), then its cycle runs
  before = settings.current
  settings.current = { ...before, repo: 'octo-example/comet' }
  from = patches.length
  await poller.configChanged(before)
  const repoPatch = patches[from]!
  assert.equal(repoPatch.repo, 'octo-example/comet')
  assert.equal(repoPatch.removed.length, visibleRows)
  assert.deepEqual(repoPatch.rows, [])
  assert.equal(repoPatch.sync?.sections.open.state, 'loading')
  await poller.idle()
  assert.equal(cache.latestCycle('octo-example/comet')?.trigger, 'config')
  assertCatchesUp(viewAt(views, from), patches, await poller.view())
  assertConsecutive(patches)
})

test('a repo change during a cycle for the old repo is followed by a cycle for the new one', async () => {
  const runner = gatedRunner(scriptedRunner())
  const { poller, settings, cache, patches } = harness({ runner })
  poller.refresh('manual')
  const before = settings.current
  settings.current = { ...before, repo: 'octo-example/comet' }
  await poller.configChanged(before)
  const from = patches.length
  runner.release()
  await poller.idle()
  // the old repo's cycle filled the cache but patched nothing on the new repo's page
  assert.ok(patches.slice(from).every((patch) => patch.sync?.cycle?.trigger !== 'manual'))
  assert.equal(cache.latestCycle(scenario.repo)?.state, 'finished')
  assert.equal(cache.latestCycle('octo-example/comet')?.trigger, 'config')
  assert.equal(cache.latestCycle('octo-example/comet')?.state, 'finished')
})

test('stop fails a running cycle, clears the timer and emits nothing more', async () => {
  const runner = gatedRunner(scriptedRunner())
  const { poller, cache, patches, time } = harness({ runner })
  poller.setActive(1, true)
  const count = patches.length
  poller.stop()
  runner.release()
  await new Promise((resolve) => setImmediate(resolve))
  await poller.idle()
  assert.equal(patches.length, count)
  assert.equal(cache.cycle(1)?.state, 'failed')
  assert.match(cache.cycle(1)?.error ?? '', /^stopped/)
  assert.equal(cache.cycle(1)?.errorKind, 'interrupted')
  assert.equal(time.pending(), 0)
  assert.equal(poller.setActive(1, true), null)
  assert.deepEqual(poller.refresh('manual'), { started: false, cycle: null })
})
