// test/ui-autoreview-card.test.ts
// the Auto-review card on the Settings page, driven through the real public/settings.ts against the fake document in test/fake-dom.ts: the posting confirmations and the rule that the same box again dismisses one, Reset to Defaults, the cap rule as either number is typed, the saved check interval that is not a listed choice, a daily limit of 0, the clone folder in the Agent card, and the words the card derives. Every expected value is a literal written out here, not taken from the code under test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { installFakeBrowser, press, tick, typeInto } from './fake-dom.ts'
import type { FakeElement } from './fake-dom.ts'

const answer = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const settingsHtml = readFileSync(new URL('../public/settings.html', import.meta.url), 'utf8')

type Auto = Record<string, unknown>

const auto = (patch: Auto = {}): Auto => ({
  enabled: true, intervalMinutes: 15, activeHours: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '18:00' },
  others: true, own: false, dependabot: false, concurrency: 1, dailyLimit: 10, post: { others: false, dependabot: false }, ...patch,
})

// an invented, complete config as the server stores it
const config = (patch: Auto = {}, autoReview: Auto | null = auto()): Record<string, unknown> => ({
  repo: 'octo-example/orbit', viewer: 'vera-quill', people: [], tickets: [], refreshSeconds: 300, idleMinutes: 120, todayStartsAt: 'local', bots: ['dependabot'],
  reportsDir: '~/agents/output', density: 'comfortable', timeFormat: '12h', showAgentColumn: true, maxConcurrentReviews: 2, selfReviewOverCap: false,
  extraReviewInstructions: '', notifications: { enabled: false, kinds: [] }, allowedHosts: ['pit.example.test'], cloneDir: '~/dev/orbit',
  agent: { runner: 'claude', claudeModel: 'sonnet' }, ...(autoReview === null ? {} : { autoReview }), ...patch,
})

const emptyView = (autoReview: Auto | null): Record<string, unknown> => ({ mine: { groups: [] }, others: { groups: [] }, autoReview })

const running = (patch: Auto = {}): Auto => ({
  enabled: true, state: 'idle', nextTickAt: new Date(Date.now() + 600_000).toISOString(), running: 0, queued: 0, startedToday: 3, lastTick: null,
  posting: { others: false, dependabot: false }, sweepHold: null, worktrees: { kept: [], unlisted: [] }, ...patch,
})

type Page = {
  by: (id: string) => FakeElement
  puts: Record<string, unknown>[]
  document: ReturnType<typeof installFakeBrowser>['document']
  save: () => Promise<void>
  focused: () => string
}

let imports = 0
const withCard = async (stored: Record<string, unknown>, check: (page: Page) => Promise<void>, options: { put?: { status: number, body: unknown }, view?: Record<string, unknown> | null } = {}): Promise<void> => {
  const puts: Record<string, unknown>[] = []
  const fake = installFakeBrowser((async (input: string, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/config' && init?.method === 'PUT') {
      puts.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      const put = options.put ?? { status: 200, body: JSON.parse(String(init.body)) }
      return answer(put.status, put.body)
    }
    if (url === '/api/config') return answer(200, stored)
    if (url === '/api/view' && options.view !== undefined && options.view !== null) return answer(200, options.view)
    return answer(404, {})
  }) as typeof fetch)
  try {
    fake.document.loadPage(settingsHtml)
    imports += 1
    const target = new URL('../public/settings.ts', import.meta.url)
    target.search = `?card=${imports}`
    await import(target.href)
    await settle()
    const by = (id: string): FakeElement => fake.document.getElementById(id) as FakeElement
    await check({
      by,
      puts,
      document: fake.document,
      save: async () => {
        by('settings-form').dispatch('submit')
        await settle()
      },
      focused: () => fake.document.activeElement?.id ?? '',
    })
  } finally {
    fake.restore()
  }
}

const buttonsIn = (slot: FakeElement): FakeElement[] => slot.querySelectorAll('button')

// the posting confirmations and the rule that the same box again dismisses one

