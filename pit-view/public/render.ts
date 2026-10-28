// public/render.ts
// draws a frame: the header, the offline banner, the summary tiles, the changes-requested
// banner and the three sections, each table filtered, grouped and sorted by this page's own controls
import type { ClosedRange, ClosedRow, MineRow, OtherRow } from '../src/derive.ts'
import type { View } from '../src/poller.ts'
import { avatar, icons } from './cells.ts'
import { closedSummary, mondayNote, rangeButtons } from './closed.ts'
import { byId, h, newTab, setText, svg, sync } from './dom.ts'
import type { Part } from './dom.ts'
import { renderFilterBar } from './filterbar.ts'
import type { FilterBarActions, SelectModel } from './filterbar.ts'
import {
  arrange, authorOptions, isFiltered, matchesClosed, matchesMine, matchesOthers, mineIssueOptions, mineMergeOptions, openAttention,
  othersIssueOptions, othersMergeOptions, outcomeOptions, selfReviewOptions, shownText, statusOptions,
} from './filters.ts'
import type { Arrangement, ClosedRangeKey, Controls, TileKey } from './filters.ts'
import { formatAge, shortSha } from './format.ts'
import { offlineBadge, offlineBanner, sectionMarker, syncStatus, tableState } from './status.ts'
import { closedColumns, countText, mineColumns, openFreshness, othersColumns, renderTable } from './tables.ts'
import type { CellContext, Column, TableKey } from './tables.ts'

export type Density = 'comfortable' | 'compact'

// the parts of the config the page reads; everything else arrives in the view
export type Settings = { density: Density, showAgentColumn: boolean, idleMinutes: number }

// this page's own state: none of it is part of the view, and only paused outlives a reload, idle
// never; filters, sort, grouping and the active tile live in memory (Controls in filters.ts)
export type UiState = Controls & {
  // collapsible groups the viewer opened, as 'mine:drafts' and 'others:bots'
  openGroups: Set<string>
  paused: boolean
  // no user activity for idleMinutes; the server counts the page as not active
  idle: boolean
}

export type Actions = FilterBarActions & {
  toggleSection: (table: TableKey) => void
  toggleGroup: (table: TableKey, key: string) => void
  sortBy: (table: TableKey, key: string) => void
  pressTile: (tile: TileKey) => void
  setRange: (range: ClosedRangeKey) => void
}

export type Frame = { view: View, ui: UiState, settings: Settings, nowMs: number }

const header = (frame: Frame): void => {
  const { view, ui, nowMs } = frame
  const repo = byId('repo-name')
  setText(repo, view.repo)
  const viewer = byId('viewer')
  sync(viewer, [
    { key: 'avatar', sig: JSON.stringify(view.viewer), build: () => avatar(view.viewer, 'header') },
    { key: 'login', sig: view.viewer.login, build: () => h('span', { class: 'viewer-login' }, `@${view.viewer.login}`) },
  ])
  const status = syncStatus(view.sync, { paused: ui.paused, idle: ui.idle, nowMs })
  const text = byId('sync-status')
  setText(text, status.text)
  text.dataset.tone = status.tone
  byId('offline-badge').hidden = !offlineBadge(view.sync)
  const running = view.sync.cycle?.state === 'running'
  const refresh = byId('refresh')
  refresh.toggleAttribute('data-running', running)
  const pause = byId('pause')
  const label = ui.paused ? 'Resume updates' : 'Pause updates'
  if (pause.getAttribute('aria-label') !== label) {
    pause.setAttribute('aria-pressed', String(ui.paused))
    pause.setAttribute('aria-label', label)
    pause.title = label
    pause.replaceChildren(svg(ui.paused ? icons.play : icons.pause, { size: 14, fill: true }))
  }
}

// the amber strip while the latest cycle has failed; the sync region announces the change, so
// the strip itself stays quiet and its ticking age is never read out
const renderOffline = (frame: Frame): void => {
  const slot = byId('offline-banner')
  const banner = offlineBanner(frame.view.sync, { paused: frame.ui.paused, nowMs: frame.nowMs })
  slot.hidden = banner === null
  sync(slot, banner === null ? [] : [{
    key: 'banner',
    sig: JSON.stringify(banner),
    build: () => h('div', { class: 'banner-offline', role: 'status', 'aria-live': 'off' },
      svg(icons.offline, { size: 16, stroke: '2.2', className: 'offline-icon' }),
      h('span', { class: 'offline-lead' }, banner.lead),
      h('span', {}, banner.detail)),
  }])
}

