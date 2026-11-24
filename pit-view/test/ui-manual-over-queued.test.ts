// test/ui-manual-over-queued.test.ts
// a manual start on a PR whose auto-review run is only queued, driven through the real page code: the Agent cell and its start options come from the server's own agentCell over real cache rows, and public/drawer.ts builds the confirmation and sends its request against the fake document in test/fake-dom.ts. Every expected value here is a literal written out, not taken from the code under test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openCache } from '../src/cache.ts'
import type { NewRun, Run } from '../src/cache.ts'
import { defaultConfig } from '../src/config.ts'
import type { OpenRow } from '../src/derive.ts'
import type { RawOpenPr } from '../src/github.ts'
import { agentCell, runView } from '../src/launcher.ts'
import type { AgentCell } from '../public/agent.ts'
import { createDrawer } from '../public/drawer.ts'
import { drawerModel } from '../public/drawerview.ts'
import type { RunView } from '../public/agent.ts'
import { scenario } from './fixtures/scenario.ts'
import { installFakeBrowser, press } from './fake-dom.ts'
import type { FakeElement } from './fake-dom.ts'
import { logEntryText } from '../public/autoreviewlogview.ts'
import type { LogEntry } from '../src/autoreviewlog.ts'
import { fakeTime, openPage1, openPage2 } from './helpers.ts'

type Sent = { url: string, method: string, body: Record<string, unknown> | null }

const answer = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const prOf = async (number: number): Promise<RawOpenPr> => {
  const nodes = [...(await openPage1()).data.repository!.pullRequests.nodes, ...(await openPage2()).data.repository!.pullRequests.nodes]
  const pr = nodes.find((entry) => entry.number === number)
  assert.ok(pr !== undefined, `fixture PR #${number}`)
  return pr
}

const config = { ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit', maxConcurrentReviews: 2 }

const replacesLine = 'This PR has an auto-review waiting in the queue. Starting now replaces it.'

const runRow = (patch: Partial<NewRun> = {}): NewRun => ({
  repo: scenario.repo, number: 106, command: 'review-pr', args: ['106', '--no-post'], label: 'Review', runner: 'claude', cwd: '~/dev/orbit',
  sessionId: null, pid: null, pidStartedAt: null, startedAt: '2026-10-28T14:00:00Z', lastStepAt: null, step: null, stepState: null,
  finishedAt: null, status: 'queued', result: null, note: null, costUsd: null, resume: null,
  origin: 'auto', tick: 1, reason: 'new', queuedAt: '2026-10-28T14:00:00Z', headOid: 'abcdef0', ...patch,
})

const rowsOf = (...patches: Partial<NewRun>[]): Run[] => {
  const cache = openCache({ path: ':memory:', clock: fakeTime().clock })
  try {
    cache.createTick(scenario.repo)
    return patches.map((patch) => cache.createRun(runRow(patch), (id) => `~/runs/${id}`))
  } finally {
    cache.close()
  }
}

const cellOf = async (...runs: Run[]): Promise<AgentCell> => agentCell(await prOf(106), config, runs.at(-1), undefined, null, { review: false, selfReview: false, running: 0 }, undefined, [...runs].reverse()) as unknown as AgentCell

const row = (agent: AgentCell): OpenRow => ({
  number: 106,
  url: 'https://example.test/octo-example/orbit/pull/106',
  title: 'feat(pager): page the audit list',
  author: { login: 'sam-tran', alias: 'Sam' },
  headRef: 'feat/pager', baseRef: 'main', headOid: '755b78b2c4e1f0a9d3b6e8c7a5f4d2e1b0c9a8f7',
  agent,
} as unknown as OpenRow)

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const withDrawer = async (cell: AgentCell, kind: 'default' | 'tandem' | undefined, runs: RunView[], check: (page: { root: FakeElement, sent: Sent[], buttons: () => string[], byKey: (key: string) => FakeElement | null }) => Promise<void>): Promise<void> => {
  const sent: Sent[] = []
  const fake = installFakeBrowser((async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    sent.push({ url: String(input), method, body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null })
    if (method === 'POST') return answer(200, { id: 9 })
    return answer(200, String(input).endsWith('/runs') ? runs : [])
  }) as typeof fetch)
  try {
    const root = fake.document.createElement('aside')
    fake.document.body.appendChild(root)
    const drawer = createDrawer({
      root: root as unknown as HTMLElement,
      token: 'token-1',
      nowMs: () => Date.parse('2026-10-28T15:00:00Z'),
      rowOf: (number) => number === 106 ? row(cell) : undefined,
      repo: () => scenario.repo,
      viewer: () => scenario.viewer,
      say: () => undefined,
      reports: { open: () => undefined, close: () => undefined, isOpen: () => false, refresh: () => undefined },
      sweepLink: () => null,
      openSweep: () => undefined,
    })
    drawer.open(106, { key: 'agent:106', number: 106 }, kind)
    await settle()
    await settle()
    sent.length = 0
    await check({
      root,
      sent,
      buttons: () => root.querySelector('.confirm-actions')?.querySelectorAll('button').map((button) => button.textContent) ?? [],
      byKey: (key) => root.querySelector(`[data-focus-key="${key}"]`),
    })
  } finally {
    fake.restore()
  }
}

