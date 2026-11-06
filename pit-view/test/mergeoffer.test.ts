// test/mergeoffer.test.ts
// the Merge offer over the full cross product of everything it reads, generated rather than picked by hand. The expected answer comes from the one-sentence rule written out below, which imports nothing from the code under test, and the page, the drawer, the idle Agent button, and the server must each equal it in every cell
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actionOffers } from '../public/actionsview.ts'
import { cellModel, showsMerge } from '../public/agent.ts'
import type { AgentCell } from '../public/agent.ts'
import { ActionError, createActions, mergeRefusal } from '../src/actions.ts'
import type { ActionsOptions } from '../src/actions.ts'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { deriveOpenRows } from '../src/derive.ts'
import type { OpenRow } from '../src/derive.ts'
import type { Gh, RawCheckContext, RawMergeStateStatus, RawOpenPr } from '../src/github.ts'
import { scenario } from './fixtures/scenario.ts'
import { openPage1 } from './helpers.ts'

// every value of every input the rule reads. The type system excludes a null mergeStateStatus, and GitHub cannot produce some crossings (CLEAN with CONFLICTING, say), but the rule has an answer for each, so nothing is skipped
const statuses = ['CLEAN', 'UNKNOWN', 'HAS_HOOKS', 'UNSTABLE', 'BEHIND', 'BLOCKED', 'DIRTY', 'DRAFT', null] as const
const mergeables = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] as const
const decisions = ['APPROVED', 'REVIEW_REQUIRED', 'CHANGES_REQUESTED', null] as const
const drafts = [false, true] as const
const bases = ['primary', 'other', 'stack', 'release'] as const
const cis = ['passing', 'failing', 'pending', 'canceled', 'noRollup', 'emptyRollup'] as const
const owners = ['mine', 'notMine'] as const
const reviews = ['reviewed', 'noReviews'] as const

type Cell = {
  status: typeof statuses[number]
  mergeable: typeof mergeables[number]
  decision: typeof decisions[number]
  draft: typeof drafts[number]
  base: typeof bases[number]
  ci: typeof cis[number]
  owner: typeof owners[number]
  reviews: typeof reviews[number]
}

const cells: Cell[] = statuses.flatMap((status) => mergeables.flatMap((mergeable) => decisions.flatMap((decision) => drafts.flatMap((draft) => bases.flatMap((base) => cis.flatMap((ci) => owners.flatMap((owner) => reviews.map((review) => ({ status, mergeable, decision, draft, base, ci, owner, reviews: review })))))))))
const expectedCells = statuses.length * mergeables.length * decisions.length * drafts.length * bases.length * cis.length * owners.length * reviews.length

const nameOf = (cell: Cell): string => Object.values(cell).map(String).join(' / ')

// THE RULE, independent of the code under test. Approved means reviewDecision APPROVED, and REVIEW_REQUIRED and null are not approved. A CONFLICTING mergeable, a change request, and a failing or running check each withhold it; no checks at all (the CI not run chip) and a canceled check do not. UNSTABLE is the owner's open question and is not offered
const clearsTheRule = (cell: Cell): boolean =>
  !cell.draft
  && cell.decision === 'APPROVED'
  && cell.mergeable !== 'CONFLICTING'
  && cell.ci !== 'failing' && cell.ci !== 'pending'
  && (cell.status === 'CLEAN' || cell.status === 'HAS_HOOKS' || cell.status === 'UNKNOWN')

// Merge is offered only on the viewer's own PR into the primary branch that clears the rule
const expectedOffer = (cell: Cell): boolean => cell.owner === 'mine' && cell.base === 'primary' && clearsTheRule(cell)

// the group and the merge state say the same as the rule whoever owns the PR and whatever its base, so a row never reads Ready to merge on one screen and is refused on another
const expectedMergeState = (cell: Cell): 'ready' | 'checking' | 'other' => {
  if (!clearsTheRule(cell)) return 'other'
  return cell.status === 'UNKNOWN' ? 'checking' : 'ready'
}

