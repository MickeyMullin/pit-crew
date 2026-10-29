// src/notify.ts
import { execFile } from 'node:child_process'
import type { Notifications } from './config.ts'
import type { OpenRow } from './derive.ts'

// the transitions that can notify; the order is the Settings page's
export const notificationKinds = ['changesRequested', 'readyToMerge', 'reviewRequested', 'ciFailing', 'runFinished', 'runNeedsInput'] as const
export type NotificationKind = typeof notificationKinds[number]

export const isNotificationKind = (value: unknown): value is NotificationKind =>
  typeof value === 'string' && (notificationKinds as readonly string[]).includes(value)

// the state a row is watched for: each flag is a condition, and a notification fires when one
// turns true that was false
export type RowState = { changesRequested: boolean, readyToMerge: boolean, reviewRequested: boolean, ciFailing: boolean }

export const rowState = (row: OpenRow): RowState => ({
  changesRequested: row.section === 'mine' && row.group === 'changesRequested',
  readyToMerge: row.section === 'mine' && row.merge.state === 'ready',
  reviewRequested: row.section === 'others' && row.flags.some((flag) => flag.kind === 'requestedOfYou'),
  ciFailing: row.section === 'mine' && row.issues.some((issue) => issue.kind === 'ciFailing'),
})

export const noRowState: RowState = { changesRequested: false, readyToMerge: false, reviewRequested: false, ciFailing: false }

// `title` is null for a run whose PR has left the open rows, so the notice names the number alone
export type NotifyEvent = { kind: NotificationKind, number: number, title: string | null, repo: string }

const rowKinds = ['changesRequested', 'readyToMerge', 'reviewRequested', 'ciFailing'] as const

// the events for one row going from `before` to `after`; a row with no previous state (null) has
// no transition and reports nothing, and a row marked stale reports nothing, since its state was
// not confirmed
export const rowEvents = (repo: string, before: RowState | null, after: OpenRow): NotifyEvent[] => {
  if (before === null || after.freshness.state === 'stale') return []
  const now = rowState(after)
  return rowKinds.filter((kind) => now[kind] && !before[kind]).map((kind) => ({ kind, number: after.number, title: after.title, repo }))
}

// the previous states of a repo's rows, advanced as transitions are compared; `firstLoad` holds
// until a nonempty baseline has been recorded
export type RowBaseline = { repo: string, rows: Map<number, RowState>, firstLoad: boolean }

export const baselineOf = (repo: string, rows: readonly OpenRow[], loaded: boolean): RowBaseline =>
  ({ repo, rows: new Map(rows.map((row) => [row.number, rowState(row)])), firstLoad: !loaded || rows.length === 0 })

// compares the baseline with the rows now (or with one row, when `only` is a PR number),
// advancing the baseline. Nothing fires while the baseline is the first load, which ends with
// the first comparison that finds open rows. A stale row neither fires nor moves its baseline.
// A row with no previous state is recorded and fires nothing.
export const compareRows = (baseline: RowBaseline, rows: ReadonlyMap<number, OpenRow>, only?: number): NotifyEvent[] => {
  const silent = baseline.firstLoad
  // a single row cannot settle the first load: the cycle that finishes it does
  if (silent && only !== undefined) return []
  const events: NotifyEvent[] = []
  const numbers = only === undefined ? new Set([...baseline.rows.keys(), ...rows.keys()]) : new Set([only])
  for (const number of numbers) {
    const row = rows.get(number)
    if (row === undefined) {
      baseline.rows.delete(number)
      continue
    }
    if (row.freshness.state === 'stale') continue
    if (!silent) events.push(...rowEvents(baseline.repo, baseline.rows.get(number) ?? null, row))
    baseline.rows.set(number, rowState(row))
  }
  if (only === undefined && rows.size > 0) baseline.firstLoad = false
  return events
}

// the review-session kinds: a run's status as last seen, by PR, and what a new status fires
export type RunSeen = { runId: number, status: string }

// a run settles once it was running (the same run, as last seen), or once it is first seen already
// settled and was requested during this server's lifetime (its start failed before it ever ran);
// a run first seen already settled that was requested before this server started is history and
// fires nothing. A stopped run fires nothing, and a run already settled fires nothing again.
// `title` is null when the PR is no longer among the open rows.
export const runEvent = (repo: string, row: { number: number, title: string | null }, before: RunSeen | undefined, after: RunSeen, requestedHere = false): NotifyEvent | null => {
  const wasRunning = before !== undefined && before.runId === after.runId && before.status === 'running'
  const sameSettled = before !== undefined && before.runId === after.runId && before.status !== 'running'
  if (sameSettled || !(wasRunning || requestedHere)) return null
  const base = { number: row.number, title: row.title, repo }
  if (after.status === 'done' || after.status === 'failed') return { ...base, kind: 'runFinished' }
  if (after.status === 'needsInput') return { ...base, kind: 'runNeedsInput' }
  return null
}

// what the user reads; the text starts with a letter or # so it can never look like an option
export type Notice = { title: string, subtitle: string, body: string }

const headlines: Readonly<Record<NotificationKind, string>> = {
  changesRequested: 'Changes requested on your PR',
  readyToMerge: 'Your PR is ready to merge',
  reviewRequested: 'Review requested of you',
  ciFailing: 'CI is failing on your PR',
  runFinished: 'Review session finished',
  runNeedsInput: 'Review session needs your input',
}

const maxText = 200

// control characters out, whitespace collapsed, length bounded
const clean = (text: string): string => {
  const flat = text.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > maxText ? `${flat.slice(0, maxText - 1)}…` : flat
}

export const noticeOf = (event: NotifyEvent): Notice => ({
  title: 'Pit View',
  subtitle: headlines[event.kind],
  body: clean(event.title === null ? `#${event.number}` : `#${event.number} ${event.title}`),
})

// the one platform-specific piece; tests pass a recorder, and only main() passes the real one
export type Deliver = (notice: Notice) => Promise<void>

export const noDeliver: Deliver = async () => {}

// runs a file with an argument list and no shell
export type Exec = (file: string, args: string[]) => Promise<void>

export const systemExec: Exec = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 10_000 }, (error) => error === null ? resolve() : reject(error))
})

// the AppleScript is this constant text and nothing else; the notice reaches it as arguments to
// `on run argv`, so no quote, backslash, or newline in a PR title can change what it does
export const appleScript = [
  'on run argv',
  'display notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv)',
  'end run',
]

export const osascriptArgs = (notice: Notice): string[] =>
  [...appleScript.flatMap((line) => ['-e', line]), notice.title, notice.subtitle, notice.body]

// macOS through the built-in osascript; any other platform delivers nothing
export const systemDeliver = (platform: string, exec: Exec): Deliver =>
  platform === 'darwin' ? (notice) => exec('osascript', osascriptArgs(notice)) : noDeliver

export type Notifier = {
  // delivers the events the current config asks for; never throws and never waits for the OS
  send: (events: readonly NotifyEvent[]) => void
}

export type NotifierOptions = {
  config: () => { notifications?: Notifications }
  deliver: Deliver
  log: (line: string) => void
}

export const createNotifier = ({ config, deliver, log }: NotifierOptions): Notifier => ({
  send: (events) => {
    const settings = config().notifications
    if (settings === undefined || !settings.enabled) return
    for (const event of events) {
      if (!settings.kinds.includes(event.kind)) continue
      Promise.resolve().then(() => deliver(noticeOf(event))).catch((error: unknown) => {
        log(`notifications: cannot deliver ${event.kind} for #${event.number}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  },
})
