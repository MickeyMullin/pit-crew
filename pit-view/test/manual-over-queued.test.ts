// test/manual-over-queued.test.ts
import assert from 'node:assert/strict'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { openCache } from '../src/cache.ts'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { createGh } from '../src/github.ts'
import type { RawOpenPr } from '../src/github.ts'
import { agentCell, createLauncher, createReviewLine, createSweepLauncher, LaunchError, startOptions } from '../src/launcher.ts'
import type { StartRequest } from '../src/launcher.ts'
import { sweepRequest } from '../src/sweeps.ts'
import { scenario } from './fixtures/scenario.ts'
import { fakeLaunch, fixtureRunner, fakeTime, openPage1, openPage2, quiet, tempDir, waitFor } from './helpers.ts'

// a manual start on a PR whose only in-flight run is an auto-review run still waiting in the scheduler's queue: section 8 of DESIGN.md, Launching runs, Concurrency, Over a queued auto-review run, and section 10, Scheduler. The launcher with both engines over one line, a real cache, and fake processes; the server route and the real scheduler are driven in test/manual-over-queued-server.test.ts

const replacesLine = 'This PR has an auto-review waiting in the queue. Starting now replaces it.'

const prOf = async (number: number): Promise<RawOpenPr> => {
  const nodes = [...(await openPage1()).data.repository!.pullRequests.nodes, ...(await openPage2()).data.repository!.pullRequests.nodes]
  const pr = nodes.find((entry) => entry.number === number)
  assert.ok(pr !== undefined, `fixture PR #${number}`)
  return pr
}

