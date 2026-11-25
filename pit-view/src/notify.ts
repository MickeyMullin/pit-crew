// src/notify.ts
import { execFile } from 'node:child_process'
import type { Run } from './cache.ts'
import type { Notifications } from './config.ts'
import type { OpenRow } from './derive.ts'

// everything that can notify; the order is the Settings page's
export const notificationKinds = ['changesRequested', 'readyToMerge', 'reviewRequested', 'newForReview', 'ciFailing', 'runFinished', 'runNeedsInput', 'postBlocked', 'postFailed', 'commandDenied'] as const
export type NotificationKind = typeof notificationKinds[number]

export const isNotificationKind = (value: unknown): value is NotificationKind =>
  typeof value === 'string' && (notificationKinds as readonly string[]).includes(value)

// the kinds a macOS banner has, which are all the config's `kinds` list may hold. The kinds added since have no banner of their own: the three ways a run can end that they name banner as the finished run they always were, and a new PR for review has no banner
export const bannerKinds = ['changesRequested', 'readyToMerge', 'reviewRequested', 'ciFailing', 'runFinished', 'runNeedsInput'] as const satisfies readonly NotificationKind[]
export type BannerKind = typeof bannerKinds[number]

export const isBannerKind = (value: unknown): value is BannerKind =>
  typeof value === 'string' && (bannerKinds as readonly string[]).includes(value)

export const bannerKindOf = (kind: NotificationKind): BannerKind | null => {
  if (isBannerKind(kind)) return kind
  return kind === 'newForReview' ? null : 'runFinished'
}

// the kinds that toast while the config has no `toasts` list: what failed and what waits on the owner. A blocked post is expected on every unattended review the classifier refuses, so it stays a quiet panel entry
export const toastDefaults: readonly NotificationKind[] = ['runNeedsInput', 'postFailed', 'commandDenied']

// whether a kind toasts; the panel holds every kind either way, and the banner settings have no say
export const toasts = (kind: NotificationKind, settings: Notifications | undefined): boolean => (settings?.toasts ?? toastDefaults).includes(kind)

// the state a row is watched for: each flag is a condition, and a notification fires when one turns true that was false
export type RowState = { changesRequested: boolean, readyToMerge: boolean, reviewRequested: boolean, newForReview: boolean, ciFailing: boolean }

export const rowState = (row: OpenRow): RowState => ({
  changesRequested: row.section === 'mine' && row.group === 'changesRequested',
  readyToMerge: row.section === 'mine' && row.merge.state === 'ready',
  reviewRequested: row.section === 'others' && row.flags.some((flag) => flag.kind === 'requestedOfYou'),
  // in Your move and not for a re-review: requested of the viewer, or never reviewed by them
  newForReview: row.section === 'others' && row.group === 'yourMove' && !row.flags.some((flag) => flag.kind === 'reReview'),
  ciFailing: row.section === 'mine' && row.issues.some((issue) => issue.kind === 'ciFailing'),
})

export const noRowState: RowState = { changesRequested: false, readyToMerge: false, reviewRequested: false, newForReview: false, ciFailing: false }

// `title` is null for a run whose PR has left the open rows, so the notice names the number alone
// `run` is the run a run's event is about, and `detail` what else it says; both null for a row's
export type NotifyEvent = { kind: NotificationKind, number: number, title: string | null, repo: string, run: number | null, detail: string | null }

const rowKinds = ['changesRequested', 'readyToMerge', 'reviewRequested', 'newForReview', 'ciFailing'] as const

// the events for one row going from `before` to `after`; a row with no previous state (null) has no transition and reports only that it awaits the viewer's review, and a row marked stale reports nothing, since its state was not confirmed. A request that also makes the PR new for review is the request alone
export const rowEvents = (repo: string, before: RowState | null, after: OpenRow): NotifyEvent[] => {
  if (after.freshness.state === 'stale') return []
  const now = rowState(after)
  const turned = before === null ? rowKinds.filter((kind) => kind === 'newForReview' && now[kind]) : rowKinds.filter((kind) => now[kind] && !before[kind])
  return turned.filter((kind) => kind !== 'newForReview' || !turned.includes('reviewRequested')).map((kind) => ({ kind, number: after.number, title: after.title, repo, run: null, detail: null }))
}

// the previous states of a repo's rows for one viewer, advanced as transitions are compared. There is no flag for the first load: a baseline with no rows, at the start or after every row has been removed, is the first load, and the next comparison that finds open rows only records them.
export type RowBaseline = {
  repo: string
  viewer: string
  rows: Map<number, RowState>
  // the PRs that have awaited the viewer's review under this baseline, kept when their rows go
  awaited: Set<number>
}

// `loaded` is whether the repo has a successful cycle recorded; without one the cache holds no confirmed rows, so the baseline starts empty
export const baselineOf = (repo: string, viewer: string, rows: readonly OpenRow[], loaded: boolean): RowBaseline => {
  const states = new Map(loaded ? rows.map((row) => [row.number, rowState(row)]) : [])
  return { repo, viewer, rows: states, awaited: new Set([...states].filter(([, state]) => state.newForReview).map(([number]) => number)) }
}

