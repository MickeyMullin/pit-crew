// test/ui-settings.test.ts
// the Settings page's pure logic (public/settings-form.ts), run under Node: config to form and
// back, the checks before saving, the server's refusals placed on fields, people suggestions and
// colors, and ticket samples checked against the dashboard's own derivation
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { defaultAutoReview } from '../src/autoreview.ts'
import { weekdayNames } from '../src/config.ts'
import { ConfigError, defaultConfig, idleRange, validateConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { deriveOpenRows, groupRows, personView } from '../src/derive.ts'
import { notificationKinds } from '../src/notify.ts'
import { cycleKeys } from '../src/poller.ts'
import type { View } from '../src/poller.ts'
import {
  aliasOf, changeKind, colorFor, contrastWithWhite, errorId, fieldId, initialsOf, isDirty, kindDefaults, needsRefresh, newPerson, newTicket,
  idleLimits, notifyChoices, openSuggestions, parseBots, parseIdleMinutes, parseMaxReviews, previewPerson, refreshChoices, refreshKeys, sampleTextsFrom, timeFormatChoices, serverError, ticketSample, toConfig, toForm,
  validateForm, autoDefaults, postingAsk, postingLoginOf, postAskIsStale, postSwitchesToTurnOff, postingNeedsViewer, postViewerNeededText, weekdayChoices, wantsPostConfirm,
  atSectionDefaults, autoCapError, inertPostKinds, inertPostNote, instructionsLine, intervalChoices, intervalLegacyNote, intervalOptions, limitsSummary, nowLine, nowNotSetUp,
  nowUnsavedNote, opensLimits, postingAsLine, resetSection, scheduleSummary,
} from '../public/settings-form.ts'
import type { AutoReviewView } from '../src/autoreview.ts'
import { setTimeFormat } from '../public/format.ts'
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

test('the Agent card holds the Agent column switch, then Concurrent reviews, then the Clone folder, then Self-review over limit, then Extra review instructions, and none of them stays in Behavior', async () => {
  const html = await settingsHtml()
  const agent = cardOf(html, 'agent')
  assert.match(agent, /<h2 id="agent-heading" class="card-title">Agent<\/h2>/)
  assert.match(agent, /aria-labelledby="agent-heading"/)
  // the Clone folder moved here from Auto-review, after Concurrent reviews
  assert.deepEqual(fieldsIn(agent), ['showAgentColumn', 'maxConcurrentReviews', 'cloneDir', 'selfReviewOverCap', 'extraReviewInstructions'])
  assert.match(agent, /<label for="f-cloneDir">Clone folder<\/label>/)
  assert.match(agent, /id="f-cloneDir-error" class="field-error" hidden/)
  assert.match(agent, /id="f-cloneDir-hint"/)
  // the column hint points to the Clone folder and no longer tells people to edit the config file
  assert.match(agent, /A start asks first, and runs in the Clone folder below\./)
  assert.doesNotMatch(agent, /config file|<code>cloneDir<\/code>/)
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
  for (const words of ['every review, re-review, self-review, tandem review, and stack review', 'unattended', 'Never a Dependabot review or sweep, a Fix session, or an Update session', 'narrow what the reviewer reads', '--no-post', 'a start\'s Special instructions replace them for that run', 'the report does not show them unless they ask for that', 'At most 2,000 characters']) assert.ok(hint.includes(words), words)
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
  // Sunday first, the same order as weekdayNames in src/config.ts
  assert.deepEqual(weekdayChoices.map((day) => day.value), ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])
  assert.deepEqual(weekdayChoices.map((day) => day.label), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
  assert.deepEqual(weekdayChoices.map((day) => day.value), [...weekdayNames])
  // Sunday is written first, and a saved Monday-first list holding the same days is not an unsaved change
  form.autoDays = ['sat', 'mon', 'sun']
  assert.deepEqual(toConfig(form, saved).autoReview?.activeHours.days, ['sun', 'mon', 'sat'])
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
    assert.deepEqual(problems({ autoConcurrency: bad }), [['autoConcurrency', 'Use a whole number of 1 or more.']], bad)
  }
  // the daily limit alone takes 0, which means no limit
  for (const bad of ['', '1.5', '-1', 'ten', '99999999999999999999']) {
    assert.deepEqual(problems({ autoDailyLimit: bad }), [['autoDailyLimit', 'Use a whole number of 0 or more.']], bad)
  }
  assert.deepEqual(problems({ autoDailyLimit: '0' }), [])
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
    [{ intervalMinutes: 4 }, 'autoInterval'], [{ dailyLimit: -1 }, 'autoDailyLimit'], [{ concurrency: 0 }, 'autoConcurrency'], [{ dailyLimit: 1.5 }, 'autoDailyLimit'],
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
  // the question always names the login it is given, with its at sign
  assert.equal(postingAsk('others', 'ines-hale').title, 'Let auto-review post to GitHub as @ines-hale?')
  assert.equal(postingAsk('dependabot', 'ines-hale').confirm, 'Post as @ines-hale')
})

