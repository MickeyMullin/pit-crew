// test/ui-filters.test.ts
// the page's filters, sort cycle, grouping and tile presets (public/filters.ts), run under Node
// against rows derived from the invented fixtures
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { deriveClosed, deriveOpenRows, deriveTiles, groupRows } from '../src/derive.ts'
import type { ClosedRow, MineRow, OpenRow, OtherRow } from '../src/derive.ts'
import type { RawClosedPr } from '../src/github.ts'
import {
  arrange, authorOptions, clearFilters, closedSortValues, comparator, cycleSort, initialControls, isFiltered, matchesClosed, matchesMine,
  matchesOthers, matchesQuery, mineSortValues, nextSort, noFilters, openAttention, othersSortValues, pressTile, setClosedRange, setFilter,
  setGrouped, shownText, statusOptions,
} from '../public/filters.ts'
import type { ArrangeInput, Controls, Filters, SortValue } from '../public/filters.ts'
import { regroup } from '../public/state.ts'
import { closedColumns, mineColumns, othersColumns } from '../public/tables.ts'
import { scenario } from './fixtures/scenario.ts'
import { closedSearch, fakeTime, openPage1, openPage2 } from './helpers.ts'

const config = (): Config => ({ ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer })

const fixtureView = async () => {
  const prs = [...(await openPage1()).data.repository!.pullRequests.nodes, ...(await openPage2()).data.repository!.pullRequests.nodes]
  const ctx = { config: config(), clock: fakeTime().clock, timeZone: scenario.timeZone }
  const rows = deriveOpenRows(prs, scenario.defaultBranch, ctx)
  const closedPrs: RawClosedPr[] = (await closedSearch()).data.search.nodes
  const closed = deriveClosed(closedPrs, ctx)
  return { rows, ...groupRows(rows), closed, tiles: deriveTiles(rows, closed) }
}

const numbers = (rows: readonly { number: number }[]): number[] => rows.map((row) => row.number)

const mineRowsOf = (rows: readonly OpenRow[]): MineRow[] => rows.filter((row): row is MineRow => row.section === 'mine')
const otherRowsOf = (rows: readonly OpenRow[]): OtherRow[] => rows.filter((row): row is OtherRow => row.section === 'others')

const mineFilter = (change: Partial<Filters['mine']>) => matchesMine({ ...noFilters().mine, ...change })
const othersFilter = (change: Partial<Filters['others']>) => matchesOthers({ ...noFilters().others, ...change })
const closedFilter = (change: Partial<Filters['closed']>) => matchesClosed({ ...noFilters().closed, ...change })

test('search matches the title case-insensitively or the number, a leading # ignored', () => {
  const row = { number: 118, title: 'Fix the Orbit cache' }
  assert.equal(matchesQuery('', row), true)
  assert.equal(matchesQuery('   ', row), true)
  assert.equal(matchesQuery('orbit', row), true)
  assert.equal(matchesQuery('  ORBIT cache ', row), true)
  assert.equal(matchesQuery('#118', row), true)
  assert.equal(matchesQuery('11', row), true)
  assert.equal(matchesQuery('#119', row), false)
  assert.equal(matchesQuery('rocket', row), false)
  // only a leading # is dropped
  assert.equal(matchesQuery('cache#', row), false)
})

