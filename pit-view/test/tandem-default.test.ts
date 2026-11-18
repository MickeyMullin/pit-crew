// test/tandem-default.test.ts
// the tandem review as the default start (section 8 of DESIGN.md, Agent cell and Drawer): the real start options and the real Agent cell feed the real drawer on the fake page, so what the first Start entry, the idle button, and the server's default for a start that names no kind say all come from one place
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import type { OpenRow } from '../src/derive.ts'
import type { RawOpenPr } from '../src/github.ts'
import { agentCell, defaultRun, isTandemRun, judge, startOptions } from '../src/launcher.ts'
import { resolveModels, tandemPairProblem } from '../src/models.ts'
import { sweepArgs, sweepCommand, sweepRequest } from '../src/sweeps.ts'
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

// the PRs of the fixture: 113 never reviewed by the viewer, 106 reviewed before, 104 the viewer's own awaiting review, and 114 Dependabot's
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

test('a Dependabot review, a stack review, a fix session, and the plain entries never carry --tandem, only the tandem entry does, and the sweep request is the same single run it was', () => {
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
  // the one builder both the manual start and the scheduler use for a sweep
  const sweep = sweepRequest(scenario.repo)
  assert.equal(sweep.command, sweepCommand)
  assert.deepEqual(sweep.args, sweepArgs(scenario.repo))
  assert.equal(isTandemRun(sweep.args), false)
})

test('the queue wording follows the first start: Queue tandem review on the idle button, Queue review in tandem first in the drawer, and the plain review one click away says queue too', () => {
  const room = { review: true, selfReview: true }
  const cell = agentCell(prOf(113), config, undefined, undefined, null, room)
  assert.equal(cell.action.label, 'Queue tandem review')
  assert.deepEqual(startsModel(cell, true, 113).buttons.map((entry) => entry.text), ['Queue review in tandem', 'Queue review PR'])
})

// the real drawer on the fake page: the Start button pressed, then the confirmation's own button; fetch records what the page sends
const startThroughDrawer = async (number: number, press1: 'tandem' | 'default' | 'stack' | 'fix', stack: typeof stacked | null = null): Promise<{ command: string, sent: { url: string, body: Record<string, unknown> | null }[] }> => {
  const cell = agentCell(prOf(number), config, undefined, undefined, stack)
  const sent: { url: string, body: Record<string, unknown> | null }[] = []
  const fake = installFakeBrowser((async (input: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      sent.push({ url: String(input), body: typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null })
      return new Response(JSON.stringify({ id: 9 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch)
  try {
    const root = fake.document.createElement('aside')
    fake.document.body.appendChild(root)
    const row = { number, url: `https://example.test/pull/${number}`, title: 'Invented title', author: { login: 'casey-rowe', alias: 'Casey' }, headRef: 'feat/a', baseRef: 'main', headOid: 'a'.repeat(40), headSha: 'a'.repeat(40), agent: cell } as unknown as OpenRow
    const drawer = createDrawer({
      root: root as unknown as HTMLElement, token: 't', nowMs: () => Date.now(), rowOf: (n) => n === number ? row : undefined, repo: () => scenario.repo, viewer: () => scenario.viewer,
      say: () => undefined, reports: { open: () => undefined, close: () => undefined, isOpen: () => false, refresh: () => undefined }, sweepLink: () => null, openSweep: () => undefined,
    })
    drawer.open(number, { key: `agent:${number}`, number })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
    const start = root.querySelectorAll('button').filter((button) => button.getAttribute('data-focus-key') === `start:${press1}`)[0]
    assert.ok(start, `#${number} offers the ${press1} start`)
    press(start)
    const command = root.querySelector('[data-confirm="command"]')?.textContent ?? ''
    sent.length = 0
    press(root.querySelector('[data-focus-key="confirm-go"]') as FakeElement)
    await new Promise<void>((resolve) => setImmediate(resolve))
    return { command, sent }
  } finally {
    fake.restore()
  }
}

test('the real drawer confirms and sends the tandem start and the plain start of a review, a re-review, and a self-review, each with its own kind and command', async () => {
  const expected = [
    [113, 'tandem', '/review-pr 113 --tandem', 'tandem'], [113, 'default', '/review-pr 113', 'default'],
    [106, 'tandem', '/review-pr 106 --tandem', 'tandem'], [106, 'default', '/review-pr 106', 'default'],
    [104, 'tandem', '/review-pr 104 --tandem --no-post', 'tandem'], [104, 'default', '/review-pr 104 --no-post', 'default'],
  ] as const
  for (const [number, pressed, command, kind] of expected) {
    const result = await startThroughDrawer(number, pressed)
    assert.equal(result.command, command, `#${number} ${pressed} command`)
    assert.deepEqual(result.sent.map((request) => [request.url, request.body?.kind, request.body?.runner]), [[`/api/prs/${number}/runs`, kind, 'claude']], `#${number} ${pressed} request`)
    assert.equal(result.sent[0]?.body?.repo, scenario.repo)
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

// the starts that are never a tandem, pressed in the real drawer on the real reader: the confirmation's command and the request the page sends carry no --tandem, and a Dependabot PR's drawer offers no tandem entry

// a Dependabot PR is offered one review and no tandem entry; a stack review and a fix session sit beside the tandem review of a PR that has one, so for those the entry pressed is what carries no --tandem
const noTandemEntry = (number: number): void => {
  const cell = agentCell(prOf(number), config, undefined, undefined)
  assert.equal(cell.starts.some((start) => start.kind === 'tandem'), false, `#${number} offers no tandem entry`)
  assert.equal(startsModel(cell, true, number).buttons.some((button) => button.kind === 'tandem'), false, `#${number} drawer shows no tandem button`)
}

for (const [name, number, pressed, stack, command, kind] of [
  ['a Dependabot review', 114, 'default', null, '/review-dependabot 114', 'default'],
  ['a stack review', 104, 'stack', stacked, '/review-stack 104', 'stack'],
  ['a fix session', 104, 'fix', stacked, '/fix-pr 104', 'fix'],
] as const) {
  test(`${name} pressed in the real drawer confirms and sends no --tandem, and its own entry is not a tandem one`, async () => {
    if (number === 114) noTandemEntry(number)
    const entry = agentCell(prOf(number), config, undefined, undefined, stack).starts.find((start) => start.kind === pressed)
    assert.ok(entry, `#${number} offers ${pressed}`)
    assert.equal(isTandemRun(entry.args), false)
    const result = await startThroughDrawer(number, pressed, stack)
    assert.equal(result.command.startsWith(command), true, result.command)
    assert.doesNotMatch(result.command, /--tandem/)
    assert.deepEqual(result.sent.map((request) => [request.url, request.body?.kind]), [[`/api/prs/${number}/runs`, kind]])
    assert.doesNotMatch(JSON.stringify(result.sent), /--tandem|"tandem"/)
  })
}
