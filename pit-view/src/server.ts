// src/server.ts
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Stats } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openCache } from './cache.ts'
import type { Cache } from './cache.ts'
import { createClients, keepsSchedule } from './clients.ts'
import type { ClientState, Clients } from './clients.ts'
import { cacheFile, ConfigError, configFile, expandHome, readConfig, runnerNames, saveConfig, stateDir, tildePath, validateConfig } from './config.ts'
import type { Clock, Config, RunnerName } from './config.ts'
import { commandRunner, createGh, fetchViewerLogin } from './github.ts'
import type { Runner } from './github.ts'
import { createLauncher, defaultRun, LaunchError, procsFrom, systemFs, systemSpawn } from './launcher.ts'
import type { Kill, Launcher, LaunchErrorCode, LauncherFs, Procs, Spawn } from './launcher.ts'
import { createPoller, systemTimers } from './poller.ts'
import type { Patch, Poller, Timers } from './poller.ts'

export const defaultPort = 4791
// a named instance's port when PIT_VIEW_PORT is unset; any other name must set it
export const instancePorts: ReadonlyMap<string, number> = new Map([['', defaultPort], ['dev', 4792]])
export const instancePattern = /^[a-z][a-z0-9-]{0,31}$/
// loopback only, in every hosting mode
export const host = '127.0.0.1'

// what starting review runs needs from the outside world; main passes the real ones, and tests
// pass fakes, so no test ever starts a real runner
export type LaunchDeps = {
  spawn: Spawn
  fs: LauncherFs
  kill: Kill
  procs: Procs
  // git, for the clone check
  git: Runner
  // the environment the child's few variables are picked from
  env: Readonly<Record<string, string | undefined>>
  newSessionId: () => string
  pollMs?: number
  watchedPollMs?: number
  stopGraceMs?: number
}

export type ServerOptions = {
  home: string
  // 0 picks a free port (tests)
  port: number
  runner: Runner
  clock: Clock
  timers: Timers
  timeZone: string
  configPath: string
  cachePath: string
  // the instance's state folder: runs live in its runs/ folder
  stateDir: string
  publicDir: string
  launch: LaunchDeps
  // the per-start token the pages carry on run writes; random when left out
  token?: string
  log: (line: string) => void
  // '' for the default instance (the deployed app), or a name such as dev
  instance?: string
  keepaliveMs?: number
  pageSize?: number
}

export type PitServer = {
  port: number
  url: string
  poller: Poller
  clients: Clients
  cache: Cache
  launcher: Launcher
  // the token this start injected into its pages
  token: string
  // closes the streams, fails a running cycle, stops watching runs (which keep going), stops
  // listening and closes the cache
  close: () => Promise<void>
}

export class PortInUseError extends Error {
  override name = 'PortInUseError'
}

class HttpError extends Error {
  override name = 'HttpError'
  status: number
  constructor (status: number, message: string) {
    super(message)
    this.status = status
  }
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

const maxBody = 1024 * 1024

// JSON bodies only: the content type also makes a cross-origin write need a preflight, which fails
const readJson = async (req: IncomingMessage): Promise<unknown> => {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'send the body as application/json')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > maxBody) throw new HttpError(413, 'body too large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'body is not valid JSON')
  }
}

// a write that takes no body: one sent anyway must still be JSON, as every body must
const noBody = async (req: IncomingMessage): Promise<void> => {
  const length = Number(req.headers['content-length'] ?? 0)
  if (length > 0 || req.headers['transfer-encoding'] !== undefined) await readJson(req)
}

// a page reached through another name (DNS rebinding) is refused, whatever its address
const loopbackHosts = (port: number): Set<string> => new Set([`${host}:${port}`, `localhost:${port}`, `[::1]:${port}`])