test('Mine filters: status group, issues by kind or none, self-review state, and merge ready or not', async () => {
  const { rows } = await fixtureView()
  const mine = mineRowsOf(rows)
  assert.ok(mine.length >= 4)
  for (const group of ['changesRequested', 'readyToMerge', 'awaitingReview', 'drafts'] as const) {
    const picked = mine.filter(mineFilter({ status: group }))
    assert.ok(picked.length > 0 && picked.every((row) => row.group === group))
  }
  const changes = mine.filter(mineFilter({ issues: 'changesRequested' }))
  assert.deepEqual(numbers(changes), numbers(mine.filter((row) => row.issues.some((issue) => issue.kind === 'changesRequested'))))
  assert.ok(changes.length > 0)
  assert.deepEqual(numbers(mine.filter(mineFilter({ issues: 'none' }))), numbers(mine.filter((row) => row.issues.length === 0)))
  const ready = mine.filter(mineFilter({ merge: 'ready' }))
  const notReady = mine.filter(mineFilter({ merge: 'notReady' }))
  assert.ok(ready.every((row) => row.merge.state === 'ready') && ready.length > 0)
  assert.ok(notReady.every((row) => row.merge.state !== 'ready') && notReady.length > 0)
  assert.equal(ready.length + notReady.length, mine.length)
  // self-review: each state picks only its own rows
  const states = ['current', 'stale', 'none'] as const
  const varied = mine.map((row, index) => ({ ...row, selfReview: { ...row.selfReview, state: states[index % 3]! } }))
  for (const state of states) {
    const picked = varied.filter(mineFilter({ selfReview: state }))
    assert.ok(picked.length > 0 && picked.every((row) => row.selfReview.state === state))
  }
  // filters combine with and
  const both = mine.filter(mineFilter({ merge: 'notReady', query: String(changes[0]!.number), issues: 'changesRequested' }))
  assert.deepEqual(numbers(both), [changes[0]!.number])
})

test('Others\' filters: status group, author alias, issues including CI running, and merge with Needs review covering needs approval', async () => {
  const { rows } = await fixtureView()
  const others = otherRowsOf(rows)
  for (const status of ['yourMove', 'readyToMerge', 'waitingOnAuthor', 'bots'] as const) {
    assert.deepEqual(numbers(others.filter(othersFilter({ status }))), numbers(others.filter((row) => row.group === status)))
  }
  const alias = others[0]!.author.alias
  const byAuthor = others.filter(othersFilter({ author: alias }))
  assert.ok(byAuthor.length > 0 && byAuthor.every((row) => row.author.alias === alias))
  const running = others.filter(othersFilter({ issues: 'ciRunning' }))
  assert.ok(running.length > 0 && running.every((row) => row.issues.some((issue) => issue.kind === 'ciRunning')))
  const failing = others.filter(othersFilter({ issues: 'ciFailing' }))
  assert.ok(failing.length > 0 && failing.every((row) => row.issues.some((issue) => issue.kind === 'ciFailing')))
  const conflicts = others.filter(othersFilter({ issues: 'conflicts' }))
  assert.ok(conflicts.length > 0 && conflicts.every((row) => row.issues.some((issue) => issue.kind === 'conflicts')))

  const approval: OtherRow = { ...others[0]!, merge: { state: 'needsApproval', label: 'Needs approval' } }
  const review: OtherRow = { ...others[0]!, merge: { state: 'needsReview', label: 'Needs review' } }
  const blocked: OtherRow = { ...others[0]!, merge: { state: 'blocked', label: 'Blocked' } }
  const ready: OtherRow = { ...others[0]!, merge: { state: 'ready', label: 'Ready' } }
  const four = [approval, review, blocked, ready]
  assert.deepEqual(four.filter(othersFilter({ merge: 'needsReview' })), [approval, review])
  assert.deepEqual(four.filter(othersFilter({ merge: 'blocked' })), [blocked])
  assert.deepEqual(four.filter(othersFilter({ merge: 'ready' })), [ready])
  assert.deepEqual(four.filter(othersFilter({})), four)
})

