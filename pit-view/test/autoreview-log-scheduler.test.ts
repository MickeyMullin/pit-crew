// test/autoreview-log-scheduler.test.ts
// the auto-review log through the real scheduler (section 10 of DESIGN.md, The log): each decision a tick, its start step, or a run's end makes becomes one line with its time, repository, PR, reason, head, and run; tick-level skips collapse into stretches; the log prunes on the tick, survives a restart, and is read from GET /api/auto-review/log; it changes nothing the scheduler decides, and a run the owner starts is not in it
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LogEntry } from '../src/autoreviewlog.ts'
import type { Run } from '../src/cache.ts'
import { scenario } from './fixtures/scenario.ts'
import { autoRuns, finish, running, saturday, save, setup, tick } from './scheduler-world.ts'
import type { World } from './scheduler-world.ts'

const day = 24 * 60 * 60_000

const logOf = async (world: World): Promise<{ days: number, entries: LogEntry[] }> => {
  const answer = await fetch(`${world.server.url}/api/auto-review/log`)
  assert.equal(answer.status, 200)
  return await answer.json() as { days: number, entries: LogEntry[] }
}

const entries = async (world: World): Promise<LogEntry[]> => (await logOf(world)).entries

const ofRun = (lines: readonly LogEntry[], run: Pick<Run, 'id'>, kind: 'run' | 'sweep' = 'run'): LogEntry[] => lines.filter((line) => line.run?.kind === kind && line.run.id === run.id)

const tickLines = (lines: readonly LogEntry[]): LogEntry[] => lines.filter((line) => line.lane === 'tick')

const failRun = async (world: World, run: Run, error: string): Promise<Run> =>
  await finish(world, run, { status: 'failed', error, reviewed: null, verdict: null, findings: [], report: null })

test('a tick that queues and starts: the check, each PR queued with its reason, head, tick, and run, the one started, and its end with the outcome in the cell\'s words', async () => {
  const world = await setup()
  try {
    await tick(world)
    const lines = await entries(world)
    const queued = autoRuns(world)
    assert.ok(queued.length > 1)
    const check = tickLines(lines)
    assert.equal(check.length, 1)
    assert.equal(check[0]?.decision, 'checked')
    assert.equal(check[0]?.reason, 'queued')
    assert.equal(check[0]?.repo, scenario.repo)
    assert.equal(check[0]?.tick, world.server.cache.latestTick(scenario.repo)?.id)
    assert.equal(check[0]?.at, '2026-10-26T14:20:38Z')
    for (const run of queued) {
      const mine = ofRun(lines, run)
      const queuedLine = mine.find((line) => line.decision === 'queued')
      assert.ok(queuedLine, `#${run.number} has a queued line`)
      assert.equal(queuedLine.lane, 'pr')
      assert.equal(queuedLine.repo, scenario.repo)
      assert.equal(queuedLine.number, run.number)
      assert.equal(queuedLine.reason, run.reason)
      assert.equal(queuedLine.head, run.headOid)
      assert.equal(queuedLine.tick, run.tick)
      assert.equal(queuedLine.at, run.queuedAt)
      // the title as the cache had it
      assert.equal(queuedLine.title, world.server.cache.readView(scenario.repo).open.find((entry) => entry.number === run.number)?.pr.title)
    }
    const first = running(world)[0]
    assert.ok(first)
    assert.deepEqual(ofRun(lines, first).map((line) => line.decision).sort(), ['queued', 'started'])
    await finish(world, first, { reviewed: { kind: 'commit', sha: first.headOid }, verdict: 'changesRequested' })
    const ended = ofRun(await entries(world), first).find((line) => line.decision === 'finished')
    assert.ok(ended)
    assert.equal(ended.reason, 'done')
    assert.equal(ended.note, 'Changes requested · not posted')
    // newest first
    const all = await entries(world)
    assert.equal(all[0]?.decision, 'started', 'the next run, started by the end of the first, is the newest line')
  } finally {
    await world.cleanup()
  }
})

