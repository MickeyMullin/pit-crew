// test/ui-closed.test.ts
// the Closed section's pure parts (public/closed.ts and its columns), run under Node against
// ranges from the server's own day rules and rows derived from the invented fixtures
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { deriveClosed } from '../src/derive.ts'
import type { ClosedRange, ClosedRow, ClosedView } from '../src/derive.ts'
import { closedRanges } from '../src/time.ts'
import { closedSummary, hasTickets, mondayNote, rangeButtons, rangeDays } from '../public/closed.ts'
import { closedSortValues, comparator, initialControls, setClosedRange } from '../public/filters.ts'
import { formatClock } from '../public/format.ts'
import { closedColumns } from '../public/tables.ts'
import { scenario } from './fixtures/scenario.ts'
import { closedSearch, fakeTime } from './helpers.ts'

const zone = scenario.timeZone

const config = (change: Partial<Config> = {}): Config => ({ ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer, ...change })

// both ranges as the server computes them at an instant, with no rows
const rangesAt = (now: string, todayStartsAt: Config['todayStartsAt'] = 'local'): ClosedView => {
  const { today, yesterday } = closedRanges(fakeTime(now).clock, { todayStartsAt, timeZone: zone })
  return { today: { ...today, rows: [] }, yesterday: { ...yesterday, rows: [] } }
}

const fixtureClosed = async (change: Partial<Config> = {}): Promise<ClosedView> =>
  deriveClosed((await closedSearch()).data.search.nodes, { config: config(change), clock: fakeTime().clock, timeZone: zone })

test('a weekday names its own day for Today and the day before for Yesterday', () => {
  const tuesday = rangesAt('2026-10-27T14:05:38Z')
  assert.equal(rangeDays(tuesday.today, zone), 'Tue Oct 27')
  assert.equal(rangeDays(tuesday.yesterday, zone), 'Mon Oct 26')
  assert.deepEqual(rangeButtons(tuesday, 'today', zone), [
    { key: 'today', label: 'Today', pressed: true, tip: 'Tue Oct 27' },
    { key: 'yesterday', label: 'Yesterday', pressed: false, tip: 'Mon Oct 26' },
  ])
  assert.equal(mondayNote(tuesday), null)
})

test('on a Monday, Yesterday* covers Friday through Sunday, with its tip and the footnote', () => {
  const monday = rangesAt(scenario.now)
  assert.equal(rangeDays(monday.today, zone), 'Mon Oct 26')
  assert.equal(rangeDays(monday.yesterday, zone), 'Fri Oct 23 – Sun Oct 25')
  assert.deepEqual(rangeButtons(monday, 'yesterday', zone), [
    { key: 'today', label: 'Today', pressed: false, tip: 'Mon Oct 26' },
    { key: 'yesterday', label: 'Yesterday*', pressed: true, tip: 'Monday: covers Friday through Sunday' },
  ])
  assert.equal(mondayNote(monday), '* On Mondays, Yesterday covers Friday through Sunday.')
  // a Monday-rule range shows the weekday on its times
  assert.equal(formatClock('2026-10-25T21:53:00Z', monday.yesterday.isMondayRule, zone), 'Sun 5:53 PM')
  assert.equal(formatClock('2026-10-26T13:10:00Z', monday.today.isMondayRule, zone), '9:10 AM')
})

test('a Fri–Sun range across a DST change still names Friday and Sunday', () => {
  // DST ends on Sunday Nov 1 2026 and starts on Sunday Mar 14 2027 in New York
  const fall = rangesAt('2026-11-02T15:00:00Z')
  assert.deepEqual([fall.yesterday.from, fall.yesterday.to], ['2026-10-30T04:00:00Z', '2026-11-02T05:00:00Z'])
  assert.equal(rangeDays(fall.yesterday, zone), 'Fri Oct 30 – Sun Nov 1')
  assert.equal(rangeDays(fall.today, zone), 'Mon Nov 2')
  const spring = rangesAt('2027-03-15T15:00:00Z')
  assert.equal(rangeDays(spring.yesterday, zone), 'Fri Mar 12 – Sun Mar 14')
  // the 25-hour and 23-hour days themselves
  assert.equal(rangeDays(rangesAt('2026-11-02T03:00:00Z').today, zone), 'Sun Nov 1')
  assert.equal(rangeDays(rangesAt('2027-03-15T03:00:00Z').today, zone), 'Sun Mar 14')
})