// the Host header names the server: a loopback name with the server's port, or a host in
// config.allowedHosts (the name a reverse proxy passes through) with any port or none
export const hostAllowed = (header: string | undefined, port: number, allowed: readonly string[]): boolean => {
  if (header === undefined) return false
  const name = header.toLowerCase()
  if (loopbackHosts(port).has(name)) return true
  const match = /^([a-z0-9.-]+)(?::\d{1,5})?$/.exec(name)
  return match !== null && allowed.includes(match[1] ?? '')
}

// a write's Origin is the server's own page: a loopback origin with the server's port, or
// http or https on an allowed host, with any port or none
export const originAllowed = (origin: string, port: number, allowed: readonly string[]): boolean => {
  const value = origin.toLowerCase()
  if (value.startsWith('http://') && loopbackHosts(port).has(value.slice('http://'.length))) return true
  const match = /^https?:\/\/([a-z0-9.-]+)(?::\d{1,5})?$/.exec(value)
  return match !== null && allowed.includes(match[1] ?? '')
}

const clientIdPattern = /^[A-Za-z0-9_-]{1,100}$/

// the header a page sends its per-start token in, and the meta tag it reads it from
export const tokenHeader = 'x-pit-view-token'
export const tokenMeta = 'pit-view-token'

// a constant-time comparison, so the token cannot be guessed a character at a time
export const tokenMatches = (sent: string | string[] | undefined, token: string): boolean => {
  if (typeof sent !== 'string') return false
  const a = Buffer.from(sent)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

// the token goes into each served page at serve time and is never written to disk
export const injectToken = (html: string, token: string): string => {
  const tag = `<meta name="${tokenMeta}" content="${token}">\n`
  const at = html.search(/<\/head>/i)
  return at < 0 ? html : `${html.slice(0, at)}${tag}${html.slice(at)}`
}

// why a start or stop was refused, as an HTTP status
const launchStatus: Readonly<Record<LaunchErrorCode, number>> = {
  noClone: 422,
  notAClone: 422,
  identityMismatch: 422,
  identityUnknown: 502,
  busy: 409,
  unknownRun: 404,
  notRunning: 409,
}

const flag = (value: string | null, fallback: boolean): boolean => {
  if (value === null) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new HttpError(400, 'visible, paused and idle must be true or false')
}

const staticTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

// raster images only: an SVG opened directly could run script on this origin
const avatarTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
}

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR'
}

// the active gh account from gh's own config file; local, unlike gh api user
const localLogin = async (runner: Runner): Promise<string> => {
  try {
    const result = await runner(['config', 'get', 'user', '-h', 'github.com'])
    return result.code === 0 ? result.stdout.trim() : ''
  } catch {
    return ''
  }
}

const listen = (server: ReturnType<typeof createServer>, port: number): Promise<void> =>
  new Promise((resolveListen, rejectListen) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening)
      rejectListen(error.code === 'EADDRINUSE'
        ? new PortInUseError(`port ${port} on ${host} is already in use; is Pit View already running?`)
        : error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })

type Route = { method: string, pattern: RegExp, handle: (req: IncomingMessage, res: ServerResponse, url: URL, match: RegExpExecArray) => Promise<void> | void }

