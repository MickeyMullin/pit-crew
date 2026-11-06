// test/sweeps.test.ts
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { openCache } from '../src/cache.ts'
import type { Sweep } from '../src/cache.ts'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { createGh } from '../src/github.ts'
import type { RawOpenPr } from '../src/github.ts'
import { createLauncher, createReviewLine, createSweepLauncher, LaunchError, parseResult } from '../src/launcher.ts'
import type { ReviewLine, StartRequest } from '../src/launcher.ts'
import { createSweepMemory, sweepRequest, sweepStartOf, sweepText, sweepView, sweepsView } from '../src/sweeps.ts'
import { scenario } from './fixtures/scenario.ts'
import { armedGate, emptySweepResult, fakeLaunch, fakeRemotes, fakeRunner, fakeTime, fixtureRunner, gatedGh, ok, openPage1, openPage2, quiet, reviewResult, sweepHead201, sweepResult, tempDir, waitFor, within } from './helpers.ts'
import type { FakeLaunch, FakeRunner } from './helpers.ts'

const second = 1000

const prOf = async (number: number): Promise<RawOpenPr> => {
  const nodes = [...(await openPage1()).data.repository!.pullRequests.nodes, ...(await openPage2()).data.repository!.pullRequests.nodes]
  const pr = nodes.find((entry) => entry.number === number)
  assert.ok(pr !== undefined, `fixture PR #${number}`)
  return pr
}