test('a PR already reviewed at its head, and one whose auto run waits, are skipped with the reason, one line each however many ticks see them', async () => {
  const world = await setup()
  try {
    await tick(world)
    const first = running(world)[0]
    assert.ok(first)
    await finish(world, first, { reviewed: { kind: 'commit', sha: first.headOid } })
    await tick(world)
    await tick(world)
    const lines = await entries(world)
    const reviewed = lines.filter((line) => line.number === first.number && line.decision === 'skipped')
    assert.deepEqual(reviewed.map((line) => [line.reason, line.head, line.count]), [['alreadyReviewed', first.headOid, 2]])
    const waiting = autoRuns(world).find((run) => run.status === 'queued')
    assert.ok(waiting)
    const held = lines.filter((line) => line.number === waiting.number && line.decision === 'skipped')
    assert.deepEqual(held.map((line) => [line.reason, line.count]), [['inFlight', 2]])
    // the skip names the run that caused it, so the line can link to it
    assert.deepEqual(held.map((line) => line.run), [{ kind: 'run', id: waiting.id }])
  } finally {
    await world.cleanup()
  }
})

test('tick-level skips collapse per reason and stretch: three ticks with the wrong gh login are one line, a missing clone starts another, and a good tick a third', async () => {
  const world = await setup()
  try {
    world.gh.login = 'somebody-else'
    await tick(world)
    await tick(world)
    await tick(world)
    world.gh.login = scenario.viewer
    world.git.state.remotes = null
    await tick(world)
    await tick(world)
    world.git.state.remotes = `origin\thttps://github.com/${scenario.repo}.git (fetch)\norigin\thttps://github.com/${scenario.repo}.git (push)\n`
    await tick(world)
    const lines = tickLines(await entries(world))
    assert.deepEqual(lines.map((line) => [line.decision, line.reason, line.count]), [['checked', 'queued', 1], ['skipped', 'noClone', 2], ['skipped', 'identityMismatch', 3]])
    const mismatch = lines[2]
    assert.equal(mismatch?.at, '2026-10-26T14:20:38Z')
    assert.equal(mismatch?.lastAt, '2026-10-26T14:50:38Z')
  } finally {
    await world.cleanup()
  }
})

test('a full cap is a tick-level skip too: ticks whose waiting runs found no room are one line, and the queued PRs one inFlight line each', async () => {
  const world = await setup({ auto: { concurrency: 1 } })
  try {
    await tick(world)
    await tick(world)
    await tick(world)
    const lines = tickLines(await entries(world))
    assert.deepEqual(lines.map((line) => [line.decision, line.reason, line.count]), [['skipped', 'capFull', 2], ['checked', 'queued', 1]])
  } finally {
    await world.cleanup()
  }
})

test('the daily limit: a tick that finds it reached is a dailyLimit skip, and the next ones join it', async () => {
  const world = await setup({ auto: { dailyLimit: 1 } })
  try {
    await tick(world)
    const first = running(world)[0]
    assert.ok(first)
    await finish(world, first, { reviewed: { kind: 'commit', sha: first.headOid } })
    await tick(world)
    await tick(world)
    const lines = tickLines(await entries(world))
    assert.deepEqual(lines.map((line) => [line.reason, line.count]), [['dailyLimit', 2], ['queued', 1]])
  } finally {
    await world.cleanup()
  }
})

test('outside hours and off: the closed window is one line until a tick runs, and turning auto-review off is a line of its own', async () => {
  const world = await setup({ now: saturday })
  try {
    // a restart while the window is closed adds nothing
    await world.restart()
    let lines = tickLines(await entries(world))
    assert.deepEqual(lines.map((line) => [line.decision, line.reason]), [['skipped', 'outsideHours']])
    assert.equal(lines[0]?.at, saturday)
    // Monday 09:00, then Monday 09:15
    world.time.advance(Date.parse('2026-10-26T13:00:00Z') - Date.parse(saturday))
    await world.server.scheduler.idle()
    await tick(world)
    assert.equal(await save(world, (config) => ({ ...config, autoReview: { ...config.autoReview!, enabled: false } })).then((answer) => answer.status), 200)
    lines = tickLines(await entries(world))
    assert.deepEqual(lines.map((line) => [line.decision, line.reason]), [['skipped', 'off'], ['skipped', 'capFull'], ['checked', 'queued'], ['skipped', 'outsideHours']])
  } finally {
    await world.cleanup()
  }
})

