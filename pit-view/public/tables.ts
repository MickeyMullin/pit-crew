// public/tables.ts
// the three tables: column definitions, the arrangement of rows into groups, and keyed rendering
import type { ClosedRange, ClosedRow, MineRow, OpenRow, OtherRow } from '../src/derive.ts'
import type { View } from '../src/poller.ts'
import { avatar, chip, issueChip, mergeChip, pip, ticketChip } from './cells.ts'
import { closedTally, hasTickets } from './closed.ts'
import { h, sync } from './dom.ts'
import type { Keyed, Part } from './dom.ts'
import { closedSortValues, mineSortValues, othersSortValues } from './filters.ts'
import type { Sort, SortValue } from './filters.ts'
import { formatAge, formatClock, plural, shortSha } from './format.ts'
import { rowFreshness } from './state.ts'
import { rowMarker } from './status.ts'
import type { Marker, TableState } from './status.ts'

export type TableKey = 'mine' | 'others' | 'closed'

// what every cell builder can read besides its row; paused is this page's own
export type CellContext = { view: View, nowMs: number, paused: boolean }

// one column: its header, its width in the colgroup, how a row fills it, and the value it
// sorts by; a column without one has a plain header
export type Column<R> = {
  key: string
  label: string
  width: string
  cell: (row: R, ctx: CellContext) => { sig: unknown, build: () => Node[] }
  sort?: SortValue<R>
}

// the agent column exists from phase 2; config.showAgentColumn turns it on
const agentColumn = <R>(): Column<R> => ({
  key: 'agent',
  label: 'Agent',
  width: '168px',
  cell: () => ({ sig: null, build: () => [h('span', { class: 'muted' }, '—')] }),
})

const prCell = <R extends { number: number, url: string }>(hover: boolean): Column<R>['cell'] => (row) => ({
  sig: [row.number, row.url, hover],
  build: () => [h('a', { class: 'pr-link mono', href: row.url, 'data-focus': 'pr', 'data-hover': hover ? 'pr' : null }, `#${row.number}`)],
})

const titleCell = (row: OpenRow): { sig: unknown, build: () => Node[] } => ({
  sig: [row.title, row.stack],
  build: () => [h('span', { class: 'title-cell' },
    h('span', { class: 'title-text', 'data-hover': 'title' }, row.title),
    row.stack === null ? null : chip(`stack ${row.stack.position}/${row.stack.size}`, 'gray', { class: 'chip chip-small tone-gray', title: 'Stacked PR: its position in the stack' }))],
})

const issuesCell = (row: OpenRow): { sig: unknown, build: () => Node[] } => ({
  sig: row.issues,
  build: () => [h('span', { class: 'chips' }, row.issues.map(issueChip))],
})

// the stale dot sits before the age, and a muted age carries its reason; color is never the only sign
const ageLine = (age: string, marker: Marker): HTMLElement => {
  if (marker === null) return h('span', { class: 'age mono' }, age)
  if (marker.kind === 'muted') return h('span', { class: 'age age-muted mono', title: marker.tip }, age, h('span', { class: 'sr-only' }, ` (${marker.tip})`))
  return h('span', { class: 'age age-stale mono' }, h('span', { class: 'fresh-dot', role: 'img', 'aria-label': marker.tip, title: marker.tip }), age)
}

// the marker is in the sig, so a cell rebuilds when its row turns stale, pending or current
const activityCell = (row: OpenRow, { view, nowMs, paused }: CellContext): { sig: unknown, build: () => Node[] } => {
  const age = formatAge(row.lastActivity.at, nowMs)
  const marker = rowMarker(row, view.sync, { paused, nowMs })
  return {
    sig: [age, row.lastActivity.text, marker],
    build: () => [h('span', { class: 'activity' },
      ageLine(age, marker),
      h('span', { class: 'activity-text', title: row.lastActivity.text }, row.lastActivity.text))],
  }
}

const mergeCell = (row: OpenRow): { sig: unknown, build: () => Node[] } => ({
  sig: row.merge,
  build: () => [mergeChip(row.merge.state, row.merge.label)],
})

const stageLabels: Record<MineRow['stage'], string> = {
  changesRequested: 'Changes requested',
  reReviewRequested: 'Re-review requested',
  updatedNotRequested: 'Updated · re-review not requested',
  awaitingReview: 'Awaiting review',
  approved: 'Approved',
  draft: 'Draft',
}

