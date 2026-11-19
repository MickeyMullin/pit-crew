// test/ui-autoreview-log-run.test.ts
// a run link in the auto-review log opens that run's Agent drawer (section 10 of DESIGN.md, The log), and the drawer's link leads back to that line: the real panel, the real drawer, and the page's opener (public/autoreviewlogopen.ts) against the fake document in test/fake-dom.ts, with a PR that has two runs and a PR that is closed
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
  // run 7 of PR 106 has been pruned from the PR's runs, while the log still keeps its line
  entryOf(14, { decision: 'started', reason: 'requested', note: null, run: { kind: 'run', id: 7 }, at: '2026-10-28T14:10:00Z', lastAt: '2026-10-28T14:10:00Z' }),
  entryOf(13, { decision: 'finished', reason: 'done', note: 'Clean · not posted', run: { kind: 'run', id: 42 }, at: '2026-10-28T14:05:00Z', lastAt: '2026-10-28T14:05:00Z' }),
  entryOf(12, { run: { kind: 'run', id: 41 } }),
  entryOf(11, { number: 99, title: 'chore: a closed invented PR', run: { kind: 'run', id: 40 }, note: 'permissionDenied: the folder cannot be written' }),
]

type Page = {
  panelRoot: FakeElement, drawerRoot: FakeElement, header: FakeElement, panel: ReturnType<typeof createAutoReviewLogPanel>, drawer: ReturnType<typeof createDrawer>, sweepOpened: number[], urls: string[]
  // the scheduler's state moves on, so the panel's next update reads the log again
  bump: () => void
  document: ReturnType<typeof installFakeBrowser>['document']
}

// served, by default: the log's lines and PR 106's two runs; a test replaces what the log or PR 106's runs answer
type Served = { log?: () => Response | Promise<Response>, runs106?: () => Response | Promise<Response> }

const withPages = async (check: (page: Page) => Promise<void>, served: Served = {}): Promise<void> => {
  const urls: string[] = []
  let moves = 0
  const fake = installFakeBrowser((async (input: string) => {
    urls.push(String(input))
    if (String(input) === '/api/auto-review/log') return served.log?.() ?? answer(200, { days: 14, entries: entries() })
    if (String(input) === '/api/prs/106/runs') return served.runs106?.() ?? answer(200, [newer, older])
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
      view: () => ({ autoReview: { state: 'idle', running: moves } }) as unknown as View,
      isOpen: (number) => number === 106,
      openRun: openLoggedRun({ drawer, sweepDrawer: { open: (_opener, show) => { sweepOpened.push(show?.sweepId ?? -1) } }, seedRuns: () => undefined, backToLog: (entryId) => panel.restore(entryId) }),
      returnTo: () => header as unknown as HTMLElement,
    })
    await check({ panelRoot, drawerRoot, header, panel, drawer, sweepOpened, urls, bump: () => { moves += 1 }, document: doc })
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
    openLoggedRun({ drawer, sweepDrawer: { open: (_opener, show) => { sweepOpened.push(show?.sweepId ?? -1) } }, seedRuns: () => undefined, backToLog: () => undefined })({ kind: 'sweep', id: 7, key: 'line-1', entryId: 1, anchor: 'auto-log-entry-1', number: null, title: null, closed: false, text: 'sweep 7', name: '', opens: true })
    assert.deepEqual(sweepOpened, [7])
    assert.equal(drawer.isOpen(), false)
  })
})

test('opening the drawer on the same PR any other way shows its newest run again, not the run the log chose', async () => {
  await withPages(async ({ panelRoot, drawerRoot, panel, drawer }) => {
    panel.open()
    await settle()
    press(linkOf(panelRoot, 41))
    await settle()
    assert.match(resultText(drawerRoot), /no result/i)
    drawer.open(106, { key: 'auto-review-button', number: 106 })
    await settle()
    assert.match(resultText(drawerRoot), /Clean/)
    assert.doesNotMatch(resultText(drawerRoot), /no result/i)
  })
})

// the run the log asked for, when its card cannot be shown: a note in its place, never another run's card

const asks = (drawerRoot: FakeElement): string => drawerRoot.querySelector('.drawer-gone')?.textContent ?? ''

