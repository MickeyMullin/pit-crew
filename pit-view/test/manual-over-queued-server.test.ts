// test/manual-over-queued-server.test.ts
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { LogEntry } from '../src/autoreviewlog.ts'
import type { Run } from '../src/cache.ts'
import { scenario } from './fixtures/scenario.ts'
import { reviewResult } from './helpers.ts'
import { autoRuns, finish, headers, running, setup, tick } from './scheduler-world.ts'
import type { World } from './scheduler-world.ts'

// a manual start through POST /api/prs/<n>/runs on a PR whose auto-review run is only queued, with the real scheduler ticking over fake gh, git, clock, and processes: section 8 of DESIGN.md, Launching runs, Concurrency, Over a queued auto-review run, and section 10, Scheduler

const queuedAuto = (world: World): Run[] => autoRuns(world).filter((run) => run.status === 'queued')

const startByHand = async (world: World, number: number): Promise<{ status: number, body: Record<string, unknown> }> => {
  const answer = await fetch(`${world.server.url}/api/prs/${number}/runs`, { method: 'POST', headers: headers(world), body: JSON.stringify({ repo: scenario.repo, viewer: scenario.viewer, kind: 'default' }) })
  return { status: answer.status, body: await answer.json() as Record<string, unknown> }
}

const logOf = async (world: World): Promise<LogEntry[]> => ((await (await fetch(`${world.server.url}/api/auto-review/log`)).json()) as { entries: LogEntry[] }).entries

// one concurrency slot, so the first auto run starts and the rest wait queued in the scheduler's own table
const waiting = async (world: World): Promise<Run> => {
  await tick(world)
  const next = queuedAuto(world)[0]
  assert.ok(next, 'an auto run waits in the queue')
  return next
}

test('at the daily limit a queued auto run is replaced by a manual start: it runs under the manual rules, the limit is read nowhere, and the superseded run is recorded with its reason', async () => {
  const world = await setup({ auto: { dailyLimit: 1, concurrency: 1 } })
  try {
    const next = await waiting(world)
    const first = running(world)[0]
    assert.ok(first)
    await finish(world, first, { reviewed: { kind: 'commit', sha: first.headOid } })
    // the limit is reached: the tick skips and the queued run stays queued
    await tick(world)
    assert.equal(world.server.cache.getRun(next.id)?.status, 'queued')
    const startedBefore = world.launch.children.length
    const answer = await startByHand(world, next.number)
    assert.equal(answer.status, 200)
    assert.equal(answer.body.status, 'running')
    assert.equal(answer.body.origin, 'manual')
    assert.equal(world.launch.children.length, startedBefore + 1)
    const superseded = world.server.cache.getRun(next.id)
    assert.equal(superseded?.status, 'skipped')
    assert.equal(superseded?.note, 'superseded')
    assert.equal(world.server.cache.runsFor(scenario.repo, next.number, 1)[0]?.id, answer.body.id)
    // the log shows the dropped run with its reason
    const line = (await logOf(world)).find((entry) => entry.run?.kind === 'run' && entry.run.id === next.id && entry.decision === 'dropped')
    assert.equal(line?.reason, 'superseded')
  } finally {
    await world.cleanup()
  }
})

test('behind a full review cap a manual start of a PR with a queued auto run queues in the manual queue, and the auto run is superseded', async () => {
  const world = await setup({ auto: { concurrency: 1 }, config: { maxConcurrentReviews: 1 } })
  try {
    const next = await waiting(world)
    assert.equal(running(world).length, 1)
    const answer = await startByHand(world, next.number)
    assert.equal(answer.status, 200)
    assert.equal(answer.body.status, 'queued')
    assert.equal(answer.body.origin, 'manual')
    assert.equal(world.server.cache.getRun(next.id)?.status, 'skipped')
    assert.equal(world.server.cache.getRun(next.id)?.note, 'superseded')
  } finally {
    await world.cleanup()
  }
})

test('a running auto run and a manual run in flight each still refuse a manual start with busy', async () => {
  const world = await setup({ auto: { concurrency: 1 } })
  try {
    const next = await waiting(world)
    const live = running(world)[0]
    assert.ok(live)
    const refused = await startByHand(world, live.number)
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error, `a run for #${live.number} is already in flight`)
    assert.equal(world.server.cache.getRun(live.id)?.status, 'running')
    const taken = await startByHand(world, next.number)
    assert.equal(taken.status, 200)
    const again = await startByHand(world, next.number)
    assert.equal(again.status, 409)
    assert.equal(world.server.cache.runsFor(scenario.repo, next.number).filter((run) => run.origin === 'manual').length, 1)
  } finally {
    await world.cleanup()
  }
})

test('while the manual run is in flight the scheduler does not queue the PR again, and when it ends the PR is judged afresh as after any manual run', async () => {
  const world = await setup({ auto: { concurrency: 1 }, config: { maxConcurrentReviews: 3 } })
  try {
    const next = await waiting(world)
    const manual = await startByHand(world, next.number)
    assert.equal(manual.status, 200)
    const before = world.server.cache.runsFor(scenario.repo, next.number).length
    await tick(world)
    await tick(world)
    assert.equal(world.server.cache.runsFor(scenario.repo, next.number).length, before, 'no new run for the PR while the manual run is in flight')
    assert.equal(queuedAuto(world).some((run) => run.number === next.number), false)
    // a manual run works in the clone itself, so its process is the newest one; when it fails, the superseded auto run counted for nothing, so the PR is queued again at once
    const child = world.launch.children.at(-1)
    assert.ok(child)
    child.exit(1)
    await world.server.launcher.settled(Number(manual.body.id))
    await tick(world)
    const again = autoRuns(world).filter((run) => run.number === next.number && run.id !== next.id)
    assert.equal(again.length, 1)
    assert.equal(again[0]?.status === 'queued' || again[0]?.status === 'running', true)
  } finally {
    await world.cleanup()
  }
})

test('a manual run that finishes at the head holds the PR: the scheduler queues no auto run for it', async () => {
  const world = await setup({ auto: { concurrency: 1 }, config: { maxConcurrentReviews: 3 } })
  try {
    const next = await waiting(world)
    const manual = await startByHand(world, next.number)
    const child = world.launch.children.at(-1)
    assert.ok(child)
    await mkdir(join(world.home, 'agents', 'output'), { recursive: true })
    await writeFile(join(world.home, 'agents', 'output', `PR-${next.number}.md`), `# Review\n\nReviewed commit: \`feat/x\` @ \`${(next.headOid ?? '').slice(0, 7)}\`\n\nNo actionable findings.\n`)
    await child.result(reviewResult({ target: { repo: scenario.repo, pr: next.number }, reviewed: { kind: 'commit', sha: next.headOid }, posted: null, notPostedReason: 'noPost', report: `~/agents/output/PR-${next.number}.md` }))
    child.exit(0)
    await world.server.launcher.settled(Number(manual.body.id))
    await world.server.scheduler.idle()
    await tick(world)
    assert.equal(autoRuns(world).filter((entry) => entry.number === next.number && entry.id !== next.id).length, 0)
  } finally {
    await world.cleanup()
  }
})
