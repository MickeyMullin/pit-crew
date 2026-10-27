// public/status.ts
// what the page says about freshness, from the view's sync and this page's own pause: the
// header's sync status, the offline banner, row and section markers and the tables' states; pure
import type { OpenRow, RowRefresh } from '../src/derive.ts'
import type { Sync } from '../src/poller.ts'
import { formatAge, formatCached, formatInterval, formatSince } from './format.ts'
import { rowFreshness } from './state.ts'

// paused is this page's own state; timeZone is named only by tests
export type Reading = { paused: boolean, nowMs: number, timeZone?: string }

export type SyncTone = 'normal' | 'warn'

export type SyncStatus = {
  text: string
  tone: SyncTone
  // changes only when a cycle starts or ends, or the page pauses or resumes: the live region
  // announces on a change of key, never per patch
  key: string
}

const progress = (sync: Sync): string => {
  const cycle = sync.cycle
  if (cycle === null || cycle.prsTotal === null) return 'refreshing…'
  return `refreshing · ${cycle.prsUpdated} of ${cycle.prsTotal}`
}

const updated = (sync: Sync, nowMs: number): string =>
  sync.lastSuccessAt === null ? 'not updated yet' : `updated ${formatSince(sync.lastSuccessAt, nowMs)}`

const failed = (sync: Pick<Sync, 'cycle'>): boolean => sync.cycle?.state === 'failed'

// what a failed cycle says about its cause: the header's word, the banner's opening clause, and
// what the owner can do about it; a failure with no kind reads as unreachable, as before kinds
type Cause = { word: string, clause: string, fix: string }

export const failureCause = (cycle: NonNullable<Sync['cycle']>): Cause => {
  switch (cycle.errorKind) {
    case null:
    case 'network':
      return { word: 'offline', clause: 'Can\'t reach GitHub', fix: '' }
    case 'auth':
      return { word: 'sign-in failed', clause: 'GitHub did not accept gh\'s sign-in', fix: 'Check it with gh auth status in a terminal. ' }
    case 'rateLimit':
      return { word: 'rate-limited', clause: 'GitHub\'s rate limit stopped the refresh', fix: '' }
    case 'interrupted':
      return { word: 'interrupted', clause: 'The last refresh stopped when Pit View did', fix: '' }
    default: {
      const reason = (cycle.error ?? 'unknown error').trim().replace(/[.\s]+$/, '')
      return { word: 'refresh failed', clause: `The refresh failed (${reason})`, fix: '' }
    }
  }
}

// the oldest data shown: the open section is as old as its oldest row, so the sections suffice
export const oldestFetch = (sync: Pick<Sync, 'sections'>): string | null => {
  const times = [sync.sections.open.fetchedAt, sync.sections.closed.fetchedAt].filter((at): at is string => at !== null)
  return times.length === 0 ? null : times.reduce((oldest, at) => Date.parse(at) < Date.parse(oldest) ? at : oldest)
}

export const syncStatus = (sync: Sync, { paused, nowMs, timeZone }: Reading): SyncStatus => {
  const cycle = sync.cycle
  const key = `${cycle?.id ?? 0}:${cycle?.state ?? 'none'}:${paused ? 'paused' : 'live'}`
  if (cycle !== null && cycle.state === 'running') return { text: progress(sync), tone: 'normal', key }
  const pausedLead = paused ? 'paused · ' : ''
  if (cycle !== null && failed(sync)) {
    const oldest = oldestFetch(sync)
    const cached = oldest === null ? 'nothing cached yet' : `cached ${formatCached(oldest, nowMs, timeZone)}`
    return { text: `${pausedLead}${failureCause(cycle).word} · ${cached}`, tone: 'warn', key }
  }
  if (paused) return { text: `paused · ${updated(sync, nowMs)}`, tone: 'warn', key }
  return { text: `${updated(sync, nowMs)} · every ${formatInterval(sync.refreshSeconds)}`, tone: 'normal', key }
}

export type Banner = { lead: string, detail: string }