test('a window that closes after a tick is dated from its close: the night is one outsideHours line from 18:00 until the window opens, a save in the night included', async () => {
  // Monday 17:40 in New York, so the tick at 17:55 is the last the window allows
  const world = await setup({ now: '2026-10-26T21:40:00Z', auto: { dailyLimit: 0 } })
  try {
    await tick(world)
    assert.deepEqual(tickLines(await entries(world)).map((line) => [line.decision, line.reason]), [['checked', 'queued']])
    // a save at 20:00 plans again inside the night: the line stays dated from the close and now reaches 20:00
    world.time.advance(Date.parse('2026-10-27T00:00:00Z') - Date.parse('2026-10-26T21:55:00Z'))
    await world.server.scheduler.idle()
    assert.equal(await save(world, (config) => config).then((answer) => answer.status), 200)
    const evening = tickLines(await entries(world)).filter((line) => line.reason === 'outsideHours')
    assert.deepEqual(evening.map((line) => [line.at, line.lastAt]), [['2026-10-26T22:00:00Z', '2026-10-27T00:00:00Z']])
    // the night passes, and Tuesday 09:00 brings the first tick of the day
    world.time.advance(Date.parse('2026-10-27T13:00:00Z') - Date.parse('2026-10-27T00:00:00Z'))
    await world.server.scheduler.idle()
    const night = tickLines(await entries(world)).filter((line) => line.reason === 'outsideHours')
    assert.equal(night.length, 1)
    assert.equal(night[0]?.at, '2026-10-26T22:00:00Z')
    assert.equal(night[0]?.lastAt, '2026-10-27T13:00:00Z')
    // newest first: the morning's tick, whose waiting runs from the evening find no room, then the night, then the evening's tick
    assert.deepEqual(tickLines(await entries(world)).map((line) => [line.decision, line.reason]), [['skipped', 'capFull'], ['skipped', 'outsideHours'], ['checked', 'queued']])
  } finally {
    await world.cleanup()
  }
})

test('a queued PR that closed is dropped before start with the reason, and a queued self-review whose PR was marked ready too', async () => {
  const world = await setup({ auto: { others: false, own: true }, drafts: [101, 102] })
  try {
    await tick(world)
    const waiting = autoRuns(world).filter((run) => run.status === 'queued')
    assert.ok(waiting.length >= 2)
    const closing = waiting[0]!
    const readying = waiting[1]!
    world.server.cache.closePr(scenario.repo, closing.number)
    const row = world.server.cache.readView(scenario.repo).open.find((entry) => entry.number === readying.number)
    assert.ok(row)
    world.server.cache.writePr(scenario.repo, { ...row.pr, isDraft: false }, scenario.defaultBranch)
    await finish(world, running(world)[0]!)
    const lines = await entries(world)
    assert.deepEqual(ofRun(lines, closing).map((line) => [line.decision, line.reason]).filter(([decision]) => decision === 'dropped'), [['dropped', 'closed']])
    assert.deepEqual(ofRun(lines, readying).map((line) => [line.decision, line.reason]).filter(([decision]) => decision === 'dropped'), [['dropped', 'ready']])
  } finally {
    await world.cleanup()
  }
})

test('a run that fails, its retry, the retry failing, and the PR left as failed twice are each a line, and failedTwice is written once however many ticks find it', async () => {
  // the owner's one draft, so the queue holds nothing else
  const world = await setup({ auto: { others: false, own: true, dailyLimit: 100 } })
  try {
    await tick(world)
    const first = running(world)[0]
    assert.ok(first)
    assert.equal(first.number, 103)
    await failRun(world, first, 'the session gave up')
    await tick(world)
    const second = running(world)[0]
    assert.ok(second)
    await failRun(world, second, 'the session gave up again')
    await tick(world)
    await tick(world)
    const lines = await entries(world)
    assert.deepEqual(ofRun(lines, first).map((line) => line.decision).sort(), ['failed', 'queued', 'started'])
    assert.match(ofRun(lines, first).find((line) => line.decision === 'failed')?.note ?? '', /gave up/)
    assert.deepEqual(ofRun(lines, second).map((line) => line.decision).sort(), ['failed', 'failedTwice', 'retried', 'started'])
    // written once, however many ticks find it
    assert.equal(lines.filter((line) => line.decision === 'failedTwice').length, 1)
  } finally {
    await world.cleanup()
  }
})

test('a run whose worktree cannot be made is a start that failed, with its note', async () => {
  const world = await setup({ auto: { others: false, own: true } })
  try {
    world.git.state.addFails = true
    await tick(world)
    const run = autoRuns(world)[0]
    assert.ok(run)
    assert.equal(world.server.cache.getRun(run.id)?.status, 'failed')
    const failedLine = ofRun(await entries(world), run).find((line) => line.decision === 'failed')
    assert.match(failedLine?.note ?? '', /^worktreeFailed/)
  } finally {
    await world.cleanup()
  }
})