type TileTone = 'blue' | 'red' | 'green' | 'gray' | 'purple'
type Tile = { key: TileKey, count: number, label: string, sub: string, tone: TileTone, alarm: boolean, target: TableKey }

// each tile is a filter preset (filters.ts, tilePresets); the section it targets is its id
const tiles = (view: View, nowMs: number): Tile[] => {
  const t = view.tiles
  const detail = t.mineChangesRequestedDetail
  const previous = t.closedPrevious
  return [
    { key: 'yourMove', count: t.yourMove, label: 'Your move', sub: 'others\' PRs waiting on your review', tone: 'blue', alarm: false, target: 'others' },
    {
      key: 'mineChangesRequested',
      count: t.mineChangesRequested,
      label: 'Changes requested on yours',
      sub: detail === null ? 'nothing to address' : `#${detail.number} · ${detail.by}, ${formatAge(detail.at, nowMs)} ago`,
      // red only while there is something to address
      tone: t.mineChangesRequested > 0 ? 'red' : 'gray',
      alarm: t.mineChangesRequested > 0,
      target: 'mine',
    },
    { key: 'mineReadyToMerge', count: t.mineReadyToMerge, label: 'Yours ready to merge', sub: 'approved, green, no conflicts', tone: 'green', alarm: false, target: 'mine' },
    { key: 'waitingOnAuthor', count: t.waitingOnAuthor, label: 'Waiting on author', sub: 'conflicts, red CI, or your changes', tone: 'gray', alarm: false, target: 'others' },
    {
      key: 'closedToday',
      count: t.closedToday,
      label: 'Closed today',
      sub: `${previous.count} ${previous.label} · ${previous.merged} merged, ${previous.closed} closed`,
      tone: 'purple',
      alarm: false,
      target: 'closed',
    },
  ]
}

const renderTiles = (frame: Frame, actions: Actions): void => {
  sync(byId('tiles'), tiles(frame.view, frame.nowMs).map((tile): Part => {
    const pressed = frame.ui.tile === tile.key
    const sub = pressed ? 'showing only these · click to show all' : tile.sub
    return {
      key: tile.key,
      sig: JSON.stringify([tile, pressed]),
      build: () => {
        const button = h('button', {
          type: 'button',
          class: `tile tile-${tile.tone}${tile.alarm ? ' tile-alarm' : ''}`,
          'aria-pressed': String(pressed),
          'aria-controls': tile.target,
          'data-target': tile.target,
          'data-focus-key': `tile:${tile.key}`,
        },
        h('span', { class: 'tile-count' }, String(tile.count)),
        h('span', { class: 'tile-label' }, tile.label),
        h('span', { class: 'tile-sub' }, sub))
        button.addEventListener('click', () => actions.pressTile(tile.key))
        return button
      },
    }
  }))
}

const selfReviewPhrase = (row: MineRow): string => {
  const self = row.selfReview
  if (self.state === 'current') return 'your self-review is current'
  if (self.state === 'stale') return `your self-review is stale (${shortSha(self.reviewedOid ?? '')}, head is ${shortSha(self.headOid)})`
  return 'no self-review yet'
}

// the red call-out above Mine: announced as an alert only when it first appears, never per patch
const renderBanner = (frame: Frame): void => {
  const slot = byId('mine-banner')
  const rows = frame.view.mine.groups.find((group) => group.key === 'changesRequested')?.rows ?? []
  if (rows.length === 0) {
    slot.replaceChildren()
    slot.hidden = true
    return
  }
  const entries = rows.map((row): Part => {
    const who = row.changesRequested?.alias ?? 'A reviewer'
    const age = row.changesRequested === null ? null : formatAge(row.changesRequested.at, frame.nowMs)
    const phrase = selfReviewPhrase(row)
    return {
      key: `pr-${row.number}`,
      sig: JSON.stringify([who, age, row.url, row.title, phrase]),
      build: () => h('li', { class: 'banner-entry' },
        h('span', { class: 'banner-text' },
          h('span', { class: 'banner-lead' }, `${who} requested changes on `, h('a', { ...newTab, href: row.url }, `#${row.number}`), age === null ? '' : ` · ${age} ago`),
          h('span', { class: 'banner-detail' }, `${row.title} · ${phrase}`)),
        h('a', { ...newTab, class: 'button button-danger', href: row.url }, 'Open review')),
    }
  })
  let banner = slot.firstElementChild
  if (banner === null) {
    banner = h('div', { class: 'banner banner-changes', role: 'alert' }, svg(icons.alert, { size: 20, stroke: '2.2', className: 'banner-icon' }), h('ul', { class: 'banner-list' }))
    slot.appendChild(banner)
    slot.hidden = false
  } else {
    banner.removeAttribute('role')
  }
  const list = banner.querySelector('.banner-list')
  if (list !== null) sync(list, entries)
}

