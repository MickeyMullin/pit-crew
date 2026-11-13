// src/config.ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { projectModels } from './models.ts'
import { isNotificationKind, notificationKinds } from './notify.ts'
import type { NotificationKind } from './notify.ts'

export type Clock = { now: () => number }

export type Person = {
  login: string
  alias: string
  initials: string
  color: string
  // 'initials', 'github', or an image path under ~
  avatar: string
}

export type TicketSystem = {
  enabled: boolean
  kind: 'jira' | 'github-issues' | 'linear' | 'template'
  name: string
  source: 'title-then-branch' | 'linked-issues'
  pattern: string
  baseUrl: string
  linkTemplate: string
}

// absent means off; kinds lists the transitions to notify about (section 9 of DESIGN.md)
export type Notifications = { enabled: boolean, kinds: NotificationKind[] }

// the days auto-review's active hours name, Sunday first, as the time helpers number them
export const weekdayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
export type WeekdayName = typeof weekdayNames[number]

export type ActiveHours = { days: WeekdayName[], from: string, to: string }

// the autoReview key (section 10 of DESIGN.md, Configuration); absent means off
export type AutoReviewSettings = {
  enabled: boolean
  intervalMinutes: number
  activeHours: ActiveHours
  others: boolean
  own: boolean
  dependabot: boolean
  concurrency: number
  dailyLimit: number
  post: { others: boolean, dependabot: boolean }
}

// the agents Pit View can drive for a review session (section 8 of DESIGN.md, Launching runs)
export type RunnerName = 'claude' | 'codex'
export const runnerNames: readonly RunnerName[] = ['claude', 'codex']

export const defaultClaudeModel = 'sonnet'

// the owner's extra review instructions (section 8 of DESIGN.md, Extra instructions): what a run used, and whether it came from Settings or was typed for this run
export type ExtraInstructions = { text: string, source: 'default' | 'box' }

export const maxExtraInstructions = 2000

// the text as it is stored and written: every line break a plain newline, and nothing around it
export const normalizeExtraInstructions = (text: string): string => text.replace(/\r\n?|[\u2028\u2029]/g, '\n').trim()

// why the text is refused, finishing a sentence that names it, or null when it is fine. Control characters are looked for before the trim, which would otherwise hide one at either end. A character is a code point, as a reader counts it. The page keeps the same rule in public/settings-form.ts, which a test keeps in step
export const extraInstructionsProblem = (text: string): string | null => {
  const characters = [...text.replace(/\r\n?|[\u2028\u2029]/g, '\n')]
  const at = characters.findIndex((character) => /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(character))
  if (at >= 0) return `must be plain text: character ${at + 1} is the control character U+${(characters[at] as string).charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}, and only line breaks and tabs are allowed`
  const length = [...normalizeExtraInstructions(text)].length
  return length > maxExtraInstructions ? `must be at most ${maxExtraInstructions.toLocaleString('en-US')} characters; it has ${length.toLocaleString('en-US')}` : null
}

export type AgentSettings = {
  // the default runner; a single run may pick the other
  runner: RunnerName
  // passed to every Claude run as --model; the default is sonnet, not the owner's own Claude default
  claudeModel: string
  // passed to Codex as -m when set; Codex otherwise uses its own configured model
  codexModel?: string
}

