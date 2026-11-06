// test/autoreview.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildQueue, defaultAutoReview, isActiveAt, isReviewedAtHead, nextActiveStart, parseWorktreeList, recheckQueued, retryDecision, sameHead,
  selectOrphanWorktrees, startBudget, startedToday, unlistedDirectories, worktreePath,
} from '../src/autoreview.ts'
import type { AutoRun, AutoSweep, AutoReviewSettings, QueueInput } from '../src/autoreview.ts'
import { defaultConfig } from '../src/config.ts'
import { deriveOpenRows } from '../src/derive.ts'
import type { MineRow, OpenRow, OtherRow } from '../src/derive.ts'
import type { ReportInfo } from '../src/reports.ts'
import { scenario } from './fixtures/scenario.ts'
import { openPage1, openPage2 } from './helpers.ts'

const tz = scenario.timeZone
const config = { ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer }
const now = Date.parse(scenario.now)

const fixtureRows = async (): Promise<OpenRow[]> => {
  const prs = [...(await openPage1()).data.repository!.pullRequests.nodes, ...(await openPage2()).data.repository!.pullRequests.nodes]
  return deriveOpenRows(prs, scenario.defaultBranch, { config, clock: { now: () => now }, timeZone: tz })
}

const settings = (patch: Partial<AutoReviewSettings> = {}): AutoReviewSettings => ({ ...defaultAutoReview(), enabled: true, ...patch })

const run = (patch: Partial<AutoRun> & Pick<AutoRun, 'id' | 'number'>): AutoRun => ({
  origin: 'auto', headOid: null, status: 'done', startedAt: null, posting: false, postStarted: false, posted: false, ghFailed: false, ...patch,
})

const sweep = (patch: Partial<AutoSweep> & Pick<AutoSweep, 'id'>): AutoSweep => ({ origin: 'auto', status: 'done', startedAt: null, ...patch })

const queueInput = (rows: readonly OpenRow[], patch: Partial<QueueInput> = {}): QueueInput => ({
  rows, settings: settings(), reports: new Map(), runs: [], sweeps: [], lastSweepRows: null, ...patch,
})

const numbers = (items: readonly { kind: string, number?: number }[]): (number | string)[] => items.map((item) => item.number ?? item.kind)

const reportAt = (sha: string): ReportInfo => ({ file: 'PR-1.md', reviewedSha: sha, at: '2026-10-26T12:00:00Z', tandem: false })

const byNumber = (rows: readonly OpenRow[], number: number): OpenRow => {
  const row = rows.find((candidate) => candidate.number === number)
  assert.ok(row, `#${number} is missing`)
  return row
}

// active hours and days

test('defaults are off, weekdays 09:00 to 18:00, a limit of 10, and posting off', () => {
  assert.deepEqual(defaultAutoReview(), {
    enabled: false,
    intervalMinutes: 15,
    activeHours: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '18:00' },
    others: true,
    own: false,
    dependabot: false,
    concurrency: 1,
    dailyLimit: 10,
    post: { others: false, dependabot: false },
  })
})

test('active hours are the chosen days between from (inclusive) and to (exclusive) in the local zone', () => {
  const hours = defaultAutoReview().activeHours
  // 2026-10-26 is a Monday, and 13:00Z is 09:00 in New York
  assert.equal(isActiveAt(hours, Date.parse('2026-10-26T12:59:59Z'), tz), false)
  assert.equal(isActiveAt(hours, Date.parse('2026-10-26T13:00:00Z'), tz), true)
  assert.equal(isActiveAt(hours, Date.parse('2026-10-26T21:59:59Z'), tz), true)
  assert.equal(isActiveAt(hours, Date.parse('2026-10-26T22:00:00Z'), tz), false)
  // Saturday noon is inside the hours and outside the days
  assert.equal(isActiveAt(hours, Date.parse('2026-10-31T16:00:00Z'), tz), false)
  // the weekday is the local one: Tuesday 00:30Z is still Monday evening in New York
  assert.equal(isActiveAt({ days: ['tue'], from: '00:00', to: '23:59' }, Date.parse('2026-10-27T00:30:00Z'), tz), false)
  assert.equal(isActiveAt({ days: ['mon'], from: '00:00', to: '23:59' }, Date.parse('2026-10-27T00:30:00Z'), tz), true)
})

