// test/autoreview.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildQueue, defaultAutoReview, isActiveAt, isReviewedAtHead, nextActiveStart, parseWorktreeList, recheckQueued, retryDecision, sameHead,
  selectOrphanWorktrees, startBudget, startedToday, unlistedDirectories, weekdayNames, worktreePath,
} from '../src/autoreview.ts'
import type { ActiveHours, AutoRun, AutoSweep, AutoReviewSettings, OrphanInput, QueueInput } from '../src/autoreview.ts'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { deriveOpenRows } from '../src/derive.ts'
import type { MineRow, OpenRow, OtherRow } from '../src/derive.ts'
import type { RawOpenPr } from '../src/github.ts'
import type { ReportInfo } from '../src/reports.ts'
import { minute as minuteMs } from '../src/time.ts'
import { scenario } from './fixtures/scenario.ts'
import { openPage1, openPage2 } from './helpers.ts'

const tz = scenario.timeZone
const config = { ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer }
const now = Date.parse(scenario.now)

const fixturePrs: readonly RawOpenPr[] = [...(await openPage1()).data.repository!.pullRequests.nodes, ...(await openPage2()).data.repository!.pullRequests.nodes]

const rowsOf = (prs: readonly RawOpenPr[], rowConfig: Config = config): OpenRow[] =>
  deriveOpenRows(prs, scenario.defaultBranch, { config: rowConfig, clock: { now: () => now }, timeZone: tz })

const fixtureRows = async (): Promise<OpenRow[]> => rowsOf(fixturePrs)

const patchPr = (number: number, patch: Partial<RawOpenPr>): RawOpenPr[] => fixturePrs.map((pr) => pr.number === number ? { ...pr, ...patch } : pr)

const settings = (patch: Partial<AutoReviewSettings> = {}): AutoReviewSettings => ({ ...defaultAutoReview(), enabled: true, ...patch })

const run = (patch: Partial<AutoRun> & Pick<AutoRun, 'id' | 'number'>): AutoRun => ({
  repo: scenario.repo, origin: 'auto', command: 'review-pr', headOid: null, status: 'done', startedAt: null, posting: false, postStarted: false, posted: false, ghFailed: false, ...patch,
})

const sweep = (patch: Partial<AutoSweep> & Pick<AutoSweep, 'id'>): AutoSweep => ({ repo: scenario.repo, origin: 'auto', status: 'done', startedAt: null, ...patch })

// the sweep's selection for the repository in effect, which is the one the open list describes
const orphans = (input: Omit<OrphanInput, 'repo'>): ReturnType<typeof selectOrphanWorktrees> => selectOrphanWorktrees({ repo: scenario.repo, ...input })

