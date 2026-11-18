// test/autoreview-log.test.ts
// the auto-review log's store (src/autoreviewlog.ts): one line per decision, a repeated tick-level or PR-level decision collapsed into its stretch, a run's decision written once, the days it keeps and the ceiling it never passes, and a file that survives a restart and a rebuild of the GitHub tables; and the pure builders the scheduler hands it
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { autoReviewLogDays, logDaysOf, openAutoReviewLog, sessionEntry, tickEntry } from '../src/autoreviewlog.ts'
import type { NewLogEntry } from '../src/autoreviewlog.ts'
import { openCache, schemaVersion } from '../src/cache.ts'
import type { Run } from '../src/cache.ts'
import { tempDir } from './helpers.ts'

const repo = 'octo-example/orbit'
const minute = 60_000
const day = 24 * 60 * minute

const handClock = (start = '2026-11-02T14:00:00Z') => {
  let at = Date.parse(start)
  return { clock: { now: () => at }, move: (ms: number) => { at += ms }, iso: () => new Date(at).toISOString().replace('.000Z', 'Z') }
}

const memoryLog = (ceiling?: number) => {
  const time = handClock()
  const db = new DatabaseSync(':memory:')
  const log = openAutoReviewLog({ db, clock: time.clock, ...(ceiling === undefined ? {} : { ceiling }) })
  return { log, time, db }
}

const skip = (reason: string, at: string): NewLogEntry => ({ repo, lane: 'tick', decision: 'skipped', reason, at })

test('the retention is one named constant of 14 days, the default of the config value that overrides it', () => {
  assert.equal(autoReviewLogDays, 14)
  assert.equal(logDaysOf({}), 14)
  assert.equal(logDaysOf({ autoReviewLogDays: 30 }), 30)
})

test('a tick-level skip repeated is one line per reason and stretch, with its count and its first and last times, and a changed reason starts a new line', () => {
  const { log, time } = memoryLog()
  log.record(skip('outsideHours', time.iso()))
  time.move(15 * minute)
  log.record(skip('outsideHours', time.iso()))
  time.move(15 * minute)
  log.record(skip('outsideHours', time.iso()))
  let lines = log.list(repo, 14)
  assert.equal(lines.length, 1)
  assert.equal(lines[0]?.count, 3)
  assert.equal(lines[0]?.at, '2026-11-02T14:00:00Z')
  assert.equal(lines[0]?.lastAt, '2026-11-02T14:30:00Z')
  // the reason changes: a new line, and the first stays as it was
  time.move(15 * minute)
  log.record(skip('dailyLimit', time.iso()))
  time.move(15 * minute)
  log.record(skip('dailyLimit', time.iso()))
  // and back again: a stretch of its own, not the first one extended
  time.move(15 * minute)
  log.record(skip('outsideHours', time.iso()))
  lines = log.list(repo, 14)
  assert.deepEqual(lines.map((line) => [line.reason, line.count]), [['outsideHours', 1], ['dailyLimit', 2], ['outsideHours', 3]])
})

test('an idle night of ticks is a few lines, not one per tick', () => {
  const { log, time } = memoryLog()
  log.record({ repo, lane: 'tick', decision: 'checked', reason: 'nothingNew', at: time.iso() })
  log.record(skip('outsideHours', time.iso()))
  // fifteen hours of nothing: the scheduler notes the closed window again each time it plans
  for (let index = 0; index < 60; index += 1) {
    time.move(15 * minute)
    log.record(skip('outsideHours', time.iso()))
  }
  time.move(15 * minute)
  for (let index = 0; index < 4; index += 1) {
    log.record({ repo, lane: 'tick', decision: 'checked', reason: 'nothingNew', note: '3 qualified, 3 already current, queued nothing', at: time.iso() })
    time.move(15 * minute)
  }
  assert.deepEqual(log.list(repo, 14).map((line) => [line.decision, line.reason, line.count]), [['checked', 'nothingNew', 4], ['skipped', 'outsideHours', 61], ['checked', 'nothingNew', 1]])
})

test('a PR\'s repeated skip collapses at the same head, while a new head, another decision in between, or another PR starts a line of its own', () => {
  const { log, time } = memoryLog()
  const already = (number: number, head: string): NewLogEntry => ({ repo, lane: 'pr', number, decision: 'skipped', reason: 'alreadyReviewed', head, at: time.iso() })
  log.record(already(106, 'aaaa111'))
  time.move(15 * minute)
  log.record(already(106, 'aaaa111'))
  log.record(already(113, 'bbbb222'))
  time.move(15 * minute)
  log.record(already(106, 'cccc333'))
  log.record({ repo, lane: 'pr', number: 106, decision: 'queued', reason: 'pushed', head: 'cccc333', run: { kind: 'run', id: 7 }, at: time.iso() })
  time.move(15 * minute)
  log.record({ repo, lane: 'pr', number: 106, decision: 'skipped', reason: 'inFlight', head: 'cccc333', at: time.iso() })
  log.record({ repo, lane: 'pr', number: 106, decision: 'skipped', reason: 'inFlight', head: 'cccc333', at: time.iso() })
  const of106 = log.list(repo, 14).filter((line) => line.number === 106)
  assert.deepEqual(of106.map((line) => [line.decision, line.reason, line.head, line.count]), [
    ['skipped', 'inFlight', 'cccc333', 2],
    ['queued', 'pushed', 'cccc333', 1],
    ['skipped', 'alreadyReviewed', 'cccc333', 1],
    ['skipped', 'alreadyReviewed', 'aaaa111', 2],
  ])
  assert.equal(log.list(repo, 14).filter((line) => line.number === 113).length, 1)
})

