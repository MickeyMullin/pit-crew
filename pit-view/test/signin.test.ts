// test/signin.test.ts
// sign-in through the reverse proxy (section 3 of DESIGN.md, Hosting, Sign-in behind the proxy), over the real HTTP server with a fake GitHub OAuth endpoint, an injected clock, and a config folder under the test's own temp home
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { Config } from '../src/config.ts'
import { startServer } from '../src/server.ts'
import type { PitServer, ServerOptions } from '../src/server.ts'
import { keyFileName, oauthFileName, openLoopback, revokedFileName, writeKey, SESSION_LIFETIME_MS, sessionCookieName, STATE_LIFETIME_MS, stateCookieName } from '../src/signin.ts'
import { signedInAs, showSignOut } from '../public/instance.ts'
import { scenario } from './fixtures/scenario.ts'
import { fakeLaunch, fakeTime, fixtureRunner, tempDir } from './helpers.ts'
import type { FakeTime } from './helpers.ts'

const proxyHost = 'pit.example.test'
const proxyOrigin = `https://${proxyHost}`
const clientId = 'Ov23liFAKEclient0001'
const clientSecret = 'fake-secret-0123456789abcdef0123456789abcdef'

type Recorded = { method: string, path: string, headers: IncomingHttpHeaders, body: string }

