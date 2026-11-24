// test/ui-rowclick.test.ts
// a click on a PR's row opens its drawer (section 6 of DESIGN.md, Columns, Row click): real rows, derived from the fixture PRs and drawn by the real table renderer, clicked on the fake document in test/fake-dom.ts with the real drawer, sweep drawer, and handler
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDrawer } from '../public/drawer.ts'
import { closeOnOutsidePress } from '../public/drawerview.ts'
import { mountRowClicks } from '../public/rowclick.ts'
import { createSweepDrawer } from '../public/sweepdrawer.ts'
import { renderTable } from '../public/tables.ts'
import { defaultConfig } from '../src/config.ts'
import { deriveOpenRows } from '../src/derive.ts'
import type { OpenRow } from '../src/derive.ts'
import { agentCell } from '../src/launcher.ts'
import type { RawOpenPr } from '../src/github.ts'
import { scenario } from './fixtures/scenario.ts'
import { installFakeBrowser, press } from './fake-dom.ts'
import type { FakeElement } from './fake-dom.ts'
import { openPage1, openPage2 } from './helpers.ts'
import { openTable } from './table-model.ts'

const config = { ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit' }
const nowMs = Date.parse(scenario.now)
const answer = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

const rows = async (): Promise<OpenRow[]> => {
  const prs: RawOpenPr[] = [...(await openPage1()).data.repository!.pullRequests.nodes, ...(await openPage2()).data.repository!.pullRequests.nodes]
  return deriveOpenRows(prs, scenario.defaultBranch, { config, clock: { now: () => nowMs }, timeZone: scenario.timeZone, agent: (raw, stack) => agentCell(raw, config, undefined, undefined, stack) })
}

type Page = {
  document: ReturnType<typeof installFakeBrowser>['document']
  row: (number: number) => FakeElement
  drawerRoot: FakeElement
  drawer: ReturnType<typeof createDrawer>
  sweepDrawer: ReturnType<typeof createSweepDrawer>
  // what the click did beside opening: the runs announced so far are noted, and the log closes
  did: string[]
  sent: string[]
  // leaves the next POST without its answer
  hold: () => () => void
}

const withPage = async (check: (page: Page) => Promise<void>, { agentColumn = true }: { agentColumn?: boolean } = {}): Promise<void> => {
  const all = await rows()
  const sent: string[] = []
  let held: Promise<void> | null = null
  const fake = installFakeBrowser((async (input: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      sent.push(String(input))
      await held
    }
    return answer(200, [])
  }) as typeof fetch)
  try {
    const doc = fake.document
    const main = doc.createElement('main')
    const roots = ['drawer', 'sweep-drawer', 'report-panel'].map((id) => {
      const root = doc.createElement('aside')
      root.setAttribute('id', id)
      root.hidden = true
      return root
    })
    doc.body.append(main, ...roots)
    for (const table of ['mine', 'others'] as const) {
      const element = doc.createElement('table')
      main.appendChild(element)
      const model = openTable(table, all.filter((each) => each.section === table), nowMs)
      if (!agentColumn) model.columns = model.columns.filter((column) => column.key !== 'agent')
      renderTable(element as unknown as HTMLTableElement, model)
    }
    const reports = { open: () => undefined, close: () => undefined, isOpen: () => false, refresh: () => undefined }
    const [drawerRoot, sweepRoot] = roots as [FakeElement, FakeElement]
    const drawer = createDrawer({
      root: drawerRoot as unknown as HTMLElement, token: 'token-1', nowMs: () => nowMs, rowOf: (number) => all.find((each) => each.number === number),
      repo: () => scenario.repo, viewer: () => scenario.viewer, say: () => undefined, reports, sweepLink: () => null, openSweep: () => undefined,
    })
    const sweepDrawer = createSweepDrawer({ root: sweepRoot as unknown as HTMLElement, token: 'token-1', nowMs: () => nowMs, sweeps: () => null, say: () => undefined, reports })
    const did: string[] = []
    mountRowClicks({ drawer, sweepDrawer, logPanel: { close: () => { did.push('log') } }, seedRuns: () => { did.push('seed') } })
    const row = (number: number): FakeElement => {
      const found = doc.querySelector(`tr[data-pr="${number}"][data-table]`)
      assert.ok(found)
      return found
    }
    const hold = (): (() => void) => {
      let release = (): void => undefined
      held = new Promise((resolve) => { release = resolve })
      return () => release()
    }
    await check({ document: doc, row, drawerRoot, drawer, sweepDrawer, did, sent, hold })
    drawer.close()
  } finally {
    fake.restore()
  }
}

for (const [number, section] of [[101, 'Mine'], [106, 'Others\'']] as const) {
  test(`a click on plain ${section} row area opens that PR's drawer, through the drawer's own opening`, async () => {
    await withPage(async ({ row, drawer, drawerRoot, did, sent, document }) => {
      press(row(number).querySelector('td.col-activity') ?? row(number))
      await settle()
      assert.equal(drawer.number(), number)
      assert.equal(drawerRoot.hidden, false)
      assert.match(drawerRoot.textContent, new RegExp(`Agent for #${number}`))
      assert.deepEqual(did, ['seed', 'log'])
      // an open row takes no keyboard focus of its own: its Agent button is the keyboard path
      assert.equal(row(number).getAttribute('tabindex'), null)
      // it starts nothing and asks nothing
      assert.deepEqual(sent, [])
      assert.equal(drawerRoot.querySelector('[data-confirm]'), null)
      // focus returns to the row's Agent button, as from that button
      drawer.close()
      assert.equal(document.activeElement?.getAttribute('data-focus-key'), `agent-open:${number}`)
    })
  })
}

