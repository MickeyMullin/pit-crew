// test/ui-autoreview-log-panel.test.ts
// the auto-review log panel, the real public/autoreviewlog.ts against the fake document in test/fake-dom.ts: it reads the log when it opens, its heading takes focus, its three filters are labeled selects, a run link closes it and opens that run's drawer, a closed PR's run opens it too, a repaint keeps focus on the same control, a line shows its model, the empty and failed states, Escape and Close put focus back on the header button, and a change in the scheduler's state reads the log again. The Settings page's line names the days the config keeps, and the page's markup and wiring, the documents' default days, and the panel's styles are read from the sources. Every fixture is invented, and every expected string is written out here
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { LogEntry } from '../src/autoreviewlog.ts'
import type { View } from '../src/poller.ts'
import { createAutoReviewLogPanel } from '../public/autoreviewlog.ts'
import type { LogRunLink } from '../public/autoreviewlogview.ts'
import { setTimeFormat } from '../public/format.ts'
import { installFakeBrowser, press } from './fake-dom.ts'
import type { FakeElement } from './fake-dom.ts'

setTimeFormat('12h')

const answer = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

const now = Date.parse('2026-11-02T15:00:00Z')
let nextId = 50
const entry = (patch: Partial<LogEntry>): LogEntry => {
  nextId -= 1
  return {
    id: nextId, repo: 'octo-example/orbit', lane: 'pr', number: 106, title: 'feat(nav): an invented change', decision: 'queued', reason: 'pushed', note: null,
    head: 'cccc3334444', run: null, model: null, tick: 12, at: '2026-11-02T14:30:00Z', lastAt: '2026-11-02T14:30:00Z', count: 1, ...patch,
  }
}

const entries = (): LogEntry[] => [
  entry({ decision: 'failed', reason: null, note: 'worktreeFailed: git fetch failed', run: { kind: 'run', id: 41 } }),
  entry({ lane: 'tick', number: null, title: null, decision: 'skipped', reason: 'dailyLimit', head: null }),
  entry({ number: 99, title: 'chore: a closed invented PR', decision: 'finished', reason: 'done', note: 'Approved · not posted', run: { kind: 'run', id: 40 } }),
  entry({ lane: 'sweep', number: null, title: null, decision: 'queued', reason: 'dependabot', head: null, run: { kind: 'sweep', id: 7 } }),
]

type Panel = {
  root: FakeElement
  header: FakeElement
  document: ReturnType<typeof installFakeBrowser>['document']
  panel: ReturnType<typeof createAutoReviewLogPanel>
  opened: LogRunLink[]
  reads: () => number
  setView: (autoReview: Record<string, unknown>) => void
}

const withPanel = async (body: { status: number, value: unknown }, check: (page: Panel) => Promise<void>): Promise<void> => {
  let reads = 0
  const fake = installFakeBrowser((async (input: string) => {
    if (String(input) === '/api/auto-review/log') {
      reads += 1
      return answer(body.status, body.value)
    }
    return answer(404, {})
  }) as typeof fetch)
  try {
    const doc = fake.document
    const header = doc.createElement('button')
    header.setAttribute('id', 'auto-review-button')
    const root = doc.createElement('aside')
    root.setAttribute('id', 'auto-log')
    root.hidden = true
    doc.body.append(header, root)
    let view = { autoReview: { state: 'idle', running: 0 } } as unknown as View
    const opened: LogRunLink[] = []
    const panel = createAutoReviewLogPanel({
      root: root as unknown as HTMLElement,
      nowMs: () => now,
      view: () => view,
      isOpen: (number) => number === 106,
      openRun: (link) => opened.push(link),
      returnTo: () => header as unknown as HTMLElement,
    })
    await check({
      root,
      header,
      document: doc,
      panel,
      opened,
      reads: () => reads,
      setView: (autoReview) => {
        view = { autoReview } as unknown as View
      },
    })
  } finally {
    fake.restore()
  }
}

const texts = (root: FakeElement, selector: string): string[] => root.querySelectorAll(selector).map((element) => element.textContent)

