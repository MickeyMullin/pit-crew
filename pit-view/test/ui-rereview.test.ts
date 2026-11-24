// test/ui-rereview.test.ts
// the Agent cell's idle button reads Re-review on a Mine row whose self-review is stale (public/agent.ts, public/agentcell.ts): rows derived from the fixture PRs by the real derivation with the server's own agentCell, drawn by the real table renderer on the fake document in test/fake-dom.ts. The run it leads to is asked through the real server in test/server.test.ts
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { cellModel, showsReReview } from '../public/agent.ts'
import { agentCellSig } from '../public/agentcell.ts'
import { renderTable } from '../public/tables.ts'
import { defaultConfig } from '../src/config.ts'
import { deriveOpenRows } from '../src/derive.ts'
import type { MineRow, OpenRow } from '../src/derive.ts'
import type { Run } from '../src/cache.ts'
import { agentCell } from '../src/launcher.ts'
import type { Queueing } from '../src/launcher.ts'
import type { RawOpenPr } from '../src/github.ts'
import type { ReportInfo } from '../src/reports.ts'
import { scenario } from './fixtures/scenario.ts'
import { openPage1 } from './helpers.ts'
import { openTable } from './table-model.ts'
import { installFakeBrowser } from './fake-dom.ts'
import type { FakeElement } from './fake-dom.ts'

const config = { ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer }
const nowMs = Date.parse(scenario.now)

const reportAt = (number: number, sha: string): ReportInfo => ({ number, file: `PR-${number}.md`, reviewedSha: sha, tandem: true, at: '2026-10-25T12:00:00Z' }) as unknown as ReportInfo

// one fixture PR's row as the server builds it, with its self-review report at the commit given
const rowFor = async (number: number, reviewed: 'head' | 'older' | 'none', patch: Partial<RawOpenPr> = {}, { queueing = null, run }: { queueing?: Queueing | null, run?: Run } = {}): Promise<OpenRow> => {
  const base = (await openPage1()).data.repository?.pullRequests.nodes.find((pr) => pr.number === number)
  assert.ok(base)
  const pr = { ...structuredClone(base), ...patch } as RawOpenPr
  const reports = new Map<number, ReportInfo>()
  if (reviewed !== 'none') reports.set(number, reportAt(number, reviewed === 'head' ? pr.headRefOid.slice(0, 7) : '0123abc'))
  const row = deriveOpenRows([pr], scenario.defaultBranch, {
    config, clock: { now: () => nowMs }, timeZone: scenario.timeZone, reports, agent: (raw, stack) => agentCell(raw, config, run, reports.get(number), stack, queueing),
  })[0]
  assert.ok(row)
  return row
}

// the drawn Agent cell's one button, in the real table
const drawn = (table: 'mine' | 'others', rows: OpenRow[], read: (button: FakeElement, again: (next: OpenRow[]) => FakeElement) => void): void => {
  const fake = installFakeBrowser((async () => new Response('[]')) as typeof fetch)
  try {
    const element = fake.document.createElement('table')
    fake.document.body.appendChild(element)
    const draw = (next: OpenRow[]): FakeElement => {
      renderTable(element as unknown as HTMLTableElement, openTable(table, next, nowMs))
      const button = element.querySelector('button[data-agent="open"]')
      assert.ok(button)
      return button
    }
    read(draw(rows), draw)
  } finally {
    fake.restore()
  }
}

test('a Mine row with a stale self-review draws a Re-review button in its own color, which opens the drawer as the idle button does and asks nothing', async () => {
  const row = await rowFor(101, 'older')
  assert.equal((row as MineRow).selfReview.state, 'stale')
  drawn('mine', [row], (button) => {
    assert.equal(button.textContent, 'Re-review')
    assert.equal(button.getAttribute('aria-label'), 'Re-review #101: open agent')
    assert.deepEqual(button.className.split(' ').sort(), ['agent-button', 'agent-rereview', 'agent-start'])
    assert.equal(button.getAttribute('data-pr'), '101')
    assert.equal(button.getAttribute('data-agent-ask'), null)
    assert.equal(button.getAttribute('data-focus-key'), 'agent-open:101')
  })
  // the starts and the default run are the server's, unchanged
  assert.deepEqual(row.agent?.action, { kind: 'selfReview', label: 'Tandem self-review', command: 'review-pr', args: ['101', '--tandem', '--no-post'], runner: 'claude' })
  assert.deepEqual(row.agent?.starts[0]?.args, ['101', '--tandem', '--no-post'])
})

