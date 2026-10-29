// test/ui-actions.test.ts
// the drawer's direct actions (public/actionsview.ts and their place in public/drawerview.ts and
// public/drawer.ts): what each row offers, the confirmation that must come before any request,
// the request that follows it, and the words for a refusal
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { OpenRow } from '../src/derive.ts'
import {
  actionConfirmModel, actionDoneText, actionHolds, actionOffers, actionRefusalText, actionRequest, reviewerChoices,
} from '../public/actionsview.ts'
import type { ActionConfirm, PersonChoice } from '../public/actionsview.ts'
import { confirmHolds, drawerModel, escapeTarget } from '../public/drawerview.ts'
import type { DrawerInput } from '../public/drawerview.ts'

const people: PersonChoice[] = [
  { login: 'alex-mendez', alias: 'Alex' },
  { login: 'sam-tran', alias: 'Sam' },
  { login: 'vera-quill', alias: 'You' },
]

const mine = (mergeState: string, patch: Record<string, unknown> = {}): OpenRow => ({
  number: 101,
  section: 'mine',
  url: 'https://example.test/owner/name/pull/101',
  title: 'fix(retry): back off between attempts',
  author: { login: 'vera-quill', alias: 'You' },
  headRef: 'fix/retry', baseRef: 'main', headOid: '755b78b2c4e1f0a9d3b6e8c7a5f4d2e1b0c9a8f7',
  merge: { state: mergeState, label: mergeState },
  agent: null,
  ...patch,
} as unknown as OpenRow)

const others = (): OpenRow => mine('ready', { section: 'others', author: { login: 'alex-mendez', alias: 'Alex' } })

const input = (row: OpenRow, patch: Partial<DrawerInput> = {}): DrawerInput => ({
  row, open: true, runs: { state: 'loading' }, reports: { state: 'loading' }, confirm: null, people, ...patch,
})

test('only the viewer\'s own open PRs offer actions: Merge when ready, Mark ready on a draft, Convert to draft otherwise, and Request review', () => {
  assert.deepEqual(actionOffers(mine('draft'), true).map((offer) => [offer.action, offer.text]), [
    ['markReady', 'Mark ready for review'], ['requestReview', 'Request review'],
  ])
  for (const state of ['needsReview', 'needsApproval', 'checking', 'blocked']) {
    assert.deepEqual(actionOffers(mine(state), true).map((offer) => offer.action), ['convertToDraft', 'requestReview'], state)
  }
  // merge is offered in the ready state only, and never on a draft
  assert.deepEqual(actionOffers(mine('ready'), true).map((offer) => [offer.action, offer.text]), [
    ['merge', 'Squash and merge'], ['convertToDraft', 'Convert to draft'], ['requestReview', 'Request review'],
  ])
  assert.ok(!actionOffers(mine('draft'), true).some((offer) => offer.action === 'merge'))
  // nothing is offered on someone else's PR, even a ready one, or one that left the open tables
  assert.deepEqual(actionOffers(others(), true), [])
  assert.deepEqual(actionOffers(mine('ready'), false), [])
  assert.deepEqual(actionOffers(mine('draft'), false), [])
})

test('nothing is asked or sent until a click opens the confirmation: the drawer starts with offers and no ask', () => {
  const model = drawerModel(input(mine('draft')))
  assert.equal(model.actions.length, 2)
  assert.equal(model.actionAsk, null)
  assert.equal(model.confirm, null)
  assert.equal(model.stop, null)
  // an Others' row has no Actions section at all
  assert.deepEqual(drawerModel(input(others())).actions, [])
})

