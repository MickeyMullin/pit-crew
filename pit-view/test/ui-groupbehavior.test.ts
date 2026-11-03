// test/ui-groupbehavior.test.ts
// the collapsible groups' behavior, which the left-hand disclosure leaves unchanged: which groups collapse, their default state, opening while a filter or the page search is set, and the stylesheet's phone-width wrapping; run under Node against rows derived from the invented fixtures
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { deriveOpenRows, groupRows } from '../src/derive.ts'
import type { MineRow, OtherRow } from '../src/derive.ts'
import { arrange, initialControls, isFiltered, noFilters, openAttention, setFilter } from '../public/filters.ts'
import type { ArrangeInput } from '../public/filters.ts'
import { scenario } from './fixtures/scenario.ts'
import { fakeTime, openPage1, openPage2 } from './helpers.ts'

const config = (): Config => ({ ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer })

const groups = async () => {
  const prs = [...(await openPage1()).data.repository!.pullRequests.nodes, ...(await openPage2()).data.repository!.pullRequests.nodes]
  const rows = deriveOpenRows(prs, scenario.defaultBranch, { config: config(), clock: fakeTime().clock, timeZone: scenario.timeZone })
  return groupRows(rows)
}

const arrangeMine = (source: ArrangeInput<MineRow>['groups'], change: Partial<ArrangeInput<MineRow>> = {}) =>
  arrange<MineRow>({ table: 'mine', groups: source, match: () => true, sortValue: null, dir: 'asc', grouped: true, filtered: false, openGroups: new Set(), attention: openAttention, ...change })
const arrangeOthers = (source: ArrangeInput<OtherRow>['groups'], change: Partial<ArrangeInput<OtherRow>> = {}) =>
  arrange<OtherRow>({ table: 'others', groups: source, match: () => true, sortValue: null, dir: 'asc', grouped: true, filtered: false, openGroups: new Set(), attention: openAttention, ...change })

test('only Mine\'s Drafts and Others\' bots collapse; every other group is always open', async () => {
  const { mine, others } = await groups()
  assert.deepEqual(mine.groups.map((group) => [group.key, group.collapsible]), [['changesRequested', false], ['readyToMerge', false], ['awaitingReview', false], ['drafts', true]])
  assert.deepEqual(others.groups.map((group) => [group.key, group.collapsible]), [['yourMove', false], ['readyToMerge', false], ['waitingOnAuthor', false], ['bots', true]])
  for (const group of [...arrangeMine(mine.groups).groups, ...arrangeOthers(others.groups).groups]) {
    assert.equal(group.open, !group.collapsible)
  }
})

test('Drafts and the bot group start collapsed, and open only when the viewer opens that group', async () => {
  const { mine, others } = await groups()
  const drafts = (input: Partial<ArrangeInput<MineRow>>) => arrangeMine(mine.groups, input).groups.find((group) => group.key === 'drafts')!
  const bots = (input: Partial<ArrangeInput<OtherRow>>) => arrangeOthers(others.groups, input).groups.find((group) => group.key === 'bots')!
  assert.deepEqual([drafts({}).collapsible, drafts({}).open], [true, false])
  assert.deepEqual([bots({}).collapsible, bots({}).open], [true, false])
  assert.equal(drafts({ openGroups: new Set(['mine:drafts']) }).open, true)
  assert.equal(bots({ openGroups: new Set(['others:bots']) }).open, true)
  // opening one does not open the other, and a key for the other table does nothing
  assert.equal(drafts({ openGroups: new Set(['others:bots']) }).open, false)
  assert.equal(bots({ openGroups: new Set(['mine:drafts']) }).open, false)
})

test('Drafts and the bot group open without a toggle while a filter or the page search is set', async () => {
  const { mine, others } = await groups()
  const drafts = arrangeMine(mine.groups, { filtered: true }).groups.find((group) => group.key === 'drafts')!
  const bots = arrangeOthers(others.groups, { filtered: true }).groups.find((group) => group.key === 'bots')!
  assert.deepEqual([drafts.collapsible, drafts.open], [false, true])
  assert.deepEqual([bots.collapsible, bots.open], [false, true])
  // each table's own filter is what sets it
  const controls = setFilter(setFilter(initialControls(), 'mine', { status: 'drafts' }), 'others', { status: 'bots' })
  assert.equal(isFiltered('mine', controls.filters), true)
  assert.equal(isFiltered('others', controls.filters), true)
  assert.equal(isFiltered('mine', noFilters()), false)
  assert.equal(isFiltered('others', noFilters()), false)
})

test('the page renders both tables as filtered while the page search has terms, so the search opens Drafts and the bot group', async () => {
  const source = await readFile(new URL('../public/render.ts', import.meta.url), 'utf8')
  assert.match(source, /const searching = terms\.length > 0/)
  assert.match(source, /filtered: isFiltered\('mine', ui\.filters\) \|\| searching/)
  assert.match(source, /filtered: isFiltered\('others', ui\.filters\) \|\| searching/)
  // the groups follow the page search through the same flag, and the search's ownership of whole sections lives in setPageSearch (tested in ui-pagesearch.test.ts), not in the groups
  const { mine, others } = await groups()
  assert.equal(arrangeMine(mine.groups, { filtered: true }).groups.every((group) => group.open), true)
  assert.equal(arrangeOthers(others.groups, { filtered: true }).groups.every((group) => group.open), true)
})

test('the group header keeps the label, the row count, and the explanation the data gives each collapsible group', async () => {
  const { mine, others } = await groups()
  const drafts = arrangeMine(mine.groups).groups.find((group) => group.key === 'drafts')!
  const bots = arrangeOthers(others.groups).groups.find((group) => group.key === 'bots')!
  assert.deepEqual([drafts.label, drafts.sub], ['Drafts', 'not ready for review'])
  assert.equal(bots.sub, 'dependency updates')
  assert.ok(bots.label.length > 0)
  // the count is the rows shown, so a closed group still counts them
  assert.equal(drafts.rows.length, mine.groups.find((group) => group.key === 'drafts')!.rows.length)
  assert.equal(bots.rows.length, others.groups.find((group) => group.key === 'bots')!.rows.length)
  assert.ok(drafts.rows.length > 0 && bots.rows.length > 0)
})

test('the group bar still wraps, and the disclosure has no fixed width that would overflow at phone width', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8')
  const rule = (selector: string): string => {
    const found = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.[\]]/g, '\\$&')} \\{([^}]*)\\}`))
    assert.ok(found, `${selector} rule`)
    return found[1]!
  }
  assert.match(rule('.group-bar'), /display: flex;/)
  assert.match(rule('.group-bar'), /flex-wrap: wrap;/)
  for (const selector of ['.disclosure', '.group-bar .disclosure', '.group-bar .disclosure .group-label']) {
    assert.doesNotMatch(rule(selector), /(?:^|[\s;])(?:min-|max-)?width:/)
    assert.doesNotMatch(rule(selector), /white-space: nowrap/)
  }
})