// the amber strip under the header, only while the latest cycle has failed
export const offlineBanner = (sync: Sync, { paused, nowMs, timeZone }: Reading): Banner | null => {
  const cycle = sync.cycle
  if (cycle === null || cycle.state !== 'failed') return null
  const retry = paused ? 'Updates are paused; Refresh retries once.' : `Retrying every ${formatInterval(sync.refreshSeconds)}.`
  const { clause, fix } = failureCause(cycle)
  const oldest = oldestFetch(sync)
  if (oldest === null) return { lead: `${clause}, and nothing is cached yet.`, detail: `${fix}${retry}` }
  const cached = `${formatCached(oldest, nowMs, timeZone)} (${formatAge(oldest, nowMs)} old)`
  const partway = cycle.prsUpdated > 0 && cycle.prsTotal !== null && cycle.prsUpdated < cycle.prsTotal
  const lead = partway
    ? `Refresh stopped partway: ${cycle.prsUpdated} of ${cycle.prsTotal} PRs updated; the rest show cached data from ${cached}.`
    : `${clause}. Showing cached data from ${cached}.`
  return { lead, detail: `Ages, CI and merge states may be out of date. ${fix}${retry}` }
}

// a row's freshness marker: the amber dot when stale, a muted age when its data is older than
// the interval and a cycle is still on its way or this page is paused; none when current
export type Marker = { kind: 'stale' | 'muted', tip: string } | null

// why a row's own refresh failed, in the words the banner uses for a cycle
export const rowRefreshCause = (refresh: Extract<RowRefresh, { state: 'failed' }>): string => {
  switch (refresh.errorKind) {
    case 'network':
      return 'can\'t reach GitHub'
    case 'auth':
      return 'GitHub did not accept gh\'s sign-in; check it with gh auth status in a terminal'
    case 'rateLimit':
      return 'GitHub\'s rate limit stopped it'
    default:
      return refresh.error.trim().replace(/[.\s]+$/, '') || 'unknown error'
  }
}

// a row's own refresh, running or failed, outranks what the cycles say about it
export const rowMarker = (
  row: Pick<OpenRow, 'freshness'> & { refresh?: RowRefresh | null },
  sync: Pick<Sync, 'cycle' | 'refreshSeconds'>,
  { paused, nowMs, timeZone }: Reading,
): Marker => {
  const { fetchedAt } = row.freshness
  const state = rowFreshness(row, sync)
  const cached = `cached ${formatCached(fetchedAt, nowMs, timeZone)}`
  const refresh = row.refresh ?? null
  if (refresh?.state === 'running') return { kind: 'muted', tip: `${cached}, refreshing this PR` }
  if (refresh?.state === 'failed') return { kind: 'stale', tip: `${cached}, refreshing this PR failed: ${rowRefreshCause(refresh)}` }
  if (state === 'stale') return { kind: 'stale', tip: `${cached}, refresh failed` }
  const old = nowMs - Date.parse(fetchedAt) > sync.refreshSeconds * 1000
  if (!old) return null
  if (state === 'pending') return { kind: 'muted', tip: `${cached}, refreshing` }
  return paused ? { kind: 'muted', tip: `${cached}, paused` } : null
}

// the row's refresh button: its accessible name and tooltip, and the state it shows
export type RefreshButton = { state: 'idle' | 'running' | 'failed', label: string, tip: string }

export const refreshButton = (row: Pick<OpenRow, 'number' | 'refresh'>): RefreshButton => {
  const refresh = row.refresh
  if (refresh?.state === 'running') return { state: 'running', label: `Refreshing #${row.number}`, tip: `Refreshing #${row.number}…` }
  const label = `Refresh #${row.number}`
  if (refresh?.state === 'failed') return { state: 'failed', label, tip: `${label}; the last try failed: ${rowRefreshCause(refresh)}` }
  return { state: 'idle', label, tip: label }
}

// a stale section shows the same dot in its heading
export const sectionMarker = (section: Sync['sections']['open'], { nowMs, timeZone }: Reading): Marker =>
  section.state === 'stale' && section.fetchedAt !== null
    ? { kind: 'stale', tip: `cached ${formatCached(section.fetchedAt, nowMs, timeZone)}, refresh failed` }
    : null

// loading shows placeholders while the first fetch is on its way; once it failed, or while this
// page is paused with no cycle running, nothing is coming and the table says so
export type TableState = 'ready' | 'loading' | 'missing'

export const tableState = (section: Sync['sections']['open'], sync: Pick<Sync, 'cycle'>, paused: boolean): TableState => {
  if (section.state !== 'loading') return 'ready'
  const running = sync.cycle?.state === 'running'
  return !running && (failed(sync) || paused) ? 'missing' : 'loading'
}
