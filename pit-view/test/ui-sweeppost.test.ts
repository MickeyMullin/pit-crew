// test/ui-sweeppost.test.ts
// the post button on a scheduled Dependabot sweep's PR card (section 10 of DESIGN.md, Posting, and section 8, Sweeps, Sweep drawer), driven through the real public/sweepdrawer.ts against the fake document in test/fake-dom.ts: the buttons a row's offer names, none where there is nothing to post, the in-page confirmation with the form, the report, the login, the CI state, and the moved-head sentence, Cancel, Post, refusals, the scan's second click, and the request's token. Every expected value is a literal written out here, not taken from the code under test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Sweep } from '../src/cache.ts'
import { defaultConfig } from '../src/config.ts'
import type { OpenRow } from '../src/derive.ts'
import { parseResult } from '../src/launcher.ts'
import type { SweepOffer } from '../src/launcher.ts'
import { sweepStartOf, sweepView } from '../src/sweeps.ts'
import type { SweepsView } from '../src/sweeps.ts'
import type { AgentCell } from '../public/agent.ts'
import { createSweepDrawer } from '../public/sweepdrawer.ts'
import { installFakeBrowser, press } from './fake-dom.ts'
import type { FakeElement } from './fake-dom.ts'
import { sweepResult, sweepRow } from './helpers.ts'

type Sent = { url: string, method: string, headers: Record<string, string>, body: Record<string, unknown> | null }

const repo = 'octo-example/orbit'
const head = '7c1e0b5a9d2f4c6e8a0b1d3f5e7a9c2b4d6f8e01'
const earlier = '3a91c0de5f4b7a6e8d2c1b0a9f8e7d6c5b4a3f21'

const answer = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

const offerOf = (patch: Partial<SweepOffer> = {}): SweepOffer => ({
  sweepId: 3,
  number: 214,
  forms: ['approve', 'comment'],
  report: 'PR-214.md',
  reportPath: '~/agents/output/PR-214.md',
  reviewedSha: head,
  headSha: head,
  repo,
  viewer: 'viewer',
  ci: 'green',
  commands: {
    approve: `gh pr review 214 --repo ${repo} --approve --body-file ~/agents/output/PR-214.md`,
    requestChanges: `gh pr review 214 --repo ${repo} --request-changes --body-file ~/agents/output/PR-214.md`,
    comment: `gh pr comment 214 --repo ${repo} --body-file ~/agents/output/PR-214.md`,
  },
  ...patch,
})

const rowOf = (number: number, offer: SweepOffer | null): OpenRow => ({
  number,
  url: `https://example.test/owner/name/pull/${number}`,
  title: 'build(deps): bump left-pad from 1.3.0 to 1.3.1',
  headOid: head.slice(0, 7), headSha: head,
  agent: { sweepOffer: offer } as unknown as AgentCell,
} as unknown as OpenRow)

const sweepRecord = (id: number, rows: Record<string, unknown>[]): Sweep => {
  const parsed = parseResult(JSON.stringify(sweepResult({ notPostedReason: 'noPost', rows, counts: { swept: rows.length, fresh: rows.length, reused: 0, failed: 0 } })))
  if (!parsed.ok) throw new Error(parsed.error)
  return {
    id, repo, command: 'review-dependabot-sweep', args: [repo, '--parallel', '1', '--no-post'], label: 'Dependabot sweep', runner: 'claude', cwd: '~/dev/orbit', dir: `~/sweeps/${id}`,
    sessionId: null, pid: 4000, pidStartedAt: null, startedAt: '2026-10-28T13:00:00Z', lastStepAt: null, step: null, stepState: null, steps: null, finishedAt: '2026-10-28T13:20:00Z',
    status: 'done', result: parsed.value, note: null, costUsd: null, resume: null, origin: 'auto', tick: 5, reason: 'dependabot', queuedAt: '2026-10-28T13:00:00Z', posting: false, worktree: null,
    rowReports: null, postAttempts: {},
  } as Sweep
}

