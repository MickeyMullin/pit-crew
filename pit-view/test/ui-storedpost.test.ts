// test/ui-storedpost.test.ts
// the post button on an auto-review run that finished without posting (section 10, Posting), driven through the real public/drawer.ts against the fake document in test/fake-dom.ts: the button for each recommendation, none where there is nothing to post, the confirmation with the form, the login, the CI state, and the moved-head sentence, Cancel, Post, the third button that starts a review instead, refusals, and the request's token. Every expected value is a literal written out here, not taken from the code under test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { OpenRow } from '../src/derive.ts'
import type { AgentCell, RunView } from '../public/agent.ts'
import { createDrawer } from '../public/drawer.ts'
import { confirmHolds, drawerModel } from '../public/drawerview.ts'
import type { Confirm } from '../public/drawerview.ts'
import { installFakeBrowser, press } from './fake-dom.ts'
import type { FakeElement } from './fake-dom.ts'

type Sent = { url: string, method: string, headers: Record<string, string>, body: Record<string, unknown> | null }
type Offer = NonNullable<AgentCell['storedOffer']>

const head = '755b78b2c4e1f0a9d3b6e8c7a5f4d2e1b0c9a8f7'
const earlier = '3a91c0de5f4b7a6e8d2c1b0a9f8e7d6c5b4a3f21'
const repo = 'octo-example/orbit'

const answer = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const offerOf = (patch: Partial<Offer> = {}): Offer => ({
  runId: 7,
  forms: ['approve', 'comment'],
  report: 'PR-101.md',
  reportPath: '~/agents/output/PR-101.md',
  reviewedSha: head,
  headSha: head,
  repo,
  viewer: 'viewer',
  ci: 'green',
  commands: {
    approve: `gh pr review 101 --repo ${repo} --approve --body-file ~/agents/output/PR-101.md`,
    requestChanges: `gh pr review 101 --repo ${repo} --request-changes --body-file ~/agents/output/PR-101.md`,
    comment: `gh pr comment 101 --repo ${repo} --body-file ~/agents/output/PR-101.md`,
  },
  ...patch,
})

const cellOf = (storedOffer: Offer | null): AgentCell => ({
  state: 'done',
  label: 'Review',
  action: { kind: 'reReview', label: 'Re-review', command: 'review-pr', args: ['101'], runner: 'claude' },
  starts: [{
    kind: 'default', label: 'Re-review', button: 'Re-review PR', command: 'review-pr', args: ['101'], runners: ['claude', 'codex'],
    posts: { kind: 'review', text: 'Posts its report to the PR as @viewer: an approval, a request for changes, or a comment, per the findings.' },
    repo, viewer: 'viewer', unavailable: null, extraInstructions: { standing: '', flag: '--extra-instructions' },
  }],
  models: { claude: 'Sonnet', codex: 'Codex default' },
  lastReviewAt: null,
  runId: 7, runner: 'claude', command: 'review-pr', args: ['101', '--no-post'], status: 'done', startedAt: '2026-10-28T14:00:00Z', lastStepAt: null, step: null,
  steps: [], tandem: false, commit: head, extraInstructions: null, origin: 'auto', queuedAt: '2026-10-28T13:59:00Z', posted: false,
  finishedAt: '2026-10-28T14:05:00Z', text: 'Clean · not posted', result: { kind: 'review', verdict: 'clean', recommendation: null, findings: 0, ci: 'green', posted: null, notPostedReason: 'noPost', report: '~/agents/output/PR-101.md' },
  question: null, note: null, firstNote: null, resolvedByHand: false, resume: null, costUsd: null, postOffer: null, storedOffer, stackRun: null,
} as unknown as AgentCell)