test('a run\'s decision is written once, however often it is seen, and its own time is kept', () => {
  const { log } = memoryLog()
  const started: NewLogEntry = { repo, lane: 'pr', number: 106, decision: 'started', run: { kind: 'run', id: 7 }, head: 'cccc333', at: '2026-11-02T13:50:00Z' }
  assert.notEqual(log.record(started), null)
  assert.equal(log.record({ ...started, at: '2026-11-02T14:00:00Z' }), null)
  // the same id in the other table is another record
  assert.notEqual(log.record({ ...started, lane: 'sweep', number: null, run: { kind: 'sweep', id: 7 } }), null)
  assert.notEqual(log.record({ ...started, decision: 'finished', reason: 'done', note: 'Clean · not posted' }), null)
  const lines = log.list(repo, 14)
  assert.equal(lines.length, 3)
  assert.equal(lines.find((line) => line.decision === 'started' && line.run?.kind === 'run')?.at, '2026-11-02T13:50:00Z')
})

test('the log keeps the days it is given: pruning drops what was last seen before them, and a read never shows it either', () => {
  const { log, time } = memoryLog()
  log.record(skip('noClone', time.iso()))
  time.move(day)
  log.record(skip('fetchFailed', time.iso()))
  time.move(13 * day + minute)
  // the first is now past 14 days; a read already leaves it out, before any prune
  assert.deepEqual(log.list(repo, 14).map((line) => line.reason), ['fetchFailed'])
  assert.equal(log.prune(14), 1)
  assert.equal(log.prune(14), 0)
  // a shorter setting keeps less
  assert.equal(log.prune(1), 1)
  assert.deepEqual(log.list(repo, 14), [])
})

test('a stretch still going is kept by its last time, not its first', () => {
  const { log, time } = memoryLog()
  log.record(skip('identityMismatch', time.iso()))
  time.move(10 * day)
  log.record(skip('identityMismatch', time.iso()))
  time.move(10 * day)
  assert.equal(log.prune(14), 0)
  assert.equal(log.list(repo, 14)[0]?.count, 2)
})

test('the log never holds more than its ceiling of lines, the oldest going first', () => {
  const { log, time } = memoryLog(3)
  for (const reason of ['noClone', 'fetchFailed', 'noClone', 'fetchFailed', 'dailyLimit']) {
    log.record(skip(reason, time.iso()))
    time.move(minute)
  }
  assert.deepEqual(log.list(repo, 14).map((line) => line.reason), ['dailyLimit', 'fetchFailed', 'noClone'])
})

test('each repository has its own lines and its own stretches', () => {
  const { log, time } = memoryLog()
  log.record(skip('noClone', time.iso()))
  log.record({ ...skip('noClone', time.iso()), repo: 'octo-example/nebula' })
  log.record(skip('noClone', time.iso()))
  assert.equal(log.list(repo, 14)[0]?.count, 2)
  assert.equal(log.list('octo-example/nebula', 14).length, 1)
})

test('the log lives in the cache file: it survives a restart and a rebuild of the GitHub tables, and opening it adds nothing to the cache\'s own schema', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const time = handClock()
    const first = openCache({ path, clock: time.clock })
    openAutoReviewLog({ db: first.db, clock: time.clock }).record(skip('noClone', time.iso()))
    first.close()
    const second = openCache({ path, clock: time.clock })
    assert.deepEqual(openAutoReviewLog({ db: second.db, clock: time.clock }).list(repo, 14).map((line) => line.reason), ['noClone'])
    // a cache from an older schema has its GitHub tables dropped and rebuilt; the log is not one of them
    second.db.exec('UPDATE meta SET value = \'2\' WHERE key = \'schemaVersion\'')
    second.close()
    const third = openCache({ path, clock: time.clock })
    assert.equal(third.db.prepare('SELECT value FROM meta WHERE key = \'schemaVersion\'').get()?.value, String(schemaVersion))
    const log = openAutoReviewLog({ db: third.db, clock: time.clock })
    assert.deepEqual(log.list(repo, 14).map((line) => line.reason), ['noClone'])
    // its ids are never reused after a prune
    time.move(30 * day)
    log.prune(14)
    const next = log.record(skip('fetchFailed', time.iso()))
    assert.ok((next?.id ?? 0) > 1)
    third.close()
  } finally {
    await cleanup()
  }
})

// the pure builders

const tick = { id: 12, repo, startedAt: '2026-11-02T14:00:00Z' }

