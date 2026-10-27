// scripts/service.ts
// pnpm service:install, service:uninstall, service:status and service:restart: the launchd user
// agent that keeps the deployed app (the default instance) running from login
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { stateDir, tildePath } from '../src/config.ts'
import { commandRunner } from '../src/github.ts'
import type { Runner } from '../src/github.ts'
import { defaultPort, host } from '../src/server.ts'

export const label = 'com.mickey.pit-view'
// the app clone runs this branch; a development checkout never becomes the service
export const deployBranch = 'master'

export const templateFile = (appDir: string): string => join(appDir, 'deploy', `${label}.plist`)
export const plistFile = (home: string): string => join(home, 'Library', 'LaunchAgents', `${label}.plist`)
export const logFiles = (home: string): { out: string, err: string } => ({
  out: join(stateDir(home), 'server.log'),
  err: join(stateDir(home), 'server.err.log'),
})

export class ServiceError extends Error {
  override name = 'ServiceError'
}

export type PlistValues = { home: string, appDir: string, node: string, path: string }

const placeholders: ReadonlyMap<string, keyof PlistValues> = new Map([
  ['__HOME__', 'home'],
  ['__APP_DIR__', 'appDir'],
  ['__NODE__', 'node'],
  ['__PATH__', 'path'],
])

const xmlEscape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// fills every placeholder in the committed template; an unknown one, or a value that is not an
// absolute path, is refused rather than written into a plist launchd would misread
export const renderPlist = (template: string, values: PlistValues): string => {
  for (const key of ['home', 'appDir', 'node'] as const) {
    if (!isAbsolute(values[key])) throw new ServiceError(`${key} must be an absolute path, got ${values[key]}`)
  }
  if (values.path === '') throw new ServiceError('path must not be empty')
  return template.replace(/__[A-Z_]+__/g, (token) => {
    const key = placeholders.get(token)
    if (key === undefined) throw new ServiceError(`the template holds an unknown placeholder ${token}`)
    return xmlEscape(values[key])
  })
}

// the installing shell's PATH without what pnpm adds for its scripts, with Node's own folder first
export const servicePath = (envPath: string, nodeDir: string): string => {
  const kept = envPath.split(delimiter).filter((entry) =>
    isAbsolute(entry) && !entry.split('/').includes('node_modules') && !entry.endsWith('/node-gyp-bin'))
  return [...new Set([nodeDir, ...kept])].join(delimiter)
}

export type AgentState = { loaded: boolean, state: string | null, pid: number | null, lastExit: string | null }

// the few fields of launchctl print that matter here
export const parseLaunchctlPrint = (code: number, text: string): AgentState => {
  if (code !== 0) return { loaded: false, state: null, pid: null, lastExit: null }
  const field = (name: string): string | null => new RegExp(`^\\s*${name} = (.+)$`, 'm').exec(text)?.[1]?.trim() ?? null
  const pid = field('pid')
  return { loaded: true, state: field('state'), pid: pid === null ? null : Number(pid), lastExit: field('last exit code') }
}

// what answered on the app's port: the instance's name ('' for the default) and its process
export type Answer = { name: string, pid: number }

export type ServiceDeps = {
  home: string
  // the pit-view folder of the checkout running this script
  appDir: string
  // the Node binary running this script; the plist pins it
  node: string
  envPath: string
  uid: number
  launchctl: Runner
  git: Runner
  probe: () => Promise<Answer | null>
  sleep: (ms: number) => Promise<void>
  log: (line: string) => void
}

const domain = (deps: ServiceDeps): string => `gui/${deps.uid}`
const target = (deps: ServiceDeps): string => `${domain(deps)}/${label}`
const appUrl = `http://${host}:${defaultPort}`

const agentState = async (deps: ServiceDeps): Promise<AgentState> => {
  const result = await deps.launchctl(['print', target(deps)])
  return parseLaunchctlPrint(result.code, result.stdout)
}

