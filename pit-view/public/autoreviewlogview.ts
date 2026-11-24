// public/autoreviewlogview.ts
// the auto-review log panel's view model (section 10 of DESIGN.md, The log): each line in the owner's words, the tick-level reasons as the header and the Now line word them, the filters by PR, decision, and day, the empty states, and the run links; pure, with every clock reading passed in
import type { LogDecision, LogEntry, LogRun } from '../src/autoreviewlog.ts'
import { skipWords } from './autoreviewbar.ts'
import { formatCached, formatDay, localDateKey, plural, shortSha } from './format.ts'

export type LogFilters = {
  // '' for every line, a PR number, 'tick' for the scheduler's own lines, or 'sweep' for the Dependabot sweep's
  pr: string
  // '' or one of the decisions
  decision: string
  // '' or a local date as YYYY-MM-DD
  day: string
}

export const noFilters: LogFilters = { pr: '', decision: '', day: '' }

export type LogReading = {
  nowMs: number
  timeZone?: string
  // how many days the log keeps
  days: number
  // whether a PR is open: a closed PR's run link still opens its drawer, which then says the PR is no longer open
  isOpen: (number: number) => boolean
}

// the id of a line's element in the panel, from the entry's own id: unique to the line, the same after every repaint, and never another line's, since the store never reuses an entry's id. The drawer's link back to the log points at it
export const entryAnchor = (id: number): string => `auto-log-entry-${id}`

// key is unique to the line, so a run that has several lines (queued, started, finished) has a link on each that focus can tell apart; title and closed are what the drawer needs to open a PR that is no longer open; entryId and anchor name the line the link is on, so the drawer can lead back to it
export type LogRunLink = LogRun & { key: string, entryId: number, anchor: string, number: number | null, title: string | null, closed: boolean, text: string, name: string, opens: boolean }

export type LogLine = {
  id: number
  // the id of the line's element
  anchor: string
  when: string
  // the PR's number after a hash sign, Scheduler, or Dependabot sweep
  subject: string
  title: string | null
  text: string
  note: string | null
  tone: 'normal' | 'warn'
  count: string | null
  head: string | null
  // the model that ran the review, for a line of a run that spawned; null for the rest and for a line stored before the log kept it
  model: string | null
  run: LogRunLink | null
}

export type LogChoice = { value: string, label: string }

export type LogModel = {
  lines: LogLine[]
  empty: string | null
  prs: LogChoice[]
  decisions: LogChoice[]
  days: LogChoice[]
  summary: string
  filtered: boolean
}

const decisionWords: Readonly<Record<LogDecision, string>> = {
  checked: 'Checked PRs',
  queued: 'Queued',
  retried: 'Queued a retry',
  started: 'Started',
  skipped: 'Skipped',
  dropped: 'Dropped before start',
  finished: 'Finished',
  failed: 'Failed',
  failedTwice: 'Failed twice',
  stopped: 'Stopped',
}

const decisionOrder = Object.keys(decisionWords) as LogDecision[]

// the reasons in the owner's words: a tick's skip as the header says it, then the rest
const reasonWords: Readonly<Record<string, string>> = {
  ...skipWords,
  outsideHours: 'outside hours',
  off: 'off',
  capFull: 'review cap full',
  nothingNew: 'nothing new to queue',
  queued: 'queued new runs',
  alreadyReviewed: 'already reviewed at this head',
  inFlight: 'an auto-review run is already queued or running',
  postInFlight: 'a post for it is in flight',
  ownersRun: 'your own run of it is in flight',
  stoppedAtHead: 'you stopped its run at this head',
  postUnknown: 'its last run may have posted',
  optedOut: 'its kind is turned off in Settings',
  requested: 'review requested',
  new: 'new PR',
  pushed: 'pushed since the last review',
  selfReview: 'self-review',
  dependabot: 'Dependabot sweep',
  closed: 'the PR closed',
  ready: 'marked ready for review',
  superseded: 'replaced by a review you started',
}

// the tick-level reasons the header shows in amber
const warnReasons = new Set(Object.keys(skipWords))

// the scheduler notes a closed window or the off switch each time it plans, which is no count of anything
const uncounted = new Set(['outsideHours', 'off'])

// the words after the decision: a finished or failed run says its outcome or note, Failed twice says what it means, and the rest say why
const reasonText = (entry: LogEntry): string | null => {
  if (entry.decision === 'finished' || entry.decision === 'failed') return entry.note
  if (entry.decision === 'failedTwice') return 'left for you at this head'
  if (entry.reason === null) return null
  return reasonWords[entry.reason] ?? entry.reason
}

export const logEntryText = (entry: LogEntry): string => {
  const reason = reasonText(entry)
  return reason === null || reason === '' ? decisionWords[entry.decision] ?? entry.decision : `${decisionWords[entry.decision] ?? entry.decision}: ${reason}`
}

// the reader's local date of an instant, as YYYY-MM-DD
export const dayKey = localDateKey

const hourMs = 60 * 60_000

// every local date a line's stretch touches, oldest first; a day's span is never more than 25 hours, so stepping by 12 hours meets each one
const daysOf = (entry: LogEntry, timeZone?: string): string[] => {
  const from = Date.parse(entry.at)
  const to = Math.max(from, Date.parse(entry.lastAt))
  const keys = new Set<string>()
  for (let at = from, steps = 0; at < to && steps < 2000; at += 12 * hourMs, steps += 1) keys.add(dayKey(at, timeZone))
  keys.add(dayKey(to, timeZone))
  return [...keys]
}