test('clicking the checkbox again while its posting question is open dismisses it exactly as Cancel does, for both switches, and never confirms', async () => {
  // the label wraps its box, so a click on the label is a click on the box
  assert.match(settingsHtml, /<label class="check"><input id="f-autoPostOthers" type="checkbox"/)
  assert.match(settingsHtml, /<label class="check"><input id="f-autoPostDependabot" type="checkbox"/)
  for (const [kind, id] of [['others', 'f-autoPostOthers'], ['dependabot', 'f-autoPostDependabot']] as const) {
    await withCard(config(), async (page) => {
      const box = page.by(id)
      const slot = page.by(`auto-post-ask-${kind}`)
      tick(box)
      assert.equal(slot.hidden, false, `${kind}: the question opens`)
      assert.equal(box.checked, false, 'the switch stays off until confirmed')
      assert.equal(page.document.activeElement?.textContent, 'Post as @vera-quill', 'the confirm button takes focus only when opened')
      // the second click on the same box (or its label)
      tick(box)
      assert.equal(slot.hidden, true, `${kind}: the question closes`)
      assert.equal(slot.querySelectorAll('button').length, 0)
      assert.equal(box.checked, false, 'it ends where Cancel leaves it: off')
      assert.equal(page.focused(), id, 'focus returns to the switch, as Cancel does')
      assert.equal(page.by('save-status').textContent, '', 'nothing changed in the form')
      await page.save()
      assert.deepEqual(page.puts, [], 'nothing was confirmed or saved')
      // the question can be opened again afterwards, and a third click closes it again
      tick(box)
      assert.equal(slot.hidden, false)
      tick(box)
      assert.equal(slot.hidden, true)
    })
  }
})

test('Cancel and the confirm button behave as before, and a click on the box after confirming turns the switch off without a question', async () => {
  await withCard(config(), async (page) => {
    const box = page.by('f-autoPostOthers')
    const slot = page.by('auto-post-ask-others')
    tick(box)
    const [confirm, cancel] = buttonsIn(slot)
    assert.equal(confirm?.textContent, 'Post as @vera-quill')
    assert.equal(cancel?.textContent, 'Cancel')
    press(cancel as FakeElement)
    assert.equal(slot.hidden, true)
    assert.equal(box.checked, false)
    assert.equal(page.focused(), 'f-autoPostOthers')
    assert.equal(page.by('save-status').textContent, '')
    // confirming turns it on, and the form is unsaved
    tick(box)
    press(buttonsIn(slot)[0] as FakeElement)
    assert.equal(slot.hidden, true)
    assert.equal(box.checked, true)
    assert.equal(page.by('save-status').textContent, 'Unsaved changes')
    // turning it off asks nothing
    tick(box)
    assert.equal(slot.hidden, true)
    assert.equal(box.checked, false)
    assert.equal(page.by('save-status').textContent, '')
  })
})

test('a dismissed question leaves no confirmed login behind: the login changing later turns nothing off, and a second box opens only its own question', async () => {
  await withCard(config(), async (page) => {
    const others = page.by('f-autoPostOthers')
    tick(others)
    tick(others)
    typeInto(page.by('f-viewer'), 'ines-hale')
    assert.equal(page.by('f-autoPostOthers-notice').hidden, true, 'no login-changed notice for a switch never confirmed')
    // one question is open at a time: opening the other switch\'s question replaces the first, as before
    tick(others)
    tick(page.by('f-autoPostDependabot'))
    assert.equal(page.by('auto-post-ask-others').hidden, true)
    assert.equal(page.by('auto-post-ask-dependabot').hidden, false)
  })
})

test('an empty viewer opens no question: the switch stays off, the notice gains a Go to Viewing as link, and nothing takes focus until the link is used', async () => {
  await withCard(config({ viewer: '' }), async (page) => {
    const box = page.by('f-autoPostOthers')
    const before = page.document.activeElement
    tick(box)
    assert.equal(page.by('auto-post-ask-others').hidden, true)
    assert.equal(box.checked, false)
    const notice = page.by('f-autoPostOthers-notice')
    assert.equal(notice.hidden, false)
    assert.equal(notice.textContent, 'Enter a viewer first: the confirmation has to name the account that will post, and an empty viewer does not name one. Go to Viewing as')
    assert.equal(page.document.activeElement, before, 'the notice takes no focus')
    notice.querySelector('a')?.dispatch('click')
    assert.equal(page.focused(), 'f-viewer')
  })
})

// Reset to Defaults