const exists = async (file: string): Promise<boolean> => {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

// bootout returns before launchd has finished tearing the job down, so wait until it is gone
const stopAgent = async (deps: ServiceDeps): Promise<boolean> => {
  if (!(await agentState(deps)).loaded) return false
  await deps.launchctl(['bootout', target(deps)])
  for (let tries = 0; tries < 20; tries += 1) {
    if (!(await agentState(deps)).loaded) return true
    await deps.sleep(500)
  }
  throw new ServiceError(`${label} is still loaded after bootout; try again, or run launchctl bootout ${target(deps)}`)
}

// the agent's own process answering as the default instance, waited for after a start
const awaitAnswer = async (deps: ServiceDeps): Promise<void> => {
  for (let tries = 0; tries < 15; tries += 1) {
    await deps.sleep(1_000)
    const agent = await agentState(deps)
    const answer = await deps.probe()
    if (agent.pid !== null && answer !== null && answer.pid === agent.pid && answer.name === '') {
      deps.log(`${appUrl} answers from the agent (pid ${agent.pid})`)
      return
    }
  }
  throw new ServiceError(`${label} is loaded but ${appUrl} did not answer from it; see ${tildePath(logFiles(deps.home).err, deps.home)} and pnpm service:status`)
}

export const install = async (deps: ServiceDeps): Promise<void> => {
  const branch = await deps.git(['-C', deps.appDir, 'rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch.code !== 0) throw new ServiceError(`${deps.appDir} is not a git checkout; install from the app clone (deploy/README.md)`)
  const name = branch.stdout.trim()
  if (name !== deployBranch) {
    throw new ServiceError(`the service runs the app clone on ${deployBranch}, and this checkout is on ${name}; install from the app clone (deploy/README.md), and use pnpm dev here`)
  }
  const plist = renderPlist(await readFile(templateFile(deps.appDir), 'utf8'), {
    home: deps.home,
    appDir: deps.appDir,
    node: deps.node,
    path: servicePath(deps.envPath, dirname(deps.node)),
  })
  // launchd opens the log files but does not create their folder
  await mkdir(stateDir(deps.home), { recursive: true })
  await mkdir(dirname(plistFile(deps.home)), { recursive: true })
  if (await stopAgent(deps)) deps.log(`stopped the earlier ${label}`)
  await writeFile(plistFile(deps.home), plist, 'utf8')
  deps.log(`wrote ${tildePath(plistFile(deps.home), deps.home)} (node ${deps.node}, app ${tildePath(deps.appDir, deps.home)})`)
  // the same teardown race can still fail a bootstrap, so retry it; a job loaded anyway counts
  let loaded = false
  for (let tries = 0; tries < 5 && !loaded; tries += 1) {
    if (tries > 0) await deps.sleep(1_000)
    const result = await deps.launchctl(['bootstrap', domain(deps), plistFile(deps.home)])
    loaded = result.code === 0 || (await agentState(deps)).loaded
  }
  if (!loaded) throw new ServiceError(`could not bootstrap ${label} into ${domain(deps)}; the service is not running`)
  deps.log(`loaded ${label}`)
  await awaitAnswer(deps)
}

export const uninstall = async (deps: ServiceDeps): Promise<void> => {
  deps.log(await stopAgent(deps) ? `stopped and unloaded ${label}` : `${label} was not loaded`)
  const file = plistFile(deps.home)
  if (await exists(file)) {
    await rm(file)
    deps.log(`removed ${tildePath(file, deps.home)}`)
  }
}

export const restart = async (deps: ServiceDeps): Promise<void> => {
  if (!(await agentState(deps)).loaded) throw new ServiceError(`${label} is not loaded; run pnpm service:install`)
  await deps.launchctl(['kickstart', '-k', target(deps)])
  deps.log(`restarted ${label}`)
  await awaitAnswer(deps)
}

// true when the agent is running and its own process answers as the default instance
export const status = async (deps: ServiceDeps): Promise<boolean> => {
  const file = plistFile(deps.home)
  const agent = await agentState(deps)
  const answer = await deps.probe()
  const logs = logFiles(deps.home)
  deps.log(`plist: ${tildePath(file, deps.home)} ${await exists(file) ? 'installed' : 'not installed'}`)
  if (!agent.loaded) deps.log(`agent: ${label} is not loaded`)
  else if (agent.pid === null) deps.log(`agent: loaded, ${agent.state ?? 'not running'}${agent.lastExit === null ? '' : `, last exit code ${agent.lastExit}`}`)
  else deps.log(`agent: loaded, ${agent.state ?? 'running'}, pid ${agent.pid}`)
  if (answer === null) deps.log(`server: ${appUrl} does not answer`)
  else if (answer.name !== '') deps.log(`server: ${appUrl} answers as the ${answer.name} instance (pid ${answer.pid}), not the app`)
  else if (answer.pid !== agent.pid) deps.log(`server: ${appUrl} answers from pid ${answer.pid}, not the agent; is a manual pnpm start running?`)
  else deps.log(`server: ${appUrl} answers from the agent`)
  deps.log(`logs: ${tildePath(logs.out, deps.home)}, ${tildePath(logs.err, deps.home)}`)
  return agent.loaded && answer !== null && answer.name === '' && answer.pid === agent.pid
}

const probeApp = async (): Promise<Answer | null> => {
  try {
    const response = await fetch(`${appUrl}/api/instance`, { signal: AbortSignal.timeout(2_000) })
    if (!response.ok) return null
    const body = await response.json() as Partial<Answer>
    return typeof body.name === 'string' && typeof body.pid === 'number' ? { name: body.name, pid: body.pid } : null
  } catch {
    return null
  }
}

const commands: Record<string, (deps: ServiceDeps) => Promise<boolean | void>> = { install, uninstall, status, restart }

export const main = async (argv: string[]): Promise<void> => {
  const command = argv[0] ?? ''
  const run = Object.hasOwn(commands, command) ? commands[command] : undefined
  if (run === undefined || argv.length !== 1) {
    console.error('usage: node scripts/service.ts install | uninstall | status | restart')
    process.exit(2)
  }
  if (process.platform !== 'darwin' || process.getuid === undefined) {
    console.error('pit-view service: launchd agents need macOS')
    process.exit(1)
  }
  const deps: ServiceDeps = {
    home: homedir(),
    appDir: dirname(dirname(fileURLToPath(import.meta.url))),
    node: process.execPath,
    envPath: process.env.PATH ?? '',
    uid: process.getuid(),
    launchctl: commandRunner('launchctl'),
    git: commandRunner('git'),
    probe: probeApp,
    sleep: (ms) => delay(ms),
    log: (line) => console.log(line),
  }
  try {
    process.exit(await run(deps) === false ? 1 : 0)
  } catch (error) {
    console.error(`pit-view service: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

if (import.meta.main) await main(process.argv.slice(2))