test('the next active start is the next chosen day at from, in the local zone', () => {
  const hours = defaultAutoReview().activeHours
  const next = (time: string) => new Date(nextActiveStart(hours, Date.parse(time), tz)!).toISOString()
  // before the window opens, the same day
  assert.equal(next('2026-10-26T11:00:00Z'), '2026-10-26T13:00:00.000Z')
  // after it closed, the next weekday
  assert.equal(next('2026-10-26T23:00:00Z'), '2026-10-27T13:00:00.000Z')
  // Friday evening skips the weekend
  assert.equal(next('2026-10-30T23:00:00Z'), '2026-11-02T14:00:00.000Z')
  // a DST change moves the instant but not the wall clock: Mar 9 2026 is the first EDT Monday
  assert.equal(next('2026-03-07T23:00:00Z'), '2026-03-09T13:00:00.000Z')
  // the start itself is not "next": inside the window the following day answers
  assert.equal(next('2026-10-26T13:00:00Z'), '2026-10-27T13:00:00.000Z')
})

// qualification

test('others qualify only from Your move; waiting, ready, and bot PRs never do', async () => {
  const rows = await fixtureRows()
  const queue = buildQueue(queueInput(rows))
  const yourMove = rows.filter((row): row is OtherRow => row.section === 'others' && row.group === 'yourMove').map((row) => row.number)
  assert.deepEqual(numbers(queue.items).sort(), [...yourMove].sort())
  for (const excluded of [118, 109, 108, 116, 110, 114, 115, 101, 102, 103]) assert.ok(!numbers(queue.items).includes(excluded), `#${excluded}`)
})

test('the others opt-in off leaves them out, and own and dependabot are off by default', async () => {
  const rows = await fixtureRows()
  assert.deepEqual(buildQueue(queueInput(rows, { settings: settings({ others: false }) })).items, [])
})

test('own PRs qualify when not a draft and self-review is none or stale, never when current', async () => {
  const rows = await fixtureRows()
  const own = (queue: ReturnType<typeof buildQueue>) => queue.items.filter((item) => item.kind === 'own').map((item) => item.number)
  const queue = buildQueue(queueInput(rows, { settings: settings({ others: false, own: true }) }))
  // 103 is a draft
  assert.deepEqual(own(queue), [101, 102, 120, 104])
  const current: MineRow = { ...(byNumber(rows, 104) as MineRow), selfReview: { ...(byNumber(rows, 104) as MineRow).selfReview, state: 'current' } }
  const stale: MineRow = { ...(byNumber(rows, 101) as MineRow), selfReview: { ...(byNumber(rows, 101) as MineRow).selfReview, state: 'stale' } }
  const swapped = rows.map((row) => row.number === 104 ? current : row.number === 101 ? stale : row)
  assert.deepEqual(own(buildQueue(queueInput(swapped, { settings: settings({ others: false, own: true }) }))), [101, 102, 120])
  assert.deepEqual(queue.items.find((item) => item.number === 101)?.reason, 'selfReview')
})

test('reasons: requested wins, then never reviewed is new, then pushed since the review', async () => {
  const rows = await fixtureRows()
  const queue = buildQueue(queueInput(rows))
  const reason = (number: number) => queue.items.find((item) => item.number === number)?.reason
  // 106 has the Re-review flag only, 107 has Re-review and Requested of you, 113 has no flag
  assert.equal(reason(106), 'pushed')
  assert.equal(reason(107), 'requested')
  assert.equal(reason(113), 'new')
})

