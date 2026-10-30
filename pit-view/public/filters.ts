// public/filters.ts
// the page's own table controls, pure: filters and their predicates, the sort cycle and its
// keys, Group by status, and the summary tiles as filter presets; no DOM here
import type { ClosedRow, MineGroup, MineRow, OpenRow, OtherGroup, OtherRow } from '../src/derive.ts'
import { plural } from './format.ts'
import { attentionOrder } from './state.ts'
import type { ShownGroup, TableKey } from './tables.ts'

export type MineFilters = {
  query: string
  status: 'any' | MineGroup
  issues: 'any' | 'none' | 'changesRequested' | 'conflicts' | 'ciFailing'
  selfReview: 'any' | 'current' | 'stale' | 'none'
  merge: 'any' | 'ready' | 'notReady'
}

export type OthersFilters = {
  query: string
  status: 'any' | OtherGroup
  // an alias, or '' for all authors
  author: string
  issues: 'any' | 'none' | 'changesRequested' | 'conflicts' | 'ciFailing' | 'ciRunning'
  merge: 'any' | 'ready' | 'needsReview' | 'blocked'
}

export type ClosedFilters = {
  query: string
  author: string
  outcome: 'all' | 'merged' | 'closed'
}

export type Filters = { mine: MineFilters, others: OthersFilters, closed: ClosedFilters }

// a column's sort, or null for attention order
export type Sort = { key: string, dir: 'asc' | 'desc' } | null

export type TileKey = 'yourMove' | 'mineChangesRequested' | 'mineReadyToMerge' | 'waitingOnAuthor' | 'closedToday'

export type ClosedRangeKey = 'today' | 'yesterday'

// the controls the tiles, filter bars and headers change; all in memory, so a reload starts clean
export type Controls = {
  expanded: Record<TableKey, boolean>
  closedRange: ClosedRangeKey
  filters: Filters
  sort: Record<TableKey, Sort>
  grouped: { mine: boolean, others: boolean }
  // the tile whose preset is applied, until a filter is changed by hand
  tile: TileKey | null
  // the header search's text, applied on top of each table's own search and filters
  pageSearch: string
  // sections the page search opened, so it can close them again (setPageSearch)
  searchOpened: TableKey[]
}

export const noFilters = (): Filters => ({
  mine: { query: '', status: 'any', issues: 'any', selfReview: 'any', merge: 'any' },
  others: { query: '', status: 'any', author: '', issues: 'any', merge: 'any' },
  closed: { query: '', author: '', outcome: 'all' },
})

export const initialControls = (): Controls => ({
  expanded: { mine: true, others: true, closed: true },
  closedRange: 'today',
  filters: noFilters(),
  sort: { mine: null, others: null, closed: null },
  grouped: { mine: true, others: true },
  tile: null,
  pageSearch: '',
  searchOpened: [],
})

export const isFiltered = (table: TableKey, filters: Filters): boolean =>
  JSON.stringify(filters[table]) !== JSON.stringify(noFilters()[table])

// the options each filter select offers, first option the default
export type Option = { value: string, label: string }

export const mineIssueOptions: Option[] = [
  { value: 'any', label: 'Issues: any' },
  { value: 'none', label: 'No issues' },
  { value: 'changesRequested', label: 'Changes requested' },
  { value: 'conflicts', label: 'Conflicts' },
  { value: 'ciFailing', label: 'CI failing' },
]

export const othersIssueOptions: Option[] = [...mineIssueOptions, { value: 'ciRunning', label: 'CI running' }]

export const selfReviewOptions: Option[] = [
  { value: 'any', label: 'Self-review: any' },
  { value: 'current', label: 'Current' },
  { value: 'stale', label: 'Stale' },
  { value: 'none', label: 'None' },
]

export const mineMergeOptions: Option[] = [
  { value: 'any', label: 'Merge: any' },
  { value: 'ready', label: 'Ready' },
  { value: 'notReady', label: 'Not ready' },
]

