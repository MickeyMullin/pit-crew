// test/ui-pagesearch.test.ts
// the header's page search (public/pagesearch.ts) and its controls (public/filters.ts), run under Node against rows derived from the invented fixtures
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { deriveClosed, deriveOpenRows } from '../src/derive.ts'
import type { MineRow, OtherRow } from '../src/derive.ts'
import { clearFilters, initialControls, pressTile, setFilter, setPageSearch, toggleSection } from '../public/filters.ts'
import { emptyMessage, hiddenHits, matchesPage, searchTerms, slashApplies, splitMatches } from '../public/pagesearch.ts'
import { scenario } from './fixtures/scenario.ts'
import { closedSearch, fakeTime, openPage1, openPage2 } from './helpers.ts'

const config = (): Config => ({ ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer })

const fixtures = async () => {
  const prs = [...(await openPage1()).data.repository!.pullRequests.nodes, ...(await openPage2()).data.repository!.pullRequests.nodes]
  const ctx = { config: config(), clock: fakeTime().clock, timeZone: scenario.timeZone }
  const open = deriveOpenRows(prs, scenario.defaultBranch, ctx)
  const closed = deriveClosed((await closedSearch()).data.search.nodes, ctx).today.rows
  return { open, closed }
}

const numbers = (rows: readonly { number: number }[]): number[] => rows.map((row) => row.number)

test('terms are lowercased, split on spaces, and a leading # is dropped from each', () => {
  assert.deepEqual(searchTerms(''), [])
  assert.deepEqual(searchTerms('   '), [])
  assert.deepEqual(searchTerms('  #118  Orbit '), ['118', 'orbit'])
  assert.deepEqual(searchTerms('#'), [])
  assert.deepEqual(searchTerms('a#b'), ['a#b'])
})

test('no terms match every row', async () => {
  const { open, closed } = await fixtures()
  assert.equal([...open, ...closed].every(matchesPage([])), true)
})

test('a term matches the number, title, author alias, login, branch, or ticket, in any case', () => {
  const row = {
    number: 118,
    title: 'Fix the Orbit cache',
    author: { alias: 'Alex', login: 'alex-mendez' },
    headRef: 'fix/orb-266-timeout',
    tickets: [{ system: 'Jira', label: 'ORB-266' }],
  }
  const matches = (query: string): boolean => matchesPage(searchTerms(query))(row)
  assert.equal(matches('#118'), true)
  assert.equal(matches('118'), true)
  assert.equal(matches('#119'), false)
  assert.equal(matches('ORBIT'), true)
  assert.equal(matches('alex'), true)
  assert.equal(matches('mendez'), true)
  assert.equal(matches('timeout'), true)
  assert.equal(matches('orb-266'), true)
  assert.equal(matches('nothing'), false)
})

test('every term must match, each in any field', () => {
  const row = { number: 7, title: 'Add retries', author: { alias: 'Sam', login: 'sam-ng' }, headRef: 'feat/retry', tickets: [] }
  assert.equal(matchesPage(searchTerms('retries sam'))(row), true)
  assert.equal(matchesPage(searchTerms('retries kim'))(row), false)
})

test('fixture rows are found by each searchable field in every table', async () => {
  const { open, closed } = await fixtures()
  const mine = open.filter((row): row is MineRow => row.section === 'mine')
  const others = open.filter((row): row is OtherRow => row.section === 'others')
  assert.ok(mine.length > 0 && others.length > 0 && closed.length > 0)
  for (const row of [...open, ...closed]) {
    assert.ok(matchesPage(searchTerms(`#${row.number}`))(row))
    assert.ok(matchesPage(searchTerms(row.title))(row))
    assert.ok(matchesPage(searchTerms(row.author.alias))(row))
    assert.ok(matchesPage(searchTerms(row.author.login))(row))
    assert.ok(matchesPage(searchTerms(row.headRef))(row), `branch of #${row.number}`)
    for (const ticket of row.tickets) assert.ok(matchesPage(searchTerms(ticket.label))(row))
  }
  const byBranch = closed.filter(matchesPage(searchTerms('fix/orb-266-timeout')))
  assert.deepEqual(numbers(byBranch), [100])
})