test('the queue is others then own then the sweep, with others flags first then most recent activity first', async () => {
  const rows = await fixtureRows()
  const all = settings({ own: true, dependabot: true })
  const queue = buildQueue(queueInput(rows, { settings: all }))
  // Your move's own order would be oldest first within each set (107 before 106); the queue is newest first
  assert.deepEqual(numbers(queue.items), [106, 107, 113, 111, 112, 101, 102, 120, 104, 'dependabot'])
})

test('the queue reuses the attention rules: Requested of you ahead of unflagged, ties to the higher number', async () => {
  const rows = await fixtureRows()
  const base = byNumber(rows, 113) as OtherRow
  const at = '2026-10-26T10:05:33Z'
  const requested: OtherRow = { ...base, number: 900, flags: [{ kind: 'requestedOfYou', label: 'Requested of you' }], lastActivity: { ...base.lastActivity, at: '2026-10-20T00:00:00Z' } }
  const tieLow: OtherRow = { ...base, number: 901, lastActivity: { ...base.lastActivity, at } }
  const tieHigh: OtherRow = { ...base, number: 902, lastActivity: { ...base.lastActivity, at } }
  const queue = buildQueue(queueInput([tieLow, requested, tieHigh]))
  assert.deepEqual(numbers(queue.items), [900, 902, 901])
})

// already reviewed at the head

test('a PR whose report names the head is already reviewed, whoever ran it', async () => {
  const rows = await fixtureRows()
  const row = byNumber(rows, 113)
  assert.equal(isReviewedAtHead(row, reportAt(row.headSha.slice(0, 7)), []), true)
  assert.equal(isReviewedAtHead(row, reportAt('deadbee'), []), false)
  assert.equal(isReviewedAtHead(row, undefined, []), false)
  assert.equal(isReviewedAtHead(row, { ...reportAt(row.headSha.slice(0, 7)), reviewedSha: null }, []), false)
  const queue = buildQueue(queueInput(rows, { reports: new Map([[113, reportAt(row.headSha.slice(0, 7))]]) }))
  assert.ok(!numbers(queue.items).includes(113))
  assert.equal(queue.alreadyCurrent, 1)
})

test('an auto run at the head that finished, waits for input, or is in flight also marks it reviewed', async () => {
  const rows = await fixtureRows()
  const row = byNumber(rows, 113)
  for (const status of ['done', 'needsInput', 'queued', 'running'] as const) {
    assert.equal(isReviewedAtHead(row, undefined, [run({ id: 1, number: 113, headOid: row.headSha, status })]), true, status)
  }
  // a failed run is the retry rule's business, a run at an older head does not count, and manual runs are not auto runs
  assert.equal(isReviewedAtHead(row, undefined, [run({ id: 1, number: 113, headOid: row.headSha, status: 'failed' })]), false)
  assert.equal(isReviewedAtHead(row, undefined, [run({ id: 1, number: 113, headOid: 'aaaaaaa1', status: 'done' })]), false)
  assert.equal(isReviewedAtHead(row, undefined, [run({ id: 1, number: 113, headOid: row.headSha, status: 'done', origin: 'manual' })]), false)
  assert.equal(isReviewedAtHead(row, undefined, [run({ id: 1, number: 111, headOid: row.headSha, status: 'done' })]), false)
})

test('heads compare as prefixes, since the short and full forms both appear', () => {
  assert.equal(sameHead('abcdef1234567890', 'abcdef1'), true)
  assert.equal(sameHead('ABCDEF1', 'abcdef1234'), true)
  assert.equal(sameHead('abcdef1', 'abcdef2'), false)
  assert.equal(sameHead(null, 'abcdef1'), false)
  assert.equal(sameHead('', ''), false)
})