test('a run the owner stops is a stopped line, and the next tick leaves its PR alone at that head with a line saying so', async () => {
  const world = await setup({ auto: { others: false, own: true } })
  try {
    await tick(world)
    const started = running(world)[0]
    assert.ok(started)
    world.server.launcher.stop(started.id)
    await world.server.launcher.settled(started.id)
    await world.server.scheduler.idle()
    await tick(world)
    const lines = await entries(world)
    assert.ok(ofRun(lines, started).some((line) => line.decision === 'stopped'))
    assert.deepEqual(lines.filter((line) => line.number === started.number && line.decision === 'skipped').map((line) => line.reason), ['stoppedAtHead'])
  } finally {
    await world.cleanup()
  }
})

test('a queued run whose opt-in was turned off is skipped with that reason, as one line however often the start step reaches it', async () => {
  const world = await setup({ auto: { concurrency: 1 } })
  try {
    await tick(world)
    const waiting = autoRuns(world).filter((run) => run.status === 'queued')
    assert.ok(waiting.length > 0)
    assert.equal((await save(world, (config) => ({ ...config, autoReview: { ...config.autoReview!, others: false } }))).status, 200)
    await finish(world, running(world)[0]!)
    await tick(world)
    const lines = await entries(world)
    for (const run of waiting) assert.deepEqual(ofRun(lines, run).filter((line) => line.decision === 'skipped').map((line) => line.reason), ['optedOut'])
  } finally {
    await world.cleanup()
  }
})

test('a run the owner started is not in the log, and its PR is skipped as the owner\'s run in flight', async () => {
  const world = await setup({ auto: { others: false, own: true } })
  try {
    const manual = await world.server.launcher.start({ repo: scenario.repo, number: 103, command: 'review-pr', args: ['103', '--no-post'], label: 'Self-review' })
    assert.equal(manual.origin, 'manual')
    await tick(world)
    world.launch.children[0]!.exit(1)
    await world.server.launcher.settled(manual.id)
    await world.server.scheduler.idle()
    const lines = await entries(world)
    assert.deepEqual(ofRun(lines, manual), [])
    assert.deepEqual(lines.filter((line) => line.number === 103).map((line) => [line.decision, line.reason, line.run]), [['skipped', 'ownersRun', null]])
  } finally {
    await world.cleanup()
  }
})

test('both kinds the scheduler runs are logged: others\' PRs and the owner\'s drafts, and the Dependabot sweep in a lane of its own', async () => {
  const world = await setup({ auto: { own: true, dependabot: true, concurrency: 1 } })
  try {
    await tick(world)
    const lines = await entries(world)
    const reasons = new Set(lines.filter((line) => line.decision === 'queued').map((line) => line.reason))
    assert.ok(reasons.has('selfReview'))
    assert.ok(['requested', 'pushed', 'new'].some((reason) => reasons.has(reason)))
    const sweep = world.server.cache.allSweeps()[0]
    assert.ok(sweep)
    const sweepLines = ofRun(lines, sweep, 'sweep')
    assert.deepEqual(sweepLines.map((line) => [line.lane, line.number, line.decision, line.reason]), [['sweep', null, 'queued', 'dependabot']])
  } finally {
    await world.cleanup()
  }
})

test('the log prunes on the tick, by the days the config keeps, and the endpoint says how many days that is', async () => {
  const world = await setup({ config: { autoReviewLogDays: 2 } })
  try {
    const log = world.server.autoLog
    assert.ok(log)
    log.record({ repo: scenario.repo, lane: 'tick', decision: 'skipped', reason: 'noClone', at: '2026-10-23T14:00:00Z' })
    const count = (): number => Number(world.server.cache.db.prepare('SELECT count(*) AS n FROM autoreview_log').get()?.n)
    assert.equal(count(), 1)
    await tick(world)
    assert.equal((await logOf(world)).days, 2)
    assert.equal((await entries(world)).some((line) => line.reason === 'noClone'), false)
    assert.equal(world.server.cache.db.prepare('SELECT count(*) AS n FROM autoreview_log WHERE reason = \'noClone\'').get()?.n, 0)
  } finally {
    await world.cleanup()
  }
})

test('without the setting the log keeps 14 days, and it survives a restart', async () => {
  const world = await setup()
  try {
    await tick(world)
    const before = await entries(world)
    assert.ok(before.length > 0)
    assert.equal((await logOf(world)).days, 14)
    await world.restart()
    assert.deepEqual(await entries(world), before)
    world.time.advance(15 * day)
    assert.deepEqual(await entries(world), [], 'a read shows nothing past the days kept, before any prune')
  } finally {
    await world.cleanup()
  }
})