const selfReviewParts = (row: MineRow): { label: string, detail: string } => {
  const self = row.selfReview
  const tandem = self.tandem ? ' · tandem' : ''
  if (self.state === 'current') return { label: `✓ Current${tandem}`, detail: `at ${shortSha(self.reviewedOid ?? self.headOid)}` }
  if (self.state === 'stale') return { label: `Stale${tandem}`, detail: `${shortSha(self.reviewedOid ?? '')} → ${shortSha(self.headOid)}` }
  return { label: 'None', detail: 'no report found' }
}

export const mineColumns = (agent: boolean): Column<MineRow>[] => [
  { key: 'pr', label: 'PR', width: '72px', cell: prCell(true), sort: mineSortValues.pr },
  { key: 'title', label: 'Title', width: 'auto', cell: titleCell, sort: mineSortValues.title },
  {
    key: 'review',
    label: 'Review',
    width: '180px',
    sort: mineSortValues.review,
    cell: (row) => ({
      sig: [row.stage, row.reviewers],
      build: () => [h('span', { class: 'review' },
        h('span', { class: `stage stage-${row.stage}` }, stageLabels[row.stage]),
        row.reviewers.map(pip))],
    }),
  },
  {
    key: 'selfReview',
    label: 'Self-review',
    width: '162px',
    sort: mineSortValues.selfReview,
    cell: (row) => {
      const { label, detail } = selfReviewParts(row)
      return {
        sig: [row.selfReview.state, label, detail],
        build: () => [h('span', { class: 'stacked' },
          h('span', { class: `self self-${row.selfReview.state}` }, label),
          h('span', { class: 'detail mono' }, detail))],
      }
    },
  },
  { key: 'issues', label: 'Issues', width: '180px', cell: issuesCell, sort: mineSortValues.issues },
  { key: 'activity', label: 'Last activity', width: '176px', cell: activityCell, sort: mineSortValues.activity },
  { key: 'merge', label: 'Merge', width: '120px', cell: mergeCell, sort: mineSortValues.merge },
  ...(agent ? [agentColumn<MineRow>()] : []),
]

export const othersColumns = (agent: boolean): Column<OtherRow>[] => [
  {
    key: 'author',
    label: 'Author',
    width: '128px',
    sort: othersSortValues.author,
    cell: (row) => ({
      sig: row.author,
      build: () => [h('span', { class: 'person' }, avatar(row.author, 'row'), h('span', { class: 'person-name' }, row.author.alias))],
    }),
  },
  { key: 'pr', label: 'PR', width: '72px', cell: prCell(true), sort: othersSortValues.pr },
  { key: 'title', label: 'Title', width: 'auto', cell: titleCell, sort: othersSortValues.title },
  {
    key: 'review',
    label: 'Review',
    width: '200px',
    sort: othersSortValues.review,
    cell: (row) => ({
      sig: [row.flags, row.reviewers],
      build: () => [h('span', { class: 'review' },
        row.flags.map((flag) => chip(flag.label, 'blue')),
        row.reviewers.map(pip),
        row.flags.length === 0 && row.reviewers.length === 0 ? h('span', { class: 'muted small' }, 'no reviews yet') : null)],
    }),
  },
  { key: 'issues', label: 'Issues', width: '180px', cell: issuesCell, sort: othersSortValues.issues },
  { key: 'activity', label: 'Last activity', width: '176px', cell: activityCell, sort: othersSortValues.activity },
  { key: 'merge', label: 'Merge', width: '120px', cell: mergeCell, sort: othersSortValues.merge },
  ...(agent ? [agentColumn<OtherRow>()] : []),
]

// the Ticket column, between PR and Title, only when a row in the range has a ticket
const ticketColumn = (): Column<ClosedRow> => ({
  key: 'ticket',
  label: 'Ticket',
  width: '112px',
  sort: closedSortValues.ticket,
  cell: (row) => ({ sig: row.tickets, build: () => [h('span', { class: 'tickets' }, row.tickets.map(ticketChip))] }),
})