const row214 = sweepRow({ number: 214, url: 'https://example.test/owner/name/pull/214', title: 'build(deps): bump left-pad from 1.3.0 to 1.3.1', head, posted: null, report: '~/agents/output/PR-214.md' })
const row215 = sweepRow({ number: 215, url: 'https://example.test/owner/name/pull/215', title: 'build(deps): bump right-pad from 2.0.0 to 2.0.1', head: earlier, posted: null, report: '~/agents/output/PR-215.md' })

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
  writes: () => Sent[]
  drawer: ReturnType<typeof createSweepDrawer>
  document: ReturnType<typeof installFakeBrowser>['document']
  // replaces the offers the rows carry, as a patch would, and redraws
  offers: (next: Record<number, SweepOffer | null>) => void
}

const withPage = async (offers: Record<number, SweepOffer | null>, check: (page: Page) => Promise<void>, replies: { post?: Response | (() => Response | Promise<Response>) } = {}, sweeps: Sweep[] = [sweepRecord(3, [row214, row215])]): Promise<void> => {
  const sent: Sent[] = []
  const said: string[] = []
  let current = offers
  const fake = installFakeBrowser((async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    sent.push({ url: String(input), method, headers: (init?.headers ?? {}) as Record<string, string>, body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null })
    if (method === 'POST' && String(input).endsWith('/post')) return (typeof replies.post === 'function' ? replies.post() : replies.post) ?? answer(200, { number: 214, sweepId: 3, posted: { form: 'approve', url: 'https://example.test/owner/name/pull/214' }, sweep: null })
    return answer(200, [])
  }) as typeof fetch)
  try {
    const root = fake.document.createElement('aside')
    root.hidden = true
    fake.document.body.appendChild(root)
    const view: SweepsView = { start: sweepStartOf({ ...defaultConfig(), repo, viewer: 'viewer', cloneDir: '~/dev/orbit' }, false), items: sweeps.map(sweepView) }
    const drawer = createSweepDrawer({
      root: root as unknown as HTMLElement,
      token: 'token-1',
      nowMs: () => Date.parse('2026-10-28T15:00:00Z'),
      sweeps: () => view,
      rowOf: (number) => number in current ? rowOf(number, current[number] ?? null) : undefined,
      say: (text) => said.push(text),
      reports: { open: () => undefined, close: () => undefined, isOpen: () => false, refresh: () => undefined },
    })
    drawer.open({ key: 'sweep-status' }, { sweepId: 3 })
    await settle()
    sent.length = 0
    const names = (list: FakeElement[]): string[] => list.map((element) => element.textContent)
    await check({
      root,
      sent,
      said,
      buttons: () => names(root.querySelectorAll('[data-sweep-post-form]')),
      confirmButtons: () => names(root.querySelector('.confirm-actions')?.children ?? []),
      button: (text) => {
        const found = root.querySelectorAll('button').find((element) => element.textContent === text)
        assert.ok(found !== undefined, `a button named ${text}`)
        return found
      },
      text: () => root.textContent,
      error: () => root.querySelector('#sweep-error')?.textContent ?? '',
      posts: () => sent.filter((request) => request.method === 'POST' && request.url.endsWith('/post')),
      writes: () => sent.filter((request) => request.method === 'POST'),
      drawer,
      document: fake.document,
      offers: (next) => {
        current = next
        drawer.update()
      },
    })
  } finally {
    fake.restore()
  }
}

test('a PR card of the sweep shows a button for the report\'s recommendation and Comment, and Comment alone for a comment', async () => {
  await withPage({ 214: offerOf() }, async (page) => {
    assert.deepEqual(page.buttons(), ['Approve', 'Comment'])
    const card = page.root.querySelector('#sweep-row-214')
    assert.equal(card?.querySelectorAll('[data-sweep-post-form]').length, 2, 'the buttons sit on #214\'s own card')
  })
  await withPage({ 214: offerOf({ forms: ['comment'] }) }, async (page) => {
    assert.deepEqual(page.buttons(), ['Comment'])
  })
  await withPage({ 214: offerOf({ forms: ['requestChanges', 'comment'] }) }, async (page) => {
    assert.deepEqual(page.buttons(), ['Request Changes', 'Comment'])
  })
})

