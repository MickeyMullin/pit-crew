// test/tandem-default.test.ts
// the tandem review as the default start (section 8 of DESIGN.md, Agent cell and Drawer): the real start options and the real Agent cell feed the real drawer on the fake page, so what the first Start entry, the idle button, and the server's default for a start that names no kind say all come from one place
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import type { OpenRow } from '../src/derive.ts'
import type { RawOpenPr } from '../src/github.ts'
import { agentCell, defaultRun, isTandemRun, judge, startOptions } from '../src/launcher.ts'
import { tandemPairProblem } from '../src/models.ts'
import { resolveModels } from '../src/models.ts'
import { cellModel } from '../public/agent.ts'
import type { AgentCell } from '../public/agent.ts'
import { createDrawer } from '../public/drawer.ts'
import { startConfirmModel, startsModel } from '../public/drawerview.ts'
import { installFakeBrowser, press } from './fake-dom.ts'
import type { FakeElement } from './fake-dom.ts'
import { openPage1, openPage2 } from './helpers.ts'
import { scenario } from './fixtures/scenario.ts'

const config: Config = { ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit' }
const nodes: readonly RawOpenPr[] = [...(await openPage1()).data.repository!.pullRequests.nodes, ...(await openPage2()).data.repository!.pullRequests.nodes]
const prOf = (number: number): RawOpenPr => {
  const pr = nodes.find((candidate) => candidate.number === number)
  assert.ok(pr !== undefined, `fixture PR #${number}`)
  return pr
}
const stacked = { position: 2, size: 3 }

// the PRs of the fixture: 113 never reviewed by the viewer, 106 reviewed before, 104 the viewer's own awaiting review, 114 Dependabot's
const kindsOf = (number: number, stack: typeof stacked | null = null): string[] => startOptions(prOf(number), config, stack, false).map((option) => option.kind)

test('the first start of a review, a re-review, and a self-review is the tandem one, with the plain review next, and the idle button and the first drawer button agree', () => {
  for (const [number, button, plain] of [[113, 'Review in tandem', 'Review PR'], [106, 'Re-review in tandem', 'Re-review PR'], [104, 'Self-review in tandem', 'Self-review']] as const) {
    const cell = agentCell(prOf(number), config, undefined, undefined)
    const starts = startsModel(cell, true, number)
    assert.deepEqual(starts.buttons.slice(0, 2).map((entry) => [entry.kind, entry.text]), [['tandem', button], ['default', plain]], `#${number}`)
    assert.equal(isTandemRun(cell.action.args), true)
    assert.deepEqual(cell.action.args, cell.starts[0]?.args)
    assert.equal(cell.action.label, cell.starts[0]?.label)
    assert.match((cellModel(cell, number, Date.now()) as { button: string }).button, /^Tandem /)
  }
})

test('a Dependabot review, its sweep, a stack review, a fix session, and the plain entries never carry --tandem, and only the tandem entry does', () => {
  assert.deepEqual(kindsOf(114), ['default'])
  assert.equal(isTandemRun(defaultRun(prOf(114), config).args), false)
  assert.equal(defaultRun(prOf(114), config).command, 'review-dependabot')
  for (const number of [113, 106, 104, 111, 114, 115]) {
    for (const option of startOptions(prOf(number), config, stacked, false)) {
      assert.equal(isTandemRun(option.args), option.kind === 'tandem', `#${number} ${option.kind}`)
      if (option.command === 'review-stack' || option.command === 'fix-pr' || option.command === 'review-dependabot') assert.equal(isTandemRun(option.args), false, `#${number} ${option.command}`)
    }
  }
  assert.ok(kindsOf(104, stacked).includes('fix') && kindsOf(104, stacked).includes('stack'))
})

test('the queue wording follows the first start: Queue tandem review on the idle button, Queue review in tandem first in the drawer, and the plain review one click away says queue too', () => {
  const room = { review: true, selfReview: true }
  const cell = agentCell(prOf(113), config, undefined, undefined, null, room)
  assert.equal(cell.action.label, 'Queue tandem review')
  assert.deepEqual(startsModel(cell, true, 113).buttons.map((entry) => entry.text), ['Queue review in tandem', 'Queue review PR'])
})

test('a tandem start asks for Claude and sends the tandem kind, a plain start one click away sends the default kind, through the real drawer', async () => {
  const cell = agentCell(prOf(106), config, undefined, undefined, stacked)
  const sent: { url: string, body: Record<string, unknown> | null }[] = []
  const fake = installFakeBrowser((async (input: string, init?: RequestInit) => {
    sent.push({ url: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null })
    if (init?.method === 'POST') return new Response(JSON.stringify({ id: 9 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch)
  try {
    const root = fake.document.createElement('aside')
    fake.document.body.appendChild(root)
    const row = { number: 106, url: 'https://example.test/pull/106', title: 'Invented title', author: { login: 'casey-rowe', alias: 'Casey' }, headRef: 'feat/a', baseRef: 'main', headOid: 'a'.repeat(40), headSha: 'a'.repeat(40), agent: cell } as unknown as OpenRow
    const drawer = createDrawer({
      root: root as unknown as HTMLElement, token: 't', nowMs: () => Date.now(), rowOf: (number) => number === 106 ? row : undefined, repo: () => scenario.repo, viewer: () => scenario.viewer,
      say: () => undefined, reports: { open: () => undefined, close: () => undefined, isOpen: () => false, refresh: () => undefined }, sweepLink: () => null, openSweep: () => undefined,
    })
    drawer.open(106, { key: 'agent:106', number: 106 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
    const buttons = (): FakeElement[] => root.querySelectorAll('button').filter((button) => button.getAttribute('data-focus-key')?.startsWith('start:') === true)
    assert.deepEqual(buttons().map((button) => button.textContent), ['Re-review in tandem', 'Re-review PR', 'Review stack'])
    press(buttons()[0]!)
    assert.match(root.textContent, /\/review-pr 106 --tandem/)
    const confirm = startConfirmModel(row, cell, 'tandem', 'claude')
    assert.equal(confirm?.runner, 'claude')
    assert.deepEqual(confirm?.runners.map((runner) => runner.name), ['claude'])
    const plain = startConfirmModel(row, cell, 'default', 'claude')
    assert.doesNotMatch(plain?.command ?? '', /--tandem/)
    assert.deepEqual(plain?.runners.map((runner) => runner.name), ['claude', 'codex'])
  } finally {
    fake.restore()
  }
})

test('a start on a Claude-only tandem cannot be given another runner: the confirmation offers Claude alone, whatever runner is configured', () => {
  const codex: Config = { ...config, agent: { runner: 'codex', claudeModel: 'sonnet' } }
  const cell: AgentCell = agentCell(prOf(113), codex, undefined, undefined)
  assert.equal(cell.action.runner, 'claude')
  const row = { number: 113, title: 'Invented title', headRef: 'feat/b' }
  assert.equal(startConfirmModel(row, cell, 'tandem', 'codex')?.runner, 'claude')
  // the plain review still follows the configured runner
  assert.equal(startConfirmModel(row, cell, 'default', 'codex')?.runner, 'codex')
})

// the pair a scheduled tandem needs

const pair = (...ids: string[]) => resolveModels({ slots: { autoReviewHuman: ids } })

test('a Human auto-review pair runs a tandem when its primary is on Claude and the two are different models, and is refused otherwise with the reason', () => {
  assert.equal(tandemPairProblem(resolveModels(undefined)), null)
  assert.equal(tandemPairProblem(pair('opus', 'gpt-6.1-terra')), null)
  assert.equal(tandemPairProblem(pair('sonnet', 'opus')), null)
  assert.match(tandemPairProblem(pair('gpt-6.1-terra', 'sonnet')) ?? '', /primary gpt-6\.1-terra runs on codex, and a tandem primary runs on Claude only/)
  assert.match(tandemPairProblem(pair('kimi-code', 'sonnet')) ?? '', /runs on hermes/)
  assert.match(tandemPairProblem(pair('sonnet', 'sonnet')) ?? '', /names sonnet twice, and a tandem needs two different models/)
})

test('a registry entry that repeats a model under another id is the same model, so the pair is refused', () => {
  const same = resolveModels({ registry: [{ id: 'sonnet-again', runner: 'claude', provider: 'anthropic', model: 'sonnet' }], slots: { autoReviewHuman: ['sonnet', 'sonnet-again'] } })
  assert.match(tandemPairProblem(same) ?? '', /needs two different models/)
})

// an unattended stop

const stopped = { schema: 'pit-crew/review-result@1', command: 'review-pr', status: 'needsInput', question: 'The secondary failed: consolidate without it?', reviewed: null, verdict: null, findings: [], report: null } as never
const judged = (unattended: boolean) => judge({ stopped: false, restarted: false, exit: { code: 0, signal: null, error: null }, parsed: { ok: true, value: stopped }, reportExists: null, denials: [], unattended, lastEvent: null })

test('a stop to ask in a run nobody attends is a failed run carrying the question, and the same stop in an attended run is still a stop to ask', () => {
  assert.deepEqual([judged(true).status, judged(true).note], ['failed', 'unattendedStop: The secondary failed: consolidate without it?'])
  assert.deepEqual([judged(false).status, judged(false).note], ['needsInput', null])
})
