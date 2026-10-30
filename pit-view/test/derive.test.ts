// test/derive.test.ts
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import {
  deriveClosed, deriveCounts, deriveIssues, deriveLastActivity, deriveMerge, deriveOpenRow, deriveOpenRows, deriveStacks,
  deriveTickets, deriveTiles, deriveView, groupRows, latestReviewsOf, localAvatarUrl, personView, reviewerPips,
} from '../src/derive.ts'
import type { DeriveContext, MineRow, OpenRow, OtherRow } from '../src/derive.ts'
import type { RawCheckContext, RawClosedPr, RawOpenPr, RawTimelineItem } from '../src/github.ts'
import { scanReports } from '../src/reports.ts'
import { scenario } from './fixtures/scenario.ts'
import { closedSearch, openPage1, openPage2, tempDir } from './helpers.ts'

// invented people for the scenario's logins; colors are config data, not styling
const config: Config = {
  ...defaultConfig(),
  repo: scenario.repo,
  viewer: scenario.viewer,
  people: [
    { login: 'vera-quill', alias: 'Vera', initials: 'VQ', color: '#1D4ED8', avatar: 'initials' },
    { login: 'alex-mendez', alias: 'Alex', initials: 'AL', color: '#0F766E', avatar: 'github' },
    { login: 'sam-tran', alias: 'Sam', initials: 'ST', color: '#7C3AED', avatar: 'initials' },
    { login: 'priya-k', alias: 'Priya', initials: 'PK', color: '#B45309', avatar: 'initials' },
    { login: 'lee-park', alias: 'Lee', initials: 'LP', color: '#BE123C', avatar: 'initials' },
  ],
}

const clock = { now: () => Date.parse(scenario.now) }
const ctx = (overrides: Partial<DeriveContext> = {}): DeriveContext => ({ config, clock, timeZone: scenario.timeZone, ...overrides })

const page1 = async (): Promise<RawOpenPr[]> => (await openPage1()).data.repository?.pullRequests.nodes ?? []
const page2 = async (): Promise<RawOpenPr[]> => (await openPage2()).data.repository?.pullRequests.nodes ?? []
const allOpen = async (): Promise<RawOpenPr[]> => [...await page1(), ...await page2()]
const closedPrs = async (): Promise<RawClosedPr[]> => (await closedSearch()).data.search.nodes

const find = <T extends { number: number }>(items: readonly T[], number: number): T => {
  const item = items.find((candidate) => candidate.number === number)
  assert.ok(item, `#${number} is missing`)
  return item
}

// a copy of a fixture PR with some fields replaced, for cases the scenario does not cover
const variant = (pr: RawOpenPr, patch: Partial<RawOpenPr>): RawOpenPr => ({ ...structuredClone(pr), ...patch })

const withContexts = (pr: RawOpenPr, nodes: RawCheckContext[] | null): RawOpenPr => {
  const copy = structuredClone(pr)
  const head = copy.headCommit.nodes[0]
  assert.ok(head)
  head.commit.statusCheckRollup = nodes === null ? null : { contexts: { totalCount: nodes.length, nodes } }
  return copy
}

const checkRun = (name: string, status: string, conclusion: string | null, url = `https://example.test/${name}`): RawCheckContext =>
  ({ __typename: 'CheckRun', name, status, conclusion, detailsUrl: url, checkSuite: null }) as RawCheckContext

const rows = async (overrides: Partial<DeriveContext> = {}): Promise<OpenRow[]> =>
  deriveOpenRows(await allOpen(), scenario.defaultBranch, ctx(overrides))

const row = async (number: number, overrides: Partial<DeriveContext> = {}): Promise<OpenRow> => find(await rows(overrides), number)
const other = async (number: number): Promise<OtherRow> => {
  const found = await row(number)
  assert.equal(found.section, 'others')
  return found as OtherRow
}
const mine = async (number: number, overrides: Partial<DeriveContext> = {}): Promise<MineRow> => {
  const found = await row(number, overrides)
  assert.equal(found.section, 'mine')
  return found as MineRow
}

test('every open PR lands in its section and group; others\' drafts are hidden', async () => {
  const placed = Object.fromEntries((await rows()).map((entry) => [entry.number, `${entry.section}/${entry.group}`]))
  assert.deepEqual(placed, {
    101: 'mine/changesRequested',
    102: 'mine/readyToMerge',
    103: 'mine/drafts',
    104: 'mine/awaitingReview',
    120: 'mine/awaitingReview',
    106: 'others/yourMove',
    107: 'others/yourMove',
    111: 'others/yourMove',
    112: 'others/yourMove',
    113: 'others/yourMove',
    110: 'others/readyToMerge',
    108: 'others/waitingOnAuthor',
    109: 'others/waitingOnAuthor',
    116: 'others/waitingOnAuthor',
    118: 'others/waitingOnAuthor',
    114: 'others/bots',
    115: 'others/bots',
  })
})

test('bots win over every other group, drafts and ready PRs included', async () => {
  const bump = find(await page2(), 114)
  const stack = deriveStacks([], null)
  assert.equal(deriveOpenRow(variant(bump, { isDraft: true }), ctx(), stack)?.group, 'bots')
  assert.equal(deriveOpenRow(variant(bump, { mergeStateStatus: 'CLEAN' }), ctx(), stack)?.group, 'bots')
  // with no bots configured it is an ordinary PR
  const noBots = ctx({ config: { ...config, bots: [] } })
  assert.equal(deriveOpenRow(bump, noBots, stack)?.group, 'yourMove')
})

test('ready to merge comes before waiting on author and your move', async () => {
  const requested = find(await page1(), 109)
  const clean = withContexts(variant(requested, { mergeStateStatus: 'CLEAN' }), [checkRun('Unit tests', 'COMPLETED', 'SUCCESS')])
  const found = deriveOpenRow(clean, ctx(), new Map()) as OtherRow
  assert.equal(found.group, 'readyToMerge')
  assert.deepEqual(found.flags.map((flag) => flag.kind), ['requestedOfYou'])
})

