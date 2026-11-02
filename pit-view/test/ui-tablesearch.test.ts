// test/ui-tablesearch.test.ts
// each table's own text search highlights as it is typed (public/filters.ts, public/tables.ts), run under Node with a minimal stand-in for the document so the cell builders can run
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { deriveClosed, deriveOpenRows } from '../src/derive.ts'
import type { ClosedRow, MineRow, OtherRow } from '../src/derive.ts'
import { matchesClosed, matchesMine, matchesOthers, matchesQuery, noFilters, queryTerms } from '../public/filters.ts'
import { searchTerms, splitMatches } from '../public/pagesearch.ts'
import { closedColumns, mineColumns, othersColumns } from '../public/tables.ts'
import type { CellContext } from '../public/tables.ts'
import { scenario } from './fixtures/scenario.ts'
import { closedSearch, fakeTime, openPage1, openPage2 } from './helpers.ts'

// just enough of an element for the builders: tag, attributes, children, and text
type Fake = { tag: string, attrs: Map<string, string>, children: Fake[], text?: string, setAttribute: (name: string, value: string) => void, addEventListener: () => void, appendChild: (child: Fake) => Fake }
const fakeElement = (tag: string, text?: string): Fake => {
  const element: Fake = {
    tag,
    attrs: new Map(),
    children: [],
    ...(text === undefined ? {} : { text }),
    setAttribute: (name, value) => { element.attrs.set(name, value) },
    addEventListener: () => {},
    appendChild: (child) => { element.children.push(child); return child },
  }
  return element
}
Object.assign(globalThis, { document: { createElement: (tag: string) => fakeElement(tag), createTextNode: (text: string) => fakeElement('#text', text) } })

// the cell's markup as text, with each mark shown as [[...]]
const flat = (node: Fake): string =>
  node.tag === '#text' ? node.text! : node.tag === 'mark' ? `[[${node.children.map(flat).join('')}]]` : node.children.map(flat).join('')
const marked = (nodes: readonly Node[]): string => nodes.map((node) => flat(node as unknown as Fake)).join('')

const config = (): Config => ({ ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer })

const fixtures = async () => {
  const prs = [...(await openPage1()).data.repository!.pullRequests.nodes, ...(await openPage2()).data.repository!.pullRequests.nodes]
  const ctx = { config: config(), clock: fakeTime().clock, timeZone: scenario.timeZone }
  const open = deriveOpenRows(prs, scenario.defaultBranch, ctx)
  const closed = deriveClosed((await closedSearch()).data.search.nodes, ctx).today.rows
  return {
    mine: open.filter((row): row is MineRow => row.section === 'mine'),
    others: open.filter((row): row is OtherRow => row.section === 'others'),
    closed,
  }
}

const context = async (terms: readonly string[], query: readonly string[]): Promise<CellContext> => {
  const { mine } = await fixtures()
  return { view: { mine: { groups: [{ key: 'x', rows: mine }] } } as never, nowMs: 0, paused: false, terms, queryTerms: query }
}

const cellText = async (column: { cell: (row: never, ctx: CellContext) => { build: () => Node[] } }, row: unknown, terms: readonly string[], query: readonly string[]): Promise<string> =>
  marked(column.cell(row as never, await context(terms, query)).build())

const byKey = <R>(columns: readonly { key: string }[], key: string): { cell: (row: R, ctx: CellContext) => { sig: unknown, build: () => Node[] } } =>
  columns.find((column) => column.key === key) as never

test('a table search is one phrase: trimmed, lowercased, a leading # dropped, inner spaces kept', () => {
  assert.deepEqual(queryTerms(''), [])
  assert.deepEqual(queryTerms('   '), [])
  assert.deepEqual(queryTerms('#'), [])
  assert.deepEqual(queryTerms('  #118 '), ['118'])
  assert.deepEqual(queryTerms('  ORBIT cache '), ['orbit cache'])
  assert.deepEqual(queryTerms('cache#'), ['cache#'])
})

