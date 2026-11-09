// test/ui-extra-instructions-page.test.ts
// the Special instructions box and the Extra review instructions field, driven through the real page code: public/drawer.ts builds the start confirmation and sends its request, and public/settings.ts reads, checks, and saves the form, both run against the fake document in test/fake-dom.ts. Every expected value here is a literal written out, not taken from the code under test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { OpenRow } from '../src/derive.ts'
import type { AgentCell } from '../public/agent.ts'
import { createDrawer } from '../public/drawer.ts'
import { installFakeBrowser, press, tick, typeInto } from './fake-dom.ts'
import type { FakeElement } from './fake-dom.ts'

type Sent = { url: string, method: string, body: Record<string, unknown> | null }

const answer = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// an invented review-pr start offered with the Special instructions box, as the server describes it
const review = (standing: string): AgentCell => ({
  state: 'idle',
  label: 'Re-review',
  action: { kind: 'reReview', label: 'Re-review', command: 'review-pr', args: ['101'], runner: 'claude' },
  starts: [{
    kind: 'default', label: 'Re-review', button: 'Re-review PR', command: 'review-pr', args: ['101'], runners: ['claude', 'codex'],
    posts: { kind: 'review', text: 'Posts its report to the PR as @viewer: an approval, a request for changes, or a comment, per the findings.' },
    repo: 'octo-example/orbit', viewer: 'viewer', unavailable: null,
    extraInstructions: { standing, flag: '--extra-instructions' },
  }],
  models: { claude: 'Sonnet', codex: 'Codex default' },
  lastReviewAt: null,
  runId: null, runner: null, command: null, args: null, status: null, startedAt: null, lastStepAt: null, step: null,
  steps: [], tandem: false, commit: null, extraInstructions: null,
  finishedAt: null, text: null, result: null, question: null, note: null, firstNote: null, resolvedByHand: false, resume: null, costUsd: null, postOffer: null, stackRun: null,
} as unknown as AgentCell)

const row = (agent: AgentCell): OpenRow => ({
  number: 101,
  url: 'https://example.test/owner/name/pull/101',
  title: 'fix(retry): back off between attempts',
  author: { login: 'alex-mendez', alias: 'Alex' },
  headRef: 'fix/retry', baseRef: 'main', headOid: '755b78b2c4e1f0a9d3b6e8c7a5f4d2e1b0c9a8f7',
  agent,
} as unknown as OpenRow)

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

// the real drawer on the fake page, with the confirmation of the first start asked; fetch records what the page sends
const withConfirmation = async (standing: string, check: (page: {
  root: FakeElement
  sent: Sent[]
  box: () => FakeElement | null
  field: () => FakeElement | null
  command: () => string
  go: () => FakeElement
}) => Promise<void>, refuse?: { status: number, error: string }): Promise<void> => {
  const sent: Sent[] = []
  const fake = installFakeBrowser((async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    sent.push({ url: String(input), method, body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null })
    if (method === 'POST') return refuse === undefined ? answer(200, { id: 1 }) : answer(refuse.status, { error: refuse.error })
    return answer(200, [])
  }) as typeof fetch)
  try {
    const root = fake.document.createElement('aside')
    fake.document.body.appendChild(root)
    const cell = review(standing)
    const drawer = createDrawer({
      root: root as unknown as HTMLElement,
      token: 'token-1',
      nowMs: () => Date.parse('2026-10-28T15:00:00Z'),
      rowOf: (number) => number === 101 ? row(cell) : undefined,
      repo: () => 'octo-example/orbit',
      viewer: () => 'viewer',
      say: () => undefined,
      reports: { open: () => undefined, close: () => undefined, isOpen: () => false, refresh: () => undefined },
      sweepLink: () => null,
      openSweep: () => undefined,
    })
    drawer.open(101, { key: 'agent:101', number: 101 }, 'default')
    await settle()
    sent.length = 0
    await check({
      root,
      sent,
      box: () => root.querySelector('input[name="drawer-extra-on"]'),
      field: () => root.querySelector('textarea[name="drawer-extra"]'),
      command: () => root.querySelector('[data-confirm="command"]')?.textContent ?? '',
      go: () => root.querySelector('[data-focus-key="confirm-go"]') as FakeElement,
    })
  } finally {
    fake.restore()
  }
}

const posts = (sent: Sent[]): Sent[] => sent.filter((request) => request.method === 'POST')

