// test/ui-state.test.ts
// the page's state logic in public/, run under Node against the real poller's views and patches
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openCache } from '../src/cache.ts'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { deriveOpenRows, groupRows } from '../src/derive.ts'
import type { OpenRow, OtherRow } from '../src/derive.ts'
import { createGh } from '../src/github.ts'
import { createPoller } from '../src/poller.ts'
import type { Patch, Sync, View } from '../src/poller.ts'
import { formatAge, formatClock, formatDay, formatInterval, formatSince } from '../public/format.ts'
import {
  applyPatch, botGroupLabel, emptyFeed, openRows, receivePatch, receiveView, regroup, restartFeed, rowFreshness,
} from '../public/state.ts'
import type { Feed } from '../public/state.ts'
import { syncStatus } from '../public/status.ts'
import { scenario } from './fixtures/scenario.ts'
import { fakeTime, fixtureRunner, openPage1, openPage2 } from './helpers.ts'

const minute = 60_000

// no real reports folder is ever read: this home does not exist
const nowhere = '/nonexistent/pit-view-test-home'

const config = (): Config => ({ ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer })

// the real poller over the fixture gh, recording each patch and the view right after it
const harness = () => {
  const time = fakeTime()
  const cache = openCache({ path: ':memory:', clock: time.clock })
  const patches: Patch[] = []
  const views: View[] = []
  const poller = createPoller({
    cache,
    gh: createGh(fixtureRunner().runner),
    clock: time.clock,
    timers: time.timers,
    config,
    home: nowhere,
    timeZone: scenario.timeZone,
    emit: (patch) => {
      patches.push(patch)
      void poller.view().then((view) => views.push(view))
    },
    pageSize: scenario.pageSize,
  })
  return { time, poller, patches, views }
}

// Today runs to the server's now, which only a closed patch moves; everything else must match
const comparable = (view: View): unknown => ({ ...view, now: '', closed: { ...view.closed, today: { ...view.closed.today, to: '' } } })

const step = (feed: Feed, patch: Patch) => receivePatch(feed, patch).feed

const viewAt = (views: readonly View[], version: number): View => {
  const view = views.find((candidate) => candidate.version === version)
  assert.ok(view, `a view at version ${version}`)
  return view
}

test('a page that loaded before a cycle and applied every patch matches a fresh view, groups and order included', async () => {
  const { poller, patches } = harness()
  const before = await poller.view()
  assert.ok(before.mine.groups.every((group) => group.rows.length === 0))
  poller.setActive(1, true)
  await poller.idle()
  const final = await poller.view()
  const caught = patches.reduce(applyPatch, before)
  assert.deepEqual(comparable(caught), comparable(final))
  assert.equal(caught.now, patches[patches.length - 1]?.now)
  // the bots group holds dependabot and renovate, so it is labeled Bots
  assert.equal(caught.others.groups.find((group) => group.key === 'bots')?.label, 'Bots')
})

test('a page loading at any point mid-cycle drops the patches at or below its view and catches up', async () => {
  const { poller, patches, views } = harness()
  poller.setActive(1, true)
  await poller.idle()
  const final = await poller.view()
  for (const view of views) {
    // the stream was open from the start, so every patch is buffered when the view arrives
    const buffered = patches.reduce(step, emptyFeed())
    assert.equal(buffered.view, null)
    const result = receiveView(buffered, view)
    assert.equal(result.refetch, false)
    assert.equal(result.feed.awaiting, false)
    assert.deepEqual(result.feed.buffer, [])
    assert.deepEqual(comparable(result.feed.view!), comparable(final))
  }
})

test('patches at or below the view are dropped, the next one applies, and a gap asks for a refetch', async () => {
  const { poller, patches, views } = harness()
  poller.setActive(1, true)
  await poller.idle()
  assert.ok(patches.length >= 5)
  let feed = receiveView(emptyFeed(), viewAt(views, 1)).feed

  const old = receivePatch(feed, patches[0]!)
  assert.deepEqual([old.render, old.refetch], [false, false])
  assert.equal(old.feed, feed)

  const next = receivePatch(feed, patches[1]!)
  assert.deepEqual([next.render, next.refetch], [true, false])
  feed = next.feed
  assert.equal(feed.view?.version, 2)

  const gap = receivePatch(feed, patches[3]!)
  assert.deepEqual([gap.render, gap.refetch], [false, true])
  assert.equal(gap.feed.awaiting, true)
  // while the refetch is in flight, patches wait, and the old view stays shown
  const waiting = receivePatch(gap.feed, patches[4]!)
  assert.deepEqual([waiting.render, waiting.refetch], [false, false])
  assert.equal(waiting.feed.view?.version, 2)
  assert.deepEqual(waiting.feed.buffer.map((patch) => patch.version), [4, 5])
  const refetched = receiveView(waiting.feed, viewAt(views, 3))
  assert.equal(refetched.refetch, false)
  assert.equal(refetched.feed.view?.version, 5)
})