// a stand-in for github.com's OAuth endpoints and api.github.com's /user: a code names the login it signs in as
const fakeGitHub = async (logins: Record<string, string>) => {
  const requests: Recorded[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body })
      const reply = (status: number, value: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (req.method === 'POST' && req.url === '/login/oauth/access_token') {
        const sent = JSON.parse(body) as Record<string, string>
        const login = logins[sent.code ?? '']
        if (sent.client_id !== clientId || sent.client_secret !== clientSecret || login === undefined) return reply(200, { error: 'bad_verification_code' })
        return reply(200, { access_token: `gho_fake_${sent.code}`, token_type: 'bearer', scope: '' })
      }
      if (req.method === 'GET' && req.url === '/user') {
        const code = /^Bearer gho_fake_(.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''
        const login = logins[code]
        return login === undefined ? reply(401, { message: 'Bad credentials' }) : reply(200, { login, id: 1 })
      }
      reply(404, { message: 'Not Found' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

type Rig = {
  server: PitServer
  time: FakeTime
  home: string
  dir: string
  configPath: string
  github: Awaited<ReturnType<typeof fakeGitHub>>
  logs: string[]
  // while fail is set, every write of the signing key fails as a read-only folder would make it
  keyWrite: { fail: boolean }
  // a restart over the same folders: the server closes and a new one starts, with a new port and token
  restart: () => Promise<void>
  cleanup: () => Promise<void>
}

const validOAuth = JSON.stringify({ clientId, clientSecret })

const setup = async ({ oauth = validOAuth as string | null, mode = 0o600, config = {}, logins = {}, keepaliveMs }: {
  // the contents of oauth.json, or null for no file
  oauth?: string | null
  mode?: number
  config?: Partial<Config>
  logins?: Record<string, string>
  keepaliveMs?: number
} = {}): Promise<Rig> => {
  const { dir: home, cleanup: removeHome } = await tempDir()
  const dir = join(home, '.config', 'pit-view')
  const configPath = join(dir, 'config.json')
  await mkdir(dir, { recursive: true })
  await writeFile(configPath, JSON.stringify({ repo: scenario.repo, viewer: scenario.viewer, allowedHosts: [proxyHost], ...config }), 'utf8')
  if (oauth !== null) {
    await writeFile(join(dir, oauthFileName), oauth)
    await chmod(join(dir, oauthFileName), mode)
  }
  const github = await fakeGitHub({ 'code-viewer': scenario.viewer, ...logins })
  const time = fakeTime()
  const logs: string[] = []
  const keyWrite = { fail: false }
  const serverOptions: ServerOptions = {
    home,
    writeSigningKey: async (path: string): Promise<void> => {
      if (keyWrite.fail) throw Object.assign(new Error('injected'), { code: 'EACCES' })
      await writeKey(path)
    },
    port: 0,
    runner: fixtureRunner().runner,
    clock: time.clock,
    timers: time.timers,
    timeZone: scenario.timeZone,
    configPath,
    cachePath: join(home, '.local', 'state', 'pit-view', 'cache.sqlite'),
    stateDir: join(home, '.local', 'state', 'pit-view'),
    publicDir: join(home, 'public'),
    launch: fakeLaunch().deps,
    log: (line) => logs.push(line),
    pageSize: scenario.pageSize,
    oauthEndpoints: { web: github.base, api: github.base },
    ...(keepaliveMs === undefined ? {} : { keepaliveMs }),
  }
  const server = await startServer(serverOptions)
  await mkdir(join(home, 'public'), { recursive: true })
  await writeFile(join(home, 'public', 'index.html'), '<!-- public/index.html -->\n<!doctype html>\n<html>\n<head>\n<title>Pit View</title>\n</head>\n<body></body>\n</html>\n')
  await writeFile(join(home, 'public', 'settings.html'), '<!-- public/settings.html -->\n<!doctype html>\n<html>\n<head>\n<title>Settings</title>\n</head>\n<body></body>\n</html>\n')
  await writeFile(join(home, 'public', 'app.ts'), '// public/app.ts\nexport const answer: number = 42\n')
  await writeFile(join(home, 'public', 'styles.css'), '/* public/styles.css */\n')
  const rig: Rig = {
    server, time, home, dir, configPath, github, logs, keyWrite,
    restart: async () => {
      await rig.server.close()
      rig.server = await startServer(serverOptions)
    },
    cleanup: async () => {
      // a test that made the folder read-only gives it back, so it can be removed
      await chmod(dir, 0o700).catch(() => {})
      await rig.server.close()
      await github.close()
      await removeHome()
    },
  }
  return rig
}

type Answer = { status: number, headers: IncomingHttpHeaders, body: string }

// a raw request, for headers fetch will not let a test set (Host, Cookie) and paths it would normalize
const raw = (port: number, path: string, headers: Record<string, string> = {}, method = 'GET', body?: string): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })

// a request as the proxy forwards it: the Host passed through, and the headers Caddy adds
const proxied = (rig: Rig, path: string, headers: Record<string, string> = {}, method = 'GET', body?: string): Promise<Answer> =>
  raw(rig.server.port, path, { Host: proxyHost, 'X-Forwarded-For': '192.0.2.10', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': proxyHost, ...headers }, method, body)

const loopback = (rig: Rig, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Answer> =>
  raw(rig.server.port, path, { Host: `127.0.0.1:${rig.server.port}`, ...headers }, method)

const setCookies = (answer: Answer): string[] => answer.headers['set-cookie'] ?? []

const cookieNamed = (answer: Answer, name: string): string | undefined => setCookies(answer).find((line) => line.startsWith(`${name}=`))

// the name=value pair of a Set-Cookie line, as a browser sends it back
const pair = (line: string | undefined): string => (line ?? '').split(';')[0] ?? ''

const valueOf = (line: string | undefined): string => pair(line).slice(pair(line).indexOf('=') + 1)

const attributes = (line: string | undefined): string[] => (line ?? '').split(';').slice(1).map((part) => part.trim().toLowerCase())

// the sign-in as a browser makes it: start, GitHub's redirect back with a code, the callback
const begin = async (rig: Rig): Promise<{ state: string, stateCookie: string, location: URL, answer: Answer }> => {
  const answer = await proxied(rig, '/auth/sign-in')
  assert.equal(answer.status, 302, answer.body)
  const location = new URL(answer.headers.location ?? '')
  return { state: location.searchParams.get('state') ?? '', stateCookie: pair(cookieNamed(answer, stateCookieName)), location, answer }
}

const callback = (rig: Rig, code: string, state: string, stateCookie: string): Promise<Answer> =>
  proxied(rig, `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, stateCookie === '' ? {} : { Cookie: stateCookie })

const signIn = async (rig: Rig, code = 'code-viewer'): Promise<string> => {
  const { state, stateCookie } = await begin(rig)
  const answer = await callback(rig, code, state, stateCookie)
  assert.equal(answer.status, 200, answer.body)
  const session = pair(cookieNamed(answer, sessionCookieName))
  assert.notEqual(session, '')
  return session
}

const tokenTag = (rig: Rig): string => `<meta name="pit-view-token" content="${rig.server.token}">`

const githubAsked = (rig: Rig): number => rig.github.requests.length

test('the session lifetime is one named constant of seven days', () => {
  const day = 24 * 60 * 60 * 1000
  assert.equal(SESSION_LIFETIME_MS / day, 7)
  assert.ok(STATE_LIFETIME_MS > 0 && STATE_LIFETIME_MS < SESSION_LIFETIME_MS)
})

test('a signed-out request through the proxy reaches nothing: a page redirects to sign-in, and an asset, every /api route, and the event stream are 401', async () => {
  const rig = await setup()
  try {
    for (const path of ['/', '/index.html', '/settings.html']) {
      const answer = await proxied(rig, path)
      assert.equal(answer.status, 302, path)
      assert.equal(answer.headers.location, '/auth/sign-in', path)
      assert.ok(!answer.body.includes(rig.server.token), `${path} carries no token`)
    }
    for (const path of ['/app.ts', '/styles.css', '/favicon.svg', '/api/view', '/api/config', '/api/instance', '/api/sweeps', '/api/prs/101/runs', '/api/reports/PR-101.md']) {
      const answer = await proxied(rig, path)
      assert.equal(answer.status, 401, path)
      assert.ok(!answer.body.includes(rig.server.token), `${path} carries no token`)
    }
    const api = await proxied(rig, '/api/view')
    assert.match(String(api.headers['content-type']), /^application\/json/)
    assert.match(String(JSON.parse(api.body).error), /sign in/i)
    // the event stream registers no client and sends nothing
    const stream = await proxied(rig, '/api/events?client=signedout&visible=true&paused=false')
    assert.equal(stream.status, 401)
    assert.equal(rig.server.clients.size(), 0)
    // a write with a good Origin is still refused, and starts nothing
    assert.equal((await proxied(rig, '/api/refresh', { Origin: proxyOrigin }, 'POST')).status, 401)
    assert.equal((await proxied(rig, '/api/prs/106/runs', { Origin: proxyOrigin, 'X-Pit-View-Token': rig.server.token, 'Content-Type': 'application/json' }, 'POST', JSON.stringify({ repo: scenario.repo }))).status, 401)
    assert.equal(rig.server.cache.latestCycle(scenario.repo), null)
    // other methods are no way around it
    assert.equal((await proxied(rig, '/', {}, 'HEAD')).status, 401)
    assert.equal((await proxied(rig, '/api/view', {}, 'OPTIONS')).status, 401)
    assert.equal((await proxied(rig, '/api/config', { Origin: proxyOrigin, 'Content-Type': 'application/json' }, 'PUT', '{}')).status, 401)
  } finally {
    await rig.cleanup()
  }
})

test('no spelling of a path gets past the sign-in check: dot segments, doubled slashes, encodings, case, and look-alikes of the sign-in routes', async () => {
  const rig = await setup()
  try {
    const paths = [
      '/auth/sign-in/../../api/view', '/auth/callback/../../api/view', '/auth/sign-out/../../api/config', '/auth/../api/view', '/auth/%2e%2e/api/view', '/%2e%2e/api/view',
      '/./api/view', '//api/view', '/api//view', '/api/view/', '/API/view', '/api/view?next=/auth/sign-in', '/api/view#/auth/sign-in', '/auth/sign-in%2f..%2f..%2fapi%2fview',
      '/auth%2fsign-in', '/AUTH/SIGN-IN', '/auth/sign-in/', '/auth/sign-in.html', '/auth/callbackx', '/auth/', '/auth', '/index.html%00', '/%69ndex.html', '/app.ts?x=1',
    ]
    for (const path of paths) {
      const answer = await proxied(rig, path)
      assert.notEqual(answer.status, 200, path)
      assert.ok(!answer.body.includes(rig.server.token), `${path} carries no token`)
      // a look-alike never starts a sign-in either
      if (path !== '/auth/sign-in') assert.ok(answer.headers.location === undefined || answer.headers.location === '/auth/sign-in', `${path} redirects only to sign-in`)
    }
    assert.equal(githubAsked(rig), 0)
  } finally {
    await rig.cleanup()
  }
})

test('sign-in starts at GitHub with no scope and a state, and the callback admits the viewer with a signed, HttpOnly, Secure, SameSite=Strict session cookie', async () => {
  const rig = await setup()
  try {
    const { state, location, answer } = await begin(rig)
    assert.equal(`${location.origin}${location.pathname}`, `${rig.github.base}/login/oauth/authorize`)
    assert.equal(location.searchParams.get('client_id'), clientId)
    assert.equal(location.searchParams.get('redirect_uri'), `${proxyOrigin}/auth/callback`)
    assert.equal(location.searchParams.get('scope'), null)
    assert.match(state, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(answer.headers['cache-control'], 'no-store')
    // the state cookie may be Lax, since the return from GitHub is a cross-site navigation
    const stateLine = cookieNamed(answer, stateCookieName)
    assert.ok(stateCookieName.startsWith('__Host-'))
    assert.deepEqual(attributes(stateLine).sort(), ['httponly', `max-age=${STATE_LIFETIME_MS / 1000}`, 'path=/', 'samesite=lax', 'secure'])
    assert.ok(!valueOf(stateLine).includes(clientSecret))

    const back = await callback(rig, 'code-viewer', state, pair(stateLine))
    assert.equal(back.status, 200)
    assert.equal(back.headers['referrer-policy'], 'no-referrer')
    assert.equal(back.headers['cache-control'], 'no-store')
    // the next request is made by this page, so it is same-site and carries the Strict cookie; a redirect from GitHub's navigation would not
    assert.match(back.body, /<meta http-equiv="refresh" content="0; url=\/">/)
    assert.ok(!back.body.includes(rig.server.token))
    const sessionLine = cookieNamed(back, sessionCookieName)
    assert.ok(sessionCookieName.startsWith('__Host-'))
    assert.deepEqual(attributes(sessionLine).sort(), ['httponly', `max-age=${SESSION_LIFETIME_MS / 1000}`, 'path=/', 'samesite=strict', 'secure'])
    // the state cookie is spent
    assert.ok(attributes(cookieNamed(back, stateCookieName)).includes('max-age=0'))

    // GitHub was asked to exchange the code with the secret, then who the token belongs to
    const [exchange, user] = rig.github.requests
    assert.equal(exchange?.method, 'POST')
    assert.equal(exchange?.path, '/login/oauth/access_token')
    assert.deepEqual(JSON.parse(exchange?.body ?? '{}'), { client_id: clientId, client_secret: clientSecret, code: 'code-viewer', redirect_uri: `${proxyOrigin}/auth/callback` })
    assert.equal(user?.path, '/user')
    assert.equal(user?.headers.authorization, 'Bearer gho_fake_code-viewer')

    const session = pair(sessionLine)
    const page = await proxied(rig, '/', { Cookie: session })
    assert.equal(page.status, 200)
    assert.ok(page.body.includes(tokenTag(rig)), 'a signed-in page carries the token')
    assert.match(page.body, new RegExp(`<meta name="pit-view-signed-in" content="${scenario.viewer}">`))
    assert.equal((await proxied(rig, '/app.ts', { Cookie: session })).status, 200)
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 200)
  } finally {
    await rig.cleanup()
  }
})

test('the viewer is matched without regard to letter case, and any other GitHub login is refused with no session', async () => {
  const rig = await setup({ logins: { 'code-upper': scenario.viewer.toUpperCase(), 'code-other': 'sam-tran' } })
  try {
    assert.notEqual(await signIn(rig, 'code-upper'), '')
    const { state, stateCookie } = await begin(rig)
    const refused = await callback(rig, 'code-other', state, stateCookie)
    assert.equal(refused.status, 403)
    assert.match(refused.body, /sam-tran/)
    assert.equal(cookieNamed(refused, sessionCookieName), undefined)
    assert.ok(!refused.body.includes(rig.server.token))
    // nothing the refused sign-in got back opens the app
    assert.equal((await proxied(rig, '/api/view', { Cookie: setCookies(refused).map(pair).join('; ') })).status, 401)
  } finally {
    await rig.cleanup()
  }
})

test('a viewer that is not resolved admits nobody', async () => {
  const rig = await setup({ config: { viewer: '' } })
  try {
    const { state, stateCookie } = await begin(rig)
    const refused = await callback(rig, 'code-viewer', state, stateCookie)
    assert.equal(refused.status, 403)
    assert.equal(cookieNamed(refused, sessionCookieName), undefined)
  } finally {
    await rig.cleanup()
  }
})

test('the callback asks GitHub nothing without a matching, signed, unexpired state of its own', async () => {
  const rig = await setup()
  try {
    const { state, stateCookie } = await begin(rig)
    const other = await begin(rig)
    const [name, value] = [stateCookie.slice(0, stateCookie.indexOf('=')), stateCookie.slice(stateCookie.indexOf('=') + 1)]
    const flipped = `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`
    for (const [label, query, cookie] of [
      ['no state cookie', `code=code-viewer&state=${state}`, ''],
      ['no state', 'code=code-viewer', stateCookie],
      ['another start\'s state', `code=code-viewer&state=${other.state}`, stateCookie],
      ['a state cookie with a changed signature', `code=code-viewer&state=${state}`, `${name}=${flipped}`],
      ['a state cookie made up by hand', `code=code-viewer&state=${state}`, `${name}=${state}`],
      ['two state cookies', `code=code-viewer&state=${state}`, `${stateCookie}; ${other.stateCookie}`],
      ['no code', `state=${state}`, stateCookie],
    ] as const) {
      const answer = await proxied(rig, `/auth/callback?${query}`, cookie === '' ? {} : { Cookie: cookie })
      assert.equal(answer.status, 400, label)
      assert.equal(cookieNamed(answer, sessionCookieName), undefined, label)
    }
    // GitHub's own refusal (the owner pressed Cancel) is no sign-in either
    const canceled = await proxied(rig, `/auth/callback?error=access_denied&state=${state}`, { Cookie: stateCookie })
    assert.equal(canceled.status, 403)
    assert.equal(githubAsked(rig), 0)
    // a state is good for a limited time only
    rig.time.advance(STATE_LIFETIME_MS)
    assert.equal((await callback(rig, 'code-viewer', state, stateCookie)).status, 400)
    assert.equal(githubAsked(rig), 0)
    // a code GitHub does not accept signs nobody in
    const fresh = await begin(rig)
    const bad = await callback(rig, 'code-unknown', fresh.state, fresh.stateCookie)
    assert.equal(bad.status, 502)
    assert.equal(cookieNamed(bad, sessionCookieName), undefined)
  } finally {
    await rig.cleanup()
  }
})

test('sign-in takes no return address, so it cannot redirect anywhere but GitHub and then the dashboard', async () => {
  const rig = await setup()
  try {
    for (const query of ['?next=https://attacker.test/', '?return_to=//attacker.test', '?redirect_uri=https://attacker.test/auth/callback', '?state=chosen-by-attacker']) {
      const answer = await proxied(rig, `/auth/sign-in${query}`)
      assert.equal(answer.status, 302)
      const location = new URL(answer.headers.location ?? '')
      assert.equal(location.origin, rig.github.base)
      assert.equal(location.searchParams.get('redirect_uri'), `${proxyOrigin}/auth/callback`)
      assert.notEqual(location.searchParams.get('state'), 'chosen-by-attacker')
    }
    const { state, stateCookie } = await begin(rig)
    const back = await proxied(rig, `/auth/callback?code=code-viewer&state=${state}&next=https://attacker.test/`, { Cookie: stateCookie })
    assert.equal(back.status, 200)
    assert.equal(back.headers.location, undefined)
    assert.ok(!back.body.includes('attacker.test'))
  } finally {
    await rig.cleanup()
  }
})

test('a tampered, forged, foreign, doubled, or expired session cookie is refused, and the lifetime is the constant\'s', async () => {
  const rig = await setup()
  const elsewhere = await setup()
  try {
    const session = await signIn(rig)
    const foreign = await signIn(elsewhere)
    const value = session.slice(session.indexOf('=') + 1)
    const [version, payload, signature] = value.split('.') as [string, string, string]
    const swap = (text: string, at: number): string => `${text.slice(0, at)}${text[at] === 'A' ? 'B' : 'A'}${text.slice(at + 1)}`
    const forgedPayload = Buffer.from(JSON.stringify({ login: scenario.viewer, issuedAt: rig.time.clock.now(), nonce: 'x' })).toString('base64url')
    for (const [label, cookie] of [
      ['a changed payload', `${sessionCookieName}=${version}.${swap(payload, 2)}.${signature}`],
      ['a changed last signature character', `${sessionCookieName}=${version}.${payload}.${swap(signature, signature.length - 1)}`],
      ['a changed first signature character', `${sessionCookieName}=${version}.${payload}.${swap(signature, 0)}`],
      ['a shortened signature', `${sessionCookieName}=${version}.${payload}.${signature.slice(0, -2)}`],
      ['a lengthened signature', `${sessionCookieName}=${version}.${payload}.${signature}AA`],
      ['a signature with a stray character', `${sessionCookieName}=${version}.${payload}.${signature}!`],
      ['no signature', `${sessionCookieName}=${version}.${payload}`],
      ['a payload signed by nobody', `${sessionCookieName}=${version}.${forgedPayload}.${signature}`],
      ['another version', `${sessionCookieName}=v2.${payload}.${signature}`],
      ['another server\'s session', foreign],
      ['two session cookies', `${session}; ${foreign}`],
      ['the name without its prefix', `pit-view-session=${value}`],
    ] as const) {
      assert.equal((await proxied(rig, '/api/view', { Cookie: cookie })).status, 401, label)
    }
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 200)
    rig.time.advance(SESSION_LIFETIME_MS - 1)
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 200)
    rig.time.advance(1)
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 401)
    assert.equal((await proxied(rig, '/', { Cookie: session })).status, 302)
  } finally {
    await rig.cleanup()
    await elsewhere.cleanup()
  }
})

