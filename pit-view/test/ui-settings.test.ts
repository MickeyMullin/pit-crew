// test/ui-settings.test.ts
// the Settings page's pure logic (public/settings-form.ts), run under Node: config to form and
// back, the checks before saving, the server's refusals placed on fields, people suggestions and
// colors, and ticket samples checked against the dashboard's own derivation
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { defaultAutoReview } from '../src/autoreview.ts'
import { ConfigError, defaultConfig, idleRange, validateConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { deriveOpenRows, groupRows, personView } from '../src/derive.ts'
import { notificationKinds } from '../src/notify.ts'
import { cycleKeys } from '../src/poller.ts'
import type { View } from '../src/poller.ts'
import {
  aliasOf, changeKind, colorFor, contrastWithWhite, errorId, fieldId, initialsOf, isDirty, kindDefaults, needsRefresh, newPerson, newTicket,
  idleLimits, notifyChoices, openSuggestions, parseBots, parseIdleMinutes, parseMaxReviews, previewPerson, refreshChoices, refreshKeys, sampleTextsFrom, timeFormatChoices, serverError, ticketSample, toConfig, toForm,
  validateForm, autoDefaults, postingAsk, weekdayChoices, wantsPostConfirm,
} from '../public/settings-form.ts'
import type { Form, TicketForm } from '../public/settings-form.ts'
import { scenario } from './fixtures/scenario.ts'
import { fakeTime, openPage1, openPage2 } from './helpers.ts'

const ids = (): (() => string) => {
  let count = 0
  return () => {
    count += 1
    return `t${count}`
  }
}

// an invented config touching every setting the form edits
const sample = (): Config => ({
  ...defaultConfig(),
  repo: 'octo-example/orbit',
  viewer: 'vera-quill',
  // not on the page, so a save must carry it over
  allowedHosts: ['pit.example.test'],
  people: [
    { login: 'alex-mendez', alias: 'Alex', initials: 'AM', color: '#0F766E', avatar: 'initials' },
    { login: 'sam-tran', alias: 'Sam', initials: 'ST', color: '#B4410C', avatar: 'github' },
    { login: 'priya-k', alias: 'Priya', initials: 'PK', color: '#5B21B6', avatar: '~/Pictures/priya.png' },
  ],
  refreshSeconds: 120,
  idleMinutes: 120,
  todayStartsAt: 'utc',
  bots: ['dependabot', 'renovate', 'review-helper'],
  density: 'compact',
  timeFormat: '24h',
  showAgentColumn: true,
  maxConcurrentReviews: 3,
  selfReviewOverCap: true,
  // not on the page yet (P2.5 or later), so a save must carry them over
  cloneDir: '~/dev/orbit',
  agent: { runner: 'codex', claudeModel: 'sonnet', codexModel: 'gpt-6.1-terra' },
  notifications: { enabled: false, kinds: ['readyToMerge'] },
})

const formOf = (config: Config = sample()): Form => toForm(config, ids())

const fields = (form: Form): (string | null)[] => validateForm(form).map((error) => error.field)

// the message validateConfig throws for a config, as PUT /api/config sends it back
const refusal = (config: unknown): string => {
  try {
    validateConfig(config)
  } catch (error) {
    assert.ok(error instanceof ConfigError)
    return error.message
  }
  assert.fail('validateConfig accepted the config')
}

test('a config survives the trip to the form and back, settings the page does not edit included', () => {
  for (const config of [defaultConfig(), sample()]) {
    const back = toConfig(formOf(config), config)
    assert.deepEqual(back, config)
    assert.deepEqual(validateConfig(back), config)
  }
  const form = formOf()
  assert.deepEqual(form.people.map((person) => [person.avatarMode, person.avatarPath]), [['initials', ''], ['github', ''], ['image', '~/Pictures/priya.png']])
  assert.equal(form.bots, 'dependabot, renovate, review-helper')
  // every row has an id of its own
  assert.equal(new Set([...form.people, ...form.tickets].map((row) => row.id)).size, 5)
})

test('the form sends trimmed values and a clean bots list', () => {
  const form = formOf()
  form.repo = '  octo-example/rocket '
  form.people[0]!.alias = ' Alexandra '
  form.people[1]!.avatarMode = 'image'
  form.people[1]!.avatarPath = ' ~/sam.webp '
  form.tickets[0]!.baseUrl = ' https://tickets.example.com '
  form.bots = ' dependabot,\nrenovate , , Dependabot '
  const config = toConfig(form, sample())
  assert.equal(config.repo, 'octo-example/rocket')
  assert.equal(config.people[0]!.alias, 'Alexandra')
  assert.equal(config.people[1]!.avatar, '~/sam.webp')
  assert.equal(config.tickets[0]!.baseUrl, 'https://tickets.example.com')
  assert.deepEqual(config.bots, ['dependabot', 'renovate'])
  assert.deepEqual(parseBots(''), [])
})

test('unsaved changes are differences in what would be saved, not in spacing', () => {
  const saved = sample()
  const form = formOf(saved)
  assert.equal(isDirty(form, saved), false)
  form.bots = 'dependabot,renovate,review-helper  '
  form.repo = 'octo-example/orbit '
  assert.equal(isDirty(form, saved), false)
  form.refreshSeconds = 60
  assert.equal(isDirty(form, saved), true)
  form.refreshSeconds = 120
  form.people.pop()
  assert.equal(isDirty(form, saved), true)
})

test('only the settings the poller refreshes for start a refresh', () => {
  assert.deepEqual([...refreshKeys], [...cycleKeys])
  const before = sample()
  assert.equal(needsRefresh(before, { ...before, density: 'comfortable', timeFormat: '12h', refreshSeconds: 300, showAgentColumn: false }), false)
  assert.equal(needsRefresh(before, { ...before, bots: ['dependabot'] }), true)
  assert.equal(needsRefresh(before, { ...before, people: [] }), true)
})

test('the refresh interval offers 60 seconds, 2 minutes and 5 minutes, smallest first, with 5 minutes the default', () => {
  assert.deepEqual(refreshChoices.map((choice) => [choice.value, choice.label]), [[60, '60 seconds'], [120, '2 minutes'], [300, '5 minutes (default)']])
  assert.equal(defaultConfig().refreshSeconds, 300)
})

test('idle minutes edit as text: whole minutes, 0 for never, in the range the server accepts', () => {
  assert.deepEqual(idleLimits, idleRange)
  const form = formOf()
  assert.equal(form.idleMinutes, '120')
  assert.equal(formOf(defaultConfig()).idleMinutes, '90')
  form.idleMinutes = ' 45 '
  assert.equal(toConfig(form, sample()).idleMinutes, 45)
  assert.equal(isDirty(form, sample()), true)
  for (const good of ['0', '5', '90', '1440']) {
    form.idleMinutes = good
    assert.deepEqual(fields(form), [], good)
    assert.equal(validateConfig(toConfig(form, sample())).idleMinutes, Number(good))
  }
  for (const bad of ['', '4', '1441', '1.5', '-5', '90m', 'never']) {
    form.idleMinutes = bad
    assert.deepEqual(fields(form), ['idleMinutes'], bad)
  }
  assert.match(validateForm(form)[0]!.message, /^Use 0 for never, or a whole number of minutes from 5 to 1440\.$/)
  assert.ok(Number.isNaN(parseIdleMinutes('ninety')))
  // the server's refusal lands on the same field
  assert.deepEqual(serverError(refusal({ ...sample(), idleMinutes: 3 }), form), { field: 'idleMinutes', message: 'Must be 0 (never idle) or a whole number of minutes from 5 to 1440.' })
})

test('the review cap edits as text: a whole number of 1 or more, refused as zero, negative, or fractional, and the self-review switch rides along', () => {
  const form = formOf()
  assert.deepEqual([form.maxConcurrentReviews, form.selfReviewOverCap], ['3', true])
  assert.deepEqual([formOf(defaultConfig()).maxConcurrentReviews, formOf(defaultConfig()).selfReviewOverCap], ['2', false])
  form.maxConcurrentReviews = ' 5 '
  form.selfReviewOverCap = false
  const sent = toConfig(form, sample())
  assert.deepEqual([sent.maxConcurrentReviews, sent.selfReviewOverCap], [5, false])
  assert.equal(isDirty(form, sample()), true)
  for (const good of ['1', '2', '12']) {
    form.maxConcurrentReviews = good
    assert.deepEqual(fields(form), [], good)
    assert.equal(validateConfig(toConfig(form, sample())).maxConcurrentReviews, Number(good))
  }
  for (const bad of ['', '0', '00', '-1', '1.5', '2.0', 'two', '3 reviews']) {
    form.maxConcurrentReviews = bad
    assert.deepEqual(fields(form), ['maxConcurrentReviews'], bad)
  }
  assert.match(validateForm(form)[0]!.message, /^Use a whole number of 1 or more\.$/)
  assert.ok(Number.isNaN(parseMaxReviews('two')))
  // the server's refusals land on the same fields
  assert.deepEqual(serverError(refusal({ ...sample(), maxConcurrentReviews: 0 }), form), { field: 'maxConcurrentReviews', message: 'Must be a whole number of 1 or more.' })
  assert.deepEqual(serverError(refusal({ ...sample(), selfReviewOverCap: 'yes' }), form), { field: 'selfReviewOverCap', message: 'Must be true or false.' })
})

test('the page takes every review cap the server takes and refuses every one it refuses, five digits and more included', () => {
  // a stored cap of five digits saves unchanged
  const stored = { ...sample(), maxConcurrentReviews: 10_000 }
  const form = toForm(stored, () => 'id')
  assert.equal(form.maxConcurrentReviews, '10000')
  assert.deepEqual(fields(form), [])
  assert.equal(isDirty(form, stored), false)
  assert.equal(validateConfig(toConfig(form, stored)).maxConcurrentReviews, 10_000)
  form.maxConcurrentReviews = '100000'
  assert.deepEqual(fields(form), [])
  assert.equal(toConfig(form, stored).maxConcurrentReviews, 100_000)
  // the page sees the number as the field shows it, in digits, and agrees with the server on each
  for (const value of [1, 2, 9999, 10_000, 100_000, 123_456_789, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 1e21, 0, -1, 1.5]) {
    form.maxConcurrentReviews = String(value)
    let server = true
    try {
      validateConfig({ ...stored, maxConcurrentReviews: value })
    } catch {
      server = false
    }
    assert.equal(fields(form).length === 0, server, String(value))
  }
})

test('a valid form passes the checks, and the server accepts what it sends', () => {
  const form = formOf()
  assert.deepEqual(validateForm(form), [])
  assert.doesNotThrow(() => validateConfig(toConfig(form, sample())))
  // an empty viewer means the gh login
  form.viewer = ''
  assert.deepEqual(validateForm(form), [])
})

test('the checks name the field each problem belongs to', () => {
  const form = formOf()
  form.repo = 'orbit'
  form.viewer = 'vera quill'
  form.people[0]!.login = ''
  form.people[1]!.login = 'ALEX-MENDEZ'
  form.people[2]!.login = 'Alex-Mendez'
  form.people[1]!.alias = ' '
  form.people[1]!.initials = 'ABCD'
  form.people[1]!.color = 'teal'
  form.people[2]!.avatarPath = '/tmp/priya.png'
  form.reportsDir = ''
  assert.deepEqual(fields(form), [
    'repo', 'viewer', 'people.0.login', 'people.1.alias', 'people.1.initials', 'people.1.color',
    'people.2.login', 'people.2.avatarPath', 'reportsDir',
  ])
  form.people[2]!.avatarPath = '~/priya.svg'
  assert.ok(fields(form).includes('people.2.avatarPath'))
})

test('ticket checks: a pattern only where one is used, and well-formed URLs and placeholders', () => {
  const form = formOf()
  form.tickets[0]!.pattern = '([a-z]+'
  form.tickets[0]!.baseUrl = 'tickets.example.com'
  form.tickets[1]!.pattern = ''
  form.tickets[1]!.linkTemplate = 'https://github.com/{repo}/issues/{number}'
  form.tickets[1]!.name = ''
  assert.deepEqual(fields(form), ['tickets.0.pattern', 'tickets.0.baseUrl', 'tickets.1.name', 'tickets.1.linkTemplate'])
  form.tickets[0]!.pattern = '  '
  assert.match(validateForm(form)[0]!.message, /Enter a key pattern/)
  // the server would refuse the same bad pattern
  assert.match(refusal({ ...sample(), tickets: [{ ...sample().tickets[0], pattern: '([a-z]+' }] }), /tickets\[0\]\.pattern/)
})

test('every error has the ids its field and message use', () => {
  assert.equal(fieldId('repo'), 'f-repo')
  assert.equal(fieldId('people.2.avatarPath'), 'f-people-2-avatarPath')
  assert.equal(errorId('tickets.0.pattern'), 'f-tickets-0-pattern-error')
})

test('the server\'s refusals land on the field they name, and the rest stay with the form', () => {
  const form = formOf()
  const config = sample()
  const place = (bad: unknown) => serverError(refusal(bad), form)
  assert.deepEqual(place({ ...config, refreshSeconds: 10 }), { field: 'refreshSeconds', message: 'Must be one of 60, 120, 300.' })
  assert.deepEqual(place({ ...config, repo: 'orbit' }), { field: 'repo', message: 'Must look like owner/name.' })
  const people = config.people.map((person) => ({ ...person }))
  people[2]!.avatar = '/elsewhere/priya.png'
  assert.equal(place({ ...config, people }).field, 'people.2.avatarPath')
  const ticket = { ...config.tickets[1]!, kind: 'trello' }
  assert.equal(place({ ...config, tickets: [config.tickets[0], ticket] }).field, 'tickets.1.kind')
  // validateConfig rejects unknown keys; the form has no field for them
  const unknown = place({ ...config, theme: 'dark' })
  assert.equal(unknown.field, null)
  assert.match(unknown.message, /config\.theme is not a known setting/)
  assert.equal(place({ ...config, people: [{ ...people[0], nickname: 'Al' }] }).field, null)
  assert.equal(serverError('body is not valid JSON', form).field, null)
})

test('initials and a first alias match what the dashboard shows for an unlisted login', () => {
  const config = { ...defaultConfig(), viewer: scenario.viewer }
  for (const login of ['alex-mendez', 'lee-park', 'dependabot', 'review_helper', 'q']) {
    assert.equal(initialsOf(login), personView(login, null, config).initials, login)
  }
  assert.equal(aliasOf('sam-tran'), 'Sam')
  assert.equal(aliasOf('app/dependabot'), 'App')
})

test('a new person\'s color is fixed by the login and keeps white initials readable', () => {
  assert.equal(colorFor('sam-tran'), colorFor('Sam-Tran'))
  assert.notEqual(colorFor('sam-tran'), colorFor('lee-park'))
  assert.ok(contrastWithWhite('#FFFFFF') < 1.01)
  assert.ok(contrastWithWhite('#000000') > 20)
  for (let index = 0; index < 400; index += 1) {
    const color = colorFor(`person-${index}`)
    assert.match(color, /^#[0-9A-F]{6}$/)
    assert.ok(contrastWithWhite(color) >= 4.5, `${color} reads at ${contrastWithWhite(color).toFixed(2)}:1`)
  }
})

test('suggestions leave out anyone already listed, saved or not, and fill a row when added', () => {
  const form = formOf()
  form.people.push(newPerson('t99', 'Lee-Park'))
  const suggestions = [
    { login: 'sam-tran', avatarUrl: 'https://avatars.example/sam', count: 4 },
    { login: 'lee-park', avatarUrl: 'https://avatars.example/lee', count: 2 },
    { login: 'dependabot', avatarUrl: 'https://avatars.example/bot', count: 1 },
  ]
  assert.deepEqual(openSuggestions(suggestions, form).map((entry) => entry.login), ['dependabot'])
  const added = newPerson('t100', 'dependabot')
  assert.deepEqual({ ...added, color: '' }, { id: 't100', login: 'dependabot', alias: 'Dependabot', initials: 'DE', color: '', avatarMode: 'github', avatarPath: '' })
  assert.equal(newPerson('t101').login, '')
})

test('the preview draws a row the way the dashboard would', () => {
  const [initials, github, image] = formOf().people
  assert.deepEqual(previewPerson(initials!), { login: 'alex-mendez', alias: 'Alex', initials: 'AM', color: '#0F766E', avatarUrl: null })
  assert.equal(previewPerson(github!).avatarUrl, 'https://github.com/sam-tran.png')
  // a local image shows only once saved at that path, since the server serves only the saved one
  assert.equal(previewPerson(image!).avatarUrl, null)
  assert.equal(previewPerson(image!, sample().people).avatarUrl, '/api/avatar/priya-k')
  assert.equal(previewPerson({ ...image!, avatarPath: '~/pictures/other.png' }, sample().people).avatarUrl, null)
  const unfinished = newPerson('t1')
  unfinished.login = 'new-face'
  unfinished.color = 'nope'
  assert.deepEqual(previewPerson(unfinished), { login: 'new-face', alias: 'new-face', initials: 'NF', color: null, avatarUrl: 'https://github.com/new-face.png' })
})

test('the kind defaults are the shipped defaults, and a kind change keeps what was typed', () => {
  const [jira, github] = defaultConfig().tickets
  assert.deepEqual({ ...newTicket('a', 'jira'), id: undefined }, { ...jira, id: undefined })
  assert.deepEqual({ ...newTicket('b', 'github-issues'), id: undefined }, { ...github, id: undefined })
  assert.equal(kindDefaults.linear.linkTemplate, '{baseUrl}/issue/{key}')
  const untouched = changeKind(newTicket('c', 'jira'), 'github-issues')
  assert.deepEqual({ ...untouched, id: undefined }, { ...github, id: undefined })
  const typed: TicketForm = { ...newTicket('d', 'jira'), name: 'Tracker', baseUrl: 'https://tickets.example.com' }
  const changed = changeKind(typed, 'linear')
  assert.equal(changed.kind, 'linear')
  assert.equal(changed.name, 'Tracker')
  assert.equal(changed.baseUrl, 'https://tickets.example.com')
  assert.equal(changed.linkTemplate, '{baseUrl}/issue/{key}')
})

// a view holding the fixture's open rows, as GET /api/view would serve them
const fixtureView = async (config: Config): Promise<View> => {
  const prs = [...(await openPage1()).data.repository!.pullRequests.nodes, ...(await openPage2()).data.repository!.pullRequests.nodes]
  const rows = deriveOpenRows(prs, scenario.defaultBranch, { config, clock: fakeTime().clock, timeZone: scenario.timeZone })
  return { ...groupRows(rows) } as unknown as View
}

test('a ticket sample is the chip the dashboard shows for the first cached PR the pattern finds', async () => {
  const config: Config = { ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer }
  config.tickets[0]!.baseUrl = 'https://tickets.example.com/'
  const view = await fixtureView(config)
  const texts = sampleTextsFrom(view)
  assert.ok(texts.length > 0)
  const form = toForm(config, ids())
  const shown = ticketSample(form.tickets[0]!, config.repo, texts)
  assert.ok(shown.label !== null)
  const number = Number(/#(\d+)$/.exec(shown.where)?.[1])
  const row = [...view.mine.groups, ...view.others.groups].flatMap((group) => group.rows as { number: number, tickets: unknown[] }[]).find((entry) => entry.number === number)
  assert.ok(row !== undefined, `the sample came from #${number}`)
  assert.ok(row.tickets.some((ticket) => JSON.stringify(ticket) === JSON.stringify({ system: 'Jira', label: shown.label, url: shown.url })), JSON.stringify(row.tickets))
})

test('ticket samples: linked issues, no link without a base URL, and the reasons for none', () => {
  const form = formOf(defaultConfig())
  const [jira, github] = form.tickets as [TicketForm, TicketForm]
  assert.deepEqual(ticketSample(github, 'octo-example/orbit', []), { label: '#42', url: 'https://github.com/octo-example/orbit/issues/42', where: 'an example linked issue' })
  assert.deepEqual(ticketSample(jira, 'octo-example/orbit', []), { label: 'ABC-123', url: null, where: 'an example key' })
  assert.deepEqual(ticketSample(jira, 'octo-example/orbit', [{ text: 'fix: ORB-7 tidy', where: 'the title of #1' }]), { label: 'ORB-7', url: null, where: 'the title of #1' })
  assert.deepEqual(ticketSample({ ...jira, pattern: '(' }, 'x/y', []), { label: null, reason: 'invalid pattern' })
  assert.deepEqual(ticketSample({ ...jira, pattern: '' }, 'x/y', []), { label: null, reason: 'no pattern yet' })
  assert.deepEqual(ticketSample({ ...jira, pattern: 'zzz-\\d{9}' }, 'x/y', []), { label: null, reason: 'no match yet' })
  assert.deepEqual(sampleTextsFrom(null), [])
})

test('ticket samples fall back to closed PR titles when no open PR carries a key', async () => {
  const config: Config = { ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer }
  const view = await fixtureView(config)
  const closedRow = { number: 90, title: 'feat: wire up ZED-314 reports' }
  const withClosed = { ...view, closed: { today: { rows: [closedRow] }, yesterday: { rows: [] } } } as unknown as View
  const texts = sampleTextsFrom(withClosed)
  assert.deepEqual(texts.at(-1), { text: closedRow.title, where: 'the title of #90, closed' })
  const jira = toForm(config, ids()).tickets[0]!
  assert.deepEqual(ticketSample({ ...jira, pattern: '\\bzed-\\d+\\b' }, config.repo, texts), { label: 'ZED-314', url: null, where: 'the title of #90, closed' })
})

test('the page lists exactly the notification kinds the server knows, in the same order', () => {
  assert.deepEqual(notifyChoices.map((choice) => choice.kind), notificationKinds)
})

test('notifications round-trip: absent stays absent until the form leaves its default, a saved key stays', () => {
  const config = defaultConfig()
  assert.equal('notifications' in toConfig(formOf(config), config), false)
  const form = formOf(config)
  assert.deepEqual([form.notifyEnabled, form.notifyKinds], [false, [...notificationKinds]])
  form.notifyEnabled = true
  form.notifyKinds = ['ciFailing', 'readyToMerge']
  // saved in the page's order, not the order they were ticked
  assert.deepEqual(toConfig(form, config).notifications, { enabled: true, kinds: ['readyToMerge', 'ciFailing'] })
  assert.equal(isDirty(form, config), true)
  // off with every kind is the default; a config that had the key keeps it
  const off = { ...config, notifications: { enabled: false, kinds: [...notificationKinds] } }
  assert.deepEqual(toConfig(formOf(off), off).notifications, off.notifications)
  assert.equal(isDirty(formOf(off), off), false)
  // the server accepts what the page sends
  assert.deepEqual(validateConfig(toConfig(form, config)).notifications, { enabled: true, kinds: ['readyToMerge', 'ciFailing'] })
})

// the Settings page's card layout, read from public/settings.html: which fields sit in which card, in what order, under which labels
const settingsHtml = async (): Promise<string> => readFile(new URL('../public/settings.html', import.meta.url), 'utf8')

const cardOf = (html: string, id: string): string => {
  const start = html.indexOf(`<section id="${id}"`)
  assert.notEqual(start, -1, `the ${id} card exists`)
  return html.slice(start, html.indexOf('</section>', start))
}

const fieldsIn = (card: string): string[] => [...card.matchAll(/id="f-([A-Za-z]+)"/g)].map((match) => match[1] as string).filter((name, at, all) => all.indexOf(name) === at)

test('the Agent card holds the Agent column switch, then Concurrent reviews, then Self-review over limit, then Extra review instructions, and none of them stays in Behavior', async () => {
  const html = await settingsHtml()
  const agent = cardOf(html, 'agent')
  assert.match(agent, /<h2 id="agent-heading" class="card-title">Agent<\/h2>/)
  assert.match(agent, /aria-labelledby="agent-heading"/)
  assert.deepEqual(fieldsIn(agent), ['showAgentColumn', 'maxConcurrentReviews', 'selfReviewOverCap', 'extraReviewInstructions'])
  assert.match(agent, /Show the Agent column/)
  assert.match(agent, /<label for="f-maxConcurrentReviews">Concurrent reviews<\/label>/)
  assert.match(agent, /<span class="field-label">Self-review over limit<\/span>/)
  // the setting changes whether a self-review fits, never its place in line
  assert.match(agent, /may start while the limit is reached, once every review queued before it has started or left the queue/)
  assert.doesNotMatch(agent, /never waits/)
  const behavior = fieldsIn(cardOf(html, 'behavior'))
  assert.deepEqual(behavior, ['refreshSeconds', 'idleMinutes', 'todayStartsAt', 'bots', 'reportsDir', 'density', 'timeFormat'])
})

test('the time format is a Behavior choice, 12 hour first and the default, and it round-trips through the form', () => {
  assert.deepEqual(timeFormatChoices.map((choice) => choice.value), ['12h', '24h'])
  assert.match(timeFormatChoices[0]?.label ?? '', /12 hour.*default/)
  const form = formOf()
  assert.equal(form.timeFormat, '24h')
  form.timeFormat = '12h'
  assert.equal(toConfig(form, sample()).timeFormat, '12h')
  assert.equal(formOf({ ...sample(), timeFormat: '12h' }).timeFormat, '12h')
})

test('the Behavior card has a labeled time format select with a hint and an error slot', async () => {
  const behavior = cardOf(await settingsHtml(), 'behavior')
  assert.match(behavior, /<label for="f-timeFormat">Time format<\/label>/)
  assert.match(behavior, /<select id="f-timeFormat" class="input" aria-describedby="f-timeFormat-hint"><\/select>/)
  assert.match(behavior, /id="f-timeFormat-error" class="field-error" hidden/)
})

test('the Agent card sits right after Behavior, then Auto-review, then Notifications, and no old label survives anywhere on the page', async () => {
  const html = await settingsHtml()
  const order = ['repository', 'people', 'tickets', 'behavior', 'agent', 'auto-review', 'notifications'].map((id) => html.indexOf(`<section id="${id}"`))
  assert.ok(order.every((at, index) => at !== -1 && (index === 0 || at > (order[index - 1] as number))), order.join(','))
  assert.doesNotMatch(html, /Reviews at once|Self-review over the limit/i)
})

test('a save carries the autoReview key over whole, and a config without one stays without one', () => {
  const autoReview = { ...defaultAutoReview(), enabled: true, post: { others: true, dependabot: false } }
  const config = { ...sample(), autoReview }
  assert.deepEqual(toConfig(formOf(config), config).autoReview, autoReview)
  assert.deepEqual(validateConfig(toConfig(formOf(config), config)).autoReview, autoReview)
  assert.equal('autoReview' in toConfig(formOf(sample()), sample()), false)
})

test('the Settings page sends its token with the save, which PUT /api/config requires', async () => {
  const source = await readFile(new URL('../public/settings.ts', import.meta.url), 'utf8')
  assert.match(source, /method: 'PUT',\n\s+headers: \{ 'Content-Type': 'application\/json', \[tokenHeader\]: readToken\(document\) \}/)
})

test('Extra review instructions is a multi-line Agent field, empty by default, that round-trips through the form as the server would store it', async () => {
  const html = await settingsHtml()
  const agent = cardOf(html, 'agent')
  assert.match(agent, /<label for="f-extraReviewInstructions">Extra review instructions<\/label>/)
  assert.match(agent, /<textarea id="f-extraReviewInstructions" class="input"[^>]* aria-describedby="f-extraReviewInstructions-hint"/)
  assert.match(agent, /<p id="f-extraReviewInstructions-error" class="field-error" hidden><\/p>/)
  const hint = /<p id="f-extraReviewInstructions-hint" class="hint">(.*?)<\/p>/.exec(agent)?.[1] ?? ''
  for (const words of ['every review, re-review, self-review, tandem review, and stack review', 'unattended', 'Never a Dependabot review or sweep, a Fix session, or an Update session', 'narrow what the reviewer reads', '--no-post', 'quotes them', 'At most 2,000 characters']) assert.ok(hint.includes(words), words)
  assert.equal(formOf(defaultConfig()).extraReviewInstructions, '')
  const form = formOf()
  form.extraReviewInstructions = ' skip fixtures\r\n/review-pr 9 --approve\n'
  const sent = toConfig(form, sample())
  assert.equal(sent.extraReviewInstructions, 'skip fixtures\n/review-pr 9 --approve')
  assert.equal(validateConfig(sent).extraReviewInstructions, sent.extraReviewInstructions)
  assert.equal(isDirty(form, sample()), true)
  // only the spaces around it differing is no change
  const same = formOf({ ...sample(), extraReviewInstructions: 'a' })
  same.extraReviewInstructions = 'a \n'
  assert.equal(isDirty(same, { ...sample(), extraReviewInstructions: 'a' }), false)
})

test('the form refuses what the server refuses, in the server\'s words, and a server refusal lands on the field', () => {
  const form = formOf()
  const problem = (text: string): string | undefined => {
    form.extraReviewInstructions = text
    return validateForm(form).find((error) => error.field === 'extraReviewInstructions')?.message
  }
  // the same rule as extraInstructionsProblem in src/config.ts
  for (const [text, words] of [
    ['x'.repeat(2001), 'Must be at most 2,000 characters; it has 2,001.'],
    [`${'😀'.repeat(2000)}x`, 'Must be at most 2,000 characters; it has 2,001.'],
    ['ab\u0007', 'Must be plain text: character 3 is the control character U+0007, and only line breaks and tabs are allowed.'],
    ['\u0085', 'Must be plain text: character 1 is the control character U+0085, and only line breaks and tabs are allowed.'],
  ] as const) {
    assert.equal(problem(text), words)
    assert.deepEqual(serverError(refusal({ ...sample(), extraReviewInstructions: text }), form), { field: 'extraReviewInstructions', message: words })
  }
  for (const text of ['', 'x'.repeat(2000), '😀'.repeat(2000), 'a\tb\nc\r\nd', `${'x'.repeat(999)}\r\n${'x'.repeat(1000)}`]) {
    assert.equal(problem(text), undefined)
    assert.equal(validateConfig({ ...sample(), extraReviewInstructions: text }).extraReviewInstructions, text.replace(/\r\n/g, '\n'))
  }
})

test('the field is wired as a static text field, and a textarea is drawn taller than an input', async () => {
  const source = await readFile(new URL('../public/settings.ts', import.meta.url), 'utf8')
  assert.match(source, /const staticText = \[[^\]]*'extraReviewInstructions'[^\]]*\] as const/)
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8')
  assert.match(styles, /textarea\.input \{[^}]*height: auto;/)
})

// auto-review in Settings (section 10, In the UI)

test('a config without autoReview shows the shipped defaults, leaves the key out until the form leaves them, and a clone folder rides along', () => {
  const plain = sample()
  const form = formOf(plain)
  assert.deepEqual(
    [form.autoEnabled, form.autoInterval, form.autoDays, form.autoFrom, form.autoTo, form.autoOthers, form.autoOwn, form.autoDependabot, form.autoConcurrency, form.autoDailyLimit, form.autoPostOthers, form.autoPostDependabot],
    [false, '15', ['mon', 'tue', 'wed', 'thu', 'fri'], '09:00', '18:00', true, false, false, '1', '10', false, false],
  )
  assert.equal(form.cloneDir, '~/dev/orbit')
  assert.equal('autoReview' in toConfig(form, plain), false)
  // turning it on writes the whole key, as the server requires, and the server accepts it
  form.autoEnabled = true
  const sent = toConfig(form, plain)
  assert.deepEqual(sent.autoReview, {
    enabled: true, intervalMinutes: 15, activeHours: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '18:00' },
    others: true, own: false, dependabot: false, concurrency: 1, dailyLimit: 10, post: { others: false, dependabot: false },
  })
  assert.deepEqual(validateConfig(sent).autoReview, sent.autoReview)
  // and turning it back off in the form leaves the key out again when nothing else changed
  form.autoEnabled = false
  assert.equal('autoReview' in toConfig(form, plain), false)
  // the page's defaults are the server's
  assert.deepEqual(autoDefaults, defaultAutoReview())
})