const queueInput = (rows: readonly OpenRow[], patch: Partial<QueueInput> = {}): QueueInput => ({
  rows, openPrs: fixturePrs, settings: settings(), reports: new Map(), runs: [], sweeps: [], lastSweepRows: null, ...patch,
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

const at = (time: string): number => Date.parse(time)

test('a from inside the spring-forward gap opens at the first instant after the gap', () => {
  // Sunday Mar 8 2026 in New York goes from 02:00 EST straight to 03:00 EDT, which is 07:00Z
  const hours: ActiveHours = { days: ['sun'], from: '02:30', to: '04:00' }
  const opens = at('2026-03-08T07:00:00Z')
  assert.equal(nextActiveStart(hours, at('2026-03-08T05:00:00Z'), tz), opens)
  assert.equal(isActiveAt(hours, opens, tz), true)
  // called again from the last instant before the gap, it does not skip to the next Sunday
  assert.equal(nextActiveStart(hours, at('2026-03-08T06:30:00Z'), tz), opens)
  assert.equal(nextActiveStart(hours, opens - 1, tz), opens)
  // from there on, the next Sunday answers
  assert.equal(nextActiveStart(hours, opens, tz), at('2026-03-15T06:30:00Z'))
})

test('a window wholly inside the gap has no active instant that day, and the next chosen day answers', () => {
  for (const [from, to] of [['02:10', '02:50'], ['02:30', '03:00']] as const) {
    const hours: ActiveHours = { days: ['sun'], from, to }
    const after = at(`2026-03-15T06:${from.slice(3)}:00Z`)
    assert.equal(nextActiveStart(hours, at('2026-03-08T05:00:00Z'), tz), after, `${from} the same day`)
    // the Sunday before it looks past the empty one
    assert.equal(nextActiveStart(hours, at('2026-03-01T17:00:00Z'), tz), after, `${from} a week before`)
    assert.equal(isActiveAt(hours, after, tz), true)
  }
})

test('a window straddling the gap opens at the gap\'s end or at from, whichever the clock reaches', () => {
  // from before the gap: it opens at from, and the gap sits inside it
  const before: ActiveHours = { days: ['sun'], from: '01:30', to: '03:30' }
  assert.equal(nextActiveStart(before, at('2026-03-08T05:00:00Z'), tz), at('2026-03-08T06:30:00Z'))
  assert.equal(isActiveAt(before, at('2026-03-08T06:59:00Z'), tz), true)
  assert.equal(isActiveAt(before, at('2026-03-08T07:00:00Z'), tz), true)
  // from exactly at the gap's start
  assert.equal(nextActiveStart({ days: ['sun'], from: '02:00', to: '03:30' }, at('2026-03-08T05:00:00Z'), tz), at('2026-03-08T07:00:00Z'))
})

test('a from the clocks repeat opens first at its first occurrence, and again on the second pass', () => {
  // Sunday Nov 1 2026 in New York: 01:30 EDT is 05:30Z, then 02:00 EDT falls back to 01:00 EST at 06:00Z, and 01:30 EST is 06:30Z
  const hours: ActiveHours = { days: ['sun'], from: '01:30', to: '01:45' }
  assert.equal(nextActiveStart(hours, at('2026-11-01T04:00:00Z'), tz), at('2026-11-01T05:30:00Z'))
  // between the two passes the window is closed, and the timer must not skip the second
  assert.equal(isActiveAt(hours, at('2026-11-01T05:50:00Z'), tz), false)
  assert.equal(isActiveAt(hours, at('2026-11-01T06:35:00Z'), tz), true)
  assert.equal(nextActiveStart(hours, at('2026-11-01T05:50:00Z'), tz), at('2026-11-01T06:30:00Z'))
  // after both, the next Sunday
  assert.equal(nextActiveStart(hours, at('2026-11-01T06:50:00Z'), tz), at('2026-11-08T06:30:00Z'))
})

test('a window that ends inside the repeated hour reopens when the clocks fall back into it', () => {
  const hours: ActiveHours = { days: ['sun'], from: '00:30', to: '01:30' }
  assert.equal(nextActiveStart(hours, at('2026-11-01T04:00:00Z'), tz), at('2026-11-01T04:30:00Z'))
  // 01:30 EDT closed it at 05:30Z, and 01:00 EST at 06:00Z is inside it again
  assert.equal(nextActiveStart(hours, at('2026-11-01T05:40:00Z'), tz), at('2026-11-01T06:00:00Z'))
})

test('an overnight window is invalid: never active, and no next start', () => {
  // section 10's validation requires from before to, so a window never crosses midnight; one that reaches these functions anyway opens never, rather than answering an instant that is not active
  const days: ActiveHours['days'] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
  for (const [from, to] of [['22:00', '06:00'], ['09:00', '09:00']] as const) {
    const hours: ActiveHours = { days, from, to }
    for (const time of ['2026-10-27T03:00:00Z', '2026-10-27T10:00:00Z', '2026-10-27T13:00:00Z']) assert.equal(isActiveAt(hours, at(time), tz), false, `${from} ${time}`)
    assert.equal(nextActiveStart(hours, at('2026-10-26T12:00:00Z'), tz), null, from)
  }
  assert.equal(nextActiveStart({ days: [], from: '09:00', to: '18:00' }, at('2026-10-26T12:00:00Z'), tz), null)
})

// every minute of the days around each clock change, read through isActiveAt: where it turns true is what nextActiveStart must answer
const risingEdges = (hours: ActiveHours, from: number, to: number, timeZone: string): number[] => {
  const edges: number[] = []
  let was = isActiveAt(hours, from - minuteMs, timeZone)
  for (let time = from; time < to; time += minuteMs) {
    const active = isActiveAt(hours, time, timeZone)
    if (active && !was) edges.push(time)
    was = active
  }
  return edges
}

const allDays: ActiveHours['days'] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

// the local dates of 2026's two clock changes, with a half-hour zone (St. John's) and a half-hour change (Lord Howe) beside New York
const clockChanges: { timeZone: string, spring: string, fall: string, windows: [string, string][] }[] = [
  { timeZone: 'America/New_York', spring: '2026-03-08', fall: '2026-11-01', windows: [['02:30', '04:00'], ['02:10', '02:50'], ['01:30', '03:30'], ['02:00', '03:00'], ['01:30', '01:45'], ['00:30', '01:30'], ['01:15', '02:15'], ['09:00', '18:00'], ['00:00', '23:59']] },
  { timeZone: 'America/St_Johns', spring: '2026-03-08', fall: '2026-11-01', windows: [['02:30', '04:00'], ['02:10', '02:50'], ['01:30', '03:30'], ['01:30', '01:45'], ['00:30', '01:30'], ['09:00', '18:00']] },
  { timeZone: 'Australia/Lord_Howe', spring: '2026-10-04', fall: '2026-04-05', windows: [['02:15', '04:00'], ['02:05', '02:25'], ['01:45', '02:15'], ['01:40', '01:50'], ['01:00', '01:40'], ['09:00', '18:00']] },
]

test('across both clock changes, every next start is active and is the first place the window opens', () => {
  for (const { timeZone, spring, fall, windows } of clockChanges) {
    for (const date of [spring, fall]) {
      const noon = at(`${date}T12:00:00Z`)
      const from = noon - 36 * 3_600_000
      const to = noon + 36 * 3_600_000
      for (const days of [allDays, [weekdayNames[new Date(noon).getUTCDay()]!]]) {
        for (const [start, end] of windows) {
          const hours: ActiveHours = { days, from: start, to: end }
          const edges = risingEdges(hours, from, to, timeZone)
          const hourly = Array.from({ length: 48 }, (_, index) => from + index * 3_600_000)
          for (const time of [...hourly, ...edges.flatMap((edge) => [edge - 1, edge, edge + minuteMs])]) {
            const label = `${timeZone} ${date} ${days.length} ${start}-${end} from ${new Date(time).toISOString()}`
            const next = nextActiveStart(hours, time, timeZone)
            assert.notEqual(next, null, label)
            assert.equal(isActiveAt(hours, next!, timeZone), true, label)
            assert.equal(isActiveAt(hours, next! - minuteMs, timeZone), false, `${label}: the minute before`)
            const expected = edges.find((edge) => edge > time)
            if (expected !== undefined) assert.equal(next, expected, label)
          }
        }
      }
    }
  }
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

// a stopped auto run leaves its PR alone at that head

const atNewHead = (rows: readonly OpenRow[], number: number, head: string): OpenRow[] => rows.map((candidate) => candidate.number === number ? { ...candidate, headSha: head } as OpenRow : candidate)

test('a PR whose auto run ended stopped is not queued again at that head, and says so', async () => {
  const rows = await fixtureRows()
  const head = byNumber(rows, 113).headSha
  const started = '2026-10-26T13:00:00Z'
  // stopped while it ran, or taken out of the queue before it started
  for (const startedAt of [started, null]) {
    const queue = buildQueue(queueInput(rows, { runs: [run({ id: 1, number: 113, headOid: head, status: 'stopped', startedAt })] }))
    assert.ok(!numbers(queue.items).includes(113), `started ${startedAt}`)
    assert.deepEqual(queue.leftForOwner, [{ number: 113, outcome: 'stopped' }])
    assert.equal(queue.alreadyCurrent, 0)
    assert.equal(queue.qualified, 5)
  }
  // heads compare as prefixes here too
  assert.ok(!numbers(buildQueue(queueInput(rows, { runs: [run({ id: 1, number: 113, headOid: head.slice(0, 7), status: 'stopped' })] })).items).includes(113))
  // and it holds for an own PR
  const own = settings({ others: false, own: true })
  const mine = buildQueue(queueInput(rows, { settings: own, runs: [run({ id: 1, number: 101, headOid: byNumber(rows, 101).headSha, status: 'stopped' })] }))
  assert.ok(!numbers(mine.items).includes(101))
  assert.deepEqual(mine.leftForOwner, [{ number: 101, outcome: 'stopped' }])
})

test('a stopped run is the PR\'s own and its head\'s: a new head qualifies again, and another PR is not affected', async () => {
  const rows = await fixtureRows()
  const head = byNumber(rows, 113).headSha
  const stopped = [run({ id: 1, number: 113, headOid: head, status: 'stopped' })]
  const moved = buildQueue(queueInput(atNewHead(rows, 113, 'f'.repeat(40)), { runs: stopped }))
  // the stop was not a failure, so the new head is a fresh start and no retry
  assert.equal(moved.items.find((item) => item.number === 113)?.retry, false)
  assert.deepEqual(moved.leftForOwner, [])
  assert.ok(numbers(buildQueue(queueInput(rows, { runs: stopped })).items).includes(111))
  // a manual run stopped by the owner is not an auto run, and holds nothing back
  assert.ok(numbers(buildQueue(queueInput(rows, { runs: [{ ...stopped[0]!, origin: 'manual' }] })).items).includes(113))
})

test('a manual review that finished at the head supersedes the stop, and the ordinary rules then apply', async () => {
  const rows = await fixtureRows()
  const head = byNumber(rows, 113).headSha
  const stopped = run({ id: 1, number: 113, headOid: head, status: 'stopped' })
  const manual = run({ id: 2, number: 113, headOid: head.slice(0, 7), status: 'done', origin: 'manual', startedAt: '2026-10-26T13:00:00Z' })
  // its report names the head, so the PR is already reviewed and waits for the next push
  const reviewed = buildQueue(queueInput(rows, { runs: [stopped, manual], reports: new Map([[113, reportAt(head.slice(0, 7))]]) }))
  assert.ok(!numbers(reviewed.items).includes(113))
  assert.equal(reviewed.alreadyCurrent, 1)
  assert.deepEqual(reviewed.leftForOwner, [])
  // the next push qualifies, as any new head does
  const pushed = buildQueue(queueInput(atNewHead(rows, 113, 'f'.repeat(40)), { runs: [stopped, manual], reports: new Map([[113, reportAt(head.slice(0, 7))]]) }))
  assert.equal(pushed.items.find((item) => item.number === 113)?.retry, false)
  // with no report naming the head the guard does not hold, so the PR is a candidate like any other
  const unreported = buildQueue(queueInput(rows, { runs: [stopped, manual] }))
  assert.ok(numbers(unreported.items).includes(113))
  assert.deepEqual(unreported.leftForOwner, [])
  // and a stop after that review stands again
  const again = buildQueue(queueInput(rows, { runs: [stopped, manual, run({ id: 3, number: 113, headOid: head, status: 'stopped' })] }))
  assert.deepEqual(again.leftForOwner, [{ number: 113, outcome: 'stopped' }])
  // a failure after the superseded stop is the retry rule's business
  const failedAfter = buildQueue(queueInput(rows, { runs: [stopped, manual, run({ id: 3, number: 113, headOid: head, status: 'failed' })] }))
  assert.equal(failedAfter.items.find((item) => item.number === 113)?.retry, true)
})

test('only a finished manual review, newer than the stop, of that PR and head, supersedes it', async () => {
  const rows = await fixtureRows()
  const head = byNumber(rows, 113).headSha
  const stopped = run({ id: 5, number: 113, headOid: head, status: 'stopped' })
  const manual = (patch: Partial<AutoRun>) => run({ id: 6, number: 113, headOid: head, status: 'done', origin: 'manual', startedAt: '2026-10-26T13:00:00Z', ...patch })
  const cases: [string, AutoRun][] = [
    ['still queued', manual({ status: 'queued' })],
    ['still running', manual({ status: 'running' })],
    ['waiting for input', manual({ status: 'needsInput' })],
    ['failed', manual({ status: 'failed' })],
    ['stopped', manual({ status: 'stopped' })],
    ['before the stop', manual({ id: 4 })],
    ['at another head', manual({ headOid: 'aaaaaaa1' })],
    ['with no head known', manual({ headOid: null })],
    ['of another PR', manual({ number: 111 })],
    ['a fix session', manual({ command: 'fix-pr' })],
    ['an update session', manual({ command: 'update-pr' })],
    // its report is not the PR's, so the guard would not see it, and an auto run would start at the head the owner stopped
    ['a stack review', manual({ command: 'review-stack' })],
  ]
  for (const [label, other] of cases) {
    const queue = buildQueue(queueInput(rows, { runs: [stopped, other] }))
    assert.ok(!numbers(queue.items).includes(113), label)
    assert.deepEqual(queue.leftForOwner.filter((entry) => entry.number === 113), [{ number: 113, outcome: 'stopped' }], label)
  }
})

// one live auto run per PR, at whatever head

test('while an auto run is queued or running at an older head, the tick queues nothing else for the PR', async () => {
  const rows = atNewHead(await fixtureRows(), 113, 'f'.repeat(40))
  for (const status of ['queued', 'running'] as const) {
    for (const headOid of ['aaaaaaa1', null]) {
      const queue = buildQueue(queueInput(rows, { runs: [run({ id: 1, number: 113, headOid, status })] }))
      assert.ok(!numbers(queue.items).includes(113), `${status} at ${headOid}`)
      assert.deepEqual(queue.leftForOwner, [], `${status} at ${headOid}`)
      // it qualifies and is not reviewed at this head; it just waits for that run to end
      assert.equal(queue.alreadyCurrent, 0, `${status} at ${headOid}`)
      assert.equal(queue.qualified, 5, `${status} at ${headOid}`)
    }
  }
  // an own PR the same
  const own = atNewHead(await fixtureRows(), 101, 'f'.repeat(40))
  const mine = buildQueue(queueInput(own, { settings: settings({ others: false, own: true }), runs: [run({ id: 1, number: 101, headOid: 'aaaaaaa1', status: 'running' })] }))
  assert.ok(!numbers(mine.items).includes(101))
  // another PR's run holds nothing
  assert.ok(numbers(buildQueue(queueInput(rows, { runs: [run({ id: 1, number: 111, headOid: 'aaaaaaa1', status: 'running' })] })).items).includes(113))
})

test('once the older run ends, the PR is judged afresh at its current head', async () => {
  const rows = atNewHead(await fixtureRows(), 113, 'f'.repeat(40))
  for (const status of ['done', 'failed', 'stopped', 'needsInput', 'skipped'] as const) {
    const queue = buildQueue(queueInput(rows, { runs: [run({ id: 1, number: 113, headOid: 'aaaaaaa1', status })] }))
    assert.equal(queue.items.find((item) => item.number === 113)?.retry, false, status)
  }
})

test('across ticks a moved head never gives a PR two live runs, and the run that started records the head it ran at', async () => {
  const rows = await fixtureRows()
  const first = byNumber(rows, 113).headSha
  const second = 'b'.repeat(40)
  const openAt = patchPr(113, { headRefOid: second })
  const tick = (headSha: string, runs: AutoRun[]) => buildQueue(queueInput(atNewHead(rows, 113, headSha), { runs })).items.filter((item) => item.number === 113)
  // the first tick queues it at the old head, and the push lands while it waits
  const [queuedItem] = tick(first, [])
  assert.ok(queuedItem)
  const queuedRow = run({ id: 1, number: 113, headOid: first, status: 'queued' })
  assert.deepEqual(tick(second, [queuedRow]), [])
  // the check before it starts neither drops it nor asks for another: it runs at the new head
  assert.deepEqual(recheckQueued(queuedItem, openAt), { action: 'start', headSha: second })
  const runningRow = { ...queuedRow, headOid: second, status: 'running' as const, startedAt: '2026-10-26T13:00:00Z' }
  assert.deepEqual(tick(second, [runningRow]), [])
  // it ended, so that head is reviewed, and only the next push qualifies
  const doneRow = { ...runningRow, status: 'done' as const }
  assert.deepEqual(tick(second, [doneRow]), [])
  assert.equal(tick('c'.repeat(40), [doneRow]).length, 1)
})

test('a manual run in flight is not an auto run, so the live rule does not read it', async () => {
  const rows = atNewHead(await fixtureRows(), 113, 'f'.repeat(40))
  assert.ok(numbers(buildQueue(queueInput(rows, { runs: [run({ id: 1, number: 113, headOid: 'aaaaaaa1', status: 'running', origin: 'manual' })] })).items).includes(113))
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
  assert.deepEqual(buildQueue(queueInput(withoutDependabot, { settings: only, openPrs: fixturePrs.filter((pr) => pr.number !== 114) })).items, [])
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

// a scheduled sweep waiting for input blocks a new one

test('a scheduled sweep that ends needsInput blocks a new scheduled sweep, however due it is', async () => {
  const rows = await fixtureRows()
  const only = settings({ others: false, dependabot: true })
  const waiting = sweep({ id: 1, status: 'needsInput', startedAt: '2026-10-26T13:00:00Z' })
  // nothing has been swept, a Dependabot PR moved, and a waiting result carries no rows
  for (const lastSweepRows of [null, [{ number: 114, head: 'a'.repeat(40) }]]) {
    const queue = buildQueue(queueInput(rows, { settings: only, sweeps: [waiting], lastSweepRows }))
    assert.deepEqual(queue.items, [])
    assert.equal(queue.sweepFailedTwice, false)
  }
  // so its worktree, which a later started sweep would settle, stays
  assert.deepEqual(orphans({ listed: [`${dir}/sweep-1`], dir, runs: [], sweeps: [waiting], openPrs: fixturePrs }).keep.map((entry) => entry.id), [1])
})

test('a waiting sweep lets go when the owner finished its session or started a sweep of their own', async () => {
  const rows = await fixtureRows()
  const only = settings({ others: false, dependabot: true })
  const started = '2026-10-26T13:00:00Z'
  const waiting = sweep({ id: 1, status: 'needsInput', startedAt: started })
  const items = (sweeps: AutoSweep[]) => buildQueue(queueInput(rows, { settings: only, sweeps })).items.map((item) => item.kind)
  // the caller knows its session ended, or the row left needsInput
  assert.deepEqual(items([{ ...waiting, settled: true }]), ['dependabot'])
  assert.deepEqual(items([{ ...waiting, status: 'done' }]), ['dependabot'])
  // a newer sweep the owner started, once it has started and left the slot free
  assert.deepEqual(items([waiting, sweep({ id: 2, origin: 'manual', status: 'done', startedAt: started })]), ['dependabot'])
  assert.deepEqual(items([waiting, sweep({ id: 2, origin: 'manual', status: 'stopped', startedAt: started })]), ['dependabot'])
  // one in flight holds the slot in any case
  assert.deepEqual(items([waiting, sweep({ id: 2, origin: 'manual', status: 'running', startedAt: started })]), [])
  // one that never started settles nothing, as for the worktree
  assert.deepEqual(items([waiting, sweep({ id: 2, origin: 'manual', status: 'stopped' })]), [], 'stopped before it started')
  assert.deepEqual(items([waiting, sweep({ id: 2, status: 'skipped' })]), [], 'skipped')
  // an older sweep settles nothing
  assert.deepEqual(items([sweep({ id: 0, origin: 'manual', status: 'done', startedAt: started }), waiting]), [], 'older')
})

test('a sweep the owner started that waits for input does not block a scheduled one, as a manual run does not block its PR', async () => {
  const rows = await fixtureRows()
  const only = settings({ others: false, dependabot: true })
  const queue = buildQueue(queueInput(rows, { settings: only, sweeps: [sweep({ id: 1, origin: 'manual', status: 'needsInput', startedAt: '2026-10-26T13:00:00Z' })] }))
  assert.deepEqual(queue.items.map((item) => item.kind), ['dependabot'])
})

// a failed sweep retries once, then failedTwice

const failedSweep = (id: number, patch: Partial<AutoSweep> = {}): AutoSweep => sweep({ id, status: 'failed', startedAt: '2026-10-26T14:00:00Z', ...patch })

test('a failed scheduled sweep is retried once, then recorded failedTwice and not retried again', async () => {
  const rows = await fixtureRows()
  const only = settings({ others: false, dependabot: true })
  const tick = (sweeps: AutoSweep[]) => buildQueue(queueInput(rows, { settings: only, sweeps }))
  const none = tick([])
  assert.deepEqual([none.items.length, none.sweepFailedTwice], [1, false])
  const once = tick([failedSweep(1)])
  assert.deepEqual(once.items.map((item) => item.kind), ['dependabot'])
  assert.equal(once.sweepFailedTwice, false)
  for (const sweeps of [[failedSweep(1), failedSweep(2)], [failedSweep(1), failedSweep(2), failedSweep(3)]]) {
    const twice = tick(sweeps)
    assert.deepEqual(twice.items, [])
    assert.equal(twice.sweepFailedTwice, true)
    assert.equal(twice.qualified, 1)
    assert.equal(twice.alreadyCurrent, 0)
  }
  // an attempt that failed before it started is still an attempt
  assert.equal(tick([failedSweep(1, { startedAt: null }), failedSweep(2, { startedAt: null })]).sweepFailedTwice, true)
})

test('a sweep that ends done clears the count, whoever started it, and nothing else does', async () => {
  const rows = await fixtureRows()
  const only = settings({ others: false, dependabot: true })
  const started = '2026-10-26T14:00:00Z'
  const tick = (sweeps: AutoSweep[]) => buildQueue(queueInput(rows, { settings: only, sweeps }))
  const kinds = (sweeps: AutoSweep[]) => tick(sweeps).items.map((item) => item.kind)
  // a retry that succeeded, a scheduled sweep or one by hand
  assert.deepEqual(kinds([failedSweep(1), failedSweep(2), sweep({ id: 3, status: 'done', startedAt: started })]), ['dependabot'])
  assert.deepEqual(kinds([failedSweep(1), failedSweep(2), sweep({ id: 3, origin: 'manual', status: 'done', startedAt: started })]), ['dependabot'])
  assert.equal(tick([failedSweep(1), failedSweep(2), sweep({ id: 3, origin: 'manual', status: 'done', startedAt: started })]).sweepFailedTwice, false)
  // after it, one more failure is a first failure again, and two are failedTwice again
  assert.deepEqual(kinds([failedSweep(1), failedSweep(2), sweep({ id: 3, status: 'done', startedAt: started }), failedSweep(4)]), ['dependabot'])
  assert.equal(tick([failedSweep(1), sweep({ id: 3, status: 'done', startedAt: started }), failedSweep(4), failedSweep(5)]).sweepFailedTwice, true)
  // a sweep by hand that failed, or was stopped, does not clear it
  for (const status of ['failed', 'stopped'] as const) {
    const queue = tick([failedSweep(1), failedSweep(2), sweep({ id: 3, origin: 'manual', status, startedAt: started })])
    assert.deepEqual(queue.items, [], status)
    assert.equal(queue.sweepFailedTwice, true, status)
  }
  // nor is a sweep by hand that failed a scheduled failure
  assert.deepEqual(kinds([failedSweep(1), failedSweep(2, { origin: 'manual' })]), ['dependabot'])
})

test('failedTwice is recorded only for a sweep that would be due and is opted in', async () => {
  const rows = await fixtureRows()
  const failures = [failedSweep(1), failedSweep(2)]
  const seen = [{ number: 114, head: byNumber(rows, 114).headSha }]
  const notDue = buildQueue(queueInput(rows, { settings: settings({ others: false, dependabot: true }), sweeps: failures, lastSweepRows: seen }))
  assert.deepEqual([notDue.items, notDue.sweepFailedTwice, notDue.qualified], [[], false, 0])
  const optedOut = buildQueue(queueInput(rows, { settings: settings({ others: false }), sweeps: failures }))
  assert.deepEqual([optedOut.items, optedOut.sweepFailedTwice], [[], false])
  // in flight, the slot rule answers first
  const inFlight = buildQueue(queueInput(rows, { settings: settings({ others: false, dependabot: true }), sweeps: [...failures, sweep({ id: 3, origin: 'manual', status: 'running', startedAt: '2026-10-26T14:00:00Z' })] }))
  assert.deepEqual([inFlight.items, inFlight.sweepFailedTwice], [[], false])
  // a waiting sweep blocks whatever failed before it
  const waiting = buildQueue(queueInput(rows, { settings: settings({ others: false, dependabot: true }), sweeps: [...failures, sweep({ id: 3, status: 'needsInput' })] }))
  assert.deepEqual([waiting.items, waiting.sweepFailedTwice], [[], false])
})

test('a failing sweep spends the daily limit once per attempt, and stops at two attempts', async () => {
  const rows = await fixtureRows()
  const only = settings({ others: false, dependabot: true, dailyLimit: 10 })
  const sweeps: AutoSweep[] = []
  // ticks with room in the limit: each attempt fails, and only the first two ever queue
  for (let id = 1; id <= 6; id += 1) {
    const budget = startBudget({ concurrency: 1, inFlight: 0, dailyLimit: only.dailyLimit, startedToday: startedToday([], sweeps, now, tz), capRoom: 2 })
    assert.equal(budget.count, 1)
    if (buildQueue(queueInput(rows, { settings: only, sweeps })).items.length > 0) sweeps.push(failedSweep(id))
  }
  assert.equal(sweeps.length, 2)
  assert.equal(startedToday([], sweeps, now, tz), 2)
  // attempts that failed before they started, such as worktreeFailed, spend nothing
  assert.equal(startedToday([], [failedSweep(1, { startedAt: null }), failedSweep(2, { startedAt: null })], now, tz), 0)
})

// Dependabot is told by its author, not by the owner's bots grouping

const noDependabotBots = { ...config, bots: ['renovate'] }

test('with Dependabot off the bots list, its open PR still sweeps and is never queued singly', () => {
  const rows = rowsOf(fixturePrs, noDependabotBots)
  // it really is in Your move now, so only the author test keeps it out
  assert.deepEqual([byNumber(rows, 114).section, (byNumber(rows, 114) as OtherRow).group], ['others', 'yourMove'])
  const queue = buildQueue(queueInput(rows, { settings: settings({ dependabot: true }) }))
  assert.ok(!numbers(queue.items).includes(114))
  assert.deepEqual(queue.items.filter((item) => item.kind === 'dependabot'), [{ kind: 'dependabot', reason: 'dependabot', prs: [114] }])
})

test('with the Dependabot opt-in off, its PR is not queued at all, even from Your move', () => {
  const rows = rowsOf(fixturePrs, noDependabotBots)
  const queue = buildQueue(queueInput(rows))
  assert.ok(!numbers(queue.items).includes(114))
  assert.ok(!queue.items.some((item) => item.kind === 'dependabot'))
  // nor does it count as a qualifying PR of the others' kind
  assert.equal(queue.qualified, buildQueue(queueInput(rowsOf(fixturePrs))).qualified)
})

test('an open Dependabot PR the rows hide or put in another group still sweeps', () => {
  const only = settings({ others: false, dependabot: true })
  // off the bots list a draft is hidden from the rows altogether
  const draft = patchPr(114, { isDraft: true })
  assert.equal(rowsOf(draft, noDependabotBots).some((row) => row.number === 114), false)
  assert.deepEqual(buildQueue(queueInput(rowsOf(draft, noDependabotBots), { settings: only, openPrs: draft })).items, [{ kind: 'dependabot', reason: 'dependabot', prs: [114] }])
  // Ready to merge, for an approved clean PR
  const ready = patchPr(114, { mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' })
  assert.equal((byNumber(rowsOf(ready, noDependabotBots), 114) as OtherRow).group, 'readyToMerge')
  assert.deepEqual(buildQueue(queueInput(rowsOf(ready, noDependabotBots), { settings: only, openPrs: ready })).items, [{ kind: 'dependabot', reason: 'dependabot', prs: [114] }])
  // a new head on one the rows hide is due again, and the head the last sweep saw is not
  const seen = [{ number: 114, head: fixturePrs.find((pr) => pr.number === 114)!.headRefOid }]
  assert.deepEqual(buildQueue(queueInput(rowsOf(draft, noDependabotBots), { settings: only, openPrs: draft, lastSweepRows: seen })).items, [])
  const moved = patchPr(114, { isDraft: true, headRefOid: 'd'.repeat(40) })
  assert.equal(buildQueue(queueInput(rowsOf(moved, noDependabotBots), { settings: only, openPrs: moved, lastSweepRows: seen })).items.length, 1)
})

test('a Dependabot PR is never queued as an own PR either, and other bots stay out of the sweep', () => {
  const viewerIsBot = { ...config, viewer: 'dependabot' }
  const rows = rowsOf(fixturePrs, viewerIsBot)
  assert.equal(byNumber(rows, 114).section, 'mine')
  const queue = buildQueue(queueInput(rows, { settings: settings({ others: false, own: true }) }))
  assert.ok(!numbers(queue.items).includes(114))
  // renovate's 115 is not swept, whatever the bots list holds
  const sweepItem = buildQueue(queueInput(rowsOf(fixturePrs, { ...config, bots: [] }), { settings: settings({ others: false, dependabot: true }) })).items[0]
  assert.deepEqual(sweepItem, { kind: 'dependabot', reason: 'dependabot', prs: [114] })
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

test('before it starts, a closed PR is dropped and a moved head is recorded', () => {
  const head = fixturePrs.find((pr) => pr.number === 113)!.headRefOid
  const item = { kind: 'others' as const, number: 113, reason: 'new' as const, retry: false, headSha: head }
  assert.deepEqual(recheckQueued(item, fixturePrs), { action: 'start', headSha: head })
  assert.deepEqual(recheckQueued(item, fixturePrs.filter((pr) => pr.number !== 113)), { action: 'drop', note: 'closed' })
  assert.deepEqual(recheckQueued(item, patchPr(113, { headRefOid: 'f'.repeat(40) })), { action: 'start', headSha: 'f'.repeat(40) })
  assert.deepEqual(recheckQueued({ kind: 'dependabot', reason: 'dependabot', prs: [114] }, []), { action: 'start', headSha: null })
})

test('a queued run whose PR became a draft is not closed: it starts, at the head the open list holds', () => {
  const prs = patchPr(113, { isDraft: true, headRefOid: 'e'.repeat(40) })
  // others' drafts are hidden from the rows, so the row is really gone
  assert.equal(rowsOf(prs).some((row) => row.number === 113), false)
  const item = { kind: 'others' as const, number: 113, reason: 'new' as const, retry: false, headSha: 'abc1234' }
  assert.deepEqual(recheckQueued(item, prs), { action: 'start', headSha: 'e'.repeat(40) })
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
  const { remove, keep } = orphans({ listed, dir, runs, sweeps, openPrs: [] })
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
    // settled: a newer run started for the PR (a retry)
    run({ id: 4, number: 106, headOid: byNumber(rows, 106).headSha, status: 'failed' }),
    run({ id: 8, number: 106, headOid: byNumber(rows, 106).headSha, status: 'running', startedAt: '2026-10-26T13:00:00Z' }),
    // settled: the PR closed (not in the open list), or its head moved
    run({ id: 5, number: 999, headOid: head, status: 'needsInput' }),
    run({ id: 6, number: 107, headOid: 'aaaaaaa1', status: 'failed' }),
  ]
  const result = orphans({ listed, dir, runs, sweeps: [], openPrs: fixturePrs })
  assert.deepEqual(result.keep.map((entry) => entry.id), [1, 2])
  assert.deepEqual(result.remove.map((entry) => entry.id), [3, 4, 5, 6, 7])
  // a caller that knows the session ended says so
  const settled = orphans({ listed, dir, runs: runs.map((entry) => entry.id === 1 ? { ...entry, settled: true } : entry), sweeps: [], openPrs: fixturePrs })
  assert.deepEqual(settled.keep.map((entry) => entry.id), [2])
})

test('a failed or waiting sweep stays until a newer sweep has started', () => {
  const listed = [`${dir}/sweep-1`, `${dir}/sweep-2`]
  const select = (newer: AutoSweep) => orphans({ listed: [`${dir}/sweep-1`], dir, runs: [], sweeps: [sweep({ id: 1, status: 'failed' }), newer], openPrs: fixturePrs })
  const alone = orphans({ listed, dir, runs: [], sweeps: [sweep({ id: 1, status: 'failed' })], openPrs: [] })
  assert.deepEqual(alone.keep.map((entry) => entry.id), [1])
  assert.deepEqual(select(sweep({ id: 2, status: 'queued' })).keep.map((entry) => entry.id), [1], 'queued')
  assert.deepEqual(select(sweep({ id: 2, status: 'stopped' })).keep.map((entry) => entry.id), [1], 'stopped before it started')
  assert.deepEqual(select(sweep({ id: 2, status: 'skipped' })).keep.map((entry) => entry.id), [1], 'skipped')
  assert.deepEqual(select(sweep({ id: 2, status: 'running', startedAt: '2026-10-26T13:00:00Z' })).remove.map((entry) => entry.id), [1], 'running')
  assert.deepEqual(select(sweep({ id: 2, status: 'stopped', startedAt: '2026-10-26T13:00:00Z' })).remove.map((entry) => entry.id), [1], 'stopped after it started')
})

test('a waiting or failed run is settled only by a run of its own repository: a later started run of another repository with the same PR number leaves its worktree in place', () => {
  const started = '2026-10-26T13:00:00Z'
  const head = fixturePrs.find((pr) => pr.number === 113)!.headRefOid
  const select = (status: AutoRun['status'], newerRepo: string) => orphans({
    listed: [`${dir}/run-1`],
    dir,
    runs: [run({ id: 1, number: 113, headOid: head, status }), run({ id: 2, repo: newerRepo, number: 113, headOid: head, status: 'running', startedAt: started })],
    sweeps: [],
    openPrs: fixturePrs,
  })
  for (const status of ['needsInput', 'failed'] as const) {
    assert.deepEqual(select(status, 'octo-example/another').keep.map((entry) => entry.id), [1], `${status}, a newer run of another repository`)
    assert.deepEqual(select(status, scenario.repo).remove.map((entry) => entry.id), [1], `${status}, a newer run of its own repository`)
  }
})

test('a waiting or failed sweep is settled only by a sweep of its own repository', () => {
  const started = '2026-10-26T13:00:00Z'
  const select = (status: AutoSweep['status'], newerRepo: string) => orphans({
    listed: [`${dir}/sweep-1`],
    dir,
    runs: [],
    sweeps: [sweep({ id: 1, status }), sweep({ id: 2, repo: newerRepo, status: 'running', startedAt: started })],
    openPrs: fixturePrs,
  })
  for (const status of ['needsInput', 'failed'] as const) {
    assert.deepEqual(select(status, 'octo-example/another').keep.map((entry) => entry.id), [1], `${status}, a newer sweep of another repository`)
    assert.deepEqual(select(status, scenario.repo).remove.map((entry) => entry.id), [1], `${status}, a newer sweep of its own repository`)
  }
})

test('a waiting or failed row of another repository stays with its worktree, since the open list describes only the repository in effect; a done one of that repository goes', () => {
  const other = 'octo-example/another'
  const started = '2026-10-26T13:00:00Z'
  const head = fixturePrs.find((pr) => pr.number === 113)!.headRefOid
  const moved = 'c'.repeat(40)
  const absent = 987654
  for (const status of ['needsInput', 'failed'] as const) {
    const listed = [`${dir}/run-1`, `${dir}/run-2`, `${dir}/run-3`, `${dir}/sweep-1`]
    const select = orphans({
      listed,
      dir,
      runs: [
        // its number is not in this list, and would read as a PR that closed
        run({ id: 1, repo: other, number: absent, headOid: head, status }),
        // its number is, at another head, and would read as a PR that moved on
        run({ id: 2, repo: other, number: 113, headOid: moved, status }),
        run({ id: 3, repo: other, number: 113, headOid: head, status: 'done' }),
        // a newer run of its own repository does not take it either, as the row of a repository not in effect
        run({ id: 4, repo: other, number: absent, headOid: head, status: 'done', startedAt: started }),
      ],
      sweeps: [sweep({ id: 1, repo: other, status }), sweep({ id: 2, repo: other, status: 'done', startedAt: started })],
      openPrs: fixturePrs,
    })
    assert.deepEqual(select.keep.map((entry) => `${entry.kind}-${entry.id}`), ['run-1', 'run-2', 'sweep-1'], status)
    assert.deepEqual(select.remove.map((entry) => `${entry.kind}-${entry.id}`), ['run-3'], status)
  }
})

test('a waiting or failed run is settled by a newer run that started, not one that only exists', () => {
  const started = '2026-10-26T13:00:00Z'
  const head = fixturePrs.find((pr) => pr.number === 113)!.headRefOid
  const select = (newer: AutoRun, status: AutoRun['status'] = 'needsInput') => orphans({
    listed: [`${dir}/run-1`],
    dir,
    runs: [run({ id: 1, number: 113, headOid: head, status }), newer],
    sweeps: [],
    openPrs: fixturePrs,
  })
  for (const status of ['needsInput', 'failed'] as const) {
    assert.deepEqual(select(run({ id: 2, number: 113, headOid: head, status: 'queued' }), status).keep.map((entry) => entry.id), [1], `${status}, newer queued`)
    assert.deepEqual(select(run({ id: 2, number: 113, headOid: head, status: 'stopped' }), status).keep.map((entry) => entry.id), [1], `${status}, newer stopped before it started`)
    assert.deepEqual(select(run({ id: 2, number: 113, headOid: head, status: 'skipped' }), status).keep.map((entry) => entry.id), [1], `${status}, newer skipped`)
    // a queued row may carry a time from the queue; it has still not started
    assert.deepEqual(select(run({ id: 2, number: 113, headOid: head, status: 'queued', startedAt: started }), status).keep.map((entry) => entry.id), [1], `${status}, newer queued with a time`)
    assert.deepEqual(select(run({ id: 2, number: 113, headOid: head, status: 'running', startedAt: started }), status).remove.map((entry) => entry.id), [1], `${status}, newer running`)
    assert.deepEqual(select(run({ id: 2, number: 113, headOid: head, status: 'done', startedAt: started }), status).remove.map((entry) => entry.id), [1], `${status}, newer done`)
    assert.deepEqual(select(run({ id: 2, number: 113, headOid: head, status: 'stopped', startedAt: started }), status).remove.map((entry) => entry.id), [1], `${status}, newer stopped after it started`)
    // whoever started it
    assert.deepEqual(select(run({ id: 2, number: 113, headOid: head, status: 'running', startedAt: started, origin: 'manual' }), status).remove.map((entry) => entry.id), [1], `${status}, newer manual`)
    // an older run or another PR's run settles nothing
    assert.deepEqual(select(run({ id: 0, number: 113, headOid: head, status: 'done', startedAt: started }), status).keep.map((entry) => entry.id), [1], `${status}, older`)
    assert.deepEqual(select(run({ id: 2, number: 111, headOid: head, status: 'running', startedAt: started }), status).keep.map((entry) => entry.id), [1], `${status}, another PR`)
  }
})

test('a PR converted to a draft has not closed: its waiting and failed worktrees stay', () => {
  const head = fixturePrs.find((pr) => pr.number === 113)!.headRefOid
  const prs = patchPr(113, { isDraft: true })
  assert.equal(rowsOf(prs).some((row) => row.number === 113), false)
  const runs = [run({ id: 1, number: 113, headOid: head, status: 'needsInput' }), run({ id: 2, number: 113, headOid: head, status: 'failed' })]
  const kept = orphans({ listed: [`${dir}/run-1`, `${dir}/run-2`], dir, runs, sweeps: [], openPrs: prs })
  assert.deepEqual(kept.keep.map((entry) => entry.id), [1, 2])
  // the draft's head is read from the open list too, so a push to it is still noticed
  const moved = orphans({ listed: [`${dir}/run-1`], dir, runs, sweeps: [], openPrs: patchPr(113, { isDraft: true, headRefOid: 'c'.repeat(40) }) })
  assert.deepEqual(moved.remove.map((entry) => entry.id), [1])
})

test('a PR that left the open list has closed, and one at a new head has moved on', () => {
  const head = fixturePrs.find((pr) => pr.number === 113)!.headRefOid
  const runs = [run({ id: 1, number: 113, headOid: head, status: 'needsInput' })]
  const select = (openPrs: readonly RawOpenPr[]) => orphans({ listed: [`${dir}/run-1`], dir, runs, sweeps: [], openPrs })
  assert.deepEqual(select(fixturePrs).keep.map((entry) => entry.id), [1])
  assert.deepEqual(select(fixturePrs.filter((pr) => pr.number !== 113)).remove.map((entry) => entry.id), [1])
  assert.deepEqual(select(patchPr(113, { headRefOid: 'c'.repeat(40) })).remove.map((entry) => entry.id), [1])
})

test('with no open list yet nothing reads as closed, so an unsettled worktree stays and a finished one still goes', () => {
  // a rebuilt cache keeps its runs and has no PRs until a listing completes; startup's sweep may read it then
  const runs = [
    run({ id: 1, number: 113, headOid: 'abc1234', status: 'needsInput' }),
    run({ id: 2, number: 111, headOid: 'abc1234', status: 'failed' }),
    run({ id: 3, number: 112, headOid: 'abc1234', status: 'done' }),
    run({ id: 4, number: 113, headOid: 'abc1234', status: 'needsInput', settled: true }),
    run({ id: 6, number: 111, headOid: 'abc1234', status: 'failed' }),
    run({ id: 7, number: 111, headOid: 'abc1234', status: 'running', startedAt: '2026-10-26T13:00:00Z' }),
  ]
  const result = orphans({ listed: [1, 2, 3, 4, 5, 6].map((id) => `${dir}/run-${id}`), dir, runs: runs.slice(0, 5), sweeps: [], openPrs: null })
  assert.deepEqual(result.keep.map((entry) => entry.id), [1, 2, 6])
  assert.deepEqual(result.remove.map((entry) => entry.id), [3, 4, 5])
  // what the records alone can settle is still settled
  const started = orphans({ listed: [`${dir}/run-6`], dir, runs, sweeps: [], openPrs: null })
  assert.deepEqual(started.remove.map((entry) => entry.id), [6])
})

test('the listed paths are compared as given, so a caller passes git\'s resolved folder', () => {
  // git lists resolved paths; a dir that is only a symlink spelling matches nothing
  const result = orphans({ listed: [`${dir}/run-1`], dir: '/fixture/link/worktrees', runs: [], sweeps: [], openPrs: [] })
  assert.deepEqual([result.remove, result.keep], [[], []])
  // a trailing slash on the folder is the same folder
  assert.equal(orphans({ listed: [`${dir}/run-1`], dir: `${dir}/`, runs: [], sweeps: [], openPrs: [] }).remove.length, 1)
})

test('directories in the folder that git no longer lists are reported, never selected for removal', () => {
  const listed = [`${dir}/run-1`]
  assert.deepEqual(unlistedDirectories(['run-1', 'run-2', 'sweep-3', 'notes'], dir, listed), ['run-2', 'sweep-3', 'notes'])
  assert.deepEqual(unlistedDirectories([], dir, listed), [])
})
