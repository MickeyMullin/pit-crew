// public/format.ts
// pure formatting for the page: ages, durations, times, and counts; every clock reading is passed in

const second = 1000
const minute = 60 * second
const hour = 60 * minute
const day = 24 * hour

// relative age as section 5 writes it: minutes under an hour, hours under a day, days otherwise
export const formatAge = (fromIso: string, nowMs: number): string => {
  const elapsed = Math.max(0, nowMs - Date.parse(fromIso))
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`
  return `${Math.floor(elapsed / day)}d`
}

// the header's "updated 38s ago": seconds under a minute, then the row ages
export const formatSince = (fromIso: string, nowMs: number): string => {
  const elapsed = Math.max(0, nowMs - Date.parse(fromIso))
  if (elapsed < 10 * second) return 'just now'
  if (elapsed < minute) return `${Math.floor(elapsed / second)}s ago`
  return `${formatAge(fromIso, nowMs)} ago`
}

// how long a run has gone: seconds under a minute, minutes under an hour, then hours and minutes
export const formatDuration = (fromIso: string, nowMs: number): string => {
  const elapsed = Math.max(0, nowMs - Date.parse(fromIso))
  if (elapsed < minute) return `${Math.floor(elapsed / second)}s`
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`
  const minutes = Math.floor((elapsed % hour) / minute)
  return minutes === 0 ? `${Math.floor(elapsed / hour)}h` : `${Math.floor(elapsed / hour)}h ${minutes}m`
}

// refreshSeconds as the header shows it: "every 5m"
export const formatInterval = (seconds: number): string =>
  seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`

// the Settings preference for how clock times read; this module is the only place a time is turned into text, so one switch covers every screen
export type TimeFormat = '12h' | '24h'

let timeFormat: TimeFormat = '12h'

export const getTimeFormat = (): TimeFormat => timeFormat

export const setTimeFormat = (format: TimeFormat): void => {
  timeFormat = format
}

// anything but 24h is the 12 hour default, as for a config that predates the setting
export const parseTimeFormat = (value: unknown): TimeFormat => value === '24h' ? '24h' : '12h'

type DateStyle = 'clock' | 'weekdayClock' | 'day'

const clockOptions = (): Intl.DateTimeFormatOptions =>
  timeFormat === '24h' ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' }

const styleOptions = (style: DateStyle): Intl.DateTimeFormatOptions => {
  switch (style) {
    case 'clock':
      return clockOptions()
    case 'weekdayClock':
      return { weekday: 'short', ...clockOptions() }
    default:
      return { weekday: 'short', month: 'short', day: 'numeric' }
  }
}

const formats = new Map<string, Intl.DateTimeFormat>()

// the browser's zone unless one is named; tests name one so they read the same anywhere
const formatOf = (style: DateStyle, timeZone: string | undefined): Intl.DateTimeFormat => {
  const key = `${style}:${timeFormat}:${timeZone ?? ''}`
  let format = formats.get(key)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', { ...styleOptions(style), ...(timeZone === undefined ? {} : { timeZone }) })
    formats.set(key, format)
  }
  return format
}

// an instant as an ISO string from the server or as milliseconds from the page's own arithmetic
export type Instant = string | number

const dateOf = (at: Instant): Date => new Date(typeof at === 'number' ? at : Date.parse(at))

// "5:53 PM", or "Sun 5:53 PM" when the range spans several days
export const formatClock = (at: Instant, withWeekday = false, timeZone?: string): string =>
  formatOf(withWeekday ? 'weekdayClock' : 'clock', timeZone).format(dateOf(at))

// "Mon Oct 26"
export const formatDay = (at: Instant, timeZone?: string): string =>
  formatOf('day', timeZone).format(dateOf(at)).replace(',', '')

// a cache time: "10:02 AM" today, "Fri 10:02 AM" on an earlier day
export const formatCached = (iso: string, nowMs: number, timeZone?: string): string =>
  formatClock(iso, formatDay(iso, timeZone) !== formatDay(nowMs, timeZone), timeZone)

// the browser's IANA zone name, which Settings offers for the day boundary; it is a name, not a time
export const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

export const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

// a head SHA as rows show it
export const shortSha = (sha: string): string => sha.slice(0, 7)