test('hidden hits name the branch, the login the alias hides, and tickets that no cell shows', () => {
  const row = {
    number: 5,
    title: 'Plain',
    author: { alias: 'Alex', login: 'alex-mendez' },
    headRef: 'fix/orb-266-timeout',
    tickets: [{ system: 'Jira', label: 'ORB-266' }],
  }
  const hits = (query: string, tickets = true) => hiddenHits(searchTerms(query), row, { tickets, alias: true })
  assert.deepEqual(hits('timeout'), [{ label: 'branch', text: 'fix/orb-266-timeout' }])
  assert.deepEqual(hits('mendez'), [{ label: 'login', text: 'alex-mendez' }])
  assert.deepEqual(hits('alex'), [])
  assert.deepEqual(hits('orb-266'), [{ label: 'branch', text: 'fix/orb-266-timeout' }, { label: 'ticket', text: 'ORB-266' }])
  assert.deepEqual(hits('orb-266', false), [{ label: 'branch', text: 'fix/orb-266-timeout' }])
  assert.deepEqual(hits('plain'), [])
  assert.deepEqual(hiddenHits([], row, { tickets: true, alias: true }), [])
})

test('matching and highlighting agree on context-sensitive lowercase', () => {
  const title = 'ΟΣ cache'
  const terms = searchTerms(title)
  const row = { number: 1, title, author: { alias: 'Sam', login: 'sam' }, headRef: 'x', tickets: [] }
  assert.equal(matchesPage(terms)(row), true)
  assert.equal(splitMatches(title, terms).some((piece) => piece.hit), true)
})

test('splitMatches marks every term occurrence and merges overlaps', () => {
  assert.deepEqual(splitMatches('Fix the Orbit cache', []), [{ text: 'Fix the Orbit cache', hit: false }])
  assert.deepEqual(splitMatches('Fix the Orbit cache', ['orbit']), [
    { text: 'Fix the ', hit: false },
    { text: 'Orbit', hit: true },
    { text: ' cache', hit: false },
  ])
  assert.deepEqual(splitMatches('aaa', ['aa']), [{ text: 'aaa', hit: true }])
  assert.deepEqual(splitMatches('abcabc', ['ab', 'bc']), [{ text: 'abcabc', hit: true }])
  assert.deepEqual(splitMatches('x ab y', ['ab', 'y']), [
    { text: 'x ', hit: false },
    { text: 'ab', hit: true },
    { text: ' ', hit: false },
    { text: 'y', hit: true },
  ])
  assert.deepEqual(splitMatches('', ['a']), [])
})

test('slash focuses the search only when no field has focus and no modifier is held', () => {
  const base = { key: '/', tag: 'BODY', editable: false, ctrl: false, meta: false, alt: false }
  assert.equal(slashApplies(base), true)
  assert.equal(slashApplies({ ...base, tag: 'BUTTON' }), true)
  assert.equal(slashApplies({ ...base, tag: 'INPUT' }), false)
  assert.equal(slashApplies({ ...base, tag: 'TEXTAREA' }), false)
  assert.equal(slashApplies({ ...base, tag: 'SELECT' }), false)
  assert.equal(slashApplies({ ...base, editable: true }), false)
  assert.equal(slashApplies({ ...base, ctrl: true }), false)
  assert.equal(slashApplies({ ...base, meta: true }), false)
  assert.equal(slashApplies({ ...base, alt: true }), false)
  assert.equal(slashApplies({ ...base, key: '?' }), false)
})

const none = { mine: 0, others: 0, closed: 0 }
const counts = (mine: number, others: number, closed: number) => ({ mine, others, closed })