// the amber dot beside a stale section's counts, with its reason as tooltip and accessible name
const sectionFresh = (table: TableKey, frame: Frame): void => {
  const sections = frame.view.sync.sections
  const marker = sectionMarker(table === 'closed' ? sections.closed : sections.open, { paused: frame.ui.paused, nowMs: frame.nowMs })
  sync(byId(`${table}-fresh`), marker === null ? [] : [{
    key: 'dot',
    sig: marker.tip,
    build: () => h('span', { class: 'fresh-dot', role: 'img', 'aria-label': `${tableNames[table]}: ${marker.tip}`, title: marker.tip }),
  }])
}

const sectionChrome = (table: TableKey, frame: Frame, count: string, actions: Actions): void => {
  sectionFresh(table, frame)
  const expanded = frame.ui.expanded[table]
  const toggle = byId(`${table}-toggle`)
  toggle.setAttribute('aria-expanded', String(expanded))
  if (toggle.dataset.wired === undefined) {
    toggle.dataset.wired = ''
    toggle.addEventListener('click', () => actions.toggleSection(table))
  }
  byId(`${table}-body`).hidden = !expanded
  setText(byId(`${table}-count`), count)
}

const tableNames: Record<TableKey, string> = { mine: 'Mine', others: 'Others\'', closed: 'Closed' }

// the sorted column's values, if the sort names a sortable column of this table
const sortOf = <R>(table: TableKey, columns: readonly Column<R>[], ui: UiState) => {
  const sort = ui.sort[table]
  const value = sort === null ? undefined : columns.find((column) => column.key === sort.key)?.sort
  return { sortValue: value ?? null, dir: sort?.dir ?? 'asc' }
}

// with rows in the table but none matching, the empty text says the filters hid them
const emptyText = (arranged: Arrangement<unknown>, empty: string): string =>
  arranged.total > 0 && arranged.matched === 0 ? 'No PRs match these filters.' : empty

const filterBar = (table: TableKey, ui: UiState, arranged: Arrangement<unknown>, selects: SelectModel[], actions: Actions): void => {
  renderFilterBar(byId(`${table}-box`), {
    table,
    name: tableNames[table],
    query: ui.filters[table].query,
    selects,
    grouped: table === 'closed' ? null : ui.grouped[table],
    count: shownText(arranged),
    filtered: isFiltered(table, ui.filters),
  }, actions)
}

export const closedRangeOf = (view: View, ui: UiState): ClosedRange => ui.closedRange === 'today' ? view.closed.today : view.closed.yesterday

// Today / Yesterday in the Closed heading: a labeled group of toggle buttons; a rebuilt button
// gets focus back by its data-focus-key
const renderRange = (frame: Frame, actions: Actions): void => {
  sync(byId('closed-range'), rangeButtons(frame.view.closed, frame.ui.closedRange).map((button): Part => ({
    key: button.key,
    sig: JSON.stringify(button),
    build: () => {
      const element = h('button', { type: 'button', class: 'segment', 'aria-pressed': String(button.pressed), title: button.tip, 'data-focus-key': `range:${button.key}` }, button.label)
      element.addEventListener('click', () => actions.setRange(button.key))
      return element
    },
  })))
  const note = mondayNote(frame.view.closed)
  const slot = byId('closed-note')
  setText(slot, note ?? '')
  slot.hidden = note === null
}