const runOf = (patch: Record<string, unknown> = {}, result: Record<string, unknown> = {}): RunView => ({
  id: 7, repo, number: 101, command: 'review-pr', args: ['101', '--no-post'], label: 'Review', runner: 'claude', cwd: '~/dev/orbit', dir: '~/runs/7', sessionId: null, pid: 4001, pidStartedAt: null,
  startedAt: '2026-10-28T14:00:00Z', lastStepAt: null, step: null, stepState: null, steps: [], tandem: false, finishedAt: '2026-10-28T14:05:00Z', status: 'done', note: null, costUsd: null, resume: null,
  resolvedByHand: false, firstNote: null, extraInstructions: null, reportHash: 'c'.repeat(64), postAttemptedAt: null, origin: 'auto', tick: 3, reason: 'requested', queuedAt: '2026-10-28T13:59:00Z', headOid: head.slice(0, 7), posting: false,
  result: {
    schema: 'pit-crew/review-result@1', command: 'review-pr', status: 'done', target: { repo, pr: 101 }, reviewed: { kind: 'commit', sha: head }, verdict: 'clean', recommendation: null, findings: [], ci: 'green',
    fixAttempts: 0, posted: null, notPostedReason: 'noPost', report: '~/agents/output/PR-101.md', question: null, error: null, ...result,
  },
  ...patch,
} as unknown as RunView)

const rowOf = (agent: AgentCell): OpenRow => ({
  number: 101,
  url: 'https://example.test/owner/name/pull/101',
  title: 'fix(retry): back off between attempts',
  author: { login: 'alex-mendez', alias: 'Alex' },
  headRef: 'fix/retry', baseRef: 'main', headOid: head, headSha: head,
  agent,
} as unknown as OpenRow)

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

type Page = {
  root: FakeElement
  sent: Sent[]
  said: string[]
  buttons: () => string[]
  confirmButtons: () => string[]
  button: (text: string) => FakeElement
  text: () => string
  error: () => string
  posts: () => Sent[]
  // every POST the page has sent
  writes: () => Sent[]
}

// the real drawer on the fake page with the PR's runs read; fetch records what the page sends and answers the post and the start as the test says
const withPage = async (agent: AgentCell, runs: RunView[], check: (page: Page) => Promise<void>, replies: { post?: Response, start?: Response } = {}): Promise<void> => {
  const sent: Sent[] = []
  const said: string[] = []
  const fake = installFakeBrowser((async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    sent.push({ url: String(input), method, headers: (init?.headers ?? {}) as Record<string, string>, body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null })
    if (method === 'POST' && String(input).endsWith('/post')) return replies.post ?? answer(200, { number: 101, runId: 7, posted: { form: 'approve', url: 'https://example.test/owner/name/pull/101' }, run: null })
    if (method === 'POST') return replies.start ?? answer(200, { id: 9 })
    return String(input).endsWith('/runs') ? answer(200, runs) : answer(200, [])
  }) as typeof fetch)
  try {
    const root = fake.document.createElement('aside')
    fake.document.body.appendChild(root)
    const drawer = createDrawer({
      root: root as unknown as HTMLElement,
      token: 'token-1',
      nowMs: () => Date.parse('2026-10-28T15:00:00Z'),
      rowOf: (number) => number === 101 ? rowOf(agent) : undefined,
      repo: () => repo,
      viewer: () => 'viewer',
      say: (text) => said.push(text),
      reports: { open: () => undefined, close: () => undefined, isOpen: () => false, refresh: () => undefined },
      sweepLink: () => null,
      openSweep: () => undefined,
    })
    drawer.open(101, { key: 'agent:101', number: 101 }, 'default')
    await settle()
    await settle()
    sent.length = 0
    const names = (list: FakeElement[]): string[] => list.map((element) => element.textContent)
    await check({
      root,
      sent,
      said,
      buttons: () => names(root.querySelectorAll('[data-stored-form]')),
      confirmButtons: () => names(root.querySelector('.confirm-actions')?.children ?? []),
      button: (text) => {
        const found = root.querySelectorAll('button').find((element) => element.textContent === text)
        assert.ok(found !== undefined, `a button named ${text}`)
        return found
      },
      text: () => root.textContent,
      error: () => root.querySelector('#drawer-error')?.textContent ?? '',
      posts: () => sent.filter((request) => request.method === 'POST' && request.url.endsWith('/post')),
      writes: () => sent.filter((request) => request.method === 'POST'),
    })
  } finally {
    fake.restore()
  }
}