export const startServer = async (options: ServerOptions): Promise<PitServer> => {
  const { home, runner, clock, timers, log } = options
  const token = options.token ?? randomBytes(32).toString('base64url')
  const keepaliveMs = options.keepaliveMs ?? 30_000
  const publicDir = resolve(options.publicDir)
  const gh = createGh(runner)

  // the file as stored, and the gh login standing in for an empty viewer
  let stored = await readConfig(options.configPath)
  let ghLogin = stored.viewer === '' ? await localLogin(runner) : ''
  const effective = (): Config => ({ ...stored, viewer: stored.viewer === '' ? ghLogin : stored.viewer })

  // the port comes first: a second server must exit before it touches the running one's cache
  let dispatch: ((req: IncomingMessage, res: ServerResponse) => void) | null = null
  const server = createServer((req, res) => {
    if (dispatch === null) {
      json(res, 503, { error: 'starting' })
    } else {
      dispatch(req, res)
    }
  })
  await listen(server, options.port)
  const port = (server.address() as AddressInfo).port

  let cache: Cache
  try {
    cache = openCache({ path: options.cachePath, clock })
  } catch (error) {
    server.close()
    throw error
  }
  const clients = createClients()
  const streams = new Set<ServerResponse>()

  const broadcast = (patch: Patch): void => {
    const frame = `event: patch\ndata: ${JSON.stringify(patch)}\n\n`
    for (const stream of streams) stream.write(frame)
  }

  const poller = createPoller({
    cache,
    gh,
    clock,
    timers,
    config: effective,
    home,
    timeZone: options.timeZone,
    emit: broadcast,
    log,
    pageSize: options.pageSize,
    // only when gh's config named no account: asked at the first cycle, never at startup
    beforeCycle: async () => {
      if (effective().viewer === '') ghLogin = await fetchViewerLogin(gh)
    },
  })

  const launcher = createLauncher({
    cache,
    gh,
    git: options.launch.git,
    spawn: options.launch.spawn,
    fs: options.launch.fs,
    kill: options.launch.kill,
    procs: options.launch.procs,
    clock,
    timers,
    config: effective,
    home,
    stateDir: options.stateDir,
    env: options.launch.env,
    newSessionId: options.launch.newSessionId,
    onChange: (run) => poller.runChanged(run.repo, run.number),
    log,
    pollMs: options.launch.pollMs,
    watchedPollMs: options.launch.watchedPollMs,
    stopGraceMs: options.launch.stopGraceMs,
  })
  // runs that outlived the last server: watched again, or settled; local only, no GitHub call
  try {
    await launcher.recover()
  } catch (error) {
    log(`runs: recovery failed: ${messageOf(error)}`)
  }

  // one keepalive timer while any stream is open; local only, never a GitHub call
  let keepaliveTimer: unknown = null
  const keepalive = (): void => {
    for (const stream of streams) stream.write(': keepalive\n\n')
    keepaliveTimer = timers.set(keepalive, keepaliveMs)
  }
  const syncKeepalive = (): void => {
    if (streams.size > 0 && keepaliveTimer === null) keepaliveTimer = timers.set(keepalive, keepaliveMs)
    if (streams.size === 0 && keepaliveTimer !== null) {
      timers.clear(keepaliveTimer)
      keepaliveTimer = null
    }
  }

  const events = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    const id = url.searchParams.get('client') ?? ''
    if (!clientIdPattern.test(id)) throw new HttpError(400, 'client must be an id of letters, digits, - and _')
    const state: ClientState = {
      visible: flag(url.searchParams.get('visible'), true),
      paused: flag(url.searchParams.get('paused'), false),
      idle: flag(url.searchParams.get('idle'), false),
    }
    const lastUpdate = url.searchParams.get('lastUpdate')
    if (lastUpdate !== null && !Number.isFinite(Date.parse(lastUpdate))) throw new HttpError(400, 'lastUpdate must be an ISO 8601 time')
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // nothing between the page and the server may hold, cache or compress the stream
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    // each frame goes out as soon as it is written, through a proxy too
    req.socket.setNoDelay(true)
    // the first bytes flush the headers, so the page's EventSource opens before it fetches the view
    res.write(': connected\n\n')
    streams.add(res)
    syncKeepalive()
    const { connection, change } = clients.connect(id, state)
    req.on('close', () => {
      streams.delete(res)
      syncKeepalive()
      const left = clients.disconnect(id, connection)
      if (left !== null) poller.setActive(left.activeCount, false)
    })
    // a reload within the interval keeps the schedule rather than refreshing on arrival
    const keep = keepsSchedule(lastUpdate, clock.now(), effective().refreshSeconds)
    poller.setActive(change.activeCount, change.becameActive && !keep)
  }

  const updateClient = async (req: IncomingMessage, res: ServerResponse, id: string): Promise<void> => {
    if (!clientIdPattern.test(id)) throw new HttpError(400, 'client must be an id of letters, digits, - and _')
    const body = await readJson(req)
    const { visible, paused, idle = false } = (body ?? {}) as Record<string, unknown>
    // idle may be left out, as a page loaded before idle existed leaves it
    if (typeof visible !== 'boolean' || typeof paused !== 'boolean' || typeof idle !== 'boolean') {
      throw new HttpError(400, 'send { "visible": boolean, "paused": boolean, "idle": boolean }')
    }
    const change = clients.update(id, { visible, paused, idle })
    if (change === null) return json(res, 404, { error: 'no event stream is open for this client; reopen it' })
    const cycle = poller.setActive(change.activeCount, change.becameActive)
    json(res, 200, { active: change.active, cycle })
  }

  // one PR's row, fetched on its own; a deliberate one-shot like Refresh, so paused pages may ask
  const refreshPr = async (req: IncomingMessage, res: ServerResponse, raw: string): Promise<void> => {
    if (!/^[1-9]\d{0,8}$/.test(raw)) throw new HttpError(400, 'the PR number must be a positive integer')
    await noBody(req)
    json(res, 200, await poller.refreshPr(Number(raw)))
  }

  // run writes need the token from a page this start served, besides the Host and Origin checks
  const requireToken = (req: IncomingMessage): void => {
    if (!tokenMatches(req.headers[tokenHeader], token)) throw new HttpError(403, 'missing or wrong Pit View token; reload the page')
  }

  const prNumber = (raw: string): number => {
    if (!/^[1-9]\d{0,8}$/.test(raw)) throw new HttpError(400, 'the PR number must be a positive integer')
    return Number(raw)
  }

  const launchFailure = (error: unknown): never => {
    if (error instanceof LaunchError) throw new HttpError(launchStatus[error.code], error.message)
    throw error
  }

  // the row's default run (section 8 of DESIGN.md), with the configured runner or the one asked for
  const startRun = async (req: IncomingMessage, res: ServerResponse, raw: string): Promise<void> => {
    requireToken(req)
    const number = prNumber(raw)
    const length = Number(req.headers['content-length'] ?? 0)
    const body = length > 0 || req.headers['transfer-encoding'] !== undefined ? await readJson(req) : {}
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'send { "runner": "claude" | "codex" } or no body')
    const { runner: asked, ...rest } = body as Record<string, unknown>
    if (Object.keys(rest).length > 0) throw new HttpError(400, `unknown field ${Object.keys(rest)[0]}; send { "runner": "claude" | "codex" } or no body`)
    if (asked !== undefined && !runnerNames.includes(asked as RunnerName)) throw new HttpError(400, 'runner must be claude or codex')
    const config = effective()
    const cached = cache.readView(config.repo).open.find((row) => row.number === number)
    if (cached === undefined) throw new HttpError(422, `#${number} is not an open PR in ${config.repo} that Pit View has fetched`)
    const plan = defaultRun(cached.pr, config)
    try {
      const run = await launcher.start({
        repo: config.repo,
        number,
        command: plan.command,
        args: plan.args,
        label: plan.label,
        ...(asked === undefined ? {} : { runner: asked as RunnerName }),
      })
      json(res, 200, run)
    } catch (error) {
      launchFailure(error)
    }
  }

  const stopRun = async (req: IncomingMessage, res: ServerResponse, raw: string): Promise<void> => {
    requireToken(req)
    if (!/^[1-9]\d{0,9}$/.test(raw)) throw new HttpError(400, 'the run id must be a positive integer')
    await noBody(req)
    try {
      json(res, 200, launcher.stop(Number(raw)))
    } catch (error) {
      launchFailure(error)
    }
  }

  const putConfig = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJson(req)
    let saved: Config
    try {
      saved = await saveConfig(options.configPath, validateConfig(body))
    } catch (error) {
      if (error instanceof ConfigError) return json(res, 400, { error: error.message })
      throw error
    }
    const before = effective()
    stored = saved
    if (stored.viewer === '' && ghLogin === '') ghLogin = await localLogin(runner)
    await poller.configChanged(before)
    json(res, 200, saved)
  }

  // logins seen in cached PRs (authors and reviewers) that config.people does not list; the
  // viewer always shows as You, so is never suggested
  const suggestions = (): { login: string, avatarUrl: string, count: number }[] => {
    const config = effective()
    const listed = new Set([...config.people.map((person) => person.login.toLowerCase()), config.viewer.toLowerCase()])
    const seen = new Map<string, { login: string, avatarUrl: string, count: number }>()
    const add = (login: string | null | undefined, avatarUrl: string | null | undefined): void => {
      if (login == null || login === '' || listed.has(login.toLowerCase())) return
      const key = login.toLowerCase()
      const entry = seen.get(key) ?? { login, avatarUrl: avatarUrl ?? `https://github.com/${encodeURIComponent(login)}.png`, count: 0 }
      if (avatarUrl != null) entry.avatarUrl = avatarUrl
      entry.count += 1
      seen.set(key, entry)
    }
    const cached = cache.readView(config.repo)
    for (const { pr } of cached.open) {
      const logins = new Map<string, string | null>([[pr.author?.login ?? '', pr.author?.avatarUrl ?? null]])
      for (const review of pr.latestReviews.nodes) {
        if (review.author !== null && !logins.has(review.author.login)) logins.set(review.author.login, null)
      }
      for (const { requestedReviewer } of pr.reviewRequests.nodes) {
        if (requestedReviewer !== null && requestedReviewer.__typename !== 'Team' && !logins.has(requestedReviewer.login)) logins.set(requestedReviewer.login, null)
      }
      for (const [login, avatarUrl] of logins) add(login, avatarUrl)
    }
    for (const pr of cached.closed?.result.prs ?? []) add(pr.author?.login, pr.author?.avatarUrl)
    return [...seen.values()].sort((a, b) => b.count - a.count || a.login.localeCompare(b.login))
  }

  // a person's local avatar image, read from the configured path under ~ and nowhere else
  const avatar = async (res: ServerResponse, encoded: string): Promise<void> => {
    let login: string
    try {
      login = decodeURIComponent(encoded)
    } catch {
      throw new HttpError(400, 'bad login')
    }
    const person = effective().people.find((entry) => entry.login.toLowerCase() === login.toLowerCase())
    if (person === undefined || !person.avatar.startsWith('~/')) throw new HttpError(404, 'no local avatar for this login')
    const root = resolve(home)
    const file = resolve(expandHome(person.avatar, home))
    const type = avatarTypes[extname(file).toLowerCase()]
    if (!file.startsWith(`${root}${sep}`) || type === undefined) throw new HttpError(404, 'the avatar must be a PNG, JPEG, GIF, WebP or AVIF image under ~')
    let data: Buffer
    try {
      data = await readFile(file)
    } catch (error) {
      if (isMissing(error)) throw new HttpError(404, 'avatar file not found')
      throw error
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' })
    res.end(data)
  }

  // public/*.ts goes out as JavaScript through type stripping, kept per file until it changes
  const stripped = new Map<string, { mtimeMs: number, code: string }>()

  const serveStatic = async (res: ServerResponse, pathname: string): Promise<void> => {
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      throw new HttpError(400, 'bad path')
    }
    const segments = (decoded.endsWith('/') ? `${decoded}index.html` : decoded).split('/').filter((segment) => segment !== '')
    // dot segments cover both hidden files and ..
    if (segments.some((segment) => segment.startsWith('.') || segment.includes('\\') || segment.includes('\0'))) throw new HttpError(404, 'not found')
    const file = join(publicDir, ...segments)
    if (!file.startsWith(`${publicDir}${sep}`)) throw new HttpError(404, 'not found')
    let info: Stats
    try {
      info = await stat(file)
    } catch (error) {
      if (isMissing(error)) throw new HttpError(404, 'not found')
      throw error
    }
    if (!info.isFile()) throw new HttpError(404, 'not found')
    const extension = extname(file).toLowerCase()
    let body: Buffer | string
    if (extension === '.html') {
      body = injectToken(await readFile(file, 'utf8'), token)
    } else if (extension === '.ts') {
      const hit = stripped.get(file)
      if (hit !== undefined && hit.mtimeMs === info.mtimeMs) {
        body = hit.code
      } else {
        const source = await readFile(file, 'utf8')
        try {
          body = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: `/${segments.join('/')}` })
        } catch (error) {
          throw new HttpError(500, `cannot strip types from ${segments.join('/')}: ${messageOf(error)}`)
        }
        stripped.set(file, { mtimeMs: info.mtimeMs, code: body })
      }
    } else {
      body = await readFile(file)
    }
    res.writeHead(200, {
      'Content-Type': staticTypes[extension] ?? 'application/octet-stream',
      'Content-Length': Buffer.byteLength(body),
      // a page carries this start's token, so a stored copy would be stale after a restart
      'Cache-Control': extension === '.html' ? 'no-store' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(body)
  }

  const routes: Route[] = [
    { method: 'GET', pattern: /^\/api\/view$/, handle: async (_req, res) => json(res, 200, await poller.view()) },
    { method: 'GET', pattern: /^\/api\/events$/, handle: (req, res, url) => events(req, res, url) },
    { method: 'POST', pattern: /^\/api\/clients\/([^/]+)$/, handle: (req, res, _url, match) => updateClient(req, res, match[1] ?? '') },
    { method: 'POST', pattern: /^\/api\/refresh$/, handle: (_req, res) => json(res, 200, poller.refresh('manual')) },
    { method: 'POST', pattern: /^\/api\/prs\/([^/]+)\/refresh$/, handle: (req, res, _url, match) => refreshPr(req, res, match[1] ?? '') },
    { method: 'POST', pattern: /^\/api\/prs\/([^/]+)\/runs$/, handle: (req, res, _url, match) => startRun(req, res, match[1] ?? '') },
    { method: 'GET', pattern: /^\/api\/prs\/([^/]+)\/runs$/, handle: (_req, res, _url, match) => json(res, 200, cache.runsFor(effective().repo, prNumber(match[1] ?? ''))) },
    { method: 'POST', pattern: /^\/api\/runs\/([^/]+)\/stop$/, handle: (req, res, _url, match) => stopRun(req, res, match[1] ?? '') },
    { method: 'GET', pattern: /^\/api\/instance$/, handle: (_req, res) => json(res, 200, { name: options.instance ?? '', configPath: tildePath(options.configPath, home), pid: process.pid }) },
    { method: 'GET', pattern: /^\/api\/config$/, handle: (_req, res) => json(res, 200, stored) },
    { method: 'PUT', pattern: /^\/api\/config$/, handle: (req, res) => putConfig(req, res) },
    { method: 'GET', pattern: /^\/api\/people\/suggestions$/, handle: (_req, res) => json(res, 200, suggestions()) },
    { method: 'GET', pattern: /^\/api\/avatar\/([^/]+)$/, handle: (_req, res, _url, match) => avatar(res, match[1] ?? '') },
    { method: 'GET', pattern: /^\/(?!api(?:\/|$))/, handle: (_req, res, url) => serveStatic(res, url.pathname) },
  ]

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const allowed = stored.allowedHosts
    if (!hostAllowed(req.headers.host, port, allowed)) throw new HttpError(403, 'unknown host; open Pit View at its loopback address or a host in allowedHosts')
    const method = req.method ?? 'GET'
    const origin = req.headers.origin
    // writes from another site's page are refused; the page's own requests carry its origin or none
    if (method !== 'GET' && origin !== undefined && !originAllowed(origin, port, allowed)) {
      throw new HttpError(403, 'cross-origin request refused')
    }
    const url = new URL(req.url ?? '/', `http://${host}:${port}`)
    const matching = routes.filter((route) => route.pattern.test(url.pathname))
    if (matching.length === 0) throw new HttpError(404, 'not found')
    const route = matching.find((candidate) => candidate.method === method)
    if (route === undefined) {
      res.setHeader('Allow', matching.map((candidate) => candidate.method).join(', '))
      throw new HttpError(405, 'method not allowed')
    }
    await route.handle(req, res, url, route.pattern.exec(url.pathname) as RegExpExecArray)
  }

  dispatch = (req, res) => {
    handle(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500
      if (status === 500) log(`${req.method} ${req.url}: ${messageOf(error)}`)
      if (res.headersSent) {
        res.end()
      } else {
        json(res, status, { error: error instanceof HttpError ? error.message : 'internal error' })
      }
    })
  }

  const close = async (): Promise<void> => {
    poller.stop()
    launcher.close()
    for (const stream of streams) stream.end()
    streams.clear()
    syncKeepalive()
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose())
      server.closeAllConnections()
    })
    cache.close()
  }

  return { port, url: `http://${host}:${port}`, poller, clients, cache, launcher, token, close }
}

