// test/notify.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openCache } from '../src/cache.ts'
import type { RunStatus } from '../src/cache.ts'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import type { OtherRow } from '../src/derive.ts'
import { createGh } from '../src/github.ts'
import type { RawOpenPr, RawOpenResponse } from '../src/github.ts'
import {
  appleScript, baselineOf, compareRows, createNotifier, noticeOf, notificationKinds, osascriptArgs, noRowState, rowEvents, rowState, runEvent, systemDeliver,
} from '../src/notify.ts'
import type { Exec, Notice, NotifyEvent } from '../src/notify.ts'
import { createPoller } from '../src/poller.ts'
import type { Patch } from '../src/poller.ts'
import { scenario } from './fixtures/scenario.ts'
import { closedSearch, failed, fakeRunner, fakeTime, field, ok, openPage1, openPage2, singlePr } from './helpers.ts'

const nowhere = '/nonexistent/pit-view-test-home'

// edits to the raw PRs of the next cycle, by PR number
type Edit = (pr: RawOpenPr, all: Map<number, RawOpenPr>) => RawOpenPr

const harness = async (config: Partial<Config> = {}) => {
  const time = fakeTime()
  const cache = openCache({ path: ':memory:', clock: time.clock })
  const events: NotifyEvent[] = []
  const state = { edits: new Map<number, Edit>(), fail: false, single: new Map<number, Edit>() }
  const base = new Map<number, RawOpenPr>()
  for (const raw of [await openPage1(), await openPage2()]) {
    for (const pr of raw.data.repository!.pullRequests.nodes) base.set(pr.number, pr)
  }
  const edited = (raw: RawOpenResponse, edits: Map<number, Edit>): RawOpenResponse => {
    const repository = raw.data.repository!
    const nodes = repository.pullRequests.nodes.map((pr) => edits.get(pr.number)?.(pr, base) ?? pr)
    return { data: { ...raw.data, repository: { ...repository, pullRequests: { ...repository.pullRequests, nodes } } } }
  }
  const runner = fakeRunner(async (args) => {
    if (args[0] === 'auth' && args[1] === 'token') return ok('gho_fixture_token\n')
    const query = field(args, 'query') ?? ''
    if (query.includes('query OpenPullRequests')) {
      if (field(args, 'after') === undefined) return ok(JSON.stringify(edited(await openPage1(), state.edits)))
      if (state.fail) return failed('HTTP 502')
      return ok(JSON.stringify(edited(await openPage2(), state.edits)))
    }
    if (query.includes('query ClosedPullRequests')) return ok(JSON.stringify(await closedSearch()))
    if (query.includes('query SinglePullRequest')) {
      const number = Number(field(args, 'number'))
      const single = await singlePr(number)
      const pr = single.data.repository!.pullRequest!
      const edit = state.single.get(number)
      return ok(JSON.stringify({ data: { ...single.data, repository: { ...single.data.repository!, pullRequest: edit === undefined ? pr : { ...edit(pr, base), state: 'OPEN' } } } }))
    }
    return failed(`no answer for gh ${args.join(' ')}`)
  })
  const settings = { current: { ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer, ...config } }
  const patches: Patch[] = []
  // a poller over the shared cache; a second one stands for a restarted server
  const build = (beforeCycle?: () => Promise<void>) => createPoller({
    cache,
    gh: createGh(runner.runner),
    clock: time.clock,
    timers: time.timers,
    config: () => settings.current,
    home: nowhere,
    timeZone: scenario.timeZone,
    emit: (patch) => patches.push(patch),
    pageSize: scenario.pageSize,
    notify: (found) => events.push(...found),
    beforeCycle,
  })
  const poller = build()
  // one finished cycle; the clock moves on so the next is its own
  const cycle = async (): Promise<NotifyEvent[]> => {
    const before = events.length
    poller.refresh('manual')
    await poller.idle()
    time.advance(60_000)
    return events.slice(before)
  }
  const cycleOf = async (other: ReturnType<typeof build>): Promise<NotifyEvent[]> => {
    const before = events.length
    other.refresh('manual')
    await other.idle()
    time.advance(60_000)
    return events.slice(before)
  }
  return { poller, build, cycleOf, cache, state, events, cycle, settings, time }
}

