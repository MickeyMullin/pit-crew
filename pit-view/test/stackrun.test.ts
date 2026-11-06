// test/stackrun.test.ts
// a review-stack run in the Agent cell of the other layers of its stack (section 8 of DESIGN.md, Agent cell, Stack reviews on other layers): the real launcher, line, and poller, from the run's change through the coalesced flush to the row, and from the row through the real column's cell, signature, and built nodes
import assert from 'node:assert/strict'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { actionOffers } from '../public/actionsview.ts'
import { announceKey, announcements, cellModel, stopRequest } from '../public/agent.ts'
import { drawerModel } from '../public/drawerview.ts'
import { countRunning, hasRunningRun } from '../public/state.ts'
import { mineColumns, othersColumns } from '../public/tables.ts'
import type { CellContext } from '../public/tables.ts'
import { openCache } from '../src/cache.ts'
import type { Run, RunChanges } from '../src/cache.ts'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import * as derive from '../src/derive.ts'
import type { OpenRow } from '../src/derive.ts'
import { createGh } from '../src/github.ts'
import type { RawOpenPr } from '../src/github.ts'
import { agentCell, createLauncher, createReviewLine } from '../src/launcher.ts'
import type { RunResultJson, StartRequest } from '../src/launcher.ts'
import { createPoller } from '../src/poller.ts'
import type { Patch, View } from '../src/poller.ts'
import type { ReportInfo } from '../src/reports.ts'
import { scenario } from './fixtures/scenario.ts'
import { fakeLaunch, fakeRunner, fakeTime, fixtureRunner, ok, reviewResult, tempDir, waitFor } from './helpers.ts'

// the column builds real nodes on a small stand-in for the document, as test/ui-basedon.test.ts does
type Fake = { tag: string, attrs: Map<string, string>, children: Fake[], text?: string, setAttribute: (name: string, value: string) => void, appendChild: (child: Fake) => Fake, addEventListener: () => void }
const fakeElement = (tag: string, text?: string): Fake => {
  const element: Fake = {
    tag,
    attrs: new Map(),
    children: [],
    ...(text === undefined ? {} : { text }),
    setAttribute: (name, value) => { element.attrs.set(name, value) },
    appendChild: (child) => { element.children.push(child); return child },
    addEventListener: () => {},
  }
  return element
}
Object.assign(globalThis, {
  document: {
    createElement: (tag: string) => fakeElement(tag),
    createElementNS: (_ns: string, tag: string) => fakeElement(tag),
    createTextNode: (text: string) => fakeElement('#text', text),
  },
})
const textOf = (node: Fake): string => (node.tag === '#text' ? node.text! : node.children.map(textOf).join(''))

const rowsOf = (view: View): OpenRow[] => [...view.mine.groups.flatMap((group) => group.rows), ...view.others.groups.flatMap((group) => group.rows)]

const stack = [110, 111, 112]
const top = 112
const topSha = 'ec2fcbc878788359a31d8a16f3976e20f0f729cb'
const stackTarget = { repo: scenario.repo, stack, top }
const noMark: Partial<RawOpenPr> = { stack: null, stackEntry: null }

const waitingResult = (patch: Record<string, unknown> = {}): Record<string, unknown> => reviewResult({
  command: 'review-stack', status: 'needsInput', target: stackTarget, reviewed: { kind: 'commit', sha: topSha }, verdict: 'clean', findings: [], posted: null,
  notPostedReason: 'awaitingAnswer', report: '~/agents/output/STACK-112.md', question: 'Post this report on the top layer?', ...patch,
})

const doneResult = (patch: Record<string, unknown> = {}): Record<string, unknown> => waitingResult({ status: 'done', notPostedReason: 'noPost', question: null, ...patch })

const stackRequest = (number = 110): StartRequest => ({ repo: scenario.repo, number, command: 'review-stack', args: [String(number)], label: 'Review stack' })

const ownRequest = (number: number): StartRequest => ({ repo: scenario.repo, number, command: 'review-pr', args: [String(number)], label: 'Review' })

type SetupOptions = { config?: Partial<Config>, marks?: Record<number, Partial<RawOpenPr>>, reports?: Map<number, ReportInfo> }