const baseConfig = (): Config => ({ ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit' })

type HarnessOptions = { config?: Partial<Config>, launch?: FakeLaunch, gh?: FakeRunner, onQueueing?: () => void }

// the sweep launcher with fake processes and a real temp folder, beside a run launcher on the same cache
const harness = async ({ config = {}, launch = fakeLaunch(), gh = fixtureRunner(), onQueueing }: HarnessOptions = {}) => {
  const temp = await tempDir()
  const home = await realpath(temp.dir)
  await mkdir(join(home, 'agents', 'output'), { recursive: true })
  await mkdir(join(home, 'agents', 'worktrees'), { recursive: true })
  const time = fakeTime()
  const cache = openCache({ path: ':memory:', clock: time.clock })
  const changes: Sweep[] = []
  const watched: number[] = []
  const settings = { current: { ...baseConfig(), ...config } }
  const stateDir = join(home, '.local', 'state', 'pit-view')
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
  }
  // each slot an attempt held, in the order the launches released them
  const released: number[] = []
  // the two engines over one review line, as the server makes them; called again it stands for a new server start
  const pair = () => {
    const made = createReviewLine({ config: options.config, timers: time.timers, ...(onQueueing === undefined ? {} : { onQueueing }) })
    const line: ReviewLine = {
      ...made,
      release: (attempt) => {
        released.push(attempt)
        made.release(attempt)
      },
    }
    return {
      line,
      sweeps: createSweepLauncher({ ...options, line, onWatch: (sweep) => watched.push(sweep.id), onChange: (sweep) => changes.push(sweep) }),
      runs: createLauncher({ ...options, line, onWatch: () => {}, onChange: () => {} }),
    }
  }
  const make = () => pair().sweeps
  const { sweeps: launcher, runs, line } = pair()
  const cleanup = async (): Promise<void> => {
    launcher.close()
    runs.close()
    cache.close()
    await temp.cleanup()
  }
  return { home, time, cache, launcher, runs, line, released, make, pair, changes, watched, settings, stateDir, launch, gh, cleanup }
}

const start = (runner?: StartRequest['runner']): StartRequest => sweepRequest(scenario.repo, runner)

test('a sweep launches review-dependabot-sweep for the repo with --parallel 1 and --emit-json, and never --no-post', async () => {
  const h = await harness()
  try {
    const sweep = await h.launcher.start(start())
    const runDir = join(h.stateDir, 'sweeps', String(sweep.id))
    const child = h.launch.children[0]!
    // the argv Claude receives and the one stdin line that carries the request
    assert.equal(child.request.command, 'claude')
    assert.equal(child.request.cwd, join(h.home, 'dev', 'orbit'))
    const content = (JSON.parse(child.writes[0] ?? '{}') as { message: { content: string } }).message.content
    assert.equal(content, `/review-dependabot-sweep ${scenario.repo} --parallel 1 --emit-json=${runDir}`)
    assert.ok(content.includes('--parallel 1'))
    assert.ok(content.includes('--emit-json='))
    assert.ok(!content.includes('--no-post'))
    assert.ok(!child.request.args.some((arg) => arg.includes('--no-post')))
    // the record is a sweep's own: its table, its folder, no PR number
    assert.deepEqual([sweep.command, sweep.args, sweep.label, sweep.status], ['review-dependabot-sweep', [scenario.repo, '--parallel', '1'], 'Dependabot sweep', 'running'])
    assert.equal(sweep.dir, `~/.local/state/pit-view/sweeps/${sweep.id}`)
    assert.equal('number' in sweep, false)
    assert.deepEqual(h.cache.runningRuns(), [])
    const recorded = JSON.parse(await readFile(join(runDir, 'request.json'), 'utf8'))
    assert.deepEqual([recorded.command, recorded.args, recorded.pid], ['review-dependabot-sweep', [scenario.repo, '--parallel', '1'], child.pid])
    // the same checks as a run's start: one identity call and one clone check
    assert.deepEqual(h.gh.calls.filter((call) => call.args[0] === 'api').map((call) => call.args), [['api', 'user', '--jq', '.login']])
    assert.equal(h.launch.gitCalls.length, 1)
    assert.deepEqual(h.watched, [sweep.id])
  } finally {
    await h.cleanup()
  }
})

test('a sweep runs no git hook on either runner: its child carries the launcher\'s third git entry', async () => {
  const h = await harness()
  try {
    for (const runner of ['claude', 'codex'] as const) {
      const before = h.launch.children.length
      const sweep = await h.launcher.start(start(runner))
      const child = h.launch.children[before]!
      assert.deepEqual(
        [child.request.env.GIT_CONFIG_COUNT, child.request.env.GIT_CONFIG_KEY_0, child.request.env.GIT_CONFIG_KEY_1, child.request.env.GIT_CONFIG_KEY_2, child.request.env.GIT_CONFIG_VALUE_2],
        ['3', 'url.https://github.com/.insteadOf', 'credential.helper', 'core.hooksPath', '/dev/null'],
        runner,
      )
      child.exit(0)
      await h.launcher.settled(sweep.id)
    }
  } finally {
    await h.cleanup()
  }
})

test('Codex gets the same sweep as a $ skill, still serial and never --no-post', async () => {
  const h = await harness({ config: { agent: { runner: 'codex', claudeModel: 'sonnet' } } })
  try {
    const sweep = await h.launcher.start(start())
    const prompt = h.launch.children[0]!.request.args.at(-1) ?? ''
    assert.equal(sweep.runner, 'codex')
    assert.ok(prompt.startsWith(`$review-dependabot-sweep ${scenario.repo} --parallel 1 --emit-json=`))
    assert.ok(!prompt.includes('--no-post'))
  } finally {
    await h.cleanup()
  }
})

test('a start is refused for another gh account, an unset cloneDir, and a folder that is not a clone, before anything runs', async () => {
  const other = fakeRunner((args) => args[0] === 'api' ? ok('someone-else\n') : ok('gho_fixture_token\n'))
  const mismatch = await harness({ gh: other })
  try {
    await assert.rejects(mismatch.launcher.start(start()), (error: unknown) =>
      error instanceof LaunchError && error.code === 'identityMismatch' && /someone-else/.test(error.message) && error.message.includes(scenario.viewer))
    assert.equal(mismatch.launch.children.length, 0)
    assert.deepEqual(mismatch.cache.sweepsFor(scenario.repo), [])
  } finally {
    await mismatch.cleanup()
  }
  const unset = await harness()
  try {
    delete unset.settings.current.cloneDir
    await assert.rejects(unset.launcher.start(start()), (error: unknown) => error instanceof LaunchError && error.code === 'noClone')
    assert.equal(unset.launch.children.length, 0)
  } finally {
    await unset.cleanup()
  }
  for (const remotes of [null, 'origin\thttps://github.com/octo-example/other (fetch)\n']) {
    const wrong = await harness({ launch: fakeLaunch({ remotes }) })
    try {
      await assert.rejects(wrong.launcher.start(start()), (error: unknown) => error instanceof LaunchError && error.code === 'notAClone')
      assert.equal(wrong.launch.children.length, 0)
    } finally {
      await wrong.cleanup()
    }
  }
})

test('one sweep per repository: a second start is refused while one is in flight, even before the first has its row', async () => {
  const h = await harness()
  try {
    const [first, second] = await Promise.allSettled([h.launcher.start(start()), h.launcher.start(start())])
    assert.equal(first.status, 'fulfilled')
    assert.ok(second.status === 'rejected' && second.reason instanceof LaunchError && second.reason.code === 'busy')
    assert.match(String(second.status === 'rejected' && (second.reason as Error).message), /sweep/)
    await assert.rejects(h.launcher.start(start()), (error: unknown) => error instanceof LaunchError && error.code === 'busy')
    assert.equal(h.launch.children.length, 1)
    // a run of a PR is unaffected by the sweep, and the sweep by a run: they count apart
    await h.runs.start({ repo: scenario.repo, number: 106, command: 'review-pr', args: ['106'], label: 'Re-review' })
    assert.equal(h.launch.children.length, 2)
    // once settled, the repository may sweep again
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(1)
    await h.launcher.start(start())
    assert.equal(h.launch.children.length, 3)
  } finally {
    await h.cleanup()
  }
})

test('a sweep settles done from result.json with its rows, counts, and merge order', async () => {
  const h = await harness()
  try {
    const sweep = await h.launcher.start(start())
    const child = h.launch.children[0]!
    await child.events({ at: '2026-10-26T14:06:00Z', step: 'resolveBase', state: 'done', note: null }, { at: '2026-10-26T14:07:00Z', step: 'review', state: 'started', note: null })
    await h.launcher.check()
    assert.deepEqual([h.cache.getSweep(sweep.id)!.step, h.cache.getSweep(sweep.id)!.steps?.[1]?.state], ['review', 'started'])
    await writeFile(join(h.home, 'agents', 'output', 'dependabot-sweep-octo-example-orbit-2026-10-26.md'), '# sweep\n')
    await child.result(sweepResult())
    const settled = h.launcher.settled(sweep.id)
    h.time.advance(5 * second)
    child.exit(0)
    const final = await settled
    assert.equal(final.status, 'done')
    assert.equal(final.note, null)
    assert.equal(final.result?.schema, 'pit-crew/sweep-result@1')
    const view = sweepView(final)
    assert.equal(view.text, 'Done · 2 swept')
    assert.deepEqual(view.result?.counts, { swept: 2, fresh: 1, reused: 1, failed: 0 })
    assert.deepEqual(view.result?.rows.map((row) => [row.number, row.headShort, row.recommendation, row.ci, row.reused]), [[201, '2010000', 'approve', 'green', false], [202, '2020000', 'hold', 'failed', true]])
    assert.deepEqual(view.result?.mergeOrder.map((action) => action.prs), [[201], [202]])
    assert.equal(view.result?.summary, '~/agents/output/dependabot-sweep-octo-example-orbit-2026-10-26.md')
    // the sweeps table holds it and the runs table saw nothing
    assert.equal(h.cache.getSweep(sweep.id)?.status, 'done')
    assert.deepEqual(h.cache.runningRuns(), [])
  } finally {
    await h.cleanup()
  }
})

test('a sweep with nothing to sweep settles done with every count zero and no summary, never as a failure', async () => {
  const h = await harness()
  try {
    const sweep = await h.launcher.start(start())
    const child = h.launch.children[0]!
    await child.result(emptySweepResult())
    const settled = h.launcher.settled(sweep.id)
    child.exit(0)
    const final = await settled
    assert.deepEqual([final.status, final.note], ['done', null])
    const view = sweepView(final)
    assert.equal(view.text, 'Done · nothing to sweep')
    assert.deepEqual(view.result?.counts, { swept: 0, fresh: 0, reused: 0, failed: 0 })
    assert.deepEqual([view.result?.rows, view.result?.mergeOrder, view.result?.summary], [[], [], null])
  } finally {
    await h.cleanup()
  }
})

test('a failed sweep keeps its own error', async () => {
  const h = await harness()
  try {
    const outcome = async (value: Record<string, unknown>, code = 0): Promise<Sweep> => {
      const sweep = await h.launcher.start(start())
      const child = h.launch.children.at(-1)!
      await child.result(value)
      const settled = h.launcher.settled(sweep.id)
      child.exit(code)
      return settled
    }
    const failed = await outcome(sweepResult({ status: 'failed', error: 'the working directory is not a clone of the repository', rows: [], mergeOrder: [], summary: null }))
    assert.deepEqual([failed.status, failed.note], ['failed', 'the working directory is not a clone of the repository'])
    assert.equal(sweepView(failed).text, 'Failed')
    // a sweep that finished with reviews failed is still done, its failures counted
    await writeFile(join(h.home, 'agents', 'output', 'dependabot-sweep-octo-example-orbit-2026-10-26.md'), '# sweep\n')
    const partial = await outcome(sweepResult({ counts: { swept: 3, fresh: 2, reused: 0, failed: 1 } }))
    assert.equal(partial.status, 'done')
    assert.equal(sweepText(partial), 'Done · 3 swept, 1 failed')
    // a done sweep whose summary file is missing fails as noReport, and a missing result as noResult
    const missing = await outcome(sweepResult({ summary: '~/agents/output/not-written.md' }))
    assert.deepEqual([missing.status, missing.note], ['failed', 'noReport: ~/agents/output/not-written.md does not exist'])
    const silent = await outcome({} , 1)
    assert.equal(silent.status, 'failed')
    assert.match(silent.note ?? '', /^noResult: /)
    assert.equal(sweepView(silent).text, 'Failed · no result')
  } finally {
    await h.cleanup()
  }
})

test('a sweep that stops to ask is needsInput with its question, and a review\'s result in a sweep\'s folder is no result', async () => {
  const h = await harness()
  try {
    const first = await h.launcher.start(start())
    await h.launch.children[0]!.result(sweepResult({ status: 'needsInput', question: 'Two PRs must land together. Close #202 first? (yes / no)', rows: [], mergeOrder: [], summary: null }))
    const waiting = h.launcher.settled(first.id)
    h.launch.children[0]!.exit(0)
    const waited = await waiting
    assert.deepEqual([waited.status, waited.note], ['needsInput', null])
    const view = sweepView(waited)
    assert.deepEqual([view.text, view.question], ['Needs your answer', 'Two PRs must land together. Close #202 first? (yes / no)'])
    const second = await h.launcher.start(start())
    await writeFile(join(h.home, 'agents', 'output', 'PR-106.md'), 'x\n')
    await h.launch.children[1]!.result(reviewResult({ report: '~/agents/output/PR-106.md' }))
    const wrong = h.launcher.settled(second.id)
    h.launch.children[1]!.exit(0)
    const mismatched = await wrong
    assert.equal(mismatched.status, 'failed')
    assert.match(mismatched.note ?? '', /^noResult: result.json: expected pit-crew\/sweep-result@1, found pit-crew\/review-result@1/)
  } finally {
    await h.cleanup()
  }
})

test('a stop signals the sweep\'s group and settles it stopped; stopping an unknown or finished sweep is refused', async () => {
  const h = await harness()
  try {
    const sweep = await h.launcher.start(start())
    const child = h.launch.children[0]!
    const stopped = h.launcher.stop(sweep.id)
    assert.equal(stopped.status, 'running')
    await waitFor(() => h.launch.kills.length === 1)
    assert.deepEqual(h.launch.kills, [{ pid: -child.pid, signal: 'SIGTERM' }])
    const final = await h.launcher.settled(sweep.id)
    assert.deepEqual([final.status, sweepView(final).text], ['stopped', 'Stopped'])
    assert.throws(() => h.launcher.stop(sweep.id), (error: unknown) => error instanceof LaunchError && error.code === 'notRunning')
    assert.throws(() => h.launcher.stop(99), (error: unknown) => error instanceof LaunchError && error.code === 'unknownRun' && /sweep 99/.test(error.message))
    // a run with the same id is a different thing: stopping sweep 1 never touches run 1
    assert.deepEqual(h.cache.runningRuns(), [])
  } finally {
    await h.cleanup()
  }
})

test('after a restart a sweep whose process lives is watched again and settles from its files', async () => {
  const h = await harness()
  try {
    const sweep = await h.launcher.start(start())
    const child = h.launch.children[0]!
    h.launcher.close()
    const again = h.make()
    await again.recover()
    assert.deepEqual(h.watched, [sweep.id, sweep.id])
    await writeFile(join(h.home, 'agents', 'output', 'dependabot-sweep-octo-example-orbit-2026-10-26.md'), '# sweep\n')
    await child.result(sweepResult())
    child.exit(0)
    h.time.advance(20 * second)
    const final = await again.settled(sweep.id)
    assert.equal(final.status, 'done')
    again.close()
  } finally {
    await h.cleanup()
  }
})

test('after a restart a sweep whose process is gone settles from its result.json and otherwise fails as serverRestarted', async () => {
  const h = await harness()
  try {
    const withResult = await h.launcher.start(start())
    const child = h.launch.children[0]!
    await writeFile(join(h.home, 'agents', 'output', 'dependabot-sweep-octo-example-orbit-2026-10-26.md'), '# sweep\n')
    await child.result(sweepResult())
    h.launcher.close()
    h.launch.alive.delete(child.pid)
    // the first sweep is recorded as running, with a result on disk; settle it, then start another, and lose it
    const again = h.make()
    await again.recover()
    assert.deepEqual([h.cache.getSweep(withResult.id)?.status, h.cache.getSweep(withResult.id)?.note], ['done', null])
    const lost = await again.start(start())
    again.close()
    h.launch.alive.delete(h.launch.children[1]!.pid)
    const last = h.make()
    await last.recover()
    assert.deepEqual([h.cache.getSweep(lost.id)?.status, h.cache.getSweep(lost.id)?.note], ['failed', 'serverRestarted'])
    assert.equal(sweepText(h.cache.getSweep(lost.id)!), 'Failed · server restarted')
    last.close()
  } finally {
    await h.cleanup()
  }
})

test('a sweep with an unreadable spawn fails as spawnFailed and the repository may sweep again', async () => {
  const launch = fakeLaunch()
  launch.spawnError = new Error('spawn claude ENOENT')
  const h = await harness({ launch })
  try {
    const sweep = await h.launcher.start(start())
    assert.deepEqual([sweep.status, sweep.note], ['failed', 'spawnFailed: spawn claude ENOENT'])
    launch.spawnError = null
    assert.equal((await h.launcher.start(start())).status, 'running')
  } finally {
    await h.cleanup()
  }
})

// the view, the start text, and the memory

test('the sweep confirmation carries the labels of the configured models, and they change with the config', () => {
  assert.deepEqual(sweepStartOf(baseConfig(), false).models, { claude: 'Sonnet', codex: 'Codex default' })
  const config = { ...baseConfig(), agent: { runner: 'codex' as const, claudeModel: 'opus', codexModel: 'gpt-6.1-terra' } }
  assert.deepEqual(sweepStartOf(config, false).models, { claude: 'Opus', codex: 'gpt-6.1-terra' })
})

test('the confirmation names the repository, says the sweep is serial, and says the reviewers may post as the viewer', () => {
  const start = sweepStartOf(baseConfig(), false)
  assert.match(start.heading, /octo-example\/orbit/)
  assert.equal(start.repo, scenario.repo)
  assert.equal(start.command, 'review-dependabot-sweep octo-example/orbit --parallel 1')
  assert.match(start.serial, /one PR at a time/)
  assert.match(start.posts, /reviewers post on GitHub as @/)
  assert.match(start.posts, new RegExp(`@${scenario.viewer}`))
  assert.match(start.posts, /approve a clean bump/)
  assert.match(start.posts, /never merges or pushes/)
  assert.equal(start.unavailable, null)
  assert.deepEqual(start.runners, ['claude', 'codex'])
  // not available while a sweep runs or without a clone
  assert.match(sweepStartOf(baseConfig(), true).unavailable ?? '', /already in flight/)
  const noClone = baseConfig()
  delete noClone.cloneDir
  assert.match(sweepStartOf(noClone, false).unavailable ?? '', /cloneDir/)
})

test('rows are read defensively: a row without a PR number is dropped, notPostedReason is ignored, and a bad enum reads as null', () => {
  const parsed = parseResult(JSON.stringify(sweepResult({
    rows: [
      { number: 0, title: 'dropped' },
      'not a row',
      { number: 7, url: 'https://github.com/octo-example/orbit/pull/7', title: 'x', head: sweepHead201, bump: 'b', recommendation: 'ship it', ci: 'purple', findings: [{ priority: 'P9', summary: 'x' }, { priority: 'P2', summary: 'kept' }], escalation: '', posted: { form: 'wave', url: 'u' }, reused: 'yes', report: null, notes: ['one', 'two'], notPostedReason: 'noPost' },
    ],
  })))
  assert.equal(parsed.ok, true)
  if (!parsed.ok || parsed.value.schema !== 'pit-crew/sweep-result@1') throw new Error('expected a sweep result')
  const sweep = { ...sweepView({ ...baseSweep(), result: parsed.value, status: 'done' }) }
  const row = sweep.result?.rows[0]
  assert.equal(sweep.result?.rows.length, 1)
  assert.deepEqual([row?.number, row?.recommendation, row?.ci, row?.findings, row?.escalation, row?.posted, row?.reused, row?.notes], [7, null, null, [{ priority: 'P2', summary: 'kept' }], null, null, false, 'one; two'])
  assert.equal('notPostedReason' in (row ?? {}), false)
})

const baseSweep = (patch: Partial<Sweep> = {}): Sweep => ({
  id: 1, repo: scenario.repo, command: 'review-dependabot-sweep', args: [scenario.repo, '--parallel', '1'], label: 'Dependabot sweep', runner: 'claude',
  cwd: '~/dev/orbit', dir: '~/.local/state/pit-view/sweeps/1', sessionId: null, pid: null, pidStartedAt: null, startedAt: '2026-10-26T14:00:00Z',
  lastStepAt: null, step: null, stepState: null, steps: null, finishedAt: null, status: 'running', result: null, note: null, costUsd: null, resume: null, origin: 'manual', tick: null, reason: null, queuedAt: null, posting: false, worktree: null, ...patch,
})

test('a running sweep reads as five pending slots with no text, and memory keeps the newest sweeps of a repo, loaded from the cache', () => {
  const view = sweepView(baseSweep())
  assert.deepEqual([view.text, view.question, view.result, view.steps.map((slot) => slot.state)], [null, null, null, ['pending', 'pending', 'pending', 'pending', 'pending']])
  const time = fakeTime()
  const cache = openCache({ path: ':memory:', clock: time.clock })
  const template = baseSweep()
  const { id: _id, dir: _dir, steps: _steps, ...fields } = template
  const first = cache.createSweep({ ...fields, status: 'done' }, (id) => `~/s/${id}`)
  cache.createSweep({ ...fields, repo: 'octo-example/other' }, (id) => `~/s/${id}`)
  const memory = createSweepMemory(cache, 2)
  assert.deepEqual(memory.list(scenario.repo).map((sweep) => sweep.id), [first.id])
  const second = cache.createSweep({ ...fields }, (id) => `~/s/${id}`)
  cache.createSweep({ ...fields }, (id) => `~/s/${id}`)
  // memory is state of its own: a sweep not announced to it is not in it
  assert.deepEqual(memory.list(scenario.repo).map((sweep) => sweep.id), [first.id])
  memory.set(cache.getSweep(second.id)!)
  memory.set(cache.getSweep(4)!)
  assert.deepEqual(memory.list(scenario.repo).map((sweep) => sweep.id), [4, second.id])
  assert.equal(memory.get(4)?.status, 'running')
  // another repo is read from the cache the first time it is asked for
  assert.deepEqual(memory.list('octo-example/other').map((sweep) => sweep.id), [2])
  // the page's view: the start text is unavailable while the repo's newest sweep runs
  assert.match(sweepsView(baseConfig(), memory).start.unavailable ?? '', /already in flight/)
  cache.close()
})

test('memory drops the sweeps the cache pruned, and the launcher names them as it prunes', async () => {
  const pruned: number[] = []
  const h = await harness()
  try {
    const cache = openCache({ path: ':memory:', clock: fakeTime().clock, keepSweeps: 1 })
    const launcher = createSweepLauncher({
      cache, gh: createGh(h.gh.runner), git: h.launch.deps.git, spawn: h.launch.deps.spawn, fs: h.launch.deps.fs, kill: h.launch.deps.kill, procs: h.launch.deps.procs,
      clock: fakeTime().clock, timers: fakeTime().timers, config: () => h.settings.current, home: h.home, stateDir: h.stateDir, env: h.launch.deps.env,
      newSessionId: h.launch.deps.newSessionId, onWatch: () => {}, onChange: () => {}, onPruned: (gone) => pruned.push(...gone.map((sweep) => sweep.id)),
      line: createReviewLine({ config: () => h.settings.current, timers: fakeTime().timers }),
    })
    const memory = createSweepMemory(cache, 5)
    const first = await launcher.start(start())
    memory.set(first)
    h.launch.children[0]!.exit(1)
    await launcher.settled(first.id)
    memory.set(cache.getSweep(first.id)!)
    const second = await launcher.start(start())
    assert.deepEqual(pruned, [first.id])
    memory.drop(pruned)
    assert.equal(memory.get(first.id), undefined)
    assert.equal(cache.getSweep(first.id), null)
    memory.set(second)
    assert.deepEqual(memory.list(scenario.repo).map((sweep) => sweep.id), [second.id])
    launcher.close()
    cache.close()
  } finally {
    await h.cleanup()
  }
})

// the review cap and its one queue, shared by the review engine and the sweep engine (section 8, Launching runs, Review cap)

const review = (number: number, patch: Partial<StartRequest> = {}): StartRequest =>
  ({ repo: scenario.repo, number, command: 'review-pr', args: [String(number)], label: 'Review', ...patch })

// what the runner was asked, in the order the processes started: a review's PR number, or sweep
const startOrder = (h: { launch: FakeLaunch }): (number | 'sweep')[] => h.launch.children.map((child) => {
  const text = child.writes[0] ?? ''
  return text.includes('/review-dependabot-sweep ') ? 'sweep' : Number(/\/review-pr (\d+) /.exec(text)?.[1])
})

test('a sweep takes one slot and gives it back when it settles, and the one answer for a new review follows it', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  try {
    assert.deepEqual(h.runs.queueing(), { review: false, selfReview: false })
    const sweep = await h.launcher.start(start())
    assert.equal(sweep.status, 'running')
    // either engine reads the one count
    assert.deepEqual(h.runs.queueing(), { review: true, selfReview: true })
    assert.deepEqual(h.launcher.queueing(), { review: true, selfReview: true })
    const queued = await h.runs.start(review(113))
    assert.equal(queued.status, 'queued')
    assert.equal(h.launch.children.length, 1)
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(sweep.id)
    await waitFor(() => h.launch.children.length === 2)
    assert.deepEqual(startOrder(h), ['sweep', 113])
    h.launch.children[1]!.exit(1)
    await h.runs.settled(queued.id)
    await waitFor(() => !h.runs.queueing().review)
    assert.deepEqual(h.runs.queueing(), { review: false, selfReview: false })
  } finally {
    await h.cleanup()
  }
})