test('Reset to Defaults in each section sets only that section in the form, saves nothing, is disabled at the defaults, moves focus to the section\'s first control, and Discard undoes it', async () => {
  const away = auto({
    enabled: true, intervalMinutes: 30, activeHours: { days: ['sat', 'sun'], from: '07:30', to: '20:00' }, others: false, own: true, dependabot: true,
    concurrency: 2, dailyLimit: 25, post: { others: false, dependabot: false },
  })
  await withCard(config({}, away), async (page) => {
    for (const id of ['reset-schedule', 'reset-what', 'reset-post', 'reset-limits']) assert.equal(page.by(id).disabled, id === 'reset-post', id)
    assert.equal(page.by('reset-limits').hidden, true, 'Limits\' button shows only while Limits is open')
    page.by('limits-toggle').dispatch('click')
    assert.equal(page.by('limits-body').hidden, false)
    assert.equal(page.by('reset-limits').hidden, false)
    // Schedule
    press(page.by('reset-schedule'))
    assert.equal(page.by('f-autoInterval').value, '15')
    assert.equal(page.by('f-autoFrom').value, '09:00')
    assert.equal(page.by('f-autoTo').value, '18:00')
    assert.deepEqual(page.by('auto-days').children.map((chip) => chip.querySelector('input')?.checked), [false, true, true, true, true, true, false])
    assert.equal(page.by('reset-schedule').disabled, true)
    assert.equal(page.by('f-autoDay-sun').checked, false)
    assert.equal(page.focused(), 'f-autoDay-sun')
    assert.equal(page.by('save-status').textContent, 'Unsaved changes')
    // the other sections are untouched
    assert.equal(page.by('f-autoOwn').checked, true)
    assert.equal(page.by('f-autoConcurrency').value, '2')
    assert.equal(page.by('f-autoDailyLimit').value, '25')
    // What to review
    press(page.by('reset-what'))
    assert.deepEqual([page.by('f-autoOthers').checked, page.by('f-autoOwn').checked, page.by('f-autoDependabot').checked], [true, false, false])
    assert.equal(page.focused(), 'f-autoOthers')
    // Limits
    press(page.by('reset-limits'))
    assert.deepEqual([page.by('f-autoConcurrency').value, page.by('f-autoDailyLimit').value], ['1', '10'])
    assert.equal(page.focused(), 'f-autoConcurrency')
    assert.equal(page.by('f-autoEnabled').checked, true, 'the master switch has no Reset and is never reset')
    assert.equal(page.by('f-cloneDir').value, '~/dev/orbit')
    assert.deepEqual(page.puts, [], 'nothing is saved until Save')
    // Discard returns every field to what is saved
    press(page.by('revert'))
    assert.equal(page.by('f-autoInterval').value, '30')
    assert.equal(page.by('f-autoOwn').checked, true)
    assert.equal(page.by('f-autoDailyLimit').value, '25')
    assert.equal(page.by('save-status').textContent, 'Changes discarded.')
  })
})

test('Reset to Defaults saves only through Save, and then writes the section\'s defaults with everything else as it was', async () => {
  await withCard(config({}, auto({ intervalMinutes: 30, dailyLimit: 25, concurrency: 2 })), async (page) => {
    press(page.by('reset-schedule'))
    await page.save()
    assert.equal(page.puts.length, 1)
    const sent = page.puts[0]?.autoReview as Auto
    assert.equal(sent.intervalMinutes, 15)
    assert.equal(sent.dailyLimit, 25)
    assert.equal(sent.concurrency, 2)
  })
})

test('Reset to Defaults in Post auto-reviews? turns both switches off without a question, closes an open one, clears the notices, and can never turn one on', async () => {
  await withCard(config({}, auto({ post: { others: true, dependabot: true } })), async (page) => {
    assert.equal(page.by('reset-post').disabled, false)
    press(page.by('reset-post'))
    assert.deepEqual([page.by('f-autoPostOthers').checked, page.by('f-autoPostDependabot').checked], [false, false])
    assert.equal(page.by('auto-post-ask-others').hidden, true)
    assert.equal(page.by('auto-post-ask-dependabot').hidden, true)
    assert.equal(page.by('reset-post').disabled, true)
    assert.equal(page.focused(), 'f-autoPostOthers')
    assert.equal(page.by('save-status').textContent, 'Unsaved changes')
    // with a question open, Reset closes it and still leaves the switch off
    tick(page.by('f-autoPostDependabot'))
    assert.equal(page.by('auto-post-ask-dependabot').hidden, false)
    press(page.by('reset-schedule').disabled ? page.by('reset-post') : page.by('reset-post'))
    assert.equal(page.by('auto-post-ask-dependabot').hidden, true)
    assert.deepEqual([page.by('f-autoPostOthers').checked, page.by('f-autoPostDependabot').checked], [false, false])
  })
  // a form at the defaults has nothing to reset in any section
  await withCard(config({}, null), async (page) => {
    for (const id of ['reset-schedule', 'reset-what', 'reset-post', 'reset-limits']) assert.equal(page.by(id).disabled, true, id)
  })
})