test('the log changes nothing the scheduler decides: the same ticks with and without it record the same ticks and runs, and make the same gh calls', async () => {
  const play = async (autoReviewLog: boolean): Promise<unknown> => {
    const world = await setup({ auto: { own: true, concurrency: 1, dailyLimit: 3 }, autoReviewLog })
    try {
      await tick(world)
      const first = running(world)[0]!
      await finish(world, first, { reviewed: { kind: 'commit', sha: first.headOid } })
      const second = running(world)[0]!
      await failRun(world, second, 'gave up')
      world.gh.login = 'somebody-else'
      await tick(world)
      world.gh.login = scenario.viewer
      await tick(world)
      await tick(world)
      assert.equal(world.server.autoLog === null, !autoReviewLog)
      const ticks = world.server.cache.ticksFor(scenario.repo).map(({ id: _id, ...rest }) => rest)
      const runs = world.server.cache.allRuns().map((run) => [run.number, run.status, run.reason, run.headOid, run.note, run.args, run.tick, run.queuedAt, run.startedAt, run.finishedAt])
      const view = world.server.scheduler.view()
      // each world has its own temporary home, which is all that may differ
      return JSON.parse(JSON.stringify({ ticks, runs, view, children: world.launch.children.map((child) => child.request.args), gh: world.gh.calls }).replaceAll(world.home, '~'))
    } finally {
      await world.cleanup()
    }
  }
  assert.deepEqual(await play(true), await play(false))
})

test('reading the log is a read: no gh call, no write, and no change to the scheduler\'s state', async () => {
  const world = await setup({ auto: { own: true } })
  try {
    await tick(world)
    const calls = world.gh.calls.length
    const view = JSON.stringify(world.server.scheduler.view())
    const count = (): number => Number(world.server.cache.db.prepare('SELECT count(*) AS n FROM autoreview_log').get()?.n)
    const lines = count()
    assert.ok(lines > 0)
    for (let read = 0; read < 3; read += 1) assert.ok((await entries(world)).length > 0)
    await world.server.scheduler.idle()
    assert.equal(world.gh.calls.length, calls)
    assert.equal(count(), lines)
    assert.equal(JSON.stringify(world.server.scheduler.view()), view)
  } finally {
    await world.cleanup()
  }
})

// the lines the first version of the log could not write, and the log never being able to change what the scheduler does

const goneProcesses = (world: World): void => {
  for (const child of world.launch.children) world.launch.alive.delete(child.pid)
}

test('a run that ended while the server was down is logged once when it starts again, with its id, and the scheduler seeing it later adds nothing', async () => {
  const world = await setup({ auto: { concurrency: 3 } })
  try {
    await tick(world)
    const run = running(world)[0]
    assert.ok(run)
    goneProcesses(world)
    await world.restart()
    assert.equal(world.server.cache.getRun(run.id)?.status, 'failed')
    const ended = async (): Promise<LogEntry[]> => (await entries(world)).filter((line) => line.decision === 'failed' && line.run?.kind === 'run')
    const failedLines = await ended()
    assert.ok(failedLines.length >= 1)
    const mine = failedLines.filter((line) => line.run?.id === run.id)
    assert.equal(mine.length, 1)
    assert.match(mine[0]?.note ?? '', /^serverRestarted/)
    assert.equal(mine[0]?.number, run.number)
    assert.equal(mine[0]?.lane, 'pr')
    // the scheduler meeting the same rows again, in ticks and in a change of their notes, writes nothing new
    await tick(world)
    await tick(world)
    assert.equal((await ended()).length, failedLines.length)
  } finally {
    await world.cleanup()
  }
})

test('a sweep that ended while the server was down is logged once when it starts again, with its id', async () => {
  const world = await setup({ auto: { others: false, dependabot: true } })
  try {
    await tick(world)
    const sweep = world.server.cache.allSweeps().find((candidate) => candidate.status === 'running')
    assert.ok(sweep)
    goneProcesses(world)
    await world.restart()
    assert.equal(world.server.cache.getSweep(sweep.id)?.status, 'failed')
    const mine = ofRun(await entries(world), sweep, 'sweep').filter((line) => line.decision === 'failed')
    assert.equal(mine.length, 1)
    assert.equal(mine[0]?.lane, 'sweep')
    assert.match(mine[0]?.note ?? '', /^serverRestarted/)
    await tick(world)
    assert.equal(ofRun(await entries(world), sweep, 'sweep').filter((line) => line.decision === 'failed').length, 1)
  } finally {
    await world.cleanup()
  }
})