test('changes requested waits on the author only until the next push', async () => {
  // #118: the viewer requested changes at the head commit
  assert.equal((await other(118)).group, 'waitingOnAuthor')
  // #107: commits since that review (a force push), so it is the viewer's move again
  const moved = await other(107)
  assert.equal(moved.group, 'yourMove')
  assert.deepEqual(moved.issues.map((issue) => issue.kind), ['changesRequested'])
})

test('a PR the viewer reviewed at the head, with nothing new, falls back to waiting on author', async () => {
  const found = await other(116)
  assert.equal(found.group, 'waitingOnAuthor')
  assert.deepEqual(found.flags, [])
  assert.deepEqual(found.issues, [])
})

test('waiting on author still shows Requested of you', async () => {
  for (const number of [108, 109]) {
    const found = await other(number)
    assert.equal(found.group, 'waitingOnAuthor')
    assert.deepEqual(found.flags, [{ kind: 'requestedOfYou', label: 'Requested of you' }])
  }
})

test('re-review counts pushes since the viewer\'s review, or says new commits when the window lost it', async () => {
  assert.deepEqual((await other(106)).flags, [{ kind: 'reReview', label: 'Re-review · 2 pushes since yours', count: 2 }])
  assert.deepEqual((await other(107)).flags, [
    { kind: 'reReview', label: 'Re-review · new commits' },
    { kind: 'requestedOfYou', label: 'Requested of you' },
  ])
  const base = find(await page1(), 106)
  const recent = base.recentCommits.nodes
  const onePush = variant(base, { recentCommits: { totalCount: 2, nodes: recent.slice(1) } })
  const middle = recent[1]?.commit.oid
  assert.ok(middle)
  const review = onePush.latestReviews.nodes[0]
  assert.ok(review)
  review.commit = { oid: middle }
  assert.deepEqual((deriveOpenRow(onePush, ctx(), new Map()) as OtherRow).flags, [
    { kind: 'reReview', label: 'Re-review · 1 push since yours', count: 1 },
  ])
})

test('a team request is not a request of the viewer', async () => {
  const found = await other(111)
  assert.deepEqual(found.flags, [])
  assert.equal(found.group, 'yourMove')
})

test('reviewer pips come from latest reviews plus pending requests', async () => {
  const pips = async (number: number) => (await row(number)).reviewers.map((pip) => [pip.login, pip.state])
  assert.deepEqual(await pips(101), [['sam-tran', 'commented'], ['alex-mendez', 'changes']])
  assert.deepEqual(await pips(102), [['alex-mendez', 'approved'], ['sam-tran', 'approved']])
  // the viewer's old changes-requested review plus a re-request shows as requested
  assert.deepEqual(await pips(107), [['vera-quill', 'requested']])
  assert.deepEqual(await pips(120), [['alex-mendez', 'approved'], ['review-helper', 'requested']])
  assert.deepEqual(await pips(113), [])
  const teams = (await row(104)).reviewers
  assert.deepEqual(teams.map((pip) => [pip.login, pip.state, pip.team ?? false]), [
    ['sam-tran', 'requested', false],
    ['platform-reviewers', 'requested', true],
  ])
  assert.equal(teams[0]?.alias, 'Sam')
  assert.equal(find(await rows(), 107).reviewers[0]?.alias, 'You')
})

test('pips skip the author\'s own comments and dismissed reviews', async () => {
  const base = find(await page1(), 113)
  const pr = variant(base, {
    latestReviews: {
      nodes: [
        { author: { login: 'sam-tran' }, state: 'COMMENTED', submittedAt: '2026-10-26T10:00:00Z', commit: { oid: base.headRefOid } },
        { author: { login: 'lee-park' }, state: 'DISMISSED', submittedAt: '2026-10-26T10:01:00Z', commit: { oid: base.headRefOid } },
      ],
    },
  })
  assert.deepEqual(reviewerPips(pr, config), [])
  // and so the PR still needs its first review
  assert.equal(deriveMerge(pr, []).state, 'needsReview')
})

test('issue chips come in their fixed order with counts', async () => {
  const issues = async (number: number) => (await row(number)).issues
  assert.deepEqual(await issues(109), [{
    kind: 'ciFailing',
    label: 'CI failing · 2',
    count: 2,
    url: 'https://github.com/octo-example/orbit/actions/runs/31000000078/job/93000000245',
    tip: 'Open the failing job: Unit tests',
  }])
  assert.deepEqual(await issues(103), [{ kind: 'ciRunning', label: 'CI running · 4', count: 4 }])
  assert.deepEqual(await issues(112), [{ kind: 'ciRunning', label: 'CI running · 1', count: 1 }])
  assert.deepEqual(await issues(115), [{ kind: 'ciCanceled', label: 'CI canceled · 2', count: 2 }])
  assert.deepEqual(await issues(108), [{ kind: 'conflicts', label: 'Conflicts' }, { kind: 'ciNotRun', label: 'CI not run' }])
  assert.deepEqual(await issues(101), [{ kind: 'changesRequested', label: 'Changes requested' }])
  // mergeable UNKNOWN produces no chip
  assert.deepEqual(await issues(113), [])
})