export const render = (frame: Frame, actions: Actions): void => {
  const { view, ui, settings, nowMs } = frame
  document.body.dataset.density = settings.density
  header(frame)
  renderOffline(frame)
  renderTiles(frame, actions)
  const ctx: CellContext = { view, nowMs, paused: ui.paused }
  const range = closedRangeOf(view, ui)
  const freshness = openFreshness(view)
  const openTable = tableState(view.sync.sections.open, view.sync, ui.paused)

  const { mine: mineFilters, others: othersFilters, closed: closedFilters } = ui.filters

  sectionChrome('mine', frame, countText('mine', view, range), actions)
  renderBanner(frame)
  const mineCols = mineColumns(settings.showAgentColumn)
  const mine = arrange<MineRow>({
    table: 'mine',
    groups: view.mine.groups,
    match: matchesMine(mineFilters),
    ...sortOf('mine', mineCols, ui),
    grouped: ui.grouped.mine,
    filtered: isFiltered('mine', ui.filters),
    openGroups: ui.openGroups,
    attention: openAttention,
  })
  filterBar('mine', ui, mine, [
    { field: 'status', label: 'Filter Mine by status group', value: mineFilters.status, options: statusOptions(view.mine.groups) },
    { field: 'issues', label: 'Filter Mine by issue', value: mineFilters.issues, options: mineIssueOptions },
    { field: 'selfReview', label: 'Filter Mine by self-review', value: mineFilters.selfReview, options: selfReviewOptions },
    { field: 'merge', label: 'Filter Mine by merge state', value: mineFilters.merge, options: mineMergeOptions },
  ], actions)
  renderTable<MineRow>(byId<HTMLTableElement>('mine-table'), {
    table: 'mine',
    columns: mineCols,
    groups: mine.groups,
    ctx,
    state: openTable,
    emptyText: emptyText(mine, 'You have no open PRs.'),
    numberOf: (row) => row.number,
    rowClass: (row) => row.group === 'changesRequested' ? 'row row-changes' : 'row',
    freshnessOf: freshness,
    onToggleGroup: (key) => actions.toggleGroup('mine', key),
    sort: ui.sort.mine,
    onSort: (key) => actions.sortBy('mine', key),
  })

  sectionChrome('others', frame, countText('others', view, range), actions)
  const othersCols = othersColumns(settings.showAgentColumn)
  const others = arrange<OtherRow>({
    table: 'others',
    groups: view.others.groups,
    match: matchesOthers(othersFilters),
    ...sortOf('others', othersCols, ui),
    grouped: ui.grouped.others,
    filtered: isFiltered('others', ui.filters),
    openGroups: ui.openGroups,
    attention: openAttention,
  })
  filterBar('others', ui, others, [
    { field: 'status', label: 'Filter Others\' by status group', value: othersFilters.status, options: statusOptions(view.others.groups) },
    { field: 'author', label: 'Filter Others\' by author', value: othersFilters.author, options: authorOptions(view.others.groups.flatMap((group) => group.rows), othersFilters.author) },
    { field: 'issues', label: 'Filter Others\' by issue', value: othersFilters.issues, options: othersIssueOptions },
    { field: 'merge', label: 'Filter Others\' by merge state', value: othersFilters.merge, options: othersMergeOptions },
  ], actions)
  renderTable<OtherRow>(byId<HTMLTableElement>('others-table'), {
    table: 'others',
    columns: othersCols,
    groups: others.groups,
    ctx,
    state: openTable,
    emptyText: emptyText(others, 'No open PRs from anyone else.'),
    numberOf: (row) => row.number,
    rowClass: () => 'row',
    freshnessOf: freshness,
    onToggleGroup: (key) => actions.toggleGroup('others', key),
    sort: ui.sort.others,
    onSort: (key) => actions.sortBy('others', key),
  })

  sectionChrome('closed', frame, closedSummary(range), actions)
  renderRange(frame, actions)
  const closedCols = closedColumns(range)
  const closed = arrange<ClosedRow>({
    table: 'closed',
    groups: [{ key: 'all', label: range.label, sub: '', collapsible: false, rows: range.rows }],
    match: matchesClosed(closedFilters),
    ...sortOf('closed', closedCols, ui),
    grouped: false,
    filtered: isFiltered('closed', ui.filters),
    openGroups: ui.openGroups,
  })
  filterBar('closed', ui, closed, [
    { field: 'author', label: 'Filter Closed by author', value: closedFilters.author, options: authorOptions(range.rows, closedFilters.author) },
    { field: 'outcome', label: 'Filter Closed by outcome', value: closedFilters.outcome, options: outcomeOptions },
  ], actions)
  renderTable<ClosedRow>(byId<HTMLTableElement>('closed-table'), {
    table: 'closed',
    columns: closedCols,
    groups: closed.groups,
    ctx,
    state: tableState(view.sync.sections.closed, view.sync, ui.paused),
    emptyText: emptyText(closed, ui.closedRange === 'today' ? 'Nothing merged or closed yet today.' : 'Nothing merged or closed in this range.'),
    numberOf: (row) => row.number,
    rowClass: () => 'row',
    freshnessOf: () => null,
    onToggleGroup: () => {},
    sort: ui.sort.closed,
    onSort: (key) => actions.sortBy('closed', key),
  })
}