test('a needsInput run keeps its PR out of the queue at that head, and a new head qualifies again', async () => {
  const rows = await fixtureRows()
  const row = byNumber(rows, 113)
  const waiting = [run({ id: 5, number: 113, headOid: row.headSha, status: 'needsInput' })]
  assert.ok(!numbers(buildQueue(queueInput(rows, { runs: waiting })).items).includes(113))
  const moved = rows.map((candidate) => candidate.number === 113 ? { ...candidate, headSha: 'f'.repeat(40) } as OpenRow : candidate)
  assert.ok(numbers(buildQueue(queueInput(moved, { runs: waiting })).items).includes(113))
})

// retry once, then failedTwice

test('a failed run is retried once, then recorded as failedTwice and left for the owner', async () => {
  const rows = await fixtureRows()
  const head = byNumber(rows, 113).headSha
  const failedRun = (id: number) => run({ id, number: 113, headOid: head, status: 'failed' })
  const once = buildQueue(queueInput(rows, { runs: [failedRun(1)] }))
  assert.equal(once.items.find((item) => item.number === 113)?.retry, true)
  assert.equal(buildQueue(queueInput(rows)).items.find((item) => item.number === 113)?.retry, false)
  const twice = buildQueue(queueInput(rows, { runs: [failedRun(1), failedRun(2)] }))
  assert.ok(!numbers(twice.items).includes(113))
  assert.deepEqual(twice.leftForOwner, [{ number: 113, outcome: 'failedTwice' }])
  assert.equal(twice.alreadyCurrent, 0)
  // a failure at an older head does not count against the new one
  const older = buildQueue(queueInput(rows, { runs: [run({ id: 1, number: 113, headOid: 'aaaaaaa1', status: 'failed' }), run({ id: 2, number: 113, headOid: 'aaaaaaa1', status: 'failed' })] }))
  assert.equal(older.items.find((item) => item.number === 113)?.retry, false)
})

test('the retry decision counts failures at the head', () => {
  const failure = (id: number, patch: Partial<AutoRun> = {}) => run({ id, number: 1, headOid: 'abcdef1', status: 'failed', ...patch })
  assert.equal(retryDecision([failure(1)]), 'retry')
  assert.equal(retryDecision([failure(1), failure(2)]), 'failedTwice')
  assert.equal(retryDecision([failure(1), failure(2), failure(3)]), 'failedTwice')
})

test('a failed run that could have posted is never retried: postUnknown', () => {
  const failure = (patch: Partial<AutoRun>) => run({ id: 1, number: 1, headOid: 'abcdef1', status: 'failed', posting: true, ...patch })
  assert.equal(retryDecision([failure({ postStarted: true })]), 'postUnknown')
  assert.equal(retryDecision([failure({ posted: true })]), 'postUnknown')
  assert.equal(retryDecision([failure({ ghFailed: true })]), 'postUnknown')
  assert.equal(retryDecision([failure({})]), 'retry')
  // a run that was told not to post cannot have posted, whatever its steps say
  assert.equal(retryDecision([failure({ posting: false, postStarted: true, ghFailed: true })]), 'retry')
  // the newest failure decides
  assert.equal(retryDecision([failure({ id: 1, postStarted: true }), failure({ id: 2 })]), 'failedTwice')
  assert.equal(retryDecision([failure({ id: 1 }), failure({ id: 2, postStarted: true })]), 'postUnknown')
})

test('a postUnknown failure leaves the PR for the owner', async () => {
  const rows = await fixtureRows()
  const head = byNumber(rows, 113).headSha
  const queue = buildQueue(queueInput(rows, { runs: [run({ id: 1, number: 113, headOid: head, status: 'failed', posting: true, postStarted: true })] }))
  assert.ok(!numbers(queue.items).includes(113))
  assert.deepEqual(queue.leftForOwner, [{ number: 113, outcome: 'postUnknown' }])
})

// the Dependabot sweep