test('no button on a card whose PR has no offer, an offer from another sweep, or no open row', async () => {
  await withPage({ 214: null }, async (page) => assert.deepEqual(page.buttons(), []))
  await withPage({ 214: offerOf({ sweepId: 4 }) }, async (page) => assert.deepEqual(page.buttons(), []))
  await withPage({}, async (page) => assert.deepEqual(page.buttons(), []))
  // #215's offer is #215's: it never lands on #214's card
  await withPage({ 215: offerOf({ number: 215, report: 'PR-215.md', reportPath: '~/agents/output/PR-215.md', reviewedSha: earlier }) }, async (page) => {
    assert.equal(page.root.querySelector('#sweep-row-214')?.querySelectorAll('[data-sweep-post-form]').length, 0)
    assert.equal(page.root.querySelector('#sweep-row-215')?.querySelectorAll('[data-sweep-post-form]').length, 2)
  })
})

test('a button opens an in-page confirmation and sends nothing: the form, the report, the command, the login, the CI state, and what it is bound to', async () => {
  await withPage({ 214: offerOf() }, async (page) => {
    press(page.button('Approve'))
    assert.deepEqual(page.writes(), [])
    assert.match(page.text(), /Post the stored report on #214 as an approval\?/)
    assert.match(page.text(), /build\(deps\): bump left-pad from 1\.3\.0 to 1\.3\.1/)
    assert.match(page.text(), /PR-214\.md/)
    assert.match(page.text(), /gh pr review 214 --repo octo-example\/orbit --approve --body-file ~\/agents\/output\/PR-214\.md/)
    assert.match(page.text(), /Posts the saved report ~\/agents\/output\/PR-214\.md to #214 as an approval, under your account \(@viewer\), once\. Pit View cannot undo it\./)
    assert.match(page.text(), /CI now: green/)
    assert.match(page.text(), /For the head 7c1e0b5 in octo-example\/orbit, as viewer, the report from sweep 3 reviewing 7c1e0b5\./)
    assert.deepEqual(page.confirmButtons(), ['Cancel', 'Post'])
    assert.equal(page.document.activeElement?.textContent, 'Cancel', 'Cancel takes focus first')
    assert.doesNotMatch(page.text(), /New commits since this review/)
    assert.equal(page.root.querySelector('[role="group"]')?.getAttribute('aria-labelledby'), 'sweep-confirm-heading')
  })
})

test('Post sends the form, the heads, the login, and the token to the sweep\'s post route, once, and says so', async () => {
  await withPage({ 214: offerOf() }, async (page) => {
    press(page.button('Comment'))
    assert.match(page.text(), /Post the stored report on #214 as a comment\?/)
    press(page.button('Post'))
    await settle()
    const posts = page.posts()
    assert.equal(posts.length, 1)
    assert.equal(posts[0]?.url, '/api/sweeps/3/post')
    assert.equal(posts[0]?.headers['X-Pit-View-Token'], 'token-1')
    assert.deepEqual(posts[0]?.body, { repo, viewer: 'viewer', number: 214, headSha: head, reviewedSha: head, form: 'comment' })
    assert.deepEqual(page.writes().filter((request) => !request.url.endsWith('/post')), [])
    assert.deepEqual(page.said, ['#214: report posted. The row is refreshing.'])
    assert.doesNotMatch(page.text(), /Post the stored report/)
  })
})

test('a moved head: the confirmation says so in plain text and offers Cancel and Post anyway', async () => {
  await withPage({ 214: offerOf({ reviewedSha: earlier }) }, async (page) => {
    press(page.button('Approve'))
    assert.match(page.text(), /New commits since this review: reviewed 3a91c0d, now 7c1e0b5\. Post this report as @viewer anyway\?/)
    assert.deepEqual(page.confirmButtons(), ['Cancel', 'Post anyway'])
    press(page.button('Post anyway'))
    await settle()
    assert.deepEqual(page.posts()[0]?.body, { repo, viewer: 'viewer', number: 214, headSha: head, reviewedSha: earlier, form: 'approve' })
  })
})

test('Cancel and Escape post nothing and close the confirmation, before Escape closes the drawer', async () => {
  await withPage({ 214: offerOf() }, async (page) => {
    press(page.button('Approve'))
    press(page.button('Cancel'))
    assert.doesNotMatch(page.text(), /Post the stored report/)
    assert.deepEqual(page.buttons(), ['Approve', 'Comment'])
    press(page.button('Comment'))
    assert.equal(page.drawer.escape(), true)
    assert.doesNotMatch(page.text(), /Post the stored report/)
    assert.equal(page.drawer.isOpen(), true)
    assert.deepEqual(page.writes(), [])
  })
})

test('a refused post stays in the confirmation with the server\'s words, and a reload is asked for on a refused token', async () => {
  await withPage({ 214: offerOf() }, async (page) => {
    press(page.button('Approve'))
    press(page.button('Post'))
    await settle()
    assert.equal(page.error(), 'This report is no longer the latest for this PR; nothing was posted.')
    assert.match(page.text(), /Post the stored report/)
    assert.deepEqual(page.said, [])
  }, { post: answer(409, { error: 'This report is no longer the latest for this PR; nothing was posted' }) })
  await withPage({ 214: offerOf() }, async (page) => {
    press(page.button('Approve'))
    press(page.button('Post'))
    await settle()
    assert.equal(page.error(), 'Reload the page to post reports: Pit View has restarted since this page loaded.')
  }, { post: answer(403, { error: 'bad token' }) })
})

test('a post refused over the scan shows the term, and the next Post click on that confirmation sends exactly that hit set and hash back', async () => {
  const hits = [{ term: 'assistant', context: 'checked with an assistant' }]
  const replies = [answer(422, {
    error: 'the saved report ~/agents/output/PR-214.md contains "assistant" (checked with an assistant), and a posted report normally never mentions the involvement of AI, a model, a runner, or a provider; nothing was posted. Post again to post it as it is, edit that text out of the report, or start a new review',
    hits,
    reportHash: 'b'.repeat(64),
  })]
  await withPage({ 214: offerOf() }, async (page) => {
    press(page.button('Approve'))
    press(page.button('Post'))
    await settle()
    assert.match(page.error(), /contains "assistant"/)
    press(page.button('Post'))
    await settle()
    assert.equal(page.posts().length, 2)
    assert.deepEqual(page.posts()[1]?.body, { repo, viewer: 'viewer', number: 214, headSha: head, reviewedSha: head, form: 'approve', allow: { terms: ['assistant'], reportHash: 'b'.repeat(64) } })
    // Cancel forgets it: the next confirmation starts with none
    press(page.button('Approve'))
    press(page.button('Post'))
    await settle()
    assert.equal(page.posts()[2]?.body?.allow, undefined)
  }, { post: () => replies.shift() ?? answer(200, { number: 214, sweepId: 3, posted: { form: 'approve', url: 'https://example.test/owner/name/pull/214' }, sweep: null }) })
})

test('the confirmation is dropped when the offer changes in any way, CI included, or goes away', async () => {
  await withPage({ 214: offerOf() }, async (page) => {
    press(page.button('Approve'))
    page.offers({ 214: offerOf({ ci: 'pending' }) })
    assert.doesNotMatch(page.text(), /Post the stored report/)
    assert.deepEqual(page.buttons(), ['Approve', 'Comment'])
    press(page.button('Approve'))
    assert.match(page.text(), /CI now: pending\. Checks are still running\. It does not block the post\./)
    page.offers({ 214: null })
    assert.doesNotMatch(page.text(), /Post the stored report/)
    assert.deepEqual(page.buttons(), [])
  })
})