test('Closed filters: search, author alias and outcome', async () => {
  const { closed } = await fixtureView()
  const rows: ClosedRow[] = [...closed.today.rows, ...closed.yesterday.rows]
  assert.ok(rows.some((row) => row.outcome === 'merged') && rows.some((row) => row.outcome === 'closed'))
  assert.deepEqual(numbers(rows.filter(closedFilter({ outcome: 'merged' }))), numbers(rows.filter((row) => row.outcome === 'merged')))
  assert.deepEqual(numbers(rows.filter(closedFilter({ outcome: 'closed' }))), numbers(rows.filter((row) => row.outcome === 'closed')))
  const alias = rows[0]!.author.alias
  assert.ok(rows.filter(closedFilter({ author: alias })).every((row) => row.author.alias === alias))
  assert.deepEqual(numbers(rows.filter(closedFilter({ query: `#${rows[1]!.number}` }))), [rows[1]!.number])
})

test('the sort cycle runs ascending, descending, then back to attention order; a new column starts ascending', () => {
  const first = nextSort(null, 'title')
  assert.deepEqual(first, { key: 'title', dir: 'asc' })
  const second = nextSort(first, 'title')
  assert.deepEqual(second, { key: 'title', dir: 'desc' })
  assert.equal(nextSort(second, 'title'), null)
  assert.deepEqual(nextSort(second, 'pr'), { key: 'pr', dir: 'asc' })
  assert.deepEqual(nextSort(first, 'pr'), { key: 'pr', dir: 'asc' })
})

const sortedBy = <R>(rows: readonly R[], value: SortValue<R>, dir: 'asc' | 'desc' = 'asc'): R[] => [...rows].sort(comparator(value, dir))

test('sort keys put rows in the order section 6 gives, and ties keep attention order both ways', async () => {
  const { rows } = await fixtureView()
  const mine = mineRowsOf(rows)
  const others = otherRowsOf(rows)
  const base = mine[0]!

  // review on Mine: changes requested, awaiting, approved, draft
  const stages = (['draft', 'approved', 'awaitingReview', 'changesRequested'] as const).map((stage, index) => ({ ...base, number: index, stage }))
  assert.deepEqual(sortedBy(stages, mineSortValues.review).map((row) => row.stage), ['changesRequested', 'awaitingReview', 'approved', 'draft'])
  // self-review: stale, none, current
  const selves = (['current', 'none', 'stale'] as const).map((state) => ({ ...base, selfReview: { ...base.selfReview, state } }))
  assert.deepEqual(sortedBy(selves, mineSortValues.selfReview).map((row) => row.selfReview.state), ['stale', 'none', 'current'])
  // merge: ready, needs review (and approval), blocked, draft
  const merges = (['draft', 'blocked', 'needsApproval', 'ready', 'needsReview'] as const).map((state) => ({ ...base, merge: { state, label: state } }))
  assert.deepEqual(sortedBy(merges, mineSortValues.merge).map((row) => row.merge.state), ['ready', 'needsApproval', 'needsReview', 'blocked', 'draft'])
  // issues: more first
  const byIssues = sortedBy(rows, mineSortValues.issues)
  for (let index = 1; index < byIssues.length; index += 1) assert.ok(byIssues[index - 1]!.issues.length >= byIssues[index]!.issues.length)
  // last activity: most recent first ascending, oldest first descending
  const recent = sortedBy(rows, mineSortValues.activity)
  for (let index = 1; index < recent.length; index += 1) assert.ok(Date.parse(recent[index - 1]!.lastActivity.at) >= Date.parse(recent[index]!.lastActivity.at))
  const oldest = sortedBy(rows, mineSortValues.activity, 'desc')
  for (let index = 1; index < oldest.length; index += 1) assert.ok(Date.parse(oldest[index - 1]!.lastActivity.at) <= Date.parse(oldest[index]!.lastActivity.at))
  // PR number and title
  assert.deepEqual(numbers(sortedBy(rows, mineSortValues.pr)), [...numbers(rows)].sort((a, b) => a - b))
  assert.deepEqual(numbers(sortedBy(rows, mineSortValues.pr, 'desc')), [...numbers(rows)].sort((a, b) => b - a))
  const titled = ['beta', 'Alpha', 'alpha 10', 'alpha 9'].map((title, index) => ({ ...base, number: index, title }))
  assert.deepEqual(sortedBy(titled, mineSortValues.title).map((row) => row.title), ['Alpha', 'alpha 9', 'alpha 10', 'beta'])

  // review on Others': flags first, then reviewed, then unreviewed (a pending request is not a review)
  const other = others[0]!
  const flagged: OtherRow = { ...other, number: 1, flags: [{ kind: 'requestedOfYou', label: 'Requested of you' }], reviewers: [] }
  const reviewed: OtherRow = { ...other, number: 2, flags: [], reviewers: [{ ...other.author, state: 'approved' }] }
  const requested: OtherRow = { ...other, number: 3, flags: [], reviewers: [{ ...other.author, state: 'requested' }] }
  const nobody: OtherRow = { ...other, number: 4, flags: [], reviewers: [] }
  assert.deepEqual(numbers(sortedBy([nobody, requested, reviewed, flagged], othersSortValues.review)), [1, 2, 4, 3])
  // author alias, case-insensitive
  const authors = ['sam', 'Alex', 'priya'].map((alias, index) => ({ ...other, number: index, author: { ...other.author, alias } }))
  assert.deepEqual(sortedBy(authors, othersSortValues.author).map((row) => row.author.alias), ['Alex', 'priya', 'sam'])

  // ties keep the order they came in, ascending and descending alike
  const tied = [3, 1, 2].map((number) => ({ ...base, number, stage: 'awaitingReview' as const }))
  assert.deepEqual(numbers(sortedBy(tied, mineSortValues.review)), [3, 1, 2])
  assert.deepEqual(numbers(sortedBy(tied, mineSortValues.review, 'desc')), [3, 1, 2])
})

