// test/ui-copyreport.test.ts
// the Copy report button (section 8 of DESIGN.md, Report panel): in the report panel's bar only, with none on the Agent drawer's rows of Reports on disk or its result card, driven through the real public/drawer.ts and public/reportpanel.ts on the fake document in test/fake-dom.ts. The fixture report holds Markdown, tabs, a trailing newline, and non-ASCII characters, and every expected value is a literal written out here
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { OpenRow } from '../src/derive.ts'
import type { AgentCell } from '../public/agent.ts'
import { createDrawer } from '../public/drawer.ts'
import { createReportPanel } from '../public/reportpanel.ts'
import { installFakeBrowser, press } from './fake-dom.ts'
import type { FakeElement } from './fake-dom.ts'

const repo = 'octo-example/orbit'
const head = '755b78b2c4e1f0a9d3b6e8c7a5f4d2e1b0c9a8f7'

// Markdown, a tab, a trailing newline, and non-ASCII characters: what the button must hand to the clipboard unchanged
const raw = '# Review of #101\n\n- naïve café — “quoted” ✓ 日本語\n\tindented with a tab\n\n```ts\nconst a = 1 // <b>not html</b>\n```\n'

type Sent = { url: string, method: string }

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const cellOf = (): AgentCell => ({
  state: 'done',
  label: 'Review',
  action: { kind: 'reReview', label: 'Re-review', command: 'review-pr', args: ['101'], runner: 'claude' },
  starts: [],
  models: { claude: 'Sonnet', codex: 'Codex default' },
  lastReviewAt: null,
  runId: 7, runner: 'claude', command: 'review-pr', args: ['101'], status: 'done', startedAt: '2026-10-28T14:00:00Z', lastStepAt: null, step: null,
  steps: [], tandem: false, commit: head, extraInstructions: null, origin: 'manual', queuedAt: null, posted: false,
  finishedAt: '2026-10-28T14:05:00Z', text: 'Clean', result: { kind: 'review', verdict: 'clean', recommendation: null, findings: 0, ci: 'green', posted: null, notPostedReason: 'postBlocked', report: '~/agents/output/PR-101.md' },
  question: null, note: null, firstNote: null, resolvedByHand: false, resume: null, costUsd: null, postOffer: null, storedOffer: null, stackRun: null,
} as unknown as AgentCell)

const rowOf = (): OpenRow => ({
  number: 101,
  url: 'https://example.test/octo-example/orbit/pull/101',
  title: 'fix(retry): back off between attempts',
  author: { login: 'alex-mendez', alias: 'Alex' },
  headRef: 'fix/retry', baseRef: 'main', headOid: head, headSha: head,
  agent: cellOf(),
} as unknown as OpenRow)

const listing = [
  { name: 'PR-101.md', kind: 'review', modifiedAt: '2026-10-28T14:05:00Z', sha: '755b78b', verdict: null, tandem: false },
  { name: 'FIX-101.md', kind: 'fix', modifiedAt: '2026-10-28T14:30:00Z', sha: null, verdict: null, tandem: false },
]

const fixCellOf = (): AgentCell => ({
  ...cellOf(),
  command: 'fix-pr',
  result: {
    kind: 'fix', requests: 1, triage: { needsJudgment: 0, noChange: 0, disagree: 0, outOfScope: 0, clear: 1 }, outcomes: { fixed: 1, notFixed: 0, awaitingAnswer: 0 },
    pushed: null, notPushedReason: 'nothing to push', checks: [], worktree: null, report: '~/agents/output/FIX-101.md',
  },
} as unknown as AgentCell)

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

type Clipboard = { written: string[], refuse: boolean }

// the clipboard is the browser's: navigator.clipboard.writeText, then the textarea and execCommand where it is refused
const installClipboard = (clipboard: Clipboard, document: { execCommand?: (command: string) => boolean }): () => void => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: (text: string) => clipboard.refuse ? Promise.reject(new Error('refused')) : Promise.resolve(void clipboard.written.push(text)) } },
  })
  document.execCommand = (command: string) => command === 'copy' && !clipboard.refuse
  return () => {
    if (before === undefined) delete (globalThis as Record<string, unknown>).navigator
    else Object.defineProperty(globalThis, 'navigator', before)
  }
}

// setTimeout is recorded and never fires on its own, so the two-second revert runs only when a test runs it and nothing outlives the fake page
type Timer = { run: () => void, ms: number, cleared: boolean }

