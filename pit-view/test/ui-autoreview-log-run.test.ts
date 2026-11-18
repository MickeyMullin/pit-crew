// test/ui-autoreview-log-run.test.ts
// a run link in the auto-review log opens that run's Agent drawer (section 10 of DESIGN.md, The log): the real panel, the real drawer, and the page's opener (public/autoreviewlogopen.ts) against the fake document in test/fake-dom.ts, with a PR that has two runs and a PR that is closed
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LogEntry } from '../src/autoreviewlog.ts'
import type { OpenRow } from '../src/derive.ts'
import type { View } from '../src/poller.ts'
import type { AgentCell, RunView } from '../public/agent.ts'
import { createAutoReviewLogPanel } from '../public/autoreviewlog.ts'
import { openLoggedRun } from '../public/autoreviewlogopen.ts'
import { createDrawer } from '../public/drawer.ts'
import { setTimeFormat } from '../public/format.ts'
import { installFakeBrowser, press } from './fake-dom.ts'
import type { FakeElement } from './fake-dom.ts'

setTimeFormat('12h')

const repo = 'octo-example/orbit'
const head = '755b78b2c4e1f0a9d3b6e8c7a5f4d2e1b0c9a8f7'
const answer = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

const runOf = (id: number, number: number, patch: Record<string, unknown> = {}): RunView => ({
  id, repo, number, command: 'review-pr', args: [String(number), '--no-post'], label: 'Review', runner: 'claude', cwd: '~/dev/orbit', dir: `~/runs/${id}`, sessionId: null, pid: 4001, pidStartedAt: null,
  startedAt: '2026-10-28T14:00:00Z', lastStepAt: null, step: null, stepState: null, steps: [], tandem: false, finishedAt: '2026-10-28T14:05:00Z', status: 'failed', note: 'noResult', costUsd: null, resume: null,
  resolvedByHand: false, firstNote: null, extraInstructions: null, reportHash: null, postAttemptedAt: null, origin: 'auto', tick: 3, reason: 'requested', queuedAt: '2026-10-28T13:59:00Z', headOid: head.slice(0, 7), posting: false,
  result: null, models: null, ...patch,
} as unknown as RunView)

// PR 106 is open and has two runs, the newer one finished and the older one failed; PR 99 is closed and has one failed run
const older = runOf(41, 106, { startedAt: '2026-10-28T13:00:00Z', finishedAt: '2026-10-28T13:05:00Z' })
const newer = runOf(42, 106, {
  status: 'done', note: null,
  result: { schema: 'pit-crew/review-result@1', command: 'review-pr', status: 'done', target: { repo, pr: 106 }, reviewed: { kind: 'commit', sha: head }, verdict: 'clean', recommendation: null, findings: [], ci: 'green', fixAttempts: 0, posted: null, notPostedReason: 'noPost', report: '~/agents/output/PR-106.md', question: null, error: null },
})
const closedRun = runOf(40, 99, { note: 'permissionDenied: the folder cannot be written' })

const cellOf = (run: RunView): AgentCell => ({
  state: 'done', label: 'Review', action: { kind: 'reReview', label: 'Re-review', command: 'review-pr', args: ['106'], runner: 'claude' }, starts: [], models: { claude: 'Sonnet', codex: 'Codex default' }, lastReviewAt: null,
  runId: run.id, runner: 'claude', command: 'review-pr', args: run.args, status: 'done', startedAt: run.startedAt, lastStepAt: null, step: null, steps: [], tandem: false, commit: head, extraInstructions: null, recorded: null,
  origin: 'auto', queuedAt: null, posted: false, finishedAt: run.finishedAt, text: 'Clean · not posted', result: { kind: 'review', verdict: 'clean', recommendation: null, findings: 0, ci: 'green', posted: null, notPostedReason: 'noPost', report: '~/agents/output/PR-106.md' },
  question: null, note: null, firstNote: null, resolvedByHand: false, resume: null, costUsd: null, postOffer: null, storedOffer: null, stackRun: null,
} as unknown as AgentCell)

const row106 = (): OpenRow => ({
  number: 106, url: 'https://example.test/owner/name/pull/106', title: 'feat(nav): an invented change', author: { login: 'alex-mendez', alias: 'Alex' },
  headRef: 'feat/nav', baseRef: 'main', headOid: head, headSha: head, section: 'others', agent: cellOf(newer),
} as unknown as OpenRow)

const entryOf = (id: number, patch: Partial<LogEntry>): LogEntry => ({
  id, repo, lane: 'pr', number: 106, title: 'feat(nav): an invented change', decision: 'failed', reason: null, note: 'noResult', head: head.slice(0, 7), run: null, model: null, tick: 3,
  at: '2026-10-28T13:05:00Z', lastAt: '2026-10-28T13:05:00Z', count: 1, ...patch,
})

const entries = (): LogEntry[] => [
  entryOf(13, { decision: 'finished', reason: 'done', note: 'Clean · not posted', run: { kind: 'run', id: 42 }, at: '2026-10-28T14:05:00Z', lastAt: '2026-10-28T14:05:00Z' }),
  entryOf(12, { run: { kind: 'run', id: 41 } }),
  entryOf(11, { number: 99, title: 'chore: a closed invented PR', run: { kind: 'run', id: 40 }, note: 'permissionDenied: the folder cannot be written' }),
]