test('opening the log reads it, focuses its heading, and lists its lines newest first under three labeled filters', async () => {
  await withPanel({ status: 200, value: { days: 14, entries: entries() } }, async ({ root, document, panel, reads }) => {
    panel.open()
    assert.equal(root.hidden, false)
    assert.equal(document.activeElement?.id, 'auto-log-heading')
    assert.deepEqual(texts(root, '.auto-note'), ['Loading the log…'])
    await settle()
    assert.equal(reads(), 1)
    assert.equal(root.querySelector('#auto-log-summary')?.textContent, 'Kept for 14 days, newest first. 4 lines.')
    assert.deepEqual(texts(root, '.auto-log-text'), ['Failed: worktreeFailed: git fetch failed', 'Skipped: daily limit reached', 'Finished: Approved · not posted', 'Queued: Dependabot sweep'])
    assert.deepEqual(texts(root, '.auto-log-subject'), ['#106', 'Scheduler', '#99', 'Dependabot sweep'])
    // each filter is a select its label names
    for (const [id, label] of [['auto-log-pr', 'PR'], ['auto-log-decision', 'Decision'], ['auto-log-day', 'Day']] as const) {
      assert.equal(root.querySelector(`#${id}`)?.tag, 'select')
      assert.equal(root.querySelector(`label[for="${id}"]`)?.textContent, label)
    }
    assert.deepEqual(texts(root.querySelector('#auto-log-pr') as FakeElement, 'option'), ['All PRs', '#106', '#99', 'Scheduler only', 'Dependabot sweeps'])
    assert.equal(root.querySelector('button[aria-label="Close the auto-review log"]')?.tag, 'button')
  })
})

test('a run link closes the log and opens that run\'s drawer, a closed PR\'s run opens it too, and a sweep opens the sweep drawer', async () => {
  await withPanel({ status: 200, value: { days: 14, entries: entries() } }, async ({ root, panel, opened }) => {
    panel.open()
    await settle()
    const links = root.querySelectorAll('button[data-auto-log-run]')
    assert.deepEqual(links.map((link) => link.getAttribute('aria-label')), ['Open the Agent drawer of #106, run 41', 'Open the Agent drawer of #99, run 40 (the PR is closed)', 'Open the sweep drawer at sweep 7'])
    assert.deepEqual(texts(root, '.auto-log-muted'), [])
    press(links[0] as FakeElement)
    assert.equal(root.hidden, true)
    assert.deepEqual(opened.map((link) => [link.kind, link.id, link.number, link.closed, link.title]), [['run', 41, 106, false, 'feat(nav): an invented change']])
    panel.open()
    await settle()
    press(root.querySelector('button[data-auto-log-run="run-40"]') as FakeElement)
    assert.deepEqual(opened.map((link) => [link.kind, link.id, link.number, link.closed]).slice(1), [['run', 40, 99, true]])
    panel.open()
    await settle()
    press(root.querySelector('button[data-auto-log-run="sweep-7"]') as FakeElement)
    assert.deepEqual(opened.map((link) => [link.kind, link.id, link.number]).slice(2), [['sweep', 7, null]])
  })
})

test('a repaint leaves focus on the control that had it: a line\'s own run link among several lines of one run, Clear filters, and Try again', async () => {
  const lines = [
    entry({ decision: 'finished', reason: 'done', note: 'Approved · not posted', run: { kind: 'run', id: 41 } }),
    entry({ decision: 'started', reason: 'pushed', run: { kind: 'run', id: 41 } }),
    entry({ decision: 'queued', reason: 'pushed', run: { kind: 'run', id: 41 } }),
  ]
  await withPanel({ status: 200, value: { days: 14, entries: lines } }, async ({ root, document, panel }) => {
    panel.open()
    await settle()
    const keys = root.querySelectorAll('button[data-auto-log-run]').map((link) => link.getAttribute('data-auto-log-key'))
    assert.equal(new Set(keys).size, 3, 'each line has a key of its own')
    // the middle line's link, though the first two share its run
    const middle = root.querySelectorAll('button[data-auto-log-run]')[1] as FakeElement
    middle.focus()
    assert.equal(document.activeElement?.getAttribute('data-auto-log-key'), keys[1])
    panel.update()
    assert.equal(document.activeElement?.getAttribute('data-auto-log-key'), keys[1])
    // Clear filters, with a filter on
    const decision = root.querySelector('#auto-log-decision') as FakeElement
    decision.value = 'started'
    decision.dispatch('change')
    const clearButton = [...root.querySelectorAll('button')].find((button) => button.textContent === 'Clear filters') as FakeElement
    clearButton.focus()
    panel.update()
    assert.equal(document.activeElement?.getAttribute('data-auto-log-key'), 'clear')
  })
  await withPanel({ status: 500, value: { error: 'invented failure' } }, async ({ root, document, panel }) => {
    panel.open()
    await settle()
    const retry = [...root.querySelectorAll('button')].find((button) => button.textContent === 'Try again') as FakeElement
    retry.focus()
    panel.update()
    assert.equal(document.activeElement?.getAttribute('data-auto-log-key'), 'retry')
    assert.notEqual(document.activeElement, null)
  })
})

