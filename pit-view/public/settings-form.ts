// public/settings-form.ts
// the Settings page's pure logic: config to form and back, the checks made before saving, the
// server's refusals placed on their fields, people suggestions, and ticket samples
import type { AutoReviewSettings, Config, Person, TicketSystem, WeekdayName } from '../src/config.ts'
import type { NotificationKind } from '../src/notify.ts'
import type { View } from '../src/poller.ts'

// the page posts here after a save, so an open dashboard rereads density and the agent column
export const configChannel = 'pit-view.config'

// where the default instance keeps the config, shown until /api/instance names the real file
export const configPathText = '~/.config/pit-view/config.json'

export type AvatarMode = 'initials' | 'github' | 'image'

// each row carries an id of its own, so a row keeps its elements while others come and go
export type PersonForm = {
  id: string
  login: string
  alias: string
  initials: string
  color: string
  avatarMode: AvatarMode
  // the image path under ~, used when avatarMode is image
  avatarPath: string
}

export type TicketForm = TicketSystem & { id: string }

export type Form = {
  repo: string
  viewer: string
  people: PersonForm[]
  tickets: TicketForm[]
  refreshSeconds: Config['refreshSeconds']
  // minutes as typed; 0 means never idle
  idleMinutes: string
  todayStartsAt: Config['todayStartsAt']
  // login substrings as typed: commas or new lines between them
  bots: string
  reportsDir: string
  density: Config['density']
  timeFormat: Config['timeFormat']
  showAgentColumn: boolean
  // the cap as typed: a whole number of 1 or more
  maxConcurrentReviews: string
  selfReviewOverCap: boolean
  extraReviewInstructions: string
  notifyEnabled: boolean
  notifyKinds: NotificationKind[]
  // the clone folder as typed: an absolute path or one under ~, empty for none
  cloneDir: string
  // auto-review (section 10): the numbers as typed, the days in week order, the times as HH:MM
  autoEnabled: boolean
  autoInterval: string
  autoDays: WeekdayName[]
  autoFrom: string
  autoTo: string
  autoOthers: boolean
  autoOwn: boolean
  autoDependabot: boolean
  autoConcurrency: string
  autoDailyLimit: string
  autoPostOthers: boolean
  autoPostDependabot: boolean
}

// the autoReview defaults, a copy of defaultAutoReview in src/autoreview.ts, which a test keeps in step (the page cannot import that module's code)
export const autoDefaults: AutoReviewSettings = {
  enabled: false,
  intervalMinutes: 15,
  activeHours: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '18:00' },
  others: true,
  own: false,
  dependabot: false,
  concurrency: 1,
  dailyLimit: 10,
  post: { others: false, dependabot: false },
}

// the days as the page lists and saves them, Monday first
export const weekdayChoices: readonly { value: WeekdayName, label: string }[] = [
  { value: 'mon', label: 'Mon' }, { value: 'tue', label: 'Tue' }, { value: 'wed', label: 'Wed' }, { value: 'thu', label: 'Thu' },
  { value: 'fri', label: 'Fri' }, { value: 'sat', label: 'Sat' }, { value: 'sun', label: 'Sun' },
]

const inWeekOrder = (days: readonly WeekdayName[]): WeekdayName[] => weekdayChoices.map((day) => day.value).filter((day) => days.includes(day))

// the notification kinds in the order the page lists them; the same names as notificationKinds in src/notify.ts, which a test keeps in step (the page cannot import that module's code)
export const notifyChoices: readonly { kind: NotificationKind, label: string, hint: string }[] = [
  { kind: 'changesRequested', label: 'Changes requested on your PR', hint: 'A PR of yours moves to Changes requested.' },
  { kind: 'readyToMerge', label: 'Your PR is ready to merge', hint: 'A PR of yours reaches the Ready to merge state.' },
  { kind: 'reviewRequested', label: 'Review requested of you', hint: 'Someone else\'s PR newly asks for your review.' },
  { kind: 'ciFailing', label: 'CI failing on your PR', hint: 'A PR of yours starts failing checks.' },
  { kind: 'runFinished', label: 'Review session finished', hint: 'A review session started from the Agent column finishes or fails.' },
  { kind: 'runNeedsInput', label: 'Review session waiting for input', hint: 'A review session stops with a question for you.' },
]