test('a click on a row\'s plain text, its chips that are not links, and the row itself opens the drawer', async () => {
  for (const selector of ['.title-text', '.review', 'td.col-merge', null]) {
    await withPage(async ({ row, drawer }) => {
      const target = selector === null ? row(106) : row(106).querySelector(selector)
      assert.ok(target, String(selector))
      press(target)
      assert.equal(drawer.number(), 106, String(selector))
    })
  }
})

test('with the Agent column off the row still opens the drawer, and focus returns to the PR link', async () => {
  await withPage(async ({ row, drawer, document }) => {
    press(row(106))
    assert.equal(drawer.number(), 106)
    drawer.close()
    assert.equal(document.activeElement?.getAttribute('data-focus'), 'pr')
  }, { agentColumn: false })
})

test('a click on any link or control in a row, or inside one, opens nothing', async () => {
  await withPage(async ({ row, drawer, document }) => {
    const controls = [101, 106].flatMap((number) => row(number).querySelectorAll('a[href], button'))
    assert.ok(controls.length >= 6)
    for (const control of controls) {
      press(control)
      assert.equal(drawer.isOpen(), false, control.textContent)
      const inner = control.children[0]
      if (inner !== undefined) press(inner)
      assert.equal(drawer.isOpen(), false, control.textContent)
    }
    // controls of other kinds, should a cell ever hold one
    for (const tag of ['input', 'select', 'textarea', 'label', 'summary']) {
      const control = document.createElement(tag)
      row(106).querySelector('td.col-merge')!.appendChild(control)
      press(control)
      assert.equal(drawer.isOpen(), false, tag)
    }
  })
})

test('a drag that selects text in the row does not open it; a selection elsewhere does not matter', async () => {
  await withPage(async ({ row, drawer, document }) => {
    const selection = (inside: FakeElement) => ({ isCollapsed: false, containsNode: (node: FakeElement) => node === inside })
    document.getSelection = () => selection(row(106))
    press(row(106).querySelector('.title-text')!)
    assert.equal(drawer.isOpen(), false)
    document.getSelection = () => ({ ...selection(row(106)), isCollapsed: true })
    press(row(106))
    assert.equal(drawer.number(), 106)
    document.getSelection = () => selection(row(101))
    drawer.close()
    press(row(106))
    assert.equal(drawer.number(), 106)
  })
})

test('a second click on the open drawer\'s row leaves it open with its confirmation, and another row\'s click switches to that PR', async () => {
  await withPage(async ({ row, drawer, drawerRoot, did }) => {
    press(row(101))
    await settle()
    press(drawerRoot.querySelector('[data-focus-key="start:tandem"]')!)
    assert.ok(drawerRoot.querySelector('[data-confirm="command"]'))
    did.length = 0
    press(row(101))
    assert.equal(drawer.number(), 101)
    assert.ok(drawerRoot.querySelector('[data-confirm="command"]'), 'the confirmation stays')
    assert.deepEqual(did, [])
    press(row(106))
    assert.equal(drawer.number(), 106)
    assert.equal(drawerRoot.querySelector('[data-confirm="command"]'), null)
  })
})

test('a click on a row while the drawer\'s request is on its way changes nothing', async () => {
  await withPage(async ({ row, drawer, drawerRoot, hold, sent }) => {
    press(row(101))
    await settle()
    press(drawerRoot.querySelector('[data-focus-key="start:tandem"]')!)
    const release = hold()
    press(drawerRoot.querySelector('[data-focus-key="confirm-go"]')!)
    assert.deepEqual(sent, ['/api/prs/101/runs'])
    press(row(106))
    assert.equal(drawer.number(), 101)
    release()
    await settle()
    press(row(106))
    assert.equal(drawer.number(), 106)
  })
})

test('a press on plain row area is an opener\'s press, so it closes no drawer before its click; a press on the row\'s link or control closes it as before', async () => {
  await withPage(async ({ row, drawer, sweepDrawer }) => {
    const pressed = (target: FakeElement): boolean => closeOnOutsidePress([drawer, sweepDrawer], target as unknown as Element)
    press(row(101))
    assert.equal(pressed(row(106).querySelector('.title-text')!), false)
    assert.equal(pressed(row(106)), false)
    assert.equal(drawer.number(), 101)
    const link = row(106).querySelector('a.pr-link')
    assert.ok(link)
    assert.equal(pressed(link), true)
    assert.equal(drawer.isOpen(), false)
  })
})

test('a click a handler has taken, a click with another button, and a click outside every row open nothing', async () => {
  await withPage(async ({ row, drawer, document }) => {
    row(106).addEventListener('click', (event) => event.preventDefault())
    press(row(106))
    assert.equal(drawer.isOpen(), false)
    row(101).dispatch('click', { button: 1 })
    assert.equal(drawer.isOpen(), false)
    press(document.querySelector('thead')!)
    press(document.body)
    assert.equal(drawer.isOpen(), false)
  })
})

test('the sweep drawer gives way to the PR drawer', async () => {
  await withPage(async ({ row, drawer, sweepDrawer }) => {
    sweepDrawer.open({ key: 'sweep-status' })
    press(row(106))
    assert.deepEqual([drawer.number(), sweepDrawer.isOpen()], [106, false])
  })
})

test('the page mounts the handler with its own drawers and log, and its rows show the pointer', async () => {
  const read = (name: string): Promise<string> => readFile(join(import.meta.dirname, '..', 'public', name), 'utf8')
  assert.match(await read('app.ts'), /mountRowClicks\(\{ drawer, sweepDrawer, logPanel, seedRuns \}\)/)
  assert.match(await read('styles.css'), /\.prs tr\[data-pr\] \{\n\s+cursor: pointer;\n\}/)
})