test('the page search starts empty and changing it releases a tile but leaves the filters', () => {
  const start = initialControls()
  assert.equal(start.pageSearch, '')
  assert.deepEqual(start.searchOpened, [])
  const tiled = pressTile(start, 'yourMove')
  const searched = setPageSearch(tiled, 'orbit', none)
  assert.equal(searched.pageSearch, 'orbit')
  assert.equal(searched.tile, null)
  assert.deepEqual(searched.filters, tiled.filters)
})

test('a tile preset clears the page search, a table Clear does not', () => {
  const searched = setPageSearch(initialControls(), 'orbit', none)
  const tiled = pressTile(searched, 'waitingOnAuthor')
  assert.equal(tiled.pageSearch, '')
  const filtered = setFilter(searched, 'mine', { query: 'fix' })
  assert.equal(filtered.pageSearch, 'orbit')
  assert.equal(clearFilters(filtered, 'mine').pageSearch, 'orbit')
  assert.equal(setFilter(setPageSearch(pressTile(initialControls(), 'yourMove'), 'q', none), 'others', { query: 'a' }).pageSearch, 'q')
})

test('a collapsed section holding a match opens, and re-closes when the search changes and nothing in it matches', () => {
  let controls = { ...initialControls(), expanded: { mine: false, others: true, closed: false } }
  controls = setPageSearch(controls, 'orbit', counts(2, 0, 0))
  assert.deepEqual(controls.expanded, { mine: true, others: true, closed: false })
  assert.deepEqual(controls.searchOpened, ['mine'])
  controls = setPageSearch(controls, 'orbital', counts(0, 0, 0))
  assert.deepEqual(controls.expanded, { mine: false, others: true, closed: false })
  assert.deepEqual(controls.searchOpened, [])
})

test('a section that was open before the search stays open when nothing matches', () => {
  const controls = setPageSearch(initialControls(), 'zzz', none)
  assert.deepEqual(controls.expanded, { mine: true, others: true, closed: true })
  assert.deepEqual(controls.searchOpened, [])
})

test('emptying the search re-closes the sections it opened', () => {
  let controls = { ...initialControls(), expanded: { mine: false, others: false, closed: true } }
  controls = setPageSearch(controls, 'a', counts(1, 1, 1))
  assert.deepEqual(controls.expanded, { mine: true, others: true, closed: true })
  controls = setPageSearch(controls, '', counts(5, 5, 5))
  assert.deepEqual(controls.expanded, { mine: false, others: false, closed: true })
  assert.deepEqual(controls.searchOpened, [])
})

test('toggling a section by hand ends the search\'s claim on it, so emptying the search leaves it as chosen', () => {
  let controls = { ...initialControls(), expanded: { mine: false, others: true, closed: true } }
  controls = setPageSearch(controls, 'a', counts(1, 0, 0))
  controls = toggleSection(controls, 'mine')
  assert.equal(controls.expanded.mine, false)
  assert.deepEqual(controls.searchOpened, [])
  controls = toggleSection(controls, 'mine')
  assert.equal(controls.expanded.mine, true)
  controls = setPageSearch(controls, '', counts(0, 0, 0))
  assert.equal(controls.expanded.mine, true)
})

test('a tile press forgets which sections the search opened', () => {
  let controls = { ...initialControls(), expanded: { mine: false, others: true, closed: true } }
  controls = setPageSearch(controls, 'a', counts(1, 0, 0))
  controls = pressTile(controls, 'yourMove')
  assert.deepEqual(controls.searchOpened, [])
  assert.deepEqual(controls.expanded, { mine: false, others: true, closed: false })
})