test('while the runs of the PR load, the drawer says that run is loading and shows no run\'s card in its place', async () => {
  let release: (response: Response) => void = () => undefined
  const held = new Promise<Response>((resolve) => { release = resolve })
  await withPages(async ({ panelRoot, drawerRoot, panel }) => {
    panel.open()
    await settle()
    press(linkOf(panelRoot, 41))
    await settle()
    assert.match(asks(drawerRoot), /Loading run 41/)
    assert.equal(drawerRoot.querySelector('.drawer-result-text'), null)
    release(answer(200, [newer, older]))
    await settle()
    // loaded, the run's own card replaces the note
    assert.equal(asks(drawerRoot), '')
    assert.match(resultText(drawerRoot), /no result/i)
  }, { runs106: () => held })
})

test('when the runs loaded and the run is not among them, the drawer says that run is no longer listed, by its id, and shows no other run\'s card', async () => {
  await withPages(async ({ panelRoot, drawerRoot, panel }) => {
    panel.open()
    await settle()
    press(linkOf(panelRoot, 7))
    await settle()
    assert.match(asks(drawerRoot), /Run 7 is no longer listed for #106/)
    assert.equal(drawerRoot.querySelector('.drawer-result-text'), null)
  })
})

test('when the runs could not be loaded, the drawer says so for that run and shows no other run\'s card', async () => {
  await withPages(async ({ panelRoot, drawerRoot, panel }) => {
    panel.open()
    await settle()
    press(linkOf(panelRoot, 41))
    await settle()
    assert.match(asks(drawerRoot), /Run 41 cannot be shown: the runs of #106 could not be loaded/)
    assert.equal(drawerRoot.querySelector('.drawer-result-text'), null)
  }, { runs106: () => answer(500, { error: 'the cache is unreadable' }) })
})

test('the run the row\'s own card already shows is opened as it was, with no note', async () => {
  await withPages(async ({ panelRoot, drawerRoot, panel }) => {
    panel.open()
    await settle()
    press(linkOf(panelRoot, 42))
    await settle()
    assert.equal(asks(drawerRoot), '')
    assert.match(resultText(drawerRoot), /Clean/)
  }, { runs106: () => answer(500, { error: 'the cache is unreadable' }) })
})

// the link back to the log: a real link to the line's anchor

const backOf = (drawerRoot: FakeElement): FakeElement | null => drawerRoot.querySelector('a[data-focus-key="back-to-log"]')
const focusedKey = (page: Page): string | null => page.document.activeElement?.getAttribute('data-auto-log-key') ?? null

test('a drawer opened from a log line shows a link back to that line, and following it closes the drawer and shows the log scrolled to the line with its run link focused', async () => {
  await withPages(async (page) => {
    const { panelRoot, drawerRoot, panel, drawer } = page
    panel.open()
    await settle()
    press(linkOf(panelRoot, 41))
    await settle()
    const back = backOf(drawerRoot)
    assert.ok(back !== null)
    assert.equal(back.getAttribute('href'), '#auto-log-entry-12')
    assert.equal(back.textContent, 'Back to the auto-review log')
    back.dispatch('click')
    await settle()
    assert.equal(drawer.isOpen(), false)
    assert.equal(drawerRoot.hidden, true)
    assert.equal(panelRoot.hidden, false)
    const line = page.document.getElementById('auto-log-entry-12')
    assert.ok(line !== null)
    assert.deepEqual(line.scrolled, [{ block: 'center' }])
    assert.equal(focusedKey(page), 'line-12')
  })
})

test('the filters the log had when the run link was pressed are still set when the link back shows the log again, and the line is found under them', async () => {
  await withPages(async (page) => {
    const { panelRoot, drawerRoot, panel } = page
    panel.open()
    await settle()
    const byPr = panelRoot.querySelector('#auto-log-pr')
    assert.ok(byPr !== null)
    byPr.value = '106'
    byPr.dispatch('change')
    press(linkOf(panelRoot, 41))
    await settle()
    backOf(drawerRoot)?.dispatch('click')
    await settle()
    assert.equal(panelRoot.querySelector('#auto-log-pr')?.value, '106')
    assert.equal(panelRoot.querySelectorAll('li.auto-log-line').length, 3)
    assert.equal(page.document.getElementById('auto-log-entry-12')?.scrolled.length, 1)
  })
})

test('a line that is gone by the time the link back shows the log leaves the log at the top, with nothing said and nothing focused on a line', async () => {
  let pruned = false
  await withPages(async (page) => {
    const { panelRoot, drawerRoot, panel } = page
    panel.open()
    await settle()
    press(linkOf(panelRoot, 41))
    await settle()
    pruned = true
    backOf(drawerRoot)?.dispatch('click')
    await settle()
    assert.equal(panelRoot.hidden, false)
    assert.equal(page.document.getElementById('auto-log-entry-12'), null)
    assert.ok(page.document.getElementById('auto-log-entry-13') !== null)
    assert.equal(page.document.getElementById('auto-log-entry-13')?.scrolled.length, 0)
    assert.equal(panelRoot.querySelector('[role="alert"]'), null)
    assert.doesNotMatch(panelRoot.textContent, /could not|gone|pruned|missing|no longer/i)
    assert.equal(page.document.activeElement?.getAttribute('id'), 'auto-log-heading')
  }, { log: () => answer(200, { days: 14, entries: entries().filter((entry) => !pruned || entry.id !== 12) }) })
})

test('a line that a filter hides when the log is shown again leaves the log at the top, with the filter kept and nothing said', async () => {
  let finished = false
  await withPages(async (page) => {
    const { panelRoot, drawerRoot, panel } = page
    panel.open()
    await settle()
    const byDecision = panelRoot.querySelector('#auto-log-decision')
    assert.ok(byDecision !== null)
    byDecision.value = 'failed'
    byDecision.dispatch('change')
    press(linkOf(panelRoot, 41))
    await settle()
    // the line has since become a finished one, which the failed filter hides
    finished = true
    backOf(drawerRoot)?.dispatch('click')
    await settle()
    assert.equal(panelRoot.querySelector('#auto-log-decision')?.value, 'failed')
    assert.equal(page.document.getElementById('auto-log-entry-12'), null)
    assert.equal(panelRoot.querySelectorAll('li.auto-log-line').length > 0, true)
    assert.equal(panelRoot.querySelector('[role="alert"]'), null)
    assert.equal(page.document.activeElement?.getAttribute('id'), 'auto-log-heading')
  }, { log: () => answer(200, { days: 14, entries: entries().map((entry) => finished && entry.id === 12 ? { ...entry, decision: 'finished' as const } : entry) }) })
})

test('a repaint of the log after the link back keeps the line\'s anchor, the focus on its run link, and the scroll where it was', async () => {
  await withPages(async (page) => {
    const { panelRoot, drawerRoot, panel } = page
    panel.open()
    await settle()
    press(linkOf(panelRoot, 41))
    await settle()
    backOf(drawerRoot)?.dispatch('click')
    await settle()
    const before = page.document.getElementById('auto-log-entry-12')
    assert.ok(before !== null)
    page.bump()
    panel.update()
    await settle()
    panel.update()
    const after = page.document.getElementById('auto-log-entry-12')
    assert.ok(after !== null)
    // the line was drawn again under the same id, and the repaint did not scroll or move focus
    assert.equal(after.scrolled.length, 0)
    assert.equal(focusedKey(page), 'line-12')
    assert.equal(panelRoot.querySelectorAll('#auto-log-entry-12').length, 1)
    assert.equal(drawerRoot.hidden, true)
  })
})

test('a drawer opened any other way shows no link back, and neither does one reopened on the same PR after the log\'s', async () => {
  await withPages(async (page) => {
    const { panelRoot, drawerRoot, panel, drawer } = page
    drawer.open(106, { key: 'auto-review-button', number: 106 })
    await settle()
    assert.equal(backOf(drawerRoot), null)
    drawer.close()
    panel.open()
    await settle()
    press(linkOf(panelRoot, 41))
    await settle()
    assert.ok(backOf(drawerRoot) !== null)
    // the same PR opened by its Agent button: the drawer is not the log's any more
    drawer.open(106, { key: 'auto-review-button', number: 106 })
    await settle()
    assert.equal(backOf(drawerRoot), null)
    // and a drawer closed and opened again after a trip back has none either
    drawer.close()
    drawer.open(106, { key: 'auto-review-button', number: 106 })
    await settle()
    assert.equal(backOf(drawerRoot), null)
  })
})

test('Escape and Close still close a drawer opened from the log and return focus to the header\'s Auto-review button, the link back being an extra way and not the only one', async () => {
  await withPages(async (page) => {
    const { panelRoot, drawerRoot, panel, drawer, header } = page
    panel.open()
    await settle()
    press(linkOf(panelRoot, 41))
    await settle()
    assert.equal(drawer.escape(), true)
    assert.equal(drawer.isOpen(), false)
    assert.equal(drawerRoot.hidden, true)
    assert.equal(page.document.activeElement, header)
    // the close button does the same, and the log is not shown by either
    panel.open()
    await settle()
    press(linkOf(panelRoot, 41))
    await settle()
    drawerRoot.querySelector('.drawer-close')?.dispatch('click')
    assert.equal(drawer.isOpen(), false)
    assert.equal(panelRoot.hidden, true)
  })
})
