// test/description-edit.test.ts
// a description edit by the PR's author after the relevant review counts as an update, the way a push does (section 5 of DESIGN.md)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openCache } from '../src/cache.ts'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { deriveLastActivity, deriveOpenRow } from '../src/derive.ts'
import type { DeriveContext, MineRow, OtherRow } from '../src/derive.ts'
import { createGh, fetchClosedPrs, fetchOpenPrs } from '../src/github.ts'
import type { RawOpenPr } from '../src/github.ts'
import { scenario } from './fixtures/scenario.ts'
import { fakeRunner, field, fixtureRunner, ok, openPage1, openPage2 } from './helpers.ts'

const config: Config = {
  ...defaultConfig(),
  repo: scenario.repo,
  viewer: scenario.viewer,
  people: [
    { login: 'vera-quill', alias: 'Vera', initials: 'VQ', color: '#1D4ED8', avatar: 'initials' },
    { login: 'alex-mendez', alias: 'Alex', initials: 'AL', color: '#0F766E', avatar: 'github' },
    { login: 'sam-tran', alias: 'Sam', initials: 'ST', color: '#7C3AED', avatar: 'initials' },
    { login: 'lee-park', alias: 'Lee', initials: 'LP', color: '#BE123C', avatar: 'initials' },
  ],
}
const ctx: DeriveContext = { config, clock: { now: () => Date.parse(scenario.now) }, timeZone: scenario.timeZone }

const allOpen = async (): Promise<RawOpenPr[]> => [...(await openPage1()).data.repository?.pullRequests.nodes ?? [], ...(await openPage2()).data.repository?.pullRequests.nodes ?? []]
const fixturePr = async (number: number): Promise<RawOpenPr> => {
  const found = (await allOpen()).find((pr) => pr.number === number)
  assert.ok(found, `#${number} is missing`)
  return structuredClone(found)
}

// the PR with its description last edited by editor at the given time
const editedBy = (pr: RawOpenPr, editor: string | null, at: string): RawOpenPr => ({
  ...structuredClone(pr),
  lastEditedAt: at,
  userContentEdits: { nodes: [{ createdAt: at, editor: editor === null ? null : { login: editor } }] },
})

const others = (pr: RawOpenPr): OtherRow => {
  const row = deriveOpenRow(pr, ctx, new Map())
  assert.equal(row?.section, 'others')
  return row as OtherRow
}
const mine = (pr: RawOpenPr): MineRow => {
  const row = deriveOpenRow(pr, ctx, new Map())
  assert.equal(row?.section, 'mine')
  return row as MineRow
}

// #118: author alex-mendez, the viewer requested changes at the head at 2026-10-26T13:50:04Z, so it waits on the author
const afterChanges = '2026-10-26T14:10:00Z'
const beforeChanges = '2026-10-26T13:00:00Z'

test('changes requested by the viewer: the author\'s description edit after the review moves the PR to Your move, no other edit does', async () => {
  const base = await fixturePr(118)
  assert.equal(others(base).group, 'waitingOnAuthor')
  assert.equal(others(editedBy(base, 'alex-mendez', afterChanges)).group, 'yourMove')
  assert.equal(others(editedBy(base, 'Alex-Mendez', afterChanges)).group, 'yourMove')
  // before the review, the review already saw it
  assert.equal(others(editedBy(base, 'alex-mendez', beforeChanges)).group, 'waitingOnAuthor')
  // the viewer and a third person are not the author
  assert.equal(others(editedBy(base, 'vera-quill', afterChanges)).group, 'waitingOnAuthor')
  assert.equal(others(editedBy(base, 'sam-tran', afterChanges)).group, 'waitingOnAuthor')
  // an edit by an account GitHub no longer knows is nobody's
  assert.equal(others(editedBy(base, null, afterChanges)).group, 'waitingOnAuthor')
  // a row with an edit time but no edit record cannot say who edited
  assert.equal(others({ ...structuredClone(base), lastEditedAt: afterChanges, userContentEdits: { nodes: [] } }).group, 'waitingOnAuthor')
})

test('conflicts, failing CI, and CI not run keep the PR waiting on the author whatever was edited', async () => {
  const edited = editedBy(await fixturePr(118), 'alex-mendez', afterChanges)
  assert.equal(others(edited).group, 'yourMove')
  assert.equal(others({ ...structuredClone(edited), mergeable: 'CONFLICTING' }).group, 'waitingOnAuthor')
  const failing = structuredClone(edited)
  failing.headCommit.nodes[0]!.commit.statusCheckRollup = {
    contexts: { totalCount: 1, nodes: [{ __typename: 'StatusContext', context: 'build', state: 'FAILURE', targetUrl: null }] },
  } as never
  assert.equal(others(failing).group, 'waitingOnAuthor')
})