// the cap rule

test('the cap rule shows on Concurrent auto-reviews as either number is typed, opens Limits, waits for Save for everything else, and refuses a Save', async () => {
  await withCard(config(), async (page) => {
    assert.equal(page.by('limits-body').hidden, true)
    typeInto(page.by('f-autoConcurrency'), '3')
    const slot = page.by('f-autoConcurrency-error')
    assert.equal(slot.hidden, false)
    assert.equal(slot.textContent, 'Must be no more than Concurrent reviews in Agent, which is now 2.')
    assert.equal(page.by('f-autoConcurrency').getAttribute('aria-invalid'), 'true')
    assert.equal(page.by('limits-body').hidden, false, 'Limits opens for the error')
    assert.equal(page.by('form-errors').hidden, true, 'no summary before a Save')
    // it stays open while the error stands
    page.by('limits-toggle').dispatch('click')
    assert.equal(page.by('limits-body').hidden, false)
    // every other check still waits for the first Save
    typeInto(page.by('f-autoFrom'), 'late')
    assert.equal(page.by('f-autoFrom-error').hidden, true)
    typeInto(page.by('f-autoFrom'), '09:00')
    // raising the Agent number clears it, and lowering it brings it back with the value typed
    typeInto(page.by('f-maxConcurrentReviews'), '3')
    assert.equal(slot.hidden, true)
    assert.equal(page.by('f-autoConcurrency').getAttribute('aria-invalid'), null)
    typeInto(page.by('f-maxConcurrentReviews'), '2')
    assert.equal(slot.textContent, 'Must be no more than Concurrent reviews in Agent, which is now 2.')
    await page.save()
    assert.deepEqual(page.puts, [])
    assert.equal(page.by('form-errors').hidden, false)
    // the fake page holds only elements with an id, so the summary names the field by its key here; the real label is pinned in ui-settings.test.ts
    assert.match(page.by('form-errors').textContent, /: Must be no more than Concurrent reviews in Agent, which is now 2\./)
    assert.equal(page.by('save-status').textContent, 'Nothing saved yet: fix the fields marked above.')
    // fixing the number lets the Save through
    typeInto(page.by('f-autoConcurrency'), '2')
    await page.save()
    const sent = page.puts as Record<string, unknown>[]
    assert.equal(sent.length, 1)
    assert.equal((sent[0]?.autoReview as Auto).concurrency, 2)
  })
})

test('a Concurrent auto-reviews value saved above the cap shows the error as the page loads, with Limits open and the number kept, is not an unsaved change, and refuses a Save until fixed', async () => {
  await withCard(config({}, auto({ concurrency: 3 })), async (page) => {
    assert.equal(page.by('f-autoConcurrency').value, '3')
    assert.equal(page.by('f-autoConcurrency-error').textContent, 'Must be no more than Concurrent reviews in Agent, which is now 2.')
    assert.equal(page.by('limits-body').hidden, false)
    assert.equal(page.by('save-status').textContent, '', 'not an unsaved change')
    assert.equal(page.by('revert').disabled, true)
    await page.save()
    assert.deepEqual(page.puts, [], 'Save is refused until the person fixes it')
    assert.equal(page.by('f-autoConcurrency').value, '3', 'never lowered for the person')
    // raising Concurrent reviews fixes it
    typeInto(page.by('f-maxConcurrentReviews'), '3')
    assert.equal(page.by('f-autoConcurrency-error').hidden, true)
    await page.save()
    assert.equal(page.puts.length, 1)
  })
})