test('the confirmation of a start on a PR with a queued auto run says plainly that Start replaces it, and Start sends the ordinary start', async () => {
  const [queued] = rowsOf({})
  await withDrawer(await cellOf(queued!), 'default', [], async (page) => {
    assert.deepEqual(page.buttons(), ['Cancel', 'Start'])
    assert.ok(page.root.textContent.includes(replacesLine))
    press(page.byKey('confirm-go') as FakeElement)
    await settle()
    assert.deepEqual(page.sent.filter((request) => request.method === 'POST').map((request) => [request.url, request.body]), [
      ['/api/prs/106/runs', { kind: 'default', runner: 'claude', repo: scenario.repo, viewer: scenario.viewer }],
    ])
  })
})

test('the tandem start says the same, and a start on a PR with nothing queued says nothing of replacing', async () => {
  const [queued] = rowsOf({})
  await withDrawer(await cellOf(queued!), 'tandem', [], async (page) => {
    assert.ok(page.root.textContent.includes(replacesLine))
  })
  await withDrawer(await cellOf(), 'default', [], async (page) => {
    assert.equal(page.root.textContent.includes('waiting in the queue'), false)
    assert.equal(page.root.textContent.includes('replaces it'), false)
  })
})

test('a running auto run offers no start: the Start buttons are disabled with the in-flight reason, and no confirmation opens', async () => {
  const [live] = rowsOf({ status: 'running', startedAt: '2026-10-28T14:30:00Z' })
  const cell = await cellOf(live!)
  const model = drawerModel({ row: row(cell), open: true, runs: { state: 'ready', items: [] }, reports: { state: 'loading' }, confirm: null })
  assert.deepEqual(model.starts.buttons.map((button) => button.disabled), model.starts.buttons.map(() => true))
  assert.equal(model.starts.shared, 'A run for #106 is already in flight.')
})

test('the Queued card of the auto run offers its starts: with a queued auto run they are enabled, so the page can ask for a start while the card shows', async () => {
  const [queued] = rowsOf({})
  const cell = await cellOf(queued!)
  const model = drawerModel({ row: row(cell), open: true, runs: { state: 'ready', items: [] }, reports: { state: 'loading' }, confirm: null })
  assert.equal(model.card, 'queued')
  assert.equal(model.starts.buttons.length >= 2, true)
  for (const button of model.starts.buttons) assert.equal(button.disabled, false)
  assert.equal(model.starts.shared, null)
})

test('after the start lands the manual run\'s card replaces the Queued card, and the superseded auto run is listed under the auto-review runs with its plain reason', async () => {
  const [auto, manual] = rowsOf({ status: 'skipped', note: 'superseded', finishedAt: '2026-10-28T14:40:00Z' }, { origin: 'manual', status: 'running', args: ['106'], tick: null, reason: null, queuedAt: null, headOid: null, startedAt: '2026-10-28T14:40:00Z' } as Partial<NewRun>)
  const cell = await cellOf(auto!, manual!)
  const runs = [manual!, auto!].map((run) => runView(run) as unknown as RunView)
  const model = drawerModel({ row: row(cell), open: true, runs: { state: 'ready', items: runs }, reports: { state: 'loading' }, confirm: null })
  assert.equal(model.card, 'running')
  assert.equal(model.queued, null)
  assert.deepEqual(model.autoRuns.map((entry) => [entry.id, entry.text, entry.why]), [[auto!.id, 'Skipped', 'Replaced by a review you started by hand.']])
  await withDrawer(cell, undefined, runs, async (page) => {
    assert.equal(page.root.querySelector('.drawer-queued'), null)
    assert.ok(page.root.textContent.includes('Replaced by a review you started by hand.'))
  })
})

test('a skipped auto run with another reason shows no superseded line', async () => {
  const [closed] = rowsOf({ status: 'skipped', note: 'closed', finishedAt: '2026-10-28T14:40:00Z' })
  const model = drawerModel({ row: row(await cellOf(closed!)), open: true, runs: { state: 'ready', items: [runView(closed!) as unknown as RunView] }, reports: { state: 'loading' }, confirm: null })
  assert.deepEqual(model.autoRuns.map((entry) => entry.why), [null])
})

test('the auto-review log says a superseded run was dropped before it started, replaced by a review the owner started', () => {
  const line = { id: 1, repo: scenario.repo, lane: 'pr', number: 106, title: 'feat(nav): an invented change', decision: 'dropped', reason: 'superseded', note: null, head: 'cccc3334444', run: { kind: 'run', id: 4 }, model: null, tick: 3, at: '2026-11-02T14:30:00Z', lastAt: '2026-11-02T14:30:00Z', count: 1 } as unknown as LogEntry
  assert.equal(logEntryText(line), 'Dropped before start: replaced by a review you started')
})
