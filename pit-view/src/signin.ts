// src/signin.ts
// sign-in through the reverse proxy (section 3 of DESIGN.md, Hosting, Sign-in behind the proxy): GitHub's OAuth web flow, admitting only the configured viewer, with the session in a signed cookie
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import type { IncomingHttpHeaders } from 'node:http'
import { join } from 'node:path'
import type { Clock } from './config.ts'
import { tildePath } from './config.ts'

// how long a session lasts from its sign-in; change it here, and nowhere else
export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
// how long a sign-in may take between leaving for GitHub and coming back
export const STATE_LIFETIME_MS = 10 * 60 * 1000
// how long Pit View waits for each of GitHub's two answers in a sign-in
export const GITHUB_DEADLINE_MS = 10_000

// __Host- cookies are Secure, host-only, and Path=/, so no other host, subdomains included, can set or overwrite them
export const sessionCookieName = '__Host-pit-view-session'
export const stateCookieName = '__Host-pit-view-state'

// both live in the instance's config folder, beside config.json and never in it
export const oauthFileName = 'oauth.json'
export const keyFileName = 'session.key'
// the revocation marker, in the instance's state folder rather than the config folder, so a config folder that cannot be written does not also leave it unwritable: its presence means a new signing key was owed and could not be written, so the old one is not trusted
export const revokedFileName = 'session.revoked'

export type OAuthEndpoints = { web: string, api: string }
export const githubEndpoints: OAuthEndpoints = { web: 'https://github.com', api: 'https://api.github.com' }

// the names the server answers to on loopback, each with the server's port
export const loopbackNames: readonly string[] = ['127.0.0.1', 'localhost', '[::1]']

// a header a proxy adds: any X-Forwarded-*, Via, or the standard Forwarded
const forwardingHeader = (name: string): boolean => name.startsWith('x-forwarded-') || name === 'via' || name === 'forwarded'

// open without sign-in only for a loopback Host and no sign of a proxy: the proxy runs on this machine and forwards to 127.0.0.1, so the source address cannot tell the two apart
export const openLoopback = (headers: IncomingHttpHeaders, port: number): boolean => {
  const host = (headers.host ?? '').toLowerCase()
  if (!loopbackNames.some((name) => host === `${name}:${port}`)) return false
  return !Object.keys(headers).some((name) => forwardingHeader(name.toLowerCase()))
}

export type SignInFiles = { clientId: string, clientSecret: string, key: Buffer }
export type SignInState = { open: true, files: SignInFiles } | { open: false, reason: string }

// reads one of the two files only when it is the owner's own plain file of mode 0600 or stricter, read through the descriptor that was checked, so the check and the read are of the same file
const readGuarded = async (path: string, shown: string): Promise<{ text: string } | { missing: true } | { problem: string }> => {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { missing: true }
    if (code === 'ELOOP') return { problem: `${shown} is a symbolic link; it must be the file itself` }
    return { problem: `${shown} cannot be read (${code ?? 'error'})` }
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) return { problem: `${shown} is not a plain file` }
    const uid = process.getuid?.()
    if (uid !== undefined && info.uid !== uid) return { problem: `${shown} belongs to another user` }
    const mode = info.mode & 0o777
    if ((mode & ~0o600) !== 0) return { problem: `${shown} has mode ${mode.toString(8).padStart(4, '0')}; it must be 0600 (chmod 600 ${shown})` }
    return { text: await handle.readFile('utf8') }
  } finally {
    await handle.close()
  }
}

const parseOAuth = (text: string, shown: string): { clientId: string, clientSecret: string } | string => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return `${shown} is not valid JSON`
  }
  const usage = `${shown} must be { "clientId": "...", "clientSecret": "..." } and nothing else`
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return usage
  const { clientId, clientSecret, ...rest } = value as Record<string, unknown>
  if (Object.keys(rest).length > 0) return usage
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(clientId)) return usage
  if (typeof clientSecret !== 'string' || !/^\S{1,200}$/.test(clientSecret)) return usage
  return { clientId, clientSecret }
}

const keyBytes = 32

const parseKey = (text: string): Buffer | null => {
  const trimmed = text.trim()
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return null
  const key = Buffer.from(trimmed, 'base64url')
  return key.length >= keyBytes ? key : null
}

