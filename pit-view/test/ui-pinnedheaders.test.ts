// test/ui-pinnedheaders.test.ts
// the pinned column headers (section 6 of DESIGN.md, Sections): the stylesheet's rules, read as written, and the real table renderer on the fake document in test/fake-dom.ts, which draws one header row per table. The fake document has no layout, so what a browser pins is not exercised here
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ClosedRange } from '../src/derive.ts'
import { closedColumns, mineColumns, othersColumns, renderTable } from '../public/tables.ts'
import type { Column, TableKey, TableModel } from '../public/tables.ts'
import { installFakeBrowser } from './fake-dom.ts'
import type { FakeElement } from './fake-dom.ts'

const css = readFile(join(import.meta.dirname, '..', 'public', 'styles.css'), 'utf8')

// the declarations of the first rule with exactly this selector, in the text given
const ruleOf = (text: string, selector: string): Map<string, string> => {
  const at = text.split('\n').findIndex((line, index, lines) => line.trim() === `${selector} {` && !(lines[index - 1] ?? '').trim().endsWith(','))
  assert.ok(at >= 0, `a rule for ${selector}`)
  const found = new Map<string, string>()
  for (const line of text.split('\n').slice(at + 1)) {
    if (line.trim() === '}') break
    const [name = '', value = ''] = line.trim().replace(/;$/, '').split(/:\s*/, 2)
    found.set(name, value)
  }
  return found
}

// the block of the media query that pins the headers, and the width it starts at
const pinned = async (): Promise<{ from: number, block: string }> => {
  const text = await css
  const open = /@media \(min-width: (\d+)px\) \{\n(?=[^@]*?\.prs thead th \{\n\s+position: sticky)/.exec(text)
  assert.ok(open !== null, 'a min-width media query that makes the column headers sticky')
  const start = open.index + open[0].length
  return { from: Number(open[1]), block: text.slice(start, text.indexOf('\n}\n', start)) }
}

test('each table\'s own header row is pinned beneath the page\'s sticky header, on an opaque background and under the header\'s layer', async () => {
  const { block } = await pinned()
  const header = ruleOf(block, '.prs thead th')
  assert.equal(header.get('position'), 'sticky')
  assert.equal(header.get('top'), 'calc(var(--header-height, 56px) - 1px)')
  assert.equal(header.get('background'), 'var(--surface)')
  const layer = Number(header.get('z-index'))
  assert.ok(layer >= 1 && layer < Number(ruleOf(await css, '.site-header').get('z-index')), `layer ${layer} is above the rows and under the page header`)
})

test('no box around a table scrolls where the headers are pinned, so they pin to the window, and below that width the tables keep their own sideways scroll', async () => {
  const { block } = await pinned()
  assert.equal(ruleOf(block, '.dashboard .card').get('overflow'), 'clip')
  assert.equal(ruleOf(block, '.dashboard .table-box').get('overflow-x'), 'visible')
  // outside the query nothing changed
  const text = await css
  assert.equal(ruleOf(text, '.card').get('overflow'), 'hidden')
  assert.equal(ruleOf(text, '.table-box').get('overflow-x'), 'auto')
})

test('the headers pin only where the widest table fits its box, scroll bar included, so no table there needs the sideways scroll it gave up', async () => {
  const text = await css
  const { from } = await pinned()
  const px = (value: string | undefined): number => Number(/^(\d+)px$/.exec(value ?? '')?.[1])
  const widest = Math.max(px(ruleOf(text, '.prs-open').get('min-width')), px(ruleOf(text, '.prs-closed').get('min-width')))
  const side = Number(/^\d+px (\d+)px/.exec(ruleOf(text, '.dashboard').get('padding') ?? '')?.[1])
  const border = 1
  const scrollBar = 17
  assert.equal(Number.isFinite(widest + side), true)
  assert.ok(from >= widest + 2 * side + 2 * border + scrollBar, `${from} leaves room for ${widest}`)
})

test('a control focused in a row lands below the pinned header too', async () => {
  const { block } = await pinned()
  assert.match(block, /\.prs tbody,\n\s+\.prs tbody \* \{\n\s+scroll-margin-top: calc\(var\(--header-height, 56px\) \+ 44px\);/)
})

const range: ClosedRange = { label: 'Today', from: '2026-10-26T04:00:00Z', to: '2026-10-26T14:05:38Z', isMondayRule: false, rows: [] }

const tables: [TableKey, Column<never>[]][] = [
  ['mine', mineColumns(true) as unknown as Column<never>[]],
  ['others', othersColumns(true) as unknown as Column<never>[]],
  ['closed', closedColumns(range) as unknown as Column<never>[]],
]

for (const [table, columns] of tables) {
  test(`the ${table} table has one header row, so the pinned one is the same element with the same columns, widths, and sort buttons`, () => {
    const fake = installFakeBrowser((async () => new Response('[]')) as typeof fetch)
    try {
      const element: FakeElement = fake.document.createElement('table')
      fake.document.body.appendChild(element)
      const model = {
        table, columns, groups: [], ctx: {}, state: 'ready', emptyText: 'none', numberOf: () => 0, rowClass: () => 'row', freshnessOf: () => null, onToggleGroup: () => undefined, sort: null, onSort: () => undefined,
      } as unknown as TableModel<never>
      renderTable(element as unknown as HTMLTableElement, model)
      renderTable(element as unknown as HTMLTableElement, model)
      assert.equal(element.querySelectorAll('thead').length, 1)
      assert.equal(element.querySelectorAll('thead tr').length, 1)
      assert.deepEqual(element.querySelectorAll('thead th').map((cell) => cell.className), columns.map((column) => `col-${column.key}`))
      assert.equal(element.querySelectorAll('thead button').length, columns.filter((column) => column.sort !== undefined).length)
    } finally {
      fake.restore()
    }
  })
}