test('reviewed at the head with nothing new: the author\'s description edit after the review is something new', async () => {
  // #116: the viewer commented at the head at 2026-10-24T13:00:00Z; lee-park is the author
  const base = await fixturePr(116)
  assert.equal(others(base).group, 'waitingOnAuthor')
  assert.deepEqual(others(base).flags, [])
  assert.equal(others(editedBy(base, 'lee-park', '2026-10-24T14:00:00Z')).group, 'yourMove')
  assert.equal(others(editedBy(base, 'lee-park', '2026-10-24T12:00:00Z')).group, 'waitingOnAuthor')
  assert.equal(others(editedBy(base, 'vera-quill', '2026-10-24T14:00:00Z')).group, 'waitingOnAuthor')
  assert.equal(others(editedBy(base, 'sam-tran', '2026-10-24T14:00:00Z')).group, 'waitingOnAuthor')
  // the same moment as the review is not after it
  assert.equal(others(editedBy(base, 'lee-park', '2026-10-24T13:00:00Z')).group, 'waitingOnAuthor')
})

test('the Re-review flag names the description edit, with no push count or commit SHA when only the description changed', async () => {
  const edit = '2026-10-24T14:00:00Z'
  const only = others(editedBy(await fixturePr(116), 'lee-park', edit))
  assert.deepEqual(only.flags, [{ kind: 'reReview', label: 'Re-review · description edited since yours' }])
  // not the author's edit: no flag
  assert.deepEqual(others(editedBy(await fixturePr(116), 'sam-tran', edit)).flags, [])
  assert.deepEqual(others(editedBy(await fixturePr(116), 'lee-park', '2026-10-24T12:00:00Z')).flags, [])
  // #106: two pushes since the viewer's review of 2026-10-22T10:30:00Z, by alex-mendez
  const pushed = await fixturePr(106)
  const plain = others(pushed).flags[0]
  assert.equal(plain?.kind, 'reReview')
  assert.equal(plain?.label, 'Re-review · 2 pushes since yours')
  const both = others(editedBy(pushed, 'alex-mendez', '2026-10-23T08:00:00Z')).flags[0]
  assert.deepEqual(both, { ...plain, label: 'Re-review · 2 pushes since yours and the description edited' })
  assert.equal(others(editedBy(pushed, 'sam-tran', '2026-10-23T08:00:00Z')).flags[0]?.label, 'Re-review · 2 pushes since yours')
  // #107: the review's commit is outside the window, so the push count is unknown
  const lost = others(editedBy(await fixturePr(107), 'sam-tran', '2026-10-24T08:00:00Z')).flags[0]
  assert.deepEqual(lost, { kind: 'reReview', label: 'Re-review · new commits and the description edited' })
})