const recordTimers = (): { timers: Timer[], restore: () => void } => {
  const timers: Timer[] = []
  const before = globalThis.setTimeout
  const beforeClear = globalThis.clearTimeout
  // a cleared timer never fires: running it does nothing, as the real one would not have
  globalThis.setTimeout = ((run: () => void, ms: number) => {
    const timer: Timer = { run: () => { if (!timer.cleared) run() }, ms, cleared: false }
    timers.push(timer)
    return timers.length
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => { const timer = timers[id - 1]; if (timer !== undefined) timer.cleared = true }) as unknown as typeof clearTimeout
  return { timers, restore: () => { globalThis.setTimeout = before; globalThis.clearTimeout = beforeClear } }
}

// the drawer, with the run's cell as the test says; every request is recorded
const withDrawer = async (cell: () => AgentCell, check: (page: { root: FakeElement, sent: Sent[] }) => Promise<void>): Promise<void> => {
  const sent: Sent[] = []
  const fake = installFakeBrowser((async (input: string, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method ?? 'GET' })
    const url = String(input)
    if (url.endsWith('/reports')) return json(200, listing)
    return json(200, [])
  }) as typeof fetch)
  try {
    const root = fake.document.createElement('aside')
    fake.document.body.appendChild(root)
    const drawer = createDrawer({
      root: root as unknown as HTMLElement,
      token: 'token-1',
      nowMs: () => Date.parse('2026-10-28T15:00:00Z'),
      rowOf: (number) => number === 101 ? { ...rowOf(), agent: cell() } : undefined,
      repo: () => repo,
      viewer: () => 'viewer',
      say: () => undefined,
      reports: { open: () => undefined, close: () => undefined, isOpen: () => false, refresh: () => undefined },
      sweepLink: () => null,
      openSweep: () => undefined,
    })
    drawer.open(101, { key: 'agent:101', number: 101 }, 'default')
    await settle()
    await settle()
    await check({ root, sent })
  } finally {
    fake.restore()
  }
}

const served = (): Response => json(200, { name: 'PR-101.md', modifiedAt: '2026-10-28T14:05:00Z', html: '<h1>x</h1>', raw })

const copyIn = (root: FakeElement): FakeElement[] => root.querySelectorAll('button').filter((button) => button.getAttribute('aria-label') === 'Copy report' || (button.getAttribute('data-focus-key') ?? '').startsWith('copy-'))

test('the Agent drawer carries no Copy report button: not on any row of Reports on disk, not on the result card, and not on a fix session\'s result', async () => {
  for (const cell of [cellOf, fixCellOf]) {
    await withDrawer(cell, async (page) => {
      // Open stays: one on each of the two listed reports, and Open report on the result card
      assert.equal(page.root.querySelectorAll('button').filter((button) => button.textContent === 'Open').length, 2)
      assert.equal(page.root.querySelectorAll('button').filter((button) => button.textContent === 'Open report').length, 1)
      assert.deepEqual(copyIn(page.root).map((button) => button.getAttribute('data-focus-key')), [])
      assert.equal(page.root.querySelectorAll('svg').filter((icon) => icon.querySelectorAll('rect').length === 2).length, 0, 'no two-square glyph anywhere in the drawer')
    })
  }
})

test('on the result card Open report stands alone, as before: no row of actions around it', async () => {
  await withDrawer(cellOf, async (page) => {
    const open = page.root.querySelectorAll('button').find((button) => button.textContent === 'Open report')
    assert.ok(open !== undefined)
    assert.doesNotMatch((open.parentNode as FakeElement).getAttribute('class') ?? '', /drawer-report-actions/)
  })
})

// the report panel: the one place the button lives; it reads the report through the route Open uses
const withPanel = async (answer: () => Response, check: (page: { buttons: () => FakeElement[], open: () => Promise<void>, said: string[], clipboard: Clipboard, sent: Sent[], timers: Timer[] }) => Promise<void>): Promise<void> => {
  const said: string[] = []
  const clipboard: Clipboard = { written: [], refuse: false }
  const sent: Sent[] = []
  const fake = installFakeBrowser((async (input: string, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method ?? 'GET' })
    return answer()
  }) as typeof fetch)
  const restoreClipboard = installClipboard(clipboard, fake.document as unknown as { execCommand?: (command: string) => boolean })
  const recorded = recordTimers()
  const observer = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver')
  Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: class { observe(): void {} } })
  // the rendered view reads the page's theme from computed styles, which the fake page has none of
  const computed = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle')
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ colorScheme: 'light dark', color: 'rgb(0, 0, 0)', getPropertyValue: () => 'sans-serif' }) })
  try {
    const root = fake.document.createElement('aside')
    fake.document.body.appendChild(root)
    // the page ships the panel hidden
    root.hidden = true
    const panel = createReportPanel({ root: root as unknown as HTMLElement, nowMs: () => Date.parse('2026-10-28T15:00:00Z'), onClosed: () => undefined, say: (text) => said.push(text) })
    const buttons = (): FakeElement[] => root.querySelectorAll('button').filter((button) => button.getAttribute('aria-label') === 'Copy report')
    await check({
      buttons,
      open: async () => { panel.open('PR-101.md', null); await settle(); await settle() },
      said, clipboard, sent, timers: recorded.timers,
    })
  } finally {
    recorded.restore()
    if (observer === undefined) delete (globalThis as Record<string, unknown>).MutationObserver
    else Object.defineProperty(globalThis, 'MutationObserver', observer)
    if (computed === undefined) delete (globalThis as Record<string, unknown>).getComputedStyle
    else Object.defineProperty(globalThis, 'getComputedStyle', computed)
    restoreClipboard()
    fake.restore()
  }
}