for (const reviewed of ['head', 'none'] as const) {
  test(`a Mine row whose self-review is ${reviewed === 'head' ? 'current' : 'missing'} keeps its button as it was`, async () => {
    drawn('mine', [await rowFor(101, reviewed)], (button) => {
      assert.equal(button.textContent, 'Tandem self-review')
      assert.equal(button.getAttribute('aria-label'), 'Tandem self-review #101: open agent')
      assert.equal(button.className, 'agent-button agent-start')
    })
  })
}

test('the button changes both ways on the next draw, with no reload', async () => {
  const [current, stale] = [await rowFor(101, 'head'), await rowFor(101, 'older')]
  drawn('mine', [current], (button, again) => {
    assert.equal(button.textContent, 'Tandem self-review')
    assert.equal(again([stale]).textContent, 'Re-review')
    assert.equal(again([current]).textContent, 'Tandem self-review')
  })
  const sig = (row: OpenRow): string => JSON.stringify(agentCellSig(row.agent, row.number, nowMs, false, showsReReview(row)))
  assert.notEqual(sig(stale), sig(current))
})

test('a new self-review that would wait in the queue reads Queue re-review', async () => {
  const queueing = { review: true, selfReview: true } as unknown as Queueing
  drawn('mine', [await rowFor(101, 'older', {}, { queueing })], (button) => {
    assert.equal(button.textContent, 'Queue re-review')
    assert.equal(button.getAttribute('aria-label'), 'Queue re-review #101: open agent')
    assert.ok(button.className.includes('agent-rereview'))
  })
})

test('a ready row keeps Merge, stale self-review or not', async () => {
  const row = await rowFor(102, 'older', { mergeStateStatus: 'CLEAN' })
  assert.equal((row as MineRow).selfReview.state, 'stale')
  drawn('mine', [row], (button) => {
    assert.equal(button.textContent, 'Merge')
    assert.equal(button.getAttribute('data-agent-ask'), 'merge')
    assert.equal(button.className, 'agent-button agent-start')
  })
})

test('a queued, running, or done cell is unchanged by a stale self-review', async () => {
  const row = await rowFor(101, 'older')
  assert.ok(row.agent !== null)
  for (const patch of [{ state: 'queued', startedAt: scenario.now }, { state: 'running', startedAt: scenario.now }, { state: 'done', status: 'done', text: 'Clean', finishedAt: scenario.now }]) {
    const cell = { ...row.agent, ...patch } as typeof row.agent
    assert.deepEqual(cellModel(cell, 101, nowMs, false, true), cellModel(cell, 101, nowMs))
  }
})

test('Others\' rows never read Re-review for a self-review', async () => {
  const row = await rowFor(106, 'none')
  assert.equal(showsReReview(row), false)
  drawn('others', [row], (button) => {
    assert.equal(button.textContent, row.agent?.action.label)
    assert.ok(!button.className.includes('agent-rereview'))
  })
})

test('the Re-review button is drawn in amber from a token, not the idle button\'s blue', async () => {
  const css = await readFile(join(import.meta.dirname, '..', 'public', 'styles.css'), 'utf8')
  assert.match(css, /\.agent-rereview \{\n\s+border-color: var\(--amber-fg\);\n\s+color: var\(--amber-fg\);\n\}/)
  assert.match(css, /\.agent-rereview:hover \{\n\s+background: var\(--amber-bg\);\n\s+border-color: var\(--amber-fg\);\n\}/)
  // it follows the idle button's own rules, which it overrides
  assert.ok(css.indexOf('\n.agent-rereview {') > css.indexOf('\n.agent-start:hover {'))
})
