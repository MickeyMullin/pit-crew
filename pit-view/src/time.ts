// src/time.ts
import type { Clock, Config } from './config.ts'

export const minute = 60_000
export const hour = 60 * minute
export const day = 24 * hour

// relative age: minutes under an hour, hours under a day, days otherwise
export const formatAge = (fromIso: string, clock: Clock): string => {
  const elapsed = Math.max(0, clock.now() - Date.parse(fromIso))
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`
  return `${Math.floor(elapsed / day)}d`
}

export const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.000Z$/, 'Z')

// timeZone is the machine's IANA zone, resolved by the server; utc mode ignores it
export type DayOptions = { todayStartsAt: Config['todayStartsAt'], timeZone: string }

export const zoneOf = ({ todayStartsAt, timeZone }: DayOptions): string =>
  todayStartsAt === 'utc' ? 'UTC' : timeZone

// a calendar date; month is 1-based
export type LocalDate = { year: number, month: number, day: number }

const formatters = new Map<string, Intl.DateTimeFormat>()

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

// the wall clock in timeZone at an instant, as if it were UTC
const wallClock = (ms: number, timeZone: string): number => {
  const parts: Record<string, number> = {}
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  const get = (key: string): number => parts[key] ?? 0
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
}

// how far timeZone's wall clock is ahead of UTC at an instant
const offsetAt = (ms: number, timeZone: string): number => wallClock(ms, timeZone) - Math.floor(ms / 1000) * 1000

export const localDateOf = (ms: number, timeZone: string): LocalDate => {
  const wall = new Date(wallClock(ms, timeZone))
  return { year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1, day: wall.getUTCDate() }
}

export const addDays = (date: LocalDate, days: number): LocalDate => {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() }
}

// 0 is Sunday, 1 is Monday
export const weekdayOf = (date: LocalDate): number => new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()

const sameDate = (a: LocalDate, b: LocalDate): boolean => a.year === b.year && a.month === b.month && a.day === b.day

// the first instant of a calendar date in timeZone, DST included
export const startOfDate = (date: LocalDate, timeZone: string): number => {
  const midnight = Date.UTC(date.year, date.month - 1, date.day)
  let start = midnight - offsetAt(midnight, timeZone)
  start = midnight - offsetAt(start, timeZone)
  // where DST skips midnight the day starts at the first hour that exists
  for (let step = 0; step < 4 && !sameDate(localDateOf(start, timeZone), date); step += 1) start += hour
  return start
}

export const startOfDay = (ms: number, timeZone: string): number => startOfDate(localDateOf(ms, timeZone), timeZone)

export type Range = { label: string, isMondayRule: boolean, from: string, to: string }
export type ClosedRanges = { today: Range, yesterday: Range }

// Today runs from the start of the day to now; Yesterday is the previous day, or
// Friday 00:00 through Sunday 24:00 when today is a Monday
export const closedRanges = (clock: Clock, options: DayOptions): ClosedRanges => {
  const zone = zoneOf(options)
  const now = clock.now()
  const today = localDateOf(now, zone)
  const todayFrom = startOfDate(today, zone)
  const isMonday = weekdayOf(today) === 1
  const yesterdayFrom = startOfDate(addDays(today, isMonday ? -3 : -1), zone)
  return {
    today: { label: 'Today', isMondayRule: false, from: iso(todayFrom), to: iso(now) },
    yesterday: { label: isMonday ? 'Yesterday*' : 'Yesterday', isMondayRule: isMonday, from: iso(yesterdayFrom), to: iso(todayFrom) },
  }
}

// the window the closed search covers: the start of Yesterday through now
export const closedSearchWindow = (clock: Clock, options: DayOptions): { from: string, to: string } => {
  const { today, yesterday } = closedRanges(clock, options)
  return { from: yesterday.from, to: today.to }
}