test('Closed sorts by outcome, author, closed by and closedAt', async () => {
  const { closed } = await fixtureView()
  const rows = [...closed.today.rows, ...closed.yesterday.rows]
  const when = numbers(sortedBy(rows, closedSortValues.when))
  assert.deepEqual(when, numbers([...rows].sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt))))
  assert.deepEqual(numbers(sortedBy(rows, closedSortValues.when, 'desc')), [...when].reverse())
  const outcomes = sortedBy(rows, closedSortValues.outcome).map((row) => row.outcome)
  assert.equal(outcomes.lastIndexOf('merged') < outcomes.indexOf('closed'), true)
  const by = sortedBy(rows, closedSortValues.closedBy).map((row) => row.closedBy.text.toLowerCase())
  assert.deepEqual(by, [...by].sort((a, b) => a.localeCompare(b, 'en')))
})

test('every column has a sort key except the phase 2 agent column and the trailing row refresh', () => {
  const unsorted = (columns: readonly { key: string, sort?: unknown }[]): string[] => columns.filter((column) => column.sort === undefined).map((column) => column.key)
  assert.deepEqual(unsorted(mineColumns(true)), ['agent', 'refresh'])
  assert.deepEqual(unsorted(othersColumns(true)), ['agent', 'refresh'])
  assert.deepEqual(unsorted(mineColumns(false)), ['refresh'])
  // the refresh column is last, so revealing its button never moves another column
  assert.equal(mineColumns(true).at(-1)?.key, 'refresh')
  assert.equal(othersColumns(false).at(-1)?.key, 'refresh')
  const range = { label: 'Today', isMondayRule: false, from: scenario.todayFrom, to: scenario.now, rows: [] }
  assert.deepEqual(unsorted(closedColumns(range)), [])
})

const arrangeOthers = (groups: ArrangeInput<OtherRow>['groups'], change: Partial<ArrangeInput<OtherRow>>): ReturnType<typeof arrange<OtherRow>> =>
  arrange<OtherRow>({
    table: 'others', groups, match: () => true, sortValue: null, dir: 'asc', grouped: true, filtered: false, openGroups: new Set(), attention: openAttention, ...change,
  })