test('the drawer shows a button for the report\'s recommendation and Comment, and Comment alone for a comment', async () => {
  await withPage(cellOf(offerOf()), [runOf()], async (page) => {
    assert.deepEqual(page.buttons(), ['Approve', 'Comment'])
  })
  await withPage(cellOf(offerOf({ forms: ['requestChanges', 'comment'] })), [runOf({}, { verdict: 'changesRequested' })], async (page) => {
    assert.deepEqual(page.buttons(), ['Request Changes', 'Comment'])
  })
  await withPage(cellOf(offerOf({ forms: ['comment'] })), [runOf()], async (page) => {
    assert.deepEqual(page.buttons(), ['Comment'])
  })
})

test('the buttons sit in the Auto-review list under the run that did not post, and nowhere else', async () => {
  await withPage(cellOf(offerOf()), [runOf()], async (page) => {
    const section = page.root.querySelector('#drawer-auto-runs')?.parentNode
    assert.ok(section !== null && section !== undefined)
    assert.match(page.text(), /Not posted: set to not post/)
    assert.equal(section.querySelectorAll('[data-stored-form]').length, 2)
    assert.equal(page.root.querySelectorAll('[data-stored-form]').length, 2)
    // the latest-run card's Post it is the blocked post's, not this
    assert.equal(page.root.querySelectorAll('[data-focus-key="post-it"]').length, 0)
  })
})

test('no button for a posted run, a run that failed before writing a report, or your own PR', async () => {
  // posted: the server offers nothing and the run reads as posted
  const posted = runOf({}, { posted: { form: 'approve', url: 'https://example.test/owner/name/pull/101' }, notPostedReason: null })
  await withPage(cellOf(null), [posted], async (page) => {
    assert.deepEqual(page.buttons(), [])
    assert.match(page.text(), /Posted as an approval/)
  })
  // failed before a report: no result at all
  await withPage(cellOf(null), [runOf({ status: 'failed', note: 'noResult', result: null })], async (page) => {
    assert.deepEqual(page.buttons(), [])
    assert.match(page.text(), /No/)
  })
  // your own PR: the run was told not to post, and the server offers nothing
  await withPage(cellOf(null), [runOf({}, { notPostedReason: 'ownPr' })], async (page) => {
    assert.deepEqual(page.buttons(), [])
    assert.match(page.text(), /Not posted: your own PR/)
  })
})

