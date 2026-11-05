// test/ui-agentmerge.test.ts
// the Agent cell's idle button reads Merge on a Mine row that is ready to merge into the primary branch (public/agent.ts, public/agentcell.ts); the page derives that from the row it already has, and the cell only opens the drawer with the Squash and merge confirmation asked
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cellModel, showsMerge } from '../public/agent.ts'
import type { AgentCell } from '../public/agent.ts'
import { agentCellNodes, agentCellSig } from '../public/agentcell.ts'
import { actionHolds } from '../public/actionsview.ts'

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

const row = (section: string, state: string, primaryBase: boolean) => ({ section, merge: { state }, primaryBase }) as unknown as Parameters<typeof showsMerge>[0]

test('Merge shows only on a Mine row that is ready to merge into the primary branch', () => {
  assert.equal(showsMerge(row('mine', 'ready', true)), true)
  assert.equal(showsMerge(row('mine', 'ready', false)), false)
  for (const state of ['draft', 'blocked', 'conflicts', 'pending', 'waiting']) assert.equal(showsMerge(row('mine', state, true)), false, state)
  assert.equal(showsMerge(row('others', 'ready', true)), false)
  assert.equal(showsMerge(row('bots', 'ready', true)), false)
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