const withPages = async (check: (page: { panelRoot: FakeElement, drawerRoot: FakeElement, panel: ReturnType<typeof createAutoReviewLogPanel>, drawer: ReturnType<typeof createDrawer>, sweepOpened: number[], urls: string[] }) => Promise<void>): Promise<void> => {
  const urls: string[] = []
  const fake = installFakeBrowser((async (input: string) => {
    urls.push(String(input))
    if (String(input) === '/api/auto-review/log') return answer(200, { days: 14, entries: entries() })
    if (String(input) === '/api/prs/106/runs') return answer(200, [newer, older])
    if (String(input) === '/api/prs/99/runs') return answer(200, [closedRun])
    return answer(200, [])
  }) as typeof fetch)
  try {
    const doc = fake.document
    const header = doc.createElement('button')
    header.setAttribute('id', 'auto-review-button')
    header.setAttribute('data-focus-key', 'auto-review-button')
    const panelRoot = doc.createElement('aside')
    panelRoot.hidden = true
    const drawerRoot = doc.createElement('aside')
    drawerRoot.hidden = true
    doc.body.append(header, panelRoot, drawerRoot)
    const drawer = createDrawer({
      root: drawerRoot as unknown as HTMLElement,
      token: 'token-1',
      nowMs: () => Date.parse('2026-10-28T15:00:00Z'),
      rowOf: (number) => number === 106 ? row106() : undefined,
      repo: () => repo,
      viewer: () => 'viewer',
      say: () => undefined,
      reports: { open: () => undefined, close: () => undefined, isOpen: () => false, refresh: () => undefined },
      sweepLink: () => null,
      openSweep: () => undefined,
    })
    const sweepOpened: number[] = []
    const panel = createAutoReviewLogPanel({
      root: panelRoot as unknown as HTMLElement,
      nowMs: () => Date.parse('2026-10-28T15:00:00Z'),
      view: () => ({ autoReview: { state: 'idle', running: 0 } }) as unknown as View,
      isOpen: (number) => number === 106,
      openRun: openLoggedRun({ drawer, sweepDrawer: { open: (_opener, show) => { sweepOpened.push(show?.sweepId ?? -1) } }, seedRuns: () => undefined }),
      returnTo: () => header as unknown as HTMLElement,
    })
    await check({ panelRoot, drawerRoot, panel, drawer, sweepOpened, urls })
  } finally {
    fake.restore()
  }
}

const resultText = (root: FakeElement): string => root.querySelector('.drawer-result-text')?.textContent ?? ''
const linkOf = (root: FakeElement, run: number): FakeElement => {
  const link = root.querySelector(`button[data-auto-log-run="run-${run}"]`)
  assert.ok(link !== null, `a link for run ${run}`)
  return link
}

test('the link of the older of a PR\'s two runs opens the drawer on that run, not on the PR\'s newest', async () => {
  await withPages(async ({ panelRoot, drawerRoot, panel, drawer }) => {
    panel.open()
    await settle()
    press(linkOf(panelRoot, 41))
    await settle()
    assert.equal(panelRoot.hidden, true)
    assert.equal(drawer.isOpen(), true)
    assert.equal(drawer.number(), 106)
    // the older run failed with no result; the newer one is clean
    assert.match(resultText(drawerRoot), /no result/i)
    assert.doesNotMatch(resultText(drawerRoot), /Clean/)
    // and the link of the newer run shows the newer
    drawer.close()
    panel.open()
    await settle()
    press(linkOf(panelRoot, 42))
    await settle()
    assert.match(resultText(drawerRoot), /Clean/)
  })
})

test('a closed PR\'s run link opens a drawer on that run, which says the PR is no longer open and offers nothing to start', async () => {
  await withPages(async ({ panelRoot, drawerRoot, panel, drawer }) => {
    panel.open()
    await settle()
    press(linkOf(panelRoot, 40))
    await settle()
    assert.equal(panelRoot.hidden, true)
    assert.equal(drawer.isOpen(), true)
    assert.equal(drawer.number(), 99)
    assert.match(drawerRoot.textContent, /Agent for #99/)
    assert.match(drawerRoot.textContent, /chore: a closed invented PR/)
    assert.match(drawerRoot.textContent, /#99 is no longer open/)
    assert.match(resultText(drawerRoot), /permission denied/i)
    assert.equal(drawerRoot.querySelectorAll('[data-start-kind]').length, 0)
  })
})

test('a sweep\'s link opens the sweep drawer and not the Agent drawer', async () => {
  await withPages(async ({ drawer, sweepOpened }) => {
    openLoggedRun({ drawer, sweepDrawer: { open: (_opener, show) => { sweepOpened.push(show?.sweepId ?? -1) } }, seedRuns: () => undefined })({ kind: 'sweep', id: 7, key: 'line-1', number: null, title: null, closed: false, text: 'sweep 7', name: '', opens: true })
    assert.deepEqual(sweepOpened, [7])
    assert.equal(drawer.isOpen(), false)
  })
})