test('a sign-in never keeps a session cookie the browser already had: the new one is minted fresh', async () => {
  const rig = await setup()
  try {
    const planted = `${sessionCookieName}=v1.planted.planted`
    const { state, stateCookie } = await begin(rig)
    const back = await callback(rig, 'code-viewer', state, `${stateCookie}; ${planted}`)
    const minted = pair(cookieNamed(back, sessionCookieName))
    assert.notEqual(minted, planted)
    assert.equal((await proxied(rig, '/api/view', { Cookie: planted })).status, 401)
    assert.equal((await proxied(rig, '/api/view', { Cookie: minted })).status, 200)
    // two sign-ins mint two different sessions
    assert.notEqual(await signIn(rig), minted)
  } finally {
    await rig.cleanup()
  }
})

test('loopback is open only for a loopback Host with no forwarding header; anything that came through a proxy needs sign-in, whatever its Host', async () => {
  const rig = await setup()
  try {
    for (const name of [`127.0.0.1:${rig.server.port}`, `localhost:${rig.server.port}`, `[::1]:${rig.server.port}`]) {
      const answer = await raw(rig.server.port, '/', { Host: name })
      assert.equal(answer.status, 200, name)
      assert.ok(answer.body.includes(tokenTag(rig)), `${name} is served the token`)
      assert.ok(!answer.body.includes('pit-view-signed-in'), `${name} is not a signed-in page`)
    }
    assert.equal((await loopback(rig, '/api/view')).status, 200)
    for (const header of ['X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Forwarded-Port', 'X-Forwarded-Server', 'Via', 'Forwarded']) {
      assert.equal((await loopback(rig, '/api/view', { [header]: header === 'Forwarded' ? 'for=192.0.2.10' : '192.0.2.10' })).status, 401, header)
      assert.equal((await loopback(rig, '/', { [header]: 'x' })).status, 302, header)
    }
    // the allowed name without forwarding headers is still not loopback
    assert.equal((await raw(rig.server.port, '/api/view', { Host: proxyHost })).status, 401)
    assert.equal((await raw(rig.server.port, '/api/view', { Host: `${proxyHost}:${rig.server.port}` })).status, 401)
    // names the server does not answer to are refused before sign-in is considered
    for (const name of ['127.0.0.1', `127.0.0.1:${rig.server.port + 1}`, `127.0.0.1.${proxyHost}`, 'localhost', `evil.${proxyHost}`]) {
      assert.equal((await raw(rig.server.port, '/api/view', { Host: name })).status, 403, name)
    }
    // the sign-in routes belong to the proxied host: open loopback has none, and a proxied loopback name cannot start one
    assert.equal((await loopback(rig, '/auth/sign-in')).status, 404)
    assert.equal((await loopback(rig, '/auth/callback?code=code-viewer&state=x')).status, 404)
    assert.equal((await loopback(rig, '/auth/sign-out', { Origin: `http://127.0.0.1:${rig.server.port}` }, 'POST')).status, 404)
    const disguised = await loopback(rig, '/auth/sign-in', { 'X-Forwarded-For': '192.0.2.10' })
    assert.equal(disguised.status, 403)
    assert.equal(cookieNamed(disguised, stateCookieName), undefined)
    assert.equal(githubAsked(rig), 0)
  } finally {
    await rig.cleanup()
  }
})

