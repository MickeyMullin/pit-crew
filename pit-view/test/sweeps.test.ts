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
import { createLauncher, createSweepLauncher, LaunchError, parseResult } from '../src/launcher.ts'
import type { StartRequest } from '../src/launcher.ts'
import { createSweepMemory, sweepRequest, sweepStartOf, sweepText, sweepView, sweepsView } from '../src/sweeps.ts'
import { scenario } from './fixtures/scenario.ts'
import { emptySweepResult, fakeLaunch, fakeRunner, fakeTime, fixtureRunner, ok, reviewResult, sweepHead201, sweepResult, tempDir } from './helpers.ts'
import type { FakeLaunch, FakeRunner } from './helpers.ts'

const second = 1000

const baseConfig = (): Config => ({ ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit' })

type HarnessOptions = { config?: Partial<Config>, launch?: FakeLaunch, gh?: FakeRunner }

// the sweep launcher with fake processes and a real temp folder, beside a run launcher on the same cache
const harness = async ({ config = {}, launch = fakeLaunch(), gh = fixtureRunner() }: HarnessOptions = {}) => {
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
  const make = () => createSweepLauncher({ ...options, onWatch: (sweep) => watched.push(sweep.id), onChange: (sweep) => changes.push(sweep) })
  const launcher = make()
  const runs = createLauncher({ ...options, onWatch: () => {}, onChange: () => {} })
  const cleanup = async (): Promise<void> => {
    launcher.close()
    runs.close()
    cache.close()
    await temp.cleanup()
  }
  return { home, time, cache, launcher, runs, make, changes, watched, settings, stateDir, launch, gh, cleanup }
}

const start = (runner?: StartRequest['runner']): StartRequest => sweepRequest(scenario.repo, runner)

test('a sweep launches review-dependabot-sweep for the repo with --parallel 1 and --emit-json, and never --no-post', async () => {
  const h = await harness()
  try {
    const sweep = await h.launcher.start(start())
    const runDir = join(h.stateDir, 'sweeps', String(sweep.id))
    const child = h.launch.children[0]!
    // the argv Claude receives, and the one stdin line that carries the request
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
    // the same checks as a run's start: one identity call, one clone check
    assert.deepEqual(h.gh.calls.filter((call) => call.args[0] === 'api').map((call) => call.args), [['api', 'user', '--jq', '.login']])
    assert.equal(h.launch.gitCalls.length, 1)
    assert.deepEqual(h.watched, [sweep.id])
  } finally {
    await h.cleanup()
  }
})

test('Codex gets the same sweep as a $ skill, still serial and never --no-post', async () => {
  const h = await harness({ config: { agent: { runner: 'codex' } } })
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

test('a start is refused for another gh account, an unset cloneDir and a folder that is not a clone, before anything runs', async () => {
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

test('a sweep settles done from result.json with its rows, counts and merge order', async () => {
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

test('after a restart a sweep whose process lives is watched again, and settles from its files', async () => {
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

test('after a restart a sweep whose process is gone settles from its result.json, and otherwise fails as serverRestarted', async () => {
  const h = await harness()
  try {
    const withResult = await h.launcher.start(start())
    const child = h.launch.children[0]!
    await writeFile(join(h.home, 'agents', 'output', 'dependabot-sweep-octo-example-orbit-2026-10-26.md'), '# sweep\n')
    await child.result(sweepResult())
    h.launcher.close()
    h.launch.alive.delete(child.pid)
    // the first sweep is recorded as running, with a result on disk; settle it, then start another and lose it
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

// the view, the start text and the memory

test('the confirmation names the repository, says the sweep is serial and that the reviewers may post as the viewer', () => {
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
  // not available while a sweep runs, or without a clone
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
  lastStepAt: null, step: null, stepState: null, steps: null, finishedAt: null, status: 'running', result: null, note: null, costUsd: null, resume: null, ...patch,
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