test('failing covers timeouts, startup failures and errored statuses; running and failing can coexist', async () => {
  const base = find(await page1(), 113)
  const pr = withContexts(variant(base, { reviewDecision: 'CHANGES_REQUESTED', mergeable: 'CONFLICTING' }), [
    checkRun('Lint', 'COMPLETED', 'SUCCESS'),
    { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR', targetUrl: 'https://ci.example.test/1' },
    checkRun('E2E', 'COMPLETED', 'TIMED_OUT'),
    checkRun('Boot', 'COMPLETED', 'STARTUP_FAILURE'),
    checkRun('Deploy', 'REQUESTED', null),
    { __typename: 'StatusContext', context: 'ci/required', state: 'EXPECTED', targetUrl: null },
    checkRun('Docs', 'COMPLETED', 'CANCELLED'),
  ])
  assert.deepEqual(deriveIssues(pr), [
    { kind: 'changesRequested', label: 'Changes requested' },
    { kind: 'conflicts', label: 'Conflicts' },
    { kind: 'ciFailing', label: 'CI failing · 3', count: 3, url: 'https://ci.example.test/1', tip: 'Open the failing job: ci/legacy' },
    { kind: 'ciRunning', label: 'CI running · 2', count: 2 },
  ])
  // an empty rollup is as good as none
  assert.deepEqual(deriveIssues(withContexts(base, [])), [{ kind: 'ciNotRun', label: 'CI not run' }])
})

test('merge states follow the table in section 5', async () => {
  const merge = async (number: number) => (await row(number)).merge
  assert.deepEqual(await merge(102), { state: 'ready', label: 'Ready' })
  assert.deepEqual(await merge(110), { state: 'ready', label: 'Ready' })
  assert.deepEqual(await merge(103), { state: 'draft', label: '—' })
  assert.deepEqual(await merge(106), { state: 'needsApproval', label: 'Needs approval' })
  assert.deepEqual(await merge(116), { state: 'needsApproval', label: 'Needs approval' })
  assert.deepEqual(await merge(113), { state: 'needsReview', label: 'Needs review' })
  assert.deepEqual(await merge(104), { state: 'needsReview', label: 'Needs review' })
  // approved but BEHIND, and CI still running, are blocked
  assert.deepEqual(await merge(120), { state: 'blocked', label: 'Blocked' })
  assert.deepEqual(await merge(112), { state: 'blocked', label: 'Blocked' })
  // a null review decision with a review is still waiting for approval
  const pr = variant(find(await page2(), 116), { reviewDecision: null })
  assert.equal(deriveMerge(pr, deriveIssues(pr)).state, 'needsApproval')
})

test('an approved PR whose mergeability GitHub has not computed is checking, not blocked', async () => {
  const approved = variant(find(await page1(), 102), { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })
  assert.deepEqual(deriveMerge(approved, deriveIssues(approved)), { state: 'checking', label: 'Checking' })
  // a chip still blocks it, and no reviews still means it needs one
  const running = withContexts(approved, [checkRun('Unit tests', 'IN_PROGRESS', null)])
  assert.equal(deriveMerge(running, deriveIssues(running)).state, 'blocked')
  assert.equal((await row(113)).merge.state, 'needsReview')
})

test('an approved PR GitHub is still checking groups as ready to merge, in Mine and Others\', and keeps its Checking label', async () => {
  const unknown = { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' } as const
  const place = (pr: RawOpenPr) => {
    const found = deriveOpenRow(pr, ctx(), new Map())
    assert.ok(found)
    return { section: found.section, group: found.group, merge: found.merge, ...(found.section === 'mine' ? { stage: found.stage } : {}) }
  }
  const checking = { state: 'checking', label: 'Checking' }
  // #102 is the viewer's and #110 someone else's, both approved and clean in the scenario
  assert.deepEqual(place(variant(find(await allOpen(), 102), unknown)), { section: 'mine', group: 'readyToMerge', merge: checking, stage: 'approved' })
  assert.deepEqual(place(variant(find(await allOpen(), 110), unknown)), { section: 'others', group: 'readyToMerge', merge: checking })
  // the tile counts it as the table does
  const tiles = deriveTiles([variant(find(await allOpen(), 102), unknown)].map((pr) => deriveOpenRow(pr, ctx(), new Map())!), deriveClosed([], ctx()))
  assert.equal(tiles.mineReadyToMerge, 1)

  // not approved: UNKNOWN changes nothing, since the PR never reaches checking
  for (const number of [104, 106, 116]) {
    const pr = find(await allOpen(), number)
    assert.notEqual(pr.reviewDecision, 'APPROVED')
    assert.deepEqual(place(variant(pr, unknown)), place(variant(pr, { mergeStateStatus: 'BLOCKED' })), `#${number}`)
  }
  // approved with an issue chip: blocked by the chip, grouped as before
  for (const number of [102, 110]) {
    const running = withContexts(find(await allOpen(), number), [checkRun('Unit tests', 'IN_PROGRESS', null)])
    const placed = place(variant(running, unknown))
    assert.notEqual(placed.group, 'readyToMerge', `#${number}`)
    assert.deepEqual(placed, place(variant(running, { mergeStateStatus: 'BLOCKED' })), `#${number}`)
  }
})

test('mine groups and stages', async () => {
  const stage = async (number: number) => {
    const found = await mine(number)
    return [found.group, found.stage]
  }
  assert.deepEqual(await stage(101), ['changesRequested', 'changesRequested'])
  assert.deepEqual(await stage(102), ['readyToMerge', 'approved'])
  assert.deepEqual(await stage(120), ['awaitingReview', 'approved'])
  assert.deepEqual(await stage(104), ['awaitingReview', 'awaitingReview'])
  assert.deepEqual(await stage(103), ['drafts', 'draft'])
  assert.deepEqual((await mine(101)).changesRequested, { login: 'alex-mendez', alias: 'Alex', at: '2026-10-25T22:14:00Z' })
  assert.equal((await mine(102)).changesRequested, null)
  assert.equal('flags' in await mine(101), false)
})

// #101 answered by the viewer: a push past alex-mendez's review, or alex-mendez re-requested
const pushedOid = 'c0ffee5d1e2a3b4c5d6e7f8091a2b3c4d5e6f708'

const pushedPast = (pr: RawOpenPr): RawOpenPr => {
  const copy = structuredClone(pr)
  const head = copy.headCommit.nodes[0]
  assert.ok(head)
  head.commit = { ...head.commit, oid: pushedOid, committedDate: '2026-10-26T09:30:00Z' }
  copy.recentCommits.nodes.push({ commit: { oid: pushedOid, committedDate: '2026-10-26T09:30:00Z' } })
  copy.recentCommits.totalCount += 1
  copy.headRefOid = pushedOid
  return copy
}

const requesting = (pr: RawOpenPr, ...logins: string[]): RawOpenPr =>
  variant(pr, { reviewRequests: { nodes: logins.map((login) => ({ requestedReviewer: { __typename: 'User', login } })) } })

// the review's commit is null, so only the dates can tell
const withoutReviewCommit = (pr: RawOpenPr): RawOpenPr =>
  variant(pr, { latestReviews: { nodes: pr.latestReviews.nodes.map((review) => ({ ...review, commit: null })) } })

const answered = async () => {
  const asked = find(await page1(), 101)
  return { asked, pushed: pushedPast(asked), reRequested: requesting(asked, 'alex-mendez') }
}

const mineOf = (pr: RawOpenPr): MineRow => {
  const found = deriveOpenRow(pr, ctx(), new Map())
  assert.equal(found?.section, 'mine')
  return found as MineRow
}

test('changes requested on yours stays your move until you push past the review or re-request the reviewer', async () => {
  const { asked, pushed, reRequested } = await answered()
  const placed = (pr: RawOpenPr) => [mineOf(pr).group, mineOf(pr).stage]
  // not answered yet: the review is on the head commit and nobody was re-requested
  assert.deepEqual(placed(asked), ['changesRequested', 'changesRequested'])
  assert.deepEqual(placed(withoutReviewCommit(asked)), ['changesRequested', 'changesRequested'])
  // answered with commits: by commit, or by date when the review's commit is null
  assert.deepEqual(placed(pushed), ['awaitingReview', 'updatedNotRequested'])
  assert.deepEqual(placed(withoutReviewCommit(pushed)), ['awaitingReview', 'updatedNotRequested'])
  // answered by re-requesting the reviewer, with or without a push
  assert.deepEqual(placed(reRequested), ['awaitingReview', 'reReviewRequested'])
  assert.deepEqual(placed(requesting(pushed, 'alex-mendez')), ['awaitingReview', 'reReviewRequested'])
  // requesting someone else, or a team, is no answer to alex-mendez
  assert.deepEqual(placed(requesting(asked, 'sam-tran')), ['changesRequested', 'changesRequested'])
  const team = variant(asked, { reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team', name: scenario.team } }] } })
  assert.deepEqual(placed(team), ['changesRequested', 'changesRequested'])
  // with two reviewers requesting changes, both must be re-requested
  const twice = variant(asked, {
    latestReviews: { nodes: asked.latestReviews.nodes.map((review) => ({ ...review, state: 'CHANGES_REQUESTED' as const })) },
  })
  assert.deepEqual(placed(requesting(twice, 'alex-mendez')), ['changesRequested', 'changesRequested'])
  assert.deepEqual(placed(requesting(twice, 'alex-mendez', 'sam-tran')), ['awaitingReview', 'reReviewRequested'])
  // a draft stays a draft
  assert.deepEqual(placed(variant(pushed, { isDraft: true })), ['drafts', 'draft'])
})

test('an answered changes request keeps GitHub\'s decision as the chip, the reviewer and the pip', async () => {
  const { pushed, reRequested } = await answered()
  for (const pr of [pushed, reRequested]) {
    const found = mineOf(pr)
    assert.equal(found.issues[0]?.kind, 'changesRequested')
    assert.deepEqual(found.changesRequested, { login: 'alex-mendez', alias: 'Alex', at: '2026-10-25T22:14:00Z' })
  }
  // the pip keeps its ✗ after a push; a re-requested reviewer shows as requested, as every pip does
  assert.equal(mineOf(pushed).reviewers.find((pip) => pip.login === 'alex-mendez')?.state, 'changes')
  assert.equal(mineOf(reRequested).reviewers.find((pip) => pip.login === 'alex-mendez')?.state, 'requested')
})

test('the changes-requested banner group and tile count only PRs not yet answered', async () => {
  const { pushed, reRequested } = await answered()
  const closed = deriveClosed(await closedPrs(), ctx())
  const replacing101 = async (pr: RawOpenPr): Promise<OpenRow[]> =>
    deriveOpenRows((await allOpen()).map((entry) => entry.number === 101 ? pr : entry), scenario.defaultBranch, ctx())
  for (const pr of [pushed, reRequested]) {
    const all = await replacing101(pr)
    const groups = groupRows(all).mine.groups
    // the banner draws one line per row in this group, so it disappears with it
    assert.deepEqual(groups.find((group) => group.key === 'changesRequested')?.rows, [])
    assert.deepEqual(groups.find((group) => group.key === 'awaitingReview')?.rows.map((entry) => entry.number), [101, 120, 104])
    const tiles = deriveTiles(all, closed)
    assert.deepEqual([tiles.mineChangesRequested, tiles.mineChangesRequestedDetail], [0, null])
  }
  // one answered and one not: only the unanswered one counts
  const second = variant(find(await page1(), 101), { number: 121, url: 'https://github.com/octo-example/orbit/pull/121' })
  const all = [...await replacing101(pushed), deriveOpenRow(second, ctx(), new Map())!]
  const tiles = deriveTiles(all, closed)
  assert.deepEqual([tiles.mineChangesRequested, tiles.mineChangesRequestedDetail], [1, { number: 121, by: 'Alex', at: '2026-10-25T22:14:00Z' }])
  assert.deepEqual(groupRows(all).mine.groups[0]?.rows.map((entry) => entry.number), [121])
})

test('self-review is current, stale or none against the head commit', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    await writeFile(join(dir, 'PR-101.md'), 'Reviewed commit: `fix/webhook-retry` @ `e37eacd`\n', 'utf8')
    await writeFile(join(dir, 'PR-101-secondary.md'), 'Reviewed commit: `fix/webhook-retry` @ `e37eacd`\n', 'utf8')
    await writeFile(join(dir, 'chore-flags-to-env.md'), 'Reviewed commit: `chore/flags-to-env` @ `01fb234`\n', 'utf8')
    const prs = await allOpen()
    const reports = await scanReports(dir, prs.filter((pr) => pr.author?.login === scenario.viewer))
    const self = async (number: number) => (await mine(number, { reports })).selfReview
    const current = await self(101)
    assert.deepEqual({ ...current, at: typeof current.at }, {
      state: 'current', reviewedOid: 'e37eacd', headOid: 'e37eacd', tandem: true, file: 'PR-101.md', at: 'string',
    })
    const stale = await self(120)
    assert.deepEqual([stale.state, stale.reviewedOid, stale.headOid, stale.tandem, stale.file], ['stale', '01fb234', '982d87f', false, 'chore-flags-to-env.md'])
    assert.deepEqual(await self(104), { state: 'none', reviewedOid: null, headOid: 'e3baedc', tandem: false, file: null, at: null })
  } finally {
    await cleanup()
  }
})

test('last activity names the actor and merges consecutive commits', async () => {
  const text = async (number: number) => (await row(number)).lastActivity.text
  assert.equal(await text(118), 'You requested changes')
  assert.equal(await text(106), 'Sam approved')
  assert.equal(await text(113), 'Sam pushed 2 commits')
  assert.equal(await text(109), 'Lee pushed 1 commit')
  assert.equal(await text(108), 'Lee edited the title')
  assert.equal(await text(107), 'Sam requested your review')
  assert.equal(await text(104), 'You requested review from platform-reviewers')
  assert.equal(await text(120), 'You requested review from review-helper')
  assert.equal(await text(101), 'You commented')
  assert.equal(await text(116), 'You commented')
  assert.equal(await text(103), 'You pushed 1 commit')
  // bot commits carry only a name
  assert.equal(await text(114), 'dependabot pushed 1 commit')
  assert.deepEqual((await row(108)).lastActivity, { at: '2026-10-25T16:20:00Z', actor: 'Lee', text: 'Lee edited the title' })
})

test('last activity covers force pushes, draft changes and an empty timeline', async () => {
  const base = find(await page1(), 113)
  const timeline = (...nodes: RawTimelineItem[]) => variant(base, { timelineItems: { nodes } })
  const commit = (login: string, at: string): RawTimelineItem =>
    ({ __typename: 'PullRequestCommit', commit: { oid: at, committedDate: at, author: { name: login, user: { login } } } })
  const event = (__typename: string, createdAt: string): RawTimelineItem =>
    ({ __typename, actor: { login: 'sam-tran' }, createdAt, beforeCommit: null, afterCommit: null }) as RawTimelineItem
  const last = (pr: RawOpenPr) => deriveLastActivity(pr, config).text
  assert.equal(last(timeline(event('HeadRefForcePushedEvent', '2026-10-26T10:00:00Z'))), 'Sam force-pushed')
  assert.equal(last(timeline(event('ReadyForReviewEvent', '2026-10-26T10:00:00Z'))), 'Sam marked it ready for review')
  assert.equal(last(timeline(event('ConvertToDraftEvent', '2026-10-26T10:00:00Z'))), 'Sam converted it to a draft')
  // consecutive commits by different actors are not merged
  assert.equal(last(timeline(commit('lee-park', '2026-10-26T09:00:00Z'), commit('sam-tran', '2026-10-26T10:00:00Z'))), 'Sam pushed 1 commit')
  // a bot commit's user login carries [bot], which its other events do not
  assert.equal(last(timeline(commit('dependabot[bot]', '2026-10-26T10:00:00Z'))), 'dependabot pushed 1 commit')
  assert.equal(last(timeline(
    commit('sam-tran', '2026-10-26T08:00:00Z'), event('RenamedTitleEvent', '2026-10-26T08:30:00Z'),
    commit('sam-tran', '2026-10-26T09:00:00Z'), commit('sam-tran', '2026-10-26T10:00:00Z'),
  )), 'Sam pushed 2 commits')
  assert.deepEqual(deriveLastActivity(timeline(), config), { at: base.updatedAt, actor: null, text: 'Updated' })
})

test('stacks are found across page boundaries', async () => {
  const all = await allOpen()
  const stacks = deriveStacks(all, scenario.defaultBranch)
  assert.deepEqual(Object.fromEntries(stacks), { 110: { position: 1, size: 3 }, 111: { position: 2, size: 3 }, 112: { position: 3, size: 3 } })
  // page 1 alone holds #111 but neither its base #110 nor its child #112
  assert.equal(deriveStacks(await page1(), scenario.defaultBranch).size, 0)
  assert.deepEqual((await row(111)).stack, { position: 2, size: 3 })
  assert.equal((await row(113)).stack, null)
})

test('stacks handle branches, forks named after the default branch, and cycles', () => {
  const pr = (number: number, headRefName: string, baseRefName: string) => ({ number, headRefName, baseRefName })
  const branched = deriveStacks([pr(1, 'a', 'main'), pr(2, 'b', 'a'), pr(3, 'c', 'a'), pr(4, 'd', 'c')], 'main')
  assert.deepEqual(Object.fromEntries(branched), {
    1: { position: 1, size: 4 }, 2: { position: 2, size: 4 }, 3: { position: 2, size: 4 }, 4: { position: 3, size: 4 },
  })
  // a fork PR whose head is called main is nobody's base
  assert.equal(deriveStacks([pr(5, 'main', 'main'), pr(6, 'x', 'main')], 'main').size, 0)
  assert.equal(deriveStacks([pr(7, 'p', 'q'), pr(8, 'q', 'p')], 'main').size, 0)
})

test('tickets come from the title, then the branch, then linked issues; bodies only carry no-ticket', async () => {
  const tickets = async (number: number) => (await row(number)).tickets
  assert.deepEqual(await tickets(101), [{ system: 'Jira', label: 'ORB-251' }])
  // lowercase in the title, and only in the branch
  assert.deepEqual(await tickets(113), [{ system: 'Jira', label: 'ORB-433' }])
  assert.deepEqual(await tickets(106), [{ system: 'Jira', label: 'ORB-377' }])
  assert.deepEqual(await tickets(102), [{ system: 'GitHub', label: '#57', url: 'https://github.com/octo-example/orbit/issues/57' }])
  assert.deepEqual(await tickets(116), [{ system: 'none', label: 'no-ticket' }])
  // keys only in the body are not tickets, and bot branches are never read
  assert.deepEqual(await tickets(118), [])
  assert.deepEqual(await tickets(107), [])
  assert.deepEqual(await tickets(114), [])
})

test('ticket links, distinct matches and the no-ticket marker', async () => {
  const jira = { ...config.tickets[0], baseUrl: 'https://jira.example.test/' } as Config['tickets'][number]
  const linked = { ...config, tickets: [jira] }
  const source = (title: string, headRefName = 'feat/x', body = '') => ({ title, headRefName, body, closingIssuesReferences: { nodes: [] } })
  assert.deepEqual(deriveTickets(source('ORB-1 and orb-1, then ORB-2', 'feat/orb-9'), false, linked), [
    { system: 'Jira', label: 'ORB-1', url: 'https://jira.example.test/browse/ORB-1' },
    { system: 'Jira', label: 'ORB-2', url: 'https://jira.example.test/browse/ORB-2' },
  ])
  // a found ticket suppresses the marker
  assert.deepEqual(deriveTickets(source('ORB-3 tidy', 'x', 'no-ticket'), false, config), [{ system: 'Jira', label: 'ORB-3' }])
  assert.deepEqual(deriveTickets(source('tidy', 'x', 'NO-TICKET here'), false, config), [{ system: 'none', label: 'no-ticket' }])
  assert.deepEqual(deriveTickets(source('tidy', 'x', 'no-tickets'), false, config), [])
  // an empty list, or every system off, hides tickets everywhere
  assert.deepEqual(deriveTickets(source('ORB-4', 'x', 'no-ticket'), false, { ...config, tickets: [] }), [])
  const off = { ...config, tickets: config.tickets.map((system) => ({ ...system, enabled: false })) }
  assert.deepEqual(deriveTickets(source('ORB-4', 'x', 'no-ticket'), false, off), [])
  // a template that needs no base URL links without one
  const template = { ...config, tickets: [{ ...jira, baseUrl: '', linkTemplate: 'https://github.com/{repo}/issues/{n}' }] }
  assert.deepEqual(deriveTickets(source('GH-12'), false, template), [{ system: 'Jira', label: 'GH-12', url: 'https://github.com/octo-example/orbit/issues/12' }])
})

test('people resolve through config, with GitHub avatars for the unlisted and You for the viewer', () => {
  assert.deepEqual(personView('review-helper', null, config), {
    login: 'review-helper', alias: 'review-helper', initials: 'RH', color: null, avatarUrl: 'https://github.com/review-helper.png',
  })
  assert.deepEqual(personView('alex-mendez', 'https://avatars.example.test/a', config), {
    login: 'alex-mendez', alias: 'Alex', initials: 'AL', color: '#0F766E', avatarUrl: 'https://avatars.example.test/a',
  })
  assert.equal(personView('sam-tran', 'https://avatars.example.test/s', config).avatarUrl, null)
  assert.deepEqual(personView('Vera-Quill', null, config), { login: 'Vera-Quill', alias: 'You', initials: 'VQ', color: '#1D4ED8', avatarUrl: null })
  // a local image is served by the server's avatar route under the configured login, never as a path
  const local = { ...config, people: [{ login: 'Priya-K', alias: 'Priya', initials: 'PK', color: '#B45309', avatar: '~/pictures/priya k.png' }] }
  assert.equal(personView('priya-k', 'https://avatars.example.test/p', local).avatarUrl, '/api/avatar/Priya-K')
  assert.equal(localAvatarUrl('lee park'), '/api/avatar/lee%20park')
})

test('closed PRs split into Today and Yesterday* by local day, newest first', async () => {
  const closed = deriveClosed(await closedPrs(), ctx())
  assert.deepEqual([closed.today.label, closed.today.from, closed.today.to], ['Today', scenario.todayFrom, scenario.now])
  assert.deepEqual([closed.yesterday.label, closed.yesterday.isMondayRule, closed.yesterday.from, closed.yesterday.to],
    ['Yesterday*', true, scenario.yesterdayFrom, scenario.yesterdayTo])
  assert.deepEqual(closed.today.rows.map((entry) => entry.number), [100, 93])
  assert.deepEqual(closed.yesterday.rows.map((entry) => entry.number), [99, 97, 96, 98, 95, 94])
  // in utc mode #99 (02:30Z Monday) is Today
  const utc = deriveClosed(await closedPrs(), ctx({ config: { ...config, todayStartsAt: 'utc' } }))
  assert.deepEqual(utc.today.rows.map((entry) => entry.number), [100, 93, 99])
  assert.deepEqual(utc.yesterday.rows.map((entry) => entry.number), [97, 96, 98, 95, 94])
})

test('closed rows say who merged or closed them, and carry their tickets', async () => {
  const closed = deriveClosed(await closedPrs(), ctx())
  const all = [...closed.today.rows, ...closed.yesterday.rows]
  const by = Object.fromEntries(all.map((entry) => [entry.number, [entry.outcome, entry.closedBy.text]]))
  assert.deepEqual(by, {
    100: ['merged', 'merged by you'],
    93: ['closed', 'closed by Lee'],
    99: ['merged', 'merged by Sam'],
    97: ['merged', 'merged by Alex'],
    96: ['closed', 'superseded'],
    98: ['closed', 'closed by Priya'],
    95: ['merged', 'merged by you'],
    94: ['merged', 'merged by Alex'],
  })
  assert.deepEqual(find(all, 97).closedBy, { alias: 'Alex', login: 'alex-mendez', text: 'merged by Alex' })
  assert.deepEqual(find(all, 96).closedBy, { label: 'superseded', text: 'superseded' })
  const tickets = Object.fromEntries(all.map((entry) => [entry.number, entry.tickets.map((ticket) => ticket.label)]))
  assert.deepEqual(tickets, { 100: ['ORB-266'], 93: ['no-ticket'], 99: ['ORB-280'], 97: ['#51'], 96: [], 98: [], 95: ['ORB-240'], 94: [] })
  assert.deepEqual(find(all, 100), {
    number: 100,
    url: 'https://github.com/octo-example/orbit/pull/100',
    title: 'fix(sync): raise the upstream timeout',
    author: { login: 'vera-quill', alias: 'You', initials: 'VQ', color: '#1D4ED8', avatarUrl: null },
    outcome: 'merged',
    closedBy: { alias: 'You', login: 'vera-quill', text: 'merged by you' },
    closedAt: '2026-10-26T13:10:00Z',
    headRef: 'fix/orb-266-timeout',
    tickets: [{ system: 'Jira', label: 'ORB-266' }],
  })
})

test('tiles and counts agree with the tables', async () => {
  const all = await rows()
  const closed = deriveClosed(await closedPrs(), ctx())
  assert.deepEqual(deriveTiles(all, closed), {
    yourMove: 5,
    mineChangesRequested: 1,
    mineChangesRequestedDetail: { number: 101, by: 'Alex', at: '2026-10-25T22:14:00Z' },
    mineReadyToMerge: 1,
    waitingOnAuthor: 4,
    closedToday: 2,
    closedPrevious: { count: 6, merged: 4, closed: 2, label: 'Fri–Sun*' },
  })
  assert.deepEqual(deriveCounts(all), { mine: { open: 5, drafts: 1 }, others: { open: 12 } })
  const tuesday = deriveClosed(await closedPrs(), ctx({ clock: { now: () => Date.parse('2026-10-27T14:00:00Z') } }))
  assert.equal(deriveTiles(all, tuesday).closedPrevious.label, 'yesterday')
})

test('groups keep display order, hold rows in attention order, and name a lone bot', async () => {
  const { mine: mineSection, others } = groupRows(await rows())
  assert.deepEqual(mineSection.groups.map((group) => [group.key, group.rows.map((entry) => entry.number)]), [
    ['changesRequested', [101]], ['readyToMerge', [102]], ['awaitingReview', [120, 104]], ['drafts', [103]],
  ])
  assert.deepEqual(others.groups.map((group) => [group.key, group.label, group.rows.map((entry) => entry.number)]), [
    ['yourMove', 'Your move', [106, 107, 113, 111, 112]],
    ['readyToMerge', 'Ready to merge', [110]],
    ['waitingOnAuthor', 'Waiting on author', [109, 108, 118, 116]],
    ['bots', 'Bots', [114, 115]],
  ])
  const oneBot = groupRows((await rows()).filter((entry) => entry.number !== 115))
  assert.equal(oneBot.others.groups.find((group) => group.key === 'bots')?.label, 'dependabot')
})

test('the derived view has the API shape, with injected freshness', async () => {
  const view = deriveView(
    { open: await allOpen(), defaultBranch: scenario.defaultBranch, closed: await closedPrs() },
    ctx({ freshness: (number) => number === 113 ? { state: 'stale', fetchedAt: '2026-10-26T14:00:00Z' } : { state: 'current', fetchedAt: scenario.now } }),
  )
  assert.deepEqual(Object.keys(view), ['viewer', 'now', 'tiles', 'counts', 'mine', 'others', 'closed'])
  assert.equal(view.now, scenario.now)
  assert.deepEqual(view.viewer, { login: 'vera-quill', alias: 'You', initials: 'VQ', color: '#1D4ED8', avatarUrl: null })
  const shown = [...view.mine.groups, ...view.others.groups].flatMap((group) => group.rows as OpenRow[])
  assert.equal(shown.length, 17)
  assert.deepEqual(find(shown, 113).freshness, { state: 'stale', fetchedAt: '2026-10-26T14:00:00Z' })
  const sample = find(shown, 110)
  assert.deepEqual(Object.keys(sample).sort(), [
    'additions', 'agent', 'author', 'baseRef', 'changedFiles', 'createdAt', 'deletions', 'flags', 'freshness', 'group', 'headOid',
    'headRef', 'headSha', 'issues', 'lastActivity', 'merge', 'number', 'primaryBase', 'refresh', 'reviewers', 'section', 'stack', 'tickets', 'title', 'url',
  ])
  assert.deepEqual([sample.headOid, sample.headRef, sample.baseRef, sample.agent, sample.refresh], ['cb052a4', 'feat/import-reader', 'main', null, null])
  // freshness defaults to current as of now
  assert.deepEqual((await row(110)).freshness, { state: 'current', fetchedAt: scenario.now })
  // JSON-safe, so the server can send it as is
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view)
})

test('a deleted author and a null review decision do not break a row', async () => {
  const base = find(await page1(), 113)
  const found = deriveOpenRow(variant(base, { author: null, reviewDecision: null }), ctx(), new Map())
  assert.equal(found?.author.login, 'ghost')
  assert.equal(found?.section, 'others')
})

// GitHub drops a reviewer from latestReviews once a review is re-requested of them, and keeps their
// approval or change request in latestOpinionatedReviews. These variants move a fixture's reviews there.
const droppedByReRequest = (pr: RawOpenPr, ...reviewers: string[]): RawOpenPr => {
  const moved = pr.latestReviews.nodes.filter((review) => reviewers.includes(review.author?.login ?? ''))
  return variant(pr, {
    latestReviews: { nodes: pr.latestReviews.nodes.filter((review) => !moved.includes(review)) },
    latestOpinionatedReviews: {
      nodes: [
        ...pr.latestOpinionatedReviews.nodes.filter((review) => !reviewers.includes(review.author?.login ?? '')),
        ...moved.filter((review) => review.state !== 'COMMENTED'),
      ],
    },
  })
}

const othersRow = (pr: RawOpenPr): OtherRow => {
  const found = deriveOpenRow(pr, ctx(), new Map())
  assert.equal(found?.section, 'others')
  return found as OtherRow
}

// #107 is the viewer's old change request, re-requested, on a head that moved; the review's commit
// is moved into the last-30 window so the pushes since it can be counted
const reRequestedOfViewer = async (): Promise<RawOpenPr> => {
  const base = find(await page1(), 107)
  const earlier = base.recentCommits.nodes[0]?.commit.oid
  assert.ok(earlier)
  const review = base.latestReviews.nodes[0]
  assert.ok(review)
  return variant(base, { latestReviews: { nodes: [{ ...review, commit: { oid: earlier } }] } })
}

test('a review GitHub dropped from latestReviews on a re-request still counts: a moved head and a re-request is your move', async () => {
  const kept = await reRequestedOfViewer()
  const dropped = droppedByReRequest(kept, 'vera-quill')
  assert.deepEqual(dropped.latestReviews.nodes, [])
  assert.equal(dropped.latestOpinionatedReviews.nodes[0]?.state, 'CHANGES_REQUESTED')
  const found = othersRow(dropped)
  assert.equal(found.group, 'yourMove')
  // the pushes since the viewer's review are still counted, and the request is still flagged
  assert.deepEqual(found.flags, [
    { kind: 'reReview', label: 'Re-review · 1 push since yours', count: 1 },
    { kind: 'requestedOfYou', label: 'Requested of you' },
  ])
  // and the row is the same one the review would have made had GitHub kept it in latestReviews
  assert.deepEqual(found, othersRow(kept))
})

test('a dropped change request on an unmoved head with no re-request is still the author\'s turn', async () => {
  const kept = await reRequestedOfViewer()
  const head = kept.headRefOid
  const review = kept.latestReviews.nodes[0]
  assert.ok(review)
  const unmoved = variant(kept, {
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [{ ...review, commit: { oid: head } }] },
  })
  const dropped = droppedByReRequest(unmoved, 'vera-quill')
  assert.equal(othersRow(unmoved).group, 'waitingOnAuthor')
  assert.equal(othersRow(dropped).group, 'waitingOnAuthor')
  assert.deepEqual(othersRow(dropped).flags, [])
})