test('a sweep counts as one review beside the reviews in flight, and only a full cap makes it wait', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 3 } })
  try {
    await h.runs.start(review(113))
    assert.equal((await h.launcher.start(start())).status, 'running')
    assert.equal(h.runs.queueing().review, false)
    assert.equal((await h.runs.start(review(118))).status, 'running')
    assert.equal(h.runs.queueing().review, true)
    assert.equal((await h.runs.start(review(106))).status, 'queued')
    assert.equal(h.launch.children.length, 3)
  } finally {
    await h.cleanup()
  }
})

test('a sweep behind a full cap waits in the one queue, with no process or folder, and starts in arrival order with reviews around it', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  try {
    const first = await h.runs.start(review(113))
    const earlier = await h.runs.start(review(118))
    const sweep = await h.launcher.start(start())
    const later = await h.runs.start(review(106))
    assert.deepEqual([first.status, earlier.status, sweep.status, later.status], ['running', 'queued', 'queued', 'queued'])
    assert.deepEqual([sweep.pid, sweep.finishedAt, sweep.resume], [null, null, null])
    assert.equal(h.cache.getSweep(sweep.id)?.status, 'queued')
    assert.deepEqual(h.watched, [sweep.id])
    assert.deepEqual(h.changes.map((change) => [change.id, change.status]), [[sweep.id, 'queued']])
    await assert.rejects(readFile(join(h.stateDir, 'sweeps', String(sweep.id), 'request.json'), 'utf8'))
    assert.deepEqual(startOrder(h), [113])

    // each end hands its slot to the next in line, by itself: nothing else is called and no timer has to fire
    h.time.advance(60 * second)
    h.launch.children[0]!.exit(1)
    await h.runs.settled(first.id)
    await waitFor(() => h.launch.children.length === 2)
    assert.deepEqual(startOrder(h), [113, 118])
    assert.equal(h.cache.getSweep(sweep.id)?.status, 'queued')

    h.launch.children[1]!.exit(1)
    await h.runs.settled(earlier.id)
    await waitFor(() => h.launch.children.length === 3)
    assert.deepEqual(startOrder(h), [113, 118, 'sweep'])
    await waitFor(() => h.cache.getSweep(sweep.id)?.pid != null)
    const started = h.cache.getSweep(sweep.id)
    assert.equal(started?.status, 'running')
    // its start time is when it started, not when it was queued, and it starts on checks made in the queue, as a queued review does: one more set, or two when the first passed while the launch ahead of it was still returning
    assert.notEqual(started?.startedAt, sweep.startedAt)
    assert.ok([6, 7].includes(h.gh.calls.filter((call) => call.args[0] === 'api').length))
    assert.equal(h.cache.getRun(later.id)?.status, 'queued')
    assert.equal(h.launch.children[2]!.request.cwd, join(h.home, 'dev', 'orbit'))
    await waitFor(() => h.changes.at(-1)?.status === 'running')

    h.launch.children[2]!.exit(1)
    await h.launcher.settled(sweep.id)
    await waitFor(() => h.launch.children.length === 4)
    assert.deepEqual(startOrder(h), [113, 118, 'sweep', 106])
  } finally {
    await h.cleanup()
  }
})

