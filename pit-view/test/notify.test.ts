// test/notify.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openCache } from '../src/cache.ts'
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
  const poller = createPoller({
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
  })
  // one finished cycle; the clock moves on so the next is its own
  const cycle = async (): Promise<NotifyEvent[]> => {
    const before = events.length
    poller.refresh('manual')
    await poller.idle()
    time.advance(60_000)
    return events.slice(before)
  }
  return { poller, cache, state, events, cycle, settings, time }
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
  const baseline = baselineOf(scenario.repo, others, true)
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
  const baseline = baselineOf(scenario.repo, [], true)
  assert.deepEqual(compareRows(baseline, new Map()), [])
  assert.deepEqual(compareRows(baseline, new Map()), [])
  // the first nonempty cycle is the baseline, and fires nothing
  assert.deepEqual(compareRows(baseline, rows), [])
  const requested = rows.get(113)! as OtherRow
  const asked = { ...requested, flags: [{ kind: 'requestedOfYou' as const, label: 'Requested of you' }] }
  assert.deepEqual(only(compareRows(baseline, new Map([...rows, [113, asked]]))), [['reviewRequested', 113]])
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
  // only title, subtitle and body reach it, and no more, whatever the notice holds
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

test('review session kinds fire when a run that was running settles, and only then', async () => {
  const { cycle, poller, cache, events } = await harness()
  await cycle()
  const run = cache.createRun({
    repo: scenario.repo, number: 106, command: 'review-pr', args: ['106'], label: 'Review', runner: 'claude', cwd: '~/dev/orbit',
    sessionId: null, pid: null, pidStartedAt: null, startedAt: '2026-10-26T14:00:00Z', lastStepAt: null, step: null, stepState: null,
    finishedAt: null, status: 'running', result: null, note: null, costUsd: null, resume: null,
  }, (id) => `~/runs/${id}`)
  poller.runChanged(scenario.repo, 106)
  assert.deepEqual(events, [])
  cache.updateRun(run.id, { status: 'needsInput' })
  poller.runChanged(scenario.repo, 106)
  assert.deepEqual(only(events), [['runNeedsInput', 106]])
  poller.runChanged(scenario.repo, 106)
  assert.equal(events.length, 1)
  poller.stop()
})

test('a run whose start fails before it is ever running still fires runFinished once', async () => {
  const { cycle, poller, cache, events } = await harness()
  await cycle()
  const run = cache.createRun({
    repo: scenario.repo, number: 106, command: 'review-pr', args: ['106'], label: 'Review', runner: 'claude', cwd: '~/dev/orbit',
    sessionId: null, pid: null, pidStartedAt: null, startedAt: '2026-10-26T14:00:00Z', lastStepAt: null, step: null, stepState: null,
    finishedAt: null, status: 'running', result: null, note: null, costUsd: null, resume: null,
  }, (id) => `~/runs/${id}`)
  cache.updateRun(run.id, { status: 'failed', finishedAt: '2026-10-26T14:00:01Z', note: 'spawnFailed: no such file' })
  poller.runChanged(scenario.repo, 106)
  assert.deepEqual(only(events), [['runFinished', 106]])
  poller.runChanged(scenario.repo, 106)
  assert.equal(events.length, 1)
  poller.stop()
})

test('runEvent needs a running run of the same id to settle', () => {
  const running = { runId: 3, status: 'running' }
  const row = { number: 106, title: 'Fix the thing' }
  assert.equal(runEvent(scenario.repo, row, running, { runId: 3, status: 'done' })?.kind, 'runFinished')
  assert.equal(runEvent(scenario.repo, row, running, { runId: 3, status: 'failed' })?.kind, 'runFinished')
  assert.equal(runEvent(scenario.repo, row, running, { runId: 3, status: 'needsInput' })?.kind, 'runNeedsInput')
  assert.equal(runEvent(scenario.repo, row, running, { runId: 3, status: 'stopped' }), null)
  assert.equal(runEvent(scenario.repo, row, running, { runId: 3, status: 'running' }), null)
  // a run never seen running (its start failed first) still reports how it settled, once
  assert.equal(runEvent(scenario.repo, row, undefined, { runId: 3, status: 'failed' })?.kind, 'runFinished')
  assert.equal(runEvent(scenario.repo, row, running, { runId: 4, status: 'failed' })?.kind, 'runFinished')
  assert.equal(runEvent(scenario.repo, row, undefined, { runId: 3, status: 'stopped' }), null)
  assert.equal(runEvent(scenario.repo, row, undefined, { runId: 3, status: 'running' }), null)
  assert.equal(runEvent(scenario.repo, row, { runId: 3, status: 'done' }, { runId: 3, status: 'done' }), null)
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

test('a PR title with quotes, backslashes and newlines reaches osascript only as an argument', async () => {
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

test('other platforms deliver nothing', async () => {
  const calls: unknown[] = []
  for (const platform of ['linux', 'win32']) await systemDeliver(platform, async () => void calls.push(platform))(noticeOf(event('readyToMerge')))
  assert.deepEqual(calls, [])
})