// turning notifications on starts with every kind selected
const allKinds: NotificationKind[] = notifyChoices.map((choice) => choice.kind)

export type MakeId = () => string

export const toForm = (config: Config, makeId: MakeId): Form => ({
  repo: config.repo,
  viewer: config.viewer,
  people: config.people.map((person) => personForm(person, makeId())),
  tickets: config.tickets.map((system) => ({ ...system, id: makeId() })),
  refreshSeconds: config.refreshSeconds,
  idleMinutes: String(config.idleMinutes),
  todayStartsAt: config.todayStartsAt,
  bots: config.bots.join(', '),
  reportsDir: config.reportsDir,
  density: config.density,
  timeFormat: config.timeFormat,
  showAgentColumn: config.showAgentColumn,
  maxConcurrentReviews: String(config.maxConcurrentReviews),
  selfReviewOverCap: config.selfReviewOverCap,
  extraReviewInstructions: config.extraReviewInstructions,
  notifyEnabled: config.notifications?.enabled ?? false,
  notifyKinds: config.notifications?.kinds ?? allKinds,
  cloneDir: config.cloneDir ?? '',
  ...autoForm(config.autoReview ?? autoDefaults),
})

const autoForm = (auto: AutoReviewSettings): Pick<Form, 'autoEnabled' | 'autoInterval' | 'autoDays' | 'autoFrom' | 'autoTo' | 'autoOthers' | 'autoOwn' | 'autoDependabot' | 'autoConcurrency' | 'autoDailyLimit' | 'autoPostOthers' | 'autoPostDependabot'> => ({
  autoEnabled: auto.enabled,
  autoInterval: String(auto.intervalMinutes),
  autoDays: inWeekOrder(auto.activeHours.days),
  autoFrom: auto.activeHours.from,
  autoTo: auto.activeHours.to,
  autoOthers: auto.others,
  autoOwn: auto.own,
  autoDependabot: auto.dependabot,
  autoConcurrency: String(auto.concurrency),
  autoDailyLimit: String(auto.dailyLimit),
  autoPostOthers: auto.post.others,
  autoPostDependabot: auto.post.dependabot,
})

const personForm = (person: Person, id: string): PersonForm => {
  const mode: AvatarMode = person.avatar === 'initials' || person.avatar === 'github' ? person.avatar : 'image'
  return {
    id,
    login: person.login,
    alias: person.alias,
    initials: person.initials,
    color: person.color,
    avatarMode: mode,
    avatarPath: mode === 'image' ? person.avatar : '',
  }
}

export const parseBots = (text: string): string[] => {
  const bots: string[] = []
  for (const part of text.split(/[,\n]/)) {
    const bot = part.trim()
    if (bot !== '' && !bots.some((seen) => seen.toLowerCase() === bot.toLowerCase())) bots.push(bot)
  }
  return bots
}

// the same range as idleRange in src/config.ts, which a test keeps in step
export const idleLimits = { min: 5, max: 1440 } as const

// whole minutes only; anything else is NaN, which the checks refuse before a save
export const parseIdleMinutes = (text: string): number => {
  const value = text.trim()
  return /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN
}

// a whole number of reviews; anything else is NaN, which the checks refuse before a save
export const parseMaxReviews = (text: string): number => {
  const value = text.trim()
  return /^\d+$/.test(value) ? Number(value) : Number.NaN
}

// a whole number as typed; anything else is NaN, which the checks refuse before a save
const parseWhole = (text: string): number => parseMaxReviews(text)

// the same rule and the same words as normalizeExtraInstructions and extraInstructionsProblem in src/config.ts, which a test keeps in step (the page cannot import that module's code)
const extraBreaks = /\r\n?|[\u2028\u2029]/g

export const normalizeExtra = (text: string): string => text.replace(extraBreaks, '\n').trim()

const extraProblem = (text: string): string | null => {
  const characters = [...text.replace(extraBreaks, '\n')]
  const at = characters.findIndex((character) => /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(character))
  if (at >= 0) return `Must be plain text: character ${at + 1} is the control character U+${(characters[at] as string).charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}, and only line breaks and tabs are allowed.`
  const length = [...normalizeExtra(text)].length
  return length > 2000 ? `Must be at most 2,000 characters; it has ${length.toLocaleString('en-US')}.` : null
}