// #101 is the viewer's own PR; alex-mendez requested changes at the head at 2026-10-25T22:14:00Z
test('mine: the author\'s description edit after the changes request answers it, the way a push does', async () => {
  const asked = await fixturePr(101)
  const placed = (pr: RawOpenPr) => [mine(pr).group, mine(pr).stage]
  assert.deepEqual(placed(asked), ['changesRequested', 'changesRequested'])
  assert.deepEqual(placed(editedBy(asked, 'vera-quill', '2026-10-26T09:00:00Z')), ['awaitingReview', 'updatedNotRequested'])
  assert.deepEqual(placed(editedBy(asked, 'vera-quill', '2026-10-25T20:00:00Z')), ['changesRequested', 'changesRequested'])
  assert.deepEqual(placed(editedBy(asked, 'alex-mendez', '2026-10-26T09:00:00Z')), ['changesRequested', 'changesRequested'])
  assert.deepEqual(placed(editedBy(asked, null, '2026-10-26T09:00:00Z')), ['changesRequested', 'changesRequested'])
  // re-requested wins when both hold
  const reRequested = { ...editedBy(asked, 'vera-quill', '2026-10-26T09:00:00Z'), reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User' as const, login: 'alex-mendez' } }] } }
  assert.deepEqual(placed(reRequested), ['awaitingReview', 'reReviewRequested'])
  // a draft stays a draft
  assert.deepEqual(placed({ ...editedBy(asked, 'vera-quill', '2026-10-26T09:00:00Z'), isDraft: true }), ['drafts', 'draft'])
})

test('last activity lists the description edit among the events, in time order, linking to the PR', async () => {
  // #109: its newest timeline event is lee-park's push
  const base = await fixturePr(109)
  assert.equal(deriveLastActivity(base, config).text, 'Lee pushed 1 commit')
  const newest = deriveLastActivity(editedBy(base, 'lee-park', '2026-10-26T12:30:00Z'), config)
  assert.deepEqual(newest, { at: '2026-10-26T12:30:00Z', actor: 'Lee', text: 'Lee edited the description', anchor: null })
  assert.equal(deriveLastActivity(editedBy(base, 'vera-quill', '2026-10-26T12:30:00Z'), config).text, 'You edited the description')
  assert.equal(deriveLastActivity(editedBy(base, 'sam-tran', '2026-10-26T12:30:00Z'), config).text, 'Sam edited the description')
  // an older edit is not the latest event
  assert.equal(deriveLastActivity(editedBy(base, 'lee-park', '2026-10-20T12:30:00Z'), config).text, 'Lee pushed 1 commit')
  // an edit long before the push leaves the push as the latest event
  assert.equal(deriveLastActivity(editedBy(base, 'lee-park', '2026-10-01T00:00:00Z'), config).text, 'Lee pushed 1 commit')
  // an edit by an account GitHub no longer knows is named the way every actor-less event is
  assert.equal(deriveLastActivity(editedBy(base, null, '2026-10-26T12:30:00Z'), config).text, 'Someone edited the description')
})

test('a PR from before the fields has no edit: every rule reads as it did', async () => {
  for (const number of [118, 116, 106, 101, 109]) {
    const old = await fixturePr(number)
    assert.equal('userContentEdits' in old, false)
    assert.equal(deriveLastActivity(old, config).text.includes('description'), false)
  }
  assert.equal(others(await fixturePr(118)).group, 'waitingOnAuthor')
  assert.equal(others(await fixturePr(116)).group, 'waitingOnAuthor')
  assert.deepEqual(mine(await fixturePr(101)).stage, 'changesRequested')
  // GitHub's own nulls: never edited
  const never = { ...await fixturePr(118), lastEditedAt: null, userContentEdits: { nodes: [] } }
  assert.equal(others(never).group, 'waitingOnAuthor')
})

// the real caller: the query fetchOpenPrs sends, the page it hands back, the cached row, and the row derived from it
test('the open list asks GitHub for the description edit and the cached row derives from what came back', async () => {
  const base = fixtureRunner()
  const edit = { createdAt: afterChanges, editor: { login: 'alex-mendez' } }
  const fake = fakeRunner(async (args) => {
    if (args[0] === 'api' && args[1] === 'graphql' && (field(args, 'query') ?? '').includes('query OpenPullRequests') && field(args, 'after') === undefined) {
      const page = await openPage1()
      const target = page.data.repository?.pullRequests.nodes.find((node) => node.number === 118)
      assert.ok(target)
      Object.assign(target, { lastEditedAt: afterChanges, userContentEdits: { nodes: [edit] } })
      return ok(JSON.stringify(page))
    }
    return base.runner(args, undefined)
  })
  const cache = openCache({ path: ':memory:', clock: { now: () => Date.parse(scenario.now) } })
  const cycle = cache.startCycle(scenario.repo, 'manual')
  await fetchOpenPrs(createGh(fake.runner), scenario.repo, (page) => { cache.writeOpenPage(cycle.id, page) }, { pageSize: scenario.pageSize })
  cache.writeClosed(cycle.id, await fetchClosedPrs(createGh(fake.runner), scenario.repo, scenario.yesterdayFrom, scenario.now))
  cache.finishCycle(cycle.id)
  const query = fake.calls.map((call) => field(call.args, 'query') ?? '').find((text) => text.includes('query OpenPullRequests')) ?? ''
  assert.match(query, /\blastEditedAt\b/)
  assert.match(query, /userContentEdits\(first: 1\) \{ nodes \{ createdAt editor \{ login \} \} \}/)
  const cached = cache.readView(scenario.repo).open.find((row) => row.number === 118)
  assert.ok(cached)
  assert.equal(others(cached.pr).group, 'yourMove')
  assert.deepEqual(others(cached.pr).flags, [{ kind: 'reReview', label: 'Re-review · description edited since yours' }])
  assert.equal(others(cached.pr).lastActivity.text, 'Alex edited the description')
  // a PR whose page carried no edit fields is unchanged
  const plain = cache.readView(scenario.repo).open.find((row) => row.number === 116)
  assert.ok(plain)
  assert.equal(others(plain.pr).group, 'waitingOnAuthor')
})