test('a line shows the model that ran the review, and a line without one, or one stored before the log kept models, shows none', async () => {
  const lines = [
    entry({ decision: 'finished', reason: 'done', note: 'Approved · not posted', run: { kind: 'run', id: 41 }, model: 'sonnet (Claude Code)' }),
    entry({ decision: 'finished', reason: 'done', note: 'Clean', run: { kind: 'run', id: 40 }, model: 'primary: sonnet (Claude Code) · secondary: gpt-6.1-terra (Codex)' }),
    entry({ decision: 'skipped', reason: 'alreadyReviewed' }),
    // a line stored before the field existed has no model key at all
    (() => {
      const old = entry({ decision: 'started', reason: 'pushed', run: { kind: 'run', id: 39 } }) as Partial<LogEntry>
      delete old.model
      return old as LogEntry
    })(),
  ]
  await withPanel({ status: 200, value: { days: 14, entries: lines } }, async ({ root, panel }) => {
    panel.open()
    await settle()
    assert.deepEqual(texts(root, '[data-auto-log-model]'), ['Model: sonnet (Claude Code)', 'Model: primary: sonnet (Claude Code) · secondary: gpt-6.1-terra (Codex)'])
    assert.equal(texts(root, '.auto-log-text').length, 4)
    // the filters still work with an entry that has no model
    const decision = root.querySelector('#auto-log-decision') as FakeElement
    decision.value = 'started'
    decision.dispatch('change')
    assert.equal(texts(root, '.auto-log-text').length, 1)
  })
})

test('the filters narrow the lines, mark themselves set, and Clear filters shows every line again', async () => {
  await withPanel({ status: 200, value: { days: 14, entries: entries() } }, async ({ root, panel }) => {
    panel.open()
    await settle()
    const decision = root.querySelector('#auto-log-decision') as FakeElement
    decision.value = 'failed'
    decision.dispatch('change')
    assert.deepEqual(texts(root, '.auto-log-text'), ['Failed: worktreeFailed: git fetch failed'])
    assert.equal(decision.className, 'filter-select filter-set')
    assert.equal(root.querySelector('#auto-log-summary')?.textContent, 'Kept for 14 days, newest first. Showing 1 of 4 lines.')
    const pr = root.querySelector('#auto-log-pr') as FakeElement
    pr.value = 'tick'
    pr.dispatch('change')
    assert.deepEqual(texts(root, '.auto-log-text'), [])
    assert.deepEqual(texts(root, '.auto-note'), ['No lines match these filters.'])
    press([...root.querySelectorAll('button')].find((button) => button.textContent === 'Clear filters') as FakeElement)
    assert.equal(texts(root, '.auto-log-text').length, 4)
    assert.equal(decision.className, 'filter-select')
    const day = root.querySelector('#auto-log-day') as FakeElement
    assert.equal(day.querySelectorAll('option')[0]?.textContent, 'All days')
    day.value = day.querySelectorAll('option')[1]?.getAttribute('value') ?? ''
    day.dispatch('change')
    assert.equal(texts(root, '.auto-log-text').length, 4)
  })
})

test('an empty log says so, and a log that cannot be read says that and offers Try again', async () => {
  await withPanel({ status: 200, value: { days: 30, entries: [] } }, async ({ root, panel }) => {
    panel.open()
    await settle()
    assert.deepEqual(texts(root, '.auto-note'), ['Nothing recorded yet. Each decision the scheduler makes adds a line here.'])
    assert.equal(root.querySelector('#auto-log-summary')?.textContent, 'Kept for 30 days, newest first. No lines.')
  })
  await withPanel({ status: 500, value: { error: 'invented failure' } }, async ({ root, panel, reads }) => {
    panel.open()
    await settle()
    assert.deepEqual(texts(root, '.auto-note'), ['The log could not be loaded.'])
    press([...root.querySelectorAll('button')].find((button) => button.textContent === 'Try again') as FakeElement)
    await settle()
    assert.equal(reads(), 2)
  })
})