// the config PUT /api/config receives: only known keys, trimmed; settings the page does not edit (allowedHosts and agent) are carried over from the config it loaded
export const toConfig = (form: Form, base: Config): Config => {
  const config: Config = {
    repo: form.repo.trim(),
    viewer: form.viewer.trim(),
    people: form.people.map((person) => ({
      login: person.login.trim(),
      alias: person.alias.trim(),
      initials: person.initials.trim(),
      color: person.color.trim(),
      avatar: person.avatarMode === 'image' ? person.avatarPath.trim() : person.avatarMode,
    })),
    tickets: form.tickets.map(({ id: _id, ...system }) => ({
      ...system,
      name: system.name.trim(),
      pattern: system.pattern.trim(),
      baseUrl: system.baseUrl.trim(),
      linkTemplate: system.linkTemplate.trim(),
    })),
    refreshSeconds: form.refreshSeconds,
    idleMinutes: parseIdleMinutes(form.idleMinutes),
    todayStartsAt: form.todayStartsAt,
    bots: parseBots(form.bots),
    reportsDir: form.reportsDir.trim(),
    density: form.density,
    timeFormat: form.timeFormat,
    showAgentColumn: form.showAgentColumn,
    maxConcurrentReviews: parseMaxReviews(form.maxConcurrentReviews),
    selfReviewOverCap: form.selfReviewOverCap,
    extraReviewInstructions: normalizeExtra(form.extraReviewInstructions),
    allowedHosts: base.allowedHosts,
    // an empty clone folder is left out, as the server reads it
    ...(form.cloneDir.trim() === '' ? {} : { cloneDir: form.cloneDir.trim() }),
    agent: base.agent,
  }
  // absent means off, so a config that never had the key and a form still at that default leave it out
  const kinds = allKinds.filter((kind) => form.notifyKinds.includes(kind))
  const untouched = !form.notifyEnabled && kinds.length === allKinds.length
  if (base.notifications !== undefined || !untouched) config.notifications = { enabled: form.notifyEnabled, kinds }
  // absent means off, so a config that never had the key and a form still at the defaults leave it out
  const auto = autoSettings(form)
  if (base.autoReview !== undefined || JSON.stringify(auto) !== JSON.stringify(autoDefaults)) config.autoReview = auto
  return config
}

const autoSettings = (form: Form): AutoReviewSettings => ({
  enabled: form.autoEnabled,
  intervalMinutes: parseWhole(form.autoInterval),
  activeHours: { days: inWeekOrder(form.autoDays), from: form.autoFrom.trim(), to: form.autoTo.trim() },
  others: form.autoOthers,
  own: form.autoOwn,
  dependabot: form.autoDependabot,
  concurrency: parseWhole(form.autoConcurrency),
  dailyLimit: parseWhole(form.autoDailyLimit),
  post: { others: form.autoPostOthers, dependabot: form.autoPostDependabot },
})

// unsaved changes: the form differs from the saved config once both are normalized the same way
export const isDirty = (form: Form, saved: Config): boolean =>
  JSON.stringify(toConfig(form, saved)) !== JSON.stringify(toConfig(toForm(saved, () => ''), saved))

// the settings whose change starts a config cycle; the same list as cycleKeys in src/poller.ts
export const refreshKeys = ['repo', 'viewer', 'people', 'tickets', 'bots'] as const

export const needsRefresh = (before: Config, after: Config): boolean =>
  refreshKeys.some((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))

// fields and their errors

// 'repo', 'people.0.login', 'tickets.1.pattern': a form field, by list position
export type FieldKey = string

export type FieldError = { field: FieldKey | null, message: string }

// the element ids a field and its error message use
export const fieldId = (field: FieldKey): string => `f-${field.replaceAll('.', '-')}`
export const errorId = (field: FieldKey): string => `${fieldId(field)}-error`