test('a tick that ran is a check, nothing new or what it queued, and one that skipped carries its reason; a tick whose waiting rows found no room is a cap-full skip', () => {
  assert.deepEqual(tickEntry(tick, { state: 'ran', skipReason: null, qualified: 3, alreadyCurrent: 3, queued: 0 }, false), {
    repo, lane: 'tick', decision: 'checked', reason: 'nothingNew', note: '3 qualified, 3 already current, queued 0', tick: 12, at: '2026-11-02T14:00:00Z',
  })
  assert.equal(tickEntry(tick, { state: 'ran', skipReason: null, qualified: 4, alreadyCurrent: 1, queued: 3 }, false).reason, 'queued')
  assert.deepEqual(tickEntry(tick, { state: 'skipped', skipReason: 'identityMismatch', qualified: null, alreadyCurrent: null, queued: null }, false), {
    repo, lane: 'tick', decision: 'skipped', reason: 'identityMismatch', note: null, tick: 12, at: '2026-11-02T14:00:00Z',
  })
  assert.deepEqual(tickEntry(tick, { state: 'ran', skipReason: null, qualified: 2, alreadyCurrent: 0, queued: 0 }, true), {
    repo, lane: 'tick', decision: 'skipped', reason: 'capFull', note: '2 qualified, 0 already current, queued 0', tick: 12, at: '2026-11-02T14:00:00Z',
  })
})

const run = (patch: Partial<Run>): Run => ({
  id: 7, repo, number: 106, command: 'review-pr', args: ['106', '--no-post'], label: 'Review', runner: 'claude', cwd: '~/x', dir: '~/x', sessionId: null, pid: 41, pidStartedAt: null,
  startedAt: '2026-11-02T14:01:00Z', lastStepAt: null, step: null, stepState: null, finishedAt: null, status: 'running', result: null, note: null, costUsd: null, resume: null,
  steps: [], resolvedByHand: false, firstNote: null, reportHash: null, postAttemptedAt: null, origin: 'auto', tick: 12, headOid: 'cccc333', reason: 'pushed', queuedAt: '2026-11-02T14:00:00Z',
  posting: false, worktree: null, extraInstructions: null, models: null, ...patch,
} as Run)

test('a session\'s status is its decision: started, finished with its outcome, failed with its note, stopped, or dropped before start with why; a queued row and a manual run are not entries, tandem or not', () => {
  assert.deepEqual(sessionEntry('run', run({})), { repo, lane: 'pr', number: 106, decision: 'started', reason: 'pushed', note: null, head: 'cccc333', run: { kind: 'run', id: 7 }, tick: 12, at: '2026-11-02T14:01:00Z' })
  assert.equal(sessionEntry('run', run({ status: 'done', finishedAt: '2026-11-02T14:09:00Z' }))?.decision, 'finished')
  assert.equal(sessionEntry('run', run({ status: 'done', finishedAt: '2026-11-02T14:09:00Z' }))?.at, '2026-11-02T14:09:00Z')
  assert.equal(sessionEntry('run', run({ status: 'done', finishedAt: '2026-11-02T14:09:00Z' }))?.note, 'Done')
  assert.equal(sessionEntry('run', run({ status: 'needsInput', finishedAt: '2026-11-02T14:09:00Z' }))?.reason, 'needsInput')
  assert.deepEqual(sessionEntry('run', run({ status: 'failed', finishedAt: '2026-11-02T14:09:00Z', note: 'worktreeFailed: git fetch failed' })), { repo, lane: 'pr', number: 106, decision: 'failed', reason: null, note: 'worktreeFailed: git fetch failed', head: 'cccc333', run: { kind: 'run', id: 7 }, tick: 12, at: '2026-11-02T14:09:00Z' })
  assert.equal(sessionEntry('run', run({ status: 'stopped', finishedAt: '2026-11-02T14:09:00Z' }))?.decision, 'stopped')
  assert.deepEqual(sessionEntry('run', run({ status: 'skipped', finishedAt: '2026-11-02T14:09:00Z', note: 'closed', pid: null })), { repo, lane: 'pr', number: 106, decision: 'dropped', reason: 'closed', note: null, head: 'cccc333', run: { kind: 'run', id: 7 }, tick: 12, at: '2026-11-02T14:09:00Z' })
  assert.equal(sessionEntry('run', run({ status: 'queued' })), null)
  assert.equal(sessionEntry('run', run({ origin: 'manual', tick: null })), null)
  // what is logged follows the run's origin, not its command: a scheduled tandem review is logged, a tandem the owner started is not
  assert.equal(sessionEntry('run', run({ args: ['106', '--tandem', '--no-post'] }))?.decision, 'started')
  assert.equal(sessionEntry('run', run({ args: ['106', '--tandem', '--no-post'], origin: 'manual', tick: null })), null)
  // a sweep has no PR and no head
  const sweep = sessionEntry('sweep', { ...run({ reason: 'dependabot' }), number: undefined } as unknown as Run)
  assert.deepEqual([sweep?.lane, sweep?.number, sweep?.head, sweep?.run], ['sweep', null, null, { kind: 'sweep', id: 7 }])
})
