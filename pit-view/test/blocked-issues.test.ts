// test/blocked-issues.test.ts
// a row whose Merge cell reads Blocked always carries an issue chip that names what it needs (section 5, Issue chips), and the Mine group formerly labeled Awaiting review reads Waiting for user action. The rows come from the invented scenario: #120 is approved, BEHIND, and MERGEABLE, the shape of a PR approved and behind its base; #102 is approved and CLEAN
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeOffered } from '../public/mergeoffer.ts'
import { matchesMine, matchesOthers, mineIssueOptions, mineSortValues, noFilters, othersIssueOptions } from '../public/filters.ts'
import { mineColumns, othersColumns } from '../public/tables.ts'
import type { CellContext } from '../public/tables.ts'
import { mergeRefusal } from '../src/actions.ts'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { deriveIssues, deriveMerge, deriveOpenRows, groupRows, offersMerge } from '../src/derive.ts'
import type { MineRow, OpenRow, OtherRow } from '../src/derive.ts'
import type { RawCheckContext, RawMergeStateStatus, RawOpenPr } from '../src/github.ts'
import { scenario } from './fixtures/scenario.ts'
import { openPage1, openPage2 } from './helpers.ts'

type Fake = { tag: string, attrs: Map<string, string>, children: Fake[], text?: string, setAttribute: (name: string, value: string) => void, appendChild: (child: Fake) => Fake }
const fakeElement = (tag: string, text?: string): Fake => {
  const element: Fake = {
    tag,
    attrs: new Map(),
    children: [],
    ...(text === undefined ? {} : { text }),
    setAttribute: (name, value) => { element.attrs.set(name, value) },
    appendChild: (child) => { element.children.push(child); return child },
  }
  return element
}
Object.assign(globalThis, {
  document: {
    createElement: (tag: string) => fakeElement(tag),
    createElementNS: (_ns: string, tag: string) => fakeElement(tag),
    createTextNode: (text: string) => fakeElement('#text', text),
  },
})

const config: Config = { ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer }
const clock = { now: () => Date.parse(scenario.now) }
const derive = (prs: RawOpenPr[]): OpenRow[] => deriveOpenRows(prs, scenario.defaultBranch, { config, clock, timeZone: scenario.timeZone })

const fixture = async (number: number): Promise<RawOpenPr> => {
  const all = [...(await openPage1()).data.repository?.pullRequests.nodes ?? [], ...(await openPage2()).data.repository?.pullRequests.nodes ?? []]
  const found = all.find((pr) => pr.number === number)
  assert.ok(found, `#${number} is missing`)
  return structuredClone(found)
}
const variant = (pr: RawOpenPr, patch: Partial<RawOpenPr>, contexts?: RawCheckContext[]): RawOpenPr => {
  const copy: RawOpenPr = { ...structuredClone(pr), ...patch }
  if (contexts !== undefined) copy.headCommit.nodes[0]!.commit.statusCheckRollup = { contexts: { totalCount: contexts.length, nodes: contexts } }
  return copy
}
const run = (name: string, status: string, conclusion: string | null): RawCheckContext =>
  ({ __typename: 'CheckRun', name, status, conclusion, detailsUrl: `https://example.test/${name}`, checkSuite: null }) as unknown as RawCheckContext
const green = [run('Unit tests', 'COMPLETED', 'SUCCESS')]
const kinds = (pr: RawOpenPr): string[] => deriveIssues(pr).map((issue) => issue.kind)

// the text of a built cell, from the fake nodes
const textOf = (node: Fake): string => (node.text ?? '') + node.children.map(textOf).join('')
const issuesText = (row: OpenRow): string[] => {
  const column = (row.section === 'mine' ? mineColumns(false) : othersColumns(false)).find((candidate) => candidate.key === 'issues')!
  const ctx = { view: { repo: scenario.repo }, nowMs: Date.parse(scenario.now), paused: false, terms: [], queryTerms: [] } as unknown as CellContext
  const cell = (column.cell as (r: unknown, c: CellContext) => { build: () => Node[] })(row, ctx)
  const wrapper = (cell.build() as unknown as Fake[])[0]!
  return wrapper.children.map(textOf)
}

const statuses: RawMergeStateStatus[] = ['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE']
const everyStatus = [...statuses, 'FUTURE_STATUS' as RawMergeStateStatus]