test('a PR whose post is in flight is skipped in the log with that reason when its run cannot be queued, once however many ticks find it', async () => {
  const world = await setup()
  try {
    await world.server.poller.refresh('manual')
    await world.server.poller.idle()
    const open = world.server.cache.readView(scenario.repo).open.map((entry) => entry.number)
    const releases = open.map((number) => world.server.posts.hold(scenario.repo, number)!)
    await tick(world)
    await tick(world)
    const held = (await entries(world)).filter((line) => line.decision === 'skipped' && line.lane === 'pr')
    assert.ok(held.length > 1)
    assert.ok(held.every((line) => line.reason === 'postInFlight' && line.count === 2 && line.run === null && line.head !== null && line.title !== null))
    assert.equal(new Set(held.map((line) => line.number)).size, held.length)
    for (const release of releases) release()
    await tick(world)
    // queued once the post lets go: a new line, not an extension of the skip
    const first = held[0]!
    const mine = (await entries(world)).filter((line) => line.number === first.number)
    assert.deepEqual(mine.map((line) => line.decision), ['queued', 'skipped'])
  } finally {
    await world.cleanup()
  }
})

// the title is looked up from the cache for the log alone, and the scheduler's own reads share the method, so a test breaks only the lookup made for a log line, found by the function that makes it: at a status change, or at the start step
const breakTitleLookup = (world: World, where: 'statusChange' | 'startStep'): { calls: () => number } => {
  const cache = world.server.cache
  const read = cache.readView.bind(cache)
  let calls = 0
  cache.readView = ((repo: string) => {
    const stack = new Error().stack ?? ''
    if (stack.includes('titleOf') && stack.includes('sessionChanged') === (where === 'statusChange')) {
      calls += 1
      throw new Error('the cache cannot be read for a title')
    }
    return read(repo)
  }) as typeof cache.readView
  return { calls: () => calls }
}

test('a log-only title lookup that throws changes nothing the scheduler does: the waiting run still starts, the statuses update, and every record matches a run without the log', async () => {
  const play = async (mode: 'off' | 'broken'): Promise<{ record: unknown, logs: string[], broken: number }> => {
    const world = await setup({ auto: { concurrency: 1 }, autoReviewLog: mode === 'broken' })
    try {
      await tick(world)
      const lookups = breakTitleLookup(world, 'statusChange')
      const first = running(world)[0]!
      const waiting = autoRuns(world).filter((run) => run.status === 'queued')
      assert.ok(waiting.length > 0)
      await finish(world, first, { reviewed: { kind: 'commit', sha: first.headOid } })
      // the end of the first run kicked the queue: the next waiting run started
      assert.equal(running(world).length, 1)
      assert.notEqual(running(world)[0]?.id, first.id)
      assert.equal(world.server.scheduler.tracked() > 0, true)
      await tick(world)
      const runs = world.server.cache.allRuns().map((run) => [run.number, run.status, run.reason, run.headOid, run.note, run.args, run.tick, run.queuedAt, run.startedAt, run.finishedAt])
      const record = JSON.parse(JSON.stringify({ ticks: world.server.cache.ticksFor(scenario.repo).map(({ id: _id, ...rest }) => rest), runs, view: world.server.scheduler.view(), children: world.launch.children.map((child) => child.request.args) }).replaceAll(world.home, '~'))
      return { record, logs: world.logs.filter((line) => line.includes('auto-review: cannot write the log')), broken: lookups.calls() }
    } finally {
      await world.cleanup()
    }
  }
  const without = await play('off')
  const broken = await play('broken')
  assert.deepEqual(broken.record, without.record)
  // switched off, the log looks nothing up at all
  assert.equal(without.broken, 0)
  assert.deepEqual(without.logs, [])
  // switched on, the lookup threw, each throw is one line in the diagnostic log, and nothing else was lost
  assert.ok(broken.broken > 0)
  assert.equal(broken.logs.length, broken.broken)
})

test('a title lookup that throws while a queued run is skipped as opted out does not stop the queue', async () => {
  const world = await setup({ auto: { concurrency: 1 } })
  try {
    await tick(world)
    const lookups = breakTitleLookup(world, 'startStep')
    assert.equal((await save(world, (config) => ({ ...config, autoReview: { ...config.autoReview!, others: false } }))).status, 200)
    await finish(world, running(world)[0]!)
    await tick(world)
    assert.ok(lookups.calls() > 0)
    assert.deepEqual(world.logs.filter((line) => line.includes('cannot start the queue')), [])
  } finally {
    await world.cleanup()
  }
})