// 104 is mine and awaiting review; these turn it into each watched state
const asChangesRequested: Edit = (pr, all) => {
  const from = all.get(101)!
  return { ...pr, reviewDecision: from.reviewDecision, latestReviews: from.latestReviews, reviewRequests: from.reviewRequests, headRefOid: from.headRefOid, headCommit: from.headCommit, recentCommits: from.recentCommits }
}
// 102 is mine and ready; as a draft it is not
const asDraft: Edit = (pr) => ({ ...pr, isDraft: true })
// 113 is someone else's with no request; 109 asks the viewer
const asRequested: Edit = (pr, all) => ({ ...pr, reviewRequests: all.get(109)!.reviewRequests })
// 120 is mine; 109's head commit has failing checks
const asFailing: Edit = (pr, all) => ({ ...pr, headCommit: all.get(109)!.headCommit })

const only = (events: NotifyEvent[]): [string, number][] => events.map((event) => [event.kind, event.number])

const otherRepo = 'octo-example/elsewhere'

// a cached run of a PR in some repo, `startedAt` as an ISO time
const makeRun = (cache: ReturnType<typeof openCache>, repo: string, number: number, startedAt: string, status: RunStatus = 'running') =>
  cache.createRun({
    repo, number, command: 'review-pr', args: [String(number)], label: 'Review', runner: 'claude', cwd: '~/dev/orbit',
    sessionId: null, pid: null, pidStartedAt: null, startedAt, lastStepAt: null, step: null, stepState: null,
    finishedAt: status === 'running' ? null : startedAt, status, result: null, note: null, costUsd: null, resume: null,
  }, (id) => `~/runs/${id}`)

// a time before the poller's own start, and the present
const earlier = (time: { clock: { now: () => number } }): string => new Date(time.clock.now() - 3_600_000).toISOString()
const nowIso = (time: { clock: { now: () => number } }): string => new Date(time.clock.now()).toISOString()

test('the scenario rows have the states the edits below rely on', async () => {
  const { poller } = await harness()
  poller.refresh('manual')
  await poller.idle()
  const view = await poller.view()
  const rows = new Map([...view.mine.groups, ...view.others.groups].flatMap((group) => group.rows.map((row) => [row.number, rowState(row)] as const)))
  assert.equal(rows.get(101)?.changesRequested, true)
  assert.equal(rows.get(102)?.readyToMerge, true)
  assert.equal(rows.get(109)?.reviewRequested, true)
  assert.equal(rows.get(104)?.changesRequested, false)
  assert.equal(rows.get(113)?.reviewRequested, false)
  assert.equal(rows.get(120)?.ciFailing, false)
  poller.stop()
})

test('nothing fires for the first load, whatever the rows hold, and nothing fires for an unchanged cycle', async () => {
  const { cycle, poller } = await harness()
  assert.deepEqual(await cycle(), [])
  assert.deepEqual(await cycle(), [])
  poller.stop()
})

test('each kind fires once, when its condition turns true', async () => {
  const cases: [string, number, Edit, Edit | null][] = [
    ['changesRequested', 104, asChangesRequested, null],
    ['readyToMerge', 102, asDraft, null],
    ['reviewRequested', 113, asRequested, null],
    ['ciFailing', 120, asFailing, null],
  ]
  for (const [kind, number, edit] of cases) {
    const { cycle, poller, state } = await harness()
    // the first load holds the PR in the opposite state (a draft, for ready to merge)
    if (kind === 'readyToMerge') state.edits.set(number, asDraft)
    await cycle()
    if (kind === 'readyToMerge') state.edits.delete(number)
    else state.edits.set(number, edit)
    assert.deepEqual(only(await cycle()), [[kind, number]], kind)
    assert.deepEqual(await cycle(), [], `${kind} does not fire again`)
    poller.stop()
  }
})