test('UTC days read in a browser zone either side of UTC still name their own dates', () => {
  const monday = rangesAt('2026-10-26T14:05:38Z', 'utc')
  assert.equal(monday.yesterday.from, '2026-10-23T00:00:00Z')
  for (const browser of [zone, 'Asia/Tokyo', 'UTC']) {
    assert.equal(rangeDays(monday.today, browser), 'Mon Oct 26', browser)
    assert.equal(rangeDays(monday.yesterday, browser), 'Fri Oct 23 – Sun Oct 25', browser)
  }
})

test('the summary gives the range\'s days and its tally', async () => {
  const closed = await fixtureClosed()
  assert.equal(closedSummary(closed.today, zone), 'Mon Oct 26 · 1 merged, 1 closed unmerged')
  assert.equal(closedSummary(closed.yesterday, zone), 'Fri Oct 23 – Sun Oct 25 · 4 merged, 2 closed unmerged')
  assert.equal(closedSummary(rangesAt('2026-10-27T14:05:38Z').today, zone), 'Tue Oct 27 · 0 merged, 0 closed unmerged')
})

const keys = (range: ClosedRange): string[] => closedColumns(range).map((column) => column.key)

test('the Ticket column sits between PR and Title only when a row in the range has a ticket', async () => {
  const closed = await fixtureClosed()
  assert.ok(hasTickets(closed.today))
  assert.deepEqual(keys(closed.today), ['outcome', 'pr', 'ticket', 'title', 'author', 'closedBy', 'when'])
  // a no-ticket marker alone still shows the column
  const markerOnly = { ...closed.today, rows: closed.today.rows.filter((row) => row.tickets.every((ticket) => ticket.system === 'none')) }
  assert.equal(markerOnly.rows.length, 1)
  assert.deepEqual(keys(markerOnly), keys(closed.today))
  // no ticket systems, or an empty range, hides it
  const untracked = await fixtureClosed({ tickets: [] })
  assert.ok(untracked.yesterday.rows.length > 0)
  assert.equal(hasTickets(untracked.yesterday), false)
  assert.deepEqual(keys(untracked.yesterday), ['outcome', 'pr', 'title', 'author', 'closedBy', 'when'])
  assert.deepEqual(keys(rangesAt('2026-10-27T14:05:38Z').today), keys(untracked.yesterday))
  assert.equal(closedColumns(closed.today).find((column) => column.key === 'ticket')?.sort, closedSortValues.ticket)
})

test('Ticket sorts by the first ticket\'s label, rows without one last', async () => {
  const closed = await fixtureClosed()
  const rows: ClosedRow[] = [...closed.today.rows, ...closed.yesterday.rows]
  assert.ok(rows.some((row) => row.tickets.length === 0))
  const sorted = [...rows].sort(comparator(closedSortValues.ticket, 'asc'))
  const labels = sorted.map((row) => row.tickets[0]?.label ?? null)
  const firstEmpty = labels.indexOf(null)
  assert.ok(firstEmpty > 0)
  assert.ok(labels.slice(firstEmpty).every((label) => label === null), 'rows without a ticket come last')
  const present = labels.slice(0, firstEmpty) as string[]
  assert.deepEqual(present, [...present].sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' })))
})

test('the range switches locally and releases a tile only when it changes', () => {
  const pressed = { ...initialControls(), tile: 'closedToday' as const }
  assert.equal(setClosedRange(pressed, 'today'), pressed)
  assert.deepEqual(setClosedRange(pressed, 'yesterday'), { ...pressed, closedRange: 'yesterday', tile: null })
})