test('the report panel carries a Copy report icon button once the report has loaded, with no text label, and it copies the same bytes', async () => {
  await withPanel(served, async (page) => {
    assert.equal(page.buttons().length, 0, 'nothing to copy before it opens')
    await page.open()
    assert.equal(page.buttons().length, 1)
    const button = page.buttons()[0] as FakeElement
    assert.equal(button.getAttribute('title'), 'Copy report')
    assert.equal(button.textContent, '')
    assert.equal(button.getAttribute('data-focus-key'), 'copy-panel-report')
    const icon = button.querySelector('svg')
    assert.ok(icon !== null, 'an inline svg glyph')
    assert.equal(icon.getAttribute('stroke'), 'currentColor')
    assert.equal(icon.getAttribute('aria-hidden'), 'true')
    assert.equal(icon.querySelectorAll('rect').length, 2, 'two overlapping squares')
    page.sent.length = 0
    press(button)
    await settle()
    await settle()
    // Markdown, a tab, a trailing newline, and non-ASCII characters, byte for byte
    assert.deepEqual(page.clipboard.written, [raw])
    assert.ok(page.clipboard.written[0]?.endsWith('\n'))
    assert.ok(page.clipboard.written[0]?.includes('\tindented with a tab'))
    assert.deepEqual(page.said, ['Report copied'])
    // the one read it made is the one Open makes, and a GET: no write, no GitHub call
    assert.deepEqual(page.sent, [{ url: '/api/reports/PR-101.md', method: 'GET' }])
    assert.equal(button.getAttribute('data-copied'), 'true')
    assert.equal(button.querySelectorAll('path').length >= 1 && button.querySelectorAll('rect').length === 0, true, 'a check mark replaces the squares')
    assert.equal(button.getAttribute('aria-label'), 'Copy report')
  })
})

test('the check mark returns to the two squares after about two seconds', async () => {
  await withPanel(served, async (page) => {
    await page.open()
    const button = page.buttons()[0] as FakeElement
    press(button)
    await settle()
    await settle()
    const revert = page.timers.find((timer) => timer.ms === 2_000)
    assert.ok(revert !== undefined, 'a 2000 ms timer')
    revert.run()
    assert.equal(button.getAttribute('data-copied'), null)
    assert.equal(button.querySelectorAll('rect').length, 2)
  })
})

test('a refused clipboard falls back to the helper\'s selected textarea; when that fails too nothing is claimed and the refusal is announced', async () => {
  await withPanel(served, async (page) => {
    await page.open()
    const button = page.buttons()[0] as FakeElement
    // the clipboard refuses, the copy command works: the textarea held the exact text
    page.clipboard.refuse = true
    let held = ''
    const document = globalThis.document as unknown as { execCommand: (command: string) => boolean, body: FakeElement }
    document.execCommand = () => {
      held = document.body.querySelectorAll('textarea')[0]?.value ?? ''
      return true
    }
    press(button)
    await settle()
    await settle()
    assert.equal(held, raw)
    assert.deepEqual(page.said, ['Report copied'])
    page.timers.find((timer) => timer.ms === 2_000)?.run()
    // both refused
    document.execCommand = () => false
    page.said.length = 0
    press(button)
    await settle()
    await settle()
    assert.equal(page.said.length, 1)
    assert.match(page.said[0] ?? '', /^Could not copy PR-101\.md/)
    assert.equal(button.getAttribute('data-copied'), null)
  })
})