test('the server\'s refusal of the cap rule lands on Concurrent auto-reviews and opens Limits', async () => {
  const refusal = { status: 400, body: { error: 'autoReview.concurrency must be no more than maxConcurrentReviews (2)' } }
  // a refusal on a field inside the closed disclosure opens it
  await withCard(config(), async (page) => {
    typeInto(page.by('f-autoDailyLimit'), '5')
    await page.save()
    assert.equal(page.by('f-autoConcurrency-error').textContent, 'Must be no more than maxConcurrentReviews (2).')
    assert.equal(page.by('limits-body').hidden, false)
    assert.equal(page.by('save-status').textContent, 'Nothing saved: Pit View refused the settings.')
    assert.equal(page.by('f-autoConcurrency').getAttribute('aria-invalid'), 'true')
  }, { put: refusal })
  await withCard(config(), async (page) => {
    typeInto(page.by('f-autoDailyLimit'), '5')
    assert.equal(page.by('limits-body').hidden, true)
    await page.save()
    assert.equal(page.by('f-autoDailyLimit-error').textContent, 'Must be a whole number of 0 or more.')
    assert.equal(page.by('limits-body').hidden, false)
  }, { put: { status: 400, body: { error: 'autoReview.dailyLimit must be a whole number of 0 or more' } } })
})

// the daily limit

test('a daily limit of 0 is valid, saves as 0, and reads no daily limit in the Limits summary and the Now line', async () => {
  await withCard(config({}, auto({ dailyLimit: 0 })), async (page) => {
    assert.equal(page.by('f-autoDailyLimit').value, '0')
    assert.equal(page.by('limits-summary').textContent, '1 concurrent auto-review · no daily limit')
    assert.equal(page.by('auto-now-meta').textContent.startsWith('3 runs started today · no daily limit · posting off'), true)
    assert.equal(page.by('save-status').textContent, '')
    typeInto(page.by('f-autoConcurrency'), '2')
    await page.save()
    assert.equal((page.puts[0]?.autoReview as Auto).dailyLimit, 0)
    assert.equal(page.by('f-autoDailyLimit-error').hidden, true)
  }, { view: emptyView(running()) })
  await withCard(config(), async (page) => {
    typeInto(page.by('f-autoDailyLimit'), '0')
    assert.equal(page.by('limits-summary').textContent, '1 concurrent auto-review · no daily limit')
    await page.save()
    assert.equal((page.puts[0]?.autoReview as Auto).dailyLimit, 0)
    typeInto(page.by('f-autoDailyLimit'), '-1')
    await page.save()
    assert.equal(page.by('f-autoDailyLimit-error').textContent, 'Use a whole number of 0 or more.')
  })
})

// the Check every dropdown