const repoPattern = /^[\w.-]+\/[\w.-]+$/
const colorPattern = /^#[0-9A-Fa-f]{6}$/
const imagePattern = /\.(?:png|jpe?g|gif|webp|avif)$/i
const urlPattern = /^https?:\/\/\S+$/i
const placeholders = new Set(['baseUrl', 'key', 'repo', 'n'])

const regexError = (pattern: string): string | null => {
  try {
    new RegExp(pattern, 'i')
    return null
  } catch {
    return 'Not a valid regular expression.'
  }
}

const personErrors = (person: PersonForm, index: number, people: readonly PersonForm[]): FieldError[] => {
  const at = (name: string, message: string): FieldError => ({ field: `people.${index}.${name}`, message })
  const errors: FieldError[] = []
  const login = person.login.trim()
  if (login === '') errors.push(at('login', 'Enter the GitHub login, or remove this person.'))
  else if (/\s/.test(login)) errors.push(at('login', 'A GitHub login has no spaces.'))
  else if (people.slice(0, index).some((other) => other.login.trim().toLowerCase() === login.toLowerCase())) {
    errors.push(at('login', 'This login is already listed above.'))
  }
  if (person.alias.trim() === '') errors.push(at('alias', 'Enter the name to show in place of the login.'))
  const initials = person.initials.trim()
  if (initials === '' || [...initials].length > 3) errors.push(at('initials', 'Use one to three characters.'))
  if (!colorPattern.test(person.color.trim())) errors.push(at('color', 'Pick a color: # and six hex digits.'))
  if (person.avatarMode === 'image') {
    const path = person.avatarPath.trim()
    if (!path.startsWith('~/')) errors.push(at('avatarPath', 'Give a path under your home folder, starting with ~/.'))
    else if (!imagePattern.test(path)) errors.push(at('avatarPath', 'Use a PNG, JPEG, GIF, WebP or AVIF image.'))
  }
  return errors
}

const ticketErrors = (system: TicketForm, index: number): FieldError[] => {
  const at = (name: string, message: string): FieldError => ({ field: `tickets.${index}.${name}`, message })
  const errors: FieldError[] = []
  if (system.name.trim() === '') errors.push(at('name', 'Enter a name for this system.'))
  if (system.source === 'title-then-branch') {
    const pattern = system.pattern.trim()
    const invalid = pattern === '' ? 'Enter a key pattern, for example \\b[a-z]+-\\d+\\b.' : regexError(pattern)
    if (invalid !== null) errors.push(at('pattern', invalid))
  }
  const baseUrl = system.baseUrl.trim()
  if (baseUrl !== '' && !urlPattern.test(baseUrl)) errors.push(at('baseUrl', 'Use a full URL starting with https://, or leave it empty.'))
  const unknown = [...system.linkTemplate.matchAll(/\{([^}]*)\}/g)].map((match) => match[1] ?? '').find((name) => !placeholders.has(name))
  if (unknown !== undefined) errors.push(at('linkTemplate', `{${unknown}} is not a placeholder; use {baseUrl}, {key}, {repo} or {n}.`))
  return errors
}

// the checks made before saving; the server's validateConfig still has the last word
export const validateForm = (form: Form): FieldError[] => {
  const errors: FieldError[] = []
  if (!repoPattern.test(form.repo.trim())) errors.push({ field: 'repo', message: 'Use owner/name, for example octo-org/widgets.' })
  if (/\s/.test(form.viewer.trim())) errors.push({ field: 'viewer', message: 'A GitHub login has no spaces; leave it empty for the gh login.' })
  form.people.forEach((person, index) => errors.push(...personErrors(person, index, form.people)))
  form.tickets.forEach((system, index) => errors.push(...ticketErrors(system, index)))
  const idle = parseIdleMinutes(form.idleMinutes)
  if (!(idle === 0 || (idle >= idleLimits.min && idle <= idleLimits.max))) {
    errors.push({ field: 'idleMinutes', message: `Use 0 for never, or a whole number of minutes from ${idleLimits.min} to ${idleLimits.max}.` })
  }
  if (form.reportsDir.trim() === '') errors.push({ field: 'reportsDir', message: 'Enter the folder review reports are written to, for example ~/agents/output.' })
  // the same rule as isReviewCap in src/config.ts, which a test keeps in step
  const cap = parseMaxReviews(form.maxConcurrentReviews)
  if (!(Number.isSafeInteger(cap) && cap >= 1)) errors.push({ field: 'maxConcurrentReviews', message: 'Use a whole number of 1 or more.' })
  const extra = extraProblem(form.extraReviewInstructions)
  if (extra !== null) errors.push({ field: 'extraReviewInstructions', message: extra })
  errors.push(...autoErrors(form))
  return errors
}