test('a sweep never spawns on checks made before it waited: gh switches accounts while it waits behind an earlier review, which is then refused', async () => {
  const accounts = armedGate()
  const login = { current: scenario.viewer as string }
  const h = await harness({ gh: gatedGh(accounts, login), config: { maxConcurrentReviews: 3 } })
  try {
    accounts.arm()
    const earlier = h.runs.start(review(106))
    await waitFor(() => accounts.held() === 1)
    const sweep = h.launcher.start(start())
    await quiet()
    login.current = 'someone-else'
    accounts.open(0)
    await assert.rejects(earlier, (error: unknown) => error instanceof LaunchError && error.code === 'identityMismatch')
    const answer = await within(sweep)
    await quiet()
    assert.equal(h.launch.children.length, 0, 'the sweep spawned under an account nobody confirmed')
    assert.equal(h.cache.getSweep(answer.id)?.status, 'failed')
  } finally {
    await h.cleanup()
  }
})

test('with room again a later review does not pass a queued sweep: the sweep is let go first', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  try {
    await h.runs.start(review(113))
    const sweep = await h.launcher.start(start())
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 2 }
    const later = await h.runs.start(review(118))
    assert.equal(later.status, 'queued')
    await waitFor(() => h.launch.children.length === 2)
    await quiet()
    assert.deepEqual(startOrder(h), [113, 'sweep'])
    assert.equal(h.cache.getSweep(sweep.id)?.status, 'running')
    assert.equal(h.cache.getRun(later.id)?.status, 'queued')
  } finally {
    await h.cleanup()
  }
})

test('a sweep arrives before its checks: an earlier review still in its checks decides first, whichever checks end first', async () => {
  const accounts = armedGate()
  const h = await harness({ config: { maxConcurrentReviews: 1 }, gh: gatedGh(accounts, { current: scenario.viewer }) })
  try {
    accounts.arm()
    const pendingReview = h.runs.start(review(113))
    await waitFor(() => accounts.held() === 1)
    // the sweep's checks pass at once, but it arrived second
    const pendingSweep = h.launcher.start(start())
    await quiet()
    assert.equal(h.launch.children.length, 0)
    assert.deepEqual(h.cache.sweepsFor(scenario.repo), [])
    accounts.open(0)
    assert.equal((await pendingReview).status, 'running')
    assert.equal((await pendingSweep).status, 'queued')
    assert.deepEqual(startOrder(h), [113])
  } finally {
    await h.cleanup()
  }
})

test('a sweep never starts over the cap: the overage is not for it, and a self-review behind it waits and then goes over the cap in its turn', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1, selfReviewOverCap: true } })
  try {
    h.cache.writePr(scenario.repo, await prOf(101), scenario.defaultBranch)
    const running = await h.runs.start(review(113))
    // the sweep reads the review flag of the one answer, never the self-review flag
    assert.deepEqual(h.runs.queueing(), { review: true, selfReview: false })
    const sweep = await h.launcher.start(start())
    assert.equal(sweep.status, 'queued')
    assert.equal(h.launch.children.length, 1)
    // a self-review the overage would let in now waits behind the earlier sweep
    assert.deepEqual(h.runs.queueing(), { review: true, selfReview: true })
    const self = await h.runs.start(review(101, { args: ['101', '--no-post'], label: 'Self-review' }))
    assert.equal(self.status, 'queued')
    await quiet()
    assert.deepEqual(startOrder(h), [113])
    // the review ends: the sweep takes the cap's slot, and the self-review goes over it, in that order
    h.launch.children[0]!.exit(1)
    await h.runs.settled(running.id)
    await waitFor(() => h.launch.children.length === 3)
    assert.deepEqual(startOrder(h), [113, 'sweep', 101])
  } finally {
    await h.cleanup()
  }
})

test('a self-review over the cap leaves the sweep a slot of the cap\'s own, and only that', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1, selfReviewOverCap: true } })
  try {
    h.cache.writePr(scenario.repo, await prOf(101), scenario.defaultBranch)
    await h.runs.start(review(101, { args: ['101', '--no-post'], label: 'Self-review' }))
    // the self-review is the one over, so the sweep takes the cap's own slot
    assert.equal(h.runs.queueing().review, false)
    assert.equal((await h.launcher.start(start())).status, 'running')
    assert.equal(h.runs.queueing().review, true)
    assert.equal((await h.runs.start(review(113))).status, 'queued')
    assert.equal(h.launch.children.length, 2)
  } finally {
    await h.cleanup()
  }
})

test('a cap lowered below what is in flight holds a sweep back until the count is below it again', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 2 } })
  try {
    const one = await h.runs.start(review(113))
    const two = await h.runs.start(review(118))
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 1 }
    const sweep = await h.launcher.start(start())
    assert.equal(sweep.status, 'queued')
    h.launch.children[0]!.exit(1)
    await h.runs.settled(one.id)
    await quiet()
    assert.equal(h.cache.getSweep(sweep.id)?.status, 'queued')
    h.launch.children[1]!.exit(1)
    await h.runs.settled(two.id)
    await waitFor(() => h.launch.children.length === 3)
    assert.equal(startOrder(h)[2], 'sweep')
  } finally {
    await h.cleanup()
  }
})

// a launch whose folder the test holds, so the cap can be saved while it is prepared
const heldFolders = () => {
  const launch = fakeLaunch()
  const folders = armedGate()
  const makeFolder = launch.deps.fs.mkdir
  launch.deps.fs = {
    ...launch.deps.fs,
    mkdir: async (path) => {
      await folders.wait()
      await makeFolder(path)
    },
  }
  return { launch, folders }
}

