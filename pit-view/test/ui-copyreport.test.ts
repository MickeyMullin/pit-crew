// test/ui-copyreport.test.ts
// the Copy report button (section 8 of DESIGN.md, Agent drawer): on each row of Reports on disk, on the result card beside Open report, and in the report panel's bar, driven through the real public/drawer.ts and public/reportpanel.ts on the fake document in test/fake-dom.ts. The fixture report holds Markdown, tabs, a trailing newline, and non-ASCII characters, and every expected value is a literal written out here
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
type Timer = { run: () => void, ms: number }

const recordTimers = (): { timers: Timer[], restore: () => void } => {
  const timers: Timer[] = []
  const before = globalThis.setTimeout
  globalThis.setTimeout = ((run: () => void, ms: number) => { timers.push({ run, ms }); return 0 }) as unknown as typeof setTimeout
  return { timers, restore: () => { globalThis.setTimeout = before } }
}

type Page = {
  root: FakeElement
  timers: Timer[]
  sent: Sent[]
  said: string[]
  clipboard: Clipboard
  copyButtons: () => FakeElement[]
  opened: string[]
}

// a report's answer is whatever the test says; the listing and the runs are fixed
const withDrawer = async (reportAnswer: () => Response, check: (page: Page) => Promise<void>): Promise<void> => {
  const sent: Sent[] = []
  const said: string[] = []
  const opened: string[] = []
  const clipboard: Clipboard = { written: [], refuse: false }
  const recorded = recordTimers()
  const fake = installFakeBrowser((async (input: string, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method ?? 'GET' })
    const url = String(input)
    if (url.startsWith('/api/reports/')) return reportAnswer()
    if (url.endsWith('/reports')) return json(200, listing)
    return json(200, [])
  }) as typeof fetch)
  const restoreClipboard = installClipboard(clipboard, fake.document as unknown as { execCommand?: (command: string) => boolean })
  try {
    const root = fake.document.createElement('aside')
    fake.document.body.appendChild(root)
    const drawer = createDrawer({
      root: root as unknown as HTMLElement,
      token: 'token-1',
      nowMs: () => Date.parse('2026-10-28T15:00:00Z'),
      rowOf: (number) => number === 101 ? rowOf() : undefined,
      repo: () => repo,
      viewer: () => 'viewer',
      say: (text) => said.push(text),
      reports: { open: (name) => { opened.push(name) }, close: () => undefined, isOpen: () => false, refresh: () => undefined },
      sweepLink: () => null,
      openSweep: () => undefined,
    })
    drawer.open(101, { key: 'agent:101', number: 101 }, 'default')
    await settle()
    await settle()
    sent.length = 0
    await check({ root, timers: recorded.timers, sent, said, clipboard, opened, copyButtons: () => root.querySelectorAll('button').filter((button) => button.getAttribute('aria-label') === 'Copy report') })
  } finally {
    recorded.restore()
    restoreClipboard()
    fake.restore()
  }
}

const served = (): Response => json(200, { name: 'PR-101.md', modifiedAt: '2026-10-28T14:05:00Z', html: '<h1>x</h1>', raw })

test('each row of Reports on disk and the result card carry a Copy report icon button with no text label', async () => {
  await withDrawer(served, async (page) => {
    const buttons = page.copyButtons()
    // PR-101.md and FIX-101.md in the list, and the result card's report
    assert.equal(buttons.length, 3)
    for (const button of buttons) {
      assert.equal(button.getAttribute('title'), 'Copy report')
      assert.equal(button.textContent, '')
      const icon = button.querySelector('svg')
      assert.ok(icon !== null, 'an inline svg glyph')
      assert.equal(icon.getAttribute('stroke'), 'currentColor')
      assert.equal(icon.getAttribute('aria-hidden'), 'true')
      assert.equal(icon.querySelectorAll('rect').length, 2, 'two overlapping squares')
    }
    // each row's Open button is still there, beside its Copy button
    assert.equal(page.root.querySelectorAll('button').filter((button) => button.textContent === 'Open').length, 2)
  })
})

test('a click copies the report\'s raw Markdown byte for byte, switches to a check mark for two seconds, and says "Report copied"', async () => {
  await withDrawer(served, async (page) => {
    const [first] = page.copyButtons()
    assert.ok(first !== undefined)
    press(first)
    await settle()
    await settle()
    assert.deepEqual(page.clipboard.written, [raw])
    assert.ok(page.clipboard.written[0]?.endsWith('\n'))
    assert.ok(page.clipboard.written[0]?.includes('\tindented with a tab'))
    assert.deepEqual(page.said, ['Report copied'])
    // the one read it made is the one Open makes, and a GET
    assert.deepEqual(page.sent, [{ url: '/api/reports/PR-101.md', method: 'GET' }])
    assert.equal(first.getAttribute('data-copied'), 'true')
    assert.equal(first.querySelectorAll('path').length >= 1 && first.querySelectorAll('rect').length === 0, true, 'a check mark replaces the squares')
    assert.equal(first.getAttribute('aria-label'), 'Copy report')
  })
})