// the same rules as toAutoReview and toCloneDir in src/config.ts, which a test keeps in step
const clockPattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/

const autoErrors = (form: Form): FieldError[] => {
  const errors: FieldError[] = []
  const interval = parseWhole(form.autoInterval)
  if (!(Number.isSafeInteger(interval) && interval >= 5)) errors.push({ field: 'autoInterval', message: 'Use a whole number of minutes, 5 or more.' })
  if (form.autoDays.length === 0) errors.push({ field: 'autoDays', message: 'Choose at least one day.' })
  const from = form.autoFrom.trim()
  const to = form.autoTo.trim()
  if (!clockPattern.test(from)) errors.push({ field: 'autoFrom', message: 'Use a 24-hour time such as 09:00.' })
  if (!clockPattern.test(to)) errors.push({ field: 'autoTo', message: 'Use a 24-hour time such as 09:00.' })
  // a window never crosses midnight
  else if (clockPattern.test(from) && from >= to) errors.push({ field: 'autoTo', message: 'Must be after the start time.' })
  for (const [field, text] of [['autoConcurrency', form.autoConcurrency], ['autoDailyLimit', form.autoDailyLimit]] as const) {
    const value = parseWhole(text)
    if (!(Number.isSafeInteger(value) && value >= 1)) errors.push({ field, message: 'Use a whole number of 1 or more.' })
  }
  const clone = form.cloneDir.trim()
  if (clone !== '' && clone !== '~' && !clone.startsWith('~/') && !clone.startsWith('/')) {
    errors.push({ field: 'cloneDir', message: 'Give an absolute path or a path under ~, such as ~/dev/orbit.' })
  }
  return errors
}

export type PostKind = 'others' | 'dependabot'

// turning a posting switch on is the one change that asks first; turning one off, or saving one that is already on, does not
export const wantsPostConfirm = (form: Pick<Form, 'autoPostOthers' | 'autoPostDependabot'>, kind: PostKind, on: boolean): boolean =>
  on && !(kind === 'others' ? form.autoPostOthers : form.autoPostDependabot)

// the login a posting question names: the viewer typed in the form, else the gh login
export const postingLoginOf = (viewer: string, ghLogin: string): string => viewer.trim() || ghLogin

// an open question was drawn for one login; it is stale once the form and the gh login would name another, and then it must be closed and asked again rather than confirmed
export const postAskIsStale = (named: string, viewer: string, ghLogin: string): boolean => postingLoginOf(viewer, ghLogin) !== named

export type PostingAsk = { title: string, lines: string[], confirm: string, cancel: string }

// what the confirmation says: what will post, and under which login (the gh login's name when the viewer is not yet known)
export const postingAsk = (kind: PostKind, login: string): PostingAsk => {
  const who = login === '' ? 'your gh login' : `@${login}`
  if (kind === 'others') {
    return {
      title: `Let auto-review post to GitHub as ${who}?`,
      lines: [
        `Auto-review runs on other people's PRs will post their report as ${who}: an approval, a request for changes, or a comment, chosen by the findings and the checks.`,
        'Your own PRs never post, and never get fixes, whatever this says.',
        'It applies to runs that start after you save.',
      ],
      confirm: `Post as ${who}`,
      cancel: 'Cancel',
    }
  }
  return {
    title: `Let scheduled Dependabot sweeps post to GitHub as ${who}?`,
    lines: [
      `Each scheduled sweep will have its reviewers post as ${who}: an approval for a bump with nothing above P3 and green checks, and a comment or a request for changes for the rest.`,
      'A sweep you start by hand already posts this way, with or without this switch.',
      'It applies to sweeps that start after you save.',
    ],
    confirm: `Post as ${who}`,
    cancel: 'Cancel',
  }
}