test('every auto-review option edits through the form and reaches the config as the server stores it', () => {
  const saved: Config = { ...sample(), autoReview: { ...defaultAutoReview(), enabled: true } }
  const form = formOf(saved)
  assert.equal(isDirty(form, saved), false)
  form.autoInterval = ' 30 '
  form.autoDays = ['tue', 'mon', 'sat']
  form.autoFrom = '08:30'
  form.autoTo = '17:45'
  form.autoOthers = false
  form.autoOwn = true
  form.autoDependabot = true
  form.autoConcurrency = '2'
  form.autoDailyLimit = '25'
  form.autoPostOthers = true
  form.autoPostDependabot = true
  form.cloneDir = ' ~/dev/orbit-clone '
  assert.equal(isDirty(form, saved), true)
  assert.deepEqual(validateForm(form), [])
  const sent = toConfig(form, saved)
  // days are written in week order, whatever order they were chosen in
  assert.deepEqual(sent.autoReview, {
    enabled: true, intervalMinutes: 30, activeHours: { days: ['mon', 'tue', 'sat'], from: '08:30', to: '17:45' },
    others: false, own: true, dependabot: true, concurrency: 2, dailyLimit: 25, post: { others: true, dependabot: true },
  })
  assert.equal(sent.cloneDir, '~/dev/orbit-clone')
  assert.deepEqual(validateConfig(sent), sent)
  // clearing the clone folder leaves it out, as the server reads an empty one
  form.cloneDir = '  '
  assert.equal('cloneDir' in toConfig(form, saved), false)
  // days saved out of week order are not unsaved changes
  const odd: Config = { ...saved, autoReview: { ...saved.autoReview!, activeHours: { days: ['fri', 'mon'], from: '09:00', to: '18:00' } } }
  assert.equal(isDirty(formOf(odd), odd), false)
  assert.deepEqual(weekdayChoices.map((day) => day.value), ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
})

test('the checks refuse what the server refuses for auto-review, name the field, and use the same words on the page and from the server', () => {
  const saved: Config = { ...sample(), autoReview: defaultAutoReview() }
  const problems = (patch: Partial<Form>): [string, string][] => validateForm({ ...formOf(saved), ...patch }).map((error) => [error.field ?? '', error.message])
  assert.deepEqual(problems({}), [])
  for (const bad of ['4', '0', '', 'abc', '5.5', '-5', '99999999999999999999']) {
    assert.deepEqual(problems({ autoInterval: bad }), [['autoInterval', 'Use a whole number of minutes, 5 or more.']], bad)
  }
  assert.deepEqual(problems({ autoInterval: '5' }), [])
  for (const bad of ['0', '', '1.5', '-1', 'ten', '99999999999999999999']) {
    assert.deepEqual(problems({ autoDailyLimit: bad }), [['autoDailyLimit', 'Use a whole number of 1 or more.']], bad)
    assert.deepEqual(problems({ autoConcurrency: bad }), [['autoConcurrency', 'Use a whole number of 1 or more.']], bad)
  }
  assert.deepEqual(problems({ autoDailyLimit: '1' }), [])
  assert.deepEqual(problems({ autoDays: [] }), [['autoDays', 'Choose at least one day.']])
  assert.deepEqual(problems({ autoFrom: '9:00' }), [['autoFrom', 'Use a 24-hour time such as 09:00.']])
  assert.deepEqual(problems({ autoTo: '24:00' }), [['autoTo', 'Use a 24-hour time such as 09:00.']])
  assert.deepEqual(problems({ autoFrom: '18:00', autoTo: '09:00' }), [['autoTo', 'Must be after the start time.']])
  assert.deepEqual(problems({ autoFrom: '09:00', autoTo: '09:00' }), [['autoTo', 'Must be after the start time.']])
  assert.deepEqual(problems({ cloneDir: 'dev/orbit' }), [['cloneDir', 'Give an absolute path or a path under ~, such as ~/dev/orbit.']])
  assert.deepEqual(problems({ cloneDir: '' }), [])
  // each refusal the page makes, the server makes too
  for (const [patch, key] of [
    [{ intervalMinutes: 4 }, 'autoInterval'], [{ dailyLimit: 0 }, 'autoDailyLimit'], [{ concurrency: 0 }, 'autoConcurrency'], [{ dailyLimit: 1.5 }, 'autoDailyLimit'],
    [{ activeHours: { days: [], from: '09:00', to: '18:00' } }, 'autoDays'], [{ activeHours: { days: ['mon'], from: '18:00', to: '09:00' } }, 'autoFrom'],
    [{ activeHours: { days: ['mon'], from: '9am', to: '18:00' } }, 'autoFrom'],
  ] as const) {
    const config = { ...saved, autoReview: { ...saved.autoReview!, ...patch } } as unknown as Config
    assert.equal(serverError(refusal(config), formOf(saved)).field, key, JSON.stringify(patch))
  }
  assert.equal(serverError(refusal({ ...saved, cloneDir: 'dev/orbit' }), formOf(saved)).field, 'cloneDir')
})

test('turning a posting switch on asks first, naming what will post and under which login; turning one off, or leaving it on, does not', () => {
  const form = formOf({ ...sample(), autoReview: { ...defaultAutoReview(), post: { others: false, dependabot: true } } })
  assert.equal(wantsPostConfirm(form, 'others', true), true)
  assert.equal(wantsPostConfirm(form, 'others', false), false)
  // already on: nothing to confirm, and no question when it is turned off
  assert.equal(wantsPostConfirm(form, 'dependabot', true), false)
  assert.equal(wantsPostConfirm(form, 'dependabot', false), false)
  assert.deepEqual(postingAsk('others', 'vera-quill'), {
    title: 'Let auto-review post to GitHub as @vera-quill?',
    lines: [
      'Auto-review runs on other people\'s PRs will post their report as @vera-quill: an approval, a request for changes, or a comment, chosen by the findings and the checks.',
      'Your own PRs never post, and never get fixes, whatever this says.',
      'It applies to runs that start after you save.',
    ],
    confirm: 'Post as @vera-quill',
    cancel: 'Cancel',
  })
  assert.deepEqual(postingAsk('dependabot', 'vera-quill'), {
    title: 'Let scheduled Dependabot sweeps post to GitHub as @vera-quill?',
    lines: [
      'Each scheduled sweep will have its reviewers post as @vera-quill: an approval for a bump with nothing above P3 and green checks, and a comment or a request for changes for the rest.',
      'A sweep you start by hand already posts this way, with or without this switch.',
      'It applies to sweeps that start after you save.',
    ],
    confirm: 'Post as @vera-quill',
    cancel: 'Cancel',
  })
  // no login resolved yet: the question still says whose account it is
  assert.equal(postingAsk('others', '').title, 'Let auto-review post to GitHub as your gh login?')
  assert.equal(postingAsk('others', '').confirm, 'Post as your gh login')
})

test('the Auto-review card holds every option in order, a labeled control and an error slot for each, the daily limit\'s note, the posting switches, and the login agent as a separate item', async () => {
  const html = await settingsHtml()
  const auto = cardOf(html, 'auto-review')
  assert.match(auto, /<h2 id="auto-review-heading" class="card-title">Auto-review<\/h2>/)
  assert.match(auto, /aria-labelledby="auto-review-heading"/)
  assert.deepEqual(fieldsIn(auto), ['autoEnabled', 'autoInterval', 'autoDays', 'autoFrom', 'autoTo', 'autoOthers', 'autoOwn', 'autoDependabot', 'autoConcurrency', 'autoDailyLimit', 'cloneDir', 'autoPostOthers', 'autoPostDependabot'])
  for (const field of ['autoEnabled', 'autoInterval', 'autoDays', 'autoFrom', 'autoTo', 'autoOthers', 'autoOwn', 'autoDependabot', 'autoConcurrency', 'autoDailyLimit', 'cloneDir', 'autoPostOthers', 'autoPostDependabot']) {
    assert.match(auto, new RegExp(`id="f-${field}-error" class="field-error" hidden`), field)
    assert.match(auto, new RegExp(`id="f-${field}-hint"`), field)
  }
  assert.match(auto, /<label for="f-autoDailyLimit">Daily limit<\/label>/)
  assert.match(auto, /<input id="f-autoDailyLimit" class="input mono" type="number"[^>]*min="1" step="1"/)
  assert.match(auto, /a whole number of 1 or more, 10 by default\. It caps only auto-review runs/)
  assert.match(auto, /Each auto-review run uses its own worktree of this clone and never the checkout itself/)
  assert.match(auto, /Runs happen whenever Pit View is running, with or without a page open/)
  // the two posting questions in the owner\'s words, each with a confirmation slot of its own
  assert.match(auto, /Post auto-reviews of other people's PRs\?/)
  assert.match(auto, /Post scheduled Dependabot sweeps\?/)
  assert.match(auto, /id="auto-post-ask-others" class="post-ask" role="group" hidden/)
  assert.match(auto, /id="auto-post-ask-dependabot" class="post-ask" role="group" hidden/)
  // the login agent is shown beside it, outside the form\'s fields, with the note that auto-review does not need it
  assert.match(auto, /Start at login \(optional\)/)
  assert.match(auto, /id="login-agent-status"/)
  assert.match(auto, /Auto-review does not need it/)
  assert.doesNotMatch(auto, /id="f-loginAgent/)
})

test('the page asks before a posting switch turns on through an in-app confirmation, never a browser dialog, and keeps the switch off until it is confirmed', async () => {
  const source = await readFile(new URL('../public/settings.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\b(?:window\.)?(?:confirm|alert|prompt)\(/)
  // the change handler decides with the pure rule, puts the switch back off, and opens the question
  assert.match(source, /if \(wantsPostConfirm\(page\.form, kind, box\.checked\)\) \{\s*box\.checked = false\s*page\.postAsk = kind/)
  // only the confirm button sets the form value to on
  assert.equal([...source.matchAll(/page\.form\[key\] = true/g)].length, 1)
})
