// test/ui-basedon.test.ts
// the Title cell of the Mine and Others' tables (public/tables.ts): a stack GitHub marks reads "stack n/m", a PR it does not mark but whose base is another open PR's branch reads "based on #N (n/m)" and links to that PR in a new tab, and neither word is borrowed by the other. Run under Node with a minimal stand-in for the document, through the real column definitions, their signatures, and the nodes they build
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { OpenRow } from '../src/derive.ts'
import { deriveOpenRows } from '../src/derive.ts'
import type { RawOpenPr } from '../src/github.ts'
import type { View } from '../src/poller.ts'
import { mineColumns, othersColumns } from '../public/tables.ts'
import type { CellContext } from '../public/tables.ts'
import { defaultConfig } from '../src/config.ts'
import { scenario } from './fixtures/scenario.ts'
import { openPage1, openPage2 } from './helpers.ts'

type Fake = { tag: string, attrs: Map<string, string>, children: Fake[], text?: string, setAttribute: (name: string, value: string) => void, appendChild: (child: Fake) => Fake, addEventListener: () => void }
const fakeElement = (tag: string, text?: string): Fake => {
  const element: Fake = {
    tag,
    attrs: new Map(),
    children: [],
    ...(text === undefined ? {} : { text }),
    setAttribute: (name, value) => { element.attrs.set(name, value) },
    appendChild: (child) => { element.children.push(child); return child },
    addEventListener: () => {},
  }
  return element
}
Object.assign(globalThis, {
  document: {
    createElement: (tag: string) => fakeElement(tag),
    createElementNS: (_ns: string, tag: string) => fakeElement(tag),
    createTextNode: (text: string) => fakeElement('#text', text),
  },
})
const text = (node: Fake): string => (node.tag === '#text' ? node.text! : node.children.map(text).join(''))
const walk = (node: Fake): Fake[] => [node, ...node.children.flatMap(walk)]

const config = { ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer }
const clock = { now: () => Date.parse(scenario.now) }
const all = async (): Promise<RawOpenPr[]> => [...(await openPage1()).data.repository!.pullRequests.nodes, ...(await openPage2()).data.repository!.pullRequests.nodes]
const unmarked = (prs: RawOpenPr[]): RawOpenPr[] => prs.map((pr) => ({ ...pr, stack: null, stackEntry: null }))
const rowsOf = (prs: RawOpenPr[]): OpenRow[] => deriveOpenRows(prs, scenario.defaultBranch, { config, clock, timeZone: scenario.timeZone })
const context = (repo: string): CellContext => ({ view: { repo } as unknown as View, nowMs: clock.now(), paused: false, terms: [], queryTerms: [] })

// every title cell the tables can build for a row: Mine's and Others'
const titleCells = (row: OpenRow, repo: string = scenario.repo) => {
  const column = row.section === 'mine' ? mineColumns(false).find((entry) => entry.key === 'title')! : othersColumns(false).find((entry) => entry.key === 'title')!
  const cell = (column.cell as (row: OpenRow, ctx: CellContext) => { sig: unknown, build: () => Node[] })(row, context(repo))
  return { sig: JSON.stringify(cell.sig), nodes: cell.build() as unknown as Fake[] }
}
const chipsOf = (nodes: Fake[]): Fake[] => nodes.flatMap(walk).filter((node) => (node.attrs.get('class') ?? '').split(' ').includes('chip'))

test('a PR GitHub does not mark but whose base is another open PR\'s branch shows "based on #N (n/m)" linking to that PR in a new tab, and no stack chip', async () => {
  const rows = rowsOf(unmarked(await all()))
  for (const number of [111, 112]) {
    const row = rows.find((entry) => entry.number === number)!
    const { nodes } = titleCells(row)
    const chips = chipsOf(nodes)
    assert.equal(chips.length, 1, `#${number}`)
    const chip = chips[0]!
    const parent = number - 1
    assert.equal(text(chip), `based on #${parent} (${number - 109}/3)`)
    assert.ok(!chips.some((entry) => /stack/i.test(text(entry))))
    assert.equal(chip.tag, 'a')
    assert.equal(chip.attrs.get('href'), `https://github.com/${scenario.repo}/pull/${parent}`)
    assert.equal(chip.attrs.get('target'), '_blank')
    assert.equal(chip.attrs.get('rel'), 'noopener')
  }
  // the bottom of the chain is based on nothing
  assert.equal(chipsOf(titleCells(rows.find((entry) => entry.number === 110)!).nodes).length, 0)
})

test('a PR GitHub marks keeps "stack n/m" with GitHub\'s numbers and no based-on chip', async () => {
  const rows = rowsOf(await all())
  const chips = chipsOf(titleCells(rows.find((entry) => entry.number === 111)!).nodes)
  assert.deepEqual(chips.map(text), ['stack 2/3'])
})

test('without a plain repository the based-on chip is text, and its signature moves with the PR it names and the repository', async () => {
  const row = rowsOf(unmarked(await all())).find((entry) => entry.number === 112)!
  const bad = titleCells(row, 'not a repo')
  const chip = chipsOf(bad.nodes)[0]!
  assert.equal(chip.tag, 'span')
  assert.equal(chip.attrs.has('href'), false)
  assert.equal(text(chip), 'based on #111 (3/3)')
  const good = titleCells(row)
  const moved = titleCells({ ...row, basedOn: { number: 110, position: 3, size: 3 } })
  assert.notEqual(good.sig, bad.sig)
  assert.notEqual(good.sig, moved.sig)
  assert.notEqual(good.sig, titleCells({ ...row, basedOn: null }).sig)
})

test('the Mine table\'s title cell carries the same indication', async () => {
  const prs = unmarked(await all()).map((pr) => pr.number === 111 ? { ...pr, author: { __typename: 'User', login: scenario.viewer, avatarUrl: '' } } as RawOpenPr : pr)
  const row = rowsOf(prs).find((entry) => entry.number === 111)!
  assert.equal(row.section, 'mine')
  assert.deepEqual(chipsOf(titleCells(row).nodes).map(text), ['based on #110 (2/3)'])
})