test('the start confirmation offers Special instructions unchecked, with no box for text, and sends no instructions when started as it opens', async () => {
  await withConfirmation('', async (page) => {
    const box = page.box()
    assert.ok(box !== null)
    assert.equal(box.checked, false)
    assert.equal(page.field(), null)
    assert.match(page.root.textContent, /Add special instructions for this review/)
    assert.equal(page.command(), '/review-pr 101')
    press(page.go())
    await settle()
    assert.deepEqual(posts(page.sent).map((request) => [request.url, request.body]), [
      ['/api/prs/101/runs', { kind: 'default', runner: 'claude', repo: 'octo-example/orbit', viewer: 'viewer' }],
    ])
  })
})

test('checking the box shows an empty text box, and what is typed is sent as typed with the flag on the command line and not the text', async () => {
  await withConfirmation('', async (page) => {
    tick(page.box() as FakeElement)
    const field = page.field()
    assert.ok(field !== null)
    assert.equal(field.value, '')
    // checked and still empty, nothing is sent yet, so the command carries no flag
    assert.equal(page.command(), '/review-pr 101')
    typeInto(field, 'look at the retry loop\nskip the generated files')
    assert.equal(page.command(), '/review-pr 101 --extra-instructions')
    press(page.go())
    await settle()
    assert.deepEqual(posts(page.sent).map((request) => request.body), [
      { kind: 'default', runner: 'claude', repo: 'octo-example/orbit', viewer: 'viewer', extraInstructions: 'look at the retry loop\nskip the generated files' },
    ])
  })
})

test('unchecking hides the box and keeps the text, rechecking shows it again, and an unchecked box sends nothing even with text kept', async () => {
  await withConfirmation('', async (page) => {
    tick(page.box() as FakeElement)
    typeInto(page.field() as FakeElement, 'read the tests first')
    tick(page.box() as FakeElement)
    assert.equal(page.box()?.checked, false)
    assert.equal(page.field(), null)
    assert.equal(page.command(), '/review-pr 101')
    press(page.go())
    await settle()
    assert.deepEqual(posts(page.sent).map((request) => request.body), [{ kind: 'default', runner: 'claude', repo: 'octo-example/orbit', viewer: 'viewer' }])
  })
  await withConfirmation('', async (page) => {
    tick(page.box() as FakeElement)
    typeInto(page.field() as FakeElement, 'read the tests first')
    tick(page.box() as FakeElement)
    tick(page.box() as FakeElement)
    assert.equal(page.box()?.checked, true)
    assert.equal(page.field()?.value, 'read the tests first')
    press(page.go())
    await settle()
    assert.deepEqual(posts(page.sent).map((request) => request.body), [
      { kind: 'default', runner: 'claude', repo: 'octo-example/orbit', viewer: 'viewer', extraInstructions: 'read the tests first' },
    ])
  })
})

test('checked with only spaces and line breaks sends no instructions field', async () => {
  await withConfirmation('', async (page) => {
    tick(page.box() as FakeElement)
    typeInto(page.field() as FakeElement, '  \n\t \n ')
    assert.equal(page.command(), '/review-pr 101')
    press(page.go())
    await settle()
    assert.deepEqual(posts(page.sent).map((request) => request.body), [{ kind: 'default', runner: 'claude', repo: 'octo-example/orbit', viewer: 'viewer' }])
  })
})

test('with a standing default set, a start that sends nothing runs under it: the command shows the flag and the request carries no text', async () => {
  await withConfirmation('prefer small findings', async (page) => {
    assert.equal(page.box()?.checked, false)
    assert.equal(page.field(), null)
    assert.equal(page.command(), '/review-pr 101 --extra-instructions')
    press(page.go())
    await settle()
    assert.deepEqual(posts(page.sent).map((request) => request.body), [{ kind: 'default', runner: 'claude', repo: 'octo-example/orbit', viewer: 'viewer' }])
  })
})

test('with a standing default set, typed special instructions are sent in its place', async () => {
  await withConfirmation('prefer small findings', async (page) => {
    tick(page.box() as FakeElement)
    typeInto(page.field() as FakeElement, 'only the auth changes')
    press(page.go())
    await settle()
    assert.deepEqual(posts(page.sent).map((request) => request.body), [
      { kind: 'default', runner: 'claude', repo: 'octo-example/orbit', viewer: 'viewer', extraInstructions: 'only the auth changes' },
    ])
  })
})

test('a refused start keeps the box checked and its text, and shows the server\'s reason on the confirmation', async () => {
  await withConfirmation('', async (page) => {
    tick(page.box() as FakeElement)
    typeInto(page.field() as FakeElement, 'only the auth changes')
    press(page.go())
    await settle()
    assert.equal(page.box()?.checked, true)
    assert.equal(page.field()?.value, 'only the auth changes')
    assert.equal(page.root.querySelector('#drawer-error')?.textContent, 'extraInstructions must be at most 2,000 characters; it has 2,001.')
  }, { status: 400, error: 'extraInstructions must be at most 2,000 characters; it has 2,001' })
})