test('an approved PR GitHub reports as BEHIND shows a Behind chip that names its base and the fix', async () => {
  const pr = await fixture(120)
  assert.equal(pr.mergeStateStatus, 'BEHIND')
  assert.equal(pr.mergeable, 'MERGEABLE')
  assert.equal(pr.reviewDecision, 'APPROVED')
  const [row] = derive([pr]) as MineRow[]
  assert.equal(row!.merge.label, 'Blocked')
  assert.deepEqual(row!.issues.map((issue) => [issue.kind, issue.label]), [['behind', 'Behind main']])
  assert.match(row!.issues[0]!.tip ?? '', /Update branch/)
  assert.deepEqual(issuesText(row!), ['Behind main'])
  // a PR on another base reads that base
  const [stacked] = derive([variant(pr, { baseRefName: 'release/2' })])
  assert.deepEqual(stacked!.issues.map((issue) => issue.label), ['Behind release/2'])
})

test('another approved, BEHIND, MERGEABLE PR with different data reads the same', async () => {
  const pr = variant(await fixture(102), { mergeStateStatus: 'BEHIND', mergeable: 'MERGEABLE' }, green)
  const [row] = derive([pr]) as MineRow[]
  assert.equal(row!.merge.state, 'blocked')
  assert.deepEqual(issuesText(row!), ['Behind main'])
})