test('openLoopback reads only the Host and the forwarding headers', () => {
  const port = 4791
  assert.equal(openLoopback({ host: '127.0.0.1:4791' }, port), true)
  assert.equal(openLoopback({ host: 'LOCALHOST:4791' }, port), true)
  assert.equal(openLoopback({ host: '[::1]:4791', 'user-agent': 'x', cookie: 'a=b' }, port), true)
  assert.equal(openLoopback({ host: '127.0.0.1:4791', 'x-forwarded-for': '127.0.0.1' }, port), false)
  assert.equal(openLoopback({ host: '127.0.0.1:4791', 'x-forwarded-anything': '' }, port), false)
  assert.equal(openLoopback({ host: '127.0.0.1:4791', via: '1.1 caddy' }, port), false)
  assert.equal(openLoopback({ host: '127.0.0.1:4791', forwarded: 'for=127.0.0.1' }, port), false)
  assert.equal(openLoopback({ host: '127.0.0.1:4792' }, port), false)
  assert.equal(openLoopback({ host: 'pit.example.test' }, port), false)
  assert.equal(openLoopback({}, port), false)
})

test('the per-start token is still required to start and stop runs on the proxied host, and a session is no substitute for it', async () => {
  const rig = await setup()
  try {
    const session = await signIn(rig)
    const write = (headers: Record<string, string>) => proxied(rig, '/api/runs/999/stop', { Cookie: session, Origin: proxyOrigin, ...headers }, 'POST')
    assert.equal((await write({})).status, 403)
    assert.equal((await write({ 'X-Pit-View-Token': 'wrong' })).status, 403)
    // with the token the request reaches the run: unknown here, so 404
    assert.equal((await write({ 'X-Pit-View-Token': rig.server.token })).status, 404)
    // and the token alone, without a session, reaches nothing
    assert.equal((await proxied(rig, '/api/runs/999/stop', { Origin: proxyOrigin, 'X-Pit-View-Token': rig.server.token }, 'POST')).status, 401)
    // a foreign Origin is refused even signed in
    assert.equal((await write({ 'X-Pit-View-Token': rig.server.token, Origin: 'https://attacker.test' })).status, 403)
  } finally {
    await rig.cleanup()
  }
})