test('Escape, the close button, and Close each shut the log and put focus back on the header\'s Auto-review button', async () => {
  await withPanel({ status: 200, value: { days: 14, entries: entries() } }, async ({ root, header, document, panel }) => {
    for (const shut of [
      () => root.dispatch('keydown', { key: 'Escape' }),
      () => press(root.querySelector('button[aria-label="Close the auto-review log"]') as FakeElement),
      () => press(root.querySelector('button[data-auto-log-close]') as FakeElement),
    ]) {
      panel.open()
      await settle()
      assert.equal(panel.isOpen(), true)
      shut()
      assert.equal(root.hidden, true)
      // by id, not the element itself: a failing comparison of two fake elements would make assert print their whole cyclic tree
      assert.equal(document.activeElement?.id, header.getAttribute('id'))
    }
    // another key does nothing
    panel.open()
    root.dispatch('keydown', { key: 'Enter' })
    assert.equal(root.hidden, false)
    await settle()
  })
})

test('a change in the scheduler\'s state reads the log again while it is open, and nothing is read while it is shut', async () => {
  await withPanel({ status: 200, value: { days: 14, entries: entries() } }, async ({ panel, reads, setView }) => {
    panel.update()
    assert.equal(reads(), 0)
    panel.open()
    await settle()
    panel.update()
    await settle()
    assert.equal(reads(), 1)
    setView({ state: 'running', running: 1 })
    panel.update()
    await settle()
    assert.equal(reads(), 2)
    panel.close()
    setView({ state: 'idle', running: 0 })
    panel.update()
    await settle()
    assert.equal(reads(), 2)
  })
})

// the Settings page's line, through the real public/settings.ts

const settingsHtml = readFileSync(new URL('../public/settings.html', import.meta.url), 'utf8')
let imports = 0

const settingsLine = async (stored: Record<string, unknown>): Promise<string> => {
  const fake = installFakeBrowser((async (input: string) => String(input) === '/api/config' ? answer(200, stored) : answer(404, {})) as typeof fetch)
  try {
    fake.document.loadPage(settingsHtml)
    imports += 1
    const target = new URL('../public/settings.ts', import.meta.url)
    target.search = `?log=${imports}`
    await import(target.href)
    await settle()
    return fake.document.getElementById('log-ref')?.textContent ?? ''
  } finally {
    fake.restore()
  }
}

test('the Settings page names the days the log keeps: the config\'s value, or the default when it has none', async () => {
  const config = {
    repo: 'octo-example/orbit', viewer: 'vera-quill', people: [], tickets: [], refreshSeconds: 300, idleMinutes: 120, todayStartsAt: 'local', bots: ['dependabot'],
    reportsDir: '~/agents/output', density: 'comfortable', timeFormat: '12h', showAgentColumn: true, maxConcurrentReviews: 2, selfReviewOverCap: false,
    extraReviewInstructions: '', notifications: { enabled: false, kinds: [] }, allowedHosts: ['pit.example.test'], cloneDir: '~/dev/orbit',
    agent: { runner: 'claude', claudeModel: 'sonnet' },
    autoReview: { enabled: true, intervalMinutes: 15, activeHours: { days: ['mon'], from: '09:00', to: '18:00' }, others: true, own: false, dependabot: false, concurrency: 1, dailyLimit: 10, post: { others: false, dependabot: false } },
  }
  assert.equal(await settingsLine(config), 'The auto-review log keeps what the scheduler decided, and why, for 14 days. Open it with Log in the header\'s Auto-review menu.')
  assert.equal(await settingsLine({ ...config, autoReviewLogDays: 30 }), 'The auto-review log keeps what the scheduler decided, and why, for 30 days. Open it with Log in the header\'s Auto-review menu.')
})

// the page's markup and wiring, read from the sources, since the header menu and app.ts need a real browser

