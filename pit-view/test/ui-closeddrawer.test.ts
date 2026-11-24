// test/ui-closeddrawer.test.ts
// the read-only drawer on a Closed row (section 8 of DESIGN.md, Drawer, Closed PRs): real Closed rows, derived from the fixture's closed search, drawn by the real table renderer, and clicked and keyed on the fake document in test/fake-dom.ts with the real drawer, its model, and the real row handler. The routes it reads are asked through the real server in test/server.test.ts
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDrawer } from '../public/drawer.ts'
import { closedDrawerRow, closeOnOutsidePress, drawerModel, latestCell } from '../public/drawerview.ts'
import type { Loadable } from '../public/drawerview.ts'
import { formatCached, setTimeFormat } from '../public/format.ts'
import type { RunView } from '../public/agent.ts'
import { mountRowClicks } from '../public/rowclick.ts'
import { createSweepDrawer } from '../public/sweepdrawer.ts'
import { findClosedRow } from '../public/state.ts'
import { renderTable } from '../public/tables.ts'
import { defaultConfig } from '../src/config.ts'
import { deriveClosed, deriveLastReadings, deriveOpenRows } from '../src/derive.ts'
import type { ClosedRow, ClosedView, LastReadings, OpenRow } from '../src/derive.ts'
import { agentCell } from '../src/launcher.ts'
import type { ReportListing } from '../src/reports.ts'
import { scenario } from './fixtures/scenario.ts'
import { installFakeBrowser, press } from './fake-dom.ts'
import type { FakeElement } from './fake-dom.ts'
import { closedSearch, openPage1, reviewResult } from './helpers.ts'
import { closedTable } from './table-model.ts'

setTimeFormat('12h')