export const closedColumns = (range: ClosedRange): Column<ClosedRow>[] => [
  {
    key: 'outcome',
    label: 'Outcome',
    width: '88px',
    sort: closedSortValues.outcome,
    cell: (row) => ({
      sig: row.outcome,
      build: () => [row.outcome === 'merged' ? chip('Merged', 'purple') : chip('Closed', 'red')],
    }),
  },
  { key: 'pr', label: 'PR', width: '72px', cell: prCell(false), sort: closedSortValues.pr },
  ...(hasTickets(range) ? [ticketColumn()] : []),
  {
    key: 'title',
    label: 'Title',
    width: 'auto',
    sort: closedSortValues.title,
    cell: (row) => ({
      sig: row.title,
      build: () => [h('span', { class: 'title-cell' }, h('span', { class: 'title-text', title: row.title }, row.title))],
    }),
  },
  {
    key: 'author',
    label: 'Author',
    width: '144px',
    sort: closedSortValues.author,
    cell: (row) => ({
      sig: row.author,
      build: () => [h('span', { class: 'person' }, avatar(row.author, 'closed'), h('span', { class: 'person-name' }, row.author.alias))],
    }),
  },
  {
    key: 'closedBy',
    label: 'Closed by',
    width: '162px',
    sort: closedSortValues.closedBy,
    cell: (row) => ({ sig: row.closedBy.text, build: () => [h('span', { class: 'muted small' }, row.closedBy.text)] }),
  },
  {
    key: 'when',
    label: 'When',
    width: '112px',
    sort: closedSortValues.when,
    cell: (row) => {
      const when = formatClock(row.closedAt, range.isMondayRule)
      return { sig: when, build: () => [h('time', { class: 'mono small', datetime: row.closedAt }, when)] }
    },
  },
]

// a group as the table shows it, its rows already filtered and sorted (filters.ts, arrange);
// plain groups (the Closed range, or an open table not grouped by status) have no header row
export type ShownGroup<R> = { key: string, label: string, sub: string, collapsible: boolean, open: boolean, rows: R[], plain?: boolean }

const groupTone: Record<string, string> = {
  'others:yourMove': 'blue',
  'others:readyToMerge': 'green',
  'others:waitingOnAuthor': 'gray',
  'others:bots': 'gray',
}

const cellParts = <R>(columns: readonly Column<R>[], row: R, ctx: CellContext): Part[] =>
  columns.map((column) => {
    const { sig, build } = column.cell(row, ctx)
    return {
      key: column.key,
      sig: JSON.stringify(sig),
      build: () => h('td', { class: `col-${column.key}` }, build()),
    }
  })

// placeholder rows while nothing has ever been fetched, or the note once the first cycle failed
const emptyBody = (key: string, columns: number, text: string, loading: boolean): Keyed => ({
  key,
  create: () => h('tbody', { class: loading ? 'loading' : 'empty' }),
  update: (element) => {
    const parts: Part[] = loading
      ? [0, 1, 2].map((index) => ({
          key: `placeholder-${index}`,
          sig: String(columns),
          build: () => h('tr', { class: 'placeholder', 'aria-hidden': 'true' },
            Array.from({ length: columns }, () => h('td', {}, h('span', { class: 'bar' })))),
        }))
      : []
    parts.push({
      key: 'note',
      sig: `${columns}:${text}`,
      build: () => h('tr', { class: 'note' }, h('td', { colspan: columns, role: 'status' }, text)),
    })
    sync(element, parts)
  },
})

export type TableModel<R> = {
  table: TableKey
  columns: Column<R>[]
  groups: ShownGroup<R>[]
  ctx: CellContext
  // loading: nothing fetched yet; missing: nothing cached, and no fetch on its way
  state: TableState
  emptyText: string
  numberOf: (row: R) => number
  rowClass: (row: R) => string
  freshnessOf: (row: R) => string | null
  onToggleGroup: (key: string) => void
  sort: Sort
  onSort: (key: string) => void
}

const groupHead = <R>(model: TableModel<R>, group: ShownGroup<R>, bodyId: string): Part => {
  const tone = groupTone[`${model.table}:${group.key}`] ?? 'ink'
  return {
    key: 'head',
    sig: JSON.stringify([group.label, group.sub, group.rows.length, group.collapsible, group.open, model.columns.length, tone]),
    build: () => {
      const toggle = group.collapsible
        ? h('button', { type: 'button', class: 'button button-small', 'aria-expanded': String(group.open), 'aria-controls': bodyId, 'data-focus-key': `group:${model.table}:${group.key}` },
            group.open ? 'Hide' : `Show ${group.rows.length}`)
        : null
      toggle?.addEventListener('click', () => model.onToggleGroup(group.key))
      return h('tr', { class: 'group-head' },
        h('th', { colspan: model.columns.length, scope: 'rowgroup' },
          h('span', { class: 'group-bar' },
            h('span', { class: `group-label tone-text-${tone}` }, group.label),
            h('span', { class: 'group-count mono' }, String(group.rows.length)),
            h('span', { class: 'group-sub' }, group.sub),
            h('span', { class: 'spacer' }),
            toggle)))
    },
  }
}