test('grouped output keeps every group in order, filtered and sorted within each; the bots group stays shut until opened or filtered', async () => {
  const { others } = await fixtureView()
  const plain = arrangeOthers(others.groups, {})
  assert.deepEqual(plain.groups.map((group) => group.key), ['yourMove', 'readyToMerge', 'waitingOnAuthor', 'bots'])
  assert.deepEqual(plain.groups.map((group) => group.rows), others.groups.map((group) => group.rows))
  assert.equal(plain.total, others.groups.flatMap((group) => group.rows).length)
  assert.equal(plain.matched, plain.total)
  const bots = plain.groups.find((group) => group.key === 'bots')!
  assert.deepEqual([bots.collapsible, bots.open], [true, false])
  assert.ok(plain.groups.every((group) => group.plain === undefined))
  const opened = arrangeOthers(others.groups, { openGroups: new Set(['others:bots']) })
  assert.deepEqual(opened.groups.find((group) => group.key === 'bots')!.open, true)
  // a filter opens it, and hides its toggle while set
  const filtered = arrangeOthers(others.groups, { filtered: true })
  assert.deepEqual([filtered.groups.find((group) => group.key === 'bots')!.collapsible, filtered.groups.find((group) => group.key === 'bots')!.open], [false, true])

  // sorted within each group: every group's rows ascend by number, and groups keep their members
  const sorted = arrangeOthers(others.groups, { sortValue: othersSortValues.pr, dir: 'asc' })
  sorted.groups.forEach((group, index) => {
    assert.deepEqual(numbers(group.rows), [...numbers(others.groups[index]!.rows)].sort((a, b) => a - b))
  })
  // a match narrows each group and the counts
  const yourMove = arrangeOthers(others.groups, { match: othersFilter({ status: 'yourMove' }), filtered: true })
  assert.deepEqual(yourMove.groups.map((group) => group.rows.length > 0), [true, false, false, false])
  assert.equal(yourMove.matched, others.groups[0]!.rows.length)
  assert.equal(yourMove.total, plain.total)
})

test('ungrouped output is one flat list in attention order across all groups, sorted across all rows', async () => {
  const { rows, mine } = await fixtureView()
  const all = mineRowsOf(rows)
  const flat = arrange<MineRow>({ table: 'mine', groups: mine.groups, match: () => true, sortValue: null, dir: 'asc', grouped: false, filtered: false, openGroups: new Set(), attention: openAttention })
  assert.equal(flat.groups.length, 1)
  const only = flat.groups[0]!
  assert.deepEqual([only.key, only.plain, only.open, only.collapsible], ['all', true, true, false])
  // drafts included, nothing collapsed, and attention order across the whole section
  assert.deepEqual(numbers(only.rows), numbers([...all].sort(openAttention)))
  assert.ok(only.rows.some((row) => row.group === 'drafts'))
  const sorted = arrange<MineRow>({ table: 'mine', groups: mine.groups, match: () => true, sortValue: mineSortValues.pr, dir: 'desc', grouped: false, filtered: false, openGroups: new Set() })
  assert.deepEqual(numbers(sorted.groups[0]!.rows), numbers(all).sort((a, b) => b - a))
  // without an attention order (Closed), the rows keep the order they came in
  const kept = arrange<MineRow>({ table: 'mine', groups: mine.groups, match: () => true, sortValue: null, dir: 'asc', grouped: false, filtered: false, openGroups: new Set() })
  assert.deepEqual(numbers(kept.groups[0]!.rows), numbers(mine.groups.flatMap((group) => group.rows)))
})

test('the filter count reads n PRs, or m of n shown', () => {
  assert.equal(shownText({ total: 12, matched: 12 }), '12 PRs')
  assert.equal(shownText({ total: 1, matched: 1 }), '1 PR')
  assert.equal(shownText({ total: 0, matched: 0 }), '0 PRs')
  assert.equal(shownText({ total: 12, matched: 3 }), '3 of 12 shown')
})