test('a condition that turns off and on again fires on the way back, not on the way off', async () => {
  const { cycle, poller, state } = await harness()
  await cycle()
  state.edits.set(102, asDraft)
  assert.deepEqual(await cycle(), [])
  state.edits.delete(102)
  assert.deepEqual(only(await cycle()), [['readyToMerge', 102]])
  poller.stop()
})

test('a failed cycle fires nothing, and the next good one fires the transition once', async () => {
  const { cycle, poller, state } = await harness()
  await cycle()
  state.edits.set(113, asRequested)
  state.fail = true
  assert.deepEqual(await cycle(), [])
  state.fail = false
  assert.deepEqual(only(await cycle()), [['reviewRequested', 113]])
  assert.deepEqual(await cycle(), [])
  poller.stop()
})

test('a one-PR refresh fires the transition it finds, once', async () => {
  const { cycle, poller, state, events } = await harness()
  await cycle()
  state.single.set(113, asRequested)
  await poller.refreshPr(113)
  assert.deepEqual(only(events), [['reviewRequested', 113]])
  await poller.refreshPr(113)
  assert.deepEqual(only(events), [['reviewRequested', 113]])
  poller.stop()
})

test('a one-PR refresh during the first load fires nothing', async () => {
  const { poller, state, events } = await harness()
  state.single.set(113, asRequested)
  await poller.refreshPr(113)
  assert.deepEqual(events, [])
  poller.stop()
})

test('a PR with no previous state has no transition, and later changes to it fire', async () => {
  const { poller } = await harness()
  poller.refresh('manual')
  await poller.idle()
  const view = await poller.view()
  const rows = new Map([...view.mine.groups, ...view.others.groups].flatMap((group) => group.rows.map((row) => [row.number, row] as const)))
  const requested = rows.get(109)! as OtherRow
  const others = [...rows.values()].filter((row) => row.number !== 109)
  const baseline = baselineOf(scenario.repo, scenario.viewer, others, true)
  // 109 already requests a review but has no previous state: nothing fires, and its state is recorded
  assert.deepEqual(compareRows(baseline, rows), [])
  assert.deepEqual(compareRows(baseline, rows), [])
  const cleared = { ...requested, flags: requested.flags.filter((flag) => flag.kind !== 'requestedOfYou') }
  assert.deepEqual(compareRows(baseline, new Map([...rows, [109, cleared]])), [])
  assert.deepEqual(only(compareRows(baseline, rows)), [['reviewRequested', 109]])
  poller.stop()
})

test('an empty baseline stays silent until a nonempty one has been recorded', async () => {
  const { poller } = await harness()
  poller.refresh('manual')
  await poller.idle()
  const view = await poller.view()
  const rows = new Map([...view.mine.groups, ...view.others.groups].flatMap((group) => group.rows.map((row) => [row.number, row] as const)))
  const baseline = baselineOf(scenario.repo, scenario.viewer, [], true)
  assert.deepEqual(compareRows(baseline, new Map()), [])
  assert.deepEqual(compareRows(baseline, new Map()), [])
  // the first nonempty cycle is the baseline, and fires nothing
  assert.deepEqual(compareRows(baseline, rows), [])
  const requested = rows.get(113)! as OtherRow
  const asked = { ...requested, flags: [{ kind: 'requestedOfYou' as const, label: 'Requested of you' }] }
  assert.deepEqual(only(compareRows(baseline, new Map([...rows, [113, asked]]))), [['reviewRequested', 113]])
  poller.stop()
})