const rowItem = <R>(model: TableModel<R>, row: R): Keyed => {
  const number = model.numberOf(row)
  return {
    key: `pr-${number}`,
    create: () => h('tr', { 'data-pr': number, 'data-table': model.table }),
    update: (element) => {
      element.className = model.rowClass(row)
      const freshness = model.freshnessOf(row)
      if (freshness === null) {
        element.removeAttribute('data-freshness')
      } else if (element.getAttribute('data-freshness') !== freshness) {
        element.setAttribute('data-freshness', freshness)
      }
      sync(element, cellParts(model.columns, row, model.ctx))
    },
  }
}

const ariaSort = { asc: 'ascending', desc: 'descending' } as const
const arrows = { asc: '↑', desc: '↓' } as const

// every sortable header is a button; the th carries the sort state as aria-sort
const headerCell = <R>(model: TableModel<R>, column: Column<R>): HTMLTableCellElement => {
  const dir = model.sort !== null && model.sort.key === column.key ? model.sort.dir : null
  const attrs = { scope: 'col', class: `col-${column.key}`, 'aria-sort': dir === null ? null : ariaSort[dir] }
  if (column.sort === undefined) return h('th', attrs, column.label)
  const button = h('button', { type: 'button', class: dir === null ? 'sort' : 'sort sort-active', title: `Sort by ${column.label}`, 'data-focus-key': `sort:${model.table}:${column.key}` },
    column.label,
    h('span', { class: 'sort-arrow', 'aria-hidden': 'true' }, dir === null ? '' : arrows[dir]))
  button.addEventListener('click', () => model.onSort(column.key))
  return h('th', attrs, button)
}

// thead and one tbody per group, keyed so a patch moves or rebuilds only the rows it touched
export const renderTable = <R>(table: HTMLTableElement, model: TableModel<R>): void => {
  const columnsSig = JSON.stringify([model.columns.map((column) => [column.key, column.label, column.width, column.sort !== undefined]), model.sort])
  const items: Keyed[] = [
    {
      key: 'colgroup',
      create: () => h('colgroup'),
      update: (element) => sync(element, model.columns.map((column) => ({
        key: column.key,
        sig: column.width,
        build: () => h('col', { class: `col-${column.key}`, style: column.width === 'auto' ? null : `width: ${column.width}` }),
      }))),
    },
    {
      key: 'thead',
      create: () => h('thead'),
      update: (element) => sync(element, [{
        key: 'row',
        sig: columnsSig,
        build: () => h('tr', {}, model.columns.map((column) => headerCell(model, column))),
      }]),
    },
  ]
  const shown = model.groups.filter((group) => group.rows.length > 0)
  if (model.state !== 'ready') {
    items.push(emptyBody(`state-${model.state}`, model.columns.length, model.state === 'loading' ? 'Loading from GitHub…' : 'No cached data yet', model.state === 'loading'))
  } else if (shown.length === 0) {
    items.push(emptyBody('empty', model.columns.length, model.emptyText, false))
  }
  for (const group of model.state === 'ready' ? shown : []) {
    const bodyId = `${model.table}-group-${group.key}`
    items.push({
      key: `group-${group.key}`,
      create: () => h('tbody', { id: bodyId, class: 'group' }),
      update: (element) => {
        const rows = group.open ? group.rows.map((row) => rowItem(model, row)) : []
        sync(element, [...(group.plain === true ? [] : [groupHead(model, group, bodyId)]), ...rows])
      },
    })
  }
  sync(table, items)
}

// the counts beside each section heading
export const countText = (table: TableKey, view: View, range: ClosedRange): string => {
  if (table === 'mine') {
    const { open, drafts } = view.counts.mine
    return drafts > 0 ? `${open} open · ${plural(drafts, 'draft', 'drafts')}` : `${open} open`
  }
  if (table === 'others') {
    const bots = view.others.groups.find((group) => group.key === 'bots')
    const botCount = bots?.rows.length ?? 0
    const open = view.counts.others.open
    if (bots === undefined || botCount === 0) return `${open} open`
    const botLabel = bots.label === 'Bots' ? 'bots' : bots.label
    return `${open} open · ${open - botCount} people's, ${botCount} ${botLabel}`
  }
  return closedTally(range.rows)
}

// freshness for open rows, null for closed ones, whose section carries it
export const openFreshness = (view: View) => (row: OpenRow): string => rowFreshness(row, view.sync)