// the table search's row selection exactly as it was before highlighting existed: whole-string lowercase, a leading # dropped
const masterMatchesQuery = (query: string, row: { number: number, title: string }): boolean => {
  const wanted = query.trim().toLowerCase().replace(/^#/, '')
  return wanted === '' || row.title.toLowerCase().includes(wanted) || String(row.number).includes(wanted)
}

test('the table search keeps the rows it kept', () => {
  const row = { number: 118, title: 'Fix the Orbit cache' }
  assert.equal(matchesQuery('  ORBIT cache ', row), true)
  assert.equal(matchesQuery('11', row), true)
  assert.equal(matchesQuery('#119', row), false)
  assert.equal(matchesQuery('cache#', row), false)
})

test('a title ending in capital sigma is kept by the final-form query and not by the plain one, as before', () => {
  const title = { number: 2, title: 'ΟΣ cache' }
  const ending = { number: 3, title: 'Fix ΟΣ' }
  // expected values come from the whole-string lowercase: ΟΣ becomes ος, with a final sigma
  assert.equal(matchesQuery('ς', title), true)
  assert.equal(matchesQuery('ς', ending), true)
  assert.equal(matchesQuery('σ', title), false)
  assert.equal(matchesQuery('σ', ending), false)
  assert.equal(matchesQuery('Σ', ending), false)
  assert.equal(matchesQuery('ΟΣ', ending), true)
  assert.equal(matchesQuery('ΟΣ cache', title), true)
  assert.equal(matchesQuery('ος', ending), true)
  assert.equal(matchesQuery('οσ', ending), false)
  assert.equal(matchesQuery('οσ', { number: 4, title: 'οσ' }), true)
  // and for every pairing below, the kept set equals the original logic's
  const titles = ['ΟΣ cache', 'Fix ΟΣ', 'οσ', 'ος', 'ΑΣΑ', 'İstanbul', 'plain']
  const queries = ['ς', 'σ', 'Σ', 'ΟΣ', 'οσ', 'ος', 'ΑΣ', 'ασα', 'i̇', 'i', 'İ', 'stanbul', '#2', '2', '', ' plain ']
  for (const t of titles) {
    for (const query of queries) assert.equal(matchesQuery(query, { number: 2, title: t }), masterMatchesQuery(query, { number: 2, title: t }), `${query} in ${t}`)
  }
})

test('highlighting follows the rows the search keeps and marks the original characters, also where lowercase changes length', () => {
  const marks = (text: string, query: string): string[] => splitMatches(text, [], queryTerms(query)).filter((piece) => piece.hit).map((piece) => piece.text)
  // a kept row is marked on the capital sigma its final-form query matched
  assert.deepEqual(marks('ΟΣ cache', 'ς'), ['Σ'])
  assert.deepEqual(marks('ΟΣ cache', 'ΟΣ cache'), ['ΟΣ cache'])
  // a row the search does not keep has no mark
  assert.equal(matchesQuery('σ', { number: 1, title: 'ΟΣ cache' }), false)
  assert.deepEqual(marks('ΟΣ cache', 'σ'), [])
  // a dotted capital I lowercases to two units; the mark still covers the one original character, and text after it stays aligned
  assert.equal(matchesQuery('i̇stanbul', { number: 1, title: 'İstanbul cache' }), true)
  assert.deepEqual(marks('İstanbul cache', 'i̇stanbul'), ['İstanbul'])
  assert.deepEqual(marks('İstanbul cache', 'stanbul'), ['stanbul'])
  assert.deepEqual(marks('İstanbul cache', 'cache'), ['cache'])
  assert.deepEqual(marks('xİİx', 'i̇i̇'), ['İİ'])
  // the page search's own words are located exactly as before
  assert.deepEqual(splitMatches('ΟΣ cache', searchTerms('σ')).filter((piece) => piece.hit).map((piece) => piece.text), ['Σ'])
})

test('the PR number and title cells mark a table search in Mine, Others\', and Closed', async () => {
  const { mine, others, closed } = await fixtures()
  const mineRow = mine[0]!
  const othersRow = others[0]!
  const closedRow = closed[0]!
  const word = (row: { title: string }): string => row.title.split(/\s+/).find((piece) => piece.length > 2)!.toLowerCase()
  const cases: [string, unknown, { cell: (row: never, ctx: CellContext) => { build: () => Node[] } }, { cell: (row: never, ctx: CellContext) => { build: () => Node[] } }, { number: number, title: string }][] = [
    ['mine', mineRow, byKey(mineColumns(false), 'title'), byKey(mineColumns(false), 'pr'), mineRow],
    ['others', othersRow, byKey(othersColumns(false), 'title'), byKey(othersColumns(false), 'pr'), othersRow],
    ['closed', closedRow, byKey(closedColumns({ rows: closed } as never), 'title'), byKey(closedColumns({ rows: closed } as never), 'pr'), closedRow],
  ]
  for (const [name, row, titleColumn, prColumn, plain] of cases) {
    const piece = word(plain)
    assert.match(await cellText(titleColumn, row, [], queryTerms(piece)), new RegExp(`\\[\\[${piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\]`, 'i'), name)
    const digits = String(plain.number).slice(-1)
    assert.match(await cellText(prColumn, row, [], queryTerms(`#${digits}`)), /^#\d*\[\[\d+\]\]/, name)
    // no search, no marks
    assert.doesNotMatch(await cellText(titleColumn, row, [], []), /\[\[/, name)
    assert.doesNotMatch(await cellText(prColumn, row, [], []), /\[\[/, name)
  }
})

test('the PR number cell marks a table search only where the number itself contains it', async () => {
  const { mine } = await fixtures()
  const row: MineRow = { ...mine[0]!, title: 'Fix #1 cache', number: 118 }
  const pr = byKey<MineRow>(mineColumns(false), 'pr')
  // the row is kept by its title, so the number has nothing of the search to show
  assert.equal(matchesQuery('##1', row), true)
  assert.doesNotMatch(await cellText(pr, row, [], queryTerms('##1')), /\[\[/)
  assert.equal(await cellText(pr, row, [], queryTerms('#18')), '#1[[18]]')
  assert.equal(await cellText(pr, row, [], queryTerms('#11')), '#[[11]]8')
})

test('with both searches set, a cell marks both, and each is removed alone', async () => {
  const { mine } = await fixtures()
  const row: MineRow = { ...mine[0]!, title: 'Fix the Orbit cache', number: 118 }
  const title = byKey<MineRow>(mineColumns(false), 'title')
  const page = searchTerms('orbit')
  const table = queryTerms('cache')
  assert.match(await cellText(title, row, page, table), /Fix the \[\[Orbit\]\] \[\[cache\]\]/)
  assert.match(await cellText(title, row, page, []), /Fix the \[\[Orbit\]\] cache/)
  assert.match(await cellText(title, row, [], table), /Fix the Orbit \[\[cache\]\]/)
  assert.match(await cellText(title, row, searchTerms('orbit cache'), queryTerms('the')), /Fix \[\[the\]\] \[\[Orbit\]\] \[\[cache\]\]|Fix \[\[the Orbit cache\]\]/)
})

test('a table search marks only the title and number, never the author, tickets, or a hidden-field line', async () => {
  const { others, closed } = await fixtures()
  const row = others.find((candidate) => candidate.author.alias.length > 2)!
  const alias = row.author.alias.toLowerCase()
  const author = byKey<OtherRow>(othersColumns(false), 'author')
  assert.doesNotMatch(await cellText(author, row, [], queryTerms(alias)), /\[\[/)
  assert.match(await cellText(author, row, searchTerms(alias), []), /\[\[/)
  const title = byKey<OtherRow>(othersColumns(false), 'title')
  const branchRow: OtherRow = { ...row, title: 'plain title', headRef: 'only-in-branch' }
  const text = await cellText(title, branchRow, [], queryTerms('only-in-branch'))
  assert.doesNotMatch(text, /branch only|only-in-branch/)
  const closedRow: ClosedRow = { ...closed[0]!, title: 'plain title', headRef: 'only-in-branch' }
  assert.doesNotMatch(await cellText(byKey<ClosedRow>(closedColumns({ rows: closed } as never), 'title'), closedRow, [], queryTerms('only-in-branch')), /only-in-branch/)
})

test('a cell rebuilds when the table search changes', async () => {
  const { mine } = await fixtures()
  const row = mine[0]!
  for (const key of ['title', 'pr']) {
    const column = byKey<MineRow>(mineColumns(false), key)
    const sig = async (query: readonly string[]): Promise<string> => JSON.stringify(column.cell(row, await context([], query)).sig)
    assert.notEqual(await sig(['a']), await sig([]), key)
    assert.notEqual(await sig(['a']), await sig(['ab']), key)
  }
})

test('the filters still keep the same rows: matchesMine, matchesOthers, and matchesClosed take the query as before', async () => {
  const { mine, others, closed } = await fixtures()
  const some = (rows: readonly { title: string }[]): string => rows[0]!.title.slice(1, 4).toUpperCase()
  assert.equal(mine.filter(matchesMine({ ...noFilters().mine, query: some(mine) })).every((row) => row.title.toLowerCase().includes(some(mine).toLowerCase()) || String(row.number).includes(some(mine).toLowerCase())), true)
  assert.ok(others.filter(matchesOthers({ ...noFilters().others, query: some(others) })).length > 0)
  assert.ok(closed.filter(matchesClosed({ ...noFilters().closed, query: some(closed) })).length > 0)
})