test('author options list each alias once, sorted, and keep a selected author that left', () => {
  const rows = ['sam', 'Alex', 'sam', 'priya'].map((alias) => ({ author: { alias } }))
  assert.deepEqual(authorOptions(rows, '').map((option) => option.value), ['', 'Alex', 'priya', 'sam'])
  assert.deepEqual(authorOptions(rows, 'lee').map((option) => option.value), ['', 'Alex', 'lee', 'priya', 'sam'])
  assert.equal(authorOptions([], '')[0]!.label, 'Author: all')
  // the status select names the groups as the table does, bots label included
  assert.deepEqual(statusOptions([{ key: 'yourMove', label: 'Your move' }, { key: 'bots', label: 'Dependabot' }]).map((option) => option.label), ['Status: any', 'Your move', 'Dependabot'])
})

test('a tile clears every filter, opens its section alone and applies its preset; pressed again it clears and reopens all', () => {
  const start: Controls = setFilter(setFilter(initialControls(), 'closed', { query: 'cache' }), 'others', { author: 'Alex' })
  const sorted = cycleSort(setGrouped(start, 'mine', false), 'mine', 'pr')

  const yourMove = pressTile(sorted, 'yourMove')
  assert.equal(yourMove.tile, 'yourMove')
  assert.deepEqual(yourMove.expanded, { mine: false, others: true, closed: false })
  assert.deepEqual(yourMove.filters, { ...noFilters(), others: { ...noFilters().others, status: 'yourMove' } })
  // sort and grouping are not filters: they stay
  assert.deepEqual(yourMove.sort, sorted.sort)
  assert.deepEqual(yourMove.grouped, sorted.grouped)

  assert.deepEqual(pressTile(sorted, 'waitingOnAuthor').filters.others.status, 'waitingOnAuthor')
  const changes = pressTile(yourMove, 'mineChangesRequested')
  assert.equal(changes.tile, 'mineChangesRequested')
  assert.deepEqual(changes.expanded, { mine: true, others: false, closed: false })
  assert.deepEqual(changes.filters, { ...noFilters(), mine: { ...noFilters().mine, status: 'changesRequested' } })
  assert.deepEqual(pressTile(sorted, 'mineReadyToMerge').filters, { ...noFilters(), mine: { ...noFilters().mine, status: 'readyToMerge' } })
  const closed = pressTile(setClosedRange(sorted, 'yesterday'), 'closedToday')
  assert.deepEqual([closed.closedRange, closed.expanded, closed.filters], ['today', { mine: false, others: false, closed: true }, noFilters()])

  const released = pressTile(yourMove, 'yourMove')
  assert.equal(released.tile, null)
  assert.deepEqual(released.filters, noFilters())
  assert.deepEqual(released.expanded, { mine: true, others: true, closed: true })
})

test('changing a filter by hand releases the tile and keeps the filters; sorting, grouping and an unchanged range do not', () => {
  const pressed = pressTile(initialControls(), 'yourMove')
  const typed = setFilter(pressed, 'others', { query: '#11' })
  assert.equal(typed.tile, null)
  assert.deepEqual(typed.filters.others, { ...noFilters().others, status: 'yourMove', query: '#11' })
  assert.deepEqual(typed.expanded, pressed.expanded)
  assert.equal(setFilter(pressed, 'mine', { merge: 'ready' }).tile, null)
  assert.equal(clearFilters(pressed, 'others').tile, null)
  assert.deepEqual(clearFilters(typed, 'others').filters, noFilters())

  assert.equal(cycleSort(pressed, 'others', 'title').tile, 'yourMove')
  assert.equal(setGrouped(pressed, 'others', false).tile, 'yourMove')
  const today = pressTile(initialControls(), 'closedToday')
  assert.equal(setClosedRange(today, 'today'), today)
  const yesterday = setClosedRange(today, 'yesterday')
  assert.deepEqual([yesterday.closedRange, yesterday.tile], ['yesterday', null])

  assert.equal(isFiltered('others', typed.filters), true)
  assert.equal(isFiltered('mine', typed.filters), false)
  assert.equal(isFiltered('closed', noFilters()), false)
})

