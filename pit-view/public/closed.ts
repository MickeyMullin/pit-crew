// public/closed.ts
// the Closed section's pure parts: the Today / Yesterday control, the range summary, the
// Monday footnote and whether the Ticket column shows; no DOM here
import type { ClosedRange, ClosedRow, ClosedView } from '../src/derive.ts'
import type { ClosedRangeKey } from './filters.ts'
import { formatDay } from './format.ts'

const hour = 3_600_000

const dayAt = (ms: number, timeZone: string | undefined): string => formatDay(new Date(ms).toISOString(), timeZone)

// a range's days, "Mon Oct 26" or "Fri Oct 23 – Sun Oct 25"; each end is read twelve hours
// inside the range, so a day that DST lengthens or shortens, or a range of UTC days
// (todayStartsAt utc) read in another browser zone, still names its own dates
export const rangeDays = (range: Pick<ClosedRange, 'from' | 'to' | 'isMondayRule'>, timeZone?: string): string => {
  const first = dayAt(Date.parse(range.from) + 12 * hour, timeZone)
  return range.isMondayRule ? `${first} – ${dayAt(Date.parse(range.to) - 12 * hour, timeZone)}` : first
}

export const closedTally = (rows: readonly Pick<ClosedRow, 'outcome'>[]): string => {
  const merged = rows.filter((row) => row.outcome === 'merged').length
  return `${merged} merged, ${rows.length - merged} closed unmerged`
}

// beside the heading: "Mon Oct 26 · 10 merged, 3 closed unmerged"
export const closedSummary = (range: ClosedRange, timeZone?: string): string =>
  `${rangeDays(range, timeZone)} · ${closedTally(range.rows)}`

export type RangeButton = { key: ClosedRangeKey, label: string, pressed: boolean, tip: string }

// the segmented control; on a Monday Yesterday reads Yesterday* and covers Friday through Sunday
export const rangeButtons = (closed: ClosedView, selected: ClosedRangeKey, timeZone?: string): RangeButton[] => [
  { key: 'today', label: closed.today.label, pressed: selected === 'today', tip: rangeDays(closed.today, timeZone) },
  {
    key: 'yesterday',
    label: closed.yesterday.label,
    pressed: selected === 'yesterday',
    tip: closed.yesterday.isMondayRule ? 'Monday: covers Friday through Sunday' : rangeDays(closed.yesterday, timeZone),
  },
]

// shown under the table whenever Yesterday carries the asterisk
export const mondayNote = (closed: ClosedView): string | null =>
  closed.yesterday.isMondayRule ? '* On Mondays, Yesterday covers Friday through Sunday.' : null

// the Ticket column shows only when a row in the range has one; a no-ticket marker counts
export const hasTickets = (range: Pick<ClosedRange, 'rows'>): boolean => range.rows.some((row) => row.tickets.length > 0)