export const othersMergeOptions: Option[] = [
  { value: 'any', label: 'Merge: any' },
  { value: 'ready', label: 'Ready' },
  { value: 'needsReview', label: 'Needs review' },
  { value: 'blocked', label: 'Blocked' },
]

export const outcomeOptions: Option[] = [
  { value: 'all', label: 'Outcome: all' },
  { value: 'merged', label: 'Merged' },
  { value: 'closed', label: 'Closed unmerged' },
]

// the status groups by their current labels, so the bots option reads as the bots group does
export const statusOptions = (groups: readonly { key: string, label: string }[]): Option[] => [
  { value: 'any', label: 'Status: any' },
  ...groups.map((group) => ({ value: group.key, label: group.label })),
]

// every alias seen, sorted; a selected author no longer present stays listed, so the select
// never silently shows a different choice than the one filtering
export const authorOptions = (rows: readonly { author: { alias: string } }[], selected: string): Option[] => {
  const aliases = new Set(rows.map((row) => row.author.alias))
  if (selected !== '') aliases.add(selected)
  return [
    { value: '', label: 'Author: all' },
    ...[...aliases].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })).map((alias) => ({ value: alias, label: alias })),
  ]
}

// predicates

// title or number, a leading # ignored
export const matchesQuery = (query: string, row: { number: number, title: string }): boolean => {
  const wanted = query.trim().toLowerCase().replace(/^#/, '')
  return wanted === '' || row.title.toLowerCase().includes(wanted) || String(row.number).includes(wanted)
}

const matchesIssues = (issues: string, row: OpenRow): boolean => {
  if (issues === 'any') return true
  if (issues === 'none') return row.issues.length === 0
  return row.issues.some((issue) => issue.kind === issues)
}

export const matchesMine = (filters: MineFilters) => (row: MineRow): boolean =>
  (filters.status === 'any' || row.group === filters.status)
  && matchesQuery(filters.query, row)
  && matchesIssues(filters.issues, row)
  && (filters.selfReview === 'any' || row.selfReview.state === filters.selfReview)
  && (filters.merge === 'any' || (filters.merge === 'ready') === (row.merge.state === 'ready'))

const othersMerge: Record<Exclude<OthersFilters['merge'], 'any'>, readonly string[]> = {
  ready: ['ready'],
  needsReview: ['needsReview', 'needsApproval'],
  blocked: ['blocked'],
}

export const matchesOthers = (filters: OthersFilters) => (row: OtherRow): boolean =>
  (filters.status === 'any' || row.group === filters.status)
  && matchesQuery(filters.query, row)
  && (filters.author === '' || row.author.alias === filters.author)
  && matchesIssues(filters.issues, row)
  && (filters.merge === 'any' || othersMerge[filters.merge].includes(row.merge.state))

export const matchesClosed = (filters: ClosedFilters) => (row: ClosedRow): boolean =>
  matchesQuery(filters.query, row)
  && (filters.author === '' || row.author.alias === filters.author)
  && (filters.outcome === 'all' || row.outcome === filters.outcome)

// sorting: each sortable column maps a row to a value; ascending puts the smallest first

export type SortValue<R> = (row: R) => number | string

const compareValues = (a: number | string, b: number | string): number =>
  typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' })

// a comparator for a column's values; ties keep the order the rows came in (attention order)
export const comparator = <R>(value: SortValue<R>, dir: 'asc' | 'desc') => (a: R, b: R): number =>
  (dir === 'asc' ? 1 : -1) * compareValues(value(a), value(b))

// first click ascending, second descending, third back to attention order
export const nextSort = (current: Sort, key: string): Sort => {
  if (current === null || current.key !== key) return { key, dir: 'asc' }
  return current.dir === 'asc' ? { key, dir: 'desc' } : null
}

const mergeRank: Record<OpenRow['merge']['state'], number> = { ready: 0, needsReview: 1, needsApproval: 1, checking: 2, blocked: 3, draft: 4 }
const stageRank: Record<MineRow['stage'], number> = { changesRequested: 0, reReviewRequested: 1, updatedNotRequested: 1, awaitingReview: 1, approved: 2, draft: 3 }
const selfReviewRank: Record<MineRow['selfReview']['state'], number> = { stale: 0, none: 1, current: 2 }

const openValues = {
  pr: (row: OpenRow) => row.number,
  title: (row: OpenRow) => row.title,
  // more issues first
  issues: (row: OpenRow) => -row.issues.length,
  // most recent first when ascending
  activity: (row: OpenRow) => -Date.parse(row.lastActivity.at),
  merge: (row: OpenRow) => mergeRank[row.merge.state],
}

export const mineSortValues = {
  ...openValues,
  review: (row: MineRow) => stageRank[row.stage],
  selfReview: (row: MineRow) => selfReviewRank[row.selfReview.state],
} satisfies Record<string, SortValue<MineRow>>

export const othersSortValues = {
  ...openValues,
  author: (row: OtherRow) => row.author.alias,
  // flags first, then reviewed by anyone, then unreviewed (requested reviewers only, or nobody)
  review: (row: OtherRow) => row.flags.length > 0 ? 0 : row.reviewers.some((reviewer) => reviewer.state !== 'requested') ? 1 : 2,
} satisfies Record<string, SortValue<OtherRow>>

export const closedSortValues = {
  outcome: (row: ClosedRow) => row.outcome === 'merged' ? 0 : 1,
  pr: (row: ClosedRow) => row.number,
  // the first ticket's label; a row without one sorts after every label
  ticket: (row: ClosedRow) => row.tickets[0]?.label ?? '\uFFFF',
  title: (row: ClosedRow) => row.title,
  author: (row: ClosedRow) => row.author.alias,
  closedBy: (row: ClosedRow) => row.closedBy.text,
  when: (row: ClosedRow) => Date.parse(row.closedAt),
} satisfies Record<string, SortValue<ClosedRow>>

// arranging a table: filter, then group or flatten, then sort within each group

export type SourceGroup<R> = { key: string, label: string, sub: string, collapsible: boolean, rows: R[] }

export type Arrangement<R> = {
  groups: ShownGroup<R>[]
  // rows in the table, and rows that pass the filters
  total: number
  matched: number
}

export type ArrangeInput<R> = {
  table: TableKey
  groups: readonly SourceGroup<R>[]
  match: (row: R) => boolean
  // the sorted column's values, or null for attention order
  sortValue: SortValue<R> | null
  dir: 'asc' | 'desc'
  // false: one flat list with no group headers
  grouped: boolean
  filtered: boolean
  // collapsible groups the viewer opened, as 'mine:drafts'
  openGroups: ReadonlySet<string>
  // attention order across groups, for the flat list; absent keeps the groups' own order
  attention?: (a: R, b: R) => number
}

// collapsible groups open, without a toggle, while any filter is set
export const arrange = <R>(input: ArrangeInput<R>): Arrangement<R> => {
  const all = input.groups.flatMap((group) => group.rows)
  const order = (rows: R[]): R[] => input.sortValue === null ? rows : [...rows].sort(comparator(input.sortValue, input.dir))
  const source: readonly SourceGroup<R>[] = input.grouped
    ? input.groups
    : [{ key: 'all', label: 'All', sub: '', collapsible: false, rows: input.attention === undefined ? all : [...all].sort(input.attention) }]
  const groups = source.map((group): ShownGroup<R> => ({
    key: group.key,
    label: group.label,
    sub: group.sub,
    collapsible: group.collapsible && !input.filtered,
    open: !group.collapsible || input.filtered || input.openGroups.has(`${input.table}:${group.key}`),
    rows: order(group.rows.filter(input.match)),
    ...(input.grouped ? {} : { plain: true }),
  }))
  return { groups, total: all.length, matched: all.filter(input.match).length }
}

// attention order for the flat open lists, as the server sorts within a group
export const openAttention: (a: OpenRow, b: OpenRow) => number = attentionOrder

// the filter bar's count
export const shownText = ({ total, matched }: { total: number, matched: number }): string =>
  matched === total ? plural(total, 'PR', 'PRs') : `${matched} of ${total} shown`

// reducers: each returns the next controls

const allOpen = (): Record<TableKey, boolean> => ({ mine: true, others: true, closed: true })

const only = (table: TableKey): Record<TableKey, boolean> => ({ mine: table === 'mine', others: table === 'others', closed: table === 'closed' })

type Preset = { target: TableKey, apply: (filters: Filters) => Filters, range?: ClosedRangeKey }

export const tilePresets: Record<TileKey, Preset> = {
  yourMove: { target: 'others', apply: (f) => ({ ...f, others: { ...f.others, status: 'yourMove' } }) },
  mineChangesRequested: { target: 'mine', apply: (f) => ({ ...f, mine: { ...f.mine, status: 'changesRequested' } }) },
  // the group, not Merge = Ready, since an approved PR GitHub is still checking counts too
  mineReadyToMerge: { target: 'mine', apply: (f) => ({ ...f, mine: { ...f.mine, status: 'readyToMerge' } }) },
  waitingOnAuthor: { target: 'others', apply: (f) => ({ ...f, others: { ...f.others, status: 'waitingOnAuthor' } }) },
  closedToday: { target: 'closed', apply: (f) => f, range: 'today' },
}

// a tile clears every filter, the page search included, opens its section alone and applies its
// preset; pressing the active tile again clears every filter and reopens all three sections
export const pressTile = (controls: Controls, tile: TileKey): Controls => {
  if (controls.tile === tile) return { ...controls, tile: null, filters: noFilters(), pageSearch: '', searchOpened: [], expanded: allOpen() }
  const preset = tilePresets[tile]
  return { ...controls, tile, filters: preset.apply(noFilters()), pageSearch: '', searchOpened: [], expanded: only(preset.target), closedRange: preset.range ?? controls.closedRange }
}

// the page search changed: it releases a tile, as any filter does, and the sections follow it.
// matches counts the rows each section would show for the new text. A collapsed section with a
// match opens and is remembered; a section the search opened closes again when nothing in it
// matches any more, or the search is emptied
export const setPageSearch = (controls: Controls, pageSearch: string, matches: Record<TableKey, number>): Controls => {
  const expanded = { ...controls.expanded }
  const opened = new Set(controls.searchOpened)
  const searching = pageSearch.trim() !== ''
  for (const table of ['mine', 'others', 'closed'] as const) {
    if (searching && matches[table] > 0) {
      if (!expanded[table]) opened.add(table)
      expanded[table] = true
    } else if (opened.has(table)) {
      opened.delete(table)
      expanded[table] = false
    }
  }
  return { ...controls, tile: null, pageSearch, expanded, searchOpened: [...opened] }
}

// opening or closing a section by hand is the viewer's choice; the page search no longer owns it
export const toggleSection = (controls: Controls, table: TableKey): Controls => ({
  ...controls,
  expanded: { ...controls.expanded, [table]: !controls.expanded[table] },
  searchOpened: controls.searchOpened.filter((key) => key !== table),
})

// a filter changed by hand releases the tile; the filters stay as they are
export const setFilter = <T extends TableKey>(controls: Controls, table: T, change: Partial<Filters[T]>): Controls => ({
  ...controls,
  tile: null,
  filters: { ...controls.filters, [table]: { ...controls.filters[table], ...change } },
})

export const clearFilters = (controls: Controls, table: TableKey): Controls => ({
  ...controls,
  tile: null,
  filters: { ...controls.filters, [table]: noFilters()[table] },
})

// the Closed range is the Closed tile's filter, so changing it by hand releases a tile too
export const setClosedRange = (controls: Controls, range: ClosedRangeKey): Controls =>
  range === controls.closedRange ? controls : { ...controls, closedRange: range, tile: null }

// sorting, grouping and collapsing are not filters: the tile stays
export const cycleSort = (controls: Controls, table: TableKey, key: string): Controls => ({
  ...controls,
  sort: { ...controls.sort, [table]: nextSort(controls.sort[table], key) },
})

export const setGrouped = (controls: Controls, table: 'mine' | 'others', grouped: boolean): Controls => ({
  ...controls,
  grouped: { ...controls.grouped, [table]: grouped },
})