test('the Auto-review card is grouped as the owner decided: the Now line, the master switch, Schedule, What to review, Post auto-reviews?, Limits, and a footer, in the owner\'s words', async () => {
  const html = await settingsHtml()
  const auto = cardOf(html, 'auto-review')
  assert.match(auto, /<h2 id="auto-review-heading" class="card-title">Auto-review<\/h2>/)
  assert.match(auto, /aria-labelledby="auto-review-heading"/)
  // the field ids keep their names; the clone folder is no longer here, and the days are built by the page
  assert.deepEqual(fieldsIn(auto), ['autoEnabled', 'autoDays', 'autoFrom', 'autoTo', 'autoInterval', 'autoOthers', 'autoOwn', 'autoDependabot', 'autoPostOthers', 'autoPostDependabot', 'autoConcurrency', 'autoDailyLimit'])
  assert.doesNotMatch(auto, /f-cloneDir"/)
  for (const field of ['autoEnabled', 'autoDays', 'autoFrom', 'autoTo', 'autoInterval', 'autoOthers', 'autoOwn', 'autoDependabot', 'autoConcurrency', 'autoDailyLimit', 'autoPostOthers', 'autoPostDependabot']) {
    assert.match(auto, new RegExp(`id="f-${field}-error" class="field-error" hidden`), field)
  }
  // the order of the groups
  const at = (text: string): number => auto.indexOf(text)
  const order = ['id="auto-now"', 'Review PRs automatically', '>Schedule</legend>', '>What to review</legend>', '>Post auto-reviews?</legend>', '>Limits</span>', 'class="auto-foot"']
  assert.deepEqual(order.map(at).every((position, index, all) => position > (all[index - 1] ?? -1)), true, 'the groups are in the owner\'s order')
  // the owner\'s texts, character for character
  for (const text of [
    'This setting only affects scheduler-driven auto-reviews. No effect on manually-launched reviews.',
    'Ready (non-draft) that request your review, plus pushes since your last review (automatic or manual).',
    '<span class="hint-lines">Off (default): Report in the PR\'s drawer to review and post.</span><span class="hint-lines">On: Posts to GitHub as approval, request for changes, or comment.</span>',
    'Manually launched sweeps always post and approve/request. (Default off.)',
    'Auto-reviews share the same concurrency pool as manually-launched agent reviews.',
    'Auto-review runs per day, 10 by default. Manually-launched runs don\'t count. 0 means no limit.',
    '<legend class="group-title">Post auto-reviews?</legend>',
    '<label for="f-autoConcurrency">Concurrent auto-reviews</label>',
    '<label for="f-autoDailyLimit">Daily limit</label>',
    'Other people\'s PRs</label>',
    'Scheduled Dependabot sweeps</label>',
    'Your own PRs never post, whatever these say.',
  ]) assert.ok(auto.includes(text), text)
  // the old labels and wording are gone
  for (const gone of ['Runs at once', 'Post auto-reviews of other people', 'Post scheduled Dependabot sweeps?', 'Start at login (optional)', 'Check every (minutes)', 'Active days', 'Turning it on asks first', 'Runs happen whenever Pit View is running, with or without a page open. It stays off']) {
    assert.ok(!auto.includes(gone), gone)
  }
  // Check every is a select with no number field and no hint of its own
  assert.match(auto, /<select id="f-autoInterval" class="input"><\/select>/)
  assert.doesNotMatch(auto, /id="f-autoInterval-hint"/)
  // Daily limit takes 0; Concurrent auto-reviews keeps 1
  assert.match(auto, /<input id="f-autoDailyLimit" class="input mono" type="number"[^>]*min="0" step="1"/)
  assert.match(auto, /<input id="f-autoConcurrency" class="input mono" type="number"[^>]*min="1" step="1"/)
  // four Reset to Defaults buttons, named by section; none on the master switch, and Limits\' button is hidden until it opens
  assert.deepEqual([...auto.matchAll(/id="(reset-[a-z]+)"[^>]*aria-label="(Reset to Defaults: [^"]+)"/g)].map((match) => [match[1], match[2]]), [
    ['reset-schedule', 'Reset to Defaults: Schedule'], ['reset-what', 'Reset to Defaults: What to review'], ['reset-post', 'Reset to Defaults: Post auto-reviews?'], ['reset-limits', 'Reset to Defaults: Limits'],
  ])
  assert.match(auto, /id="reset-limits"[^>]*hidden>Reset to Defaults</)
  assert.equal([...auto.matchAll(/>Reset to Defaults</g)].length, 4)
  // Limits is a closed disclosure with its summary; each posting switch has a slot for its question, notice, and inert note
  assert.match(auto, /id="limits-toggle" type="button" class="auto-disclosure" aria-expanded="false" aria-controls="limits-body"/)
  assert.match(auto, /id="limits-body" class="limits-grid" hidden/)
  for (const kind of ['others', 'dependabot']) assert.match(auto, new RegExp(`id="auto-post-ask-${kind}" class="post-ask" role="group" hidden`))
  assert.match(auto, /id="f-autoPostOthers-inert"/)
  assert.match(auto, /id="f-autoPostDependabot-notice" class="notice" role="status" hidden/)
  // the login agent is a footer sentence outside the form\'s fields
  assert.match(auto, /Start at login: <strong id="login-agent-status">/)
  assert.doesNotMatch(auto, /id="f-loginAgent/)
  // the Now line is not a live region
  assert.doesNotMatch(auto.slice(at('id="auto-now"'), at('Review PRs automatically')), /aria-live|role="status"/)
})

test('the page asks before a posting switch turns on through an in-app confirmation, never a browser dialog, and keeps the switch off until it is confirmed', async () => {
  const source = await readFile(new URL('../public/settings.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\b(?:window\.)?(?:confirm|alert|prompt)\(/)
  // the change handler decides with the pure rule, puts the switch back off, and opens the question
  assert.match(source, /if \(wantsPostConfirm\(page\.form, kind, box\.checked\)\) \{\s*box\.checked = false/)
  assert.match(source, /page\.postAsk = kind\s*page\.postAskLogin = postingLogin\(\)\s*showPostAsk\(true\)/)
  // only the confirm button sets the form value to on
  assert.equal([...source.matchAll(/page\.form\[key\] = true/g)].length, 1)
})

test('a posting switch can be confirmed only with an explicit viewer, and the question names exactly the typed viewer', () => {
  assert.equal(postingNeedsViewer(''), true)
  assert.equal(postingNeedsViewer('   '), true)
  assert.equal(postingNeedsViewer('ines-hale'), false)
  assert.equal(postingNeedsViewer(' ines-hale '), false)
  assert.equal(postingLoginOf(''), '')
  assert.equal(postingLoginOf('  '), '')
  assert.equal(postingLoginOf(' ines-hale '), 'ines-hale')
  assert.equal(postViewerNeededText, 'Enter a viewer first: the confirmation has to name the account that will post, and an empty viewer does not name one.')
  // the question was drawn for ines-hale and the viewer field now says rafe-moss, or is cleared: stale
  assert.equal(postAskIsStale('ines-hale', 'rafe-moss'), true)
  assert.equal(postAskIsStale('ines-hale', ''), true)
  assert.equal(postAskIsStale('ines-hale', '   '), true)
  // typing the same login again, with stray spaces, is not stale
  assert.equal(postAskIsStale('ines-hale', ' ines-hale '), false)
  // a confirmation drawn for ines-hale names @ines-hale, never another login
  assert.equal(postingAsk('others', postingLoginOf(' ines-hale ')).confirm, 'Post as @ines-hale')
})

test('the page opens no posting question while the viewer field is empty, keeps the switch off with an inline notice, and the question closes when the viewer changes or is cleared', async () => {
  const source = await readFile(new URL('../public/settings.ts', import.meta.url), 'utf8')
  assert.match(source, /const closeStalePostAsk = /)
  const bound = source.slice(source.indexOf('// turning a posting switch on asks first'), source.indexOf('const refresh = byId'))
  // the empty-viewer check comes before the question opens, puts the switch back off, shows the notice, and does not focus
  const empty = bound.slice(bound.indexOf('wantsPostConfirm('), bound.indexOf('page.postAsk = kind'))
  assert.match(empty, /postingNeedsViewer\(page\.form\.viewer\)/)
  assert.match(empty, /box\.checked = false/)
  assert.match(empty, /postViewerNeededText/)
  assert.match(empty, /return/)
  assert.doesNotMatch(empty, /\.focus\(/, 'the notice does not steal focus')
  const viewerHandler = source.slice(source.indexOf("input.addEventListener('input'"), source.indexOf('const refresh = byId'))
  assert.match(viewerHandler, /closeStalePostAsk\(\)/)
  const stale = source.slice(source.indexOf('const closeStalePostAsk'), source.indexOf('const postNoticeText'))
  assert.match(stale, /postAskIsStale\(page\.postAskLogin, page\.form\.viewer\)/)
  assert.match(stale, /page\.postAsk = null/)
  assert.doesNotMatch(stale, /\.focus\(/, 'closing does not steal focus from the field being typed in')
  assert.match(source, /page\.postAskLogin = postingLogin\(\)/)
})

test('the page never claims to know the gh login: no lookup route, no gh login state, no name in the viewer field\'s placeholder or hint', async () => {
  const dir = new URL('../', import.meta.url)
  for (const file of ['public/settings.ts', 'public/settings-form.ts', 'public/settings.html', 'public/app.ts', 'src/server.ts']) {
    assert.doesNotMatch(await readFile(new URL(file, dir), 'utf8'), /\/api\/gh-login/, file)
  }
  for (const file of ['public/settings.ts', 'public/settings-form.ts']) {
    assert.doesNotMatch(await readFile(new URL(file, dir), 'utf8'), /ghLogin/, file)
  }
  const source = await readFile(new URL('public/settings.ts', dir), 'utf8')
  assert.doesNotMatch(source, /viewer\.login/, 'the view\'s viewer is not presented as the gh login')
  assert.doesNotMatch(source, /\(the gh login\)/)
  assert.doesNotMatch(source, /f-viewer-hint/, 'the hint is static text in the page')
  assert.doesNotMatch(source, /viewer\.placeholder/, 'the viewer field\'s placeholder is static text in the page')
  const html = await settingsHtml()
  assert.match(html, /id="f-viewer"[^>]*placeholder="the account gh is signed in as"/)
  assert.match(html, /<p id="f-viewer-hint" class="hint">Leave it empty to use the account gh is signed in as\. Uses gh's own token; nothing else to sign in to\.<\/p>/)
})

test('a posting switch confirmed for one login turns back off when the login the form would post as changes before Save, and stays off', () => {
  const on = { autoPostOthers: true, autoPostDependabot: true }
  // two switches confirmed for different logins: only the one whose login no longer matches turns off
  assert.deepEqual(postSwitchesToTurnOff({ others: 'vera-quill', dependabot: 'ines-hale' }, on, 'ines-hale'), ['others'])
  assert.deepEqual(postSwitchesToTurnOff({ others: 'vera-quill', dependabot: 'ines-hale' }, on, 'rafe-moss'), ['others', 'dependabot'])
  assert.deepEqual(postSwitchesToTurnOff({ others: 'vera-quill', dependabot: 'vera-quill' }, on, 'vera-quill'), [])
  // a switch already saved on has no record, so a login change leaves it alone
  assert.deepEqual(postSwitchesToTurnOff({ dependabot: 'vera-quill' }, on, 'ines-hale'), ['dependabot'])
  assert.deepEqual(postSwitchesToTurnOff({}, on, 'ines-hale'), [])
  // a record whose switch is not on in the form turns nothing off
  assert.deepEqual(postSwitchesToTurnOff({ others: 'vera-quill' }, { autoPostOthers: false, autoPostDependabot: false }, 'ines-hale'), [])
  // the login changes and changes back: the caller clears the record when it turns the switch off, so the next decision finds nothing and the switch stays off
  const records: { others?: string } = { others: 'vera-quill' }
  assert.deepEqual(postSwitchesToTurnOff(records, on, 'ines-hale'), ['others'])
  delete records.others
  assert.deepEqual(postSwitchesToTurnOff(records, on, 'vera-quill'), [])
  // confirmed for ines-hale, then the field is cleared: the switch turns off, and the record is gone so it stays off
  const cleared: { others?: string } = { others: 'ines-hale' }
  assert.deepEqual(postSwitchesToTurnOff(cleared, on, postingLoginOf('')), ['others'])
  assert.deepEqual(postSwitchesToTurnOff({ others: 'ines-hale' }, on, postingLoginOf('  ')), ['others'])
  delete cleared.others
  assert.deepEqual(postSwitchesToTurnOff(cleared, on, postingLoginOf('ines-hale')), [])
  // confirmed for A, changed to B turns off, and changed back to A stays off
  const moved: { others?: string } = { others: 'ines-hale' }
  assert.deepEqual(postSwitchesToTurnOff(moved, on, postingLoginOf('rafe-moss')), ['others'])
  delete moved.others
  assert.deepEqual(postSwitchesToTurnOff(moved, on, postingLoginOf('ines-hale')), [])
  // typing the confirmed login with stray spaces leaves it on
  assert.deepEqual(postSwitchesToTurnOff({ others: 'ines-hale' }, on, postingLoginOf(' ines-hale ')), [])
})

test('a late loadExtras never touches an open confirmation or moves focus, and showPostAsk focuses the confirm button only when the user opens the question', async () => {
  const source = await readFile(new URL('../public/settings.ts', import.meta.url), 'utf8')
  const extras = source.slice(source.indexOf('const loadExtras'), source.indexOf('const load = '))
  assert.doesNotMatch(extras, /showPostAsk\(|closeStalePostAsk\(|turnOffUnconfirmed\(|postAsk|\.focus\(/)
  const show = source.slice(source.indexOf('const showPostAsk'), source.indexOf('const bindStatic'))
  assert.match(show, /const showPostAsk = \(opened = false\): void =>/)
  assert.match(show, /if \(opened\) confirm\.focus\(\)/)
  assert.doesNotMatch(show, /document\.activeElement/)
  assert.equal([...show.matchAll(/\.focus\(\)/g)].length, 2, 'the confirm button and the switch after closing')
  // only the change handler that opens the question asks for focus
  assert.deepEqual([...source.matchAll(/showPostAsk\(true\)/g)].length, 1)
  const bound = source.slice(source.indexOf('// turning a posting switch on asks first'), source.indexOf('const refresh = byId'))
  assert.match(bound, /page\.postAskLogin = postingLogin\(\)\s*showPostAsk\(true\)/)
})

test('the page records the login each posting switch was confirmed for, turns the switch off with a notice when the login changes, and clears the record on cancel, on switching off, on save, and on reload', async () => {
  const source = await readFile(new URL('../public/settings.ts', import.meta.url), 'utf8')
  // the confirm click records the login it named
  const confirm = source.slice(source.indexOf("confirm.addEventListener('click'"), source.indexOf("cancel.addEventListener('click'"))
  assert.match(confirm, /page\.postConfirmed\[kind\] = page\.postAskLogin/)
  // one function applies the pure decision, for both paths that change the login
  const turnOff = source.slice(source.indexOf('const postNoticeText'), source.indexOf('// the open confirmation under its switch'))
  assert.match(turnOff, /postSwitchesToTurnOff\(/)
  assert.match(turnOff, /page\.form\[key\] = false/)
  assert.match(turnOff, /\.checked = false/)
  assert.match(turnOff, /delete page\.postConfirmed\[/)
  assert.match(turnOff, /changed\(\)/)
  assert.match(turnOff, /Turned off because the login changed\. Turn it on again to be asked again\./)
  assert.doesNotMatch(turnOff, /\.focus\(/, 'the notice does not steal focus from the viewer field')
  const viewerHandler = source.slice(source.indexOf("input.addEventListener('input'"), source.indexOf("const refresh = byId"))
  assert.match(viewerHandler, /turnOffUnconfirmed\(\)/)
  // cancel and turning a switch off clear the record
  const cancel = source.slice(source.indexOf("cancel.addEventListener('click'"), source.indexOf("slot.setAttribute('aria-labelledby'"))
  assert.match(cancel, /delete page\.postConfirmed\[kind\]/)
  const bound = source.slice(source.indexOf('// turning a posting switch on asks first'), source.indexOf('const refresh = byId'))
  assert.match(bound, /delete page\.postConfirmed\[kind\]/)
  // save and revert and a new page start with no records
  const saved = source.slice(source.indexOf('current.saved = body as Config'), source.indexOf('renderAll()', source.indexOf('current.saved = body as Config')))
  assert.match(saved, /current\.postConfirmed = \{\}/)
  const revert = source.slice(source.indexOf('const revert'), source.indexOf('// the view (for sample keys'))
  assert.match(revert, /page\.postConfirmed = \{\}/)
  assert.match(source, /postAsk: null,\s*postAskLogin: '',\s*postConfirmed: \{\}/)
})

// Auto-review card, revision 1: the dropdown, the cap rule, Reset to Defaults, and the words the card derives from the form

const autoSaved = (patch: Partial<Config['autoReview'] & object> = {}): Config => ({ ...sample(), autoReview: { ...defaultAutoReview(), ...patch } })

test('Check every offers exactly 5 minutes, 15 minutes (default), 30 minutes, and 1 hour, and a saved value outside them is offered once more, marked, in number order', () => {
  assert.deepEqual(intervalChoices, [
    { value: 5, label: '5 minutes' }, { value: 15, label: '15 minutes (default)' }, { value: 30, label: '30 minutes' }, { value: 60, label: '1 hour' },
  ])
  assert.deepEqual(intervalOptions('15'), intervalChoices)
  assert.deepEqual(intervalOptions('60'), intervalChoices)
  assert.deepEqual(intervalOptions('10'), [
    { value: 5, label: '5 minutes' }, { value: 10, label: '10 minutes (saved, not a listed choice)' }, { value: 15, label: '15 minutes (default)' }, { value: 30, label: '30 minutes' }, { value: 60, label: '1 hour' },
  ])
  assert.deepEqual(intervalOptions('120').map((choice) => choice.label), ['5 minutes', '15 minutes (default)', '30 minutes', '1 hour', '120 minutes (saved, not a listed choice)'])
  // a default of 15 matches the shipped default
  assert.equal(intervalChoices.find((choice) => choice.label.endsWith('(default)'))?.value, autoDefaults.intervalMinutes)
  // the note shows while the chosen value is not one of the four
  assert.equal(intervalLegacyNote('10'), 'Saved as 10 minutes, which is not one of the choices. It keeps working as saved; pick a choice to change it.')
  assert.equal(intervalLegacyNote('15'), null)
  assert.equal(intervalLegacyNote('60'), null)
})

test('a saved check interval outside the four is shown as saved, is not an unsaved change, is not an error, and is written back unchanged', () => {
  const saved = autoSaved({ intervalMinutes: 10 })
  const form = formOf(saved)
  assert.equal(form.autoInterval, '10')
  assert.equal(isDirty(form, saved), false)
  assert.deepEqual(validateForm(form), [])
  assert.equal(toConfig(form, saved).autoReview?.intervalMinutes, 10)
  assert.equal(validateConfig(toConfig(form, saved)).autoReview?.intervalMinutes, 10)
})

test('the cap rule: Concurrent auto-reviews must be no more than Concurrent reviews, named with the Agent value as typed, and only once both are whole numbers of 1 or more', () => {
  const form = formOf(autoSaved())
  form.maxConcurrentReviews = '2'
  form.autoConcurrency = '3'
  assert.deepEqual(autoCapError(form), { field: 'autoConcurrency', message: 'Must be no more than Concurrent reviews in Agent, which is now 2.' })
  form.autoConcurrency = '2'
  assert.equal(autoCapError(form), null)
  form.autoConcurrency = '1'
  assert.equal(autoCapError(form), null)
  // either number moving brings the error back, with the Agent value as it is now typed
  form.autoConcurrency = '3'
  form.maxConcurrentReviews = ' 4 '
  assert.equal(autoCapError(form), null)
  form.maxConcurrentReviews = '1'
  assert.deepEqual(autoCapError(form), { field: 'autoConcurrency', message: 'Must be no more than Concurrent reviews in Agent, which is now 1.' })
  // the existing whole-number checks come first: nothing here while either is not a whole number of 1 or more
  for (const [auto, agent] of [['', '2'], ['0', '2'], ['x', '2'], ['3', ''], ['3', '0'], ['3', '1.5'], ['2.5', '2']] as const) {
    form.autoConcurrency = auto
    form.maxConcurrentReviews = agent
    assert.equal(autoCapError(form), null, `${auto} against ${agent}`)
  }
  // Save is refused with the usual field-named error
  form.autoConcurrency = '3'
  form.maxConcurrentReviews = '2'
  assert.deepEqual(validateForm(form).map((error) => [error.field, error.message]), [['autoConcurrency', 'Must be no more than Concurrent reviews in Agent, which is now 2.']])
  // a saved value above the cap loads with the error, is not an unsaved change, and is never lowered
  const legacy: Config = { ...autoSaved({ concurrency: 3 }), maxConcurrentReviews: 2 }
  const loaded = formOf(legacy)
  assert.equal(loaded.autoConcurrency, '3')
  assert.equal(autoCapError(loaded)?.field, 'autoConcurrency')
  assert.equal(isDirty(loaded, legacy), false)
  assert.equal(toConfig(loaded, legacy).autoReview?.concurrency, 3)
  // the server's refusal of the same rule lands on the same field, with its own words
  assert.deepEqual(serverError('autoReview.concurrency must be no more than maxConcurrentReviews (2)', loaded), { field: 'autoConcurrency', message: 'Must be no more than maxConcurrentReviews (2).' })
  // every other cap keeps 1 or more
  form.maxConcurrentReviews = '0'
  assert.deepEqual(validateForm(form).map((error) => error.field), ['maxConcurrentReviews'])
})

test('the clone folder check lives in the general part of the form checks, keeps its words, and comes after Concurrent reviews', () => {
  const form = formOf(autoSaved())
  form.cloneDir = 'dev/orbit'
  form.maxConcurrentReviews = '0'
  assert.deepEqual(validateForm(form).map((error) => [error.field, error.message]), [
    ['maxConcurrentReviews', 'Use a whole number of 1 or more.'],
    ['cloneDir', 'Give an absolute path or a path under ~, such as ~/dev/orbit.'],
  ])
  for (const ok of ['', '~', '~/dev/orbit', '/srv/orbit']) assert.deepEqual(validateForm({ ...formOf(autoSaved()), cloneDir: ok }), [], ok)
  assert.equal(serverError(refusal({ ...sample(), cloneDir: 'dev/orbit' }), form).field, 'cloneDir')
})

test('a daily limit of 0 is valid on the page, saves as 0, and Reset to Defaults in Limits sets 10', () => {
  const saved = autoSaved({ dailyLimit: 0 })
  const form = formOf(saved)
  assert.equal(form.autoDailyLimit, '0')
  assert.deepEqual(validateForm(form), [])
  assert.equal(isDirty(form, saved), false)
  assert.equal(toConfig(form, saved).autoReview?.dailyLimit, 0)
  assert.equal(validateConfig(toConfig(form, saved)).autoReview?.dailyLimit, 0)
  assert.equal(resetSection(form, 'limits').autoDailyLimit, '10')
  // the server's refusal at a negative value reads 0 or more and lands on the field
  assert.deepEqual(serverError('autoReview.dailyLimit must be a whole number of 0 or more', form), { field: 'autoDailyLimit', message: 'Must be a whole number of 0 or more.' })
})

test('Reset to Defaults sets only its own section\'s fields to the defaults and leaves every other field as it was', () => {
  const away = formOf(autoSaved({
    enabled: true, intervalMinutes: 30, activeHours: { days: ['sat', 'sun'], from: '07:30', to: '20:00' }, others: false, own: true, dependabot: true,
    concurrency: 2, dailyLimit: 25, post: { others: true, dependabot: true },
  }))
  away.viewer = 'vera-quill'
  const keys = ['autoEnabled', 'autoInterval', 'autoDays', 'autoFrom', 'autoTo', 'autoOthers', 'autoOwn', 'autoDependabot', 'autoConcurrency', 'autoDailyLimit', 'autoPostOthers', 'autoPostDependabot'] as const
  const sections = {
    schedule: ['autoInterval', 'autoDays', 'autoFrom', 'autoTo'],
    what: ['autoOthers', 'autoOwn', 'autoDependabot'],
    post: ['autoPostOthers', 'autoPostDependabot'],
    limits: ['autoConcurrency', 'autoDailyLimit'],
  } as const
  const defaults = formOf({ ...sample(), autoReview: undefined })
  for (const [name, own] of Object.entries(sections) as [keyof typeof sections, readonly (typeof keys[number])[]][]) {
    const before = structuredClone(away)
    const after = resetSection(away, name)
    assert.deepEqual(away, before, 'the input form is not changed')
    for (const key of keys) {
      assert.deepEqual(after[key], own.includes(key) ? defaults[key] : away[key], `${name}: ${key}`)
    }
    assert.equal(after.viewer, 'vera-quill')
    assert.equal(atSectionDefaults(after, name), true)
    assert.equal(atSectionDefaults(away, name), false)
  }
  // the master switch is in no section, and the clone folder is not an auto-review field
  const reset = (['schedule', 'what', 'post', 'limits'] as const).reduce((form, name) => resetSection(form, name), away)
  assert.equal(reset.autoEnabled, true)
  assert.equal(reset.cloneDir, away.cloneDir)
  // a form at the defaults is at every section's defaults, whatever the days' order
  assert.equal((['schedule', 'what', 'post', 'limits'] as const).every((name) => atSectionDefaults(defaults, name)), true)
  assert.equal(atSectionDefaults({ ...defaults, autoDays: ['fri', 'mon', 'tue', 'wed', 'thu'] }, 'schedule'), true)
  assert.equal(atSectionDefaults({ ...defaults, autoInterval: ' 15 ' }, 'schedule'), true)
})

test('Reset to Defaults in Post auto-reviews? can only turn posting off, never on', () => {
  const on = formOf(autoSaved({ post: { others: true, dependabot: true } }))
  assert.deepEqual([resetSection(on, 'post').autoPostOthers, resetSection(on, 'post').autoPostDependabot], [false, false])
  const off = formOf(autoSaved())
  assert.deepEqual([resetSection(off, 'post').autoPostOthers, resetSection(off, 'post').autoPostDependabot], [false, false])
  // the shipped defaults have posting off, so no reset of any section can switch it on
  assert.deepEqual(autoDefaults.post, { others: false, dependabot: false })
  for (const name of ['schedule', 'what', 'post', 'limits'] as const) {
    const after = resetSection(off, name)
    assert.deepEqual([after.autoPostOthers, after.autoPostDependabot], [false, false], name)
  }
})

test('the schedule summary names the interval, the days Sunday first, the hours, and the time zone, and asks for a fix while the schedule is invalid', () => {
  const form = formOf(autoSaved())
  const zone = 'Europe/Example'
  assert.equal(scheduleSummary(form, zone), 'Checks every 15 minutes, Monday to Friday, from 09:00 until 18:00, in this computer\'s time zone (Europe/Example). The last check starts before 18:00.')
  assert.equal(scheduleSummary({ ...form, autoInterval: '60' }, zone), 'Checks every hour, Monday to Friday, from 09:00 until 18:00, in this computer\'s time zone (Europe/Example). The last check starts before 18:00.')
  assert.match(scheduleSummary({ ...form, autoDays: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] }, zone), /^Checks every 15 minutes, every day, from/)
  assert.match(scheduleSummary({ ...form, autoDays: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri'] }, zone), /^Checks every 15 minutes, Sunday to Friday, from/)
  assert.match(scheduleSummary({ ...form, autoDays: ['sat', 'sun'] }, zone), /^Checks every 15 minutes, Sunday and Saturday, from/)
  assert.match(scheduleSummary({ ...form, autoDays: ['mon', 'wed', 'fri'] }, zone), /^Checks every 15 minutes, Monday, Wednesday, and Friday, from/)
  assert.match(scheduleSummary({ ...form, autoDays: ['mon', 'tue', 'sat'] }, zone), /^Checks every 15 minutes, Monday, Tuesday, and Saturday, from/)
  assert.match(scheduleSummary({ ...form, autoInterval: '10' }, zone), /^Checks every 10 minutes,/)
  for (const bad of [{ autoDays: [] }, { autoFrom: '9:00' }, { autoTo: '08:00' }, { autoInterval: '3' }, { autoInterval: '' }]) {
    assert.equal(scheduleSummary({ ...form, ...bad }, zone), 'Fix the schedule above to see when checks run.', JSON.stringify(bad))
  }
})

test('the Limits summary reads the typed numbers, and reads no daily limit at 0', () => {
  const form = formOf(autoSaved())
  assert.equal(limitsSummary(form), '1 concurrent auto-review · 10 runs a day')
  assert.equal(limitsSummary({ ...form, autoConcurrency: '2', autoDailyLimit: '1' }), '2 concurrent auto-reviews · 1 run a day')
  assert.equal(limitsSummary({ ...form, autoDailyLimit: '0' }), '1 concurrent auto-review · no daily limit')
  assert.equal(limitsSummary({ ...form, autoConcurrency: '3', autoDailyLimit: '0' }), '3 concurrent auto-reviews · no daily limit')
  assert.equal(limitsSummary({ ...form, autoConcurrency: '', autoDailyLimit: 'x' }), '? concurrent auto-reviews · ? runs a day')
  // the disclosure opens for an error on either of its two fields and no other
  assert.deepEqual(['autoConcurrency', 'autoDailyLimit', 'autoInterval', 'cloneDir'].map(opensLimits), [true, true, false, false])
})

test('the Posts as line follows the viewer field as typed, the empty viewer reads as empty, and an on switch for an unticked kind is called inert', () => {
  assert.deepEqual(postingAsLine('vera-quill'), { before: 'Posts as ', login: '@vera-quill', after: ', the Viewing as login above. ', link: 'Change' })
  assert.deepEqual(postingAsLine('  vera-quill '), postingAsLine('vera-quill'))
  assert.deepEqual(postingAsLine(''), { before: 'Posts as the Viewing as login, which is empty. ', login: '', after: '', link: 'Set Viewing as' })
  assert.deepEqual(postingAsLine('   '), postingAsLine(''))
  const form = formOf(autoSaved({ others: false, dependabot: false, post: { others: true, dependabot: true } }))
  assert.deepEqual(inertPostKinds(form), ['others', 'dependabot'])
  assert.deepEqual(inertPostKinds({ ...form, autoOthers: true }), ['dependabot'])
  assert.deepEqual(inertPostKinds({ ...form, autoOthers: true, autoDependabot: true }), [])
  assert.deepEqual(inertPostKinds({ ...form, autoPostOthers: false, autoPostDependabot: false }), [])
  assert.equal(inertPostNote('others'), 'Other people\'s PRs is not ticked under What to review, so nothing posts until it is.')
  assert.equal(inertPostNote('dependabot'), 'Dependabot PRs is not ticked under What to review, so no scheduled sweep runs to post.')
})

test('the instructions reference line names the extra review instructions, or says none are set, and the sweep never uses them', () => {
  assert.equal(instructionsLine(''), 'Reviews of people\'s PRs use your extra review instructions: none set. The Dependabot sweep never does. ')
  assert.equal(instructionsLine('  \n '), instructionsLine(''))
  assert.equal(instructionsLine('Skip generated files.'), 'Reviews of people\'s PRs use your extra review instructions: \u201cSkip generated files.\u201d. The Dependabot sweep never does. ')
  assert.match(instructionsLine('x'.repeat(80)), new RegExp(`\u201c${'x'.repeat(60)}\u2026\u201d`))
})

// the Now line reads the saved settings and the scheduler's view

const nowView = (patch: Partial<AutoReviewView> = {}): AutoReviewView => ({
  enabled: true, state: 'idle', nextTickAt: '2026-10-30T14:45:00Z', running: 0, queued: 0, startedToday: 3,
  lastTick: null, posting: { others: false, dependabot: false }, sweepHold: null, worktrees: { kept: [], unlisted: [] }, ...patch,
})
const nowReading = { nowMs: Date.parse('2026-10-30T14:31:00Z'), timeZone: 'UTC' }

test('the Now line reads the saved settings and the scheduler\'s view in the header indicator\'s words, with runs today, the posting summary, and the time', () => {
  setTimeFormat('12h')
  const saved = defaultAutoReview()
  const line = (patch: Partial<AutoReviewView>, auto = { ...saved, enabled: true }, viewer = 'vera-quill') => nowLine({ saved: auto, view: nowView(patch), viewer, reading: nowReading })
  assert.deepEqual(line({}), { tone: 'normal', text: 'On \u00b7 next 2:45 PM', meta: '3 of 10 runs started today \u00b7 posting off \u00b7 as of 2:31 PM', fix: null })
  assert.equal(line({ state: 'running', running: 1 }).text, 'On \u00b7 1 running \u00b7 next 2:45 PM')
  assert.equal(line({ state: 'running', running: 0, queued: 0, nextTickAt: null }).text, 'On \u00b7 checking PRs')
  assert.equal(line({ state: 'outsideHours', nextTickAt: '2026-11-02T09:00:00Z' }).text, 'Outside hours \u00b7 next Mon 9:00 AM')
  assert.deepEqual(nowLine({ saved: { ...saved, enabled: false }, view: nowView({ enabled: false, state: 'off', nextTickAt: null }), viewer: 'vera-quill', reading: nowReading }), {
    tone: 'normal', text: 'Off', meta: 'Nothing runs and the scheduler makes no GitHub calls.', fix: null,
  })
  // posting is named from the saved switches, as the saved viewer, or as the account gh is signed in as when there is none
  const posting = { ...saved, enabled: true, post: { others: true, dependabot: true } }
  assert.equal(line({}, posting).meta, '3 of 10 runs started today \u00b7 posts other people\'s PRs and Dependabot sweeps as @vera-quill \u00b7 as of 2:31 PM')
  assert.equal(line({}, { ...posting, post: { others: true, dependabot: false } }, '').meta, '3 of 10 runs started today \u00b7 posts other people\'s PRs as the account gh is signed in as \u00b7 as of 2:31 PM')
  // a skip is amber and names what to fix
  const skipped = (skipReason: 'identityMismatch' | 'noClone' | 'dailyLimit') => line({ state: 'blocked', lastTick: { at: '2026-10-30T14:30:00Z', state: 'skipped', skipReason, queued: null } })
  assert.deepEqual(skipped('identityMismatch'), { tone: 'warn', text: 'Skipped: gh login differs from viewer', meta: '3 of 10 runs started today \u00b7 posting off \u00b7 as of 2:31 PM', fix: 'Every check skips until gh is signed in as @vera-quill.' })
  assert.equal(skipped('noClone').text, 'Skipped: no usable clone folder')
  assert.equal(skipped('noClone').fix, 'Set the Clone folder in Agent.')
  assert.equal(skipped('dailyLimit').text, 'Skipped: daily limit reached')
  assert.equal(skipped('dailyLimit').fix, 'Runs started today have reached the daily limit; it starts over tomorrow.')
  // no autoReview key, and a view that cannot be read
  assert.deepEqual(nowLine({ saved: undefined, view: null, viewer: '', reading: nowReading }), { tone: 'normal', text: 'Not set up', meta: nowNotSetUp, fix: null })
  assert.equal(nowNotSetUp, 'These are the defaults; nothing is saved until you change one and save.')
  assert.deepEqual(nowLine({ saved: { ...saved, enabled: true }, view: null, viewer: '', reading: nowReading }), { tone: 'normal', text: 'Status unavailable', meta: '', fix: null })
  assert.equal(nowUnsavedNote, 'This line reads the saved settings. Your changes apply once you save.')
})

test('at a daily limit of 0 the Now line says no daily limit instead of N of 10, and never a daily-limit skip fix', () => {
  setTimeFormat('12h')
  const saved = { ...defaultAutoReview(), enabled: true, dailyLimit: 0 }
  const line = nowLine({ saved, view: nowView({ startedToday: 3 }), viewer: 'vera-quill', reading: nowReading })
  assert.equal(line.meta, '3 runs started today \u00b7 no daily limit \u00b7 posting off \u00b7 as of 2:31 PM')
  assert.equal(nowLine({ saved, view: nowView({ startedToday: 1 }), viewer: 'vera-quill', reading: nowReading }).meta, '1 run started today \u00b7 no daily limit \u00b7 posting off \u00b7 as of 2:31 PM')
  assert.doesNotMatch(line.meta, /\bof 0\b/)
  assert.equal(nowLine({ saved: { ...saved, enabled: false }, view: nowView({ state: 'off' }), viewer: '', reading: nowReading }).text, 'Off')
})

test('the Now line follows the time format like every clock time', () => {
  setTimeFormat('24h')
  try {
    const line = nowLine({ saved: { ...defaultAutoReview(), enabled: true }, view: nowView({ nextTickAt: '2026-10-30T14:45:00Z' }), viewer: 'v', reading: nowReading })
    assert.equal(line.text, 'On \u00b7 next 14:45')
    assert.match(line.meta, /as of 14:31$/)
  } finally {
    setTimeFormat('12h')
  }
})
