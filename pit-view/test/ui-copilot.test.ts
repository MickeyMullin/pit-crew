// test/ui-copilot.test.ts
// the Review column's note that Copilot's requested changes are outstanding on an Others' row (public/copilot.ts): rows derived from the fixture PRs by the real derivation, drawn by the real table renderer on the fake document in test/fake-dom.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copilotLogin, copilotRequestsChanges } from '../public/copilot.ts'
import { renderTable } from '../public/tables.ts'
import { othersSortValues } from '../public/filters.ts'
import { regroup } from '../public/state.ts'
import { defaultConfig } from '../src/config.ts'
import { deriveOpenRows } from '../src/derive.ts'
import type { OpenRow, OtherRow } from '../src/derive.ts'
import type { RawOpenPr } from '../src/github.ts'
import { scenario } from './fixtures/scenario.ts'
import { installFakeBrowser } from './fake-dom.ts'
import type { FakeElement } from './fake-dom.ts'
import { openPage1, openPage2 } from './helpers.ts'
import { openTable } from './table-model.ts'

const config = { ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer }
const nowMs = Date.parse(scenario.now)
const note = 'Copilot changes requested'

type Review = { login: string, state: string, at?: string }

const pages = async (): Promise<RawOpenPr[]> => [...(await openPage1()).data.repository!.pullRequests.nodes, ...(await openPage2()).data.repository!.pullRequests.nodes]

const derive = (prs: readonly RawOpenPr[]): OpenRow[] => deriveOpenRows(prs, scenario.defaultBranch, { config, clock: { now: () => nowMs }, timeZone: scenario.timeZone })

const reviewNodes = (reviews: readonly Review[]): RawOpenPr['latestReviews']['nodes'] =>
  reviews.map((review, index) => ({ databaseId: 9000 + index, author: { login: review.login }, state: review.state, submittedAt: review.at ?? '2026-10-26T10:00:00Z', commit: { oid: 'c'.repeat(40) } })) as unknown as RawOpenPr['latestReviews']['nodes']

// a fixture PR with these reviews added to the ones it has, and these logins asked again
const withReviews = async (number: number, reviews: readonly Review[], requested: readonly string[] = []): Promise<RawOpenPr> => {
  const pr = structuredClone((await pages()).find((each) => each.number === number))
  assert.ok(pr)
  pr.latestReviews.nodes.push(...reviewNodes(reviews))
  pr.latestOpinionatedReviews.nodes.push(...reviewNodes(reviews.filter((review) => review.state !== 'COMMENTED')))
  for (const login of requested) pr.reviewRequests.nodes.push({ requestedReviewer: { __typename: 'Bot', login } } as unknown as RawOpenPr['reviewRequests']['nodes'][number])
  return pr
}

const rowOf = (pr: RawOpenPr): OtherRow => {
  const row = derive([pr])[0]
  assert.equal(row?.section, 'others')
  return row as OtherRow
}

// the Review cell's chips and whole text, drawn
const drawn = (table: 'mine' | 'others', row: OpenRow): { chips: string[], text: string, tones: string[] } => {
  const fake = installFakeBrowser((async () => new Response('[]')) as typeof fetch)
  try {
    const element: FakeElement = fake.document.createElement('table')
    fake.document.body.appendChild(element)
    renderTable(element as unknown as HTMLTableElement, openTable(table, [row], nowMs))
    const cell = element.querySelector('td.col-review')
    assert.ok(cell)
    const chips = cell.querySelectorAll('.chip')
    return { chips: chips.map((chip) => chip.textContent), text: cell.textContent, tones: chips.map((chip) => chip.className) }
  } finally {
    fake.restore()
  }
}

const copilot = (state: string): Review => ({ login: copilotLogin, state })

test('Copilot\'s outstanding change request is noted after what the Review column already says', async () => {
  const pr = await withReviews(106, [])
  const before = drawn('others', rowOf(pr))
  const after = drawn('others', rowOf(await withReviews(106, [copilot('CHANGES_REQUESTED')])))
  assert.ok(!before.text.includes(note))
  assert.deepEqual(after.chips, [...before.chips, note])
  assert.match(after.tones.at(-1) ?? '', /\btone-red\b/)
})