test('a cap lowered while a new sweep is prepared keeps it from spawning: it waits again at the head of the line, and its slot is released once', async () => {
  const { launch, folders } = heldFolders()
  const h = await harness({ launch, config: { maxConcurrentReviews: 2 } })
  try {
    const running = await h.runs.start(review(113))
    const releasedBefore = h.released.length
    folders.arm()
    const pending = h.launcher.start(start())
    await waitFor(() => folders.held() === 1)
    const row = h.cache.sweepsFor(scenario.repo)[0]!
    assert.equal(row.status, 'running')
    // one arriving during the launch queues behind it
    const behind = await h.runs.start(review(118))
    assert.equal(behind.status, 'queued')
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 1 }
    h.launcher.drain()
    h.time.advance(60_000)
    folders.open(0)
    // the caller is answered with the row as it stands: waiting, so it is told the truth
    const answered = await within(pending)
    assert.deepEqual([answered.id, answered.status], [row.id, 'queued'])
    await quiet()
    assert.deepEqual(startOrder(h), [113])
    const waiting = h.cache.getSweep(row.id)!
    assert.deepEqual([waiting.status, waiting.pid, waiting.finishedAt, waiting.note, waiting.startedAt], ['queued', null, null, null, row.startedAt])
    assert.equal(h.changes.at(-1)?.status, 'queued')
    // the running review alone holds a slot: the attempt's was released exactly once
    assert.equal(h.released.length, releasedBefore + 1)
    assert.deepEqual(h.line.inFlight(), ['review'])
    assert.equal(h.line.queueing().review, true)
    // the sweep kept its place: a freed slot goes to it, and the review behind it follows it
    h.launch.children[0]!.exit(1)
    await h.runs.settled(running.id)
    await waitFor(() => h.launch.children.length === 2)
    assert.deepEqual(startOrder(h), [113, 'sweep'])
    assert.equal(h.cache.getSweep(row.id)?.status, 'running')
    assert.equal(h.cache.getRun(behind.id)?.status, 'queued')
    h.launch.children[1]!.exit(1)
    await h.launcher.settled(row.id)
    await waitFor(() => h.launch.children.length === 3)
    assert.deepEqual(startOrder(h), [113, 'sweep', 118])
  } finally {
    await h.cleanup()
  }
})

test('a cap lowered while a queued sweep is prepared, its row already running, puts it back where it stood, with the time it first waited', async () => {
  const { launch, folders } = heldFolders()
  const h = await harness({ launch, config: { maxConcurrentReviews: 2 } })
  try {
    const leaving = await h.runs.start(review(113))
    const staying = await h.runs.start(review(118))
    const queued = await h.launcher.start(start())
    const behind = await h.runs.start(review(127))
    assert.deepEqual([queued.status, behind.status], ['queued', 'queued'])
    h.time.advance(60_000)
    // a slot frees, the sweep's checks pass, and its folder is held
    folders.arm()
    h.launch.children[0]!.exit(1)
    await h.runs.settled(leaving.id)
    await waitFor(() => folders.held() === 1)
    const marked = h.cache.getSweep(queued.id)!
    assert.equal(marked.status, 'running')
    assert.notEqual(marked.startedAt, queued.startedAt)
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 1 }
    h.launcher.drain()
    folders.open(0)
    await waitFor(() => h.cache.getSweep(queued.id)?.status === 'queued')
    await quiet()
    assert.deepEqual(startOrder(h), [113, 118])
    const waiting = h.cache.getSweep(queued.id)!
    assert.deepEqual([waiting.pid, waiting.finishedAt, waiting.note, waiting.startedAt], [null, null, null, queued.startedAt])
    assert.equal(h.changes.at(-1)?.status, 'queued')
    // the running review alone holds a slot: the launch's end released the attempt's, and nothing else went with it
    assert.deepEqual(h.line.inFlight(), ['review'])
    assert.equal(h.cache.getRun(behind.id)?.status, 'queued')
    // it makes its checks again when it is next given a slot, and starts ahead of the review behind it
    const calls = h.launch.gitCalls.length
    h.launch.children[1]!.exit(1)
    await h.runs.settled(staying.id)
    await waitFor(() => h.launch.children.length === 3)
    assert.deepEqual(startOrder(h), [113, 118, 'sweep'])
    assert.equal(h.launch.gitCalls.length, calls + 1)
    const started = h.cache.getSweep(queued.id)!
    assert.equal(started.status, 'running')
    assert.notEqual(started.startedAt, queued.startedAt)
    assert.equal(h.cache.getRun(behind.id)?.status, 'queued')
    h.launch.children[2]!.exit(1)
    await h.launcher.settled(queued.id)
    await waitFor(() => h.launch.children.length === 4)
    assert.deepEqual(startOrder(h), [113, 118, 'sweep', 127])
  } finally {
    await h.cleanup()
  }
})

test('a sweep sent back by a lowered cap starts again as soon as a saved cap has room', async () => {
  const { launch, folders } = heldFolders()
  const h = await harness({ launch, config: { maxConcurrentReviews: 2 } })
  try {
    await h.runs.start(review(113))
    folders.arm()
    const pending = h.launcher.start(start())
    await waitFor(() => folders.held() === 1)
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 1 }
    folders.open(0)
    const sent = await within(pending)
    assert.equal(sent.status, 'queued')
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 2 }
    h.launcher.drain()
    await waitFor(() => h.launch.children.length === 2)
    assert.deepEqual(startOrder(h), [113, 'sweep'])
    assert.equal(h.cache.getSweep(sent.id)?.status, 'running')
  } finally {
    await h.cleanup()
  }
})

test('a Stop finds a sweep sent back by a lowered cap in the line, and takes it out', async () => {
  const { launch, folders } = heldFolders()
  const h = await harness({ launch, config: { maxConcurrentReviews: 2 } })
  try {
    await h.runs.start(review(113))
    folders.arm()
    const pending = h.launcher.start(start())
    await waitFor(() => folders.held() === 1)
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 1 }
    folders.open(0)
    const sent = await within(pending)
    assert.equal(sent.status, 'queued')
    assert.equal(h.launcher.stop(sent.id).status, 'stopped')
    // nothing is left in the line for a slot to start: only the running review still counts
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 2 }
    h.launcher.drain()
    await quiet()
    assert.deepEqual(startOrder(h), [113])
    assert.deepEqual(h.line.inFlight(), ['review'])
  } finally {
    await h.cleanup()
  }
})

test('a Stop asked during the launch ends a sweep the lowered cap would have sent back: it never spawns, and the next in line goes', async () => {
  const { launch, folders } = heldFolders()
  const h = await harness({ launch, config: { maxConcurrentReviews: 2 } })
  try {
    const running = await h.runs.start(review(113))
    const releasedBefore = h.released.length
    folders.arm()
    const pending = h.launcher.start(start())
    await waitFor(() => folders.held() === 1)
    const behind = await h.runs.start(review(118))
    const row = h.cache.sweepsFor(scenario.repo)[0]!
    assert.equal(h.launcher.stop(row.id).status, 'running')
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 1 }
    folders.open(0)
    const answered = await within(pending)
    assert.deepEqual([answered.id, answered.status], [row.id, 'stopped'])
    assert.equal(h.cache.getSweep(row.id)?.status, 'stopped')
    assert.equal((await within(h.launcher.settled(row.id))).status, 'stopped')
    assert.deepEqual(startOrder(h), [113])
    assert.equal(h.released.length, releasedBefore + 1)
    h.launch.children[0]!.exit(1)
    await h.runs.settled(running.id)
    await waitFor(() => h.launch.children.length === 2)
    assert.deepEqual(startOrder(h), [113, 118])
    assert.equal(h.cache.getRun(behind.id)?.status, 'running')
  } finally {
    await h.cleanup()
  }
})

test('a write the database refuses as a sweep goes back fails it as spawnFailed: it never spawns, and its slot is released', async () => {
  const { launch, folders } = heldFolders()
  const h = await harness({ launch, config: { maxConcurrentReviews: 2 } })
  const updateSweep = h.cache.updateSweep
  h.cache.updateSweep = (id, changes) => {
    if (changes.status === 'queued') throw new Error('attempt to write a readonly database')
    return updateSweep(id, changes)
  }
  const { sweeps, runs, line } = h.pair()
  h.cache.updateSweep = updateSweep
  try {
    await runs.start(review(113))
    const releasedBefore = h.released.length
    folders.arm()
    const pending = sweeps.start(start())
    await waitFor(() => folders.held() === 1)
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 1 }
    folders.open(0)
    const answered = await within(pending)
    assert.deepEqual([answered.status, answered.note], ['failed', 'spawnFailed: attempt to write a readonly database'])
    assert.deepEqual(startOrder(h), [113])
    assert.equal(h.released.length, releasedBefore + 1)
    assert.deepEqual(line.inFlight(), ['review'])
  } finally {
    await h.cleanup()
  }
})

test('a lowered cap that still has room for a launching sweep does not send it back: the entry behind it gives its slot back instead', async () => {
  const { launch, folders } = heldFolders()
  const h = await harness({ launch, config: { maxConcurrentReviews: 3 } })
  try {
    await h.runs.start(review(113))
    folders.arm()
    const pending = h.launcher.start(start())
    await waitFor(() => folders.held() === 1)
    // this one is let in behind the launch, and holds a slot of its own while it waits for it
    const behind = await h.runs.start(review(118))
    assert.equal(behind.status, 'queued')
    assert.equal(h.line.inFlight().length, 3)
    await quiet()
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 2 }
    folders.open(0)
    const answered = await within(pending)
    assert.equal(answered.status, 'running')
    await quiet()
    assert.deepEqual(startOrder(h), [113, 'sweep'])
    assert.equal(h.cache.getRun(behind.id)?.status, 'queued')
    assert.deepEqual(h.line.inFlight(), ['review', 'review'])
  } finally {
    await h.cleanup()
  }
})

