// test/jump.test.ts
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { openCache } from '../src/cache.ts'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { markedStack } from '../src/derive.ts'
import { createGh } from '../src/github.ts'
import type { RawOpenPr } from '../src/github.ts'
import { agentCell, createLauncher, createReviewLine, createSweepLauncher, LaunchError, startOptions, updateRequest } from '../src/launcher.ts'
import type { StartRequest } from '../src/launcher.ts'
import { createSweepMemory, sweepRequest, sweepsView } from '../src/sweeps.ts'
import { scenario } from './fixtures/scenario.ts'
import { fakeLaunch, fixtureRunner, fakeTime, openPage1, openPage2, quiet, tempDir, waitFor } from './helpers.ts'

// Start immediately (jump queue): section 8 of DESIGN.md, Launching runs, Review cap, Start immediately, and section 10, Scheduler, Past the cap

const jumpButton = 'Start immediately (jump queue)'

const prOf = async (number: number): Promise<RawOpenPr> => {
  const nodes = [...(await openPage1()).data.repository!.pullRequests.nodes, ...(await openPage2()).data.repository!.pullRequests.nodes]
  const pr = nodes.find((entry) => entry.number === number)
  assert.ok(pr !== undefined, `fixture PR #${number}`)
  return pr
}

const baseConfig = (): Config => ({ ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit' })

// the review engine and the sweep engine over one line, as the server makes them, with fake processes and a real temp folder
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
  const requestFile = async (id: number): Promise<Record<string, unknown>> => JSON.parse(await readFile(join(stateDir, 'runs', String(id), 'request.json'), 'utf8')) as Record<string, unknown>
  const cleanup = async (): Promise<void> => {
    runs.close()
    sweeps.close()
    cache.close()
    await temp.cleanup()
  }
  return { home, cache, runs, sweeps, line, settings, launch, gh, requestFile, cleanup }
}

type Harness = Awaited<ReturnType<typeof harness>>

const review = (number: number, patch: Partial<StartRequest> = {}): StartRequest =>
  ({ repo: scenario.repo, number, command: 'review-pr', args: [String(number)], label: 'Review', ...patch })

// what the runner was asked, in the order the processes started: a review's PR number, or sweep
const startOrder = (h: Harness): (number | 'sweep')[] => h.launch.children.map((child) => {
  const text = child.writes[0] ?? ''
  if (text.includes('/review-dependabot-sweep ')) return 'sweep'
  return Number(/\/review-(?:pr|stack) (\d+) /.exec(text)?.[1])
})

// every review the owner starts by hand, as its start request reaches the launcher; the self-review's PR is the viewer's own in the cache
const kinds: Array<[string, number, (h: Harness) => Promise<StartRequest>]> = [
  ['a review', 113, async () => review(113)],
  ['a re-review', 106, async () => review(106, { label: 'Re-review' })],
  ['a self-review', 104, async (h) => {
    h.cache.writePr(scenario.repo, await prOf(104), scenario.defaultBranch)
    return review(104, { args: ['104', '--no-post'], label: 'Self-review' })
  }],
  ['a tandem review', 113, async () => review(113, { args: ['113', '--tandem'], label: 'Tandem review', runner: 'claude' })],
  ['a stack review', 111, async () => review(111, { command: 'review-stack', args: ['111'], label: 'Review stack' })],
]

// the situations a jump meets: what is in flight and queued before it, the cap, and whether the ordinary start would wait
type Situation = { name: string, cap: number, waits: boolean, setUp: (h: Harness) => Promise<void> }
const situations: Situation[] = [
  {
    name: 'the cap full with a running sweep',
    cap: 1,
    waits: true,
    setUp: async (h) => {
      assert.equal((await h.sweeps.start(sweepRequest(scenario.repo))).status, 'running')
    },
  },
  {
    name: 'the cap full with a running review',
    cap: 1,
    waits: true,
    setUp: async (h) => {
      assert.equal((await h.runs.start(review(118))).status, 'running')
    },
  },
  {
    name: 'the cap with room and nothing queued',
    cap: 2,
    waits: false,
    setUp: async () => {},
  },
  {
    name: 'a queue that is not empty while the cap has room',
    cap: 1,
    waits: true,
    setUp: async (h) => {
      assert.equal((await h.runs.start(review(118))).status, 'running')
      assert.equal((await h.runs.start(review(116))).status, 'queued')
      // a raised cap that nothing has read yet: room under it, and the queue still holds #116
      h.settings.current = { ...h.settings.current, maxConcurrentReviews: 2 }
    },
  },
]

for (const [kindName, number, requestOf] of kinds) {
  for (const situation of situations) {
    test(`a jump of ${kindName} with ${situation.name}: ${situation.waits ? 'it starts at once, ahead of the queue, and is recorded as started ahead of it' : 'the flag changes nothing and the start is the ordinary one'}`, async () => {
      const h = await harness({ maxConcurrentReviews: situation.cap })
      try {
        await situation.setUp(h)
        const before = h.launch.children.length
        const queuedBefore = h.cache.queuedRuns().map((run) => run.id)
        const asked = await requestOf(h)
        // the launcher's own answer, the one the Queue label reads, says whether the ordinary start would wait
        const slot = number === 104 ? 'selfReview' : 'review'
        assert.equal(h.runs.queueing()[slot], situation.waits)
        const run = await h.runs.start({ ...asked, jump: true })
        // either way it starts at once: its process is spawned before the start returns
        assert.equal(run.status, 'running')
        assert.equal(h.launch.children.length, before + 1)
        assert.equal(startOrder(h).at(-1), number)
        // recorded on its row, in its request.json, and in what the API serves, only when the ordinary start would have waited
        assert.equal(run.jumped, situation.waits)
        assert.equal(h.cache.getRun(run.id)?.jumped, situation.waits)
        assert.equal((await h.requestFile(run.id)).jumped, situation.waits ? true : undefined)
        // the queued entries are where they were: still queued, in the same order
        assert.deepEqual(h.cache.queuedRuns().map((entry) => entry.id), queuedBefore)
        await quiet()
        assert.deepEqual(h.cache.queuedRuns().map((entry) => entry.id), queuedBefore)
        // it takes a slot like any other, so the count may now be above the cap, and a new review waits
        assert.equal(h.line.inFlight().length, before + 1)
        assert.equal(h.runs.queueing().review, situation.waits)
      } finally {
        await h.cleanup()
      }
    })
  }
}

test('a jump past a full cap holds every queued review until the count is below the cap, and they then start in the order they were queued', async () => {
  const h = await harness({ maxConcurrentReviews: 1 })
  try {
    const first = await h.runs.start(review(118))
    const earlier = await h.runs.start(review(116))
    const later = await h.runs.start(review(109))
    const jumped = await h.runs.start(review(113, { jump: true }))
    assert.deepEqual([first.status, earlier.status, later.status, jumped.status], ['running', 'queued', 'queued', 'running'])
    assert.deepEqual(startOrder(h), [118, 113])
    assert.equal(h.line.inFlight().length, 2)
    // the first review ends: one review is still running, which is the cap, so nothing queued starts
    h.launch.children[0]!.exit(1)
    await h.runs.settled(first.id)
    await quiet()
    assert.deepEqual(startOrder(h), [118, 113])
    assert.deepEqual([h.cache.getRun(earlier.id)?.status, h.cache.getRun(later.id)?.status], ['queued', 'queued'])
    // the jump ends and releases its slot as any review does: the count is below the cap, so the earliest queued review starts, and only it
    h.launch.children[1]!.exit(1)
    await h.runs.settled(jumped.id)
    await waitFor(() => h.launch.children.length === 3)
    await quiet()
    assert.deepEqual(startOrder(h), [118, 113, 116])
    assert.equal(h.cache.getRun(later.id)?.status, 'queued')
    // the reviews that started from the queue were not jumps
    assert.equal(h.cache.getRun(earlier.id)?.jumped, false)
    h.launch.children[2]!.exit(1)
    await h.runs.settled(earlier.id)
    await waitFor(() => h.launch.children.length === 4)
    assert.deepEqual(startOrder(h), [118, 113, 116, 109])
  } finally {
    await h.cleanup()
  }
})

test('while a jump keeps the count above the cap no queued sweep starts, and a new sweep or review waits', async () => {
  const h = await harness({ maxConcurrentReviews: 1 })
  try {
    const first = await h.runs.start(review(118))
    const sweep = await h.sweeps.start(sweepRequest(scenario.repo))
    assert.equal(sweep.status, 'queued')
    await h.runs.start(review(113, { jump: true }))
    h.launch.children[0]!.exit(1)
    await h.runs.settled(first.id)
    await quiet()
    assert.equal(h.cache.getSweep(sweep.id)?.status, 'queued')
    assert.equal(h.runs.queueing().review, true)
    assert.equal((await h.runs.start(review(109))).status, 'queued')
    assert.deepEqual(startOrder(h), [118, 113])
  } finally {
    await h.cleanup()
  }
})

test('a scheduled start never jumps: while a jump holds the count above the cap it stays queued in its own table, and a jump flag on its request changes nothing', async () => {
  const h = await harness({ maxConcurrentReviews: 1 })
  try {
    await h.runs.start(review(118))
    await h.runs.start(review(113, { jump: true }))
    const scheduled = review(106, { args: ['106', '--no-post'], jump: true })
    const cwd = join(h.home, 'dev', 'orbit')
    const queued = h.runs.queueScheduled(scheduled, cwd, { tick: h.cache.createTick(scenario.repo).id, reason: 'new', headOid: 'abcdef0', posting: false })
    assert.equal(queued.jumped, false)
    let prepared = 0
    const answer = await h.runs.startScheduled(queued.id, scheduled, { args: scheduled.args, posting: false }, async () => {
      prepared += 1
      return cwd
    })
    assert.equal(answer?.status, 'queued')
    assert.equal(prepared, 0)
    assert.deepEqual(startOrder(h), [118, 113])
    assert.equal(h.cache.getRun(queued.id)?.jumped, false)
  } finally {
    await h.cleanup()
  }
})

test('a sweep, a Fix session, and an Update session never jump: a start that asks for it is refused and nothing starts', async () => {
  const h = await harness({ maxConcurrentReviews: 1 })
  try {
    await h.runs.start(review(118))
    await assert.rejects(h.sweeps.start({ ...sweepRequest(scenario.repo), jump: true }), (error: unknown) => error instanceof LaunchError && error.code === 'notJumpable')
    await assert.rejects(h.runs.start({ repo: scenario.repo, number: 101, command: 'fix-pr', args: ['101'], label: 'Fix session', runner: 'claude', jump: true }), (error: unknown) => error instanceof LaunchError && error.code === 'notJumpable')
    await assert.rejects(h.runs.start({ ...updateRequest(scenario.repo, 101, 'a'.repeat(40)), jump: true }), (error: unknown) => error instanceof LaunchError && error.code === 'notJumpable')
    assert.deepEqual(startOrder(h), [118])
    assert.deepEqual(h.cache.sweepsFor(scenario.repo), [])
    assert.deepEqual(h.cache.runsFor(scenario.repo, 101), [])
  } finally {
    await h.cleanup()
  }
})

test('a jump that fails to start gives its slot back, and the queue moves as if it had never been asked for', async () => {
  const h = await harness({ maxConcurrentReviews: 1 })
  try {
    const first = await h.runs.start(review(118))
    const queued = await h.runs.start(review(116))
    h.launch.spawnError = new Error('spawn claude ENOENT')
    const failed = await h.runs.start(review(113, { jump: true }))
    h.launch.spawnError = null
    assert.equal(failed.status, 'failed')
    assert.match(failed.note ?? '', /^spawnFailed: spawn claude ENOENT/)
    assert.equal(h.line.inFlight().length, 1)
    h.launch.children[0]!.exit(1)
    await h.runs.settled(first.id)
    await waitFor(() => h.launch.children.length === 2)
    assert.deepEqual(startOrder(h), [118, 116])
    assert.equal(h.cache.getRun(queued.id)?.status, 'running')
  } finally {
    await h.cleanup()
  }
})

test('a stopped jump gives its slot back like any review, and the next in line starts once the count is below the cap', async () => {
  const h = await harness({ maxConcurrentReviews: 1 })
  try {
    const first = await h.runs.start(review(118))
    const queued = await h.runs.start(review(116))
    const jumped = await h.runs.start(review(113, { jump: true }))
    h.launch.children[0]!.exit(1)
    await h.runs.settled(first.id)
    await quiet()
    assert.equal(h.cache.getRun(queued.id)?.status, 'queued')
    const settled = h.runs.settled(jumped.id)
    h.runs.stop(jumped.id)
    assert.equal((await settled).status, 'stopped')
    await waitFor(() => h.launch.children.length === 3)
    assert.deepEqual(startOrder(h), [118, 113, 116])
  } finally {
    await h.cleanup()
  }
})

// the start options: the drawer offers the jump only where the ordinary start would wait

const waitsAll = { review: true, selfReview: true, running: 2 }
const roomAll = { review: false, selfReview: false, running: 0 }

test('every review start a PR offers carries the jump while it would wait, naming the count it will make against the cap, and a Fix session never does', async () => {
  const config = { ...baseConfig(), maxConcurrentReviews: 2 }
  const over = { button: jumpButton, text: 'This review starts now, ahead of the queue, and 3 reviews will be running, above the review cap (3 running, cap 2). Nothing else starts until the count falls below the cap.' }
  // a review and its tandem, a re-review, a self-review and its tandem, and a stack review
  for (const number of [113, 106, 104, 111]) {
    const pr = await prOf(number)
    const stack = markedStack(pr)
    assert.equal(stack !== null, number === 111)
    const options = startOptions(pr, config, stack, false, waitsAll)
    const reviews = options.filter((option) => option.kind !== 'fix' && option.kind !== 'relevancy')
    assert.ok(reviews.length >= 1)
    for (const option of reviews) assert.deepEqual(option.jump, over, `#${number} ${option.kind}`)
    // a relevancy check is no review, so it stands in no line and is never held by the cap
    const relevancy = options.find((option) => option.kind === 'relevancy')
    assert.equal(relevancy !== undefined, pr.author?.login === 'vera-quill', `#${number} offers the check on the viewer's own PRs alone`)
    assert.equal(relevancy?.jump, undefined)
  }
  // #101 is the viewer's own with a change request standing, so it offers a Fix session, which stands in no line
  const fix = startOptions(await prOf(101), config, null, false, waitsAll).find((option) => option.kind === 'fix')
  assert.ok(fix !== undefined)
  assert.equal(fix.jump, undefined)
})

test('no start carries the jump when the ordinary start would not wait, and a self-review reads its own flag', async () => {
  const config = { ...baseConfig(), maxConcurrentReviews: 2 }
  for (const number of [113, 106, 104, 101]) {
    for (const option of startOptions(await prOf(number), config, null, false, roomAll)) assert.equal(option.jump, undefined, `#${number} ${option.kind}`)
    for (const option of startOptions(await prOf(number), config, null, false, null)) assert.equal(option.jump, undefined, `#${number} ${option.kind}`)
  }
  // with selfReviewOverCap's overage free, a self-review does not wait, so only the review of another's PR offers the jump
  const split = { review: true, selfReview: false, running: 2 }
  for (const option of startOptions(await prOf(104), config, null, false, split)) assert.equal(option.jump, undefined)
  assert.ok(startOptions(await prOf(113), config, null, false, split).every((option) => option.jump?.button === jumpButton))
})

test('a jump the queue alone holds back, with room under the cap, says it starts ahead of the queue and names the count, without saying it goes above the cap', async () => {
  const config = { ...baseConfig(), maxConcurrentReviews: 3 }
  const option = startOptions(await prOf(113), config, null, false, { review: true, selfReview: true, running: 1 }).find((entry) => entry.kind === 'default')
  assert.deepEqual(option?.jump, { button: jumpButton, text: 'This review starts now, ahead of the queue (2 running, cap 3).' })
})

test('the Agent cell carries the jump on its starts, and whether its latest run was started ahead of the queue', async () => {
  const config = { ...baseConfig(), maxConcurrentReviews: 1 }
  const pr = await prOf(113)
  const cell = agentCell(pr, config, undefined, undefined, null, { review: true, selfReview: true, running: 1 })
  assert.equal(cell.starts.find((option) => option.kind === 'default')?.jump?.button, jumpButton)
  assert.equal(cell.jumped, false)
  const h = await harness({ maxConcurrentReviews: 1 })
  try {
    await h.runs.start(review(118))
    const run = await h.runs.start(review(113, { jump: true }))
    assert.equal(agentCell(pr, config, run, undefined).jumped, true)
  } finally {
    await h.cleanup()
  }
})

test('a sweep\'s start never carries the jump, whatever the queue answer says', async () => {
  const h = await harness()
  try {
    const view = sweepsView(baseConfig(), createSweepMemory(h.cache), waitsAll)
    assert.equal('jump' in view.start, false)
  } finally {
    await h.cleanup()
  }
})