test('a gap inside the buffer refetches again, and a reconnect restarts from a fresh view', async () => {
  const { poller, patches, views } = harness()
  poller.setActive(1, true)
  await poller.idle()
  const holey = [patches[1]!, patches[3]!].reduce(step, emptyFeed())
  const result = receiveView(holey, viewAt(views, 1))
  assert.equal(result.refetch, true)
  assert.equal(result.feed.awaiting, true)
  assert.equal(result.feed.view?.version, 2)

  const live = receiveView(emptyFeed(), viewAt(views, patches.length)).feed
  const restarted = restartFeed(live)
  assert.equal(restarted.awaiting, true)
  assert.equal(restarted.view, live.view)
  // a restarted server counts from zero again, and its view is still the new base
  const reset = receiveView(restarted, { ...viewAt(views, 1), version: 0 })
  assert.equal(reset.feed.view?.version, 0)
  assert.equal(reset.feed.awaiting, false)
})

test('regrouping matches the server for every row set, and the bots label follows the bots present', async () => {
  const prs = [...(await openPage1()).data.repository!.pullRequests.nodes, ...(await openPage2()).data.repository!.pullRequests.nodes]
  const time = fakeTime()
  const rows = deriveOpenRows(prs, scenario.defaultBranch, { config: config(), clock: time.clock, timeZone: scenario.timeZone })
  const server = groupRows(rows)
  // shuffled input: the client sorts into attention order itself
  const shuffled = [...rows].reverse()
  assert.deepEqual(regroup(server, shuffled), server)

  const isBot = (row: OpenRow): boolean => row.section === 'others' && row.group === 'bots'
  const bots = rows.filter(isBot) as OtherRow[]
  assert.equal(botGroupLabel(bots), 'Bots')
  const oneBot = rows.filter((row) => !isBot(row) || row.author.login === bots[0]!.author.login)
  const regrouped = regroup(server, oneBot)
  assert.equal(regrouped.others.groups.find((group) => group.key === 'bots')?.label, bots[0]!.author.alias)
  assert.deepEqual(regrouped, groupRows(oneBot))
  // every group stays present, empty or not, in display order
  const empty = regroup(server, [])
  assert.deepEqual(empty.mine.groups.map((group) => group.key), ['changesRequested', 'readyToMerge', 'awaitingReview', 'drafts'])
  assert.deepEqual(empty.others.groups.map((group) => [group.key, group.rows.length]), [['yourMove', 0], ['readyToMerge', 0], ['waitingOnAuthor', 0], ['bots', 0]])
})

test('a row moving group or section, or removed, lands where its fields say', async () => {
  const { poller } = harness()
  poller.setActive(1, true)
  await poller.idle()
  const view = await poller.view()
  const row = openRows(view).find((candidate) => candidate.section === 'others' && candidate.group === 'yourMove') as OtherRow
  const moved: OtherRow = { ...row, group: 'readyToMerge' }
  const patched = applyPatch(view, { version: view.version + 1, now: view.now, rows: [moved], removed: [], closed: null })
  assert.ok(patched.others.groups.find((group) => group.key === 'readyToMerge')?.rows.some((candidate) => candidate.number === row.number))
  assert.ok(!patched.others.groups.find((group) => group.key === 'yourMove')?.rows.some((candidate) => candidate.number === row.number))
  const removed = applyPatch(patched, { version: patched.version + 1, now: view.now, rows: [], removed: [row.number], closed: null })
  assert.equal(openRows(removed).length, openRows(view).length - 1)
  assert.ok(!openRows(removed).some((candidate) => candidate.number === row.number))
  // a viewer change sends repo and viewer, and every other field keeps its value
  const viewer = { ...view.viewer, login: 'someone-else' }
  const renamed = applyPatch(view, { version: view.version + 1, now: view.now, rows: [], removed: [], closed: null, repo: 'other/repo', viewer })
  assert.equal(renamed.repo, 'other/repo')
  assert.equal(renamed.viewer.login, 'someone-else')
  assert.equal(renamed.tiles, view.tiles)
  assert.equal(renamed.closed, view.closed)
})

