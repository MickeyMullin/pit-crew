// test/ui-anchors.test.ts
// the links from Last activity and from "push since yours" to the GitHub event they describe: built from a plain owner/name repository, a PR number, and a digits-only or hex-only id, and null for anything else, so the page falls back to the PR URL
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activityHref, changesRequestedHref, pullHref, pushHref, reReviewHref } from '../public/anchors.ts'
import { safeHref } from '../public/safeurl.ts'

const repo = 'octo-example/orbit'
const pr = 'https://github.com/octo-example/orbit/pull/101'

test('a comment, a review and a commit link to their GitHub anchors', () => {
  assert.equal(activityHref({ kind: 'comment', id: '4400123' }, repo, 101), `${pr}#issuecomment-4400123`)
  assert.equal(activityHref({ kind: 'review', id: '5500456' }, repo, 101), `${pr}#pullrequestreview-5500456`)
  assert.equal(activityHref({ kind: 'commit', id: 'ABCDEF1234' }, repo, 101), `${pr}/commits/abcdef1234`)
  assert.equal(pushHref('9f8e7d6', repo, 101), `${pr}/commits/9f8e7d6`)
  assert.equal(safeHref(pushHref('9f8e7d6', repo, 101)), `${pr}/commits/9f8e7d6`)
})

test('an unknown id, a bad id, a bad repository or a bad number gives null, so the PR URL is used', () => {
  assert.equal(activityHref(null, repo, 101), null)
  assert.equal(activityHref(undefined, repo, 101), null)
  assert.equal(pushHref(undefined, repo, 101), null)
  assert.equal(activityHref({ kind: 'comment', id: '12x' }, repo, 101), null)
  assert.equal(activityHref({ kind: 'review', id: '' }, repo, 101), null)
  assert.equal(activityHref({ kind: 'commit', id: 'zzzzzzz' }, repo, 101), null)
  assert.equal(activityHref({ kind: 'commit', id: 'abc12' }, repo, 101), null)
  assert.equal(pushHref('9f8e7d6/../x', repo, 101), null)
  assert.equal(activityHref({ kind: 'comment', id: '1' }, undefined, 101), null)
  assert.equal(activityHref({ kind: 'comment', id: '1' }, 'not a repo', 101), null)
  assert.equal(activityHref({ kind: 'comment', id: '1' }, '../..', 101), null)
  assert.equal(activityHref({ kind: 'comment', id: '1' }, 'a/b/c', 101), null)
  assert.equal(activityHref({ kind: 'comment', id: '1' }, repo, 0), null)
  assert.equal(activityHref({ kind: 'comment', id: '1' }, repo, 1.5), null)
  assert.equal(activityHref({ kind: 'unknown', id: '1' } as never, repo, 101), null)
})

test('the Re-review flag links to the first commit after the review, and to the PR URL when there is none to name', () => {
  assert.equal(reReviewHref('9f8e7d6', repo, 101, pr), `${pr}/commits/9f8e7d6`)
  assert.equal(reReviewHref(undefined, repo, 101, pr), pr)
  assert.equal(reReviewHref(null, repo, 101, pr), pr)
  assert.equal(reReviewHref('9f8e7d6/../x', repo, 101, pr), pr)
  assert.equal(reReviewHref('9f8e7d6', 'not a repo', 101, pr), pr)
})

test('the Changes requested banner and chip link to the review that requested changes, and to the PR URL when its id is unknown', () => {
  const review = { kind: 'review', id: '5500456' } as const
  assert.equal(changesRequestedHref(review, repo, 101, pr), `${pr}#pullrequestreview-5500456`)
  assert.equal(safeHref(changesRequestedHref(review, repo, 101, pr)), `${pr}#pullrequestreview-5500456`)
  assert.equal(changesRequestedHref(null, repo, 101, pr), pr)
  assert.equal(changesRequestedHref(undefined, repo, 101, pr), pr)
  assert.equal(changesRequestedHref({ kind: 'review', id: '12x' }, repo, 101, pr), pr)
  assert.equal(changesRequestedHref(review, undefined, 101, pr), pr)
})

test('the PR a based-on indication names links to its page, and a repository or number that is not plain gives null, so the indication stays text', () => {
  assert.equal(pullHref(repo, 110), 'https://github.com/octo-example/orbit/pull/110')
  assert.equal(safeHref(pullHref(repo, 110)), 'https://github.com/octo-example/orbit/pull/110')
  assert.equal(pullHref(undefined, 110), null)
  assert.equal(pullHref('not a repo', 110), null)
  assert.equal(pullHref('../..', 110), null)
  assert.equal(pullHref(repo, 0), null)
  assert.equal(pullHref(repo, 1.5), null)
})