test('signed in through the proxy, the page may write, and the event stream is unbuffered with keepalives', async () => {
  const rig = await setup()
  try {
    const session = await signIn(rig)
    assert.equal((await proxied(rig, '/api/refresh', { Cookie: session, Origin: 'http://attacker.test' }, 'POST')).status, 403)
    assert.equal(rig.server.cache.latestCycle(scenario.repo), null)
    assert.equal((await proxied(rig, '/api/refresh', { Cookie: session, Origin: proxyOrigin }, 'POST')).status, 200)
    await rig.server.poller.idle()
    const stream = await openProxiedStream(rig, session)
    assert.match(String(stream.headers['content-type']), /^text\/event-stream/)
    assert.match(String(stream.headers['cache-control']), /no-cache/)
    assert.match(String(stream.headers['cache-control']), /no-transform/)
    assert.equal(stream.headers['x-accel-buffering'], 'no')
    assert.equal(stream.headers['content-length'], undefined)
    assert.equal(await stream.next(), ': connected')
    await until(() => rig.server.clients.size() === 1)
    rig.time.advance(30_000)
    assert.equal(await stream.next(), ': keepalive')
    rig.time.advance(30_000)
    assert.equal(await stream.next(), ': keepalive')
    stream.close()
  } finally {
    await rig.cleanup()
  }
})

const until = async (check: () => boolean): Promise<void> => {
  for (let tries = 0; tries < 400 && !check(); tries += 1) await delay(5)
  assert.ok(check(), 'condition reached')
}