const baseConfig = (): Config => ({ ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit' })

const harness = async (config: Partial<Config> = {}) => {
  const temp = await tempDir()
  const home = await realpath(temp.dir)
  await mkdir(join(home, 'agents', 'output'), { recursive: true })
  await mkdir(join(home, 'agents', 'worktrees'), { recursive: true })
  const time = fakeTime()
  const cache = openCache({ path: ':memory:', clock: time.clock })
  const settings = { current: { ...baseConfig(), ...config } }
  const stateDir = join(home, '.local', 'state', 'pit-view')
  const launch = fakeLaunch()
  const gh = fixtureRunner()
  const options = {
    cache,
    gh: createGh(gh.runner),
    git: launch.deps.git,
    spawn: launch.deps.spawn,
    fs: launch.deps.fs,
    kill: launch.deps.kill,
    procs: launch.deps.procs,
    clock: time.clock,
    timers: time.timers,
    config: () => settings.current,
    home,
    stateDir,
    env: launch.deps.env,
    newSessionId: launch.deps.newSessionId,
    onWatch: () => {},
    onChange: () => {},
  }
  const line = createReviewLine({ config: options.config, timers: time.timers })
  const runs = createLauncher({ ...options, line })
  const sweeps = createSweepLauncher({ ...options, line })
  const cwd = join(home, 'dev', 'orbit')
  const cleanup = async (): Promise<void> => {
    runs.close()
    sweeps.close()
    cache.close()
    await temp.cleanup()
  }
  return { home, cwd, cache, runs, sweeps, line, settings, launch, cleanup }
}

type Harness = Awaited<ReturnType<typeof harness>>

const review = (number: number, patch: Partial<StartRequest> = {}): StartRequest =>
  ({ repo: scenario.repo, number, command: 'review-pr', args: [String(number)], label: 'Review', ...patch })

// the auto-review run the scheduler has queued for a PR, as its own tick leaves it: a queued row of origin auto
const queueAuto = (h: Harness, number: number) => {
  const request = review(number, { args: [String(number), '--no-post'] })
  const row = h.runs.queueScheduled(request, h.cwd, { tick: h.cache.createTick(scenario.repo).id, reason: 'new', headOid: 'abcdef0', posting: false })
  assert.equal(row.status, 'queued')
  assert.equal(row.origin, 'auto')
  return { row, request }
}

const startOrder = (h: Harness): number[] => h.launch.children.map((child) => Number(/\/review-pr (\d+) /.exec(child.writes[0] ?? '')?.[1]))

const refusedBusy = (error: unknown): boolean => error instanceof LaunchError && error.code === 'busy'

test('a manual start replaces the queued auto run when the cap has room: the auto run ends skipped as superseded, the manual run starts at once, and one process runs', async () => {
  const h = await harness({ maxConcurrentReviews: 2 })
  try {
    const { row } = queueAuto(h, 113)
    const run = await h.runs.start(review(113))
    assert.equal(run.status, 'running')
    assert.equal(run.origin, 'manual')
    assert.notEqual(run.id, row.id)
    assert.deepEqual(startOrder(h), [113])
    const ended = h.cache.getRun(row.id)
    assert.equal(ended?.status, 'skipped')
    assert.equal(ended?.note, 'superseded')
    assert.notEqual(ended?.finishedAt, null)
    assert.equal(ended?.origin, 'auto')
    // the PR's latest run is the manual one
    assert.equal(h.cache.runsFor(scenario.repo, 113, 1)[0]?.id, run.id)
    // the scheduler's own start of the superseded row finds nothing to start
    const again = await h.runs.startScheduled(row.id, review(113), { args: ['113'], posting: false }, async () => h.cwd)
    assert.equal(again?.status, 'skipped')
    assert.deepEqual(startOrder(h), [113])
  } finally {
    await h.cleanup()
  }
})

test('a manual start replaces the queued auto run when the cap is full: the manual run waits in the manual queue, behind what was queued before it, and the auto run ends superseded', async () => {
  const h = await harness({ maxConcurrentReviews: 1 })
  try {
    const first = await h.runs.start(review(118))
    const earlier = await h.runs.start(review(116))
    assert.equal(earlier.status, 'queued')
    const { row } = queueAuto(h, 113)
    const run = await h.runs.start(review(113))
    assert.equal(run.status, 'queued')
    assert.equal(run.origin, 'manual')
    assert.equal(h.cache.getRun(row.id)?.status, 'skipped')
    assert.equal(h.cache.getRun(row.id)?.note, 'superseded')
    assert.deepEqual(h.cache.queuedRuns().filter((entry) => entry.origin === 'manual').map((entry) => entry.id), [earlier.id, run.id])
    // the auto row never reaches the line: ending the first review starts the manual queue in order
    h.launch.children[0]!.exit(1)
    await h.runs.settled(first.id)
    await waitFor(() => h.launch.children.length === 2)
    assert.deepEqual(startOrder(h), [118, 116])
    h.launch.children[1]!.exit(1)
    await h.runs.settled(earlier.id)
    await waitFor(() => h.launch.children.length === 3)
    assert.deepEqual(startOrder(h), [118, 116, 113])
    assert.equal(h.cache.getRun(run.id)?.status, 'running')
  } finally {
    await h.cleanup()
  }
})

test('a manual start replaces a queued auto run whatever kind of manual review it is: a tandem review, a self-review, and a Fix session', async () => {
  const h = await harness({ maxConcurrentReviews: 5 })
  try {
    queueAuto(h, 113)
    const tandem = await h.runs.start(review(113, { args: ['113', '--tandem'], label: 'Tandem review', runner: 'claude' }))
    assert.equal(tandem.status, 'running')
    const { row } = queueAuto(h, 106)
    assert.equal(h.cache.getRun(row.id)?.status, 'queued')
    const fix = await h.runs.start({ repo: scenario.repo, number: 106, command: 'fix-pr', args: ['106'], label: 'Fix session', runner: 'claude' })
    assert.equal(fix.status, 'running')
    assert.equal(h.cache.getRun(row.id)?.note, 'superseded')
  } finally {
    await h.cleanup()
  }
})

test('a running auto run still blocks a manual start, and nothing changes', async () => {
  const h = await harness({ maxConcurrentReviews: 2 })
  try {
    const { row, request } = queueAuto(h, 113)
    const started = await h.runs.startScheduled(row.id, request, { args: request.args, posting: false }, async () => h.cwd)
    assert.equal(started?.status, 'running')
    await assert.rejects(h.runs.start(review(113)), refusedBusy)
    assert.equal(h.cache.getRun(row.id)?.status, 'running')
    assert.equal(h.cache.runsFor(scenario.repo, 113).length, 1)
    assert.equal(h.launch.children.length, 1)
  } finally {
    await h.cleanup()
  }
})

test('a manual run in flight still blocks another start, running or queued, and its auto predecessor stays superseded', async () => {
  const h = await harness({ maxConcurrentReviews: 1 })
  try {
    await h.runs.start(review(118))
    const { row } = queueAuto(h, 113)
    const queued = await h.runs.start(review(113))
    assert.equal(queued.status, 'queued')
    await assert.rejects(h.runs.start(review(113)), refusedBusy)
    h.launch.children[0]!.exit(1)
    await waitFor(() => h.launch.children.length === 2)
    assert.equal(h.cache.getRun(queued.id)?.status, 'running')
    await assert.rejects(h.runs.start(review(113)), refusedBusy)
    assert.equal(h.cache.runsFor(scenario.repo, 113).filter((entry) => entry.origin === 'manual').length, 1)
    assert.equal(h.cache.getRun(row.id)?.note, 'superseded')
  } finally {
    await h.cleanup()
  }
})

test('the superseded auto run is neither a failure nor a start: it has no failed status, no start time, and no hold on the PR', async () => {
  const h = await harness({ maxConcurrentReviews: 2 })
  try {
    const { row } = queueAuto(h, 113)
    await h.runs.start(review(113))
    const ended = h.cache.getRun(row.id)
    assert.equal(ended?.status, 'skipped')
    assert.notEqual(ended?.status, 'failed')
    assert.equal(h.cache.runningRuns().some((entry) => entry.id === row.id), false)
    assert.equal(h.cache.queuedRuns().some((entry) => entry.id === row.id), false)
  } finally {
    await h.cleanup()
  }
})

test('a start refused before it makes its row leaves the queued auto run queued: the supersede happens with the start, not with the ask', async () => {
  const h = await harness({ maxConcurrentReviews: 2 })
  try {
    const { row } = queueAuto(h, 113)
    h.settings.current = { ...h.settings.current, cloneDir: undefined }
    await assert.rejects(h.runs.start(review(113)))
    assert.equal(h.cache.getRun(row.id)?.status, 'queued')
    assert.equal(h.launch.children.length, 0)
  } finally {
    await h.cleanup()
  }
})

test('a queued auto sweep still holds its repository: a sweep start is refused as in flight', async () => {
  const h = await harness({ maxConcurrentReviews: 2 })
  try {
    const request = sweepRequest(scenario.repo)
    const queued = h.sweeps.queueScheduled(request, h.cwd, { tick: h.cache.createTick(scenario.repo).id, reason: 'dependabot', headOid: null, posting: false })
    assert.equal(queued.status, 'queued')
    await assert.rejects(h.sweeps.start(request), refusedBusy)
    assert.equal(h.cache.getSweep(queued.id)?.status, 'queued')
  } finally {
    await h.cleanup()
  }
})

// what the page is offered: startOptions through the Agent cell the server builds
const optionsFor = async (h: Harness, number: number) => {
  const pr = await prOf(number)
  const cell = agentCell(pr, h.settings.current, h.cache.runsFor(scenario.repo, number, 1)[0], undefined, null, h.runs.queueing(), undefined, h.cache.runsFor(scenario.repo, number))
  return cell.starts
}

test('startOptions offers every start for a PR whose only in-flight run is a queued auto run, each carrying the line that says the start replaces it', async () => {
  const h = await harness({ maxConcurrentReviews: 2 })
  try {
    queueAuto(h, 106)
    const starts = await optionsFor(h, 106)
    assert.ok(starts.length >= 2)
    for (const option of starts) {
      assert.equal(option.unavailable, null, option.kind)
      assert.equal(option.replaces, replacesLine, option.kind)
    }
  } finally {
    await h.cleanup()
  }
})

test('startOptions still marks every start unavailable for a running auto run and for a manual run in flight, and says nothing of replacing', async () => {
  const h = await harness({ maxConcurrentReviews: 2 })
  try {
    const { row, request } = queueAuto(h, 106)
    await h.runs.startScheduled(row.id, request, { args: request.args, posting: false }, async () => h.cwd)
    for (const option of await optionsFor(h, 106)) {
      assert.equal(option.unavailable, 'a run for #106 is already in flight', option.kind)
      assert.equal(option.replaces, undefined)
    }
    await h.runs.start(review(113))
    for (const option of await optionsFor(h, 113)) {
      assert.equal(option.unavailable, 'a run for #113 is already in flight', option.kind)
      assert.equal(option.replaces, undefined)
    }
  } finally {
    await h.cleanup()
  }
})

test('a start offered while nothing is in flight says nothing of replacing, and a manual run that is queued behind the cap is no auto run to replace', async () => {
  const h = await harness({ maxConcurrentReviews: 1 })
  try {
    for (const option of await optionsFor(h, 106)) {
      assert.equal(option.unavailable, null)
      assert.equal(option.replaces, undefined)
    }
    await h.runs.start(review(118))
    const queued = await h.runs.start(review(106))
    assert.equal(queued.status, 'queued')
    for (const option of await optionsFor(h, 106)) {
      assert.equal(option.unavailable, 'a run for #106 is already in flight')
      assert.equal(option.replaces, undefined)
    }
  } finally {
    await h.cleanup()
  }
})

test('startOptions called with the flag directly: replacing lifts the in-flight text and leaves a missing cloneDir as the reason', async () => {
  const pr = await prOf(106)
  const config = { ...baseConfig(), cloneDir: undefined }
  for (const option of startOptions(pr, config, null, false, null, [], true)) {
    assert.match(option.unavailable ?? '', /set cloneDir/)
  }
  for (const option of startOptions(pr, baseConfig(), null, false, null, [], true)) {
    assert.equal(option.unavailable, null)
    assert.equal(option.replaces, replacesLine)
  }
})

test('the launcher answers one place for a PR with a queued auto run: busy reports it as held while no manual start can read it as free in between', async () => {
  const h = await harness({ maxConcurrentReviews: 2 })
  try {
    queueAuto(h, 113)
    assert.equal(h.runs.busy({ repo: scenario.repo, number: 113 }), true)
    await h.runs.start(review(113))
    assert.equal(h.runs.busy({ repo: scenario.repo, number: 113 }), true)
    await quiet()
    assert.equal(h.cache.runsFor(scenario.repo, 113).filter((entry) => entry.status === 'queued').length, 0)
  } finally {
    await h.cleanup()
  }
})