test('a baseline that becomes empty again is silent: a one-PR refresh fires nothing, and the next nonempty comparison is a baseline', async () => {
  const { poller } = await harness()
  poller.refresh('manual')
  await poller.idle()
  const view = await poller.view()
  const rows = new Map([...view.mine.groups, ...view.others.groups].flatMap((group) => group.rows.map((row) => [row.number, row] as const)))
  const baseline = baselineOf(scenario.repo, scenario.viewer, [...rows.values()], true)
  assert.deepEqual(compareRows(baseline, rows), [])
  // every row removed: the baseline is empty again
  assert.deepEqual(compareRows(baseline, new Map()), [])
  const unasked = rows.get(113)! as OtherRow
  assert.deepEqual(compareRows(baseline, new Map([[113, unasked]]), 113), [])
  const asked = { ...unasked, flags: [{ kind: 'requestedOfYou' as const, label: 'Requested of you' }] }
  assert.deepEqual(compareRows(baseline, new Map([...rows, [113, asked]])), [])
  assert.deepEqual(only(compareRows(baseline, new Map([...rows, [113, unasked]]))), [])
  assert.deepEqual(only(compareRows(baseline, new Map([...rows, [113, asked]]))), [['reviewRequested', 113]])
  poller.stop()
})

test('while the viewer is unresolved nothing compares, and the first comparison after resolution is a baseline', async () => {
  const { poller, build, cycleOf, cycle, settings, state } = await harness()
  await cycle()
  poller.stop()
  // a restarted server whose viewer is still unknown, and which learns it in beforeCycle
  settings.current = { ...settings.current, viewer: '' }
  const restarted = build(async () => { settings.current = { ...settings.current, viewer: scenario.viewer } })
  assert.deepEqual(await cycleOf(restarted), [])
  state.edits.set(113, asRequested)
  assert.deepEqual(only(await cycleOf(restarted)), [['reviewRequested', 113]])
  restarted.stop()
})

test('a viewer change rebuilds the baseline silently', async () => {
  const { poller, cycle, settings } = await harness({ viewer: 'someone-else' })
  await cycle()
  const before = settings.current
  settings.current = { ...before, viewer: scenario.viewer }
  await poller.configChanged(before)
  assert.deepEqual(await cycle(), [])
  poller.stop()
})

test('the delivery script is the constant on run argv handler and only displays a notification', () => {
  assert.deepEqual(appleScript, [
    'on run argv',
    'display notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv)',
    'end run',
  ])
  const script = appleScript.join('\n')
  assert.equal((script.match(/display notification/g) ?? []).length, 1)
  for (const word of ['open location', 'activate', 'URL', 'click', 'button', 'do shell script', 'tell ']) assert.equal(script.includes(word), false, word)
  // only title, subtitle, and body reach it, and no more, whatever the notice holds
  assert.equal(osascriptArgs(noticeOf(event('ciFailing'))).length, appleScript.length * 2 + 3)
})

test('a row marked stale reports nothing', async () => {
  const { poller } = await harness()
  poller.refresh('manual')
  await poller.idle()
  const view = await poller.view()
  const row = [...view.others.groups.flatMap((group) => group.rows)].find((candidate) => candidate.number === 109)!
  assert.deepEqual(only(rowEvents(scenario.repo, noRowState, row)), [['reviewRequested', 109]])
  assert.deepEqual(rowEvents(scenario.repo, noRowState, { ...row, freshness: { ...row.freshness, state: 'stale' } }), [])
  assert.deepEqual(rowEvents(scenario.repo, rowState(row), row), [])
  poller.stop()
})

// the launcher registers a run it created or adopted; the cache row stands for what it wrote
const watch = (poller: { runWatched: (run: { id: number, repo: string, number: number }) => void }, run: { id: number, repo: string, number: number }): void =>
  poller.runWatched({ id: run.id, repo: run.repo, number: run.number })