// an event stream through the proxy, read frame by frame, which says when the server ended it
const openProxiedStream = (rig: Rig, cookie: string): Promise<{ status: number, headers: IncomingHttpHeaders, next: () => Promise<string>, ended: () => boolean, close: () => void }> =>
  new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: rig.server.port,
      path: '/api/events?client=proxied&visible=false&paused=false',
      headers: { Host: proxyHost, 'X-Forwarded-For': '192.0.2.10', 'X-Forwarded-Proto': 'https', Cookie: cookie },
    }, (res) => {
      res.setEncoding('utf8')
      let buffer = ''
      let done = false
      const waiting: ((text: string) => void)[] = []
      const drain = (): void => {
        for (let end = buffer.indexOf('\n\n'); end >= 0 && waiting.length > 0; end = buffer.indexOf('\n\n')) {
          const text = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          waiting.shift()!(text)
        }
      }
      res.on('data', (chunk: string) => {
        buffer += chunk
        drain()
      })
      res.on('end', () => {
        done = true
      })
      res.on('close', () => {
        done = true
      })
      const next = (): Promise<string> => new Promise((resolveFrame) => {
        waiting.push(resolveFrame)
        drain()
      })
      resolve({ status: res.statusCode ?? 0, headers: res.headers, next, ended: () => done, close: () => req.destroy() })
    })
    req.on('error', reject)
    req.end()
  })

test('an open event stream ends once its session is no longer good: at sign-out at once, and at expiry by its next keepalive', async () => {
  const rig = await setup({ keepaliveMs: SESSION_LIFETIME_MS / 4 })
  try {
    const first = await signIn(rig)
    const stream = await openProxiedStream(rig, first)
    assert.equal(stream.status, 200)
    assert.equal(await stream.next(), ': connected')
    await until(() => rig.server.clients.size() === 1)
    // a loopback stream is not signed in and is left alone
    const local = await new Promise<{ ended: () => boolean, close: () => void }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: rig.server.port, path: '/api/events?client=local&visible=false&paused=false' }, (res) => {
        let done = false
        res.on('data', () => {})
        res.on('close', () => {
          done = true
        })
        resolve({ ended: () => done, close: () => req.destroy() })
      })
      req.on('error', reject)
      req.end()
    })
    await until(() => rig.server.clients.size() === 2)
    rig.time.advance(SESSION_LIFETIME_MS - 1)
    await delay(50)
    assert.equal(stream.ended(), false)
    rig.time.advance(SESSION_LIFETIME_MS / 4)
    await until(() => stream.ended())
    await until(() => rig.server.clients.size() === 1)
    assert.equal(local.ended(), false)

    const second = await signIn(rig)
    const again = await openProxiedStream(rig, second)
    assert.equal(again.status, 200)
    await until(() => rig.server.clients.size() === 2)
    const out = await proxied(rig, '/auth/sign-out', { Cookie: second, Origin: proxyOrigin }, 'POST')
    assert.equal(out.status, 200)
    await until(() => again.ended())
    assert.equal(local.ended(), false)
    local.close()
  } finally {
    await rig.cleanup()
  }
})

test('sign-out takes a POST from the page\'s own origin, clears the cookie, and ends the session on the server too', async () => {
  const rig = await setup()
  try {
    const session = await signIn(rig)
    assert.equal((await proxied(rig, '/auth/sign-out', { Cookie: session }, 'GET')).status, 405)
    // another site's page cannot sign the owner out, with an Origin or without one
    assert.equal((await proxied(rig, '/auth/sign-out', { Cookie: session, Origin: 'https://attacker.test' }, 'POST')).status, 403)
    assert.equal((await proxied(rig, '/auth/sign-out', { Cookie: session }, 'POST')).status, 403)
    assert.equal((await proxied(rig, '/auth/sign-out', { Cookie: session, Origin: `http://${proxyHost}` }, 'POST')).status, 403)
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 200)
    // someone on the network with no session, who can send any Origin they like, only clears a cookie they do not have
    const stranger = await proxied(rig, '/auth/sign-out', { Origin: proxyOrigin }, 'POST')
    assert.equal(stranger.status, 200)
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 200)
    const out = await proxied(rig, '/auth/sign-out', { Cookie: session, Origin: proxyOrigin, 'Content-Type': 'application/x-www-form-urlencoded' }, 'POST', '')
    assert.equal(out.status, 200)
    assert.ok(attributes(cookieNamed(out, sessionCookieName)).includes('max-age=0'))
    assert.match(out.body, /href="\/auth\/sign-in"/)
    assert.ok(!out.body.includes(rig.server.token))
    // a copy of the cookie kept elsewhere no longer works
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 401)
    assert.notEqual(await signIn(rig), '')
  } finally {
    await rig.cleanup()
  }
})

test('a viewer change in Settings ends every session, even when the viewer is changed back', async () => {
  const rig = await setup()
  try {
    const session = await signIn(rig)
    const save = async (viewer: string): Promise<number> => {
      const stored = JSON.parse((await loopback(rig, '/api/config')).body) as Config
      return (await raw(rig.server.port, '/api/config', { Host: `127.0.0.1:${rig.server.port}`, Origin: `http://127.0.0.1:${rig.server.port}`, 'X-Pit-View-Token': rig.server.token, 'Content-Type': 'application/json' }, 'PUT', JSON.stringify({ ...stored, viewer }))).status
    }
    // a save that leaves the viewer alone keeps the session
    assert.equal(await save(scenario.viewer), 200)
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 200)
    assert.equal(await save('sam-tran'), 200)
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 401)
    assert.equal(await save(scenario.viewer), 200)
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 401)
    assert.equal((await proxied(rig, '/api/view', { Cookie: await signIn(rig) })).status, 200)
    await rig.server.poller.idle()
  } finally {
    await rig.cleanup()
  }
})

const markerPath = (rig: Rig): string => join(rig.home, '.local', 'state', 'pit-view', revokedFileName)