// compares the baseline with the rows now (or with one row, when `only` is a PR number), advancing the baseline. Nothing fires while the baseline is empty; the first comparison that finds open rows records them as the baseline. A stale row neither fires nor moves its baseline. A row with no previous state is recorded and fires only newForReview, when it awaits the viewer's review. A PR is new for review once while the baseline lasts, so CI sending it back and forth, or its closing and reopening, never makes it new again.
export const compareRows = (baseline: RowBaseline, rows: ReadonlyMap<number, OpenRow>, only?: number): NotifyEvent[] => {
  const silent = baseline.rows.size === 0
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
    const state = rowState(row)
    if (!silent) events.push(...rowEvents(baseline.repo, baseline.rows.get(number) ?? null, row).filter((event) => event.kind !== 'newForReview' || !baseline.awaited.has(number)))
    if (state.newForReview) baseline.awaited.add(number)
    baseline.rows.set(number, state)
  }
  return events
}

// what a run's record says of its post, when its result is a review's
const notPosted = (run: Pick<Run, 'result'>): string | null => run.result?.schema === 'pit-crew/review-result@1' ? run.result.notPostedReason : null

// the review-session kinds: the one event a watched run's settled record fires. needsInput is runNeedsInput; a run that failed on a denied tool call is commandDenied; a done review whose post was refused is postBlocked, and one whose post failed is postFailed; any other done or failed run is runFinished, posted or not; and stopped and running fire nothing. A run folder that could not be written is also noted permissionDenied, but that run never spawned and has no pid. `title` is null when the PR is no longer among the open rows.
export const runEvent = (repo: string, row: { number: number, title: string | null }, run: Pick<Run, 'id' | 'status' | 'result' | 'note' | 'pid'>, detail: string | null): NotifyEvent | null => {
  const base = { number: row.number, title: row.title, repo, run: run.id, detail }
  if (run.status === 'needsInput') return { ...base, kind: 'runNeedsInput' }
  if (run.status === 'failed') return { ...base, kind: run.pid !== null && run.note?.startsWith('permissionDenied: ') === true ? 'commandDenied' : 'runFinished' }
  if (run.status !== 'done') return null
  const reason = notPosted(run)
  if (reason === 'postBlocked') return { ...base, kind: 'postBlocked' }
  return { ...base, kind: reason === 'ghFailed' ? 'postFailed' : 'runFinished' }
}

// what the user reads; the text starts with a letter or # so it can never look like an option
export type Notice = { title: string, subtitle: string, body: string }

const headlines: Readonly<Record<NotificationKind, string>> = {
  changesRequested: 'Changes requested on your PR',
  readyToMerge: 'Your PR is ready to merge',
  reviewRequested: 'Review requested of you',
  newForReview: 'PR awaiting your review',
  ciFailing: 'CI is failing on your PR',
  runFinished: 'Review session finished',
  runNeedsInput: 'Review session needs your input',
  postBlocked: 'Review done, post blocked',
  postFailed: 'Review done, post failed',
  commandDenied: 'Command denied in a session',
}

export const headlineOf = (kind: NotificationKind): string => headlines[kind]

const maxText = 200

// control characters out, whitespace collapsed, length bounded
export const cleanText = (text: string): string => {
  const flat = text.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > maxText ? `${flat.slice(0, maxText - 1)}…` : flat
}

export const noticeOf = (event: NotifyEvent): Notice => ({
  title: 'Pit View',
  subtitle: headlines[bannerKindOf(event.kind) ?? event.kind],
  body: cleanText(event.title === null ? `#${event.number}` : `#${event.number} ${event.title}`),
})

// the one platform-specific piece; tests pass a recorder, and only main() passes the real one
export type Deliver = (notice: Notice) => Promise<void>

export const noDeliver: Deliver = async () => {}

// runs a file with an argument list and no shell
export type Exec = (file: string, args: string[]) => Promise<void>

export const systemExec: Exec = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 10_000 }, (error) => error === null ? resolve() : reject(error))
})

// the AppleScript is this constant text and nothing else; the notice reaches it as arguments to `on run argv`, so no quote, backslash, or newline in a PR title can change what it does
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
  // stores every event, then delivers the banners the current config asks for; never throws and never waits for the OS
  send: (events: readonly NotifyEvent[]) => void
}

export type NotifierOptions = {
  config: () => { notifications?: Notifications }
  deliver: Deliver
  log: (line: string) => void
  // stores the events and pushes them to open pages, whatever the banner settings say; none when left out
  record?: (events: readonly NotifyEvent[]) => void
}

export const createNotifier = ({ config, deliver, log, record }: NotifierOptions): Notifier => ({
  send: (events) => {
    if (events.length === 0) return
    try {
      record?.(events)
    } catch (error) {
      log(`notifications: cannot store: ${error instanceof Error ? error.message : String(error)}`)
    }
    const settings = config().notifications
    if (settings === undefined || !settings.enabled) return
    for (const event of events) {
      const banner = bannerKindOf(event.kind)
      if (banner === null || !settings.kinds.includes(banner)) continue
      Promise.resolve().then(() => deliver(noticeOf(event))).catch((error: unknown) => {
        log(`notifications: cannot deliver ${event.kind} for #${event.number}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  },
})