test('the page holds the log as a hidden, labeled panel beside the drawers, and the header button carries the focus key a drawer opened from the log returns to', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  assert.match(html, /<aside id="auto-log" class="drawer auto-log" role="dialog" aria-modal="false" aria-labelledby="auto-log-heading" hidden><\/aside>/)
  assert.match(html, /<button id="auto-review-button" [^>]*data-focus-key="auto-review-button"/)
  const menu = readFileSync(new URL('../public/autoreviewmenu.ts', import.meta.url), 'utf8')
  assert.match(menu, /'data-auto-log': '', 'data-focus-key': 'auto-log'/)
  assert.match(menu, /closest\('button\[data-auto-log\]'\) !== null\) \{\n\s+close\(\)\n\s+onLog\(\)/)
  const app = readFileSync(new URL('../public/app.ts', import.meta.url), 'utf8')
  assert.ok(app.includes('openRun: openLoggedRun({ drawer, sweepDrawer, seedRuns, backToLog: (entryId) => logPanel.restore(entryId) }),'))
  assert.ok(app.includes('logPanel.update()'))
  // the opener returns focus to the same button, whichever drawer it opens
  const opener = readFileSync(new URL('../public/autoreviewlogopen.ts', import.meta.url), 'utf8')
  assert.ok(opener.includes("sweepDrawer.open({ key: 'auto-review-button' }, { sweepId: link.id })"))
  assert.ok(opener.includes("drawer.open(link.number, { key: 'auto-review-button', number: link.number }, undefined, { runId: link.id, title: link.title, back: { anchor: link.anchor, go: () => backToLog(link.entryId) } })"))
})

// the documents and the stylesheet say what the code does, so neither can drift from it unnoticed

test('DESIGN.md, the README, and the Settings line name the default days the server keeps, and the panel\'s classes are styled', async () => {
  const { autoReviewLogDays } = await import('../src/autoreviewlog.ts')
  const { logRetentionLine } = await import('../public/autoreviewlogview.ts')
  const design = readFileSync(new URL('../DESIGN.md', import.meta.url), 'utf8')
  const row = design.split('\n').find((line) => line.startsWith('| `autoReviewLogDays` |')) ?? ''
  assert.equal(row.split(' | ')[2], String(autoReviewLogDays))
  assert.match(design, /^#### The log$/m)
  assert.ok(design.includes(`the log's line, "${logRetentionLine(autoReviewLogDays)}"`), 'the Auto-review card footer quotes the Settings line at the default')
  assert.ok(design.includes(`\`{ "days": ${autoReviewLogDays}, "entries": [...] }\``))
  // the model each line names is stated where the log is: the storage table, the log section, and the README
  assert.ok(design.includes('`run_id`, `model` (the model that ran the review, as text, or null)'))
  assert.ok(design.includes('- **The model.** A line of a scheduled run that started, finished, failed, or stopped names the model that ran the review'))
  assert.ok(design.includes('`model` (text or null), `tick`, `at`, `lastAt`, and `count`'))
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.ok(readme.includes('names the model that ran the review, as in "sonnet (Claude Code)"'))
  assert.ok(readme.includes('the pair only when the record holds both'))
  assert.ok(readme.includes('A queued or skipped line, a drop, and every line of a sweep names none.'))
  assert.ok(readme.includes('"Back to the auto-review log" link'))
  // the link back from a run's drawer is stated where the drawer is described, where the log is, and in the list of what a browser must still check
  assert.ok(design.includes('- **Opened from the auto-review log** (section 10, In the UI, The log)'))
  assert.ok(design.includes('an id made from its entry\'s id, `auto-log-entry-<id>`'))
  assert.ok(design.includes('the drawer\'s "Back to the auto-review log" link is reachable by Tab'))
  assert.ok(design.includes('names the pair only when the record holds both roles'))
  assert.ok(design.includes('the test of the pair sets its record up by hand'))
  assert.ok(readme.includes(`keeps ${autoReviewLogDays} days by default`))
  assert.ok(readme.includes('`autoReviewLogDays` (a whole number from 1 to 365)'))
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8')
  for (const name of ['auto-log-filters', 'auto-log-filter', 'auto-log-body', 'auto-log-list', 'auto-log-line', 'auto-log-meta', 'auto-log-when', 'auto-log-title', 'auto-log-details', 'auto-log-muted']) {
    assert.match(css, new RegExp(`\\.${name}[ ,{]`), `.${name} has a rule`)
  }
})
