// test/ui-freshness.test.ts
// offline, partway, stale and paused readings in public/status.ts, run under Node against the
// real poller's views while the fixture gh fails and recovers
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openCache } from '../src/cache.ts'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import type { OpenRow, RowRefresh } from '../src/derive.ts'
import { createGh } from '../src/github.ts'
import { createPoller } from '../src/poller.ts'
import type { Sync, View } from '../src/poller.ts'
import { openRows } from '../public/state.ts'
import { offlineBadge, offlineBanner, oldestFetch, refreshButton, rowMarker, sectionMarker, syncStatus, tableState } from '../public/status.ts'
import { scenario } from './fixtures/scenario.ts'
import { failed, fakeRunner, fakeTime, field, fixtureRunner } from './helpers.ts'

const minute = 60_000
const zone = scenario.timeZone
const network = 'error connecting to api.github.com'

// the fixture gh, with GitHub reachable, unreachable, or failing from page 2 of the open list
const switchable = () => {
  const base = fixtureRunner()
  let mode: 'up' | 'down' | 'page2' | 'auth' | 'limited' | 'gone' = 'up'
  const fake = fakeRunner(async (args) => {
    const api = args[0] === 'api'
    if (api && mode === 'down') return failed(network)
    if (api && mode === 'auth') return failed('HTTP 401: Bad credentials (https://api.github.com/graphql)')
    if (api && mode === 'limited') return failed('gh: API rate limit exceeded for user (HTTP 403)')
    if (api && mode === 'gone') return { code: 1, stdout: JSON.stringify({ errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository.' }] }), stderr: '' }
    if (api && mode === 'page2' && field(args, 'after') === scenario.page2After) return failed(network)
    return base.runner(args)
  })
  return { runner: fake.runner, set: (next: typeof mode) => { mode = next } }
}

const harness = () => {
  const time = fakeTime()
  const gh = switchable()
  const config = (): Config => ({ ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer })
  const poller = createPoller({
    cache: openCache({ path: ':memory:', clock: time.clock }),
    gh: createGh(gh.runner),
    clock: time.clock,
    timers: time.timers,
    config,
    // no real reports folder is ever read: this home does not exist
    home: '/nonexistent/pit-view-test-home',
    timeZone: zone,
    emit: () => {},
    pageSize: scenario.pageSize,
  })
  const cycle = async (): Promise<View> => {
    poller.refresh('manual')
    await poller.idle()
    return poller.view()
  }
  return { time, gh, poller, cycle }
}

const live = (nowMs: number) => ({ paused: false, nowMs, timeZone: zone })
const paused = (nowMs: number) => ({ paused: true, nowMs, timeZone: zone })

// scenario.now is 10:05 AM in New York
const firstFetch = Date.parse(scenario.now)

test('a cycle that cannot reach GitHub reads offline, with the banner, stale rows and stale sections', async () => {
  const { time, gh, cycle } = harness()
  const fresh = await cycle()
  assert.equal(offlineBanner(fresh.sync, live(time.clock.now())), null)
  assert.equal(syncStatus(fresh.sync, live(time.clock.now())).tone, 'normal')

  time.advance(3 * minute)
  gh.set('down')
  const down = await cycle()
  const now = time.clock.now()
  assert.equal(down.sync.cycle?.state, 'failed')
  assert.equal(oldestFetch(down.sync), scenario.now)
  assert.deepEqual(syncStatus(down.sync, live(now)), { text: 'offline · cached 10:05 AM', tone: 'warn', key: `${down.sync.cycle?.id}:failed:live` })
  assert.deepEqual(offlineBanner(down.sync, live(now)), {
    lead: 'Can\'t reach GitHub. Showing cached data from 10:05 AM (3m old).',
    detail: 'Ages, CI and merge states may be out of date. Retrying every 5m.',
  })
  assert.equal(offlineBadge(down.sync), true)
  // paused, the banner says Refresh retries once, and the header says both
  assert.equal(offlineBanner(down.sync, paused(now))?.detail, 'Ages, CI and merge states may be out of date. Updates are paused; Refresh retries once.')
  const pausedStatus = syncStatus(down.sync, paused(now))
  assert.equal(pausedStatus.text, 'paused · offline · cached 10:05 AM')
  assert.notEqual(pausedStatus.key, syncStatus(down.sync, live(now)).key)
  // idle leads the header the same way, and leaves the banner as it is for an active page
  assert.equal(syncStatus(down.sync, { ...live(now), idle: true }).text, 'idle · offline · cached 10:05 AM')
  assert.deepEqual(offlineBanner(down.sync, { ...live(now), idle: true }), offlineBanner(down.sync, live(now)))

  // every row is shown from the cache, each with the stale dot; both sections too
  const rows = openRows(down)
  assert.equal(rows.length, 17)
  for (const row of rows) assert.deepEqual(rowMarker(row, down.sync, live(now)), { kind: 'stale', tip: 'cached 10:05 AM, refresh failed' })
  for (const section of [down.sync.sections.open, down.sync.sections.closed]) {
    assert.deepEqual(sectionMarker(section, live(now)), { kind: 'stale', tip: 'cached 10:05 AM, refresh failed' })
    assert.equal(tableState(section, down.sync, false), 'ready')
  }
  // a day later the cache time names its weekday
  assert.equal(syncStatus(down.sync, live(now + 24 * 60 * minute)).text, 'offline · cached Mon 10:05 AM')

  // recovery clears the banner and every marker
  time.advance(2 * minute)
  gh.set('up')
  const back = await cycle()
  const later = time.clock.now()
  assert.equal(offlineBanner(back.sync, live(later)), null)
  assert.equal(offlineBadge(back.sync), false)
  assert.equal(syncStatus(back.sync, live(later)).text, 'updated just now · every 5m')
  assert.ok(openRows(back).every((row) => rowMarker(row, back.sync, live(later)) === null))
  assert.equal(sectionMarker(back.sync.sections.open, live(later)), null)
})

test('a cycle failing partway says how many PRs it updated and how old the rest are', async () => {
  const { time, gh, cycle } = harness()
  await cycle()
  time.advance(10 * minute)
  gh.set('page2')
  const view = await cycle()
  const now = time.clock.now()
  assert.equal(view.sync.cycle?.prsUpdated, scenario.pageSize)
  assert.deepEqual(offlineBanner(view.sync, live(now)), {
    lead: `Refresh stopped partway: ${scenario.pageSize} of ${scenario.openTotal} PRs updated; the rest show cached data from 10:05 AM (10m old).`,
    detail: 'Ages, CI and merge states may be out of date. Retrying every 5m.',
  })
  // rows the cycle reached are current; the rest carry the dot
  const marked = openRows(view).map((row) => [row.number, rowMarker(row, view.sync, live(now))?.kind ?? null] as const)
  assert.ok(marked.some(([, kind]) => kind === null))
  assert.ok(marked.some(([, kind]) => kind === 'stale'))
  for (const row of openRows(view)) assert.equal(rowMarker(row, view.sync, live(now))?.kind ?? 'current', row.freshness.state)
})

test('with nothing cached and GitHub unreachable, the tables say No cached data yet under the banner', async () => {
  const { time, gh, poller, cycle } = harness()
  const before = await poller.view()
  assert.equal(tableState(before.sync.sections.open, before.sync, false), 'loading')
  // a paused first load with no cycle on its way has nothing coming
  assert.equal(tableState(before.sync.sections.open, before.sync, true), 'missing')
  gh.set('down')
  const view = await cycle()
  const now = time.clock.now()
  assert.equal(view.sync.sections.open.state, 'loading')
  assert.equal(tableState(view.sync.sections.open, view.sync, false), 'missing')
  assert.equal(tableState(view.sync.sections.closed, view.sync, false), 'missing')
  assert.equal(syncStatus(view.sync, live(now)).text, 'offline · nothing cached yet')
  assert.deepEqual(offlineBanner(view.sync, live(now)), { lead: 'Can\'t reach GitHub, and nothing is cached yet.', detail: 'Retrying every 5m.' })
  assert.equal(offlineBanner(view.sync, paused(now))?.detail, 'Updates are paused; Refresh retries once.')
  assert.equal(sectionMarker(view.sync.sections.open, live(now)), null)
})

const row = (fetchedAt: string, state: OpenRow['freshness']['state'] = 'current'): Pick<OpenRow, 'freshness'> => ({ freshness: { state, fetchedAt } })

const syncWith = (cycle: Sync['cycle']): Pick<Sync, 'cycle' | 'refreshSeconds'> => ({ cycle, refreshSeconds: 300 })

test('a pending row mutes its age only past the interval; a paused page mutes old rows; current rows have no marker', () => {
  const at = '2026-10-26T14:00:00Z'
  const running = syncWith({ id: 3, trigger: 'interval', state: 'running', startedAt: '2026-10-26T14:10:00Z', finishedAt: null, error: null, errorKind: null, prsUpdated: 0, prsTotal: null })
  const finished = syncWith({ id: 3, trigger: 'interval', state: 'finished', startedAt: at, finishedAt: at, error: null, errorKind: null, prsUpdated: 18, prsTotal: 18 })
  const base = Date.parse(at)
  // pending: fetched before the running cycle started
  assert.equal(rowMarker(row(at), running, live(base + 4 * minute)), null)
  assert.deepEqual(rowMarker(row(at), running, live(base + 6 * minute)), { kind: 'muted', tip: 'cached 10:00 AM, refreshing' })
  // Refresh while paused: the one-shot's pending rows still read refreshing
  assert.deepEqual(rowMarker(row(at), running, paused(base + 6 * minute)), { kind: 'muted', tip: 'cached 10:00 AM, refreshing' })
  // paused with no cycle running
  assert.equal(rowMarker(row(at), finished, paused(base + 4 * minute)), null)
  assert.deepEqual(rowMarker(row(at), finished, paused(base + 6 * minute)), { kind: 'muted', tip: 'cached 10:00 AM, paused' })
  assert.equal(rowMarker(row(at), finished, live(base + 60 * minute)), null)
  // stale wins over paused
  assert.deepEqual(rowMarker(row(at, 'stale'), finished, paused(base + minute)), { kind: 'stale', tip: 'cached 10:00 AM, refresh failed' })
})

test('a refreshing cycle after a failure hides the banner and reads refreshing until it ends', async () => {
  const { time, gh, cycle } = harness()
  await cycle()
  gh.set('down')
  const down = await cycle()
  const retry: Sync = { ...down.sync, cycle: { ...down.sync.cycle!, id: down.sync.cycle!.id + 1, state: 'running', prsUpdated: 0, prsTotal: null } }
  assert.equal(offlineBanner(retry, live(time.clock.now())), null)
  assert.equal(syncStatus(retry, paused(time.clock.now())).text, 'refreshing…')
})

test('the header and banner name the cause: sign-in, rate limit, an interrupted cycle, or any other failure', async () => {
  const { time, gh, cycle } = harness()
  await cycle()
  time.advance(10 * minute)
  const reading = async (mode: 'auth' | 'limited' | 'gone') => {
    gh.set(mode)
    const view = await cycle()
    const now = time.clock.now()
    return { kind: view.sync.cycle?.errorKind, status: syncStatus(view.sync, live(now)).text, banner: offlineBanner(view.sync, live(now)), badge: offlineBadge(view.sync) }
  }
  // only an unreachable GitHub is Offline in the header; every other cause leaves the badge off
  assert.deepEqual(await reading('auth'), {
    badge: false,
    kind: 'auth',
    status: 'sign-in failed · cached 10:05 AM',
    banner: {
      lead: 'GitHub did not accept gh\'s sign-in. Showing cached data from 10:05 AM (10m old).',
      detail: 'Ages, CI and merge states may be out of date. Check it with gh auth status in a terminal. Retrying every 5m.',
    },
  })
  const limited = await reading('limited')
  assert.equal(limited.kind, 'rateLimit')
  assert.equal(limited.badge, false)
  assert.equal(limited.status, 'rate-limited · cached 10:05 AM')
  assert.equal(limited.banner?.lead, 'GitHub\'s rate limit stopped the refresh. Showing cached data from 10:05 AM (10m old).')
  const gone = await reading('gone')
  assert.equal(gone.kind, 'graphql')
  assert.equal(gone.badge, false)
  assert.equal(gone.status, 'refresh failed · cached 10:05 AM')
  assert.equal(gone.banner?.lead, 'The refresh failed (GitHub GraphQL error: Could not resolve to a Repository). Showing cached data from 10:05 AM (10m old).')
  // a cycle cut off by the server stopping says so; one recorded without a kind reads as unreachable
  const failedSync = (await cycle()).sync
  const stopped = { ...failedSync, cycle: { ...failedSync.cycle!, errorKind: 'interrupted' as const } }
  assert.equal(syncStatus(stopped, live(time.clock.now())).text, 'interrupted · cached 10:05 AM')
  assert.equal(offlineBadge(stopped), false)
  const unknown = { ...failedSync, cycle: { ...failedSync.cycle!, errorKind: null } }
  assert.equal(offlineBanner(unknown, live(time.clock.now()))?.lead, 'Can\'t reach GitHub. Showing cached data from 10:05 AM (10m old).')
  assert.equal(offlineBadge(unknown), true)
})

test('a row\'s own refresh reads refreshing, or failed with its cause, ahead of what the cycles say', () => {
  const at = '2026-10-26T14:00:00Z'
  const base = Date.parse(at)
  const finished = syncWith({ id: 3, trigger: 'interval', state: 'finished', startedAt: at, finishedAt: at, error: null, errorKind: null, prsUpdated: 18, prsTotal: 18 })
  const failedWith = (errorKind: Extract<RowRefresh, { state: 'failed' }>['errorKind'], error = 'gh api graphql failed'): RowRefresh =>
    ({ state: 'failed', at, error, errorKind })
  const withRefresh = (refresh: RowRefresh | null, state: OpenRow['freshness']['state'] = 'current') => ({ ...row(at, state), refresh })
  // running: a muted age at once, even on a fresh row
  assert.deepEqual(rowMarker(withRefresh({ state: 'running', startedAt: at }), finished, live(base + minute)), { kind: 'muted', tip: 'cached 10:00 AM, refreshing this PR' })
  // failed: the amber dot, with the cause in the words the banner uses
  const tip = (refresh: RowRefresh): string | undefined => rowMarker(withRefresh(refresh), finished, live(base + minute))?.tip
  assert.equal(tip(failedWith('auth')), 'cached 10:00 AM, refreshing this PR failed: GitHub did not accept gh\'s sign-in; check it with gh auth status in a terminal')
  assert.equal(tip(failedWith('rateLimit')), 'cached 10:00 AM, refreshing this PR failed: GitHub\'s rate limit stopped it')
  assert.equal(tip(failedWith('network')), 'cached 10:00 AM, refreshing this PR failed: can\'t reach GitHub')
  assert.equal(tip(failedWith('graphql', 'GitHub GraphQL error: Could not resolve to a PullRequest.')), 'cached 10:00 AM, refreshing this PR failed: GitHub GraphQL error: Could not resolve to a PullRequest')
  assert.equal(rowMarker(withRefresh(failedWith('auth')), finished, live(base + minute))?.kind, 'stale')
  // with no refresh of its own, the cycles' reading stands
  assert.equal(rowMarker(withRefresh(null), finished, live(base + minute)), null)
  assert.deepEqual(rowMarker(withRefresh(null, 'stale'), finished, live(base + minute)), { kind: 'stale', tip: 'cached 10:00 AM, refresh failed' })
})

test('the row refresh button is named for its PR and says when it is refreshing or last failed', () => {
  assert.deepEqual(refreshButton({ number: 941, refresh: null }), { state: 'idle', label: 'Refresh #941', tip: 'Refresh #941' })
  assert.deepEqual(refreshButton({ number: 941, refresh: { state: 'running', startedAt: scenario.now } }), { state: 'running', label: 'Refreshing #941', tip: 'Refreshing #941…' })
  assert.deepEqual(refreshButton({ number: 941, refresh: { state: 'failed', at: scenario.now, error: 'gh: API rate limit exceeded', errorKind: 'rateLimit' } }), {
    state: 'failed', label: 'Refresh #941', tip: 'Refresh #941; the last try failed: GitHub\'s rate limit stopped it',
  })
})
