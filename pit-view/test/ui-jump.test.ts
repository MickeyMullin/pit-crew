// test/ui-jump.test.ts
// Start immediately (jump queue), driven through the real page code: the Agent cell and its start options come from the server's own agentCell, and public/drawer.ts builds the confirmation and sends its request against the fake document in test/fake-dom.ts. Every expected value here is a literal written out, not taken from the code under test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultConfig } from '../src/config.ts'
import type { OpenRow } from '../src/derive.ts'
import type { RawOpenPr } from '../src/github.ts'
import { agentCell } from '../src/launcher.ts'
import type { Queueing } from '../src/launcher.ts'
import type { AgentCell } from '../public/agent.ts'
import { createDrawer } from '../public/drawer.ts'
import { drawerModel, runRows } from '../public/drawerview.ts'
import type { RunView } from '../src/launcher.ts'
import { scenario } from './fixtures/scenario.ts'
import { installFakeBrowser, press, tick, typeInto } from './fake-dom.ts'
import type { FakeElement } from './fake-dom.ts'
import { openPage1, openPage2 } from './helpers.ts'

type Sent = { url: string, method: string, body: Record<string, unknown> | null }

const answer = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const prOf = async (number: number): Promise<RawOpenPr> => {
  const nodes = [...(await openPage1()).data.repository!.pullRequests.nodes, ...(await openPage2()).data.repository!.pullRequests.nodes]
  const pr = nodes.find((entry) => entry.number === number)
  assert.ok(pr !== undefined, `fixture PR #${number}`)
  return pr
}

const config = { ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit', maxConcurrentReviews: 2 }
const full: Queueing = { review: true, selfReview: true, running: 2 }
const room: Queueing = { review: false, selfReview: false, running: 0 }

// #106 is someone else's PR the viewer reviewed before, so its starts are the tandem re-review and the plain one
const cellOf = async (queueing: Queueing): Promise<AgentCell> => agentCell(await prOf(106), config, undefined, undefined, null, queueing) as unknown as AgentCell

const row = (agent: AgentCell): OpenRow => ({
  number: 106,
  url: 'https://example.test/octo-example/orbit/pull/106',
  title: 'feat(pager): page the audit list',
  author: { login: 'sam-tran', alias: 'Sam' },
  headRef: 'feat/pager', baseRef: 'main', headOid: '755b78b2c4e1f0a9d3b6e8c7a5f4d2e1b0c9a8f7',
  agent,
} as unknown as OpenRow)

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

// the real drawer on the fake page, with the confirmation of one start asked; fetch records what the page sends
const withConfirmation = async (cell: AgentCell, kind: 'default' | 'tandem', check: (page: { root: FakeElement, sent: Sent[], buttons: () => string[], byKey: (key: string) => FakeElement | null }) => Promise<void>): Promise<void> => {
  const sent: Sent[] = []
  const fake = installFakeBrowser((async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    sent.push({ url: String(input), method, body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null })
    if (method === 'POST') return answer(200, { id: 1 })
    return answer(200, [])
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

const posts = (sent: Sent[]): Sent[] => sent.filter((request) => request.method === 'POST')

const jumpLine = 'This review starts now, ahead of the queue, and 3 reviews will be running, above the review cap (3 running, cap 2). Nothing else starts until the count falls below the cap.'

for (const kind of ['default', 'tandem'] as const) {
  test(`a ${kind} start that would wait offers Start immediately (jump queue) after Cancel and Start, says what it does, and sends the ordinary start's fields plus the flag`, async () => {
    await withConfirmation(await cellOf(full), kind, async (page) => {
      assert.deepEqual(page.buttons(), ['Cancel', 'Start', 'Start immediately (jump queue)'])
      assert.ok(page.root.textContent.includes(jumpLine))
      // the fields of the ordinary start stay, and what is set on them goes with the jump
      tick(page.root.querySelector('input[name="drawer-extra-on"]') as FakeElement)
      typeInto(page.root.querySelector('textarea[name="drawer-extra"]') as FakeElement, 'read the pager first')
      press(page.byKey('confirm-jump') as FakeElement)
      await settle()
      assert.deepEqual(posts(page.sent).map((request) => [request.url, request.body]), [
        ['/api/prs/106/runs', { kind, runner: 'claude', repo: scenario.repo, viewer: scenario.viewer, extraInstructions: 'read the pager first', jump: true }],
      ])
    })
  })
}

test('Start on a confirmation that offers the jump is the ordinary start and sends no flag', async () => {
  await withConfirmation(await cellOf(full), 'default', async (page) => {
    press(page.byKey('confirm-go') as FakeElement)
    await settle()
    assert.deepEqual(posts(page.sent).map((request) => request.body), [{ kind: 'default', runner: 'claude', repo: scenario.repo, viewer: scenario.viewer }])
  })
})

test('a start that would not wait offers no jump: Cancel and Start alone, and no line about the queue', async () => {
  await withConfirmation(await cellOf(room), 'default', async (page) => {
    assert.deepEqual(page.buttons(), ['Cancel', 'Start'])
    assert.equal(page.byKey('confirm-jump'), null)
    assert.equal(page.root.textContent.includes('ahead of the queue'), false)
  })
})

// the record: the run details say a run was started ahead of the queue

const jumpedText = 'Started ahead of the queue with Start immediately (jump queue).'

test('the running card, the result card, and the earlier runs say a run was started ahead of the queue, and say nothing for one that was not', async () => {
  const idle = await cellOf(room)
  const runningCell = { ...idle, state: 'running', status: 'running', runId: 7, runner: 'claude', command: 'review-pr', args: ['106'], label: 'Re-review', startedAt: '2026-10-28T14:55:00Z', jumped: true } as AgentCell
  const model = (cell: AgentCell) => drawerModel({ row: row(cell), open: true, runs: { state: 'ready', items: [] }, reports: { state: 'loading' }, confirm: null })
  assert.equal(model(runningCell).running?.jumped, jumpedText)
  assert.equal(model({ ...runningCell, jumped: false }).running?.jumped, null)
  const doneCell = { ...runningCell, state: 'done', status: 'done', finishedAt: '2026-10-28T14:59:00Z', text: 'Approved' } as AgentCell
  assert.equal(model(doneCell).result?.jumped, jumpedText)
  assert.equal(model({ ...doneCell, jumped: false }).result?.jumped, null)
  const earlier = (jumped: boolean): RunView => ({
    id: 5, repo: scenario.repo, number: 106, command: 'review-pr', args: ['106'], label: 'Re-review', runner: 'claude', cwd: '~/dev/orbit', dir: '~/state/runs/5',
    sessionId: null, pid: null, pidStartedAt: null, startedAt: '2026-10-27T14:00:00Z', lastStepAt: null, step: null, stepState: null, steps: [],
    finishedAt: '2026-10-27T14:10:00Z', status: 'failed', result: null, note: 'noResult', costUsd: null, resume: null, tandem: false, origin: 'manual', extraInstructions: null, models: null, jumped,
  } as unknown as RunView)
  assert.deepEqual(runRows([earlier(true), earlier(false)], null).map((entry) => entry.jumped), [jumpedText, null])
})

test('the drawer shows the line on a jumped run\'s card', async () => {
  const idle = await cellOf(room)
  const cell = { ...idle, state: 'running', status: 'running', runId: 7, runner: 'claude', command: 'review-pr', args: ['106'], label: 'Re-review', startedAt: '2026-10-28T14:55:00Z', jumped: true } as AgentCell
  await withConfirmation(cell, 'default', async (page) => {
    assert.ok(page.root.textContent.includes(jumpedText))
  })
})