test('one sweep per repository still holds: a queued sweep holds its repository, and a second start is refused until it leaves', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  try {
    await h.runs.start(review(113))
    const queued = await h.launcher.start(start())
    await assert.rejects(h.launcher.start(start()), (error: unknown) => error instanceof LaunchError && error.code === 'busy')
    assert.deepEqual(h.cache.sweepsFor(scenario.repo).map((sweep) => sweep.id), [queued.id])
    assert.equal(sweepsView(h.settings.current, memoryOf(h)).start.unavailable, `a sweep for ${scenario.repo} is already in flight`)
    h.launcher.stop(queued.id)
    assert.equal(sweepsView(h.settings.current, memoryOf(h)).start.unavailable, null)
    assert.equal((await h.launcher.start(start())).status, 'queued')
  } finally {
    await h.cleanup()
  }
})

test('a Fix session and an Update session neither count nor wait beside a queued sweep, and a PR\'s own one-run rule is unchanged', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  try {
    const sweep = await h.launcher.start(start())
    await h.runs.start(review(113))
    const fix = await h.runs.start({ repo: scenario.repo, number: 101, command: 'fix-pr', args: ['101'], label: 'Fix session', runner: 'claude' })
    assert.equal(fix.status, 'running')
    await assert.rejects(h.runs.start(review(113)), (error: unknown) => error instanceof LaunchError && error.code === 'busy')
    // the Fix session's end frees nothing: the sweep still holds the one slot
    h.launch.children.at(-1)!.exit(1)
    await h.runs.settled(fix.id)
    await quiet()
    assert.equal(h.runs.queueing().review, true)
    assert.equal(h.launch.children.length, 2)
    assert.equal(sweep.status, 'running')
  } finally {
    await h.cleanup()
  }
})

test('Stop of a queued sweep records it stopped, takes it out of the line at once, and hands nothing it never held', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  try {
    const running = await h.runs.start(review(113))
    const sweep = await h.launcher.start(start())
    const behind = await h.runs.start(review(118))
    const stopped = h.launcher.stop(sweep.id)
    assert.deepEqual([stopped.status, stopped.pid], ['stopped', null])
    assert.notEqual(stopped.finishedAt, null)
    assert.equal(h.launch.kills.length, 0)
    assert.equal((await within(h.launcher.settled(sweep.id))).status, 'stopped')
    assert.equal(h.changes.at(-1)?.status, 'stopped')
    // nothing else starts: the slot is still the running review's
    await quiet()
    assert.equal(h.launch.children.length, 1)
    // the next in line is now the review behind it
    h.launch.children[0]!.exit(1)
    await h.runs.settled(running.id)
    await waitFor(() => h.launch.children.length === 2)
    assert.deepEqual(startOrder(h), [113, 118])
    assert.equal(h.cache.getRun(behind.id)?.status, 'running')
    await assert.rejects(async () => h.launcher.stop(sweep.id), (error: unknown) => error instanceof LaunchError && error.code === 'notRunning')
  } finally {
    await h.cleanup()
  }
})

test('Stop of the queued sweep holding the line lets the self-review behind it go, within the cap', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1, selfReviewOverCap: true } })
  try {
    h.cache.writePr(scenario.repo, await prOf(101), scenario.defaultBranch)
    await h.runs.start(review(113))
    const sweep = await h.launcher.start(start())
    await h.runs.start(review(101, { args: ['101', '--no-post'], label: 'Self-review' }))
    assert.deepEqual(startOrder(h), [113])
    h.launcher.stop(sweep.id)
    await waitFor(() => h.launch.children.length === 2)
    assert.deepEqual(startOrder(h), [113, 101])
  } finally {
    await h.cleanup()
  }
})

test('a Stop of a queued sweep whose write is refused changes nothing: it keeps its place and starts when a slot is free', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  const updateSweep = h.cache.updateSweep
  let refusing = false
  h.cache.updateSweep = (id, changes) => {
    if (refusing && changes.status === 'stopped') throw new Error('attempt to write a readonly database')
    return updateSweep(id, changes)
  }
  const { sweeps, runs } = h.pair()
  h.cache.updateSweep = updateSweep
  try {
    const running = await runs.start(review(113))
    const sweep = await sweeps.start(start())
    const behind = await runs.start(review(118))
    refusing = true
    assert.throws(() => sweeps.stop(sweep.id), /readonly/)
    assert.equal(h.cache.getSweep(sweep.id)?.status, 'queued')
    refusing = false
    h.launch.children[0]!.exit(1)
    await runs.settled(running.id)
    await waitFor(() => h.launch.children.length === 2)
    assert.deepEqual(startOrder(h), [113, 'sweep'])
    assert.equal(h.cache.getRun(behind.id)?.status, 'queued')
  } finally {
    sweeps.close()
    runs.close()
    await h.cleanup()
  }
})

test('a run and a sweep with the same id are two entries in the line: stopping one never takes the other out', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  try {
    const running = await h.launcher.start(start())
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(running.id)
    // sweep 2 and run 2 both wait, behind a run that holds the slot
    const holder = await h.runs.start(review(113))
    const queuedRun = await h.runs.start(review(118))
    const queuedSweep = await h.launcher.start(start())
    assert.equal(queuedRun.id, queuedSweep.id)
    h.launcher.stop(queuedSweep.id)
    assert.equal(h.cache.getRun(queuedRun.id)?.status, 'queued')
    assert.equal(h.cache.getSweep(queuedSweep.id)?.status, 'stopped')
    h.launch.children[1]!.exit(1)
    await h.runs.settled(holder.id)
    await waitFor(() => h.launch.children.length === 3)
    assert.equal(startOrder(h)[2], 118)
  } finally {
    await h.cleanup()
  }
})

test('a sweep starting from the queue with a Stop asked during its second checks ends that attempt and frees its slot', async () => {
  const accounts = armedGate()
  const h = await harness({ config: { maxConcurrentReviews: 1 }, gh: gatedGh(accounts, { current: scenario.viewer }) })
  try {
    const running = await h.runs.start(review(113))
    const sweep = await h.launcher.start(start())
    const behind = await h.runs.start(review(118))
    accounts.arm()
    h.launch.children[0]!.exit(1)
    await h.runs.settled(running.id)
    await waitFor(() => accounts.held() === 1)
    h.launcher.stop(sweep.id)
    assert.equal(h.cache.getSweep(sweep.id)?.status, 'stopped')
    await waitFor(() => h.launch.children.length === 2)
    assert.deepEqual(startOrder(h), [113, 118])
    // the late end of its checks changes nothing
    accounts.open(0)
    await quiet()
    assert.equal(h.cache.getRun(behind.id)?.status, 'running')
    assert.equal(h.launch.children.length, 2)
  } finally {
    await h.cleanup()
  }
})

test('a Stop of a sweep that started from the queue signals it and hands its slot on when it settles', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  try {
    const running = await h.runs.start(review(113))
    const sweep = await h.launcher.start(start())
    const behind = await h.runs.start(review(118))
    assert.equal(sweep.status, 'queued')
    h.launch.children[0]!.exit(1)
    await h.runs.settled(running.id)
    await waitFor(() => h.cache.getSweep(sweep.id)?.pid != null)
    assert.equal(h.launcher.stop(sweep.id).status, 'running')
    await waitFor(() => h.launch.kills.length === 1)
    assert.deepEqual(h.launch.kills.map((kill) => kill.signal), ['SIGTERM'])
    h.launch.children[1]!.exit(0, 'SIGTERM')
    assert.equal((await h.launcher.settled(sweep.id)).status, 'stopped')
    await waitFor(() => h.launch.children.length === 3)
    assert.equal(h.cache.getRun(behind.id)?.status, 'running')
  } finally {
    await h.cleanup()
  }
})

test('after a restart a sweep still queued fails as serverRestarted, like a queued manual review, and nothing starts', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  try {
    await h.runs.start(review(113))
    const queuedRun = await h.runs.start(review(118))
    const queuedSweep = await h.launcher.start(start())
    h.launcher.close()
    h.runs.close()
    const next = h.pair()
    await next.runs.recover()
    await next.sweeps.recover()
    const failed = h.cache.getSweep(queuedSweep.id)
    assert.deepEqual([failed?.status, failed?.note], ['failed', 'serverRestarted: it was still queued, so it never started'])
    assert.equal(sweepText(failed!), 'Failed · server restarted')
    assert.notEqual(failed?.finishedAt, null)
    assert.equal(h.cache.getRun(queuedRun.id)?.note, 'serverRestarted: it was still queued, so it never started')
    assert.equal(h.launch.children.length, 1)
    assert.deepEqual(h.cache.queuedSweeps(), [])
    assert.equal((await within(next.sweeps.settled(queuedSweep.id))).status, 'failed')
    // the repository may sweep again
    assert.equal(sweepsView(h.settings.current, memoryOf(h)).start.unavailable, null)
    next.runs.close()
    next.sweeps.close()
  } finally {
    await h.cleanup()
  }
})