test('the sweep qualifies when a Dependabot PR is new or has a new head, and ignores other bots', async () => {
  const rows = await fixtureRows()
  const dependabot = byNumber(rows, 114)
  const only = settings({ others: false, dependabot: true })
  const kinds = (patch: Partial<QueueInput>) => buildQueue(queueInput(rows, { settings: only, ...patch })).items.map((item) => item.kind)
  // no earlier sweep
  assert.deepEqual(kinds({}), ['dependabot'])
  // the earlier sweep saw this PR at this head
  assert.deepEqual(kinds({ lastSweepRows: [{ number: 114, head: dependabot.headSha }] }), [])
  // a new head, or a PR the sweep never saw
  assert.deepEqual(kinds({ lastSweepRows: [{ number: 114, head: 'a'.repeat(40) }] }), ['dependabot'])
  assert.deepEqual(kinds({ lastSweepRows: [{ number: 99, head: dependabot.headSha }] }), ['dependabot'])
  // renovate (115) alone never qualifies
  const withoutDependabot = rows.filter((row) => row.number !== 114)
  assert.deepEqual(buildQueue(queueInput(withoutDependabot, { settings: only })).items, [])
})

test('the sweep item names the Dependabot PRs it covers', async () => {
  const rows = await fixtureRows()
  const queue = buildQueue(queueInput(rows, { settings: settings({ others: false, dependabot: true }) }))
  assert.deepEqual(queue.items, [{ kind: 'dependabot', reason: 'dependabot', prs: [114] }])
})

test('at most one sweep is queued or running', async () => {
  const rows = await fixtureRows()
  const only = settings({ others: false, dependabot: true })
  for (const status of ['queued', 'running'] as const) {
    assert.deepEqual(buildQueue(queueInput(rows, { settings: only, sweeps: [sweep({ id: 1, status })] })).items, [], status)
  }
  // finished and failed sweeps do not hold the slot; a manual sweep in flight does
  assert.equal(buildQueue(queueInput(rows, { settings: only, sweeps: [sweep({ id: 1, status: 'failed' })] })).items.length, 1)
  assert.equal(buildQueue(queueInput(rows, { settings: only, sweeps: [sweep({ id: 1, status: 'running', origin: 'manual' })] })).items.length, 0)
})

// counts for the tick's record

test('the queue reports what it counted for the tick row', async () => {
  const rows = await fixtureRows()
  const head = byNumber(rows, 113).headSha
  const queue = buildQueue(queueInput(rows, { runs: [run({ id: 1, number: 113, headOid: head, status: 'done' })] }))
  assert.equal(queue.qualified, 5)
  assert.equal(queue.alreadyCurrent, 1)
  assert.equal(queue.items.length, 4)
})

// the daily limit

test('the daily limit counts auto runs and sweeps started today, local time, and never manual ones', () => {
  const today = '2026-10-26T14:00:00Z'
  const earlier = '2026-10-26T03:59:00Z'
  const runs = [
    run({ id: 1, number: 1, startedAt: today }),
    run({ id: 2, number: 2, startedAt: today, status: 'failed' }),
    run({ id: 3, number: 3, startedAt: today, status: 'running' }),
    run({ id: 4, number: 4, startedAt: today, origin: 'manual' }),
    run({ id: 5, number: 5, startedAt: today, status: 'queued' }),
    run({ id: 6, number: 6, startedAt: today, status: 'skipped' as AutoRun['status'] }),
    run({ id: 7, number: 7, startedAt: earlier }),
    run({ id: 8, number: 8, startedAt: null }),
  ]
  // the day began at 04:00Z in New York, so 03:59Z belongs to yesterday
  assert.equal(startedToday(runs, [sweep({ id: 1, startedAt: today }), sweep({ id: 2, startedAt: today, origin: 'manual' })], now, tz), 4)
})