test('the check mark returns to the two squares after about two seconds', async () => {
  await withDrawer(served, async (page) => {
    const [first] = page.copyButtons()
    assert.ok(first !== undefined)
    press(first)
    await settle()
    await settle()
    const revert = page.timers.find((timer) => timer.ms === 2_000)
    assert.ok(revert !== undefined, 'a 2000 ms timer')
    revert.run()
    assert.equal(first.getAttribute('data-copied'), null)
    assert.equal(first.querySelectorAll('rect').length, 2)
  })
})

test('a refused clipboard falls back to the helper\'s selected textarea; when that fails too nothing is claimed and the text is offered', async () => {
  await withDrawer(served, async (page) => {
    const [first] = page.copyButtons()
    assert.ok(first !== undefined)
    // the clipboard refuses, the copy command works: the textarea held the exact text
    page.clipboard.refuse = true
    let held = ''
    const document = globalThis.document as unknown as { execCommand: (command: string) => boolean, body: FakeElement }
    document.execCommand = () => {
      held = document.body.querySelectorAll('textarea')[0]?.value ?? ''
      return true
    }
    press(first)
    await settle()
    await settle()
    assert.equal(held, raw)
    assert.deepEqual(page.said, ['Report copied'])
    page.timers.find((timer) => timer.ms === 2_000)?.run()
    // both refused
    document.execCommand = () => false
    page.said.length = 0
    press(first)
    await settle()
    await settle()
    assert.equal(page.said.length, 1)
    assert.match(page.said[0] ?? '', /^Could not copy PR-101\.md/)
    assert.equal(first.getAttribute('data-copied'), null)
  })
})

test('a report that cannot be read copies nothing and says why', async () => {
  for (const [status, message, expected] of [
    [404, 'no report named PR-101.md', 'PR-101.md is no longer in the reports folder.'],
    [413, 'PR-101.md is larger than 512 KB', 'PR-101.md is too large to show here.'],
    [400, 'a report is named like PR-101.md or FIX-101.md', 'Could not open PR-101.md: a report is named like PR-101.md or FIX-101.md'],
  ] as const) {
    await withDrawer(() => json(status, { error: message }), async (page) => {
      const [first] = page.copyButtons()
      assert.ok(first !== undefined)
      press(first)
      await settle()
      await settle()
      assert.deepEqual(page.clipboard.written, [])
      assert.deepEqual(page.said, [`Could not copy: ${expected}`])
      assert.equal(first.getAttribute('data-copied'), null)
    })
  }
  // Pit View did not answer
  await withDrawer(() => { throw new Error('offline') }, async (page) => {
    const [first] = page.copyButtons()
    assert.ok(first !== undefined)
    press(first)
    await settle()
    await settle()
    assert.deepEqual(page.clipboard.written, [])
    assert.deepEqual(page.said, ['Could not copy: Could not open PR-101.md: Pit View did not answer.'])
  })
})

test('copying makes no write and no GitHub call, and does not open the report panel', async () => {
  await withDrawer(served, async (page) => {
    for (const button of page.copyButtons()) {
      press(button)
      await settle()
      await settle()
    }
    assert.ok(page.sent.length > 0)
    assert.ok(page.sent.every((request) => request.method === 'GET' && request.url.startsWith('/api/reports/')), JSON.stringify(page.sent))
    assert.deepEqual(page.opened, [])
  })
})

// the panel: its own button, which reads the report the same way
test('the report panel carries a Copy report button once the report has loaded, and it copies the same bytes', async () => {
  const said: string[] = []
  const clipboard: Clipboard = { written: [], refuse: false }
  const sent: Sent[] = []
  const fake = installFakeBrowser((async (input: string, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method ?? 'GET' })
    return served()
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
    panel.open('PR-101.md', null)
    assert.equal(buttons().length, 0, 'nothing to copy while it loads')
    await settle()
    await settle()
    assert.equal(buttons().length, 1)
    sent.length = 0
    press(buttons()[0] as FakeElement)
    await settle()
    await settle()
    assert.deepEqual(clipboard.written, [raw])
    assert.deepEqual(said, ['Report copied'])
    assert.deepEqual(sent, [{ url: '/api/reports/PR-101.md', method: 'GET' }])
  } finally {
    recorded.restore()
    if (observer === undefined) delete (globalThis as Record<string, unknown>).MutationObserver
    else Object.defineProperty(globalThis, 'MutationObserver', observer)
    if (computed === undefined) delete (globalThis as Record<string, unknown>).getComputedStyle
    else Object.defineProperty(globalThis, 'getComputedStyle', computed)
    restoreClipboard()
    fake.restore()
  }
})

test('the stylesheet gives the button the theme\'s color, a hit area as large as Open\'s, and a focus ring', async () => {
  const css = await readFile(join(import.meta.dirname, '..', 'public', 'styles.css'), 'utf8')
  const rule = /\.copy-report\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  assert.match(rule, /color:\s*var\(--ink\)|color:\s*inherit/)
  const min = /min-width:\s*(\d+)px/.exec(rule)?.[1]
  assert.ok(min !== undefined && Number(min) >= 36, 'at least as wide as the Open button')
  // the button is a .button-small, 28px tall like Open
  assert.match(css, /\.button-small\s*\{[^}]*height:\s*28px/)
  assert.match(css, /\.copy-report:focus-visible\s*\{[^}]*outline/)
  assert.ok(!/\.copy-report[^{]*\{[^}]*#[0-9a-f]{3,6}/i.test(css), 'no hard-coded color')
})