test('the header holds a labeled search field and a clear button, hidden until there is text', async () => {
  const html = await readFile(join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8')
  const field = html.match(/<input id="page-search"[^>]*>/)?.[0] ?? ''
  assert.match(field, /aria-label="[^"]+"/)
  assert.match(field, /aria-keyshortcuts="\/"/)
  const clear = html.match(/<button id="page-search-clear"[^>]*>/)?.[0] ?? ''
  assert.match(clear, /aria-label="Clear page search"/)
  assert.match(clear, /\shidden[\s>]/)
  const svg = html.slice(html.indexOf('id="page-search-clear"')).match(/<svg[^>]*>/)?.[0] ?? ''
  assert.match(svg, /aria-hidden="true"/)
  assert.ok(html.indexOf('id="page-search"') > html.indexOf('id="sync-live"'))
  assert.ok(html.indexOf('id="page-search"') < html.indexOf('id="refresh"'))
})

test('an author the row does not show is named by an author hit, and a login hit survives another term matching the alias', () => {
  const row = { number: 9, title: 'Plain', author: { alias: 'Sam', login: 'sam-mendez' }, headRef: 'main-fix', tickets: [] }
  const shown = (query: string) => hiddenHits(searchTerms(query), row, { tickets: true, alias: true })
  const hidden = (query: string) => hiddenHits(searchTerms(query), row, { tickets: true, alias: false })
  assert.deepEqual(shown('sam mendez'), [{ label: 'login', text: 'sam-mendez' }])
  assert.deepEqual(shown('sam'), [])
  assert.deepEqual(hidden('sam'), [{ label: 'author', text: 'Sam' }, { label: 'login', text: 'sam-mendez' }])
  assert.deepEqual(hidden('mendez'), [{ label: 'login', text: 'sam-mendez' }])
  assert.deepEqual(hidden('plain'), [])
})

test('splitMatches slices the original text when lowercasing changes its length', () => {
  assert.deepEqual(splitMatches('İx', ['x']), [{ text: 'İ', hit: false }, { text: 'x', hit: true }])
  assert.deepEqual(splitMatches('aİb', ['b']), [{ text: 'aİ', hit: false }, { text: 'b', hit: true }])
  assert.deepEqual(splitMatches('İx', ['i̇x']), [{ text: 'İx', hit: true }])
})

test('a section with no rows at all says the page search matched nothing in it', () => {
  assert.equal(emptyMessage(0, 0, 0, 'You have no open PRs.'), 'Nothing in this section matches the page search.')
  assert.equal(emptyMessage(4, 0, 0, 'x'), 'Nothing in this section matches the page search.')
  assert.equal(emptyMessage(4, 0, 2, 'x'), 'No PRs match these filters.')
  assert.equal(emptyMessage(0, 0, null, 'You have no open PRs.'), 'You have no open PRs.')
  assert.equal(emptyMessage(4, 3, 3, 'x'), 'x')
})

test('a section closed or opened by hand during a search is never reopened or re-closed by it until the search is cleared', () => {
  let controls = { ...initialControls(), expanded: { mine: false, others: true, closed: true } }
  controls = setPageSearch(controls, 'a', counts(1, 1, 1))
  controls = toggleSection(controls, 'mine')
  assert.equal(controls.expanded.mine, false)
  controls = setPageSearch(controls, 'ab', counts(1, 1, 1))
  assert.equal(controls.expanded.mine, false)
  assert.deepEqual(controls.searchOpened, [])
  controls = toggleSection(controls, 'others')
  controls = setPageSearch(controls, 'abc', counts(0, 0, 0))
  assert.equal(controls.expanded.others, false)
  controls = toggleSection(controls, 'others')
  controls = setPageSearch(controls, 'abcd', counts(0, 0, 0))
  assert.equal(controls.expanded.others, true)
  controls = setPageSearch(controls, '', none)
  controls = setPageSearch(controls, 'a', counts(1, 0, 0))
  assert.equal(controls.expanded.mine, true)
  assert.deepEqual(controls.searchOpened, ['mine'])
})

test('the clear button has a display rule for its hidden state', async () => {
  const css = await readFile(join(import.meta.dirname, '..', 'public', 'styles.css'), 'utf8')
  assert.match(css, /\.page-search-clear\[hidden\]\s*\{\s*display:\s*none/)
})