test('review session kinds fire when a watched run settles, and only then', async () => {
  const { cycle, poller, cache, events, time } = await harness()
  await cycle()
  const run = makeRun(cache, scenario.repo, 106, nowIso(time))
  watch(poller, run)
  poller.runChanged(scenario.repo, 106)
  assert.deepEqual(events, [])
  cache.updateRun(run.id, { status: 'needsInput' })
  poller.runChanged(scenario.repo, 106)
  assert.deepEqual(only(events), [['runNeedsInput', 106]])
  poller.runChanged(scenario.repo, 106)
  assert.equal(events.length, 1)
  poller.stop()
})

test('done and failed fire runFinished, and stopped fires nothing', async () => {
  const { cycle, poller, cache, events, time } = await harness()
  await cycle()
  for (const [number, status] of [[106, 'done'], [107, 'failed'], [108, 'stopped']] as const) {
    const run = makeRun(cache, scenario.repo, number, nowIso(time))
    watch(poller, run)
    cache.updateRun(run.id, { status, finishedAt: nowIso(time) })
    poller.runChanged(scenario.repo, number)
    poller.runChanged(scenario.repo, number)
  }
  assert.deepEqual(only(events), [['runFinished', 106], ['runFinished', 107]])
  poller.stop()
})

test('a run whose start fails synchronously fires runFinished once, even with the wall clock moved backward', async () => {
  const { cycle, poller, cache, events, time } = await harness()
  await cycle()
  // the clock steps back a week after the server started
  time.advance(-7 * 86_400_000)
  const run = makeRun(cache, scenario.repo, 106, nowIso(time))
  watch(poller, run)
  cache.updateRun(run.id, { status: 'failed', finishedAt: nowIso(time), note: 'spawnFailed: no such file' })
  poller.runChanged(scenario.repo, 106)
  assert.deepEqual(only(events), [['runFinished', 106]])
  poller.runChanged(scenario.repo, 106)
  assert.equal(events.length, 1)
  poller.stop()
})

test('an old settled run first seen after a forward clock correction or a restart is history and fires nothing', async () => {
  const { cycle, poller, cache, events, time } = await harness()
  await cycle()
  // a run settled before this process, stamped in the future of a clock that has since been corrected
  const old = makeRun(cache, scenario.repo, 106, new Date(time.clock.now() + 3_600_000).toISOString(), 'failed')
  time.advance(7_200_000)
  poller.runChanged(scenario.repo, 106)
  assert.equal(old.status, 'failed')
  const stale = makeRun(cache, scenario.repo, 107, earlier(time), 'needsInput')
  poller.runChanged(scenario.repo, 107)
  assert.equal(stale.status, 'needsInput')
  assert.deepEqual(events, [])
  poller.stop()
})

test('a run in the new repository that settles while the asynchronous configChanged is pending fires once', async () => {
  const { cycle, poller, cache, events, settings, time } = await harness()
  await cycle()
  const before = settings.current
  // the config changes first; the scan inside configChanged has not finished
  settings.current = { ...before, repo: otherRepo }
  const pending = poller.configChanged(before)
  const run = makeRun(cache, otherRepo, 7, nowIso(time), 'failed')
  watch(poller, run)
  poller.runChanged(otherRepo, 7)
  assert.deepEqual(only(events), [['runFinished', 7]])
  await pending
  poller.runChanged(otherRepo, 7)
  assert.deepEqual(only(events), [['runFinished', 7]])
  poller.stop()
})

test('a run settling while another repository is in effect fires nothing, then or later', async () => {
  const { cycle, poller, cache, events, settings, time } = await harness()
  await cycle()
  const run = makeRun(cache, scenario.repo, 106, nowIso(time))
  watch(poller, run)
  const before = settings.current
  settings.current = { ...before, repo: otherRepo }
  await poller.configChanged(before)
  cache.updateRun(run.id, { status: 'done', finishedAt: nowIso(time) })
  poller.runChanged(scenario.repo, 106)
  // switching back finds the run settled, and it is not announced late
  const back = settings.current
  settings.current = before
  await poller.configChanged(back)
  poller.runChanged(scenario.repo, 106)
  assert.deepEqual(events, [])
  poller.stop()
})