test('after a restart a sweep whose process lives holds its slot again, whichever engine recovers first, and a review behind it waits', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  try {
    const sweep = await h.launcher.start(start())
    await waitFor(() => h.cache.getSweep(sweep.id)?.pidStartedAt != null)
    h.launcher.close()
    h.runs.close()
    const next = h.pair()
    await next.runs.recover()
    await next.sweeps.recover()
    assert.equal(next.runs.queueing().review, true)
    const queued = await next.runs.start(review(113))
    assert.equal(queued.status, 'queued')
    assert.equal(h.launch.children.length, 1)
    next.runs.close()
    next.sweeps.close()
  } finally {
    await h.cleanup()
  }
})

test('a recovered sweep whose pid now has another start time settles at the next poll, unsignaled, and its slot goes to the next in line', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  try {
    const sweep = await h.launcher.start(start())
    await waitFor(() => h.cache.getSweep(sweep.id)?.pidStartedAt != null)
    const pid = h.launch.children[0]!.pid
    h.launcher.close()
    h.runs.close()
    const next = h.pair()
    await next.sweeps.recover()
    await next.runs.recover()
    const queued = await next.runs.start(review(113))
    assert.equal(queued.status, 'queued')
    h.launch.startTimes.set(pid, 'a replacement')
    const settled = next.sweeps.settled(sweep.id)
    h.time.advance(10 * second)
    assert.equal((await within(settled)).status, 'failed')
    assert.deepEqual(h.launch.kills, [])
    assert.ok(h.launch.alive.has(pid), 'the replacement is never signaled')
    await waitFor(() => h.cache.getRun(queued.id)?.status === 'running')
    next.runs.close()
    next.sweeps.close()
  } finally {
    await h.cleanup()
  }
})

test('Stop on a sweep whose pid gets another start time sends no signal before the SIGTERM or the SIGKILL, and settles it stopped', async () => {
  const h = await harness()
  try {
    const first = await h.launcher.start(start())
    const firstPid = h.launch.children[0]!.pid
    h.launch.startTimes.set(firstPid, 'a replacement')
    const firstSettled = h.launcher.settled(first.id)
    assert.equal(h.launcher.stop(first.id).status, 'running')
    assert.equal((await within(firstSettled)).status, 'stopped')
    assert.deepEqual(h.launch.kills, [])

    const later = await h.launcher.start(start())
    const laterPid = h.launch.children[1]!.pid
    h.launch.ignoreTerm.add(laterPid)
    const laterSettled = h.launcher.settled(later.id)
    h.launcher.stop(later.id)
    await waitFor(() => h.launch.kills.length === 1)
    h.launch.startTimes.set(laterPid, 'a replacement')
    h.time.advance(10 * second)
    assert.equal((await within(laterSettled)).status, 'stopped')
    assert.deepEqual(h.launch.kills, [{ pid: -laterPid, signal: 'SIGTERM' }])
  } finally {
    await h.cleanup()
  }
})

test('after a restart a review whose process lives holds its slot, so a new sweep waits behind it', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  try {
    const run = await h.runs.start(review(113))
    await waitFor(() => h.cache.getRun(run.id)?.pidStartedAt != null)
    h.launcher.close()
    h.runs.close()
    const next = h.pair()
    await next.sweeps.recover()
    await next.runs.recover()
    assert.equal((await next.sweeps.start(start())).status, 'queued')
    next.runs.close()
    next.sweeps.close()
  } finally {
    await h.cleanup()
  }
})

test('a sweep and a review in different repositories share the cap, whichever is on show', async () => {
  const other = 'octo-example/nebula'
  const h = await harness({ config: { maxConcurrentReviews: 1 }, launch: fakeLaunch({ remotes: `${fakeRemotes(scenario.repo)}${fakeRemotes(other)}` }) })
  try {
    const sweep = await h.launcher.start(start())
    h.settings.current = { ...h.settings.current, repo: other }
    assert.equal(h.runs.queueing().review, true)
    const queued = await h.runs.start(review(113, { repo: other }))
    assert.equal(queued.status, 'queued')
    assert.equal(h.launch.children.length, 1)
    // the sweep of the first repository ends: the review of the other takes its slot
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(sweep.id)
    await waitFor(() => h.launch.children.length === 2)
    assert.equal(h.cache.getRun(queued.id)?.status, 'running')

    // and the other way around: a sweep of this repository waits behind the other's review, and one per repository is per repository
    const otherSweep = await h.launcher.start(sweepRequest(other))
    assert.equal(otherSweep.status, 'queued')
    h.settings.current = { ...h.settings.current, repo: scenario.repo }
    h.launcher.drain()
    // a queued sweep's repository is no longer the one in effect, so it never starts: it fails, and the slot is unaffected
    await waitFor(() => h.cache.getSweep(otherSweep.id)?.status === 'failed')
    assert.equal(h.cache.getSweep(otherSweep.id)?.note, `spawnFailed: not started: the repository is now ${scenario.repo}, not ${other}`)
    assert.equal(h.runs.queueing().review, true)
    assert.equal(h.launch.children.length, 2)
  } finally {
    await h.cleanup()
  }
})

test('a queued sweep starts only for the viewer it was confirmed for, and only after its identity check passes again', async () => {
  const login = { current: scenario.viewer as string }
  const accounts = armedGate()
  const h = await harness({ config: { maxConcurrentReviews: 1 }, gh: gatedGh(accounts, login) })
  try {
    const running = await h.runs.start(review(113))
    const sweep = await h.launcher.start(start())
    const behind = await h.runs.start(review(118))
    login.current = 'someone-else'
    h.launch.children[0]!.exit(1)
    await h.runs.settled(running.id)
    await waitFor(() => h.cache.getSweep(sweep.id)?.status === 'failed')
    assert.match(h.cache.getSweep(sweep.id)?.note ?? '', /^spawnFailed: gh is signed in as someone-else/)
    // the next in line has the same check to pass
    await waitFor(() => h.cache.getRun(behind.id)?.status === 'failed')
    assert.equal(h.launch.children.length, 1)
  } finally {
    await h.cleanup()
  }
})

test('both writes of a sweep\'s ending failing still release its slot: the next in line starts, whoever awaits it is answered, and its row stays running', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  const updateSweep = h.cache.updateSweep
  let refused = 0
  h.cache.updateSweep = (id, changes) => {
    if (changes.status === 'failed') {
      refused += 1
      throw new Error('attempt to write a readonly database')
    }
    return updateSweep(id, changes)
  }
  const { sweeps, runs } = h.pair()
  h.cache.updateSweep = updateSweep
  try {
    const sweep = await sweeps.start(start())
    const behind = await runs.start(review(113))
    assert.equal(behind.status, 'queued')
    const settled = sweeps.settled(sweep.id)
    h.launch.children[0]!.exit(1)
    const ended = await within(settled)
    assert.equal(refused, 2)
    assert.equal(ended.status, 'failed')
    assert.equal((await within(sweeps.settled(sweep.id))).status, 'failed')
    assert.equal(h.cache.getSweep(sweep.id)?.status, 'running')
    await waitFor(() => h.launch.children.length === 2)
    assert.equal(h.cache.getRun(behind.id)?.status, 'running')
    // no count of it is left behind: one slot, held by the review alone
    h.launch.children[1]!.exit(1)
    await runs.settled(behind.id)
    await waitFor(() => !runs.queueing().review)
    // its row keeps its repository until a Stop records it
    await assert.rejects(sweeps.start(start()), (error: unknown) => error instanceof LaunchError && error.code === 'busy')
    assert.equal(sweeps.stop(sweep.id).status, 'stopped')
  } finally {
    sweeps.close()
    runs.close()
    await h.cleanup()
  }
})

test('both writes of a review\'s ending failing still hand its slot to the sweep next in line', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  const updateRun = h.cache.updateRun
  h.cache.updateRun = (id, changes) => {
    if (changes.status === 'failed') throw new Error('attempt to write a readonly database')
    return updateRun(id, changes)
  }
  const { sweeps, runs } = h.pair()
  h.cache.updateRun = updateRun
  try {
    const running = await runs.start(review(113))
    const sweep = await sweeps.start(start())
    assert.equal(sweep.status, 'queued')
    const settled = runs.settled(running.id)
    h.launch.children[0]!.exit(1)
    assert.equal((await within(settled)).status, 'failed')
    assert.equal(h.cache.getRun(running.id)?.status, 'running')
    await waitFor(() => h.launch.children.length === 2)
    assert.deepEqual(startOrder(h), [113, 'sweep'])
    assert.equal(h.cache.getSweep(sweep.id)?.status, 'running')
  } finally {
    sweeps.close()
    runs.close()
    await h.cleanup()
  }
})