const config = { ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit' }
const nowMs = Date.parse(scenario.now)
const context = { config, clock: { now: () => nowMs }, timeZone: scenario.timeZone }
const answer = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

const closedView = async (): Promise<ClosedView> => deriveClosed((await closedSearch()).data.search.nodes, context)

// an open fixture PR's readings stand for what the cache last held of the closed one
const readings = async (): Promise<LastReadings> => {
  const pr = (await openPage1()).data.repository?.pullRequests.nodes.find((each) => each.number === 106)
  assert.ok(pr)
  return deriveLastReadings(pr, '2026-10-26T13:00:00Z', config)
}

const run = (patch: Partial<RunView> = {}): RunView => ({
  id: 41, repo: scenario.repo, number: 97, command: 'review-pr', args: ['97'], label: 'Review', runner: 'claude', cwd: '~/dev/orbit', dir: '~/runs/41', sessionId: null, pid: 4001, pidStartedAt: null,
  startedAt: '2026-10-25T14:00:00Z', lastStepAt: null, step: null, stepState: null, steps: [], tandem: false, finishedAt: '2026-10-25T14:05:00Z', status: 'done', note: null, costUsd: null, resume: 'claude --resume abc',
  resolvedByHand: false, firstNote: null, extraInstructions: null, reportHash: null, postAttemptedAt: null, origin: 'manual', tick: null, reason: null, queuedAt: null, headOid: null, models: null, jumped: false,
  result: reviewResult({ target: { repo: scenario.repo, pr: 97 } }), ...patch,
} as unknown as RunView)

const report = (): ReportListing => ({ name: 'PR-97.md', kind: 'review', modifiedAt: '2026-10-25T14:05:00Z', tandem: false, sha: 'abc1234', verdict: 'changesRequested' }) as unknown as ReportListing

const ready = <T>(items: T[]): Loadable<T> => ({ state: 'ready', items })

const find = (view: ClosedView, number: number): ClosedRow => {
  const row = findClosedRow({ closed: view }, number)
  assert.ok(row)
  return row
}

const modelOf = (row: ClosedRow, { runs = ready<RunView>([]), reports = ready<ReportListing>([]), last = null }: { runs?: Loadable<RunView>, reports?: Loadable<ReportListing>, last?: LastReadings | null } = {}) => {
  const shown = closedDrawerRow(row, last)
  return drawerModel({ row: { ...shown, agent: latestCell(shown.agent, runs) }, open: false, runs, reports, confirm: null, closed: { row, last: { state: 'ready', value: last }, nowMs } })
}

const emptyText = 'This PR has no reports on disk and no run history.'

// ---- the model ----

test('the closed model offers no action whatever the PR has, and says why', async () => {
  const row = find(await closedView(), 97)
  for (const runs of [ready<RunView>([]), ready([run()]), ready([run({ status: 'failed', note: 'noResult', result: null })]), ready([run({ status: 'needsInput' })]), ready([run({ status: 'running', finishedAt: null, result: null })]), ready([run({ origin: 'auto' })])]) {
    const model = modelOf(row, { runs, reports: ready([report()]) })
    assert.deepEqual([model.starts.buttons, model.actions, model.confirm, model.actionAsk, model.gone], [[], [], null, null, null])
    assert.deepEqual([model.stop, model.reread, model.rereadAsk, model.postIt, model.postAsk, model.storedAsk], [null, null, null, null, null, null])
    assert.ok(model.autoRuns.every((each) => each.stored === null))
    assert.ok(['none', 'waiting', 'result'].includes(model.card))
    assert.equal(model.closed?.note, '#97 is closed, so this drawer is read-only.')
  }
})

test('the facts are what the closed search and the cache last held: the state, who and when, the last review, CI, and merge readings, and their time', async () => {
  const view = await closedView()
  const last = await readings()
  const fact = (number: number, held: LastReadings | null) => Object.fromEntries(modelOf(find(view, number), { last: held }).closed?.facts ?? [])
  const merged = fact(97, last)
  assert.deepEqual([merged.State, merged.By, merged.When], ['Merged', 'merged by alex-mendez', formatCached(find(view, 97).closedAt, nowMs)])
  assert.equal(merged.Merge, last.merge.label)
  assert.equal(merged.CI, { green: 'green', pending: 'pending', failed: 'failed', none: 'no checks had run' }[last.ci])
  assert.equal(merged.Review, last.reviewers.map((reviewer) => `${reviewer.alias}: ${{ approved: 'approved', changes: 'changes requested', commented: 'commented', requested: 'review requested' }[reviewer.state]}`).join(', '))
  assert.equal(merged['Last read'], formatCached(last.asOf, nowMs))
  assert.equal(fact(98, last).State, 'Closed unmerged')
  assert.equal(fact(97, { ...last, reviewers: [] }).Review, 'no reviews')
  // nothing held: only what the closed search says, and a plain sentence in place of the rest
  const bare = modelOf(find(view, 97)).closed
  assert.deepEqual(bare?.facts.map(([label]) => label), ['State', 'By', 'When'])
  assert.equal(bare?.lastNote, 'The cache no longer holds this PR\'s last review, CI, and merge readings.')
})

test('the header names the PR, its author, and its branch, with the base and head only when the cache still holds them', async () => {
  const row = find(await closedView(), 97)
  const last = await readings()
  assert.deepEqual(modelOf(row).header, { number: 97, url: row.url, heading: 'Agent for #97', author: 'sam-tran · @sam-tran', title: row.title, refs: 'fix/csv-escaping' })
  assert.equal(modelOf(row, { last }).header.refs, `fix/csv-escaping → ${last.baseRef} · head ${last.headSha.slice(0, 7)}`)
})

test('a closed PR with a report, one with run history only, and one with neither each show what they have', async () => {
  const row = find(await closedView(), 97)
  const withReport = modelOf(row, { reports: ready([report()]) })
  assert.deepEqual([withReport.card, withReport.reports.rows.map((each) => each.name), withReport.closed?.empty, withReport.closed?.noRuns], ['none', ['PR-97.md'], null, 'No run history for this PR.'])
  const withRun = modelOf(row, { runs: ready([run(), run({ id: 40 })]) })
  assert.deepEqual([withRun.card, withRun.result?.text, withRun.runs.rows.map((each) => each.id), withRun.closed?.empty], ['result', 'Changes requested', [40], null])
  assert.equal(modelOf(row).closed?.empty, emptyText)
  // nothing is said to be missing before both lists have been read
  assert.equal(modelOf(row, { runs: { state: 'loading' } }).closed?.empty, null)
  assert.equal(modelOf(row, { reports: { state: 'error', message: 'x' } }).closed?.empty, null)
})

test('a run still going on a closed PR is a line of its history, with no Stop', async () => {
  const model = modelOf(find(await closedView(), 97), { runs: ready([run({ status: 'running', finishedAt: null, result: null })]) })
  assert.deepEqual([model.card, model.running, model.stop, model.runs.rows.map((each) => each.id)], ['none', null, null, [41]])
})

// ---- the page ----

type Page = {
  document: ReturnType<typeof installFakeBrowser>['document']
  row: (number: number) => FakeElement
  root: FakeElement
  drawer: ReturnType<typeof createDrawer>
  sweepDrawer: ReturnType<typeof createSweepDrawer>
  // every request the page made, as "GET /api/..."
  asked: string[]
  opened: string[]
  // the PR is open again on the page's next update
  reopen: (row: OpenRow) => void
  leave: () => void
}

type Served = { runs?: RunView[], reports?: ReportListing[], last?: LastReadings | null | 'fail' }

const withPage = async (range: 'today' | 'yesterday', served: Served, check: (page: Page) => Promise<void>): Promise<void> => {
  const view = await closedView()
  const asked: string[] = []
  const opened: string[] = []
  const live = new Map<number, OpenRow>()
  const fake = installFakeBrowser((async (input: string, init?: RequestInit) => {
    const url = String(input)
    asked.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.endsWith('/runs')) return answer(200, served.runs ?? [])
    if (url.endsWith('/reports')) return answer(200, served.reports ?? [])
    if (url.endsWith('/last')) return served.last === 'fail' ? answer(500, { error: 'the cache could not be read' }) : answer(200, { last: served.last ?? null })
    return answer(200, [])
  }) as typeof fetch)
  try {
    const doc = fake.document
    const table = doc.createElement('table')
    const [root, sweepRoot] = ['drawer', 'sweep-drawer'].map((id) => {
      const each = doc.createElement('aside')
      each.setAttribute('id', id)
      each.hidden = true
      return each
    }) as [FakeElement, FakeElement]
    doc.body.append(table, root, sweepRoot)
    const draw = (): void => renderTable(table as unknown as HTMLTableElement, closedTable(view[range], view[range].rows, nowMs))
    draw()
    const reports = { open: (name: string) => { opened.push(name) }, close: () => undefined, isOpen: () => false, refresh: () => undefined }
    const drawer = createDrawer({
      root: root as unknown as HTMLElement, token: 'token-1', nowMs: () => nowMs, rowOf: (number) => live.get(number), closedOf: (number) => findClosedRow({ closed: view }, number),
      repo: () => scenario.repo, viewer: () => scenario.viewer, say: () => undefined, reports, sweepLink: () => null, openSweep: () => undefined,
    })
    const sweepDrawer = createSweepDrawer({ root: sweepRoot as unknown as HTMLElement, token: 'token-1', nowMs: () => nowMs, sweeps: () => null, say: () => undefined, reports })
    mountRowClicks({ drawer, sweepDrawer, logPanel: { close: () => undefined }, seedRuns: () => undefined })
    const row = (number: number): FakeElement => {
      const found = doc.querySelector(`tr[data-pr="${number}"][data-table="closed"]`)
      assert.ok(found, `a Closed row for #${number}`)
      return found
    }
    await check({
      document: doc, row, root, drawer, sweepDrawer, asked, opened,
      reopen: (open) => { live.set(open.number, open) },
      leave: () => { live.clear() },
    })
    drawer.close()
  } finally {
    fake.restore()
  }
}

