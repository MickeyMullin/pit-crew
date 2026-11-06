// test/time.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Clock } from '../src/config.ts'
import { addDays, clockChangeOn, closedRanges, closedSearchWindow, formatAge, instantAt, localDateOf, minutesOfDay, startOfDay, weekdayOf } from '../src/time.ts'
import { scenario } from './fixtures/scenario.ts'

const at = (time: string): Clock => ({ now: () => Date.parse(time) })
const local = { todayStartsAt: 'local', timeZone: scenario.timeZone } as const
const utc = { todayStartsAt: 'utc', timeZone: scenario.timeZone } as const
const iso = (ms: number) => new Date(ms).toISOString()

test('ages are minutes under an hour, hours under a day, days otherwise', () => {
  const clock = at(scenario.now)
  assert.equal(formatAge('2026-10-26T13:31:38Z', clock), '34m')
  assert.equal(formatAge('2026-10-26T13:05:39Z', clock), '59m')
  assert.equal(formatAge('2026-10-26T13:05:38Z', clock), '1h')
  assert.equal(formatAge('2026-10-25T22:05:38Z', clock), '16h')
  assert.equal(formatAge('2026-10-25T14:05:39Z', clock), '23h')
  assert.equal(formatAge('2026-10-22T14:05:38Z', clock), '4d')
  // a clock slightly behind GitHub never shows a negative age
  assert.equal(formatAge('2026-10-26T14:06:00Z', clock), '0m')
})

test('local days start at local midnight in the given zone', () => {
  const now = Date.parse(scenario.now)
  assert.equal(iso(startOfDay(now, 'America/New_York')), '2026-10-26T04:00:00.000Z')
  assert.equal(iso(startOfDay(now, 'UTC')), '2026-10-26T00:00:00.000Z')
  // 23:05 in Tokyo, so its day began at 15:00Z the evening before
  assert.equal(iso(startOfDay(now, 'Asia/Tokyo')), '2026-10-25T15:00:00.000Z')
  assert.deepEqual(localDateOf(Date.parse('2026-10-26T02:30:00Z'), 'America/New_York'), { year: 2026, month: 10, day: 25 })
})

test('calendar arithmetic crosses months and knows weekdays', () => {
  assert.deepEqual(addDays({ year: 2026, month: 11, day: 2 }, -3), { year: 2026, month: 10, day: 30 })
  assert.deepEqual(addDays({ year: 2026, month: 12, day: 31 }, 1), { year: 2027, month: 1, day: 1 })
  assert.equal(weekdayOf({ year: 2026, month: 10, day: 26 }), 1)
})

test('on a Monday Yesterday* covers Friday 00:00 through Sunday 24:00', () => {
  const { today, yesterday } = closedRanges(at(scenario.now), local)
  assert.deepEqual(today, { label: 'Today', isMondayRule: false, from: scenario.todayFrom, to: scenario.now })
  assert.deepEqual(yesterday, { label: 'Yesterday*', isMondayRule: true, from: scenario.yesterdayFrom, to: scenario.yesterdayTo })
})

test('other days have a plain Yesterday', () => {
  const tuesday = closedRanges(at('2026-10-27T14:05:38Z'), local)
  assert.deepEqual(tuesday.yesterday, { label: 'Yesterday', isMondayRule: false, from: '2026-10-26T04:00:00Z', to: '2026-10-27T04:00:00Z' })
  const sunday = closedRanges(at('2026-10-25T12:00:00Z'), local)
  assert.deepEqual(sunday.yesterday, { label: 'Yesterday', isMondayRule: false, from: '2026-10-24T04:00:00Z', to: '2026-10-25T04:00:00Z' })
})

test('the day is the local day, not the UTC one', () => {
  // Monday 22:00 in New York is already Tuesday in UTC
  const late = at('2026-10-27T02:00:00Z')
  assert.equal(closedRanges(late, local).yesterday.label, 'Yesterday*')
  assert.equal(closedRanges(late, local).today.from, scenario.todayFrom)
  assert.equal(closedRanges(late, utc).yesterday.label, 'Yesterday')
  assert.equal(closedRanges(late, utc).today.from, '2026-10-27T00:00:00Z')
})

test('utc mode starts days at UTC midnight and ignores the zone', () => {
  const { today, yesterday } = closedRanges(at(scenario.now), utc)
  assert.equal(today.from, '2026-10-26T00:00:00Z')
  assert.deepEqual([yesterday.from, yesterday.to, yesterday.isMondayRule], ['2026-10-23T00:00:00Z', '2026-10-26T00:00:00Z', true])
})

test('ranges that cross a DST change keep local midnights', () => {
  // clocks went back on Sunday Nov 1 2026, so Friday starts at 04:00Z and Monday at 05:00Z
  const fall = closedRanges(at('2026-11-02T15:00:00Z'), local)
  assert.equal(fall.today.from, '2026-11-02T05:00:00Z')
  assert.deepEqual([fall.yesterday.from, fall.yesterday.to], ['2026-10-30T04:00:00Z', '2026-11-02T05:00:00Z'])
  // clocks went forward on Sunday Mar 8 2026
  const spring = closedRanges(at('2026-03-09T15:00:00Z'), local)
  assert.equal(spring.today.from, '2026-03-09T04:00:00Z')
  assert.deepEqual([spring.yesterday.from, spring.yesterday.to], ['2026-03-06T05:00:00Z', '2026-03-09T04:00:00Z'])
})