const formFields = new Set(['repo', 'viewer', 'refreshSeconds', 'idleMinutes', 'todayStartsAt', 'bots', 'reportsDir', 'density', 'timeFormat', 'showAgentColumn', 'maxConcurrentReviews', 'selfReviewOverCap', 'extraReviewInstructions', 'notifyEnabled', 'cloneDir'])

// the server's autoReview paths and the fields they land on
const autoFields: Readonly<Record<string, string>> = {
  enabled: 'autoEnabled',
  intervalMinutes: 'autoInterval',
  others: 'autoOthers',
  own: 'autoOwn',
  dependabot: 'autoDependabot',
  concurrency: 'autoConcurrency',
  dailyLimit: 'autoDailyLimit',
  'activeHours.days': 'autoDays',
  'activeHours.from': 'autoFrom',
  'activeHours.to': 'autoTo',
  'post.others': 'autoPostOthers',
  'post.dependabot': 'autoPostDependabot',
}

const capitalize = (text: string): string => text === '' ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`

// a refusal from PUT /api/config ("people[2].avatar must be ...") placed on the field it names;
// anything the form has no field for (an unknown key) stays a message for the whole form
export const serverError = (message: string, form: Form): FieldError => {
  const auto = /^autoReview\.((?:activeHours|post)\.\w+|\w+) (.+)$/.exec(message)
  if (auto !== null) {
    const field = autoFields[auto[1] ?? '']
    return field === undefined ? { field: null, message } : { field, message: `${capitalize(auto[2] ?? '')}.` }
  }
  const match = /^(config|people\[(\d+)\]|tickets\[(\d+)\])\.(\w+) (.+)$/.exec(message)
  if (match === null) return { field: null, message: capitalize(message) }
  // a setting the form has no field for keeps its path, so the message still says which
  const whole: FieldError = { field: null, message }
  const [, , person, ticket, key = '', rest = ''] = match
  if (/is not a known setting$/.test(rest)) return whole
  const text = `${capitalize(rest)}.`
  if (person !== undefined) {
    const index = Number(person)
    const entry = form.people[index]
    if (entry === undefined) return whole
    const name = key === 'avatar' ? entry.avatarMode === 'image' ? 'avatarPath' : 'avatarMode' : key
    return { field: `people.${index}.${name}`, message: text }
  }
  if (ticket !== undefined) return form.tickets[Number(ticket)] === undefined ? whole : { field: `tickets.${ticket}.${key}`, message: text }
  return formFields.has(key) ? { field: key, message: text } : whole
}

// people

// the same initials the dashboard gives an unlisted login (src/derive.ts)
export const initialsOf = (login: string): string => {
  const parts = login.split(/[-_.\s]+/).filter((part) => part !== '')
  const letters = parts.length > 1 ? parts.slice(0, 2).map((part) => part[0]).join('') : login.slice(0, 2)
  return letters.toUpperCase()
}

// a first guess at a display name: the login's first word, capitalized
export const aliasOf = (login: string): string => capitalize(login.split(/[-_./\s]+/).find((part) => part !== '') ?? login)

type Rgb = [number, number, number]

const hslToRgb = (hue: number, saturation: number, lightness: number): Rgb => {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = lightness - chroma / 2
  const sector = Math.floor(hue / 60) % 6
  const [r, g, b] = ([[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]] as Rgb[])[sector]!
  return [r + m, g + m, b + m]
}

const channel = (value: number): number => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4

const luminance = ([r, g, b]: Rgb): number => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)

// contrast of white initials on a hex color, as the avatar draws them
export const contrastWithWhite = (hex: string): number => {
  const digits = hex.replace(/^#/, '')
  const rgb = [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16) / 255) as Rgb
  return 1.05 / (luminance(rgb) + 0.05)
}

const toHex = (rgb: Rgb): string => `#${rgb.map((value) => Math.round(value * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`