const buttons = (root: FakeElement): string[] => root.querySelectorAll('button').map((button) => button.getAttribute('aria-label') ?? button.textContent)

for (const [range, number] of [['today', 100], ['yesterday', 97]] as const) {
  test(`a click on a Closed row (${range}) opens its read-only drawer, and it asks only for what the PR has`, async () => {
    await withPage(range, { runs: [run()], reports: [report()], last: await readings() }, async ({ row, root, drawer, asked, opened }) => {
      press(row(number).querySelector('td.col-closedBy') ?? row(number))
      await settle()
      assert.deepEqual([drawer.number(), root.hidden, drawer.form()], [number, false, 'closed'])
      assert.match(root.textContent, new RegExp(`Agent for #${number}`))
      assert.match(root.textContent, new RegExp(`#${number} is closed, so this drawer is read-only\\.`))
      assert.deepEqual([...asked].sort(), ['last', 'reports', 'runs'].map((what) => `GET /api/prs/${number}/${what}`))
      // the latest run's card, the report and its Open, and the resume command's Copy; nothing that starts, posts, merges, or refreshes
      assert.deepEqual(buttons(root).filter((name) => !/^(Close agent drawer|Open |Copy resume)/.test(name)), [])
      assert.equal(root.querySelector('[data-start-kind]'), null)
      assert.doesNotMatch(root.textContent, /Nothing can be started|is no longer open/)
      press(root.querySelector('[data-focus-key="report:PR-97.md"]')!)
      assert.deepEqual(opened, ['PR-97.md'])
      // a Closed row gets no Agent button: the row is the way in, and focus returns to it
      assert.equal(row(number).querySelector('button[data-agent]'), null)
    })
  })
}