test('the start budget is the smallest of concurrency room, the limit left, and the cap room', () => {
  const base = { concurrency: 1, inFlight: 0, dailyLimit: 10, startedToday: 0, capRoom: 2 }
  assert.deepEqual(startBudget(base), { count: 1, skip: null })
  assert.deepEqual(startBudget({ ...base, concurrency: 3 }), { count: 2, skip: null })
  assert.deepEqual(startBudget({ ...base, concurrency: 3, capRoom: 5, dailyLimit: 2, startedToday: 1 }), { count: 1, skip: null })
  assert.deepEqual(startBudget({ ...base, inFlight: 1 }), { count: 0, skip: null })
  assert.deepEqual(startBudget({ ...base, capRoom: 0 }), { count: 0, skip: null })
  // at the limit the tick skips as dailyLimit, even with room elsewhere
  assert.deepEqual(startBudget({ ...base, concurrency: 3, startedToday: 10 }), { count: 0, skip: 'dailyLimit' })
  assert.deepEqual(startBudget({ ...base, startedToday: 12 }), { count: 0, skip: 'dailyLimit' })
})

// the check before a queued run starts

test('before it starts, a closed PR is dropped and a moved head is recorded', async () => {
  const rows = await fixtureRows()
  const row = byNumber(rows, 113)
  const item = { kind: 'others' as const, number: 113, reason: 'new' as const, retry: false, headSha: row.headSha }
  assert.deepEqual(recheckQueued(item, rows), { action: 'start', headSha: row.headSha })
  assert.deepEqual(recheckQueued(item, rows.filter((candidate) => candidate.number !== 113)), { action: 'drop', note: 'closed' })
  const moved = rows.map((candidate) => candidate.number === 113 ? { ...candidate, headSha: 'f'.repeat(40) } as OpenRow : candidate)
  assert.deepEqual(recheckQueued(item, moved), { action: 'start', headSha: 'f'.repeat(40) })
  assert.deepEqual(recheckQueued({ kind: 'dependabot', reason: 'dependabot', prs: [114] }, []), { action: 'start', headSha: null })
})

// the worktree sweep

const dir = '/fixture/state/worktrees'
const porcelain = (paths: string[]): string =>
  paths.map((path) => `worktree ${path}\nHEAD 0123456789abcdef0123456789abcdef01234567\n${path.endsWith('clone') ? 'branch refs/heads/main' : 'detached'}\n`).join('\n')

test('the porcelain list yields every worktree path', () => {
  assert.deepEqual(parseWorktreeList(porcelain(['/fixture/clone', `${dir}/run-1`])), ['/fixture/clone', `${dir}/run-1`])
  assert.deepEqual(parseWorktreeList(''), [])
  // CRLF output and a path with spaces
  assert.deepEqual(parseWorktreeList('worktree /a b/c\r\nHEAD x\r\n\r\nworktree /d\r\n'), ['/a b/c', '/d'])
})

test('worktree paths are run-<id> or sweep-<id> directly inside the folder', () => {
  assert.equal(worktreePath(dir, 'run', 42), `${dir}/run-42`)
  assert.equal(worktreePath(dir, 'sweep', 7), `${dir}/sweep-7`)
})

test('the sweep removes only direct run-<digits> and sweep-<digits> entries whose record is not in flight', () => {
  const listed = [
    '/fixture/clone',
    `${dir}/run-42`,
    `${dir}/run-43`,
    `${dir}/run-44`,
    `${dir}/run-47`,
    `${dir}/run-48x`,
    `${dir}/run-`,
    `${dir}/Run-49`,
    `${dir}/sub/run-50`,
    `${dir}-other/run-51`,
    '/fixture/agents/worktrees/pr-52',
    `${dir}/sweep-3`,
    `${dir}/sweep-4`,
    `${dir}/notes`,
  ]
  const runs = [
    run({ id: 42, number: 1, status: 'done' }),
    run({ id: 43, number: 2, status: 'running' }),
    run({ id: 44, number: 3, status: 'queued' }),
    run({ id: 50, number: 4, status: 'done' }),
    run({ id: 51, number: 5, status: 'done' }),
    run({ id: 52, number: 6, status: 'done' }),
  ]
  const sweeps = [sweep({ id: 3, status: 'done' }), sweep({ id: 4, status: 'running' })]
  const { remove, keep } = selectOrphanWorktrees({ listed, dir, runs, sweeps, rows: [] })
  assert.deepEqual(remove.map((entry) => entry.path), [`${dir}/run-42`, `${dir}/run-47`, `${dir}/sweep-3`])
  assert.deepEqual(keep.map((entry) => entry.path), [`${dir}/run-43`, `${dir}/run-44`, `${dir}/sweep-4`])
})