test('the login is one constant, matched whatever its case, and never by a part of it', async () => {
  assert.equal(copilotLogin, 'copilot-pull-request-reviewer')
  assert.equal(copilotRequestsChanges(rowOf(await withReviews(106, [{ login: copilotLogin.toUpperCase(), state: 'CHANGES_REQUESTED' }]))), true)
  for (const login of ['copilot', `${copilotLogin}-two`, 'alex-mendez']) {
    assert.equal(copilotRequestsChanges(rowOf(await withReviews(113, [{ login, state: 'CHANGES_REQUESTED' }]))), false, login)
  }
})

for (const [name, reviews, requested] of [
  ['approved', [copilot('APPROVED')], []],
  ['commented only', [copilot('COMMENTED')], []],
  ['dismissed', [copilot('DISMISSED')], []],
  ['been asked again since its change request', [copilot('CHANGES_REQUESTED')], [copilotLogin]],
  ['not reviewed, beside another reviewer\'s change request', [{ login: 'alex-mendez', state: 'CHANGES_REQUESTED' }], []],
] as [string, Review[], string[]][]) {
  test(`nothing is noted when Copilot has ${name}`, async () => {
    assert.ok(!drawn('others', rowOf(await withReviews(113, reviews, requested))).text.includes(note))
  })
}

test('a later approval by Copilot takes the note away', async () => {
  const pr = await withReviews(113, [])
  pr.latestReviews.nodes.push(...reviewNodes([{ login: copilotLogin, state: 'APPROVED', at: '2026-10-26T12:00:00Z' }]))
  pr.latestOpinionatedReviews.nodes.push(...reviewNodes([copilot('CHANGES_REQUESTED')]))
  assert.equal(copilotRequestsChanges(rowOf(pr)), false)
})

test('a later comment by Copilot leaves its change request outstanding, as it leaves anyone\'s', async () => {
  const pr = await withReviews(113, [])
  pr.latestReviews.nodes.push(...reviewNodes([{ login: copilotLogin, state: 'COMMENTED', at: '2026-10-26T12:00:00Z' }]))
  pr.latestOpinionatedReviews.nodes.push(...reviewNodes([copilot('CHANGES_REQUESTED')]))
  assert.equal(drawn('others', rowOf(pr)).text.includes(note), true)
})

test('Mine rows are unchanged', async () => {
  const pr = await withReviews(101, [copilot('CHANGES_REQUESTED')])
  const row = derive([pr])[0]
  assert.ok(row !== undefined && row.section === 'mine')
  assert.ok(!drawn('mine', row).text.includes(note))
})

test('rows without Copilot say exactly what they did, and the note moves no count, order, group, or sort', async () => {
  const prs = await pages()
  for (const row of derive(prs)) if (row.section === 'others') assert.equal(copilotRequestsChanges(row), false, `#${row.number}`)
  // the same change request by Copilot and by a person group and sort alike; only the Copilot one is noted
  const swap = async (login: string): Promise<OpenRow[]> => {
    const changed = await withReviews(113, [{ login, state: 'CHANGES_REQUESTED' }])
    return derive(prs.map((pr) => pr.number === 113 ? changed : pr))
  }
  const shape = { mine: { groups: [{ key: 'changesRequested' }] }, others: { groups: ['yourMove', 'readyToMerge', 'waitingOnAuthor', 'bots'].map((key) => ({ key, label: key, sub: '', collapsible: false, rows: [] })) } } as unknown as Parameters<typeof regroup>[0]
  const read = (rows: OpenRow[]): unknown => ({
    groups: regroup(shape, rows).others.groups.map((group) => [group.key, group.rows.map((row) => row.number)]),
    sorts: rows.filter((row): row is OtherRow => row.section === 'others').map((row) => [row.number, othersSortValues.review(row)]),
    issues: rows.map((row) => [row.number, row.issues.map((issue) => issue.kind)]),
  })
  assert.deepEqual(read(await swap(copilotLogin)), read(await swap('pat-quigley')))
})