test('settled history is silent at a repository switch and on every later callback', async () => {
  const { cycle, poller, cache, events, settings, time } = await harness()
  await cycle()
  makeRun(cache, otherRepo, 7, earlier(time), 'done')
  makeRun(cache, otherRepo, 8, earlier(time), 'needsInput')
  const before = settings.current
  settings.current = { ...before, repo: otherRepo }
  await poller.configChanged(before)
  for (const number of [7, 8]) {
    poller.runChanged(otherRepo, number)
    poller.runChanged(otherRepo, number)
  }
  await poller.configChanged(settings.current)
  poller.runChanged(otherRepo, 7)
  assert.deepEqual(events, [])
  poller.stop()
})

test('a run watched at startup notifies once when it settles, and history at startup is silent', async () => {
  const time = fakeTime()
  const cache = openCache({ path: ':memory:', clock: time.clock })
  const settled = makeRun(cache, scenario.repo, 106, earlier(time), 'failed')
  const waiting = makeRun(cache, scenario.repo, 107, earlier(time), 'needsInput')
  const recovered = makeRun(cache, scenario.repo, 108, earlier(time))
  const events: NotifyEvent[] = []
  const poller = createPoller({
    cache,
    gh: createGh(fakeRunner(async () => failed('no gh')).runner),
    clock: time.clock,
    timers: time.timers,
    config: () => ({ ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer }),
    home: nowhere,
    timeZone: scenario.timeZone,
    emit: () => {},
    notify: (found) => events.push(...found),
  })
  // recovery adopts only the run that was still running, then reports all it found
  watch(poller, recovered)
  poller.runChanged(scenario.repo, 106)
  poller.runChanged(scenario.repo, 107)
  poller.runChanged(scenario.repo, 108)
  assert.deepEqual(events, [])
  cache.updateRun(recovered.id, { status: 'needsInput' })
  poller.runChanged(scenario.repo, 108)
  poller.runChanged(scenario.repo, 108)
  assert.deepEqual(only(events), [['runNeedsInput', 108]])
  assert.equal(settled.status, 'failed')
  assert.equal(waiting.status, 'needsInput')
  poller.stop()
})

test('a run settling after its PR left the open rows still notifies, by number alone', async () => {
  const { cycle, poller, cache, events, state, time } = await harness()
  await cycle()
  const run = makeRun(cache, scenario.repo, 106, nowIso(time))
  watch(poller, run)
  poller.runChanged(scenario.repo, 106)
  // the PR leaves the open rows before the run settles
  state.edits.set(106, (pr) => ({ ...pr, number: 9999 }))
  await cycle()
  const left = await poller.view()
  assert.equal([...left.mine.groups, ...left.others.groups].some((group) => group.rows.some((row) => row.number === 106)), false)
  cache.updateRun(run.id, { status: 'done', finishedAt: nowIso(time) })
  poller.runChanged(scenario.repo, 106)
  const fired = events.filter((found) => found.kind === 'runFinished')
  assert.equal(fired.length, 1)
  assert.equal(fired[0]?.number, 106)
  assert.equal(fired[0]?.title, null)
  assert.equal(noticeOf(fired[0]!).body, '#106')
  poller.runChanged(scenario.repo, 106)
  assert.equal(events.filter((found) => found.kind === 'runFinished').length, 1)
  poller.stop()
})

test('runEvent maps a settled status to its kind, and stopped and running to nothing', () => {
  const row: { number: number, title: string | null } = { number: 106, title: 'Fix the thing' }
  assert.equal(runEvent(scenario.repo, row, 'done')?.kind, 'runFinished')
  assert.equal(runEvent(scenario.repo, row, 'failed')?.kind, 'runFinished')
  assert.equal(runEvent(scenario.repo, row, 'needsInput')?.kind, 'runNeedsInput')
  assert.equal(runEvent(scenario.repo, row, 'stopped'), null)
  assert.equal(runEvent(scenario.repo, row, 'running'), null)
  assert.equal(runEvent(scenario.repo, { number: 106, title: null }, 'done')?.title, null)
})