test('a report that cannot be read when the button is clicked copies nothing and says why', async () => {
  for (const [status, message, expected] of [
    [404, 'no report named PR-101.md', 'PR-101.md is no longer in the reports folder.'],
    [413, 'PR-101.md is larger than 512 KB', 'PR-101.md is too large to show here.'],
    [400, 'a report is named like PR-101.md or FIX-101.md', 'Could not open PR-101.md: a report is named like PR-101.md or FIX-101.md'],
  ] as const) {
    let answer = served
    await withPanel(() => answer(), async (page) => {
      await page.open()
      answer = () => json(status, { error: message })
      press(page.buttons()[0] as FakeElement)
      await settle()
      await settle()
      assert.deepEqual(page.clipboard.written, [])
      assert.deepEqual(page.said, [`Could not copy: ${expected}`])
      assert.equal(page.buttons()[0]?.getAttribute('data-copied'), null)
    })
  }
  // Pit View did not answer
  let answer = served
  await withPanel(() => answer(), async (page) => {
    await page.open()
    answer = () => { throw new Error('offline') }
    press(page.buttons()[0] as FakeElement)
    await settle()
    await settle()
    assert.deepEqual(page.clipboard.written, [])
    assert.deepEqual(page.said, ['Could not copy: Could not open PR-101.md: Pit View did not answer.'])
  })
})

// a report that changed since it was shown is not copied: the panel holds the text it loaded and compares the fresh read's raw with it
const changedReason = 'Could not copy PR-101.md: it changed since it was shown. Open it again to see the current text.'
const rewritten = (): Response => json(200, { name: 'PR-101.md', modifiedAt: '2026-10-28T14:06:00Z', html: '<h1>y</h1>', raw: `${raw}one more line\n` })

test('the report panel copies nothing when the report on disk differs from the text it loaded, and says it changed', async () => {
  let now = served
  await withPanel(() => now(), async (page) => {
    await page.open()
    now = rewritten
    press(page.buttons()[0] as FakeElement)
    await settle()
    await settle()
    assert.deepEqual(page.clipboard.written, [])
    assert.deepEqual(page.said, [changedReason])
    assert.equal(page.buttons()[0]?.getAttribute('data-copied'), null)
    assert.equal(page.timers.length, 0)
  })
})

test('two successful copies in a row leave one live revert timer, and the second check mark keeps its own two seconds', async () => {
  await withPanel(served, async (page) => {
    await page.open()
    const button = page.buttons()[0] as FakeElement
    press(button)
    await settle()
    await settle()
    press(button)
    await settle()
    await settle()
    const live = page.timers.filter((timer) => !timer.cleared)
    assert.equal(page.timers.length, 2)
    assert.equal(live.length, 1, 'the first click\'s timer was cleared')
    // the first timer firing late (were it live) must not end the second check mark
    page.timers[0]?.run()
    assert.equal(button.getAttribute('data-copied'), 'true')
    assert.equal(button.querySelectorAll('rect').length, 0)
    live[0]?.run()
    assert.equal(button.getAttribute('data-copied'), null)
    assert.equal(button.querySelectorAll('rect').length, 2)
  })
})

// the button's size is the stylesheet's: equal width and height, never smaller than Open's height
const sizeOf = (rule: string, property: 'width' | 'height', small: string): number | null => {
  const value = new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`).exec(rule)?.[1]?.trim()
  if (value === undefined) return null
  if (value === 'var(--small-height)') return Number(/--small-height:\s*(\d+)px/.exec(small)?.[1])
  const px = /^(\d+)px$/.exec(value)?.[1]
  return px === undefined ? null : Number(px)
}

test('the stylesheet makes the button square, never smaller than Open, in the theme\'s color with a focus ring', async () => {
  const css = await readFile(join(import.meta.dirname, '..', 'public', 'styles.css'), 'utf8')
  const rule = /\.copy-report\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  assert.match(rule, /color:\s*var\(--ink\)|color:\s*inherit/)
  assert.match(css, /\.copy-report:focus-visible\s*\{[^}]*outline/)
  assert.ok(!/\.copy-report[^{]*\{[^}]*#[0-9a-f]{3,6}/i.test(css), 'no hard-coded color')
  // Open (the row's and the result card's) is a .button-small, 28px high
  const small = /\.button-small\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  assert.match(small, /height:\s*var\(--small-height\)/)
  const openHeight = sizeOf(small, 'height', small)
  assert.equal(openHeight, 28)
  const width = sizeOf(rule, 'width', small)
  const height = sizeOf(rule, 'height', small)
  assert.ok(width !== null && height !== null, 'the rule sets both a width and a height')
  assert.equal(width, height, 'square')
  assert.ok(height >= openHeight, 'never smaller than Open\'s height')
  // the square needs no side padding of its own, and nothing is computed from Open's label any more
  assert.match(rule, /padding:\s*0\s*;/)
  assert.ok(!/min-width/.test(rule) && !/--open-label/.test(css), 'no min-width and no widest-label allowance')
})