test('while a cycle runs, rows fetched before it started read as pending', () => {
  const fetchedAt = scenario.now
  const later = new Date(Date.parse(scenario.now) + minute).toISOString()
  const running = (startedAt: string): Pick<Sync, 'cycle'> => ({
    cycle: { id: 2, trigger: 'interval', state: 'running', startedAt, finishedAt: null, error: null, errorKind: null, prsUpdated: 0, prsTotal: null },
  })
  assert.equal(rowFreshness({ freshness: { state: 'current', fetchedAt } }, running(later)), 'pending')
  assert.equal(rowFreshness({ freshness: { state: 'stale', fetchedAt } }, running(later)), 'pending')
  assert.equal(rowFreshness({ freshness: { state: 'current', fetchedAt: later } }, running(later)), 'current')
  assert.equal(rowFreshness({ freshness: { state: 'current', fetchedAt } }, running(fetchedAt)), 'current')
  const finished = { cycle: { ...running(later).cycle!, state: 'failed' as const } }
  assert.equal(rowFreshness({ freshness: { state: 'stale', fetchedAt } }, finished), 'stale')
  assert.equal(rowFreshness({ freshness: { state: 'current', fetchedAt } }, { cycle: null }), 'current')
})

test('the sync status reads updated, refreshing or paused, and its key changes only per cycle edge or pause', async () => {
  const { poller, patches } = harness()
  const nowMs = Date.parse(scenario.now)
  const idle = (await poller.view()).sync
  assert.deepEqual(syncStatus(idle, { paused: false, nowMs }), { text: 'not updated yet · every 5m', tone: 'normal', key: '0:none:live' })
  poller.setActive(1, true)
  await poller.idle()
  const syncs = patches.flatMap((patch) => patch.sync === undefined ? [] : [patch.sync])
  const start = syncStatus(syncs[0]!, { paused: false, nowMs })
  assert.equal(start.text, 'refreshing…')
  const mid = syncs.find((sync) => sync.cycle?.state === 'running' && sync.cycle.prsTotal !== null)!
  const midStatus = syncStatus(mid, { paused: false, nowMs })
  assert.match(midStatus.text, /^refreshing · \d+ of 18$/)
  // progress changes the text but not the key, so the live region does not announce it
  assert.equal(midStatus.key, start.key)
  const end = syncs[syncs.length - 1]!
  assert.equal(syncStatus(end, { paused: false, nowMs: nowMs + 38_000 }).text, 'updated 38s ago · every 5m')
  assert.notEqual(syncStatus(end, { paused: false, nowMs }).key, start.key)
  const paused = syncStatus(end, { paused: true, nowMs: nowMs + 4 * minute })
  assert.deepEqual([paused.text, paused.tone], ['paused · updated 4m ago', 'warn'])
  assert.notEqual(paused.key, syncStatus(end, { paused: false, nowMs }).key)
  assert.equal(syncStatus(end, { paused: true, nowMs: nowMs + 3_000 }).text, 'paused · updated just now')
})

test('ages, intervals and times format as the page shows them', () => {
  const now = Date.parse('2026-10-27T14:05:38Z')
  assert.equal(formatAge('2026-10-27T13:31:38Z', now), '34m')
  assert.equal(formatAge('2026-10-26T22:05:38Z', now), '16h')
  assert.equal(formatAge('2026-10-23T14:05:38Z', now), '4d')
  assert.equal(formatAge('2026-10-27T15:00:00Z', now), '0m')
  assert.equal(formatSince('2026-10-27T14:05:00Z', now), '38s ago')
  assert.equal(formatSince('2026-10-27T14:01:38Z', now), '4m ago')
  assert.deepEqual([300, 120, 60, 90].map(formatInterval), ['5m', '2m', '1m', '90s'])
  assert.match(formatClock('2026-10-25T21:53:00Z'), /^\d{1,2}:\d{2} [AP]M$/)
  assert.match(formatClock('2026-10-25T21:53:00Z', true), /^[A-Z][a-z]{2} \d{1,2}:\d{2} [AP]M$/)
  assert.match(formatDay('2026-10-26T16:00:00Z'), /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}$/)
})
