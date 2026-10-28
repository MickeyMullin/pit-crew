// test/ui-settings.test.ts
// the Settings page's pure logic (public/settings-form.ts), run under Node: config to form and
// back, the checks before saving, the server's refusals placed on fields, people suggestions and
// colors, and ticket samples checked against the dashboard's own derivation
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConfigError, defaultConfig, idleRange, validateConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { deriveOpenRows, groupRows, personView } from '../src/derive.ts'
import { cycleKeys } from '../src/poller.ts'
import type { View } from '../src/poller.ts'
import {
  aliasOf, changeKind, colorFor, contrastWithWhite, errorId, fieldId, initialsOf, isDirty, kindDefaults, needsRefresh, newPerson, newTicket,
  idleLimits, openSuggestions, parseBots, parseIdleMinutes, previewPerson, refreshChoices, refreshKeys, sampleTextsFrom, serverError, ticketSample, toConfig, toForm,
  validateForm,
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
  showAgentColumn: true,
  // not on the page yet (P2.5 or later), so a save must carry them over
  cloneDir: '~/dev/orbit',
  agent: { runner: 'codex', codexModel: 'gpt-6.1-terra' },
  notifications: { enabled: false, kinds: ['mineReady'] },
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
  assert.equal(needsRefresh(before, { ...before, density: 'comfortable', refreshSeconds: 300, showAgentColumn: false }), false)
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