test('a stopped, done, or rowless run goes; a waiting or failed one stays until it is settled', async () => {
  const rows = await fixtureRows()
  const head = byNumber(rows, 113).headSha
  const listed = [`${dir}/run-1`, `${dir}/run-2`, `${dir}/run-3`, `${dir}/run-4`, `${dir}/run-5`, `${dir}/run-6`, `${dir}/run-7`]
  const runs = [
    run({ id: 1, number: 113, headOid: head, status: 'needsInput' }),
    run({ id: 2, number: 111, headOid: byNumber(rows, 111).headSha, status: 'failed' }),
    run({ id: 3, number: 112, headOid: byNumber(rows, 112).headSha, status: 'stopped' }),
    // settled: a newer run exists for the PR (a retry)
    run({ id: 4, number: 106, headOid: byNumber(rows, 106).headSha, status: 'failed' }),
    run({ id: 8, number: 106, headOid: byNumber(rows, 106).headSha, status: 'running' }),
    // settled: the PR closed (no open row), or its head moved
    run({ id: 5, number: 999, headOid: head, status: 'needsInput' }),
    run({ id: 6, number: 107, headOid: 'aaaaaaa1', status: 'failed' }),
  ]
  const result = selectOrphanWorktrees({ listed, dir, runs, sweeps: [], rows })
  assert.deepEqual(result.keep.map((entry) => entry.id), [1, 2])
  assert.deepEqual(result.remove.map((entry) => entry.id), [3, 4, 5, 6, 7])
  // a caller that knows the session ended says so
  const settled = selectOrphanWorktrees({ listed, dir, runs: runs.map((entry) => entry.id === 1 ? { ...entry, settled: true } : entry), sweeps: [], rows })
  assert.deepEqual(settled.keep.map((entry) => entry.id), [2])
})

test('a failed or waiting sweep stays until a newer sweep exists', () => {
  const listed = [`${dir}/sweep-1`, `${dir}/sweep-2`]
  const alone = selectOrphanWorktrees({ listed, dir, runs: [], sweeps: [sweep({ id: 1, status: 'failed' })], rows: [] })
  assert.deepEqual(alone.keep.map((entry) => entry.id), [1])
  const newer = selectOrphanWorktrees({ listed, dir, runs: [], sweeps: [sweep({ id: 1, status: 'failed' }), sweep({ id: 2, status: 'done' })], rows: [] })
  assert.deepEqual(newer.remove.map((entry) => entry.id), [1, 2])
})

test('the listed paths are compared as given, so a caller passes git\'s resolved folder', () => {
  // git lists resolved paths; a dir that is only a symlink spelling matches nothing
  const result = selectOrphanWorktrees({ listed: [`${dir}/run-1`], dir: '/fixture/link/worktrees', runs: [], sweeps: [], rows: [] })
  assert.deepEqual([result.remove, result.keep], [[], []])
  // a trailing slash on the folder is the same folder
  assert.equal(selectOrphanWorktrees({ listed: [`${dir}/run-1`], dir: `${dir}/`, runs: [], sweeps: [], rows: [] }).remove.length, 1)
})

test('directories in the folder that git no longer lists are reported, never selected for removal', () => {
  const listed = [`${dir}/run-1`]
  assert.deepEqual(unlistedDirectories(['run-1', 'run-2', 'sweep-3', 'notes'], dir, listed), ['run-2', 'sweep-3', 'notes'])
  assert.deepEqual(unlistedDirectories([], dir, listed), [])
})