export type Runtime = { instance: string, port: number, configPath: string, cachePath: string, stateDir: string }

// PIT_VIEW_INSTANCE picks the instance (unset for the app, dev for development) and with it the
// config and state folders and the default port; PIT_VIEW_PORT still overrides the port
export const resolveRuntime = (env: Record<string, string | undefined>, home: string): Runtime => {
  const instance = env.PIT_VIEW_INSTANCE ?? ''
  if (instance !== '' && !instancePattern.test(instance)) {
    throw new Error(`PIT_VIEW_INSTANCE must be lowercase letters, digits and -, starting with a letter, got ${instance}`)
  }
  const value = env.PIT_VIEW_PORT ?? ''
  let port = instancePorts.get(instance)
  if (value !== '') {
    port = Number(value)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PIT_VIEW_PORT must be a port number, got ${value}`)
  }
  if (port === undefined) throw new Error(`PIT_VIEW_INSTANCE=${instance} has no default port; set PIT_VIEW_PORT too`)
  return { instance, port, configPath: configFile(home, instance), cachePath: cacheFile(home, instance), stateDir: stateDir(home, instance) }
}

// the real defaults, resolved here and nowhere else; no path depends on the working directory
export const main = async (): Promise<void> => {
  const home = homedir()
  const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`)
  let runtime: Runtime
  let server: PitServer
  try {
    runtime = resolveRuntime(process.env, home)
    server = await startServer({
      home,
      instance: runtime.instance,
      port: runtime.port,
      runner: commandRunner('gh'),
      clock: { now: () => Date.now() },
      timers: systemTimers,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      configPath: runtime.configPath,
      cachePath: runtime.cachePath,
      stateDir: runtime.stateDir,
      publicDir: fileURLToPath(new URL('../public', import.meta.url)),
      launch: {
        spawn: systemSpawn,
        fs: systemFs,
        kill: (pid, signal) => process.kill(pid, signal),
        procs: procsFrom(commandRunner('ps')),
        git: commandRunner('git'),
        // under the launch agent, PATH is the one captured at install
        env: process.env,
        newSessionId: randomUUID,
      },
      log,
    })
  } catch (error) {
    console.error(`pit-view: ${messageOf(error)}`)
    process.exit(1)
  }
  const named = runtime.instance === '' ? '' : ` (instance ${runtime.instance}, config ${tildePath(runtime.configPath, home)})`
  log(`Pit View listening on ${server.url}${named}`)
  const shutdown = (signal: string): void => {
    log(`${signal}: shutting down`)
    server.close().then(() => process.exit(0), (error: unknown) => {
      console.error(`pit-view: ${messageOf(error)}`)
      process.exit(1)
    })
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
}

if (import.meta.main) await main()