// invented people and branches; #102 is the viewer's own in the scenario
const elsewhere = 'lee-park'
const reviewer = 'sam-tran'
const baseRefs = { primary: scenario.defaultBranch, other: 'develop', stack: 'feat/parent-layer', release: 'release/2' }

const contextsOf: Record<Cell['ci'], RawCheckContext[] | null> = {
  passing: [{ __typename: 'CheckRun', name: 'Unit tests', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://example.test/job', checkSuite: null }] as unknown as RawCheckContext[],
  failing: [{ __typename: 'CheckRun', name: 'Unit tests', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://example.test/job', checkSuite: null }] as unknown as RawCheckContext[],
  pending: [{ __typename: 'CheckRun', name: 'Unit tests', status: 'IN_PROGRESS', conclusion: null, detailsUrl: 'https://example.test/job', checkSuite: null }] as unknown as RawCheckContext[],
  canceled: [{ __typename: 'CheckRun', name: 'Unit tests', status: 'COMPLETED', conclusion: 'CANCELLED', detailsUrl: 'https://example.test/job', checkSuite: null }] as unknown as RawCheckContext[],
  noRollup: null,
  emptyRollup: [],
}

const reviewStateOf = (decision: Cell['decision']): string => decision === 'APPROVED' || decision === 'CHANGES_REQUESTED' ? decision : 'COMMENTED'

const prOf = (base: RawOpenPr, cell: Cell): RawOpenPr => {
  const head = base.headCommit.nodes[0]
  assert.ok(head)
  const contexts = contextsOf[cell.ci]
  const nodes = cell.reviews === 'noReviews' ? [] : [{ author: { login: reviewer }, state: reviewStateOf(cell.decision), submittedAt: '2026-10-26T10:00:00Z', commit: { oid: base.headRefOid } }]
  return {
    ...base,
    mergeStateStatus: cell.status as RawMergeStateStatus,
    mergeable: cell.mergeable,
    reviewDecision: cell.decision,
    isDraft: cell.draft,
    baseRefName: baseRefs[cell.base],
    author: { ...base.author, login: cell.owner === 'mine' ? scenario.viewer : elsewhere },
    latestReviews: { nodes },
    latestOpinionatedReviews: { nodes },
    reviewRequests: { nodes: [] },
    headCommit: { nodes: [{ commit: { ...head.commit, statusCheckRollup: contexts === null ? null : { contexts: { totalCount: contexts.length, nodes: contexts } } } }] },
  } as unknown as RawOpenPr
}

const config: Config = { ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer }
const clock = { now: () => Date.parse(scenario.now) }

const idleCell = {
  state: 'idle',
  label: 'Self-review',
  action: { kind: 'selfReview', label: 'Self-review', command: 'review-local', args: ['102'], runner: 'claude' },
  starts: [],
  commit: null,
  lastReviewAt: null,
  runId: null, runner: null, command: null, args: null, status: null, startedAt: null, lastStepAt: null, step: null,
  steps: [], tandem: false,
  finishedAt: null, text: null, result: null, question: null, note: null, firstNote: null, resolvedByHand: false, resume: null, costUsd: null, postOffer: null,
} as unknown as AgentCell

const base102 = async (): Promise<RawOpenPr> => {
  const found = (await openPage1()).data.repository?.pullRequests.nodes.find((pr) => pr.number === 102)
  assert.ok(found)
  return found
}

// a stacked PR's parent sits in the same list, so its base really is another PR's branch
const allPrs = (base: RawOpenPr, cell: Cell): RawOpenPr[] => {
  const pr = prOf(base, cell)
  return cell.base === 'stack' ? [pr, { ...base, number: 900, headRefName: baseRefs.stack }] : [pr]
}

// the row the page would receive; a draft of someone else's is hidden, so it has none
const rowOf = (base: RawOpenPr, cell: Cell): OpenRow | undefined =>
  deriveOpenRows(allPrs(base, cell), scenario.defaultBranch, { config, clock, timeZone: scenario.timeZone, agent: () => idleCell }).find((row) => row.number === 102)

// the server's whole merge path (the repository, ownership, the guard, the head and base binding, then the live read) over a fake cache and a fake gh whose live read agrees with the cell: it reports the PR as GitHub finished computing it. A write reaching gh is the offer; nothing here can reach a real PR
const serverFor = (base: RawOpenPr): ((cell: Cell) => Promise<{ allowed: boolean, reads: number }>) => {
  let open: { number: number, pr: RawOpenPr }[] = []
  let writes = 0
  let reads = 0
  let live = ''
  const gh = {
    write: async (_args: string[], _expected: string, check?: (read: (args: string[]) => Promise<string>) => Promise<void>) => {
      await check?.(async () => {
        reads += 1
        return live
      })
      writes += 1
      return ''
    },
  } as unknown as Gh
  const cache = { readView: () => ({ open, defaultBranch: scenario.defaultBranch }) }
  const actions = createActions({ cache, gh, config: () => config, refreshPr: async () => {}, log: () => {} } as unknown as ActionsOptions)
  return async (cell) => {
    const pr = prOf(base, cell)
    open = [{ number: 102, pr }]
    writes = 0
    reads = 0
    live = JSON.stringify({ state: 'open', draft: false, merged: false, mergeable: true, mergeable_state: cell.status === 'UNKNOWN' || cell.status === null ? 'clean' : cell.status.toLowerCase(), base: { ref: pr.baseRefName }, head: { sha: pr.headRefOid } })
    try {
      await actions.run(102, { action: 'merge', repo: config.repo, headSha: pr.headRefOid.toLowerCase(), base: pr.baseRefName })
    } catch (error) {
      if (!(error instanceof ActionError)) throw error
    }
    return { allowed: writes === 1, reads }
  }
}

// a failure names every disagreeing cell rather than only the first, so a mistaken rule shows its whole shape
const assertNoMismatches = (mismatches: string[]): void => {
  assert.equal(mismatches.length, 0, `${mismatches.length} mismatches, the first 25:\n${mismatches.slice(0, 25).join('\n')}`)
}

test('the cross product covers every input the Merge offer reads, with nothing skipped', () => {
  assert.equal(cells.length, expectedCells)
  assert.equal(cells.length, 20736)
  assert.equal(new Set(cells.map(nameOf)).size, cells.length)
})

test('page, drawer, idle Agent button, and server all equal the rule in every cell', async () => {
  const base = await base102()
  const server = serverFor(base)
  const mismatches: string[] = []
  for (const cell of cells) {
    const expected = expectedOffer(cell)
    const row = rowOf(base, cell)
    const page = row !== undefined && showsMerge(row)
    const drawer = row !== undefined && actionOffers(row, true).some((offer) => offer.action === 'merge')
    const idle = row !== undefined && cellModel(idleCell, 102, clock.now(), showsMerge(row))
    const button = idle !== false && idle.state === 'idle' && idle.button === 'Merge' && idle.ask === 'merge'
    const { allowed, reads } = await server(cell)
    const answers = { page, drawer, button, server: allowed, liveReadOnlyWhenAllowed: reads === (allowed ? 1 : 0) }
    const wanted = { page: expected, drawer: expected, button: expected, server: expected, liveReadOnlyWhenAllowed: true }
    if (JSON.stringify(answers) !== JSON.stringify(wanted)) mismatches.push(`${nameOf(cell)}: ${JSON.stringify(answers)}, wanted ${expected}`)
  }
  assertNoMismatches(mismatches)
})

test('the cached server guard, which ownership does not reach, equals the rule in every cell', async () => {
  const base = await base102()
  const mismatches: string[] = []
  for (const cell of cells) {
    const allowed = mergeRefusal(102, prOf(base, cell), scenario.defaultBranch) === null
    if (allowed !== (cell.base === 'primary' && clearsTheRule(cell))) mismatches.push(`${nameOf(cell)}: ${allowed}`)
  }
  assertNoMismatches(mismatches)
})

test('the merge state and the Ready to merge group equal the rule in every cell, in Mine and in Others\'', async () => {
  const base = await base102()
  const mismatches: string[] = []
  for (const cell of cells) {
    const row = rowOf(base, cell)
    if (row === undefined) {
      if (cell.owner === 'mine' || !cell.draft) mismatches.push(`${nameOf(cell)}: no row`)
      continue
    }
    const state = row.merge.state
    const answer = { state: state === 'ready' || state === 'checking' ? state : 'other', ready: row.group === 'readyToMerge', draft: state === 'draft' }
    const wanted = { state: expectedMergeState(cell), ready: clearsTheRule(cell), draft: cell.draft }
    if (JSON.stringify(answer) !== JSON.stringify(wanted)) mismatches.push(`${nameOf(cell)}: ${JSON.stringify(answer)}, wanted ${JSON.stringify(wanted)}`)
  }
  assertNoMismatches(mismatches)
})

test('an approved row GitHub has not finished computing reads Checking whatever non-withholding chip it carries, and a chip that withholds reads Blocked', async () => {
  const base = await base102()
  const unknown: Cell = { status: 'UNKNOWN', mergeable: 'UNKNOWN', decision: 'APPROVED', draft: false, base: 'primary', ci: 'noRollup', owner: 'mine', reviews: 'reviewed' }
  for (const ci of ['noRollup', 'emptyRollup', 'canceled', 'passing'] as const) {
    const row = rowOf(base, { ...unknown, ci })
    assert.ok(row)
    assert.deepEqual(row.merge, { state: 'checking', label: 'Checking' }, ci)
    assert.equal(row.group, 'readyToMerge', ci)
    assert.equal(showsMerge(row), true, ci)
  }
  for (const ci of ['failing', 'pending'] as const) assert.deepEqual(rowOf(base, { ...unknown, ci })?.merge, { state: 'blocked', label: 'Blocked' }, ci)
  // approval, not the reviews GitHub still lists, is what the rule reads
  assert.equal(rowOf(base, { ...unknown, reviews: 'noReviews' })?.merge.state, 'checking')
})

test('a PR that is not approved never reads Ready or Checking, whatever GitHub says of its merge state', async () => {
  const base = await base102()
  const clear: Cell = { status: 'HAS_HOOKS', mergeable: 'MERGEABLE', decision: 'REVIEW_REQUIRED', draft: false, base: 'primary', ci: 'passing', owner: 'mine', reviews: 'reviewed' }
  for (const status of ['HAS_HOOKS', 'CLEAN', 'UNKNOWN'] as const) {
    for (const decision of ['REVIEW_REQUIRED', null] as const) {
      const row = rowOf(base, { ...clear, status, decision })
      assert.ok(row)
      assert.deepEqual(row.merge, { state: 'needsApproval', label: 'Needs approval' }, `${status}, ${decision}`)
      assert.deepEqual(rowOf(base, { ...clear, status, decision, reviews: 'noReviews' })?.merge, { state: 'needsReview', label: 'Needs review' }, `${status}, ${decision}`)
      assert.equal(row.group, 'awaitingReview', `${status}, ${decision}`)
      assert.equal(showsMerge(row), false, `${status}, ${decision}`)
    }
  }
})

test('UNSTABLE reads Blocked and offers no Merge on an otherwise clear approved PR, whatever its checks say', async () => {
  const base = await base102()
  for (const ci of cis) {
    const row = rowOf(base, { status: 'UNSTABLE', mergeable: 'MERGEABLE', decision: 'APPROVED', draft: false, base: 'primary', ci, owner: 'mine', reviews: 'reviewed' })
    assert.ok(row)
    assert.deepEqual(row.merge, { state: 'blocked', label: 'Blocked' }, ci)
    assert.equal(showsMerge(row), false, ci)
  }
})