test('DIRTY reads Conflicts once, whether or not mergeable says CONFLICTING', async () => {
  const base = await fixture(102)
  assert.deepEqual(kinds(variant(base, { mergeStateStatus: 'DIRTY', mergeable: 'MERGEABLE' }, green)), ['conflicts'])
  assert.deepEqual(kinds(variant(base, { mergeStateStatus: 'DIRTY', mergeable: 'UNKNOWN' }, green)), ['conflicts'])
  assert.deepEqual(kinds(variant(base, { mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' }, green)), ['conflicts'])
  assert.deepEqual(kinds(variant(base, { mergeStateStatus: 'CLEAN', mergeable: 'CONFLICTING' }, green)), ['conflicts'])
})

test('BLOCKED with no other chip reads Blocked by branch protection; another chip already says what it needs', async () => {
  const base = await fixture(102)
  const blocked = variant(base, { mergeStateStatus: 'BLOCKED' }, green)
  assert.deepEqual(deriveIssues(blocked).map((issue) => [issue.kind, issue.label]), [['blockedByGithub', 'Blocked by branch protection']])
  assert.match(deriveIssues(blocked)[0]!.tip ?? '', /required/)
  assert.deepEqual(kinds(variant(base, { mergeStateStatus: 'BLOCKED' }, [run('Unit tests', 'IN_PROGRESS', null)])), ['ciRunning'])
  assert.deepEqual(kinds(variant(base, { mergeStateStatus: 'BLOCKED' }, [run('Unit tests', 'COMPLETED', 'FAILURE')])), ['ciFailing'])
  assert.deepEqual(kinds(variant(base, { mergeStateStatus: 'BLOCKED' }, [])), ['ciNotRun'])
})

test('UNSTABLE and a status this version does not know still get a chip when nothing else names the block', async () => {
  const base = await fixture(102)
  assert.deepEqual(deriveIssues(variant(base, { mergeStateStatus: 'UNSTABLE' }, green)).map((issue) => issue.label), ['Non-required checks not passing'])
  assert.deepEqual(deriveIssues(variant(base, { mergeStateStatus: 'FUTURE_STATUS' as RawMergeStateStatus }, green)).map((issue) => issue.label), ['Blocked by GitHub'])
  assert.match(deriveIssues(variant(base, { mergeStateStatus: 'FUTURE_STATUS' as RawMergeStateStatus }, green))[0]!.tip ?? '', /FUTURE_STATUS/)
  // not approved but reviewed: UNSTABLE reads Blocked whatever the reviews, so it carries the chip too
  assert.deepEqual(kinds(variant(base, { mergeStateStatus: 'UNSTABLE', reviewDecision: 'REVIEW_REQUIRED' }, green)), ['blockedByGithub'])
})

test('no PR reads Blocked with an empty Issues cell, for every merge status, decision, review, and mergeable value', async () => {
  const base = await fixture(102)
  const decisions = ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', null] as const
  const mergeables = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] as const
  const checks = [green, [run('Unit tests', 'IN_PROGRESS', null)], []]
  let blocked = 0
  for (const status of everyStatus) for (const decision of decisions) for (const mergeable of mergeables) for (const contexts of checks) for (const reviewed of [true, false]) {
    const pr = variant(base, { mergeStateStatus: status, reviewDecision: decision, mergeable }, contexts)
    if (!reviewed) { pr.latestReviews = { nodes: [] }; pr.latestOpinionatedReviews = { nodes: [] } }
    const found = derive([pr])[0]!
    const label = `${status}, ${decision}, ${mergeable}, ${contexts.length} checks, ${reviewed ? 'reviewed' : 'no reviews'}`
    if (found.merge.label === 'Blocked') {
      blocked += 1
      assert.ok(found.issues.length > 0, label)
      assert.ok(issuesText(found).every((text) => text !== ''), label)
    }
  }
  assert.ok(blocked > 50, `only ${blocked} blocked cases were exercised`)
})

test('a PR that is not blocked gains no status chip: needs approval, needs review, ready, and checking read as before', async () => {
  const base = await fixture(102)
  const reviewed = variant(base, { reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BEHIND' }, green)
  assert.deepEqual(deriveIssues(reviewed), [])
  assert.equal(deriveMerge(reviewed, deriveIssues(reviewed)).state, 'needsApproval')
  const unreviewed = variant(base, { reviewDecision: 'APPROVED', mergeStateStatus: 'BEHIND' }, green)
  unreviewed.latestReviews = { nodes: [] }
  unreviewed.latestOpinionatedReviews = { nodes: [] }
  assert.deepEqual(deriveIssues(unreviewed), [])
  assert.equal(deriveMerge(unreviewed, []).state, 'needsReview')
  for (const status of ['CLEAN', 'HAS_HOOKS', 'UNKNOWN'] as const) assert.deepEqual(deriveIssues(variant(base, { mergeStateStatus: status }, green)), [], status)
  assert.deepEqual(deriveIssues(variant(base, { isDraft: true, mergeStateStatus: 'BLOCKED' }, green)), [])
})

test('the Merge offer, on the page and on the server, still withholds Merge from a BEHIND approved PR', async () => {
  const pr = await fixture(120)
  const [row] = derive([pr]) as MineRow[]
  assert.equal(mergeOffered(row!), false)
  assert.equal(offersMerge(pr, deriveMerge(pr, deriveIssues(pr)), deriveIssues(pr), true), false)
  const refusal = mergeRefusal(120, pr, 'main')
  assert.ok(refusal)
  assert.match(refusal.message, /Blocked \(Behind main\)/)
  // the chip is not what withholds it: the status already does, and the same PR caught up offers Merge
  const caught = variant(pr, { mergeStateStatus: 'CLEAN' }, green)
  const [ready] = derive([caught]) as MineRow[]
  assert.equal(ready!.merge.state, 'ready')
  assert.equal(mergeOffered(ready!), true)
  assert.equal(mergeRefusal(120, caught, 'main'), null)
})

test('the filter, the sort, and the group read the new chips from the same list', async () => {
  const behind = derive([await fixture(120)])[0] as MineRow
  const clean = derive([variant(await fixture(102), {}, green)])[0] as MineRow
  const mineWith = (issues: string) => matchesMine({ ...noFilters().mine, issues: issues as never })
  assert.equal(mineWith('behind')(behind), true)
  assert.equal(mineWith('behind')(clean), false)
  assert.equal(mineWith('none')(behind), false)
  assert.equal(mineWith('none')(clean), true)
  assert.ok(mineIssueOptions.some((option) => option.value === 'behind' && option.label === 'Behind base'))
  assert.ok(othersIssueOptions.some((option) => option.value === 'behind'))
  const other = derive([variant(await fixture(110), { mergeStateStatus: 'BEHIND' }, green)])[0] as OtherRow
  assert.equal(other.section, 'others')
  assert.deepEqual(other.issues.map((issue) => issue.kind), ['behind'])
  assert.equal(matchesOthers({ ...noFilters().others, issues: 'behind' })(other), true)
  // the chip does not move an Others row between groups: it stays where the review state put it, never Waiting on author for this alone
  assert.notEqual(other.group, 'waitingOnAuthor')
  // sorting by issues counts chips, so the row with one sorts with the rows that have one
  assert.equal(mineSortValues.issues(behind), -1)
  assert.ok(mineSortValues.issues(clean) === 0)
})

test('the Mine group formerly labeled Awaiting review reads Waiting for user action, with the same key, members, and order', async () => {
  const all = [...(await openPage1()).data.repository?.pullRequests.nodes ?? [], ...(await openPage2()).data.repository?.pullRequests.nodes ?? []]
  const { mine } = groupRows(derive(all))
  assert.deepEqual(mine.groups.map((group) => group.key), ['changesRequested', 'readyToMerge', 'awaitingReview', 'drafts'])
  const group = mine.groups.find((candidate) => candidate.key === 'awaitingReview')!
  assert.equal(group.label, 'Waiting for user action')
  assert.equal(group.sub, 'not mergeable yet, or waiting on reviewers or checks')
  assert.deepEqual(group.rows.map((row) => row.number), [120, 104])
  assert.ok(!JSON.stringify(mine.groups).includes('Awaiting review'))
})
