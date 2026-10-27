// public/format.ts
// pure formatting for the page: ages, times and counts; every clock reading is passed in

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

// refreshSeconds as the header shows it: "every 5m"
export const formatInterval = (seconds: number): string =>
  seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`

type DateStyle = 'clock' | 'weekdayClock' | 'day'

const styles: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  clock: { hour: 'numeric', minute: '2-digit' },
  weekdayClock: { weekday: 'short', hour: 'numeric', minute: '2-digit' },
  day: { weekday: 'short', month: 'short', day: 'numeric' },
}

const formats = new Map<string, Intl.DateTimeFormat>()

// the browser's zone unless one is named; tests name one so they read the same anywhere
const formatOf = (style: DateStyle, timeZone: string | undefined): Intl.DateTimeFormat => {
  const key = `${style}:${timeZone ?? ''}`
  let format = formats.get(key)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', { ...styles[style], ...(timeZone === undefined ? {} : { timeZone }) })
    formats.set(key, format)
  }
  return format
}

// "5:53 PM", or "Sun 5:53 PM" when the range spans several days
export const formatClock = (iso: string, withWeekday = false, timeZone?: string): string =>
  formatOf(withWeekday ? 'weekdayClock' : 'clock', timeZone).format(new Date(Date.parse(iso)))

// "Mon Oct 26"
export const formatDay = (iso: string, timeZone?: string): string =>
  formatOf('day', timeZone).format(new Date(Date.parse(iso))).replace(',', '')

// a cache time: "10:02 AM" today, "Fri 10:02 AM" on an earlier day
export const formatCached = (iso: string, nowMs: number, timeZone?: string): string =>
  formatClock(iso, formatDay(iso, timeZone) !== formatDay(new Date(nowMs).toISOString(), timeZone), timeZone)

export const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

// a head SHA as rows show it
export const shortSha = (sha: string): string => sha.slice(0, 7)