test('the closed search window runs from the start of Yesterday to now', () => {
  assert.deepEqual(closedSearchWindow(at(scenario.now), local), { from: scenario.yesterdayFrom, to: scenario.now })
})

test('minutes of the local day read the wall clock in the zone', () => {
  // 10:05 in New York (EDT), 23:05 in Tokyo, and midnight reads 0 not 24
  assert.equal(minutesOfDay(Date.parse(scenario.now), 'America/New_York'), 10 * 60 + 5)
  assert.equal(minutesOfDay(Date.parse(scenario.now), 'Asia/Tokyo'), 23 * 60 + 5)
  assert.equal(minutesOfDay(Date.parse('2026-10-26T04:00:00Z'), 'America/New_York'), 0)
})

test('a wall-clock time on a date is the right instant on either side of a DST change', () => {
  // 09:00 is EST (UTC-5) before clocks went forward on Mar 8 2026 and EDT (UTC-4) after
  assert.equal(iso(instantAt({ year: 2026, month: 3, day: 7 }, 9 * 60, 'America/New_York')), '2026-03-07T14:00:00.000Z')
  assert.equal(iso(instantAt({ year: 2026, month: 3, day: 9 }, 9 * 60, 'America/New_York')), '2026-03-09T13:00:00.000Z')
  assert.equal(iso(instantAt({ year: 2026, month: 10, day: 26 }, 18 * 60, 'UTC')), '2026-10-26T18:00:00.000Z')
})

test('a wall-clock time the clocks skip is the first instant after the gap', () => {
  const ny = { year: 2026, month: 3, day: 8 }
  // New York goes from 02:00 EST to 03:00 EDT, at 07:00Z
  assert.equal(iso(instantAt(ny, 2 * 60 - 1, 'America/New_York')), '2026-03-08T06:59:00.000Z')
  assert.equal(iso(instantAt(ny, 2 * 60, 'America/New_York')), '2026-03-08T07:00:00.000Z')
  assert.equal(iso(instantAt(ny, 2 * 60 + 30, 'America/New_York')), '2026-03-08T07:00:00.000Z')
  assert.equal(iso(instantAt(ny, 3 * 60, 'America/New_York')), '2026-03-08T07:00:00.000Z')
  assert.equal(iso(instantAt(ny, 3 * 60 + 1, 'America/New_York')), '2026-03-08T07:01:00.000Z')
  // east of UTC, in a half-hour change (Lord Howe, 02:00 to 02:30 at 15:30Z the day before), and over midnight (Havana)
  assert.equal(iso(instantAt({ year: 2026, month: 3, day: 29 }, 2 * 60 + 30, 'Europe/Paris')), '2026-03-29T01:00:00.000Z')
  assert.equal(iso(instantAt({ year: 2026, month: 10, day: 4 }, 2 * 60 + 15, 'Australia/Lord_Howe')), '2026-10-03T15:30:00.000Z')
  assert.equal(iso(instantAt(ny, 30, 'America/Havana')), '2026-03-08T05:00:00.000Z')
})

test('a wall-clock time the clocks repeat is its first occurrence', () => {
  // New York: 01:30 EDT is 05:30Z, and 01:30 EST an hour later
  assert.equal(iso(instantAt({ year: 2026, month: 11, day: 1 }, 90, 'America/New_York')), '2026-11-01T05:30:00.000Z')
  // Paris: 02:30 CEST is 00:30Z, and 02:30 CET an hour later
  assert.equal(iso(instantAt({ year: 2026, month: 10, day: 25 }, 2 * 60 + 30, 'Europe/Paris')), '2026-10-25T00:30:00.000Z')
  // Lord Howe's half hour: 01:45 at UTC+11 is 14:45Z the day before, and 01:45 at UTC+10:30 half an hour later
  assert.equal(iso(instantAt({ year: 2026, month: 4, day: 5 }, 105, 'Australia/Lord_Howe')), '2026-04-04T14:45:00.000Z')
})

test('the clock change on a date is where the offset moves and how much it repeats', () => {
  const hourMs = 3_600_000
  assert.deepEqual(clockChangeOn({ year: 2026, month: 3, day: 8 }, 'America/New_York'), { at: Date.parse('2026-03-08T07:00:00Z'), repeats: -hourMs })
  assert.deepEqual(clockChangeOn({ year: 2026, month: 11, day: 1 }, 'America/New_York'), { at: Date.parse('2026-11-01T06:00:00Z'), repeats: hourMs })
  assert.deepEqual(clockChangeOn({ year: 2026, month: 4, day: 5 }, 'Australia/Lord_Howe'), { at: Date.parse('2026-04-04T15:00:00Z'), repeats: hourMs / 2 })
  assert.equal(clockChangeOn({ year: 2026, month: 10, day: 26 }, 'America/New_York'), null)
  assert.equal(clockChangeOn({ year: 2026, month: 3, day: 8 }, 'Asia/Kolkata'), null)
  assert.equal(clockChangeOn({ year: 2026, month: 3, day: 8 }, 'UTC'), null)
})