test('the owner\'s-run check is asked of the launcher once for each open PR, with the log on or off, and the log still names the PR it skipped', async () => {
  const play = async (mode: 'off' | 'on'): Promise<{ asked: number, rows: number, skipped: number }> => {
    const world = await setup({ auto: { others: false, own: true }, autoReviewLog: mode === 'on' })
    try {
      const manual = await world.server.launcher.start({ repo: scenario.repo, number: 103, command: 'review-pr', args: ['103', '--no-post'], label: 'Self-review' })
      assert.equal(manual.origin, 'manual')
      const launcher = world.server.launcher
      const busy = launcher.busy.bind(launcher)
      let asked = 0
      launcher.busy = ((target) => {
        asked += 1
        return busy(target)
      }) as typeof launcher.busy
      await tick(world)
      return { asked, rows: world.server.poller.openRows().length, skipped: mode === 'on' ? (await entries(world)).filter((line) => line.reason === 'ownersRun').length : 0 }
    } finally {
      await world.cleanup()
    }
  }
  const off = await play('off')
  const on = await play('on')
  assert.ok(off.rows > 1)
  // one question for each PR, as the scheduler asked before the log existed
  assert.equal(off.asked, off.rows)
  assert.equal(on.asked, on.rows)
  assert.equal(on.skipped, 1)
})

// the cap-full classification reads the queue for the log alone, once before the start step and once after it, and the start step's own reads share the methods, so a test breaks only the read made for the log, found by the names of the functions that make it
const breakQueueRead = (world: World, method: 'queuedRuns' | 'queuedSweeps', when: 'before' | 'after'): { calls: () => number } => {
  const cache = world.server.cache
  const read = cache[method].bind(cache) as () => unknown[]
  let calls = 0
  ;(cache as unknown as Record<string, () => unknown[]>)[method] = (() => {
    const stack = new Error().stack ?? ''
    if (stack.includes('logWaiting') && stack.includes('capFullOf') === (when === 'after')) {
      calls += 1
      throw new Error('the cache cannot be read for the queue')
    }
    return read()
  }) as () => unknown[]
  return { calls: () => calls }
}

for (const [method, when] of [['queuedRuns', 'before'], ['queuedSweeps', 'before'], ['queuedRuns', 'after'], ['queuedSweeps', 'after']] as const) {
  test(`a log-only read of the queue that throws (${method}, ${when} the start step) does not end the tick or hold back the waiting runs, and with the log off the read is never made`, async () => {
    const play = async (mode: 'off' | 'broken'): Promise<{ record: unknown, logs: string[], reads: number, states: (string | null)[], started: number }> => {
      const world = await setup({ auto: { concurrency: 1 }, autoReviewLog: mode === 'broken' })
      try {
        const reads = breakQueueRead(world, method, when)
        await tick(world)
        const waiting = autoRuns(world).filter((run) => run.status === 'queued')
        assert.ok(waiting.length > 0)
        const started = running(world).length
        await finish(world, running(world)[0]!)
        await tick(world)
        const runs = world.server.cache.allRuns().map((run) => [run.number, run.status, run.reason, run.headOid, run.note, run.args, run.tick, run.queuedAt, run.startedAt, run.finishedAt])
        const ticks = world.server.cache.ticksFor(scenario.repo).map(({ id: _id, ...rest }) => rest)
        const record = JSON.parse(JSON.stringify({ ticks, runs, view: world.server.scheduler.view(), children: world.launch.children.map((child) => child.request.args) }).replaceAll(world.home, '~'))
        return { record, logs: world.logs.filter((line) => line.includes('auto-review: cannot write the log')), reads: reads.calls(), states: ticks.map((row) => row.skipReason ?? row.state), started }
      } finally {
        await world.cleanup()
      }
    }
    const without = await play('off')
    const broken = await play('broken')
    // the waiting run started, and no tick ended as interrupted
    assert.equal(broken.started, 1)
    assert.ok(!broken.states.includes('interrupted'))
    assert.deepEqual(broken.record, without.record)
    // switched off, the read is never made; switched on, each failed read is one diagnostic line and nothing else
    assert.equal(without.reads, 0)
    assert.deepEqual(without.logs, [])
    assert.ok(broken.reads > 0)
    assert.equal(broken.logs.length, broken.reads)
  })
}

