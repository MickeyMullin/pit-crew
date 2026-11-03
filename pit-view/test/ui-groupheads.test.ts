// test/ui-groupheads.test.ts
// a collapsible group's header carries the sections' left-hand disclosure (public/tables.ts, public/styles.css), run under Node with a minimal stand-in for the document so the header builder can run
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { groupHead } from '../public/tables.ts'
import type { ShownGroup, TableModel } from '../public/tables.ts'

type Fake = { tag: string, attrs: Map<string, string>, children: Fake[], text?: string, listeners: Map<string, () => void>, setAttribute: (name: string, value: string) => void, addEventListener: (type: string, listener: () => void) => void, appendChild: (child: Fake) => Fake }
const fakeElement = (tag: string, text?: string): Fake => {
  const element: Fake = {
    tag,
    attrs: new Map(),
    children: [],
    listeners: new Map(),
    ...(text === undefined ? {} : { text }),
    setAttribute: (name, value) => { element.attrs.set(name, value) },
    addEventListener: (type, listener) => { element.listeners.set(type, listener) },
    appendChild: (child) => { element.children.push(child); return child },
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
const cls = (node: Fake): string[] => (node.attrs.get('class') ?? '').split(' ')

const group = (over: Partial<ShownGroup<unknown>> = {}): ShownGroup<unknown> => ({ key: 'drafts', label: 'Drafts', sub: 'Not ready for review', collapsible: true, open: false, rows: [{}, {}, {}], ...over })
const model = (toggled: string[], sweep: TableModel<unknown>['sweep'] = null): TableModel<unknown> =>
  ({ table: sweep === null ? 'mine' : 'others', columns: [{}, {}, {}], onToggleGroup: (key: string) => { toggled.push(key) }, sweep }) as unknown as TableModel<unknown>
const head = (g: ShownGroup<unknown>, toggled: string[] = [], sweep: TableModel<unknown>['sweep'] = null): Fake =>
  groupHead(model(toggled, sweep), g, 'mine-group-drafts').build() as unknown as Fake
const buttons = (root: Fake): Fake[] => walk(root).filter((node) => node.tag === 'button')

test('a collapsible group header leads with the sections\' disclosure: chevron, then the label, in one button', () => {
  const root = head(group())
  const toggle = buttons(root)[0]!
  assert.ok(cls(toggle).includes('disclosure'))
  assert.equal(toggle.attrs.get('aria-expanded'), 'false')
  assert.equal(toggle.attrs.get('aria-controls'), 'mine-group-drafts')
  assert.equal(toggle.attrs.get('data-focus-key'), 'group:mine:drafts')
  assert.equal(toggle.attrs.get('type'), 'button')
  const [icon, label] = toggle.children
  assert.equal(icon!.tag, 'svg')
  assert.equal(icon!.children[0]!.attrs.get('d'), 'M6 9l6 6 6-6')
  assert.equal(icon!.attrs.get('aria-hidden'), 'true')
  assert.ok(cls(label!).includes('group-label'))
  assert.equal(text(label!), 'Drafts')
  // it is the first thing in the bar
  const bar = walk(root).find((node) => cls(node).includes('group-bar'))!
  assert.equal(bar.children[0], toggle)
})

test('an open group says so with aria-expanded, and the toggle asks for this group', () => {
  const toggled: string[] = []
  const toggle = buttons(head(group({ open: true }), toggled))[0]!
  assert.equal(toggle.attrs.get('aria-expanded'), 'true')
  toggle.listeners.get('click')!()
  assert.deepEqual(toggled, ['drafts'])
})

test('the right-hand Show n / Hide button is gone, and the count, explanation, and label stay', () => {
  for (const open of [false, true]) {
    const root = head(group({ open }))
    assert.ok(!/\b(Show \d+|Hide)\b/.test(text(root)))
    assert.equal(buttons(root).length, 1)
    const found = walk(root)
    assert.equal(text(found.find((node) => cls(node).includes('group-count'))!), '3')
    assert.equal(text(found.find((node) => cls(node).includes('group-sub'))!), 'Not ready for review')
    assert.equal(text(found.find((node) => cls(node).includes('group-label'))!), 'Drafts')
  }
})

test('a group that does not collapse has no disclosure, only its label', () => {
  const root = head(group({ key: 'yourMove', label: 'Your move', collapsible: false, open: true }))
  assert.equal(buttons(root).length, 0)
  assert.equal(text(walk(root).find((node) => cls(node).includes('group-label'))!), 'Your move')
})

test('the bot group keeps its Run sweep button and sweep state beside the disclosure', () => {
  const sweep = { start: { label: 'Run sweep', name: 'Run sweep', disabled: false, reason: null }, status: { sweepId: 4, label: 'Sweep: Done', tone: 'green', running: false, startedAt: '2026-01-01T00:00:00Z', lastStepAt: null, finishedAt: '2026-01-01T00:05:00Z', text: 'Sweep: Done', name: 'Latest sweep', tip: 'Open the sweep' } } as unknown as TableModel<unknown>['sweep']
  const root = head(group({ key: 'bots', label: 'Bots', open: false }), [], sweep)
  const all = buttons(root)
  assert.equal(all.length, 3)
  assert.ok(cls(all[0]!).includes('disclosure'))
  assert.deepEqual(all.slice(1).map((node) => node.attrs.get('data-sweep')), ['start', 'open'])
  assert.equal(text(all[1]!), 'Run sweep')
  // the sweep state shows its label and tone, and the open button is the one that opens the sweep
  assert.equal(text(all[2]!), 'Sweep: Done')
})

test('the stylesheet gives the group disclosure the section control, at the group header\'s size and the label\'s tone', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8')
  assert.match(css, /\.disclosure\[aria-expanded='false'\] svg \{\s*transform: rotate\(-90deg\)/)
  assert.match(css, /\.group-bar \.disclosure \{[^}]*font-size: 14px/)
})