const saveViewer = async (rig: Rig, viewer: string): Promise<number> => {
  const stored = JSON.parse((await loopback(rig, '/api/config')).body) as Config
  return (await raw(rig.server.port, '/api/config', { Host: `127.0.0.1:${rig.server.port}`, Origin: `http://127.0.0.1:${rig.server.port}`, 'X-Pit-View-Token': rig.server.token, 'Content-Type': 'application/json' }, 'PUT', JSON.stringify({ ...stored, viewer }))).status
}

const signOut = (rig: Rig, session?: string): Promise<Answer> =>
  proxied(rig, '/auth/sign-out', { ...(session === undefined ? {} : { Cookie: session }), Origin: proxyOrigin }, 'POST')

test('a sign-out whose new key cannot be written says it did not end the sessions, keeps the host closed, and writes a marker with mode 0600', async () => {
  const rig = await setup()
  try {
    const session = await signIn(rig)
    rig.keyWrite.fail = true
    const out = await signOut(rig, session)
    assert.equal(out.status, 503)
    assert.ok(!out.body.includes('Signed out'))
    assert.match(out.body, /did not end/)
    assert.match(out.body, /session\.key/)
    assert.match(out.body, /EACCES/)
    assert.ok(!out.body.includes(rig.server.token))
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 401)
    assert.equal((await proxied(rig, '/')).status, 503)
    assert.equal((await stat(markerPath(rig))).mode & 0o777, 0o600)
    // loopback is untouched
    assert.equal((await loopback(rig, '/api/view')).status, 200)
  } finally {
    await rig.cleanup()
  }
})

test('after a failed sign-out and a restart the old cookie is refused and the host stays closed; a later rotation reopens it and the old cookie stays refused', async () => {
  const rig = await setup()
  try {
    const session = await signIn(rig)
    rig.keyWrite.fail = true
    assert.equal((await signOut(rig, session)).status, 503)
    await rig.restart()
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 401)
    assert.equal((await proxied(rig, '/', { Cookie: session })).status, 503)
    assert.ok(!(await proxied(rig, '/', { Cookie: session })).body.includes(rig.server.token))
    assert.equal((await proxied(rig, '/auth/sign-in')).status, 503)
    // the key can be written again: the next use makes a new one, which opens the host
    rig.keyWrite.fail = false
    const fresh = await signIn(rig)
    assert.equal((await proxied(rig, '/api/view', { Cookie: fresh })).status, 200)
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 401)
    await assert.rejects(stat(markerPath(rig)), { code: 'ENOENT' })
    await rig.restart()
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 401)
    assert.equal((await proxied(rig, '/api/view', { Cookie: fresh })).status, 200)
  } finally {
    await rig.cleanup()
  }
})

test('a sign-out with no session cannot close the host for the owner, even while the key cannot be written', async () => {
  const rig = await setup()
  try {
    const session = await signIn(rig)
    rig.keyWrite.fail = true
    const stranger = await signOut(rig)
    assert.equal(stranger.status, 200)
    await assert.rejects(stat(markerPath(rig)), { code: 'ENOENT' })
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 200)
    await rig.restart()
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 200)
  } finally {
    await rig.cleanup()
  }
})

test('a failed key write at a viewer change leaves the host closed through a restart, so changing the viewer back does not revive an old session', async () => {
  const rig = await setup()
  try {
    const session = await signIn(rig)
    rig.keyWrite.fail = true
    assert.equal(await saveViewer(rig, 'sam-tran'), 200)
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 401)
    assert.equal((await stat(markerPath(rig))).mode & 0o777, 0o600)
    await rig.restart()
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 401)
    assert.equal((await proxied(rig, '/')).status, 503)
    // the viewer goes back while the key still cannot be written
    assert.equal(await saveViewer(rig, scenario.viewer), 200)
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 401)
    await rig.restart()
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 401)
    rig.keyWrite.fail = false
    const fresh = await signIn(rig)
    assert.equal((await proxied(rig, '/api/view', { Cookie: fresh })).status, 200)
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 401)
    await rig.server.poller.idle()
  } finally {
    await rig.cleanup()
  }
})

test('a sign-out with the config folder really read-only fails the same way, and the marker in the state folder survives a restart', async () => {
  const rig = await setup()
  try {
    const session = await signIn(rig)
    await chmod(rig.dir, 0o500)
    const out = await signOut(rig, session)
    assert.equal(out.status, 503)
    assert.ok(!out.body.includes('Signed out'))
    await rig.restart()
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 401)
    await chmod(rig.dir, 0o700)
    const fresh = await signIn(rig)
    assert.equal((await proxied(rig, '/api/view', { Cookie: fresh })).status, 200)
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 401)
  } finally {
    await rig.cleanup()
  }
})

test('with no oauth.json the proxied host stays closed and sign-in does not start, while loopback stays open', async () => {
  const rig = await setup({ oauth: null })
  try {
    const page = await proxied(rig, '/')
    assert.equal(page.status, 503)
    assert.match(page.body, /~\/\.config\/pit-view\/oauth\.json/)
    assert.ok(!page.body.includes(rig.server.token))
    assert.equal((await proxied(rig, '/api/view')).status, 401)
    const start = await proxied(rig, '/auth/sign-in')
    assert.equal(start.status, 503)
    assert.equal(start.headers.location, undefined)
    assert.equal(cookieNamed(start, stateCookieName), undefined)
    assert.equal((await loopback(rig, '/api/view')).status, 200)
    // no key is made while sign-in is not set up
    await assert.rejects(stat(join(rig.dir, keyFileName)))
    assert.ok(rig.logs.some((line) => /sign-in/.test(line) && /oauth\.json/.test(line)), 'the closed state is logged')
    // set up later, it opens without a restart
    await writeFile(join(rig.dir, oauthFileName), validOAuth, { mode: 0o600 })
    await chmod(join(rig.dir, oauthFileName), 0o600)
    assert.notEqual(await signIn(rig), '')
  } finally {
    await rig.cleanup()
  }
})