test('on yours, a change request only in latestOpinionatedReviews is answered by re-requesting that reviewer', async () => {
  const { asked } = await answered()
  const dropped = droppedByReRequest(asked, 'alex-mendez')
  assert.deepEqual(dropped.latestReviews.nodes.map((review) => review.author?.login), ['sam-tran'])
  const placed = (pr: RawOpenPr) => [mineOf(pr).group, mineOf(pr).stage]
  // not re-requested: still the viewer's move, with the reviewer named
  assert.deepEqual(placed(dropped), ['changesRequested', 'changesRequested'])
  assert.deepEqual(mineOf(dropped).changesRequested, { login: 'alex-mendez', alias: 'Alex', at: '2026-10-25T22:14:00Z' })
  // re-requested: the PR waits on its reviewer, as it would with the review in latestReviews
  assert.deepEqual(placed(requesting(dropped, 'alex-mendez')), ['awaitingReview', 'reReviewRequested'])
  assert.equal(mineOf(requesting(dropped, 'alex-mendez')).reviewers.find((pip) => pip.login === 'alex-mendez')?.state, 'requested')
  // a push past the review also answers it, by commit
  assert.deepEqual(placed(pushedPast(dropped)), ['awaitingReview', 'updatedNotRequested'])
})

test('latestReviewsOf keeps the newest review per reviewer across both connections', () => {
  const review = (login: string | null, state: RawOpenPr['latestReviews']['nodes'][number]['state'], submittedAt: string | null, oid = 'c1') =>
    ({ author: login === null ? null : { login }, state, submittedAt, commit: { oid } })
  const pr = (reviews: ReturnType<typeof review>[], opinionated: ReturnType<typeof review>[]): RawOpenPr =>
    ({ latestReviews: { nodes: reviews }, latestOpinionatedReviews: { nodes: opinionated } }) as RawOpenPr
  const summary = (value: RawOpenPr) => latestReviewsOf(value).map((found) => [found.author?.login, found.state, found.commit?.oid])

  // a later comment beats an earlier change request, and a later approval beats an earlier comment
  assert.deepEqual(summary(pr(
    [review('ana', 'COMMENTED', '2026-10-26T12:00:00Z', 'c2'), review('bo', 'APPROVED', '2026-10-26T12:00:00Z', 'c2')],
    [review('ana', 'CHANGES_REQUESTED', '2026-10-26T10:00:00Z', 'c1'), review('bo', 'APPROVED', '2026-10-26T12:00:00Z', 'c2')],
  )), [['ana', 'COMMENTED', 'c2'], ['bo', 'APPROVED', 'c2']])
  // the opinionated list wins when it holds the newer review
  assert.deepEqual(summary(pr(
    [review('ana', 'COMMENTED', '2026-10-26T10:00:00Z', 'c1')],
    [review('ana', 'APPROVED', '2026-10-26T12:00:00Z', 'c2')],
  )), [['ana', 'APPROVED', 'c2']])
  // a reviewer in only one list is kept, whichever, and logins match regardless of case
  assert.deepEqual(summary(pr(
    [review('Ana', 'COMMENTED', '2026-10-26T10:00:00Z')],
    [review('bo', 'CHANGES_REQUESTED', '2026-10-26T09:00:00Z'), review('ANA', 'APPROVED', '2026-10-26T11:00:00Z', 'c3')],
  )), [['ANA', 'APPROVED', 'c3'], ['bo', 'CHANGES_REQUESTED', 'c1']])
  // a tie keeps the review latestReviews reported
  assert.deepEqual(summary(pr(
    [review('ana', 'COMMENTED', '2026-10-26T10:00:00Z', 'c1')],
    [review('ana', 'APPROVED', '2026-10-26T10:00:00Z', 'c2')],
  )), [['ana', 'COMMENTED', 'c1']])
  // a review with no date loses to one with a date; two lists holding the same ghost review count it once
  assert.deepEqual(summary(pr(
    [review('ana', 'APPROVED', null)],
    [review('ana', 'CHANGES_REQUESTED', '2026-10-26T10:00:00Z')],
  )), [['ana', 'CHANGES_REQUESTED', 'c1']])
  assert.equal(latestReviewsOf(pr([review(null, 'APPROVED', '2026-10-26T10:00:00Z')], [review(null, 'APPROVED', '2026-10-26T10:00:00Z')])).length, 1)
  assert.deepEqual(summary(pr([], [])), [])
})
