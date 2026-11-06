// test/ui-agentmerge.test.ts
// the Agent cell's idle button reads Merge on a Mine row that is ready to merge into the primary branch (public/agent.ts, public/agentcell.ts); the page derives that from the row it already has, and the cell only opens the drawer with the Squash and merge confirmation asked
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cellModel, showsMerge } from '../public/agent.ts'
import type { AgentCell } from '../public/agent.ts'
import { agentCellNodes, agentCellSig } from '../public/agentcell.ts'
import { actionHolds } from '../public/actionsview.ts'
import { mineColumns, othersColumns } from '../public/tables.ts'
import type { CellContext } from '../public/tables.ts'

type Fake = { tag: string, attrs: Map<string, string>, children: Fake[], text?: string, setAttribute: (name: string, value: string) => void, appendChild: (child: Fake) => Fake }
const fakeElement = (tag: string, text?: string): Fake => {
  const element: Fake = {
    tag,
    attrs: new Map(),
    children: [],
    ...(text === undefined ? {} : { text }),
    setAttribute: (name, value) => { element.attrs.set(name, value) },
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

const now = Date.parse('2026-10-28T15:00:00Z')

const selfReview = (patch: Partial<AgentCell> = {}): AgentCell => ({
  state: 'idle',
  label: 'Self-review',
  action: { kind: 'selfReview', label: 'Self-review', command: 'review-local', args: ['101'], runner: 'claude' },
  starts: [],
  commit: null,
  lastReviewAt: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
  runId: null, runner: null, command: null, args: null, status: null, startedAt: null, lastStepAt: null, step: null,
  steps: [], tandem: false,
  finishedAt: null, text: null, result: null, question: null, note: null, firstNote: null, resolvedByHand: false, resume: null, costUsd: null, postOffer: null,
  ...patch,
} as unknown as AgentCell)

const row = (section: string, state: string, primaryBase: boolean, group = 'readyToMerge') => ({ section, merge: { state }, primaryBase, group }) as unknown as Parameters<typeof showsMerge>[0]

test('Merge shows only on a Mine row that is ready to merge into the primary branch', () => {
  assert.equal(showsMerge(row('mine', 'ready', true)), true)
  assert.equal(showsMerge(row('mine', 'ready', false)), false)
  for (const state of ['draft', 'blocked', 'conflicts', 'pending', 'waiting']) assert.equal(showsMerge(row('mine', state, true)), false, state)
  assert.equal(showsMerge(row('others', 'ready', true)), false)
  assert.equal(showsMerge(row('bots', 'ready', true)), false)
})

test('Merge shows on an approved row GitHub is still checking, which groups as ready to merge, and on no other checking row', () => {
  assert.equal(showsMerge(row('mine', 'checking', true, 'readyToMerge')), true)
  assert.equal(showsMerge(row('mine', 'checking', false, 'readyToMerge')), false)
  for (const group of ['awaitingReview', 'changesRequested', 'drafts']) assert.equal(showsMerge(row('mine', 'checking', true, group)), false, group)
  assert.equal(showsMerge(row('others', 'checking', true, 'readyToMerge')), false)
  // blocked (a failing or unstable check, behind, conflicts) never shows it, even in the ready group
  assert.equal(showsMerge(row('mine', 'blocked', true, 'readyToMerge')), false)
})

test('the idle cell reads Merge with its own accessible name, and keeps the last-review line', () => {
  assert.deepEqual(cellModel(selfReview(), 101, now, true), {
    state: 'idle', button: 'Merge', name: 'Merge #101: open agent', under: 'last review 7d ago', ask: 'merge',
  })
  assert.deepEqual(cellModel(selfReview(), 101, now, false), {
    state: 'idle', button: 'Self-review', name: 'Self-review #101: open agent', under: 'last review 7d ago',
  })
  assert.deepEqual(cellModel(selfReview(), 101, now), cellModel(selfReview(), 101, now, false))
})

test('a queued, running, or done cell is unchanged even on a ready row', () => {
  const done = selfReview({ state: 'done', runId: 4, status: 'done', text: 'Clean', finishedAt: new Date(now - 60_000).toISOString() })
  assert.deepEqual(cellModel(done, 101, now, true), cellModel(done, 101, now, false))
  assert.equal(cellModel(done, 101, now, true).name, 'Open agent for #101, Clean')
  const running = selfReview({ state: 'running', runId: 5, status: 'running', startedAt: new Date(now - 60_000).toISOString() })
  assert.deepEqual(cellModel(running, 101, now, true), cellModel(running, 101, now, false))
})

test('the Merge button is the cell\'s one open button and names the confirmation to ask', () => {
  const button = (merge: boolean): Fake => {
    const span = agentCellNodes(selfReview(), 101, now, merge)[0] as unknown as Fake
    return span.children[0]!
  }
  const merge = button(true)
  assert.equal(merge.attrs.get('data-agent'), 'open')
  assert.equal(merge.attrs.get('data-pr'), '101')
  assert.equal(merge.attrs.get('data-agent-ask'), 'merge')
  assert.equal(merge.attrs.get('aria-label'), 'Merge #101: open agent')
  assert.equal(merge.children[0]?.text, 'Merge')
  const plain = button(false)
  assert.equal(plain.attrs.has('data-agent-ask'), false)
  assert.equal(plain.attrs.get('aria-label'), 'Self-review #101: open agent')
})

test('the cell rebuilds when a row starts or stops being ready to merge', () => {
  const sig = (merge: boolean): string => JSON.stringify(agentCellSig(selfReview(), 101, now, merge))
  assert.notEqual(sig(true), sig(false))
  assert.equal(sig(true), sig(true))
})

test('a merge confirmation opened from the cell is dropped by the existing rule once the row stops offering Merge', () => {
  const ask = { type: 'action', action: 'merge', repo: 'octo-example/orbit', viewer: 'vera-quill', reviewer: '', headSha: 'a'.repeat(40), baseRef: 'main' } as const
  const ready = { section: 'mine', merge: { state: 'ready' }, primaryBase: true, issues: [], headSha: 'a'.repeat(40), baseRef: 'main' } as unknown as Parameters<typeof actionHolds>[1]
  assert.equal(actionHolds(ask, ready, true), true)
  assert.equal(actionHolds(ask, { ...ready, merge: { state: 'blocked' } } as typeof ready, true), false)
})

// the table's own Agent column, given the row shape the table receives: the live label is pinned here, through the column's `sig` and the nodes `build()` returns, not through the helpers
const columnCell = (kind: 'mine' | 'others') => {
  const column = (kind === 'mine' ? mineColumns(true) : othersColumns(true)).find((candidate) => candidate.key === 'agent')!
  const ctx = { view: { sweeps: { items: [] } }, nowMs: now, paused: false, terms: [], queryTerms: [] } as unknown as CellContext
  return (tableRow: object) => {
    const cell = (column.cell as (r: unknown, c: CellContext) => { sig: unknown, build: () => Node[] })(tableRow, ctx)
    const nodes = cell.build() as unknown as Fake[]
    const button = nodes[0]!.children[0]!
    return { sig: JSON.stringify(cell.sig), name: button.attrs.get('aria-label'), ask: button.attrs.get('data-agent-ask'), text: button.children[0]?.text }
  }
}
const tableRow = (patch: object = {}) => ({ number: 101, headOid: 'a'.repeat(40), section: 'mine', merge: { state: 'ready' }, primaryBase: true, agent: selfReview(), ...patch })

test('the Mine table\'s Agent column flips between Self-review and Merge as the row becomes and stops being ready', () => {
  const cell = columnCell('mine')
  const idle = cell(tableRow({ merge: { state: 'pending' } }))
  const ready = cell(tableRow())
  assert.equal(idle.name, 'Self-review #101: open agent')
  assert.equal(idle.ask, undefined)
  assert.equal(ready.name, 'Merge #101: open agent')
  assert.equal(ready.ask, 'merge')
  assert.equal(ready.text, 'Merge')
  // the signature differs, so the keyed render rebuilds the cell on the next patch, both ways
  assert.notEqual(ready.sig, idle.sig)
  // a new push, a change request, a base change: each takes Merge away again
  for (const patch of [{ merge: { state: 'blocked' } }, { merge: { state: 'conflicts' } }, { primaryBase: false }]) {
    const stopped = cell(tableRow(patch))
    assert.equal(stopped.name, 'Self-review #101: open agent', JSON.stringify(patch))
    assert.notEqual(stopped.sig, ready.sig, JSON.stringify(patch))
    assert.equal(stopped.sig, idle.sig, JSON.stringify(patch))
  }
})

test('the Others table\'s Agent column never shows Merge', () => {
  const stays = columnCell('others')(tableRow({ section: 'others' }))
  assert.equal(stays.name, 'Self-review #101: open agent')
  assert.equal(stays.ask, undefined)
})