// a new key, written to a fresh file of mode 0600 and then moved into place, so a reader sees the old key or the new one and never a part
export const writeKey = async (path: string): Promise<void> => {
  const temporary = `${path}.${randomBytes(6).toString('hex')}`
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    await handle.writeFile(`${randomBytes(keyBytes).toString('base64url')}\n`)
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

const sign = (key: Buffer, purpose: string, text: string): Buffer => createHmac('sha256', key).update(`${purpose}\n${text}`).digest()

// the signature as sent must be the exact base64url of the one computed, compared in constant time; Node's lenient decoding is not trusted to reject stray characters
const signatureMatches = (sent: string, expected: Buffer): boolean => {
  const bytes = Buffer.from(sent, 'base64url')
  if (bytes.toString('base64url') !== sent || bytes.length !== expected.length) return false
  return timingSafeEqual(bytes, expected)
}

const sameText = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

// every value of a cookie name, so a name sent twice can be refused rather than guessed at
export const cookieValues = (header: string | undefined, name: string): string[] =>
  (header ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`)).map((part) => part.slice(name.length + 1))

const onlyCookie = (header: string | undefined, name: string): string | null => {
  const values = cookieValues(header, name)
  return values.length === 1 ? values[0] ?? null : null
}

export const setCookie = (name: string, value: string, maxAgeMs: number, sameSite: 'Strict' | 'Lax'): string =>
  `${name}=${value}; Max-Age=${Math.floor(maxAgeMs / 1000)}; Path=/; HttpOnly; Secure; SameSite=${sameSite}`

export const clearCookie = (name: string, sameSite: 'Strict' | 'Lax'): string => setCookie(name, '', 0, sameSite)

// a session is v1.<payload>.<signature>; the payload names the login and when it signed in, and its lifetime is read from the constant at every check, never from the cookie
export const mintSession = (key: Buffer, login: string, now: number): string => {
  const payload = Buffer.from(JSON.stringify({ login, issuedAt: now, nonce: randomBytes(16).toString('base64url') })).toString('base64url')
  return `v1.${payload}.${sign(key, 'session', `v1.${payload}`).toString('base64url')}`
}

// the login a session cookie value stands for, or null when it is not signed with this key, has expired, or is not the viewer's
export const verifySession = (key: Buffer, value: string, now: number, viewer: string): string | null => {
  const parts = value.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return null
  const [, payload = '', signature = ''] = parts
  if (!signatureMatches(signature, sign(key, 'session', `v1.${payload}`))) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const { login, issuedAt } = (parsed ?? {}) as Record<string, unknown>
  if (typeof login !== 'string' || typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) return null
  if (issuedAt > now || now >= issuedAt + SESSION_LIFETIME_MS) return null
  if (viewer === '' || login.toLowerCase() !== viewer.toLowerCase()) return null
  return login
}

// the state cookie is <state>.<issued>.<signature>, so only a sign-in this server started can come back
const mintState = (key: Buffer, state: string, now: number): string => `${state}.${now}.${sign(key, 'state', `${state}.${now}`).toString('base64url')}`

const verifyState = (key: Buffer, value: string, sent: string, now: number): boolean => {
  const parts = value.split('.')
  if (parts.length !== 3) return false
  const [state = '', issued = '', signature = ''] = parts
  if (!/^\d{1,16}$/.test(issued) || !signatureMatches(signature, sign(key, 'state', `${state}.${issued}`))) return false
  const at = Number(issued)
  if (at > now || now >= at + STATE_LIFETIME_MS) return false
  return sent !== '' && sameText(state, sent)
}

export type SignInDeps = {
  // the instance's config folder, which holds oauth.json and session.key
  dir: string
  // the instance's state folder, which holds the revocation marker
  stateDir: string
  // how a new signing key is written; only a test replaces it
  writeKey?: (path: string) => Promise<void>
  home: string
  clock: Clock
  endpoints: OAuthEndpoints
  log: (line: string) => void
  fetch?: typeof fetch
  deadlineMs?: number
}

export type CallbackOutcome =
  | { kind: 'signedIn', login: string, cookie: string }
  | { kind: 'refused', status: number, message: string }

export type SignIn = {
  // the files as they are now, checked again at every call
  state: () => Promise<SignInState>
  // the login of a good session in the request's cookies, or null
  session: (cookieHeader: string | undefined, viewer: string) => Promise<string | null>
  // where to send the browser to sign in, and the state cookie to set; the reason when sign-in is closed
  begin: (redirectUri: string) => Promise<{ location: string, cookie: string } | { reason: string }>
  finish: (cookieHeader: string | undefined, query: URLSearchParams, redirectUri: string, viewer: string) => Promise<CallbackOutcome>
  // a new signing key, which ends every session; when it cannot be written it says why, and sign-in stays closed, across a restart too, until a new key can be written, so no old session comes back
  rotate: (why: string) => Promise<{ ok: true } | { ok: false, reason: string }>
}

export class SignInError extends Error {
  override name = 'SignInError'
}

export const createSignIn = (deps: SignInDeps): SignIn => {
  const oauthPath = join(deps.dir, oauthFileName)
  const keyPath = join(deps.dir, keyFileName)
  const shown = (path: string): string => tildePath(path, deps.home)
  const request = deps.fetch ?? fetch
  const deadlineMs = deps.deadlineMs ?? GITHUB_DEADLINE_MS
  // logged when it changes, not at every request
  let lastReason: string | null = null
  const markerPath = join(deps.stateDir, revokedFileName)
  const makeKey = deps.writeKey ?? writeKey
  // set when a new key could not be written, which would otherwise leave the sessions it was to end in force; the marker file carries it across a restart, and this covers a marker that could not be written
  let owed = false
  // one recovery at a time
  let recovering: Promise<string | null> | null = null

  const closed = (reason: string): SignInState => {
    if (reason !== lastReason) deps.log(`sign-in: the proxied host is closed: ${reason}`)
    lastReason = reason
    return { open: false, reason }
  }

  const readKey = async (): Promise<Buffer | string> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const read = await readGuarded(keyPath, shown(keyPath))
      if ('problem' in read) return read.problem
      if ('text' in read) return parseKey(read.text) ?? `${shown(keyPath)} does not hold a key; delete it, and Pit View makes a new one`
      try {
        await makeKey(keyPath)
        deps.log(`sign-in: made a new signing key in ${shown(keyPath)}`)
      } catch (error) {
        return `${shown(keyPath)} cannot be written (${(error as NodeJS.ErrnoException).code ?? 'error'})`
      }
    }
    return `${shown(keyPath)} cannot be read`
  }

  // anything at the marker's path counts, and so does a path that cannot be examined: the doubt is not resolved in favor of the old key
  const markerPresent = async (): Promise<boolean> => {
    try {
      await lstat(markerPath)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ENOENT'
    }
  }

  const writeMarker = async (): Promise<void> => {
    try {
      await mkdir(deps.stateDir, { recursive: true, mode: 0o700 })
      const handle = await open(markerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
      await handle.close()
    } catch (error) {
      deps.log(`sign-in: the revocation marker ${shown(markerPath)} could not be written (${(error as NodeJS.ErrnoException).code ?? 'error'}); sign-in stays closed until Pit View restarts or a new key is written`)
    }
  }

  const keyProblem = (error: unknown): string => `a new signing key could not be written to ${shown(keyPath)} (${(error as NodeJS.ErrnoException).code ?? 'error'})`

  // a new key, written and then the marker removed; the reason when either fails
  const replaceKey = async (): Promise<string | null> => {
    try {
      await makeKey(keyPath)
    } catch (error) {
      return keyProblem(error)
    }
    owed = false
    try {
      await unlink(markerPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return `the revocation marker ${shown(markerPath)} could not be removed (${(error as NodeJS.ErrnoException).code ?? 'error'})`
    }
    return null
  }

  // while a new key is owed, every use tries to write it, so the host opens as soon as it can
  const recover = async (): Promise<string | null> => {
    const problem = await replaceKey()
    if (problem !== null) return `${problem}, so sign-in stays closed until one can be, and no session made before then works`
    deps.log('sign-in: wrote the owed signing key, which ends every earlier session')
    return null
  }

  const state = async (): Promise<SignInState> => {
    if (owed || await markerPresent()) {
      recovering ??= recover().finally(() => { recovering = null })
      const problem = await recovering
      if (problem !== null) return closed(problem)
    }
    const read = await readGuarded(oauthPath, shown(oauthPath))
    if ('missing' in read) return closed(`${shown(oauthPath)} does not exist; sign-in is not set up`)
    if ('problem' in read) return closed(read.problem)
    const oauth = parseOAuth(read.text, shown(oauthPath))
    if (typeof oauth === 'string') return closed(oauth)
    const key = await readKey()
    if (typeof key === 'string') return closed(key)
    if (lastReason !== '') deps.log('sign-in: open for the proxied host')
    lastReason = ''
    return { open: true, files: { ...oauth, key } }
  }

  const session = async (cookieHeader: string | undefined, viewer: string): Promise<string | null> => {
    const value = onlyCookie(cookieHeader, sessionCookieName)
    if (value === null) return null
    const now = await state()
    return now.open ? verifySession(now.files.key, value, deps.clock.now(), viewer) : null
  }

  const begin = async (redirectUri: string): Promise<{ location: string, cookie: string } | { reason: string }> => {
    const now = await state()
    if (!now.open) return { reason: now.reason }
    const value = randomBytes(32).toString('base64url')
    // no scope: the app reads only the login, which needs none
    const location = new URL('/login/oauth/authorize', deps.endpoints.web)
    location.searchParams.set('client_id', now.files.clientId)
    location.searchParams.set('redirect_uri', redirectUri)
    location.searchParams.set('state', value)
    location.searchParams.set('allow_signup', 'false')
    return { location: location.href, cookie: setCookie(stateCookieName, mintState(now.files.key, value, deps.clock.now()), STATE_LIFETIME_MS, 'Lax') }
  }

  // GitHub's answer as JSON, within the deadline; the error never carries a request's secrets
  const ask = async (url: URL, init: RequestInit, what: string): Promise<Record<string, unknown>> => {
    let response: Response
    try {
      response = await request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(deadlineMs) })
    } catch (error) {
      throw new SignInError(`GitHub did not answer the ${what} (${(error as Error).name})`)
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new SignInError(`GitHub's answer to the ${what} was not JSON (HTTP ${response.status})`)
    }
    if (!response.ok || typeof body !== 'object' || body === null) throw new SignInError(`GitHub refused the ${what} (HTTP ${response.status})`)
    return body as Record<string, unknown>
  }

  const finish = async (cookieHeader: string | undefined, query: URLSearchParams, redirectUri: string, viewer: string): Promise<CallbackOutcome> => {
    const now = await state()
    if (!now.open) return { kind: 'refused', status: 503, message: `Sign-in is not available: ${now.reason}.` }
    const cookie = onlyCookie(cookieHeader, stateCookieName)
    const sent = query.get('state') ?? ''
    if (cookie === null || !verifyState(now.files.key, cookie, sent, deps.clock.now())) {
      return { kind: 'refused', status: 400, message: 'This sign-in did not start here, or took too long. Start it again.' }
    }
    if (query.has('error')) return { kind: 'refused', status: 403, message: 'GitHub did not sign you in; the sign-in was canceled.' }
    const code = query.get('code') ?? ''
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(code)) return { kind: 'refused', status: 400, message: 'GitHub sent no code back. Start the sign-in again.' }
    let login: string
    try {
      const exchanged = await ask(new URL('/login/oauth/access_token', deps.endpoints.web), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'pit-view' },
        body: JSON.stringify({ client_id: now.files.clientId, client_secret: now.files.clientSecret, code, redirect_uri: redirectUri }),
      }, 'code exchange')
      const token = exchanged.access_token
      if (typeof token !== 'string' || token === '') throw new SignInError('GitHub did not accept the code')
      // the token is used for this one read and kept nowhere
      const user = await ask(new URL('/user', deps.endpoints.api), {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'pit-view' },
      }, 'account lookup')
      if (typeof user.login !== 'string' || user.login === '') throw new SignInError('GitHub named no login')
      login = user.login
    } catch (error) {
      if (!(error instanceof SignInError)) throw error
      deps.log(`sign-in: failed: ${error.message}`)
      return { kind: 'refused', status: 502, message: `The sign-in did not complete: ${error.message}. Start it again.` }
    }
    if (viewer === '' || login.toLowerCase() !== viewer.toLowerCase()) {
      deps.log('sign-in: refused a GitHub account that is not the viewer')
      return { kind: 'refused', status: 403, message: viewer === '' ? `You signed in to GitHub as ${login}, but this Pit View does not know its viewer yet, so nobody may sign in.` : `You signed in to GitHub as ${login}, which is not this Pit View's viewer. Only the viewer may use it.` }
    }
    deps.log('sign-in: the viewer signed in')
    return { kind: 'signedIn', login, cookie: setCookie(sessionCookieName, mintSession(now.files.key, login, deps.clock.now()), SESSION_LIFETIME_MS, 'Strict') }
  }

  const rotate = async (why: string): Promise<{ ok: true } | { ok: false, reason: string }> => {
    // with no key and nothing owed there is no session to end
    if ('missing' in await readGuarded(keyPath, shown(keyPath)) && !owed && !await markerPresent()) return { ok: true }
    // behind recovery, never beside it, so two new keys are not written at once
    while (recovering !== null) await recovering
    const problem = await replaceKey()
    if (problem === null) {
      deps.log(`sign-in: made a new signing key, which ends every session (${why})`)
      return { ok: true }
    }
    const reason = `${problem} after ${why}, so no session was ended and sign-in stays closed until one can be`
    owed = true
    await writeMarker()
    closed(reason)
    return { ok: false, reason }
  }

  return { state, session, begin, finish, rotate }
}