test('a closed PR with neither says so in plain words, in place of both lists', async () => {
  await withPage('yesterday', { last: null }, async ({ row, root }) => {
    press(row(95))
    await settle()
    assert.ok(root.textContent.includes(emptyText))
    assert.doesNotMatch(root.textContent, /Reports on disk|Previous runs|Loading/)
    assert.match(root.textContent, /The cache no longer holds this PR's last review, CI, and merge readings\./)
  })
})

test('a closed PR with run history only shows its latest run and no report', async () => {
  await withPage('yesterday', { runs: [run()] }, async ({ row, root }) => {
    press(row(97))
    await settle()
    assert.equal(root.querySelector('.drawer-result-text')?.textContent.startsWith('Changes requested'), true)
    assert.match(root.textContent, /No reports on disk for this PR\./)
    assert.ok(!root.textContent.includes(emptyText))
  })
})

test('a last reading that could not be loaded says so, and Try again reads it again', async () => {
  const served: Served = { last: 'fail' }
  await withPage('yesterday', served, async ({ row, root, asked }) => {
    press(row(97))
    await settle()
    assert.match(root.textContent, /Could not load the last readings\. The cache could not be read\./)
    served.last = await readings()
    press(root.querySelectorAll('button').find((button) => button.textContent === 'Try again')!)
    await settle()
    assert.doesNotMatch(root.textContent, /Could not load/)
    assert.match(root.textContent, /Last read/)
    assert.equal(asked.filter((each) => each.endsWith('/last')).length, 2)
  })
})

test('the click rules are the open rows\' rules: links keep theirs, a selection opens nothing, a second click leaves the drawer, and another row switches it', async () => {
  await withPage('yesterday', {}, async ({ row, drawer, sweepDrawer, document, asked }) => {
    for (const link of row(97).querySelectorAll('a[href]')) press(link)
    assert.equal(drawer.isOpen(), false)
    document.getSelection = () => ({ isCollapsed: false, containsNode: () => true })
    press(row(97))
    assert.equal(drawer.isOpen(), false)
    document.getSelection = () => null
    press(row(97))
    await settle()
    const reads = asked.length
    press(row(97))
    await settle()
    assert.deepEqual([drawer.number(), asked.length], [97, reads])
    // opening the PR it already shows read-only, by any caller, reads nothing again
    drawer.open(97, { key: 'closed-row:97', number: 97 })
    await settle()
    assert.equal(asked.length, reads)
    assert.equal(closeOnOutsidePress([drawer, sweepDrawer], row(95) as unknown as Element), false)
    press(row(95))
    assert.equal(drawer.number(), 95)
    assert.equal(closeOnOutsidePress([drawer, sweepDrawer], row(95).querySelector('a[href]') as unknown as Element), true)
  })
})

for (const key of ['Enter', ' ']) {
  test(`${key === ' ' ? 'Space' : key} on a focused Closed row opens its drawer, and closing it returns focus to the row`, async () => {
    await withPage('today', {}, async ({ row, drawer, document }) => {
      assert.equal(row(100).getAttribute('tabindex'), '0')
      assert.equal(row(100).getAttribute('aria-label'), '#100: open details')
      row(100).focus()
      assert.equal(row(100).dispatch('keydown', { key }), true, 'the key does not scroll the page')
      assert.equal(drawer.number(), 100)
      drawer.close()
      assert.equal(document.activeElement, row(100))
    })
  })
}

test('a key on a link or cell inside a Closed row, and any other key on the row, open nothing', async () => {
  await withPage('today', {}, async ({ row, drawer }) => {
    const link = row(100).querySelector('a[href]')
    assert.ok(link)
    assert.equal(link.dispatch('keydown', { key: 'Enter' }), false)
    row(100).dispatch('keydown', { key: 'a' })
    // a key that bubbles up from a cell is not the row's own
    row(100).querySelector('td')!.dispatch('keydown', { key: 'Enter' })
    assert.equal(drawer.isOpen(), false)
  })
})

test('a reopened PR shows the open drawer on the next update, with its starts', async () => {
  const pr = (await openPage1()).data.repository?.pullRequests.nodes.find((each) => each.number === 106)
  assert.ok(pr)
  const reopened = deriveOpenRows([{ ...pr, number: 97 }], scenario.defaultBranch, { ...context, agent: (raw, stack) => agentCell(raw, config, undefined, undefined, stack) })[0]
  assert.ok(reopened)
  await withPage('yesterday', { runs: [run()], last: await readings() }, async ({ row, root, drawer, reopen, leave }) => {
    press(row(97))
    await settle()
    assert.equal(drawer.form(), 'closed')
    reopen(reopened)
    drawer.update()
    await settle()
    assert.equal(drawer.form(), 'open')
    assert.doesNotMatch(root.textContent, /read-only/)
    assert.ok(root.querySelector('[data-focus-key="start:tandem"]'))
    // a PR that closes while its open drawer shows keeps that drawer's own no-longer-open form, and its Closed row then shows the read-only one
    leave()
    drawer.update()
    await settle()
    assert.equal(drawer.form(), 'gone')
    assert.match(root.textContent, /#97 is no longer open/)
    press(row(97))
    await settle()
    assert.equal(drawer.form(), 'closed')
    assert.match(root.textContent, /read-only/)
    assert.doesNotMatch(root.textContent, /no longer open/)
  })
})

test('the auto-review log\'s run link still opens a closed PR on that run in its own form', async () => {
  await withPage('yesterday', { runs: [run()] }, async ({ row, root, drawer }) => {
    press(row(97))
    await settle()
    drawer.open(97, { key: 'auto-review-button', number: 97 }, undefined, { runId: 41, title: 'a title the log kept' })
    await settle()
    assert.equal(drawer.form(), 'gone')
    assert.match(root.textContent, /#97 is no longer open/)
    assert.match(root.textContent, /a title the log kept/)
  })
})

test('findClosedRow reads both ranges, whichever the table shows', async () => {
  const closed = await closedView()
  assert.deepEqual([100, 97].map((number) => findClosedRow({ closed }, number)?.number), [100, 97])
  assert.equal(findClosedRow({ closed }, 9_999), undefined)
})

test('only Closed rows take keyboard focus themselves, with a visible ring, and the page hands the drawer its Closed rows', async () => {
  const read = (name: string): Promise<string> => readFile(join(import.meta.dirname, '..', 'public', name), 'utf8')
  assert.match(await read('styles.css'), /\.prs tr\[data-table="closed"\]:focus-visible \{\n\s+outline: 2px solid var\(--focus\);\n\s+outline-offset: -2px;\n\}/)
  assert.match(await read('app.ts'), /closedOf: \(number\) => feed\.view === null \? undefined : findClosedRow\(feed\.view, number\)/)
})