// the launcher, the line, and the poller wired as src/server.ts wires them, over the invented scenario; marks changes what GitHub answers about a PR, for this and every later read
const setup = async ({ config = {}, marks = {}, reports = new Map() }: SetupOptions = {}) => {
  const temp = await tempDir()
  const home = await realpath(temp.dir)
  await mkdir(join(home, 'agents', 'output'), { recursive: true })
  await mkdir(join(home, 'agents', 'worktrees'), { recursive: true })
  await writeFile(join(home, 'agents', 'output', 'STACK-112.md'), 'Reviewed commit: `x` @ `f00dfac`\n')
  const time = fakeTime()
  const cache = openCache({ path: ':memory:', clock: time.clock })
  const settings: { current: Config } = { current: { ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit', ...config } }
  const answers = new Map<number, Partial<RawOpenPr>>(Object.entries(marks).map(([number, patch]) => [Number(number), patch]))
  const fixtures = fixtureRunner()
  const gh = fakeRunner(async (args) => {
    const answer = await fixtures.runner(args, undefined)
    if (args[1] !== 'graphql') return answer
    const body = JSON.parse(answer.stdout) as { data?: { repository?: { pullRequests?: { nodes: RawOpenPr[] }, pullRequest?: RawOpenPr | null } } }
    const repository = body.data?.repository
    for (const node of repository?.pullRequests?.nodes ?? []) Object.assign(node, answers.get(node.number) ?? {})
    if (repository?.pullRequest != null) Object.assign(repository.pullRequest, answers.get(repository.pullRequest.number) ?? {})
    return ok(JSON.stringify(body))
  })
  const launch = fakeLaunch()
  const patches: Patch[] = []
  const emits = { attempts: 0, failing: 0 }
  // writes the database refuses, as a full disk's would; the launcher's store reads updateRun when it is made
  const writes: { refuse: (changes: RunChanges) => boolean } = { refuse: () => false }
  const updateRun = cache.updateRun
  cache.updateRun = (id, changes) => {
    if (writes.refuse(changes)) throw new Error('attempt to write a readonly database')
    return updateRun(id, changes)
  }
  const engine = { launcher: null as unknown as ReturnType<typeof createLauncher> }
  const poller = createPoller({
    cache,
    gh: createGh(gh.runner),
    clock: time.clock,
    timers: time.timers,
    config: () => settings.current,
    home: '/nonexistent/pit-view-test-home',
    timeZone: scenario.timeZone,
    emit: (patch) => {
      emits.attempts += 1
      if (emits.failing > 0) {
        emits.failing -= 1
        throw new Error('the feed refused the frame')
      }
      patches.push(patch)
    },
    pageSize: scenario.pageSize,
    queueing: () => engine.launcher.queueing(),
    scan: async () => new Map(reports),
  })
  const makeLauncher = (): ReturnType<typeof createLauncher> => createLauncher({
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
    stateDir: join(home, '.local', 'state', 'pit-view'),
    env: launch.deps.env,
    newSessionId: launch.deps.newSessionId,
    onWatch: (run) => poller.runWatched(run),
    onChange: (run) => poller.runChanged(run.repo, run.number),
    line: createReviewLine({ config: () => settings.current, timers: time.timers, onQueueing: () => poller.queueingChanged() }),
  })
  engine.launcher = makeLauncher()
  poller.refresh('manual')
  await poller.idle()
  await engine.launcher.flushed()
  const rowOf = async (number: number): Promise<OpenRow | undefined> => {
    return rowsOf(await poller.view()).find((row) => row.number === number)
  }
  const sent = (number: number): OpenRow | undefined => {
    for (const patch of [...patches].reverse()) {
      const row = patch.rows.find((entry) => entry.number === number)
      if (row !== undefined) return row
    }
    return undefined
  }
  const flushed = async (): Promise<void> => {
    await new Promise((resume) => setImmediate(resume))
    await engine.launcher.flushed()
  }
  const cleanup = async (): Promise<void> => {
    engine.launcher.close()
    poller.stop()
    cache.close()
    await temp.cleanup()
  }
  return { home, time, cache, settings, answers, launch, patches, emits, writes, engine, poller, makeLauncher, rowOf, sent, flushed, cleanup }
}

// a run row written directly, in the shape the launcher writes it
const seed = (cache: ReturnType<typeof openCache>, number: number, command: string, patch: RunChanges = {}): Run => {
  const run = cache.createRun({
    repo: scenario.repo, number, command, args: [String(number)], label: command === 'review-stack' ? 'Review stack' : 'Review', runner: 'claude', cwd: '~/dev/orbit', sessionId: 'sess', pid: null, pidStartedAt: null,
    startedAt: scenario.now, lastStepAt: null, step: null, stepState: null, finishedAt: null, status: 'running', result: null, note: null, costUsd: null, resume: null,
  }, (id) => `~/runs/${id}`)
  return Object.keys(patch).length === 0 ? run : cache.updateRun(run.id, patch)
}

const finished = (patch: RunChanges = {}): RunChanges => ({ status: 'done', finishedAt: scenario.now, ...patch })

// the row through the real Agent column of its own table: what a draw compares and what it builds
const column = (row: OpenRow, view: View, nowMs: number) => {
  const agent = (row.section === 'mine' ? mineColumns(true) : othersColumns(true)).find((entry) => entry.key === 'agent')!
  const context: CellContext = { view, nowMs, paused: false, terms: [], queryTerms: [] }
  const cell = (agent.cell as (row: OpenRow, context: CellContext) => { sig: unknown, build: () => Node[] })(row, context)
  const nodes = cell.build() as unknown as Fake[]
  return { sig: JSON.stringify(cell.sig), text: nodes.map(textOf).join(' '), root: nodes[0]! }
}

test('the stack GitHub marks is found across every open PR, joined only through PRs it marks at adjacent positions of the same size', () => {
  const pr = (number: number, head: string, base: string, position: number | null, size: number | null) => ({
    number, headRefName: head, baseRefName: base, stack: size === null ? null : { size }, stackEntry: position === null ? null : { position },
  })
  const prs = [
    pr(2, 'b', 'a', 2, 3), pr(3, 'c', 'b', 3, 3), pr(1, 'a', 'main', 1, 3),
    // a stack of the same size elsewhere in the repository
    pr(11, 'x', 'main', 1, 3), pr(12, 'y', 'x', 2, 3), pr(13, 'z', 'y', 3, 3),
    // a PR only based on the top layer's branch, which GitHub does not mark
    pr(4, 'd', 'c', null, null),
    // a marked PR of another size, at the next position on the top layer's branch
    pr(20, 'e', 'c', 4, 5),
    // marked, of the same size, on the top layer's branch, but not at the next position
    pr(30, 'f', 'c', 1, 3),
  ]
  const members = (number: number): number[] => [...derive.markedStackMembers(prs, number)].sort((a, b) => a - b)
  assert.deepEqual(members(1), [1, 2, 3])
  assert.deepEqual(members(3), [1, 2, 3])
  assert.deepEqual(members(12), [11, 12, 13])
  assert.deepEqual(members(4), [], 'GitHub does not mark it, so it has no stack')
  assert.deepEqual(members(99), [], 'not an open PR')
})

test('a stack run shows on every other layer while it is queued, running, or waiting, labeled as a stack review, in Mine and in Others\', and the PR it started from reads as it always did', async () => {
  for (const viewer of ['priya-k', scenario.viewer]) {
    const h = await setup()
    try {
      h.settings.current = { ...h.settings.current, viewer }
      const run = seed(h.cache, 110, 'review-stack', { status: 'queued' })
      const section = viewer === scenario.viewer ? 'others' : 'mine'
      for (const [status, changes] of [
        ['queued', { status: 'queued' }],
        ['running', { status: 'running' }],
      ] as const) {
        h.cache.updateRun(run.id, changes)
        for (const number of [111, 112]) {
          const row = (await h.rowOf(number))!
          assert.equal(row.section, section)
          assert.equal(row.agent?.state, status, `#${number} ${status}`)
          assert.equal(row.agent?.status, status)
          assert.equal(row.agent?.label, 'Stack review from #110')
          assert.equal(row.agent?.runId, run.id)
          assert.deepEqual(row.agent?.stackRun, { from: 110, ownStatus: null })
        }
      }
      h.cache.updateRun(run.id, { status: 'needsInput', finishedAt: scenario.now, result: waitingResult() as unknown as RunResultJson })
      for (const number of [111, 112]) {
        const agent = (await h.rowOf(number))!.agent!
        assert.deepEqual([agent.state, agent.status, agent.text, agent.question], ['done', 'needsInput', 'Stack review from #110 · Needs your answer', 'Post this report on the top layer?'])
      }
      // the PR it started from: exactly the cell it would have with no other layer in the picture
      const starter = (await h.rowOf(110))!
      assert.equal(starter.agent?.label, 'Review stack')
      assert.equal(starter.agent?.text, 'Needs your answer')
      assert.equal(starter.agent?.stackRun, null)
      const pr = h.cache.readView(scenario.repo).open.find((entry) => entry.number === 110)!.pr
      assert.deepEqual(starter.agent, agentCell(pr, h.settings.current, h.cache.getRun(run.id)!, undefined, starter.stack, h.engine.launcher.queueing()))
    } finally {
      await h.cleanup()
    }
  }
})

test('a covered layer keeps its own Start buttons, idle action, and last review: only what the run says comes from the stack run', async () => {
  const h = await setup()
  try {
    const idle = (await h.rowOf(111))!.agent!
    seed(h.cache, 110, 'review-stack')
    const agent = (await h.rowOf(111))!.agent!
    assert.equal(agent.state, 'running')
    assert.deepEqual(agent.starts, idle.starts)
    assert.deepEqual(agent.action, idle.action)
    assert.equal(agent.lastReviewAt, idle.lastReviewAt)
    assert.ok(agent.starts.every((option) => option.unavailable === null), 'the stack run is not a run of this PR, so a start stays open as it does today')
  } finally {
    await h.cleanup()
  }
})

test('a covered layer of the viewer\'s own keeps the last review its own report gives, with the stack run on show and without', async () => {
  const at = '2026-10-20T10:00:00Z'
  const h = await setup({ config: { viewer: 'priya-k' }, reports: new Map([[111, { file: 'PR-111.md', reviewedSha: 'a41fb94', at, tandem: false }]]) })
  try {
    h.poller.refresh('manual')
    await h.poller.idle()
    assert.equal((await h.rowOf(111))!.agent?.lastReviewAt, at)
    seed(h.cache, 110, 'review-stack')
    const agent = (await h.rowOf(111))!.agent!
    assert.deepEqual([agent.state, agent.lastReviewAt], ['running', at])
  } finally {
    await h.cleanup()
  }
})

test('every state through the real column, both ways: the signature moves, so the cell is rebuilt, and the built nodes say the new state', async () => {
  for (const viewer of ['priya-k', scenario.viewer]) {
    const h = await setup()
    try {
      h.settings.current = { ...h.settings.current, viewer }
      const run = seed(h.cache, 110, 'review-stack', finished({ result: doneResult() as unknown as RunResultJson }))
      const draw = async () => {
        const view = await h.poller.view()
        const row = rowsOf(view).find((entry) => entry.number === 111)!
        return column(row, view, h.time.clock.now())
      }
      const states: Record<string, { changes: RunChanges, kind: string, says: RegExp }> = {
        finished: { changes: finished({ result: doneResult() as unknown as RunResultJson }), kind: 'agent-idle', says: /review|merge/i },
        queued: { changes: { status: 'queued', finishedAt: null, result: null }, kind: 'agent-queued', says: /Stack review from #110 queued/ },
        running: { changes: { status: 'running', finishedAt: null, result: null }, kind: 'agent-running', says: /Stack review from #110 running/ },
        waiting: { changes: { status: 'needsInput', finishedAt: scenario.now, result: waitingResult() as unknown as RunResultJson }, kind: 'agent-done', says: /Stack review from #110 · Needs your answer/ },
        stopped: { changes: { status: 'stopped', finishedAt: scenario.now, result: null }, kind: 'agent-idle', says: /review|merge/i },
        failed: { changes: { status: 'failed', finishedAt: scenario.now, result: null, note: 'serverRestarted' }, kind: 'agent-idle', says: /review|merge/i },
      }
      const pairs: [string, string][] = [
        ['finished', 'queued'], ['queued', 'running'], ['running', 'waiting'], ['waiting', 'finished'], ['running', 'finished'], ['running', 'stopped'], ['running', 'failed'], ['queued', 'stopped'], ['queued', 'failed'], ['waiting', 'stopped'],
      ]
      for (const [from, to] of pairs) {
        for (const [a, b] of [[from, to], [to, from]] as [string, string][]) {
          h.cache.updateRun(run.id, states[a]!.changes)
          const before = await draw()
          assert.ok(before.root.attrs.get('class')?.includes(states[a]!.kind), `${viewer} ${a}: ${before.root.attrs.get('class')}`)
          h.cache.updateRun(run.id, states[b]!.changes)
          const after = await draw()
          assert.ok(after.root.attrs.get('class')?.includes(states[b]!.kind), `${viewer} ${b}: ${after.root.attrs.get('class')}`)
          assert.match(`${after.text} ${JSON.stringify(after.sig)}`, states[b]!.says, `${viewer} ${a} to ${b}`)
          assert.notEqual(before.sig, after.sig, `${viewer} ${a} to ${b}: the cell must be rebuilt`)
        }
      }
    } finally {
      await h.cleanup()
    }
  }
})

test('the built cell of a covered layer is one button that opens that layer\'s drawer, and the drawer shows the stack run\'s card with a Stop that stops the stack run', async () => {
  const h = await setup()
  try {
    const run = await h.engine.launcher.start(stackRequest())
    await h.flushed()
    const row = h.sent(111)!
    const built = column(row, await h.poller.view(), h.time.clock.now()).root
    assert.equal(built.tag, 'button')
    assert.equal(built.attrs.get('data-agent'), 'open')
    assert.equal(built.attrs.get('data-pr'), '111')
    const model = drawerModel({ row, open: true, runs: { state: 'ready', items: [] }, reports: { state: 'ready', items: [] }, confirm: null })
    assert.equal(model.card, 'running')
    assert.equal(model.running?.label, 'Stack review from #110')
    assert.ok(model.stop !== null)
    assert.equal(stopRequest(row.agent!.runId!, 'token').url, `/api/runs/${run.id}/stop`)
    // Stop acts on the run, whichever layer's drawer asked
    h.engine.launcher.stop(row.agent!.runId!)
    await h.engine.launcher.settled(run.id)
    await h.flushed()
    assert.equal(h.sent(111)?.agent?.state, 'idle')
    assert.equal(h.sent(112)?.agent?.state, 'idle')
    assert.equal(h.sent(110)?.agent?.text, 'Stopped')
  } finally {
    await h.cleanup()
  }
})

test('the run follows the queue: queued behind the cap, started by itself when a slot frees, then finished, and each change reaches every layer through one flush', async () => {
  const h = await setup({ config: { maxConcurrentReviews: 1 } })
  try {
    const first = await h.engine.launcher.start(ownRequest(106))
    const run = await h.engine.launcher.start(stackRequest())
    assert.equal(run.status, 'queued')
    await h.flushed()
    for (const number of [111, 112]) assert.deepEqual([h.sent(number)?.agent?.state, h.sent(number)?.agent?.runId], ['queued', run.id])
    assert.equal(h.sent(110)?.agent?.label, 'Review stack')
    // the earlier review ends: the cap queue moves with no other event, and the layers follow
    h.launch.children[0]!.exit(1)
    await h.engine.launcher.settled(first.id)
    await waitFor(() => h.launch.children.length === 2)
    await h.flushed()
    for (const number of [111, 112]) assert.equal(h.sent(number)?.agent?.state, 'running')
    // a step changes a row's run: the layers carry it
    const child = h.launch.children[1]!
    await child.events({ at: '2026-10-26T14:06:00Z', step: 'review', state: 'started', note: 'reading the tip' })
    await h.engine.launcher.check()
    await h.flushed()
    assert.equal(h.sent(112)?.agent?.step?.name, 'review')
    await child.result(doneResult())
    child.exit(0)
    assert.equal((await h.engine.launcher.settled(run.id)).status, 'done')
    await h.flushed()
    // a finished stack run changes no other layer's cell, and its own PR shows it
    assert.equal(h.sent(111)?.agent?.state, 'idle')
    assert.equal(h.sent(111)?.agent?.runId, null)
    assert.equal(h.sent(112)?.agent?.state, 'idle')
    assert.equal(h.sent(110)?.agent?.state, 'done')
  } finally {
    await h.cleanup()
  }
})

test('a failed stack run leaves every other layer as it was', async () => {
  const h = await setup()
  try {
    const idle = (await h.rowOf(111))!.agent!
    const run = await h.engine.launcher.start(stackRequest())
    await h.flushed()
    assert.equal(h.sent(111)?.agent?.state, 'running')
    h.launch.children[0]!.exit(1)
    assert.equal((await h.engine.launcher.settled(run.id)).status, 'failed')
    await h.flushed()
    assert.deepEqual(h.sent(111)?.agent, idle)
    assert.match(h.sent(110)?.agent?.text ?? '', /^Failed/)
  } finally {
    await h.cleanup()
  }
})

test('waiting for an answer shows on the layers until the answer is read, and the members are the run\'s own target stack once it has one', async () => {
  const h = await setup()
  try {
    const run = await h.engine.launcher.start(stackRequest())
    await h.flushed()
    const child = h.launch.children[0]!
    // the target names only two of the layers GitHub marks
    await child.result(waitingResult({ target: { repo: scenario.repo, stack: [110, 111], top: 111 } }))
    child.exit(0)
    assert.equal((await h.engine.launcher.settled(run.id)).status, 'needsInput')
    await h.flushed()
    assert.equal(h.sent(111)?.agent?.text, 'Stack review from #110 · Needs your answer')
    assert.equal(h.sent(112)?.agent?.state, 'idle', 'marked by GitHub, but not in the stack the run read')
    assert.equal(h.sent(112)?.agent?.runId, null)
    // answered in the session, then read again: the run is done and the layer goes back
    await child.result(doneResult({ target: { repo: scenario.repo, stack: [110, 111], top: 111 } }))
    assert.equal((await h.engine.launcher.reread(run.id)).status, 'done')
    await h.flushed()
    assert.equal(h.sent(111)?.agent?.state, 'idle')
    assert.equal(h.sent(110)?.agent?.status, 'done')
  } finally {
    await h.cleanup()
  }
})

test('a result that names no target falls back to the stack GitHub marks for the starting PR', async () => {
  const h = await setup()
  try {
    seed(h.cache, 110, 'review-stack', { status: 'needsInput', finishedAt: scenario.now, result: waitingResult({ target: null }) as unknown as RunResultJson })
    assert.equal((await h.rowOf(112))!.agent?.status, 'needsInput')
  } finally {
    await h.cleanup()
  }
})

test('a server restart: a live run stays on the layers, a gone run and a queued run leave them', async () => {
  const live = await setup()
  try {
    const run = await live.engine.launcher.start(stackRequest())
    await live.flushed()
    live.engine.launcher.close()
    live.engine.launcher = live.makeLauncher()
    await live.engine.launcher.recover()
    await live.flushed()
    assert.equal(live.sent(111)?.agent?.state, 'running')
    assert.equal(live.sent(111)?.agent?.runId, run.id)
  } finally {
    await live.cleanup()
  }
  const gone = await setup()
  try {
    const run = await gone.engine.launcher.start(stackRequest())
    await gone.flushed()
    gone.engine.launcher.close()
    gone.launch.alive.clear()
    gone.engine.launcher = gone.makeLauncher()
    await gone.engine.launcher.recover()
    await gone.flushed()
    assert.equal(gone.cache.getRun(run.id)?.note, 'serverRestarted')
    assert.equal(gone.sent(111)?.agent?.state, 'idle')
    assert.equal(gone.sent(110)?.agent?.text, 'Failed · server restarted')
  } finally {
    await gone.cleanup()
  }
  const queued = await setup({ config: { maxConcurrentReviews: 1 } })
  try {
    await queued.engine.launcher.start(ownRequest(106))
    const run = await queued.engine.launcher.start(stackRequest())
    await queued.flushed()
    assert.equal(queued.sent(111)?.agent?.state, 'queued')
    queued.engine.launcher.close()
    queued.engine.launcher = queued.makeLauncher()
    await queued.engine.launcher.recover()
    await queued.flushed()
    assert.equal(queued.cache.getRun(run.id)?.status, 'failed')
    assert.equal(queued.sent(111)?.agent?.state, 'idle')
  } finally {
    await queued.cleanup()
  }
})

test('a settlement the database refuses still reaches the flush: the rows go out reading what the row says, and a Stop then records the end and frees the layers', async () => {
  const h = await setup()
  try {
    const run = await h.engine.launcher.start(stackRequest())
    await h.flushed()
    h.writes.refuse = (changes) => changes.status !== undefined
    const before = h.patches.length
    h.launch.children[0]!.exit(1)
    assert.equal((await h.engine.launcher.settled(run.id)).status, 'failed')
    await h.flushed()
    assert.ok(h.patches.length > before, 'the slot moved, so the rows went out')
    assert.equal(h.patches.at(-1)!.rows.find((row) => row.number === 111)?.agent?.state, 'running', 'the row still reads running, as a restart would find it')
    h.writes.refuse = () => false
    h.engine.launcher.stop(run.id)
    await h.flushed()
    assert.equal(h.sent(111)?.agent?.state, 'idle')
  } finally {
    await h.cleanup()
  }
})

test('a PR leaving or joining the stack GitHub marks changes the layers it moved, before the first result, and a one-PR refresh sends them', async () => {
  const h = await setup()
  try {
    await h.engine.launcher.start(stackRequest())
    await h.flushed()
    assert.equal(h.sent(112)?.agent?.state, 'running')
    // #111 leaves: #112 is no longer joined to the PR the run started from, so the refresh of #111 carries both
    h.answers.set(111, noMark)
    await h.poller.refreshPr(111)
    assert.equal(h.sent(111)?.agent?.state, 'idle')
    assert.equal(h.patches.at(-1)!.rows.find((row) => row.number === 112)?.agent?.state, 'idle', 'a row the refresh did not read still moved')
    // and joins again
    h.answers.delete(111)
    await h.poller.refreshPr(111)
    assert.equal(h.sent(111)?.agent?.state, 'running')
    assert.equal(h.patches.at(-1)!.rows.find((row) => row.number === 112)?.agent?.state, 'running')
    // a whole cycle reads the same
    h.answers.set(112, noMark)
    h.poller.refresh('manual')
    await h.poller.idle()
    assert.equal(h.sent(112)?.agent?.state, 'idle')
    assert.equal(h.sent(111)?.agent?.state, 'running')
  } finally {
    await h.cleanup()
  }
})

test('with a target on record, a layer GitHub stops marking leaves, and a PR it starts marking does not join a run that never read it', async () => {
  const h = await setup({ marks: { 113: { stack: null, stackEntry: null } } })
  try {
    seed(h.cache, 110, 'review-stack', { status: 'needsInput', finishedAt: scenario.now, result: waitingResult() as unknown as RunResultJson })
    assert.equal((await h.rowOf(112))!.agent?.status, 'needsInput')
    h.answers.set(112, noMark)
    await h.poller.refreshPr(112)
    assert.equal((await h.rowOf(112))!.agent?.runId, null)
    assert.equal((await h.rowOf(111))!.agent?.status, 'needsInput')
    h.answers.set(113, { stack: { size: 3 }, stackEntry: { position: 3 }, baseRefName: 'feat/import-parser' })
    await h.poller.refreshPr(113)
    assert.equal((await h.rowOf(113))!.agent?.runId, null)
  } finally {
    await h.cleanup()
  }
})

test('a PR only based on another PR\'s branch gets nothing: not above a marked stack, and not in a chain GitHub does not mark, whatever the run\'s target says', async () => {
  const above = await setup({ marks: { 113: { baseRefName: 'feat/import-staging' } } })
  try {
    const idle = (await above.rowOf(113))!
    assert.equal(idle.basedOn?.number, 112)
    seed(above.cache, 110, 'review-stack')
    assert.deepEqual((await above.rowOf(113))!.agent, idle.agent)
    assert.equal((await above.rowOf(112))!.agent?.state, 'running')
  } finally {
    await above.cleanup()
  }
  const chain = await setup({ marks: { 110: noMark, 111: noMark, 112: noMark } })
  try {
    const idle = (await chain.rowOf(111))!.agent
    assert.equal((await chain.rowOf(111))!.basedOn?.number, 110)
    const run = seed(chain.cache, 110, 'review-stack')
    assert.deepEqual((await chain.rowOf(111))!.agent, idle)
    chain.cache.updateRun(run.id, { status: 'needsInput', finishedAt: scenario.now, result: waitingResult() as unknown as RunResultJson })
    assert.deepEqual((await chain.rowOf(111))!.agent, idle, 'a target that names it does not make it a stack GitHub marks')
  } finally {
    await chain.cleanup()
  }
})

test('layers are followed through every open PR the cache holds, a hidden one included', async () => {
  // #111 is a draft of someone else's, so its row is hidden, and it still joins #112 to the PR the run started from
  const h = await setup({ marks: { 111: { isDraft: true } } })
  try {
    assert.equal(await h.rowOf(111), undefined)
    seed(h.cache, 110, 'review-stack')
    assert.equal((await h.rowOf(112))!.agent?.state, 'running')
  } finally {
    await h.cleanup()
  }
})

test('a non-stack run on one layer shows on no other layer', async () => {
  const h = await setup()
  try {
    const idle = (await h.rowOf(111))!.agent
    seed(h.cache, 110, 'review-pr')
    assert.deepEqual((await h.rowOf(111))!.agent, idle)
  } finally {
    await h.cleanup()
  }
})

test('the newer of a layer\'s own run and the stack run wins, in whichever order they end', async () => {
  // the layer's run is the older: the stack run shows while it is live, and then the layer's own, still running or finished
  for (const order of ['stack first', 'own first']) {
    const h = await setup()
    try {
      const own = seed(h.cache, 111, 'review-pr')
      assert.equal((await h.rowOf(111))!.agent?.runId, own.id)
      const run = seed(h.cache, 110, 'review-stack')
      const agent = (await h.rowOf(111))!.agent!
      assert.equal(agent.runId, run.id, order)
      assert.deepEqual(agent.stackRun, { from: 110, ownStatus: 'running' })
      if (order === 'stack first') {
        h.cache.updateRun(run.id, finished())
        assert.deepEqual([(await h.rowOf(111))!.agent?.runId, (await h.rowOf(111))!.agent?.state], [own.id, 'running'])
        h.cache.updateRun(own.id, finished())
      } else {
        h.cache.updateRun(own.id, finished())
        assert.equal((await h.rowOf(111))!.agent?.runId, run.id, 'the stack run is still the newer')
        h.cache.updateRun(run.id, finished())
      }
      const end = (await h.rowOf(111))!.agent!
      assert.deepEqual([end.runId, end.state, end.stackRun], [own.id, 'done', null])
    } finally {
      await h.cleanup()
    }
  }
  // the layer's run is the newer: it wins from its start, even finished while the stack run still runs
  for (const order of ['stack first', 'own first']) {
    const h = await setup()
    try {
      const run = seed(h.cache, 110, 'review-stack')
      assert.equal((await h.rowOf(111))!.agent?.runId, run.id)
      const own = seed(h.cache, 111, 'review-pr')
      assert.equal((await h.rowOf(111))!.agent?.runId, own.id, order)
      if (order === 'stack first') {
        h.cache.updateRun(run.id, finished())
        assert.deepEqual([(await h.rowOf(111))!.agent?.runId, (await h.rowOf(111))!.agent?.state], [own.id, 'running'])
        h.cache.updateRun(own.id, finished())
      } else {
        h.cache.updateRun(own.id, finished())
        assert.deepEqual([(await h.rowOf(111))!.agent?.runId, (await h.rowOf(111))!.agent?.state], [own.id, 'done'], 'the older stack run does not take it back')
        h.cache.updateRun(run.id, finished())
      }
      const end = (await h.rowOf(111))!.agent!
      assert.deepEqual([end.runId, end.state, end.stackRun], [own.id, 'done', null])
    } finally {
      await h.cleanup()
    }
  }
})

test('two stack runs over one stack: the newer shows, the older returns when the newer ends first, and neither takes over the PR it started from', async () => {
  for (const order of ['newer first', 'older first']) {
    const h = await setup()
    try {
      const older = seed(h.cache, 110, 'review-stack')
      const newer = seed(h.cache, 112, 'review-stack')
      assert.equal((await h.rowOf(111))!.agent?.runId, newer.id)
      assert.equal((await h.rowOf(112))!.agent?.stackRun, null, 'the newer run\'s own PR')
      // the older run's own PR is a layer of the newer run, which is newer than its own
      assert.equal((await h.rowOf(110))!.agent?.runId, newer.id)
      if (order === 'newer first') {
        h.cache.updateRun(newer.id, finished())
        assert.equal((await h.rowOf(111))!.agent?.runId, older.id, 'the older run is still live')
        assert.equal((await h.rowOf(110))!.agent?.stackRun, null)
        h.cache.updateRun(older.id, finished())
      } else {
        h.cache.updateRun(older.id, finished())
        assert.equal((await h.rowOf(111))!.agent?.runId, newer.id)
        h.cache.updateRun(newer.id, finished())
      }
      assert.equal((await h.rowOf(111))!.agent?.runId, null)
    } finally {
      await h.cleanup()
    }
  }
})

test('a stack run superseded on the PR it started from stops showing on the other layers', async () => {
  const h = await setup()
  try {
    const run = seed(h.cache, 110, 'review-stack', { status: 'needsInput', finishedAt: scenario.now, result: waitingResult() as unknown as RunResultJson })
    assert.equal((await h.rowOf(111))!.agent?.runId, run.id)
    seed(h.cache, 110, 'review-pr', finished())
    assert.equal((await h.rowOf(111))!.agent?.runId, null)
  } finally {
    await h.cleanup()
  }
})

test('a layer\'s own run started through the launcher takes the cell at once, with no other event', async () => {
  const h = await setup()
  try {
    const stackRun = await h.engine.launcher.start(stackRequest())
    await h.flushed()
    assert.equal(h.sent(111)?.agent?.runId, stackRun.id)
    const own = await h.engine.launcher.start(ownRequest(111))
    await h.flushed()
    assert.deepEqual([h.sent(111)?.agent?.runId, h.sent(111)?.agent?.stackRun], [own.id, null])
    assert.equal(h.sent(112)?.agent?.runId, stackRun.id)
  } finally {
    await h.cleanup()
  }
})

test('a config save: the cell stays through one that changes nothing about it, a raised cap starts the queued run, and another repository shows no run of this one', async () => {
  const h = await setup({ config: { maxConcurrentReviews: 1 } })
  try {
    await h.engine.launcher.start(ownRequest(106))
    const run = await h.engine.launcher.start(stackRequest())
    await h.flushed()
    const first = h.settings.current
    h.settings.current = { ...first, refreshSeconds: first.refreshSeconds === 60 ? 120 : 60 }
    await h.poller.configChanged(first)
    assert.equal((await h.rowOf(111))!.agent?.state, 'queued')
    assert.equal(h.sent(111)?.agent?.state, 'queued')
    const raised = h.settings.current
    h.settings.current = { ...raised, maxConcurrentReviews: 2 }
    await h.poller.configChanged(raised)
    // every row goes with a saved cap, and the cell is the run's as it is at that moment
    assert.equal(h.patches.at(-1)!.rows.find((row) => row.number === 111)?.agent?.state, 'queued')
    h.engine.launcher.drain()
    await waitFor(() => h.launch.children.length === 2)
    await h.flushed()
    assert.equal(h.sent(111)?.agent?.state, 'running')
    assert.equal(h.sent(111)?.agent?.runId, run.id)
    const moved = h.settings.current
    h.settings.current = { ...moved, repo: 'octo-example/other' }
    await h.poller.configChanged(moved)
    await h.poller.idle()
    assert.equal((await h.rowOf(111))!.agent?.runId, null)
  } finally {
    await h.cleanup()
  }
})

test('the affected rows are sent unconditionally, whether or not anything differs, with no remembered answer and one patch per flush', async () => {
  const h = await setup()
  try {
    await h.engine.launcher.start(stackRequest())
    await h.flushed()
    for (let round = 0; round < 2; round++) {
      const before = h.patches.length
      h.poller.queueingChanged()
      assert.equal(h.patches.length, before + 1)
      const numbers = h.patches.at(-1)!.rows.map((row) => row.number)
      for (const number of stack) assert.ok(numbers.includes(number), `round ${round}: #${number}`)
    }
    // a child writing several things in one turn: one flush, carrying the layers
    const before = h.patches.length
    const child = h.launch.children[0]!
    await child.events({ at: '2026-10-26T14:06:00Z', step: 'resolveBase', state: 'started', note: null }, { at: '2026-10-26T14:06:01Z', step: 'resolveBase', state: 'done', note: null })
    await h.engine.launcher.check()
    await h.flushed()
    assert.equal(h.patches.length, before + 1)
    assert.equal(h.patches.at(-1)!.rows.find((row) => row.number === 111)?.agent?.steps[0]?.state, 'done')
  } finally {
    await h.cleanup()
  }
})

test('a flush that throws once is retried, and the layers still get the run\'s end with no other event', async () => {
  const h = await setup()
  try {
    const run = await h.engine.launcher.start(stackRequest())
    await h.flushed()
    h.emits.failing = 1
    const attempts = h.emits.attempts
    h.launch.children[0]!.exit(1)
    await h.engine.launcher.settled(run.id)
    await h.flushed()
    assert.equal(h.emits.attempts, attempts + 1)
    assert.equal(h.sent(111)?.agent?.state, 'running', 'the first attempt told no page')
    h.time.advance(50)
    await h.flushed()
    assert.equal(h.emits.attempts, attempts + 2)
    assert.equal(h.sent(111)?.agent?.state, 'idle')
    assert.equal(h.time.pending(), 0)
  } finally {
    await h.cleanup()
  }
})

test('a flush that always throws is tried a bounded number of times with growing delays, and close cancels a pending retry', async () => {
  const h = await setup()
  try {
    const run = await h.engine.launcher.start(stackRequest())
    await h.flushed()
    h.emits.failing = Number.MAX_SAFE_INTEGER
    const attempts = h.emits.attempts
    h.launch.children[0]!.exit(1)
    await h.engine.launcher.settled(run.id)
    await h.flushed()
    assert.equal(h.emits.attempts, attempts + 1)
    // a retry is not due a moment before its delay ends, and each delay is longer than the last
    for (const [index, delay] of [50, 200, 800].entries()) {
      h.time.advance(delay - 1)
      await h.flushed()
      assert.equal(h.emits.attempts, attempts + index + 1, `before the ${delay} ms retry`)
      h.time.advance(1)
      await h.flushed()
      assert.equal(h.emits.attempts, attempts + index + 2, `after the ${delay} ms retry`)
    }
    assert.equal(h.time.pending(), 0)
    h.time.advance(60_000)
    await h.flushed()
    assert.equal(h.emits.attempts, attempts + 4)
    assert.equal(h.sent(111)?.agent?.state, 'running', 'no attempt reached a page')
  } finally {
    await h.cleanup()
  }
})

test('close cancels a flush\'s pending retry, so nothing reaches a page after it', async () => {
  const h = await setup()
  try {
    const run = await h.engine.launcher.start(stackRequest())
    await h.flushed()
    h.emits.failing = Number.MAX_SAFE_INTEGER
    h.launch.children[0]!.exit(1)
    await h.engine.launcher.settled(run.id)
    await h.flushed()
    assert.equal(h.time.pending(), 1)
    const attempts = h.emits.attempts
    h.engine.launcher.close()
    assert.equal(h.time.pending(), 0)
    h.time.advance(60_000)
    await new Promise((resume) => setImmediate(resume))
    assert.equal(h.emits.attempts, attempts)
  } finally {
    await h.cleanup()
  }
})

test('the actions go by the layer\'s own runs: a stack run from another PR does not take Update branch away, and a layer\'s own run in flight does', async () => {
  const h = await setup({ config: { viewer: 'priya-k' } })
  try {
    h.settings.current = { ...h.settings.current, viewer: 'priya-k' }
    const updates = (row: OpenRow): boolean => actionOffers(row, true).some((offer) => offer.action === 'update')
    // #110 is the bottom layer, on the primary branch; the run starts from the top
    assert.equal(updates((await h.rowOf(110))!), true)
    const run = seed(h.cache, 112, 'review-stack')
    const covered = (await h.rowOf(110))!
    assert.equal(covered.agent?.state, 'running')
    assert.equal(updates(covered), true, 'as it was before the stack run reached this cell')
    h.cache.updateRun(run.id, finished())
    const own = seed(h.cache, 110, 'review-pr')
    assert.equal(updates((await h.rowOf(110))!), false)
    seed(h.cache, 112, 'review-stack')
    const both = (await h.rowOf(110))!
    assert.equal(both.agent?.command, 'review-stack')
    assert.equal(updates(both), false, 'its own run is still in flight behind the newer stack run')
    h.cache.updateRun(own.id, finished())
    assert.equal(updates((await h.rowOf(110))!), true)
  } finally {
    await h.cleanup()
  }
})

test('the page says a stack run\'s words once per change, and says nothing when a layer goes back to what it already showed', async () => {
  const h = await setup()
  try {
    const own = seed(h.cache, 111, 'review-pr', finished({ result: reviewResult({ reviewed: { kind: 'commit', sha: 'a41fb945cd8814bcb601c88e9ff32ecbb444b64a' }, target: { repo: scenario.repo, pr: 111 } }) as unknown as RunResultJson }))
    const agentOf = async () => [{ number: 111, agent: (await h.rowOf(111))!.agent }]
    const first = announcements(null, await agentOf())
    assert.deepEqual(first.messages, [])
    const run = seed(h.cache, 110, 'review-stack', { status: 'queued' })
    const queued = announcements(first.next, await agentOf())
    assert.deepEqual(queued.messages, ['#111: Stack review from #110 queued'])
    h.cache.updateRun(run.id, { status: 'running' })
    const running = announcements(queued.next, await agentOf())
    assert.deepEqual(running.messages, ['#111: Stack review from #110 started'])
    h.cache.updateRun(run.id, { status: 'needsInput', finishedAt: scenario.now, result: waitingResult() as unknown as RunResultJson })
    const waiting = announcements(running.next, await agentOf())
    assert.deepEqual(waiting.messages, ['#111: Stack review from #110 · Needs your answer'])
    const model = cellModel((await h.rowOf(111))!.agent!, 111, h.time.clock.now())
    assert.equal(model.state === 'done' ? model.tone : null, 'amber')
    // the stack run ends: the layer's own finished run is back on show, and it did not just finish
    h.cache.updateRun(run.id, finished())
    const after = announcements(waiting.next, await agentOf())
    assert.equal((await h.rowOf(111))!.agent?.runId, own.id)
    assert.deepEqual(after.messages, [])
    assert.notEqual(announceKey((await h.rowOf(111))!.agent), announceKey(null))
    // and a new run of its own speaks as ever
    const newer = seed(h.cache, 111, 'review-pr')
    const started = announcements(after.next, await agentOf())
    assert.deepEqual(started.messages, ['#111: Review started'])
    h.cache.updateRun(newer.id, finished())
  } finally {
    await h.cleanup()
  }
})

test('the Agent runs tile and filter count one run once: a covered layer counts only by its own run', async () => {
  const h = await setup()
  try {
    const run = seed(h.cache, 110, 'review-stack')
    const rows = rowsOf(await h.poller.view())
    assert.equal((await h.rowOf(111))!.agent?.state, 'running')
    assert.equal(hasRunningRun((await h.rowOf(111))!), false)
    assert.equal(countRunning(rows), 1, 'one stack run, whatever its size')
    h.cache.updateRun(run.id, finished())
    const own = seed(h.cache, 111, 'review-pr')
    const behind = seed(h.cache, 110, 'review-stack')
    assert.equal((await h.rowOf(111))!.agent?.runId, behind.id)
    assert.equal(hasRunningRun((await h.rowOf(111))!), true, 'its own run is running behind the newer stack run')
    h.cache.updateRun(own.id, { status: 'queued' })
    assert.equal(hasRunningRun((await h.rowOf(111))!), false)
  } finally {
    await h.cleanup()
  }
})