// a new person's color: a hue from the login, darkened until white initials read at 4.5:1;
// computed rather than listed, since person colors are config data and not stylesheet tokens
export const colorFor = (login: string): string => {
  let hash = 0
  for (const char of login.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const hue = hash % 360
  for (let lightness = 0.42; lightness > 0.1; lightness -= 0.02) {
    const color = toHex(hslToRgb(hue, 0.62, lightness))
    if (contrastWithWhite(color) >= 4.5) return color
  }
  return toHex(hslToRgb(hue, 0.62, 0.1))
}

export const newPerson = (id: string, login = ''): PersonForm => ({
  id,
  login,
  alias: login === '' ? '' : aliasOf(login),
  initials: login === '' ? '' : initialsOf(login),
  color: colorFor(login === '' ? id : login),
  avatarMode: 'github',
  avatarPath: '',
})

export type Suggestion = { login: string, avatarUrl: string, count: number }

// the server's suggestions less anyone the form already lists, saved or not
export const openSuggestions = (suggestions: readonly Suggestion[], form: Form): Suggestion[] => {
  const listed = new Set(form.people.map((person) => person.login.trim().toLowerCase()))
  return suggestions.filter((suggestion) => !listed.has(suggestion.login.toLowerCase()))
}

// what a person row's preview shows: the dashboard's avatar for this entry; saved is the
// people list as stored, since the server serves a local image only once it is saved
export const previewPerson = (person: PersonForm, saved: readonly Person[] = []): { login: string, alias: string, initials: string, color: string | null, avatarUrl: string | null } => {
  const login = person.login.trim()
  const color = person.color.trim()
  let avatarUrl: string | null = null
  if (login !== '' && person.avatarMode === 'github') avatarUrl = `https://github.com/${encodeURIComponent(login)}.png`
  // an unsaved or changed path would ask for nothing, or for the old image: the initials show until saved
  const stored = saved.find((entry) => entry.login.toLowerCase() === login.toLowerCase())
  if (login !== '' && person.avatarMode === 'image' && stored?.avatar === person.avatarPath.trim()) avatarUrl = `/api/avatar/${encodeURIComponent(login)}`
  return {
    login,
    alias: person.alias.trim() === '' ? login : person.alias.trim(),
    initials: person.initials.trim() === '' ? initialsOf(login) : person.initials.trim(),
    color: colorPattern.test(color) ? color : null,
    avatarUrl,
  }
}

// tickets

export type TicketKind = TicketSystem['kind']

type KindDefaults = Pick<TicketSystem, 'name' | 'source' | 'pattern' | 'baseUrl' | 'linkTemplate'>

const keyPattern = '\\b[a-z]+-\\d+\\b'

export const kindDefaults: Record<TicketKind, KindDefaults> = {
  jira: { name: 'Jira', source: 'title-then-branch', pattern: keyPattern, baseUrl: '', linkTemplate: '{baseUrl}/browse/{key}' },
  'github-issues': { name: 'GitHub', source: 'linked-issues', pattern: '', baseUrl: '', linkTemplate: 'https://github.com/{repo}/issues/{n}' },
  linear: { name: 'Linear', source: 'title-then-branch', pattern: keyPattern, baseUrl: '', linkTemplate: '{baseUrl}/issue/{key}' },
  template: { name: 'Tickets', source: 'title-then-branch', pattern: keyPattern, baseUrl: '', linkTemplate: '{baseUrl}/{key}' },
}

export const newTicket = (id: string, kind: TicketKind = 'jira'): TicketForm => ({ id, enabled: true, kind, ...kindDefaults[kind] })

// a kind change fills in the new kind's defaults, but only over fields still empty or holding
// the old kind's defaults, so nothing typed by hand is lost
export const changeKind = (system: TicketForm, kind: TicketKind): TicketForm => {
  const before = kindDefaults[system.kind]
  const after = kindDefaults[kind]
  const keep = <K extends keyof KindDefaults>(field: K): KindDefaults[K] =>
    system[field] === '' || system[field] === before[field] ? after[field] : system[field]
  return {
    ...system,
    kind,
    name: keep('name'),
    source: keep('source'),
    pattern: keep('pattern'),
    baseUrl: keep('baseUrl'),
    linkTemplate: keep('linkTemplate'),
  }
}

// the same substitution the dashboard uses (src/derive.ts): an empty baseUrl on a template that
// uses it means no link
export const fillTemplate = (template: string, values: Record<string, string>): string | null => {
  if (template === '') return null
  if (template.includes('{baseUrl}') && (values.baseUrl ?? '') === '') return null
  return template.replace(/\{(baseUrl|key|repo|n)\}/g, (_, name: string) => values[name] ?? '')
}

// text to find a sample key in: cached titles and branches first, then invented examples
export type SampleText = { text: string, where: string }

export const exampleTexts: readonly SampleText[] = [
  { text: 'ABC-123', where: 'an example key' },
  { text: 'abc-123', where: 'an example key' },
  { text: 'ENG-42', where: 'an example key' },
]

// the cached open PRs' titles, then their branches, then the closed PRs' titles, as places a
// pattern may find a key; a repo whose open PRs carry no keys often has some among the closed
export const sampleTextsFrom = (view: View | null): SampleText[] => {
  if (view === null) return []
  const rows: { number: number, title: string, headRef: string }[] = [
    ...view.mine.groups.flatMap((group) => group.rows),
    ...view.others.groups.flatMap((group) => group.rows),
  ]
  const closed = [...view.closed?.today.rows ?? [], ...view.closed?.yesterday.rows ?? []]
  return [
    ...rows.map((row) => ({ text: row.title, where: `the title of #${row.number}` })),
    ...rows.map((row) => ({ text: row.headRef, where: `the branch of #${row.number}` })),
    ...closed.map((row) => ({ text: row.title, where: `the title of #${row.number}, closed` })),
  ]
}

export type Sample =
  | { label: string, url: string | null, where: string }
  | { label: null, reason: string }

// the chip a system would show, from the first text its pattern finds a key in
export const ticketSample = (system: TicketForm, repo: string, texts: readonly SampleText[]): Sample => {
  const linkFor = (key: string, n: string): string | null =>
    fillTemplate(system.linkTemplate.trim(), { baseUrl: system.baseUrl.trim().replace(/\/+$/, ''), key, repo: repo.trim(), n })
  if (system.source === 'linked-issues') return { label: '#42', url: linkFor('#42', '42'), where: 'an example linked issue' }
  const pattern = system.pattern.trim()
  if (pattern === '') return { label: null, reason: 'no pattern yet' }
  let regex: RegExp
  try {
    regex = new RegExp(pattern, 'i')
  } catch {
    return { label: null, reason: 'invalid pattern' }
  }
  for (const { text, where } of [...texts, ...exampleTexts]) {
    const key = regex.exec(text)?.[0]
    if (key !== undefined && key !== '') {
      const label = key.toUpperCase()
      return { label, url: linkFor(label, /(\d+)$/.exec(label)?.[1] ?? ''), where }
    }
  }
  return { label: null, reason: 'no match yet' }
}

// options shown in the selects, in the order section 6 gives

export type Choice<T extends string | number> = { value: T, label: string }

export const refreshChoices: Choice<Config['refreshSeconds']>[] = [
  { value: 60, label: '60 seconds' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes (default)' },
]

export const todayChoices = (timeZone: string): Choice<Config['todayStartsAt']>[] => [
  { value: 'local', label: `Local midnight (${timeZone})` },
  { value: 'utc', label: 'UTC midnight' },
]

export const densityChoices: Choice<Config['density']>[] = [
  { value: 'comfortable', label: 'Comfortable (default)' },
  { value: 'compact', label: 'Compact' },
]

export const timeFormatChoices: Choice<Config['timeFormat']>[] = [
  { value: '12h', label: '12 hour, 2:45 PM (default)' },
  { value: '24h', label: '24 hour, 14:45' },
]

export const avatarChoices: Choice<AvatarMode>[] = [
  { value: 'initials', label: 'Initials' },
  { value: 'github', label: 'GitHub avatar' },
  { value: 'image', label: 'Image file' },
]

export const kindChoices: Choice<TicketKind>[] = [
  { value: 'jira', label: 'Jira' },
  { value: 'github-issues', label: 'GitHub issues' },
  { value: 'linear', label: 'Linear' },
  { value: 'template', label: 'Other (URL template)' },
]

export const sourceChoices: Choice<TicketSystem['source']>[] = [
  { value: 'title-then-branch', label: 'Title, then branch' },
  { value: 'linked-issues', label: 'Issues the PR links' },
]