test('Check every offers the four choices with 15 minutes (default) selected, and writes the chosen number', async () => {
  await withCard(config(), async (page) => {
    const select = page.by('f-autoInterval')
    assert.deepEqual(select.querySelectorAll('option').map((option) => [option.getAttribute('value'), option.textContent]), [
      ['5', '5 minutes'], ['15', '15 minutes (default)'], ['30', '30 minutes'], ['60', '1 hour'],
    ])
    assert.equal(select.value, '15')
    assert.equal(page.by('f-autoInterval-legacy').hidden, true)
    select.value = '60'
    select.dispatch('change')
    assert.match(page.by('schedule-summary').textContent, /^Checks every hour, Monday to Friday, from 09:00 until 18:00, in this computer's time zone \(.+\)\. The last check starts before 18:00\.$/)
    await page.save()
    assert.equal((page.puts[0]?.autoReview as Auto).intervalMinutes, 60)
  })
})

test('a saved check interval that is not a listed choice is shown selected as an extra marked option with an amber note, is no error, is saved back unchanged, and goes once another value is saved', async () => {
  await withCard(config({}, auto({ intervalMinutes: 10 })), async (page) => {
    const select = page.by('f-autoInterval')
    assert.deepEqual(select.querySelectorAll('option').map((option) => option.textContent), ['5 minutes', '10 minutes (saved, not a listed choice)', '15 minutes (default)', '30 minutes', '1 hour'])
    assert.equal(select.value, '10')
    const note = page.by('f-autoInterval-legacy')
    assert.equal(note.hidden, false)
    assert.equal(note.textContent, 'Saved as 10 minutes, which is not one of the choices. It keeps working as saved; pick a choice to change it.')
    assert.equal(select.getAttribute('aria-describedby'), 'f-autoInterval-legacy')
    assert.equal(page.by('f-autoInterval-error').hidden, true)
    assert.equal(page.by('save-status').textContent, '')
    assert.match(page.by('schedule-summary').textContent, /^Checks every 10 minutes,/)
    // changing something else writes the interval back as it was
    typeInto(page.by('f-autoDailyLimit'), '12')
    await page.save()
    assert.equal((page.puts[0]?.autoReview as Auto).intervalMinutes, 10)
    assert.equal(select.querySelectorAll('option').length, 5, 'still the saved value')
  })
  await withCard(config({}, auto({ intervalMinutes: 10 })), async (page) => {
    const select = page.by('f-autoInterval')
    select.value = '30'
    select.dispatch('change')
    assert.equal(page.by('f-autoInterval-legacy').hidden, true)
    assert.equal(select.querySelectorAll('option').length, 5, 'the option stays offered until another value is saved')
    await page.save()
    assert.equal((page.puts[0]?.autoReview as Auto).intervalMinutes, 30)
    assert.deepEqual(select.querySelectorAll('option').map((option) => option.textContent), ['5 minutes', '15 minutes (default)', '30 minutes', '1 hour'])
  })
})

// the days

test('the days are seven chips, Sunday first, each named by its full day, and the saved days are ticked', async () => {
  await withCard(config(), async (page) => {
    const chips = page.by('auto-days').children
    assert.deepEqual(chips.map((chip) => chip.textContent), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
    assert.deepEqual(chips.map((chip) => chip.querySelector('input')?.getAttribute('aria-label')), ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])
    assert.deepEqual(chips.map((chip) => chip.querySelector('input')?.checked), [false, true, true, true, true, true, false])
    // adding Sunday reads Sunday to Friday and is written Sunday first
    tick(page.by('f-autoDay-sun'))
    assert.match(page.by('schedule-summary').textContent, /^Checks every 15 minutes, Sunday to Friday, from/)
    await page.save()
    assert.deepEqual((page.puts[0]?.autoReview as { activeHours: { days: string[] } }).activeHours.days, ['sun', 'mon', 'tue', 'wed', 'thu', 'fri'])
  })
  // a saved Monday-first list is not an unsaved change
  await withCard(config({}, auto({ activeHours: { days: ['mon', 'sun'], from: '09:00', to: '18:00' } })), async (page) => {
    assert.equal(page.by('save-status').textContent, '')
  })
})

// the clone folder in the Agent card

test('a clone folder error reaches the field in the Agent card, from the page\'s check and from the server, and the Auto-review footer shows the path or an amber warning', async () => {
  await withCard(config(), async (page) => {
    assert.match(page.by('clone-ref').textContent, /^Each run works in its own worktree of ~\/dev\/orbit, never in the checkout itself\. Change in Agent$/)
    typeInto(page.by('f-cloneDir'), 'dev/orbit')
    assert.match(page.by('clone-ref').textContent, /dev\/orbit/)
    await page.save()
    assert.deepEqual(page.puts, [])
    assert.equal(page.by('f-cloneDir-error').textContent, 'Give an absolute path or a path under ~, such as ~/dev/orbit.')
    assert.equal(page.by('f-cloneDir').getAttribute('aria-invalid'), 'true')
    assert.match(page.by('form-errors').textContent, /: Give an absolute path or a path under ~, such as ~\/dev\/orbit\./)
    typeInto(page.by('f-cloneDir'), '')
    assert.equal(page.by('clone-ref').textContent, 'No clone folder is set, so no auto-review run can start. Set it in Agent')
    page.by('clone-ref').querySelector('a')?.dispatch('click')
    assert.equal(page.focused(), 'f-cloneDir')
  })
  await withCard(config(), async (page) => {
    typeInto(page.by('f-cloneDir'), '~/dev/other')
    await page.save()
    assert.equal(page.by('f-cloneDir-error').textContent, 'Must be an absolute path or one under ~.')
  }, { put: { status: 400, body: { error: 'config.cloneDir must be an absolute path or one under ~' } } })
})

// the words the card derives

test('Posts as follows the Viewing as field as typed, the link moves focus only when used, and a switch on for an unticked kind is called inert', async () => {
  await withCard(config({}, auto({ others: false, post: { others: true, dependabot: false } })), async (page) => {
    const posting = page.by('posting-as')
    assert.equal(posting.textContent, 'Posts as @vera-quill, the Viewing as login above. Change')
    typeInto(page.by('f-viewer'), 'ines-hale')
    assert.equal(posting.textContent, 'Posts as @ines-hale, the Viewing as login above. Change')
    typeInto(page.by('f-viewer'), '')
    assert.equal(posting.textContent, 'Posts as the Viewing as login, which is empty. Set Viewing as')
    assert.notEqual(page.focused(), 'f-viewer')
    posting.querySelector('a')?.dispatch('click')
    assert.equal(page.focused(), 'f-viewer')
    assert.equal(page.by('f-autoPostOthers-inert').hidden, false)
    assert.equal(page.by('f-autoPostOthers-inert').textContent, 'Other people\'s PRs is not ticked under What to review, so nothing posts until it is.')
    assert.equal(page.by('f-autoPostDependabot-inert').hidden, true)
    tick(page.by('f-autoOthers'))
    assert.equal(page.by('f-autoPostOthers-inert').hidden, true)
  })
})

test('the instructions reference line follows the Extra review instructions field and links to it', async () => {
  await withCard(config(), async (page) => {
    const line = page.by('instructions-ref')
    assert.equal(line.textContent, 'Reviews of people\'s PRs use your extra review instructions: none set. The Dependabot sweep never does. Edit in Agent')
    typeInto(page.by('f-extraReviewInstructions'), 'Skip generated files.')
    assert.equal(line.textContent, 'Reviews of people\'s PRs use your extra review instructions: “Skip generated files.”. The Dependabot sweep never does. Edit in Agent')
    line.querySelector('a')?.dispatch('click')
    assert.equal(page.focused(), 'f-extraReviewInstructions')
  })
})

test('the Now line reads the saved settings and the scheduler\'s view, says so while the form has unsaved changes, and says when there is no autoReview key or no view', async () => {
  await withCard(config(), async (page) => {
    assert.match(page.by('auto-now-text').textContent, /^On · next /)
    assert.equal(page.by('auto-now-meta').textContent.startsWith('3 of 10 runs started today · posting off · as of '), true)
    assert.equal(page.by('auto-now').dataset.tone, 'normal')
    assert.equal(page.by('auto-now-unsaved').hidden, true)
    typeInto(page.by('f-autoDailyLimit'), '4')
    assert.equal(page.by('auto-now-unsaved').hidden, false)
    assert.equal(page.by('auto-now-unsaved').textContent, 'This line reads the saved settings. Your changes apply once you save.')
    assert.equal(page.by('auto-now-meta').textContent.startsWith('3 of 10 runs'), true, 'still the saved limit')
  }, { view: emptyView(running()) })
  await withCard(config({}, auto({ enabled: false })), async (page) => {
    assert.equal(page.by('auto-now-text').textContent, 'Off')
  }, { view: emptyView(running({ enabled: false, state: 'off', nextTickAt: null })) })
  await withCard(config({}, auto({ post: { others: true, dependabot: false } })), async (page) => {
    assert.equal(page.by('auto-now').dataset.tone, 'warn')
    assert.equal(page.by('auto-now-text').textContent, 'Skipped: gh login differs from viewer')
    assert.equal(page.by('auto-now-fix').hidden, false)
    assert.equal(page.by('auto-now-fix').textContent, 'Every check skips until gh is signed in as @vera-quill.')
    assert.match(page.by('auto-now-meta').textContent, /posts other people's PRs as @vera-quill/)
  }, { view: emptyView(running({ state: 'blocked', lastTick: { at: new Date().toISOString(), state: 'skipped', skipReason: 'identityMismatch', queued: null } })) })
  await withCard(config({}, null), async (page) => {
    assert.equal(page.by('auto-now-text').textContent, 'Not set up')
    assert.equal(page.by('auto-now-meta').textContent, 'These are the defaults; nothing is saved until you change one and save.')
  }, { view: emptyView(null) })
  await withCard(config(), async (page) => {
    assert.equal(page.by('auto-now-text').textContent, 'Status unavailable')
  })
})

test('the Now line is not a live region, and the card does not store whether Limits is open', () => {
  assert.doesNotMatch(settingsHtml.slice(settingsHtml.indexOf('id="auto-now"'), settingsHtml.indexOf('Review PRs automatically')), /aria-live|role="status"/)
  const source = readFileSync(new URL('../public/settings.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /localStorage|sessionStorage/)
})