test('the confirmation names the PR and the action, and says what happens on GitHub', () => {
  const draft = mine('draft')
  const markReady = drawerModel(input(draft, { confirm: { type: 'action', action: 'markReady', reviewer: '' } })).actionAsk
  assert.ok(markReady !== null)
  assert.equal(markReady.heading, 'Mark #101 ready for review?')
  assert.equal(markReady.title, 'fix(retry): back off between attempts')
  assert.match(markReady.effect, /out of draft under your account/)
  assert.equal(markReady.confirm, 'Mark ready')
  assert.equal(markReady.reviewers, null)

  const merge = actionConfirmModel(mine('ready', { baseRef: 'release' }), { type: 'action', action: 'merge', reviewer: '' }, people)
  assert.equal(merge?.heading, 'Squash and merge #101 into release?')
  assert.equal(merge?.title, 'fix(retry): back off between attempts')
  assert.match(merge?.effect ?? '', /Squashes the PR into one commit on release under your account/)
  assert.match(merge?.effect ?? '', /head branch is not deleted/)
  assert.equal(merge?.confirm, 'Squash and merge')
  assert.equal(merge?.reviewers, null)
  // a state other than ready has no merge confirmation
  for (const state of ['draft', 'blocked', 'needsReview', 'needsApproval', 'checking']) {
    assert.equal(actionConfirmModel(mine(state), { type: 'action', action: 'merge', reviewer: '' }, people), null, state)
  }

  const convert = actionConfirmModel(mine('ready'), { type: 'action', action: 'convertToDraft', reviewer: '' }, people)
  assert.equal(convert?.heading, 'Convert #101 to a draft?')
  assert.match(convert?.effect ?? '', /cannot be merged until it is marked ready again/)
  assert.equal(convert?.confirm, 'Convert to draft')

  const review = actionConfirmModel(mine('ready'), { type: 'action', action: 'requestReview', reviewer: 'sam-tran' }, people)
  assert.equal(review?.heading, 'Request a review on #101?')
  assert.equal(review?.reviewer, 'sam-tran')
  assert.match(review?.effect ?? '', /Sam \(@sam-tran\)/)
  assert.equal(review?.confirm, 'Request review')
})

test('a review request chooses from people, never the PR\'s author; a stale choice falls back to the first listed', () => {
  assert.deepEqual(reviewerChoices(mine('ready'), people).map((person) => person.login), ['alex-mendez', 'sam-tran'])
  const ask: ActionConfirm = { type: 'action', action: 'requestReview', reviewer: 'gone-from-people' }
  const model = actionConfirmModel(mine('ready'), ask, people)
  assert.equal(model?.reviewer, 'alex-mendez')
  assert.deepEqual(model?.reviewers?.map((choice) => choice.label), ['Alex (@alex-mendez)', 'Sam (@sam-tran)'])
  // with no one else listed, there is nothing to send and the model says so
  const empty = actionConfirmModel(mine('ready'), ask, [{ login: 'vera-quill', alias: 'You' }])
  assert.equal(empty?.reviewer, '')
  assert.match(empty?.effect ?? '', /Add reviewers in Settings/)
})

test('an action the row no longer offers has no confirmation, and the open one is dropped when it stops holding', () => {
  const markReady: ActionConfirm = { type: 'action', action: 'markReady', reviewer: '' }
  assert.equal(actionConfirmModel(mine('ready'), markReady, people), null)
  assert.equal(actionConfirmModel(others(), { type: 'action', action: 'requestReview', reviewer: 'sam-tran' }, people), null)
  const merge: ActionConfirm = { type: 'action', action: 'merge', reviewer: '' }
  assert.equal(actionHolds(merge, mine('ready'), true), true)
  // a patch moved the PR out of ready, or it left the open tables: the merge confirmation is dropped
  assert.equal(actionHolds(merge, mine('blocked'), true), false)
  assert.equal(actionHolds(merge, mine('ready'), false), false)
  assert.equal(actionHolds(markReady, mine('draft'), true), true)
  // a patch took the draft out of draft, the PR left the open tables, or it is no longer the viewer's
  assert.equal(actionHolds(markReady, mine('ready'), true), false)
  assert.equal(actionHolds(markReady, mine('draft'), false), false)
  assert.equal(actionHolds(markReady, others(), true), false)
  // the run-based check does not judge an action: actionHolds does
  assert.equal(confirmHolds(markReady, null, true), true)
})