test('each tile\'s preset shows exactly the rows its count counts, and a patch moving a row in keeps the tile', async () => {
  const { rows, mine, others, closed, tiles } = await fixtureView()
  const matched = (controls: Controls, table: 'mine' | 'others'): number =>
    table === 'mine'
      ? arrange<MineRow>({ table, groups: mine.groups, match: matchesMine(controls.filters.mine), sortValue: null, dir: 'asc', grouped: true, filtered: true, openGroups: new Set() }).matched
      : arrangeOthers(others.groups, { match: matchesOthers(controls.filters.others), filtered: true }).matched
  assert.equal(matched(pressTile(initialControls(), 'yourMove'), 'others'), tiles.yourMove)
  assert.equal(matched(pressTile(initialControls(), 'waitingOnAuthor'), 'others'), tiles.waitingOnAuthor)
  assert.equal(matched(pressTile(initialControls(), 'mineReadyToMerge'), 'mine'), tiles.mineReadyToMerge)
  assert.equal(matched(pressTile(initialControls(), 'mineChangesRequested'), 'mine'), tiles.mineChangesRequested)

  // a changes request the viewer answered (here by re-requesting the reviewer) leaves the tile
  // and its preset, though the PR keeps its Changes requested chip
  const answered = rows.map((row) => row.section === 'mine' && row.group === 'changesRequested'
    ? { ...row, group: 'awaitingReview' as const, stage: 'reReviewRequested' as const }
    : row)
  const moved = regroup({ mine, others }, answered)
  const preset = pressTile(initialControls(), 'mineChangesRequested')
  const shown = arrange<MineRow>({ table: 'mine', groups: moved.mine.groups, match: matchesMine(preset.filters.mine), sortValue: null, dir: 'asc', grouped: true, filtered: true, openGroups: new Set() })
  assert.equal(shown.matched, deriveTiles(answered, closed).mineChangesRequested)
  assert.equal(shown.matched, 0)
  assert.ok(mineRowsOf(answered).some(mineFilter({ issues: 'changesRequested' })))

  // an approved PR GitHub is still checking stays in Ready to merge, so the tile and its preset
  // keep it, though the Merge filter's Ready does not
  const checking = rows.map((row) => row.section === 'mine' && row.group === 'readyToMerge'
    ? { ...row, merge: { state: 'checking' as const, label: 'Checking' } }
    : row)
  const unconfirmed = regroup({ mine, others }, checking)
  const ready = pressTile(initialControls(), 'mineReadyToMerge')
  const kept = arrange<MineRow>({ table: 'mine', groups: unconfirmed.mine.groups, match: matchesMine(ready.filters.mine), sortValue: null, dir: 'asc', grouped: true, filtered: true, openGroups: new Set() })
  assert.equal(kept.matched, deriveTiles(checking, closed).mineReadyToMerge)
  assert.equal(kept.matched, 1)
  assert.equal(mineRowsOf(checking).filter(mineFilter({ merge: 'ready' })).length, 0)

  // the controls are the page's own: regrouping after a patch never touches them
  const controls = pressTile(initialControls(), 'yourMove')
  const moving = otherRowsOf(rows).find((row) => row.group === 'readyToMerge')!
  const patched = regroup({ mine, others }, rows.map((row) => row.number === moving.number ? { ...moving, group: 'yourMove' as const } : row))
  const after = arrangeOthers(patched.others.groups, { match: matchesOthers(controls.filters.others), filtered: true })
  assert.equal(after.matched, tiles.yourMove + 1)
  assert.ok(after.groups[0]!.rows.some((row) => row.number === moving.number))
  assert.equal(controls.tile, 'yourMove')
})