test('a queued sweep whose failure cannot be recorded still leaves the queue for whoever awaits it, its row left queued for a restart to fail', async () => {
  const login = { current: scenario.viewer as string }
  const h = await harness({ config: { maxConcurrentReviews: 1 }, gh: gatedGh(armedGate(), login) })
  const updateSweep = h.cache.updateSweep
  h.cache.updateSweep = (id, changes) => {
    if (changes.status === 'failed') throw new Error('attempt to write a readonly database')
    return updateSweep(id, changes)
  }
  const { sweeps, runs } = h.pair()
  h.cache.updateSweep = updateSweep
  try {
    const running = await runs.start(review(113))
    const sweep = await sweeps.start(start())
    const waiting = sweeps.settled(sweep.id)
    login.current = 'someone-else'
    h.launch.children[0]!.exit(1)
    await runs.settled(running.id)
    const failed = await within(waiting)
    assert.equal(failed.status, 'failed')
    assert.match(failed.note ?? '', /^spawnFailed: gh is signed in as someone-else/)
    assert.equal(h.cache.getSweep(sweep.id)?.status, 'queued')
    login.current = scenario.viewer
    // the line moved on: a new review with room starts, the failed sweep is never tried again
    await waitFor(() => !runs.queueing().review)
    assert.equal((await runs.start(review(118))).status, 'running')
    assert.deepEqual(startOrder(h), [113, 118])
    // the next start of the server fails the row as it fails any sweep still queued
    sweeps.close()
    runs.close()
    const next = h.pair()
    await next.sweeps.recover()
    next.sweeps.close()
    next.runs.close()
    assert.equal(h.cache.getSweep(sweep.id)?.note, 'serverRestarted: it was still queued, so it never started')
  } finally {
    sweeps.close()
    runs.close()
    await h.cleanup()
  }
})

test('a queued sweep whose launch fails at once hands its slot on, and a sweep whose row cannot be marked running fails and never spawns', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  const updateSweep = h.cache.updateSweep
  let refuseRunning = false
  h.cache.updateSweep = (id, changes) => {
    if (refuseRunning && changes.status === 'running') throw new Error('attempt to write a readonly database')
    return updateSweep(id, changes)
  }
  const { sweeps, runs } = h.pair()
  h.cache.updateSweep = updateSweep
  try {
    const running = await runs.start(review(113))
    const sweep = await sweeps.start(start())
    const behind = await runs.start(review(118))
    refuseRunning = true
    h.launch.children[0]!.exit(1)
    await runs.settled(running.id)
    await waitFor(() => h.cache.getSweep(sweep.id)?.status === 'failed')
    assert.equal(h.cache.getSweep(sweep.id)?.note, 'spawnFailed: attempt to write a readonly database')
    await waitFor(() => h.launch.children.length === 2)
    assert.deepEqual(startOrder(h), [113, 118])
    assert.equal(h.cache.getRun(behind.id)?.status, 'running')

    // and a spawn that fails frees the slot too
    refuseRunning = false
    const next = await sweeps.start(start())
    assert.equal(next.status, 'queued')
    h.launch.spawnError = new Error('spawn claude ENOENT')
    h.launch.children[1]!.exit(1)
    await runs.settled(behind.id)
    await waitFor(() => h.cache.getSweep(next.id)?.status === 'failed')
    assert.match(h.cache.getSweep(next.id)?.note ?? '', /^spawnFailed: spawn claude ENOENT/)
    await waitFor(() => !runs.queueing().review)
  } finally {
    sweeps.close()
    runs.close()
    await h.cleanup()
  }
})

test('the cache keeps a queued sweep through a prune and lists it as queued, not running', async () => {
  const time = fakeTime()
  const cache = openCache({ path: ':memory:', clock: time.clock, keepSweeps: 1 })
  try {
    const row = (status: Sweep['status']): Sweep => cache.createSweep({
      repo: scenario.repo, command: 'review-dependabot-sweep', args: [], label: 'Dependabot sweep', runner: 'claude', cwd: '~/dev/orbit', sessionId: null, pid: null, pidStartedAt: null,
      startedAt: '2026-10-26T14:00:00Z', lastStepAt: null, step: null, stepState: null, finishedAt: null, status, result: null, note: null, costUsd: null, resume: null,
    }, (id) => `~/.local/state/pit-view/sweeps/${id}`)
    const queued = row('queued')
    const done = row('done')
    row('done')
    assert.deepEqual(cache.queuedSweeps().map((sweep) => sweep.id), [queued.id])
    assert.deepEqual(cache.runningSweeps(), [])
    assert.deepEqual(cache.pruneSweeps().map((sweep) => sweep.id), [done.id])
    assert.notEqual(cache.getSweep(queued.id), null)
  } finally {
    cache.close()
  }
})

test('a sweep moving a slot is announced through the one listener, coalesced, whatever the answer was before; a sweep\'s step moves nothing', async () => {
  let told = 0
  const h = await harness({ config: { maxConcurrentReviews: 2 }, onQueueing: () => { told += 1 } })
  try {
    await h.launcher.flushed()
    told = 0
    const sweep = await h.launcher.start(start())
    await h.runs.flushed()
    await h.launcher.flushed()
    assert.equal(told >= 1, true)
    // nothing is remembered: a second review moves the count and is told, with the answer changing or not
    told = 0
    const run = await h.runs.start(review(113))
    await h.runs.flushed()
    await h.launcher.flushed()
    assert.equal(told >= 1, true)
    // a step of the sweep is no change of the accounting
    await h.launcher.flushed()
    told = 0
    await h.launch.children[0]!.events({ at: '2026-10-26T14:06:00Z', step: 'resolveBase', state: 'done', note: null })
    await h.launcher.check()
    await h.launcher.flushed()
    assert.equal(told, 0)
    assert.equal(h.changes.at(-1)?.step, 'resolveBase')
    // its end does move it, in one coalesced call for the whole burst
    told = 0
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(sweep.id)
    await h.launcher.flushed()
    assert.equal(told, 1)
    assert.equal(run.status, 'running')
  } finally {
    await h.cleanup()
  }
})

test('a listener that throws is told again a bounded number of times, whichever engine moved the count', async () => {
  let attempts = 0
  const h = await harness({ onQueueing: () => {
    attempts += 1
    throw new Error('stream closed')
  } })
  try {
    await h.launcher.start(start())
    await h.launcher.flushed()
    assert.ok(attempts >= 1)
    // the delays are 50, 200, and 800 ms, after which it gives up until the next event
    for (const delay of [50, 200, 800]) {
      h.time.advance(delay)
      await h.runs.flushed()
    }
    assert.ok(attempts <= 4 + 1, `${attempts} attempts`)
    const gaveUp = attempts
    h.time.advance(5000)
    await h.runs.flushed()
    assert.equal(attempts, gaveUp)
    // the next event, in the other engine, is told again
    await h.runs.start(review(113))
    await h.runs.flushed()
    assert.ok(attempts > gaveUp)
  } finally {
    await h.cleanup()
  }
})

test('closing both engines ends the announcements and leaves the rows as they were, for the next server start to find', async () => {
  let told = 0
  const h = await harness({ config: { maxConcurrentReviews: 1 }, onQueueing: () => { told += 1 } })
  try {
    const sweep = await h.launcher.start(start())
    const run = await h.runs.start(review(113))
    h.launcher.close()
    h.runs.close()
    await h.runs.flushed()
    told = 0
    h.launch.children[0]!.exit(1)
    await quiet()
    assert.equal(told, 0)
    assert.equal(h.cache.getSweep(sweep.id)?.status, 'running')
    assert.equal(h.cache.getRun(run.id)?.status, 'queued')
    assert.equal(h.launch.children.length, 1)
  } finally {
    await h.cleanup()
  }
})

const memoryOf = (h: { cache: ReturnType<typeof openCache> }) => createSweepMemory(h.cache)

test('a queued sweep reads as waiting everywhere the view carries it, and Run sweep reads Queue sweep while a sweep would wait', () => {
  const config = baseConfig()
  const plain = sweepStartOf(config, false)
  assert.deepEqual([plain.button, plain.name], ['Run sweep', `Run a Dependabot sweep of ${scenario.repo}`])
  const waiting = sweepStartOf(config, false, true)
  assert.deepEqual([waiting.button, waiting.name], ['Queue sweep', `Queue a Dependabot sweep of ${scenario.repo}`])
  assert.equal(sweepText({ status: 'queued', result: null, note: null }), null)
  const cache = openCache({ path: ':memory:', clock: fakeTime().clock })
  try {
    const queued = cache.createSweep({
      repo: scenario.repo, command: 'review-dependabot-sweep', args: [], label: 'Dependabot sweep', runner: 'claude', cwd: '~/dev/orbit', sessionId: null, pid: null, pidStartedAt: null,
      startedAt: '2026-10-26T14:00:00Z', lastStepAt: null, step: null, stepState: null, finishedAt: null, status: 'queued', result: null, note: null, costUsd: null, resume: null,
    }, (id) => `~/.local/state/pit-view/sweeps/${id}`)
    const memory = createSweepMemory(cache)
    // the view's busy and its wording come from what it is given, for one answer each
    const view = sweepsView(config, memory, { review: true, selfReview: false })
    assert.equal(view.start.unavailable, `a sweep for ${scenario.repo} is already in flight`)
    assert.equal(view.start.button, 'Queue sweep')
    assert.equal(sweepsView(config, memory, { review: false, selfReview: true }).start.button, 'Run sweep')
    assert.equal(sweepsView(config, memory).start.button, 'Run sweep')
    assert.equal(sweepView(queued).text, null)
  } finally {
    cache.close()
  }
})