test('a request is built only from a confirmation, with the token header and exactly the fields the server takes', () => {
  const ready = actionRequest(101, { type: 'action', action: 'markReady', reviewer: 'ignored' }, 'tok')
  assert.equal(ready.url, '/api/prs/101/actions')
  assert.equal(ready.init.method, 'POST')
  assert.deepEqual(ready.init.headers, { 'Content-Type': 'application/json', 'X-Pit-View-Token': 'tok' })
  assert.deepEqual(JSON.parse(ready.init.body ?? ''), { action: 'markReady' })
  // a merge sends the action alone: the method is the server's, never the page's
  assert.deepEqual(JSON.parse(actionRequest(102, { type: 'action', action: 'merge', reviewer: 'ignored' }, 'tok').init.body ?? ''), { action: 'merge' })
  assert.deepEqual(JSON.parse(actionRequest(101, { type: 'action', action: 'convertToDraft', reviewer: '' }, 'tok').init.body ?? ''), { action: 'convertToDraft' })
  assert.deepEqual(JSON.parse(actionRequest(7, { type: 'action', action: 'requestReview', reviewer: 'sam-tran' }, 'tok').init.body ?? ''), { action: 'requestReview', reviewer: 'sam-tran' })
})

test('a refusal is the server\'s message as a sentence, a reload for the token, and a plain line when Pit View is down', () => {
  assert.equal(actionRefusalText(403, 'missing or wrong Pit View token; reload the page'), 'Reload the page to act on PRs: Pit View has restarted since this page loaded.')
  assert.equal(actionRefusalText(0, null), 'Pit View did not answer. Check that it is running, then try again.')
  assert.equal(actionRefusalText(422, '#101 is not a draft'), '#101 is not a draft.')
  assert.equal(actionRefusalText(502, 'gh pr failed: GraphQL: not allowed'), 'gh pr failed: GraphQL: not allowed.')
  assert.equal(actionRefusalText(500, null), 'Pit View refused with status 500.')
})

test('the done line names the PR and says the row is refreshing', () => {
  assert.equal(actionDoneText(101, { type: 'action', action: 'merge', reviewer: '' }, people), '#101: squash merged. The row is refreshing.')
  assert.equal(actionDoneText(101, { type: 'action', action: 'markReady', reviewer: '' }, people), '#101: marked ready for review. The row is refreshing.')
  assert.equal(actionDoneText(101, { type: 'action', action: 'convertToDraft', reviewer: '' }, people), '#101: converted to a draft. The row is refreshing.')
  assert.equal(actionDoneText(101, { type: 'action', action: 'requestReview', reviewer: 'sam-tran' }, people), '#101: review requested from Sam. The row is refreshing.')
})

test('Escape cancels an action\'s confirmation before closing the drawer, and not while its request is on its way', () => {
  assert.equal(escapeTarget({ report: false, confirm: true, busy: false, drawer: true }), 'confirm')
  assert.equal(escapeTarget({ report: false, confirm: true, busy: true, drawer: true }), null)
})

// the page cannot be run here, so the wiring is checked in the source: a button click only asks,
// and the one place that sends is the confirmation's own Confirm button
test('in drawer.ts an action button only asks, and the request is sent from one place, behind the confirmation', async () => {
  const source = await readFile(join(import.meta.dirname, '..', 'public', 'drawer.ts'), 'utf8')
  assert.match(source, /button\.addEventListener\('click', \(\) => void askAction\(offer\.action\)\)/)
  assert.equal(source.split('actionRequest(').length - 1, 1, 'one call builds the action request')
  const send = source.indexOf('actionRequest(')
  assert.ok(source.lastIndexOf('const doAction', send) > source.lastIndexOf('const askAction', send), 'it is inside doAction')
  assert.match(source, /confirmActions\(ask\.confirm, 'primary', \(\) => void doAction\(\)\)/)
  // doAction sends only an open action confirmation
  assert.match(source, /if \(busy \|\| confirm\?\.type !== 'action' \|\| number === null\) return/)
})