// ---- the Settings page ----

const settingsHtml = readFileSync(new URL('../public/settings.html', import.meta.url), 'utf8')

// loads the real settings.ts on the fake page, once per case: the query makes each import a fresh module with its own page state
let imports = 0
const withSettings = async (config: Record<string, unknown>, outcome: { status: number, body: unknown }, check: (page: {
  field: FakeElement
  slot: FakeElement
  status: FakeElement
  summary: FakeElement
  puts: Record<string, unknown>[]
  save: () => Promise<void>
}) => Promise<void>): Promise<void> => {
  const puts: Record<string, unknown>[] = []
  const fake = installFakeBrowser((async (input: string, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/config' && init?.method === 'PUT') {
      puts.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return answer(outcome.status, outcome.body)
    }
    if (url === '/api/config') return answer(200, config)
    return answer(404, {})
  }) as typeof fetch)
  try {
    fake.document.loadPage(settingsHtml)
    imports += 1
    const target = new URL('../public/settings.ts', import.meta.url)
    target.search = `?case=${imports}`
    await import(target.href)
    await settle()
    const byId = (id: string): FakeElement => fake.document.getElementById(id) as FakeElement
    await check({
      field: byId('f-extraReviewInstructions'),
      slot: byId('f-extraReviewInstructions-error'),
      status: byId('save-status'),
      summary: byId('form-errors'),
      puts,
      save: async () => {
        byId('settings-form').dispatch('submit')
        await settle()
      },
    })
  } finally {
    fake.restore()
  }
}

// an invented, complete config as the server stores it
const stored = (extra: string): Record<string, unknown> => ({
  repo: 'octo-example/orbit',
  viewer: 'vera-quill',
  people: [],
  tickets: [],
  refreshSeconds: 300,
  idleMinutes: 120,
  todayStartsAt: 'local',
  bots: ['dependabot'],
  reportsDir: '~/agents/output',
  density: 'comfortable',
  timeFormat: '12h',
  showAgentColumn: true,
  maxConcurrentReviews: 2,
  selfReviewOverCap: false,
  extraReviewInstructions: extra,
  notifications: { enabled: false, kinds: [] },
  allowedHosts: ['pit.example.test'],
})

test('Settings shows the saved Extra review instructions in its field and saves an edit as the normalized text', async () => {
  await withSettings(stored('prefer small findings'), { status: 200, body: stored('skip the generated files\nlook at retries') }, async (page) => {
    assert.equal(page.field.value, 'prefer small findings')
    typeInto(page.field, '  skip the generated files\r\nlook at retries \n')
    await page.save()
    assert.deepEqual(page.puts.map((put) => put.extraReviewInstructions), ['skip the generated files\nlook at retries'])
    assert.equal(page.field.value, 'skip the generated files\nlook at retries')
    assert.equal(page.slot.hidden, true)
    assert.match(page.status.textContent, /^Saved at /)
  })
})

test('Settings saves an emptied field as no extra instructions', async () => {
  await withSettings(stored('prefer small findings'), { status: 200, body: stored('') }, async (page) => {
    typeInto(page.field, '   \n')
    await page.save()
    assert.deepEqual(page.puts.map((put) => put.extraReviewInstructions), [''])
    assert.equal(page.field.value, '')
  })
})

test('Settings refuses a text over 2,000 characters on the field before anything is sent', async () => {
  await withSettings(stored(''), { status: 200, body: stored('') }, async (page) => {
    typeInto(page.field, 'x'.repeat(2001))
    await page.save()
    assert.deepEqual(page.puts, [])
    assert.equal(page.slot.hidden, false)
    assert.equal(page.slot.textContent, 'Must be at most 2,000 characters; it has 2,001.')
    assert.equal(page.field.getAttribute('aria-invalid'), 'true')
    assert.equal(page.status.textContent, 'Nothing saved yet: fix the fields marked above.')
  })
})

test('Settings puts the server\'s refusal of the instructions on the field and keeps what was typed', async () => {
  await withSettings(stored(''), { status: 400, body: { error: 'config.extraReviewInstructions must be plain text: character 3 is the control character U+0007, and only line breaks and tabs are allowed' } }, async (page) => {
    typeInto(page.field, 'be careful')
    await page.save()
    assert.equal(page.puts.length, 1)
    assert.equal(page.slot.hidden, false)
    assert.equal(page.slot.textContent, 'Must be plain text: character 3 is the control character U+0007, and only line breaks and tabs are allowed.')
    assert.equal(page.field.getAttribute('aria-invalid'), 'true')
    assert.equal(page.field.value, 'be careful')
    assert.equal(page.status.textContent, 'Nothing saved: Pit View refused the settings.')
  })
})