export type Config = {
  repo: string
  // empty means the gh login, filled in by loadConfig
  viewer: string
  people: Person[]
  tickets: TicketSystem[]
  refreshSeconds: 60 | 120 | 300
  // a page with no user activity for this long stops counting as active; 0 means never
  idleMinutes: number
  todayStartsAt: 'local' | 'utc'
  bots: string[]
  // stored with ~; expand with expandHome before use
  reportsDir: string
  density: 'comfortable' | 'compact'
  // how every clock time in the pages is written: 2:45 PM or 14:45
  timeFormat: '12h' | '24h'
  showAgentColumn: boolean
  // review runs in flight at once; more wait in a queue (section 8 of DESIGN.md, Review cap)
  maxConcurrentReviews: number
  // whether one self-review may run over that cap
  selfReviewOverCap: boolean
  // the standing default for the extra review instructions; empty means none (section 8 of DESIGN.md, Extra instructions)
  extraReviewInstructions: string
  // host names a reverse proxy may reach the server by, besides its loopback names
  allowedHosts: string[]
  // the owner's local clone of repo, stored with ~; manual runs work in it. Whether it is a
  // clone of repo is checked when a run starts, not on save
  cloneDir?: string
  agent: AgentSettings
  // the model registry and the per-command slots exactly as stored, which src/models.ts reads: a read keeps the known fields of whatever is there (projectModels drops every other field, on a read and on a save), since a bad entry or slot is set aside there with a warning, and a save refuses a bad entry and a credential-like field (modelsSaveProblem). Absent means the built-in models
  models?: unknown
  notifications?: Notifications
  autoReview?: AutoReviewSettings
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

// the same values as config.example.json; a test keeps the two in step
export const defaultConfig = (): Config => ({
  repo: 'Port-City/meridian',
  viewer: '',
  people: [],
  tickets: [
    {
      enabled: true,
      kind: 'jira',
      name: 'Jira',
      source: 'title-then-branch',
      pattern: '\\b[a-z]+-\\d+\\b',
      baseUrl: '',
      linkTemplate: '{baseUrl}/browse/{key}',
    },
    {
      enabled: true,
      kind: 'github-issues',
      name: 'GitHub',
      source: 'linked-issues',
      pattern: '',
      baseUrl: '',
      linkTemplate: 'https://github.com/{repo}/issues/{n}',
    },
  ],
  refreshSeconds: 300,
  idleMinutes: 90,
  todayStartsAt: 'local',
  bots: ['dependabot', 'renovate'],
  reportsDir: '~/agents/output',
  density: 'comfortable',
  timeFormat: '12h',
  showAgentColumn: false,
  maxConcurrentReviews: 2,
  selfReviewOverCap: false,
  extraReviewInstructions: '',
  allowedHosts: [],
  agent: { runner: 'claude', claudeModel: defaultClaudeModel },
})

// the default instance ('') is the deployed app; a named one, such as dev, keeps folders of its own
export const instanceFolder = (instance: string): string => instance === '' ? 'pit-view' : `pit-view-${instance}`
export const configDir = (home: string, instance = ''): string => join(home, '.config', instanceFolder(instance))
export const configFile = (home: string, instance = ''): string => join(configDir(home, instance), 'config.json')
export const stateDir = (home: string, instance = ''): string => join(home, '.local', 'state', instanceFolder(instance))
export const cacheFile = (home: string, instance = ''): string => join(stateDir(home, instance), 'cache.sqlite')

// a path under home written with ~, as the pages show it
export const tildePath = (path: string, home: string): string => {
  if (path === home) return '~'
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`
  return path
}

// '~' and '~/x' resolve against home; anything else is returned unchanged
export const expandHome = (path: string, home: string): string => {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const fail = (message: string): never => {
  throw new ConfigError(message)
}

const str = (obj: Record<string, unknown>, key: string, where: string): string =>
  typeof obj[key] === 'string' ? obj[key] : fail(`${where}.${key} must be a string`)

const bool = (obj: Record<string, unknown>, key: string, where: string): boolean =>
  typeof obj[key] === 'boolean' ? obj[key] : fail(`${where}.${key} must be true or false`)

const oneOf = <T extends string | number>(obj: Record<string, unknown>, key: string, allowed: readonly T[], where: string): T =>
  allowed.includes(obj[key] as T) ? obj[key] as T : fail(`${where}.${key} must be one of ${allowed.join(', ')}`)

const list = (obj: Record<string, unknown>, key: string, where: string): unknown[] =>
  Array.isArray(obj[key]) ? obj[key] : fail(`${where}.${key} must be a list`)

// 0 turns idle off; otherwise from a few minutes, so reading a page is not mistaken for leaving
// it, to a day
export const idleRange = { min: 5, max: 1440 } as const

export const isIdleMinutes = (value: unknown): value is number =>
  Number.isInteger(value) && (value === 0 || ((value as number) >= idleRange.min && (value as number) <= idleRange.max))

const idleMinutes = (obj: Record<string, unknown>, where: string): number =>
  isIdleMinutes(obj.idleMinutes)
    ? obj.idleMinutes
    : fail(`${where}.idleMinutes must be 0 (never idle) or a whole number of minutes from ${idleRange.min} to ${idleRange.max}`)

// a whole number of 1 or more that a JSON number holds exactly, so the Settings page, which shows it in digits, can save back every cap kept here
export const isReviewCap = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1

// the auto-review daily limit alone may be 0, which means no limit; every other cap stays at 1 or more
export const isDailyLimit = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

const extraReviewInstructions = (obj: Record<string, unknown>, where: string): string => {
  const text = obj.extraReviewInstructions
  if (typeof text !== 'string') return fail(`${where}.extraReviewInstructions must be a string`)
  const problem = extraInstructionsProblem(text)
  return problem === null ? normalizeExtraInstructions(text) : fail(`${where}.extraReviewInstructions ${problem}`)
}

const maxConcurrentReviews = (obj: Record<string, unknown>, where: string): number =>
  isReviewCap(obj.maxConcurrentReviews) ? obj.maxConcurrentReviews : fail(`${where}.maxConcurrentReviews must be a whole number of 1 or more`)

const onlyKeys = (obj: Record<string, unknown>, allowed: readonly string[], where: string): void => {
  const extra = Object.keys(obj).find((key) => !allowed.includes(key))
  if (extra !== undefined) fail(`${where}.${extra} is not a known setting`)
}

const personKeys = ['login', 'alias', 'initials', 'color', 'avatar'] as const
const ticketKeys = ['enabled', 'kind', 'name', 'source', 'pattern', 'baseUrl', 'linkTemplate'] as const
const configKeys = [
  'repo', 'viewer', 'people', 'tickets', 'refreshSeconds', 'idleMinutes', 'todayStartsAt',
  'bots', 'reportsDir', 'density', 'timeFormat', 'showAgentColumn', 'maxConcurrentReviews', 'selfReviewOverCap', 'extraReviewInstructions', 'allowedHosts', 'cloneDir', 'agent', 'models', 'notifications', 'autoReview',
] as const

// a bare DNS name: dot-separated labels of letters, digits and inner hyphens, with no scheme,
// port, path or wildcard
const hostnamePattern = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

export const isHostname = (value: string): boolean => hostnamePattern.test(value)

// trimmed, lowercased and without repeats; anything else than a bare host name is refused
const toAllowedHosts = (values: unknown[]): string[] => {
  const hosts: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') return fail('config.allowedHosts must hold strings')
    const name = value.trim().toLowerCase()
    if (!isHostname(name)) fail(`config.allowedHosts must hold bare host names such as pit.example.test, with no scheme, port or path; got ${value}`)
    if (!hosts.includes(name)) hosts.push(name)
  }
  return hosts
}

const toPerson = (value: unknown, index: number): Person => {
  const where = `people[${index}]`
  if (!isObject(value)) return fail(`${where} must be an object`)
  onlyKeys(value, personKeys, where)
  const avatar = str(value, 'avatar', where)
  if (avatar !== 'initials' && avatar !== 'github' && !avatar.startsWith('~/')) {
    fail(`${where}.avatar must be initials, github, or a path under ~`)
  }
  return {
    login: str(value, 'login', where),
    alias: str(value, 'alias', where),
    initials: str(value, 'initials', where),
    color: str(value, 'color', where),
    avatar,
  }
}

const toTicketSystem = (value: unknown, index: number): TicketSystem => {
  const where = `tickets[${index}]`
  if (!isObject(value)) return fail(`${where} must be an object`)
  onlyKeys(value, ticketKeys, where)
  const system: TicketSystem = {
    enabled: bool(value, 'enabled', where),
    kind: oneOf(value, 'kind', ['jira', 'github-issues', 'linear', 'template'], where),
    name: str(value, 'name', where),
    source: oneOf(value, 'source', ['title-then-branch', 'linked-issues'], where),
    pattern: str(value, 'pattern', where),
    baseUrl: str(value, 'baseUrl', where),
    linkTemplate: str(value, 'linkTemplate', where),
  }
  if (system.source === 'title-then-branch') {
    try {
      new RegExp(system.pattern, 'i')
    } catch {
      fail(`${where}.pattern is not a valid regular expression`)
    }
  }
  return system
}

const toNotifications = (value: unknown): Notifications => {
  if (!isObject(value)) return fail('config.notifications must be an object')
  onlyKeys(value, ['enabled', 'kinds'], 'notifications')
  const kinds = list(value, 'kinds', 'notifications')
  const known: NotificationKind[] = []
  for (const kind of kinds) {
    if (!isNotificationKind(kind)) fail(`notifications.kinds must hold only ${notificationKinds.join(', ')}; got ${typeof kind === 'string' ? kind : typeof kind}`)
    else if (!known.includes(kind)) known.push(kind)
  }
  return { enabled: bool(value, 'enabled', 'notifications'), kinds: known }
}

// an absolute path or one under ~; an empty value means unset
const toCloneDir = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return fail('config.cloneDir must be a string path, such as ~/dev/orbit')
  const path = value.trim()
  if (path === '') return undefined
  if (path !== '~' && !path.startsWith('~/') && !path.startsWith('/')) fail('config.cloneDir must be an absolute path or a path under ~, such as ~/dev/orbit')
  if (path.includes('\0')) fail('config.cloneDir must not contain a NUL character')
  return path
}

// a model name as Claude takes it after --model or Codex after -m; never a flag, never whitespace
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/

// absent means the default runner, so a config written before phase 2 still validates
const toAgent = (value: unknown): AgentSettings => {
  if (value === undefined) return { runner: 'claude', claudeModel: defaultClaudeModel }
  if (!isObject(value)) return fail('config.agent must be an object such as { "runner": "claude" }')
  onlyKeys(value, ['runner', 'claudeModel', 'codexModel'], 'agent')
  const agent: AgentSettings = { runner: oneOf(value, 'runner', runnerNames, 'agent'), claudeModel: defaultClaudeModel }
  if (value.claudeModel !== undefined) {
    const model = str(value, 'claudeModel', 'agent').trim()
    if (model !== '') {
      if (!modelPattern.test(model)) fail('agent.claudeModel must be a model name such as sonnet or opus, with no spaces')
      agent.claudeModel = model
    }
  }
  if (value.codexModel !== undefined) {
    const model = str(value, 'codexModel', 'agent').trim()
    if (model !== '') {
      if (!modelPattern.test(model)) fail('agent.codexModel must be a model name such as gpt-6.1-terra, with no spaces')
      agent.codexModel = model
    }
  }
  return agent
}

const autoReviewKeys = ['enabled', 'intervalMinutes', 'activeHours', 'others', 'own', 'dependabot', 'concurrency', 'dailyLimit', 'post'] as const

const clockTime = (obj: Record<string, unknown>, key: string, where: string): string => {
  const value = obj[key]
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fail(`${where}.${key} must be a 24-hour time such as 09:00`)
}

const toActiveHours = (value: unknown): ActiveHours => {
  const where = 'autoReview.activeHours'
  if (!isObject(value)) return fail(`${where} must be an object`)
  onlyKeys(value, ['days', 'from', 'to'], where)
  const days = list(value, 'days', where)
  if (days.length === 0) fail(`${where}.days must list at least one day`)
  const known: WeekdayName[] = []
  for (const day of days) {
    if (!weekdayNames.includes(day as WeekdayName)) fail(`${where}.days must hold only ${weekdayNames.join(', ')}`)
    if (known.includes(day as WeekdayName)) fail(`${where}.days must not repeat a day`)
    known.push(day as WeekdayName)
  }
  const from = clockTime(value, 'from', where)
  const to = clockTime(value, 'to', where)
  // a window never crosses midnight
  if (from >= to) fail(`${where}.from must be before to`)
  return { days: known, from, to }
}

// a present key carries everything, as notifications does: nothing here falls back to a default that could turn something on
const toAutoReview = (value: unknown): AutoReviewSettings => {
  const where = 'autoReview'
  if (!isObject(value)) return fail('config.autoReview must be an object')
  onlyKeys(value, autoReviewKeys, where)
  if (!isObject(value.post)) return fail(`${where}.post must be an object`)
  onlyKeys(value.post, ['others', 'dependabot'], `${where}.post`)
  const interval = value.intervalMinutes
  if (!Number.isSafeInteger(interval) || (interval as number) < 5) fail(`${where}.intervalMinutes must be a whole number of 5 or more`)
  if (!isReviewCap(value.concurrency)) fail(`${where}.concurrency must be a whole number of 1 or more`)
  if (!isDailyLimit(value.dailyLimit)) fail(`${where}.dailyLimit must be a whole number of 0 or more`)
  return {
    enabled: bool(value, 'enabled', where),
    intervalMinutes: interval as number,
    activeHours: toActiveHours(value.activeHours),
    others: bool(value, 'others', where),
    own: bool(value, 'own', where),
    dependabot: bool(value, 'dependabot', where),
    concurrency: value.concurrency as number,
    dailyLimit: value.dailyLimit as number,
    post: { others: bool(value.post, 'others', `${where}.post`), dependabot: bool(value.post, 'dependabot', `${where}.post`) },
  }
}

// the rule a save applies and a read does not: Concurrent auto-reviews share the review cap, so they may not exceed maxConcurrentReviews. validateConfig runs on every file read and must not apply it, or a file already over the cap would stop loading
export const autoConcurrencyProblem = (config: Pick<Config, 'autoReview' | 'maxConcurrentReviews'>): string | null =>
  config.autoReview !== undefined && config.autoReview.concurrency > config.maxConcurrentReviews
    ? `autoReview.concurrency must be no more than maxConcurrentReviews (${config.maxConcurrentReviews})`
    : null

// checks a whole config (as PUT /api/config sends it) and returns a clean copy
export const validateConfig = (input: unknown): Config => {
  if (!isObject(input)) return fail('config must be a JSON object')
  onlyKeys(input, configKeys, 'config')
  const repo = str(input, 'repo', 'config')
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail('config.repo must look like owner/name')
  const cloneDir = input.cloneDir === undefined ? undefined : toCloneDir(input.cloneDir)
  const config: Config = {
    repo,
    viewer: str(input, 'viewer', 'config').trim(),
    people: list(input, 'people', 'config').map(toPerson),
    tickets: list(input, 'tickets', 'config').map(toTicketSystem),
    refreshSeconds: oneOf(input, 'refreshSeconds', [60, 120, 300], 'config'),
    idleMinutes: idleMinutes(input, 'config'),
    todayStartsAt: oneOf(input, 'todayStartsAt', ['local', 'utc'], 'config'),
    bots: list(input, 'bots', 'config').map((bot) => typeof bot === 'string' ? bot : fail('config.bots must hold strings')),
    reportsDir: str(input, 'reportsDir', 'config'),
    density: oneOf(input, 'density', ['comfortable', 'compact'], 'config'),
    timeFormat: oneOf(input, 'timeFormat', ['12h', '24h'], 'config'),
    showAgentColumn: bool(input, 'showAgentColumn', 'config'),
    maxConcurrentReviews: maxConcurrentReviews(input, 'config'),
    selfReviewOverCap: bool(input, 'selfReviewOverCap', 'config'),
    extraReviewInstructions: extraReviewInstructions(input, 'config'),
    allowedHosts: toAllowedHosts(list(input, 'allowedHosts', 'config')),
    // absent and empty both mean unset, and an unset cloneDir is left out of the file
    ...(cloneDir === undefined ? {} : { cloneDir }),
    agent: toAgent(input.agent),
  }
  if (input.models !== undefined) config.models = projectModels(input.models)
  if (input.notifications !== undefined) config.notifications = toNotifications(input.notifications)
  if (input.autoReview !== undefined) config.autoReview = toAutoReview(input.autoReview)
  return config
}

export type LoadOptions = {
  file: string
  // asked only when the config names no viewer; the server passes the gh login lookup
  viewerLogin: () => Promise<string>
}

// the config as stored: a missing file means the defaults; a present file is merged over
// them key by key; an empty viewer stays empty (GET /api/config shows it that way)
export const readConfig = async (file: string): Promise<Config> => {
  let stored: unknown = {}
  try {
    stored = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ConfigError(`cannot read ${file}: ${(error as Error).message}`)
    }
  }
  if (!isObject(stored)) throw new ConfigError(`${file} must hold a JSON object`)
  return validateConfig({ ...defaultConfig(), ...stored })
}

// the config in effect: readConfig with an empty viewer filled from the gh login
export const loadConfig = async ({ file, viewerLogin }: LoadOptions): Promise<Config> => {
  const config = await readConfig(file)
  if (config.viewer === '') config.viewer = (await viewerLogin()).trim()
  if (config.viewer === '') throw new ConfigError('no viewer configured and the gh login is empty')
  return config
}

// writes atomically through a temporary file next to the target
export const saveConfig = async (file: string, config: Config): Promise<Config> => {
  const valid = validateConfig(config)
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(valid, null, 2)}\n`, 'utf8')
  await rename(temp, file)
  return valid
}