test('turning auto-review on during active hours and off again before the next tick starts a new off stretch, not an extension of the earlier one', async () => {
  const world = await setup()
  try {
    const turn = async (enabled: boolean): Promise<void> => {
      assert.equal((await save(world, (config) => ({ ...config, autoReview: { ...config.autoReview!, enabled } }))).status, 200)
    }
    await turn(false)
    await turn(false)
    await turn(true)
    await turn(false)
    const off = tickLines(await entries(world)).filter((line) => line.reason === 'off')
    assert.equal(off.length, 2)
    assert.deepEqual(off.map((line) => line.count), [1, 2])
  } finally {
    await world.cleanup()
  }
})

// the model that ran each review, read from the run's record, which the launcher writes at the spawn

const roleOf = (role: string, id: string, runner: 'claude' | 'codex', model: string) => ({ role, id, runner, provider: runner === 'claude' ? 'anthropic' : 'openai', model, fallback: false, outcome: null })

test('a run\'s lines name the model that ran it once it has spawned: started, finished, and failed carry it, and the queued line and every skip carry none', async () => {
  const world = await setup({ auto: { concurrency: 1 } })
  try {
    await tick(world)
    const first = running(world)[0]!
    assert.equal(world.server.cache.getRun(first.id)?.models?.roles[0]?.id, 'sonnet')
    let lines = await entries(world)
    const modelsOf = (run: Run): [string, string | null][] => ofRun(lines, run).map((line) => [line.decision, line.model]).sort() as [string, string | null][]
    assert.deepEqual(modelsOf(first), [['queued', null], ['started', 'sonnet (Claude Code)']])
    await finish(world, first, { reviewed: { kind: 'commit', sha: first.headOid } })
    const second = running(world)[0]!
    await failRun(world, second, 'the session gave up')
    lines = await entries(world)
    assert.deepEqual(modelsOf(first), [['finished', 'sonnet (Claude Code)'], ['queued', null], ['started', 'sonnet (Claude Code)']])
    assert.deepEqual(modelsOf(second), [['failed', 'sonnet (Claude Code)'], ['queued', null], ['started', 'sonnet (Claude Code)']])
    // lines that ran nothing: the tick's checks, the skips, and the queued lines
    const idle = lines.filter((line) => line.decision === 'checked' || line.decision === 'skipped' || line.decision === 'queued')
    assert.ok(idle.length > 0)
    assert.deepEqual(idle.filter((line) => line.model !== null), [])
  } finally {
    await world.cleanup()
  }
})

test('a run that fails before it spawns holds no record and its line names no model', async () => {
  const world = await setup({ auto: { others: false, own: true } })
  try {
    world.git.state.addFails = true
    await tick(world)
    const run = autoRuns(world)[0]!
    const failedLine = ofRun(await entries(world), run).find((line) => line.decision === 'failed')
    assert.ok(failedLine)
    assert.equal(failedLine.model, null)
  } finally {
    await world.cleanup()
  }
})

test('a run whose record holds the primary and the secondary (set up by hand, since the scheduler starts no tandem run) names its pair, and the panel\'s data carries it', async () => {
  const world = await setup({ auto: { others: false, own: true, concurrency: 1 } })
  try {
    await tick(world)
    const run = running(world)[0]!
    // the record as a conductor that kept both roles would leave it; the launcher itself writes the one role it starts
    world.server.cache.updateRun(run.id, { args: [String(run.number), '--tandem', '--no-post'], models: { roles: [roleOf('primary', 'sonnet', 'claude', 'sonnet'), roleOf('secondary', 'gpt-6.1-terra', 'codex', 'gpt-6.1-terra')], degraded: false } })
    await finish(world, run, { reviewed: { kind: 'commit', sha: run.headOid } })
    const ended = ofRun(await entries(world), run).find((line) => line.decision === 'finished')
    assert.equal(ended?.model, 'primary: sonnet (Claude Code) · secondary: gpt-6.1-terra (Codex)')
  } finally {
    await world.cleanup()
  }
})

test('a sweep\'s lines name no model, since its row records none', async () => {
  const world = await setup({ auto: { others: false, dependabot: true } })
  try {
    await tick(world)
    const sweep = world.server.cache.allSweeps()[0]!
    const lines = ofRun(await entries(world), sweep, 'sweep')
    assert.ok(lines.some((line) => line.decision === 'started'))
    assert.deepEqual(lines.filter((line) => line.model !== null), [])
  } finally {
    await world.cleanup()
  }
})