test('an oauth.json looser than 0600, not a plain file, or not in the expected form keeps the proxied host closed', async () => {
  for (const [label, oauth, mode] of [
    ['mode 0644', validOAuth, 0o644],
    ['mode 0640', validOAuth, 0o640],
    ['mode 0604', validOAuth, 0o604],
    ['mode 0700', validOAuth, 0o700],
    ['not JSON', 'clientId=x', 0o600],
    ['no secret', JSON.stringify({ clientId }), 0o600],
    ['an empty id', JSON.stringify({ clientId: '', clientSecret }), 0o600],
    ['another key', JSON.stringify({ clientId, clientSecret, scope: 'repo' }), 0o600],
  ] as const) {
    const rig = await setup({ oauth, mode })
    try {
      assert.equal((await proxied(rig, '/')).status, 503, label)
      assert.equal((await proxied(rig, '/auth/sign-in')).status, 503, label)
      assert.equal(githubAsked(rig), 0, label)
    } finally {
      await rig.cleanup()
    }
  }
  // a mode of 0400 is stricter than 0600, and fine
  const strict = await setup({ mode: 0o400 })
  try {
    assert.notEqual(await signIn(strict), '')
  } finally {
    await strict.cleanup()
  }
  // a symbolic link is not the file itself, even to a file of mode 0600
  const linked = await setup({ oauth: null })
  try {
    const elsewhere = join(linked.home, 'elsewhere.json')
    await writeFile(elsewhere, validOAuth)
    await chmod(elsewhere, 0o600)
    await symlink(elsewhere, join(linked.dir, oauthFileName))
    assert.equal((await proxied(linked, '/auth/sign-in')).status, 503)
  } finally {
    await linked.cleanup()
  }
})

test('the files\' modes are checked at every use: loosened after sign-in, the session stops working, and tightened again, it works', async () => {
  const rig = await setup()
  try {
    const session = await signIn(rig)
    // the key was made on the first start, with mode 0600
    assert.equal((await stat(join(rig.dir, keyFileName))).mode & 0o777, 0o600)
    await chmod(join(rig.dir, oauthFileName), 0o644)
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 401)
    assert.equal((await proxied(rig, '/', { Cookie: session })).status, 503)
    await chmod(join(rig.dir, oauthFileName), 0o600)
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 200)
    await chmod(join(rig.dir, keyFileName), 0o644)
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 401)
    await chmod(join(rig.dir, keyFileName), 0o600)
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 200)
    // a key file that is gone is made again, which ends the old sessions
    await rm(join(rig.dir, keyFileName))
    assert.equal((await proxied(rig, '/api/view', { Cookie: session })).status, 401)
    assert.equal((await stat(join(rig.dir, keyFileName))).mode & 0o777, 0o600)
  } finally {
    await rig.cleanup()
  }
})

test('the client ID, the secret, and the signing key reach no log, no API answer, no page, and no config file', async () => {
  const rig = await setup({ logins: { 'code-other': 'sam-tran' } })
  try {
    const session = await signIn(rig)
    const other = await begin(rig)
    await callback(rig, 'code-other', other.state, other.stateCookie)
    const bad = await begin(rig)
    await callback(rig, 'code-unknown', bad.state, bad.stateCookie)
    const key = (await readFile(join(rig.dir, keyFileName), 'utf8')).trim()
    const answers = await Promise.all(['/api/config', '/api/instance', '/api/view', '/', '/settings.html'].map((path) => proxied(rig, path, { Cookie: session })))
    for (const answer of answers) assert.equal(answer.status, 200)
    assert.ok(rig.logs.some((line) => /sign-in/.test(line)), 'sign-ins are logged')
    const config = await readFile(rig.configPath, 'utf8')
    for (const secret of [clientId, clientSecret, key, 'gho_fake_', 'code-viewer', valueOf(session)]) {
      for (const line of rig.logs) assert.ok(!line.includes(secret), `a log line holds ${secret}: ${line}`)
      for (const answer of answers) assert.ok(!answer.body.includes(secret), `an answer holds ${secret}`)
      assert.ok(!config.includes(secret), `config.json holds ${secret}`)
    }
  } finally {
    await rig.cleanup()
  }
})

test('both pages carry a hidden sign-out form, which a signed-in page shows', async () => {
  for (const name of ['index.html', 'settings.html']) {
    const html = await readFile(join(import.meta.dirname, '..', 'public', name), 'utf8')
    assert.match(html, /<form id="sign-out" class="sign-out" method="post" action="\/auth\/sign-out" hidden>/, name)
  }
  const form = { hidden: true, title: '' }
  const doc = (content: string | null) => ({
    querySelector: (selector: string) => selector === 'meta[name="pit-view-signed-in"]' && content !== null ? { getAttribute: (name: string) => name === 'content' ? content : null } : null,
    getElementById: (id: string) => id === 'sign-out' ? form : null,
  })
  // each page shows it at load, and the stylesheet's display for the form gives way to hidden
  for (const name of ['app.ts', 'settings.ts']) {
    const source = await readFile(join(import.meta.dirname, '..', 'public', name), 'utf8')
    assert.match(source, /import \{[^}]*\bshowSignOut\b[^}]*\} from '\.\/instance\.ts'/, name)
    assert.match(source, /^showSignOut\(document\)$/m, name)
  }
  const css = await readFile(join(import.meta.dirname, '..', 'public', 'styles.css'), 'utf8')
  assert.match(css, /\.sign-out\[hidden\] \{\s*display: none;\s*\}/)
  assert.equal(signedInAs(doc(null) as unknown as Document), null)
  showSignOut(doc(null) as unknown as Document)
  assert.equal(form.hidden, true)
  assert.equal(signedInAs(doc('vera-quill') as unknown as Document), 'vera-quill')
  showSignOut(doc('vera-quill') as unknown as Document)
  assert.equal(form.hidden, false)
  assert.equal(form.title, 'Sign out vera-quill')
})
