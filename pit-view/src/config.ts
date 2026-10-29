// src/config.ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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

// the agents Pit View can drive for a review session (section 8 of DESIGN.md, Launching runs)
export type RunnerName = 'claude' | 'codex'
export const runnerNames: readonly RunnerName[] = ['claude', 'codex']

export const defaultClaudeModel = 'sonnet'

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
  showAgentColumn: boolean
  // host names a reverse proxy may reach the server by, besides its loopback names
  allowedHosts: string[]
  // the owner's local clone of repo, stored with ~; manual runs work in it. Whether it is a
  // clone of repo is checked when a run starts, not on save
  cloneDir?: string
  agent: AgentSettings
  notifications?: Notifications
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
  showAgentColumn: false,
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

const onlyKeys = (obj: Record<string, unknown>, allowed: readonly string[], where: string): void => {
  const extra = Object.keys(obj).find((key) => !allowed.includes(key))
  if (extra !== undefined) fail(`${where}.${extra} is not a known setting`)
}

const personKeys = ['login', 'alias', 'initials', 'color', 'avatar'] as const
const ticketKeys = ['enabled', 'kind', 'name', 'source', 'pattern', 'baseUrl', 'linkTemplate'] as const
const configKeys = [
  'repo', 'viewer', 'people', 'tickets', 'refreshSeconds', 'idleMinutes', 'todayStartsAt',
  'bots', 'reportsDir', 'density', 'showAgentColumn', 'allowedHosts', 'cloneDir', 'agent', 'notifications',
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
    showAgentColumn: bool(input, 'showAgentColumn', 'config'),
    allowedHosts: toAllowedHosts(list(input, 'allowedHosts', 'config')),
    // absent and empty both mean unset, and an unset cloneDir is left out of the file
    ...(cloneDir === undefined ? {} : { cloneDir }),
    agent: toAgent(input.agent),
  }
  if (input.notifications !== undefined) config.notifications = toNotifications(input.notifications)
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