const subjectOf = (entry: LogEntry): string => {
  if (entry.lane === 'tick') return 'Scheduler'
  if (entry.lane === 'sweep') return 'Dependabot sweep'
  return entry.number === null ? 'A PR' : `#${entry.number}`
}

const runLink = (entry: LogEntry, reading: LogReading): LogRunLink | null => {
  if (entry.run === null) return null
  const key = `line-${entry.id}`
  const where = { key, entryId: entry.id, anchor: entryAnchor(entry.id) }
  if (entry.run.kind === 'sweep') return { ...entry.run, ...where, number: null, title: null, closed: false, text: `sweep ${entry.run.id}`, name: `Open the sweep drawer at sweep ${entry.run.id}`, opens: true }
  const number = entry.number
  // a PR that is no longer open still opens its drawer, on the run asked for, with starts and actions off
  const closed = number !== null && !reading.isOpen(number)
  return {
    ...entry.run,
    ...where,
    number,
    title: entry.title,
    closed,
    text: `run ${entry.run.id}`,
    name: number === null ? `Run ${entry.run.id}: its PR is not known, so its drawer cannot open` : `Open the Agent drawer of #${number}, run ${entry.run.id}${closed ? ' (the PR is closed)' : ''}`,
    opens: number !== null,
  }
}

const lineOf = (entry: LogEntry, reading: LogReading): LogLine => {
  const first = formatCached(entry.at, reading.nowMs, reading.timeZone)
  const stretch = entry.lastAt !== entry.at
  return {
    id: entry.id,
    anchor: entryAnchor(entry.id),
    when: stretch ? `${first} to ${formatCached(entry.lastAt, reading.nowMs, reading.timeZone)}` : first,
    subject: subjectOf(entry),
    title: entry.title,
    text: logEntryText(entry),
    note: entry.decision === 'finished' || entry.decision === 'failed' ? null : entry.note,
    tone: entry.decision === 'failed' || entry.decision === 'failedTwice' || (entry.lane === 'tick' && entry.decision === 'skipped' && entry.reason !== null && warnReasons.has(entry.reason)) ? 'warn' : 'normal',
    count: entry.count > 1 && !(entry.reason !== null && uncounted.has(entry.reason)) ? `${entry.count} times` : null,
    head: entry.head === null ? null : shortSha(entry.head),
    model: entry.model ?? null,
    run: runLink(entry, reading),
  }
}

const prKey = (entry: LogEntry): string => entry.lane === 'pr' ? String(entry.number ?? '') : entry.lane

const prLabel = (value: string): string => value === 'tick' ? 'Scheduler only' : value === 'sweep' ? 'Dependabot sweeps' : `#${value}`

// PRs newest number first, then the scheduler's own lines, then the sweep's
const prRank = (value: string): number => value === 'tick' ? -1 : value === 'sweep' ? -2 : Number(value)

export const logModel = (entries: readonly LogEntry[], filters: LogFilters, reading: LogReading): LogModel => {
  const today = dayKey(reading.nowMs, reading.timeZone)
  const matches = (entry: LogEntry): boolean =>
    (filters.pr === '' || prKey(entry) === filters.pr)
    && (filters.decision === '' || entry.decision === filters.decision)
    && (filters.day === '' || daysOf(entry, reading.timeZone).includes(filters.day))
  const shown = entries.filter(matches)
  // a choice the filters hold stays offered even when the log no longer has it, so a select never loses its value
  const prValues = new Set(entries.map(prKey))
  if (filters.pr !== '') prValues.add(filters.pr)
  const decisionValues = new Set<string>(entries.map((entry) => entry.decision))
  if (filters.decision !== '') decisionValues.add(filters.decision)
  const dayValues = new Set(entries.flatMap((entry) => daysOf(entry, reading.timeZone)))
  if (filters.day !== '') dayValues.add(filters.day)
  const filtered = filters.pr !== '' || filters.decision !== '' || filters.day !== ''
  const kept = `Kept for ${plural(reading.days, 'day', 'days')}, newest first.`
  const count = entries.length === 0 ? 'No lines.' : filtered ? `Showing ${shown.length} of ${plural(entries.length, 'line', 'lines')}.` : `${plural(entries.length, 'line', 'lines')}.`
  return {
    lines: shown.map((entry) => lineOf(entry, reading)),
    empty: entries.length === 0 ? 'Nothing recorded yet. Each decision the scheduler makes adds a line here.' : shown.length === 0 ? 'No lines match these filters.' : null,
    prs: [{ value: '', label: 'All PRs' }, ...[...prValues].sort((a, b) => prRank(b) - prRank(a)).map((value) => ({ value, label: prLabel(value) }))],
    decisions: [{ value: '', label: 'All decisions' }, ...decisionOrder.filter((decision) => decisionValues.has(decision)).map((decision) => ({ value: decision, label: decisionWords[decision] })), ...[...decisionValues].filter((value) => !decisionOrder.includes(value as LogDecision)).map((value) => ({ value, label: value }))],
    days: [{ value: '', label: 'All days' }, ...[...dayValues].sort().reverse().map((value) => ({ value, label: value === today ? 'Today' : formatDay(`${value}T12:00:00Z`, 'UTC') }))],
    summary: `${kept} ${count}`,
    filtered,
  }
}

// how many days the log keeps when the config does not say: a copy of autoReviewLogDays in src/autoreviewlog.ts, which a test keeps in step (the page cannot import that module's code)
export const defaultLogDays = 14

// the Settings line under the Auto-review card, from the days the config keeps
export const logRetentionLine = (days: number): string =>
  `The auto-review log keeps what the scheduler decided, and why, for ${plural(days, 'day', 'days')}. Open it with Log in the header's Auto-review menu.`