test('a button opens an in-page confirmation and sends nothing: the form, the report, the command, the login, and the CI state', async () => {
  await withPage(cellOf(offerOf()), [runOf()], async (page) => {
    press(page.button('Approve'))
    assert.deepEqual(page.writes(), [])
    assert.match(page.text(), /Post the stored report on #101 as an approval\?/)
    assert.match(page.text(), /PR-101\.md/)
    assert.match(page.text(), /gh pr review 101 --repo octo-example\/orbit --approve --body-file ~\/agents\/output\/PR-101\.md/)
    assert.match(page.text(), /Posts the saved report ~\/agents\/output\/PR-101\.md to #101 as an approval, under your account \(@viewer\), once\. Pit View cannot undo it\./)
    assert.match(page.text(), /CI now: green/)
    // the head has not moved: Cancel first, then Post
    assert.deepEqual(page.confirmButtons(), ['Cancel', 'Post'])
    assert.doesNotMatch(page.text(), /New commits since this review/)
  })
})

test('Comment and Request Changes name their own form and command', async () => {
  await withPage(cellOf(offerOf()), [runOf()], async (page) => {
    press(page.button('Comment'))
    assert.match(page.text(), /Post the stored report on #101 as a comment\?/)
    assert.match(page.text(), /gh pr comment 101 --repo octo-example\/orbit --body-file/)
  })
  await withPage(cellOf(offerOf({ forms: ['requestChanges', 'comment'] })), [runOf({}, { verdict: 'changesRequested' })], async (page) => {
    press(page.button('Request Changes'))
    assert.match(page.text(), /Post the stored report on #101 as a request for changes\?/)
    assert.match(page.text(), /--request-changes/)
  })
})

test('the CI state is shown as green, pending, failed, or none, and Approve is still postable on every one', async () => {
  const states: [Offer['ci'], RegExp][] = [
    ['green', /CI now: green/],
    ['pending', /CI now: pending/],
    ['failed', /CI now: failed/],
    ['none', /CI now: none/],
  ]
  for (const [ci, shown] of states) {
    await withPage(cellOf(offerOf({ ci })), [runOf()], async (page) => {
      press(page.button('Approve'))
      assert.match(page.text(), shown, ci)
      const post = page.button('Post')
      assert.equal(post.disabled, false, ci)
      press(post)
      await settle()
      assert.equal(page.posts().length, 1, ci)
      assert.equal(page.posts()[0]?.body?.form, 'approve', ci)
    })
  }
})

test('Post sends the form, the heads, the login, and the token to the existing post path, once', async () => {
  await withPage(cellOf(offerOf()), [runOf()], async (page) => {
    press(page.button('Approve'))
    press(page.button('Post'))
    await settle()
    const posts = page.posts()
    assert.equal(posts.length, 1)
    assert.equal(posts[0]?.url, '/api/runs/7/post')
    assert.equal(posts[0]?.headers['X-Pit-View-Token'], 'token-1')
    assert.deepEqual(posts[0]?.body, { repo, viewer: 'viewer', number: 101, headSha: head, reviewedSha: head, form: 'approve' })
    // no review is started
    assert.deepEqual(page.writes().filter((request) => !request.url.endsWith('/post')), [])
    assert.deepEqual(page.said, ['#101: report posted. The row is refreshing.'])
    assert.doesNotMatch(page.text(), /Post the stored report/)
  })
})

test('a moved head: the confirmation says so in plain text and offers Cancel, Post anyway, and a new review', async () => {
  const moved = offerOf({ reviewedSha: earlier })
  await withPage(cellOf(moved), [runOf({}, { reviewed: { kind: 'commit', sha: earlier } })], async (page) => {
    press(page.button('Approve'))
    assert.deepEqual(page.writes(), [])
    assert.match(page.text(), /New commits since this review: reviewed 3a91c0d, now 755b78b\. Post this report as @viewer anyway\?/)
    assert.deepEqual(page.confirmButtons(), ['Cancel', 'Post anyway', 'Start a new review'])
    assert.match(page.text(), /CI now: green/)
    press(page.button('Post anyway'))
    await settle()
    assert.deepEqual(page.posts()[0]?.body, { repo, viewer: 'viewer', number: 101, headSha: head, reviewedSha: earlier, form: 'approve' })
  })
})

test('Cancel posts nothing and closes the confirmation, with or without a moved head', async () => {
  for (const reviewedSha of [head, earlier]) {
    await withPage(cellOf(offerOf({ reviewedSha })), [runOf()], async (page) => {
      press(page.button('Approve'))
      press(page.button('Cancel'))
      await settle()
      assert.deepEqual(page.writes(), [])
      assert.doesNotMatch(page.text(), /Post the stored report/)
      assert.deepEqual(page.buttons(), ['Approve', 'Comment'])
    })
  }
})

test('the third button starts a review through the existing start confirmation and posts nothing', async () => {
  await withPage(cellOf(offerOf({ reviewedSha: earlier })), [runOf()], async (page) => {
    press(page.button('Approve'))
    press(page.button('Start a new review'))
    // nothing is sent by the click: the start's own confirmation opens, and the post confirmation is gone
    assert.deepEqual(page.writes(), [])
    assert.doesNotMatch(page.text(), /Post the stored report/)
    assert.equal(page.root.querySelector('[data-confirm="command"]')?.textContent, '/review-pr 101')
    press(page.root.querySelector('[data-focus-key="confirm-go"]') as FakeElement)
    await settle()
    assert.deepEqual(page.writes().map((request) => request.url), ['/api/prs/101/runs'])
    assert.deepEqual(page.posts(), [])
  })
})

test('a refused post stays in the confirmation with the server\'s words, posts nothing here, and a reload is asked for on a refused token', async () => {
  await withPage(cellOf(offerOf()), [runOf()], async (page) => {
    press(page.button('Approve'))
    press(page.button('Post'))
    await settle()
    assert.equal(page.error(), 'Run 7 has no stored report waiting to be posted on #101; nothing was posted.')
    assert.match(page.text(), /Post the stored report/)
    assert.deepEqual(page.said, [])
    assert.deepEqual(page.buttons(), [])
  }, { post: answer(422, { error: 'run 7 has no stored report waiting to be posted on #101; nothing was posted' }) })
  await withPage(cellOf(offerOf()), [runOf()], async (page) => {
    press(page.button('Approve'))
    press(page.button('Post'))
    await settle()
    assert.equal(page.error(), 'Reload the page to post reports: Pit View has restarted since this page loaded.')
  }, { post: answer(403, { error: 'bad token' }) })
})

test('the button is off for a PR that left the open tables, with the reason', () => {
  const model = drawerModel({ row: rowOf(cellOf(offerOf())), open: false, runs: { state: 'ready', items: [runOf()] }, reports: { state: 'loading' }, confirm: null })
  assert.deepEqual(model.autoRuns[0]?.stored, { runId: 7, buttons: [{ form: 'approve', text: 'Approve' }, { form: 'comment', text: 'Comment' }], disabled: true, reason: 'Posting is off: #101 is no longer open.' })
})

test('the confirmation holds only while the offer is the one it showed, CI included', () => {
  const confirm: Confirm = { type: 'storedPost', runId: 7, repo, viewer: 'viewer', headSha: head, reviewedSha: head, form: 'approve', ci: 'green' }
  assert.equal(confirmHolds(confirm, cellOf(offerOf()), true), true)
  assert.equal(confirmHolds(confirm, cellOf(offerOf()), false), false)
  assert.equal(confirmHolds(confirm, cellOf(null), true), false)
  for (const patch of [{ runId: 8 }, { headSha: earlier }, { reviewedSha: earlier }, { repo: 'other-org/other-repo' }, { viewer: 'sam-tran' }, { ci: 'failed' as const }, { forms: ['comment' as const] }]) {
    assert.equal(confirmHolds(confirm, cellOf(offerOf(patch)), true), false, JSON.stringify(patch))
  }
})

test('the third button, when a new review cannot start, shows the server\'s reason on the button and as a visible line under the buttons', async () => {
  const unavailable = 'A review of #101 is already running.'
  const cell = cellOf(offerOf({ reviewedSha: earlier }))
  const starts = (cell as unknown as { starts: { unavailable: string | null }[] }).starts
  starts[0]!.unavailable = unavailable
  await withPage(cell, [runOf()], async (page) => {
    press(page.button('Approve'))
    const third = page.button('Start a new review')
    assert.equal(third.disabled, true)
    assert.equal(third.title, unavailable)
    assert.equal(third.getAttribute('aria-describedby'), 'drawer-fresh-reason')
    assert.equal(page.root.querySelector('#drawer-fresh-reason')?.textContent, unavailable)
    // a click on the disabled button starts nothing
    press(third)
    assert.deepEqual(page.writes(), [])
  })
  // available: no reason is shown and the button works
  await withPage(cellOf(offerOf({ reviewedSha: earlier })), [runOf()], async (page) => {
    press(page.button('Approve'))
    const third = page.button('Start a new review')
    assert.equal(third.disabled, false)
    assert.equal(third.title, '')
    assert.equal(page.root.querySelector('#drawer-fresh-reason'), null)
  })
})

test('a refusal because the report is no longer the latest stays in the confirmation in the server\'s words, and the offer going away closes the confirmation', async () => {
  const words = 'This report is no longer the latest for this PR; nothing was posted. Reload the PR to see its current state'
  await withPage(cellOf(offerOf()), [runOf()], async (page) => {
    press(page.button('Approve'))
    press(page.button('Post'))
    await settle()
    assert.equal(page.posts().length, 1)
    assert.equal(page.error(), `${words}.`)
    assert.match(page.text(), /Post the stored report/)
  }, { post: answer(409, { error: words }) })
  // the same cell with the offer gone (the next patch) holds no confirmation and no button
  const gone = cellOf(null)
  assert.equal(confirmHolds({ type: 'storedPost', runId: 7, repo, viewer: 'viewer', headSha: head, reviewedSha: head, form: 'approve', ci: 'green' } as unknown as Confirm, gone, true), false)
})
