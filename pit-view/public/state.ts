// public/state.ts
// the page's data model: the view from /api/view with patches applied in order, regrouped
// client-side, plus the freshness and sync readings the header and rows show; no DOM here
import type { FreshnessState, MineRow, MineSection, OpenRow, OtherRow, OthersSection } from '../src/derive.ts'
import type { Patch, Sync, View } from '../src/poller.ts'

export type { Patch, View }

// every open row the view holds, across both sections
export const openRows = (view: Pick<View, 'mine' | 'others'>): OpenRow[] => [
  ...view.mine.groups.flatMap((group) => group.rows),
  ...view.others.groups.flatMap((group) => group.rows),
]

// attention order, as the server sorts: Re-review, then Requested of you, then most recent activity first
const flagRank = (row: OpenRow): number => {
  if (row.section !== 'others') return 2
  if (row.flags.some((flag) => flag.kind === 'reReview')) return 0
  return row.flags.some((flag) => flag.kind === 'requestedOfYou') ? 1 : 2
}

export const attentionOrder = (a: OpenRow, b: OpenRow): number =>
  flagRank(a) - flagRank(b) || Date.parse(b.lastActivity.at) - Date.parse(a.lastActivity.at) || b.number - a.number

// the bot group takes the bot's alias when only one bot appears
export const botGroupLabel = (rows: readonly OtherRow[]): string => {
  const aliases = [...new Set(rows.map((row) => row.author.alias))]
  return aliases.length === 1 && aliases[0] !== undefined ? aliases[0] : 'Bots'
}

// patches carry no groups, so rows are regrouped here; labels, subs and collapsible come from
// the view's own groups, which are always all present and in display order
export const regroup = (
  shape: Pick<View, 'mine' | 'others'>,
  rows: readonly OpenRow[],
): { mine: MineSection, others: OthersSection } => {
  const sorted = [...rows].sort(attentionOrder)
  const mine = sorted.filter((row): row is MineRow => row.section === 'mine')
  const others = sorted.filter((row): row is OtherRow => row.section === 'others')
  return {
    mine: { groups: shape.mine.groups.map((group) => ({ ...group, rows: mine.filter((row) => row.group === group.key) })) },
    others: {
      groups: shape.others.groups.map((group) => {
        const groupRows = others.filter((row) => row.group === group.key)
        return { ...group, label: group.key === 'bots' ? botGroupLabel(groupRows) : group.label, rows: groupRows }
      }),
    },
  }
}

// one patch onto a view: removed and upserted rows by number, closed replaced when present,
// tiles, counts, sync and sweeps replaced whole, repo and viewer only when a config change sent them
export const applyPatch = (view: View, patch: Patch): View => {
  const rows = new Map(openRows(view).map((row) => [row.number, row]))
  for (const number of patch.removed) rows.delete(number)
  for (const row of patch.rows) rows.set(row.number, row)
  return {
    ...view,
    version: patch.version,
    now: patch.now,
    repo: patch.repo ?? view.repo,
    viewer: patch.viewer ?? view.viewer,
    tiles: patch.tiles ?? view.tiles,
    counts: patch.counts ?? view.counts,
    sync: patch.sync ?? view.sync,
    closed: patch.closed ?? view.closed,
    // sent whole when a sweep or its start text changed
    sweeps: patch.sweeps ?? view.sweeps,
    ...regroup(view, [...rows.values()]),
  }
}

// the stream opens first, then the view is fetched: patches wait in the buffer until it arrives
export type Feed = {
  view: View | null
  buffer: Patch[]
  // a view fetch is wanted or in flight; patches are buffered meanwhile
  awaiting: boolean
}

// what the page should do after a step: draw the new view, and fetch /api/view again
export type FeedStep = { feed: Feed, render: boolean, refetch: boolean }

export const emptyFeed = (): Feed => ({ view: null, buffer: [], awaiting: true })

// a reconnect means the page refetches the view and starts again from it; the old view stays shown
export const restartFeed = (feed: Feed): Feed => ({ view: feed.view, buffer: [], awaiting: true })

export const receivePatch = (feed: Feed, patch: Patch): FeedStep => {
  if (feed.awaiting || feed.view === null) return { feed: { ...feed, buffer: [...feed.buffer, patch] }, render: false, refetch: false }
  if (patch.version <= feed.view.version) return { feed, render: false, refetch: false }
  if (patch.version !== feed.view.version + 1) return { feed: { view: feed.view, buffer: [patch], awaiting: true }, render: false, refetch: true }
  return { feed: { ...feed, view: applyPatch(feed.view, patch) }, render: true, refetch: false }
}

// a fetched view is the new base, whatever its version (a restarted server counts from zero
// again); buffered patches at or below it are dropped and the rest applied in order
export const receiveView = (feed: Feed, view: View): FeedStep => {
  const later = feed.buffer.filter((patch) => patch.version > view.version).sort((a, b) => a.version - b.version)
  let current = view
  for (const patch of later) {
    if (patch.version !== current.version + 1) {
      return { feed: { view: current, buffer: later.filter((p) => p.version > current.version), awaiting: true }, render: true, refetch: true }
    }
    current = applyPatch(current, patch)
  }
  return { feed: { view: current, buffer: [], awaiting: false }, render: true, refetch: false }
}

// rows are not re-sent as pending when a cycle starts: while one runs, a row fetched before it
// started is pending; otherwise the row's own state stands
export const rowFreshness = (row: Pick<OpenRow, 'freshness'>, sync: Pick<Sync, 'cycle'>): FreshnessState => {
  const cycle = sync.cycle
  if (cycle !== null && cycle.state === 'running' && Date.parse(row.freshness.fetchedAt) < Date.parse(cycle.startedAt)) return 'pending'
  return row.freshness.state
}

export const findOpenRow = (view: View, number: number): OpenRow | undefined =>
  openRows(view).find((row) => row.number === number)
