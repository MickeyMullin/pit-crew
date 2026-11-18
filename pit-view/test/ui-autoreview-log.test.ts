// test/ui-autoreview-log.test.ts
// the auto-review log panel's view model (public/autoreviewlogview.ts): each line in the owner's words, newest first as the server sends them, the filters by PR, decision, and day, the empty states, and the run links; the Settings line naming the days kept, and the config value the Settings page carries over; every expected string is written out here
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LogEntry } from '../src/autoreviewlog.ts'
import { defaultConfig, validateConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { setTimeFormat } from '../public/format.ts'
import { autoReviewLogDays } from '../src/autoreviewlog.ts'
import { dayKey, defaultLogDays, logModel, logRetentionLine, noFilters } from '../public/autoreviewlogview.ts'
import { toConfig, toForm } from '../public/settings-form.ts'

setTimeFormat('12h')

const timeZone = 'UTC'
// a Monday afternoon
const now = Date.parse('2026-11-02T15:00:00Z')
const open = new Set([106, 113])
const reading = { nowMs: now, timeZone, days: 14, isOpen: (number: number) => open.has(number) }

let nextId = 100
const entry = (patch: Partial<LogEntry>): LogEntry => {
  nextId -= 1
  return {
    id: nextId, repo: 'octo-example/orbit', lane: 'pr', number: 106, title: 'feat(nav): an invented change', decision: 'queued', reason: 'pushed', note: null,
    head: 'cccc3334444', run: null, model: null, tick: 12, at: '2026-11-02T14:30:00Z', lastAt: '2026-11-02T14:30:00Z', count: 1, ...patch,
  }
}

test('each decision reads in the owner\'s words, the tick-level reasons as the Now line says them', () => {
  const lines = logModel([
    entry({ lane: 'tick', number: null, title: null, decision: 'skipped', reason: 'identityMismatch', head: null }),
    entry({ lane: 'tick', number: null, title: null, decision: 'skipped', reason: 'outsideHours', head: null }),
    entry({ lane: 'tick', number: null, title: null, decision: 'skipped', reason: 'off', head: null }),
    entry({ lane: 'tick', number: null, title: null, decision: 'skipped', reason: 'capFull', head: null, note: '2 qualified, 0 already current, queued 0' }),
    entry({ lane: 'tick', number: null, title: null, decision: 'skipped', reason: 'dailyLimit', head: null }),
    entry({ lane: 'tick', number: null, title: null, decision: 'checked', reason: 'nothingNew', head: null, note: '3 qualified, 3 already current, queued 0' }),
    entry({ decision: 'queued', reason: 'requested' }),
    entry({ decision: 'retried', reason: 'pushed' }),
    entry({ decision: 'started', reason: 'new' }),
    entry({ decision: 'skipped', reason: 'alreadyReviewed' }),
    entry({ decision: 'skipped', reason: 'inFlight' }),
    entry({ decision: 'skipped', reason: 'ownersRun' }),
    entry({ decision: 'skipped', reason: 'stoppedAtHead' }),
    entry({ decision: 'skipped', reason: 'postUnknown' }),
    entry({ decision: 'skipped', reason: 'optedOut' }),
    entry({ decision: 'dropped', reason: 'closed' }),
    entry({ decision: 'dropped', reason: 'ready' }),
    entry({ decision: 'finished', reason: 'done', note: 'Changes requested · not posted' }),
    entry({ decision: 'finished', reason: 'needsInput', note: 'Needs your answer' }),
    entry({ decision: 'failed', reason: null, note: 'worktreeFailed: git fetch failed' }),
    entry({ decision: 'failedTwice', reason: null }),
    entry({ decision: 'stopped', reason: null }),
    entry({ lane: 'sweep', number: null, title: null, decision: 'queued', reason: 'dependabot', head: null }),
  ], noFilters, reading).lines
  assert.deepEqual(lines.map((line) => line.text), [
    'Skipped: gh login differs from viewer',
    'Skipped: outside hours',
    'Skipped: off',
    'Skipped: review cap full',
    'Skipped: daily limit reached',
    'Checked PRs: nothing new to queue',
    'Queued: review requested',
    'Queued a retry: pushed since the last review',
    'Started: new PR',
    'Skipped: already reviewed at this head',
    'Skipped: an auto-review run is already queued or running',
    'Skipped: your own run of it is in flight',
    'Skipped: you stopped its run at this head',
    'Skipped: its last run may have posted',
    'Skipped: its kind is turned off in Settings',
    'Dropped before start: the PR closed',
    'Dropped before start: marked ready for review',
    'Finished: Changes requested · not posted',
    'Finished: Needs your answer',
    'Failed: worktreeFailed: git fetch failed',
    'Failed twice: left for you at this head',
    'Stopped',
    'Queued: Dependabot sweep',
  ])
  assert.deepEqual(lines.map((line) => line.subject).slice(5, 7), ['Scheduler', '#106'])
  assert.equal(lines.at(-1)?.subject, 'Dependabot sweep')
  // the counts a check found stay beside its words
  assert.equal(lines[3]?.note, '2 qualified, 0 already current, queued 0')
  assert.deepEqual(lines.map((line) => line.tone).slice(0, 6), ['warn', 'normal', 'normal', 'normal', 'warn', 'normal'])
  assert.equal(lines.find((line) => line.text.startsWith('Failed:'))?.tone, 'warn')
  assert.equal(lines.find((line) => line.text.startsWith('Failed twice'))?.tone, 'warn')
})

test('a line keeps the order the server gives, newest first, with its time, its stretch, its count, and its short head', () => {
  const model = logModel([
    entry({ lane: 'tick', number: null, title: null, decision: 'skipped', reason: 'noClone', head: null, at: '2026-11-02T13:00:00Z', lastAt: '2026-11-02T14:45:00Z', count: 8 }),
    entry({ at: '2026-10-30T19:30:00Z', lastAt: '2026-10-30T19:30:00Z' }),
    entry({ lane: 'tick', number: null, title: null, decision: 'skipped', reason: 'outsideHours', head: null, at: '2026-10-30T22:00:00Z', lastAt: '2026-10-31T09:00:00Z', count: 5 }),
  ], noFilters, reading)
  assert.deepEqual(model.lines.map((line) => [line.when, line.count, line.head]), [
    ['1:00 PM to 2:45 PM', '8 times', null],
    ['Fri 7:30 PM', null, 'cccc333'],
    // the closed window is noted each time the scheduler plans, which is no count to show
    ['Fri 10:00 PM to Sat 9:00 AM', null, null],
  ])
  assert.equal(model.lines[1]?.title, 'feat(nav): an invented change')
  assert.equal(model.summary, 'Kept for 14 days, newest first. 3 lines.')
})

test('the run id is a link that opens its PR\'s Agent drawer, open or closed, with a key of its own for each line, and a sweep\'s opens the sweep drawer', () => {
  const lines = logModel([
    entry({ run: { kind: 'run', id: 42 } }),
    entry({ number: 97, run: { kind: 'run', id: 17 } }),
    entry({ lane: 'sweep', number: null, title: null, reason: 'dependabot', head: null, run: { kind: 'sweep', id: 7 } }),
    entry({ decision: 'started', run: { kind: 'run', id: 42 } }),
    entry({ decision: 'skipped', reason: 'alreadyReviewed' }),
  ], noFilters, reading).lines
  assert.deepEqual(lines[0]?.run, { kind: 'run', id: 42, key: `line-${lines[0]?.id}`, number: 106, title: 'feat(nav): an invented change', closed: false, text: 'run 42', name: 'Open the Agent drawer of #106, run 42', opens: true })
  assert.deepEqual(lines[1]?.run, { kind: 'run', id: 17, key: `line-${lines[1]?.id}`, number: 97, title: 'feat(nav): an invented change', closed: true, text: 'run 17', name: 'Open the Agent drawer of #97, run 17 (the PR is closed)', opens: true })
  assert.deepEqual(lines[2]?.run, { kind: 'sweep', id: 7, key: `line-${lines[2]?.id}`, number: null, title: null, closed: false, text: 'sweep 7', name: 'Open the sweep drawer at sweep 7', opens: true })
  // two lines of one run are two links with two keys
  assert.notEqual(lines[0]?.run?.key, lines[3]?.run?.key)
  assert.equal(lines[4]?.run, null)
})

test('a PR skipped because a post for it is in flight reads in the owner\'s words', () => {
  const [line] = logModel([entry({ decision: 'skipped', reason: 'postInFlight' })], noFilters, reading).lines
  assert.equal(line?.text, 'Skipped: a post for it is in flight')
})

test('a line carries the model the entry names, and none for an entry without one, including one stored before the log kept models', () => {
  const old = entry({ decision: 'started' }) as Partial<LogEntry>
  delete old.model
  const lines = logModel([entry({ decision: 'finished', reason: 'done', model: 'sonnet (Claude Code)' }), entry({ decision: 'skipped', reason: 'alreadyReviewed' }), old as LogEntry], noFilters, reading).lines
  assert.deepEqual(lines.map((line) => line.model), ['sonnet (Claude Code)', null, null])
})

test('the filters: by PR, by decision, and by day, each offering only what the log holds, and together', () => {
  const all = [
    entry({ number: 113, decision: 'skipped', reason: 'alreadyReviewed', at: '2026-11-02T14:40:00Z', lastAt: '2026-11-02T14:40:00Z' }),
    entry({ lane: 'tick', number: null, title: null, decision: 'skipped', reason: 'outsideHours', head: null, at: '2026-10-31T22:00:00Z', lastAt: '2026-11-02T09:00:00Z' }),
    entry({ decision: 'started', reason: 'pushed', at: '2026-10-30T14:30:00Z', lastAt: '2026-10-30T14:30:00Z' }),
    entry({ decision: 'queued', reason: 'pushed', at: '2026-10-30T14:29:00Z', lastAt: '2026-10-30T14:29:00Z' }),
  ]
  const model = logModel(all, noFilters, reading)
  assert.deepEqual(model.prs, [{ value: '', label: 'All PRs' }, { value: '113', label: '#113' }, { value: '106', label: '#106' }, { value: 'tick', label: 'Scheduler only' }])
  assert.deepEqual(model.decisions, [{ value: '', label: 'All decisions' }, { value: 'queued', label: 'Queued' }, { value: 'started', label: 'Started' }, { value: 'skipped', label: 'Skipped' }])
  assert.deepEqual(model.days, [{ value: '', label: 'All days' }, { value: '2026-11-02', label: 'Today' }, { value: '2026-11-01', label: 'Sun Nov 1' }, { value: '2026-10-31', label: 'Sat Oct 31' }, { value: '2026-10-30', label: 'Fri Oct 30' }])
  assert.equal(model.filtered, false)
  const texts = (filters: Partial<typeof noFilters>): string[] => logModel(all, { ...noFilters, ...filters }, reading).lines.map((line) => `${line.subject} ${line.text}`)
  assert.deepEqual(texts({ pr: '106' }), ['#106 Started: pushed since the last review', '#106 Queued: pushed since the last review'])
  assert.deepEqual(texts({ pr: 'tick' }), ['Scheduler Skipped: outside hours'])
  assert.deepEqual(texts({ decision: 'skipped' }), ['#113 Skipped: already reviewed at this head', 'Scheduler Skipped: outside hours'])
  // a stretch belongs to every day it touches
  assert.deepEqual(texts({ day: '2026-11-01' }), ['Scheduler Skipped: outside hours'])
  assert.deepEqual(texts({ day: '2026-11-02', decision: 'skipped', pr: '113' }), ['#113 Skipped: already reviewed at this head'])
  const narrowed = logModel(all, { ...noFilters, pr: '106' }, reading)
  assert.equal(narrowed.filtered, true)
  assert.equal(narrowed.summary, 'Kept for 14 days, newest first. Showing 2 of 4 lines.')
  // a filter on something the log no longer holds still shows as a choice, so the select never loses its value
  assert.deepEqual(logModel(all, { ...noFilters, pr: '120' }, reading).prs.map((choice) => choice.value), ['', '120', '113', '106', 'tick'])
})

test('the empty states: nothing recorded yet, and nothing that matches the filters', () => {
  const none = logModel([], noFilters, reading)
  assert.equal(none.empty, 'Nothing recorded yet. Each decision the scheduler makes adds a line here.')
  assert.equal(none.summary, 'Kept for 14 days, newest first. No lines.')
  const unmatched = logModel([entry({})], { ...noFilters, decision: 'failed' }, reading)
  assert.equal(unmatched.empty, 'No lines match these filters.')
  assert.equal(logModel([entry({})], noFilters, reading).empty, null)
  assert.equal(logModel([entry({})], noFilters, { ...reading, days: 1 }).summary, 'Kept for 1 day, newest first. 1 line.')
})

test('a day is the reader\'s local date', () => {
  assert.equal(dayKey('2026-11-02T03:30:00Z', 'America/New_York'), '2026-11-01')
  assert.equal(dayKey('2026-11-02T03:30:00Z', 'UTC'), '2026-11-02')
})

test('the Settings line names the days the log keeps, read from the config, never a number of its own', () => {
  assert.equal(logRetentionLine(14), 'The auto-review log keeps what the scheduler decided, and why, for 14 days. Open it with Log in the header\'s Auto-review menu.')
  assert.equal(logRetentionLine(1), 'The auto-review log keeps what the scheduler decided, and why, for 1 day. Open it with Log in the header\'s Auto-review menu.')
  // the page's copy of the default is the server's, so a config without the key reads the days the server keeps
  assert.equal(defaultLogDays, autoReviewLogDays)
})

test('the config value: absent means the default, a whole number of days from 1 to 365 is kept, anything else is refused, and the Settings page carries it over on save', () => {
  const base = (patch: Record<string, unknown>): unknown => ({ ...defaultConfig(), ...patch })
  assert.equal(validateConfig(base({})).autoReviewLogDays, undefined)
  assert.equal(validateConfig(base({ autoReviewLogDays: 30 })).autoReviewLogDays, 30)
  assert.equal(validateConfig(base({ autoReviewLogDays: 1 })).autoReviewLogDays, 1)
  assert.equal(validateConfig(base({ autoReviewLogDays: 365 })).autoReviewLogDays, 365)
  for (const bad of [0, 366, 1.5, '14', null, -3]) {
    assert.throws(() => validateConfig(base({ autoReviewLogDays: bad })), /autoReviewLogDays must be a whole number of days from 1 to 365/)
  }
  const saved = { ...defaultConfig(), autoReviewLogDays: 30 } as Config
  assert.equal(toConfig(toForm(saved, () => 'id'), saved).autoReviewLogDays, 30)
  assert.equal('autoReviewLogDays' in toConfig(toForm(defaultConfig(), () => 'id'), defaultConfig()), false)
})