const event = (kind: NotifyEvent['kind']): NotifyEvent => ({ kind, number: 7, title: 'Title', repo: scenario.repo })

test('the notifier delivers nothing when notifications are absent or disabled', () => {
  const delivered: Notice[] = []
  for (const notifications of [undefined, { enabled: false, kinds: [...notificationKinds] }]) {
    createNotifier({ config: () => ({ notifications }), deliver: async (notice) => void delivered.push(notice), log: () => {} }).send([event('readyToMerge')])
  }
  assert.deepEqual(delivered, [])
})

test('the notifier delivers only the kinds the config lists', async () => {
  const delivered: Notice[] = []
  const { send } = createNotifier({
    config: () => ({ notifications: { enabled: true, kinds: ['readyToMerge', 'ciFailing'] } }),
    deliver: async (notice) => void delivered.push(notice),
    log: () => {},
  })
  send([event('changesRequested'), event('readyToMerge'), event('reviewRequested'), event('ciFailing'), event('runFinished')])
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(delivered.map((notice) => notice.subtitle), ['Your PR is ready to merge', 'CI is failing on your PR'])
})

test('a delivery that throws or rejects is logged and never reaches the caller', async () => {
  const logs: string[] = []
  const { send } = createNotifier({
    config: () => ({ notifications: { enabled: true, kinds: ['readyToMerge'] } }),
    deliver: () => { throw new Error('no display') },
    log: (line) => logs.push(line),
  })
  send([event('readyToMerge')])
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(logs[0] ?? '', /cannot deliver readyToMerge for #7: no display/)
})

test('a PR title with quotes, backslashes, and newlines reaches osascript only as an argument', async () => {
  const hostile = 'Say "hi" \\" & do shell script "touch x"\n-e display dialog \'x\' \\\\'
  const calls: [string, string[]][] = []
  const exec: Exec = async (file, args) => void calls.push([file, args])
  await systemDeliver('darwin', exec)(noticeOf({ ...event('changesRequested'), title: hostile }))
  assert.equal(calls.length, 1)
  const [file, args] = calls[0]!
  assert.equal(file, 'osascript')
  // the script is the constant lines, and the three texts follow as arguments
  assert.deepEqual(args.slice(0, appleScript.length * 2), appleScript.flatMap((line) => ['-e', line]))
  assert.equal(args.length, appleScript.length * 2 + 3)
  assert.equal(args.slice(0, appleScript.length * 2).join('\n').includes('touch'), false)
  const body = args[args.length - 1]!
  assert.equal(body.startsWith('#7 Say "hi" \\" & do shell script "touch x" -e display dialog'), true)
  assert.equal(/[\n\r]/.test(body), false)
  assert.equal(body.endsWith('\\\\'), true)
})

test('notice text is bounded and starts with a character that is never an option', () => {
  const notice = noticeOf({ ...event('ciFailing'), title: 'x'.repeat(500) })
  assert.equal(notice.body.length, 200)
  assert.equal(notice.body.startsWith('#7 '), true)
  assert.equal(notice.title.startsWith('-'), false)
  assert.deepEqual(osascriptArgs(notice).slice(-3), [notice.title, notice.subtitle, notice.body])
})

test('a notice for a PR without a title is its number alone', () => {
  assert.equal(noticeOf({ ...event('runFinished'), title: null }).body, '#7')
})

test('other platforms deliver nothing', async () => {
  const calls: unknown[] = []
  for (const platform of ['linux', 'win32']) await systemDeliver(platform, async () => void calls.push(platform))(noticeOf(event('readyToMerge')))
  assert.deepEqual(calls, [])
})
