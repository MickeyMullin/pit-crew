// test/server.test.ts
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { openCache } from '../src/cache.ts'
import type { Config } from '../src/config.ts'
import type { Patch, View } from '../src/poller.ts'
import { hostAllowed, originAllowed, PortInUseError, resolveRuntime, startServer } from '../src/server.ts'
import type { PitServer } from '../src/server.ts'
import { scenario } from './fixtures/scenario.ts'
import type { MineRow, OpenRow } from '../src/derive.ts'
import type { RunResult } from '../src/github.ts'
import { failed, fakeRunner, fakeTime, field, fixtureRunner, gatedRunner, githubCalls, ok, singlePr, tempDir } from './helpers.ts'
import type { FakeRunner, FakeTime } from './helpers.ts'

type Harness = { server: PitServer, time: FakeTime, runner: FakeRunner, home: string, configPath: string, base: string, cleanup: () => Promise<void> }

const setup = async ({ config = {}, runner = fixtureRunner(), files = {} }: {
  config?: Partial<Config>
  runner?: FakeRunner
  // files under the temp home, path to contents
  files?: Record<string, string | Buffer>
} = {}): Promise<Harness> => {
  const { dir: home, cleanup: removeHome } = await tempDir()
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(home, path, '..'), { recursive: true })
    await writeFile(join(home, path), contents)
  }
  const configPath = join(home, '.config', 'pit-view', 'config.json')
  await mkdir(join(configPath, '..'), { recursive: true })
  await writeFile(configPath, JSON.stringify({ repo: scenario.repo, viewer: scenario.viewer, ...config }), 'utf8')
  const time = fakeTime()
  const server = await startServer({
    home,
    port: 0,
    runner: runner.runner,
    clock: time.clock,
    timers: time.timers,
    timeZone: scenario.timeZone,
    configPath,
    cachePath: join(home, '.local', 'state', 'pit-view', 'cache.sqlite'),
    publicDir: join(home, 'public'),
    log: () => {},
    pageSize: scenario.pageSize,
  })
  const cleanup = async (): Promise<void> => {
    await server.close()
    await removeHome()
  }
  return { server, time, runner, home, configPath, base: server.url, cleanup }
}

const getJson = async <T>(url: string): Promise<{ status: number, body: T }> => {
  const response = await fetch(url)
  return { status: response.status, body: await response.json() as T }
}

const send = async (url: string, method: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number, body: Record<string, unknown> }> => {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

// a raw request, for headers fetch will not let a test set (Host) or paths it would normalize
const raw = (port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number, type: string, body: string }> =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })

// an event stream reader: frames are split on blank lines
const openStream = async (base: string, query: string) => {
  const controller = new AbortController()
  const response = await fetch(`${base}/api/events?${query}`, { signal: controller.signal })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const frame = async (): Promise<string> => {
    for (;;) {
      const end = buffer.indexOf('\n\n')
      if (end >= 0) {
        const text = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        return text
      }
      const { value, done } = await reader.read()
      if (done) throw new Error('the stream ended')
      buffer += decoder.decode(value, { stream: true })
    }
  }
  const patch = async (): Promise<Patch> => {
    for (;;) {
      const text = await frame()
      if (!text.startsWith('event: patch\n')) continue
      return JSON.parse(text.slice(text.indexOf('data: ') + 6)) as Patch
    }
  }
  // patches up to and including the one that ends the current cycle
  const untilCycleEnds = async (): Promise<Patch[]> => {
    const patches: Patch[] = []
    for (;;) {
      const next = await patch()
      patches.push(next)
      if (next.sync?.cycle !== null && next.sync?.cycle !== undefined && next.sync.cycle.state !== 'running') return patches
    }
  }
  const close = (): void => {
    controller.abort()
    reader.cancel().catch(() => {})
  }
  return { frame, patch, untilCycleEnds, close }
}

const until = async (check: () => boolean): Promise<void> => {
  for (let tries = 0; tries < 200 && !check(); tries += 1) await delay(5)
  assert.ok(check(), 'condition reached')
}

test('GET /api/view answers from the cache at once, with no GitHub call', async () => {
  const h = await setup()
  try {
    const { status, body } = await getJson<View>(`${h.base}/api/view`)
    assert.equal(status, 200)
    assert.equal(body.version, 0)
    assert.equal(body.repo, scenario.repo)
    assert.equal(body.viewer.login, scenario.viewer)
    assert.equal(body.autoReview, null)
    assert.equal(body.sync.cycle, null)
    assert.equal(body.sync.refreshSeconds, 300)
    assert.deepEqual(body.sync.ui, { activeClients: 0, nextCycleAt: null })
    assert.equal(body.sync.sections.open.state, 'loading')
    assert.deepEqual(body.mine.groups.map((group) => group.key), ['changesRequested', 'readyToMerge', 'awaitingReview', 'drafts'])
    assert.equal(h.runner.calls.length, 0)
  } finally {
    await h.cleanup()
  }
})

test('the event stream registers the client, starts the active cycle and streams versioned patches', async () => {
  const h = await setup()
  try {
    const stream = await openStream(h.base, 'client=tab-1&visible=true&paused=false')
    const patches = await stream.untilCycleEnds()
    patches.forEach((patch, index) => assert.equal(patch.version, index + 1))
    assert.equal(patches[0]?.sync?.cycle?.trigger, 'active')
    assert.equal(patches[patches.length - 1]?.sync?.cycle?.state, 'finished')
    assert.equal(h.server.clients.size(), 1)

    // the cache now answers with everything the patches carried
    const { body: view } = await getJson<View>(`${h.base}/api/view`)
    assert.equal(view.version, patches.length)
    assert.equal(view.sync.cycle?.trigger, 'active')
    assert.equal(view.sync.ui.activeClients, 1)
    assert.equal(view.counts.mine.open + view.counts.others.open, 17)

    // hiding is reported by POST and patches the shared polling state
    assert.deepEqual((await send(`${h.base}/api/clients/tab-1`, 'POST', { visible: false, paused: false })).body, { active: false, cycle: null })
    const hidden = await stream.patch()
    assert.equal(hidden.version, patches.length + 1)
    assert.deepEqual(hidden.sync?.ui, { activeClients: 0, nextCycleAt: null })
    assert.equal(h.time.pending(), 1, 'only the keepalive timer is left')

    // returning within 30 seconds of the last start shows the cache and starts nothing
    assert.deepEqual((await send(`${h.base}/api/clients/tab-1`, 'POST', { visible: true, paused: false })).body, { active: true, cycle: null })
    const calls = githubCalls(h.runner).length
    assert.equal(calls > 0, true)

    // an id with no stream is unknown, and bad bodies are refused
    assert.equal((await send(`${h.base}/api/clients/tab-9`, 'POST', { visible: true, paused: false })).status, 404)
    assert.equal((await send(`${h.base}/api/clients/tab-1`, 'POST', { visible: 'yes' })).status, 400)
    assert.equal((await send(`${h.base}/api/clients/tab-1`, 'POST', '{"visible":true,"paused":false}', { 'Content-Type': 'text/plain' })).status, 415)

    stream.close()
    await until(() => h.server.clients.size() === 0)
    assert.equal(h.time.pending(), 0, 'no client, no timers')
    assert.equal(githubCalls(h.runner).length, calls)
  } finally {
    await h.cleanup()
  }
})

test('a stream opened hidden or paused causes no cycle, and keepalives arrive every 30 seconds', async () => {
  const h = await setup()
  try {
    const hidden = await openStream(h.base, 'client=tab-1&visible=false&paused=false')
    const paused = await openStream(h.base, 'client=tab-2&visible=true&paused=true')
    assert.equal(await hidden.frame(), ': connected')
    assert.equal(await paused.frame(), ': connected')
    await until(() => h.server.clients.size() === 2)
    h.time.advance(30_000)
    assert.equal(await hidden.frame(), ': keepalive')
    assert.equal(await paused.frame(), ': keepalive')
    h.time.advance(60 * 60_000)
    assert.equal(githubCalls(h.runner).length, 0)
    assert.equal(h.server.cache.latestCycle(scenario.repo), null)
    // bad stream queries are refused
    assert.equal((await raw(h.server.port, '/api/events?client=a%20b')).status, 400)
    assert.equal((await raw(h.server.port, '/api/events?client=tab-3&visible=maybe')).status, 400)
    hidden.close()
    paused.close()
  } finally {
    await h.cleanup()
  }
})

test('an idle page counts as paused: no active cycle, no interval, and its first activity refreshes under the 30-second rule', async () => {
  const h = await setup()
  try {
    // opened idle (a reconnect while idle), the page starts nothing
    const stream = await openStream(h.base, 'client=tab-1&visible=true&paused=false&idle=true')
    assert.equal(await stream.frame(), ': connected')
    await until(() => h.server.clients.size() === 1)
    assert.deepEqual(h.server.clients.get('tab-1'), { visible: true, paused: false, idle: true })
    h.time.advance(60 * 60_000)
    assert.equal(githubCalls(h.runner).length, 0)

    // activity ends idle: the page is active and the active rule starts a cycle
    assert.deepEqual((await send(`${h.base}/api/clients/tab-1`, 'POST', { visible: true, paused: false, idle: false })).body, { active: true, cycle: 1 })
    await stream.untilCycleEnds()
    await h.server.poller.idle()
    assert.equal(h.time.pending(), 2, 'the keepalive and the interval timer')

    // going idle while visible clears the interval timer and nextCycleAt, as pausing does
    assert.deepEqual((await send(`${h.base}/api/clients/tab-1`, 'POST', { visible: true, paused: false, idle: true })).body, { active: false, cycle: null })
    assert.deepEqual((await stream.patch()).sync?.ui, { activeClients: 0, nextCycleAt: null })
    assert.equal(h.time.pending(), 1, 'only the keepalive timer is left')
    const calls = githubCalls(h.runner).length
    h.time.advance(3 * 60 * 60_000)
    assert.equal(githubCalls(h.runner).length, calls)

    // returning after hours refreshes once; a page that leaves idle out of its report is not idle
    assert.deepEqual((await send(`${h.base}/api/clients/tab-1`, 'POST', { visible: true, paused: false })).body, { active: true, cycle: 2 })
    const back = await stream.untilCycleEnds()
    assert.equal(back[0]?.sync?.cycle?.trigger, 'active')
    assert.equal((await send(`${h.base}/api/clients/tab-1`, 'POST', { visible: true, paused: false, idle: 'yes' })).status, 400)
    assert.equal((await raw(h.server.port, '/api/events?client=tab-2&idle=maybe')).status, 400)
    stream.close()
  } finally {
    await h.cleanup()
  }
})

test('POST /api/refresh starts a cycle whatever the clients, or joins the running one', async () => {
  const runner = gatedRunner(fixtureRunner())
  const h = await setup({ runner })
  try {
    assert.deepEqual((await send(`${h.base}/api/refresh`, 'POST')).body, { started: true, cycle: 1 })
    assert.deepEqual((await send(`${h.base}/api/refresh`, 'POST')).body, { started: false, cycle: 1 })
    // the view never waits on the held cycle
    const { body: view } = await getJson<View>(`${h.base}/api/view`)
    assert.equal(view.sync.cycle?.state, 'running')
    assert.equal(view.sync.cycle?.trigger, 'manual')
    runner.release()
    await h.server.poller.idle()
    assert.equal(h.server.cache.latestCycle(scenario.repo)?.state, 'finished')
    assert.equal(h.time.pending(), 0)
  } finally {
    await h.cleanup()
  }
})

// GitHub unreachable: gh exits as it does with no network, then the network comes back
test('with GitHub unreachable the view still answers from the cache with the failed cycle and stale rows, and the next interval cycle recovers', async () => {
  const base = fixtureRunner()
  let reachable = true
  const runner = fakeRunner((args) => !reachable && args[0] === 'api' ? failed('error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com') : base.runner(args))
  const h = await setup({ runner })
  try {
    const stream = await openStream(h.base, 'client=tab-1&visible=true&paused=false')
    await stream.untilCycleEnds()
    const { body: before } = await getJson<View>(`${h.base}/api/view`)

    reachable = false
    h.time.advance(300_000)
    const failing = await stream.untilCycleEnds()
    const end = failing[failing.length - 1]!
    assert.equal(end.sync?.cycle?.trigger, 'interval')
    assert.equal(end.sync?.cycle?.state, 'failed')
    assert.match(end.sync?.cycle?.error ?? '', /error connecting/)
    // the end patch re-sends every row the cycle never reached, now stale
    assert.equal(end.rows.length, before.counts.mine.open + before.counts.others.open)
    assert.ok(end.rows.every((row) => row.freshness.state === 'stale'))

    const { status, body: down } = await getJson<View>(`${h.base}/api/view`)
    assert.equal(status, 200)
    assert.deepEqual(down.counts, before.counts)
    assert.deepEqual(down.closed.today.rows, before.closed.today.rows)
    assert.equal(down.sync.lastSuccessAt, before.sync.lastSuccessAt)
    assert.deepEqual([down.sync.sections.open.state, down.sync.sections.closed.state], ['stale', 'stale'])
    assert.match(down.sync.sections.open.error ?? '', /error connecting/)
    assert.ok([...down.mine.groups, ...down.others.groups].every((group) => group.rows.every((row) => row.freshness.state === 'stale')))
    // the retry waits for the interval, as the banner says
    assert.equal(down.sync.ui.nextCycleAt, new Date(Date.parse(end.sync!.cycle!.startedAt) + 300_000).toISOString().replace('.000Z', 'Z'))

    reachable = true
    h.time.advance(300_000)
    const recovered = await stream.untilCycleEnds()
    assert.equal(recovered[recovered.length - 1]?.sync?.cycle?.state, 'finished')
    const { body: back } = await getJson<View>(`${h.base}/api/view`)
    assert.deepEqual([back.sync.sections.open.state, back.sync.sections.closed.state], ['current', 'current'])
    assert.ok([...back.mine.groups, ...back.others.groups].every((group) => group.rows.every((row) => row.freshness.state === 'current')))
    stream.close()
  } finally {
    await h.cleanup()
  }
})

test('with an empty cache and GitHub unreachable, the view answers with loading sections and the failed cycle', async () => {
  const runner = fakeRunner((args) => args[0] === 'api' ? failed('error connecting to api.github.com') : fixtureRunner().runner(args))
  const h = await setup({ runner })
  try {
    assert.deepEqual((await send(`${h.base}/api/refresh`, 'POST')).body, { started: true, cycle: 1 })
    await h.server.poller.idle()
    const { status, body: view } = await getJson<View>(`${h.base}/api/view`)
    assert.equal(status, 200)
    assert.equal(view.sync.cycle?.state, 'failed')
    assert.deepEqual([view.sync.sections.open.state, view.sync.sections.closed.state], ['loading', 'loading'])
    assert.equal(view.sync.lastSuccessAt, null)
    assert.ok(view.mine.groups.every((group) => group.rows.length === 0))
  } finally {
    await h.cleanup()
  }
})

test('GET and PUT /api/config read, validate and save the config, and a change that needs it starts a config cycle', async () => {
  const h = await setup()
  try {
    const { body: stored } = await getJson<Config>(`${h.base}/api/config`)
    assert.equal(stored.repo, scenario.repo)
    assert.equal(stored.refreshSeconds, 300)

    const bad = await send(`${h.base}/api/config`, 'PUT', { ...stored, refreshSeconds: 10 })
    assert.equal(bad.status, 400)
    assert.match(String(bad.body.error), /refreshSeconds/)
    assert.equal((await send(`${h.base}/api/config`, 'PUT', '{nope')).status, 400)

    const next = { ...stored, refreshSeconds: 60, people: [{ login: 'alex-mendez', alias: 'Alex', initials: 'AM', color: '#0F766E', avatar: 'github' }] }
    const saved = await send(`${h.base}/api/config`, 'PUT', next)
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.body, next)
    assert.deepEqual(JSON.parse(await readFile(h.configPath, 'utf8')), next)
    await h.server.poller.idle()
    assert.equal(h.server.cache.latestCycle(scenario.repo)?.trigger, 'config')
    const { body: view } = await getJson<View>(`${h.base}/api/view`)
    assert.equal(view.sync.refreshSeconds, 60)

    // display-only settings start no cycle
    const cycles = h.server.cache.latestCycle(scenario.repo)?.id
    assert.equal((await send(`${h.base}/api/config`, 'PUT', { ...next, density: 'compact' })).status, 200)
    await h.server.poller.idle()
    assert.equal(h.server.cache.latestCycle(scenario.repo)?.id, cycles)
  } finally {
    await h.cleanup()
  }
})

test('static files come from public/, with .ts served as JavaScript and nothing outside the folder', async () => {
  const h = await setup({
    files: {
      'public/index.html': '<!-- public/index.html -->\n<!doctype html><title>Pit View</title>\n',
      'public/app.ts': '// public/app.ts\nimport type { View } from \'./types.ts\'\nconst greet = (view: View | null): string => \'ready\'\nexport { greet }\n',
      'public/broken.ts': 'const = ;\n',
      'public/.secret': 'hidden',
      'outside.txt': 'not public',
    },
  })
  try {
    const index = await raw(h.server.port, '/')
    assert.equal(index.status, 200)
    assert.match(index.type, /^text\/html/)
    assert.match(index.body, /<title>Pit View<\/title>/)

    const app = await raw(h.server.port, '/app.ts')
    assert.equal(app.status, 200)
    assert.match(app.type, /^text\/javascript/)
    assert.match(app.body, /const greet = \(view\s*\)\s*=> 'ready'/)
    assert.doesNotMatch(app.body, /import type|: string/)
    // served again from memory until the file changes
    assert.equal((await raw(h.server.port, '/app.ts')).body, app.body)
    await writeFile(join(h.home, 'public', 'app.ts'), '// public/app.ts\nexport const later: number = 2\n')
    const changed = await raw(h.server.port, '/app.ts')
    assert.match(changed.body, /export const later\s*= 2/)

    assert.equal((await raw(h.server.port, '/broken.ts')).status, 500)
    assert.equal((await raw(h.server.port, '/.secret')).status, 404)
    assert.equal((await raw(h.server.port, '/%2e%2e/outside.txt')).status, 404)
    assert.equal((await raw(h.server.port, '/..%2foutside.txt')).status, 404)
    assert.equal((await raw(h.server.port, '/missing.css')).status, 404)
    assert.equal((await raw(h.server.port, '/api/missing')).status, 404)
    assert.equal((await raw(h.server.port, '/', {}, 'POST')).status, 405)
    assert.equal((await raw(h.server.port, '/api/view', {}, 'DELETE')).status, 405)
  } finally {
    await h.cleanup()
  }
})

test('requests for another host name, or writes from another origin, are refused', async () => {
  const h = await setup()
  try {
    assert.equal((await raw(h.server.port, '/api/view', { Host: 'pit-view.attacker.test' })).status, 403)
    assert.equal((await raw(h.server.port, '/api/view', { Host: `localhost:${h.server.port}` })).status, 200)
    assert.equal((await send(`${h.base}/api/refresh`, 'POST', undefined, { Origin: 'http://attacker.test' })).status, 403)
    assert.equal(h.server.cache.latestCycle(scenario.repo), null)
    assert.equal((await send(`${h.base}/api/refresh`, 'POST', undefined, { Origin: h.base })).status, 200)
    await h.server.poller.idle()
  } finally {
    await h.cleanup()
  }
})

test('hostAllowed accepts the loopback names on the server\'s port, and allowed hosts with any port or none', () => {
  const allowed = ['pit.example.test']
  for (const header of ['127.0.0.1:4791', 'localhost:4791', '[::1]:4791', 'pit.example.test', 'pit.example.test:443', 'PIT.Example.test:8443']) {
    assert.equal(hostAllowed(header, 4791, allowed), true, header)
  }
  for (const header of [undefined, '', '127.0.0.1', '127.0.0.1:4792', 'localhost', 'pit.example.test.evil.test', 'evil.pit.example.test', 'pit.example.test:', 'pit.example.test:abc', 'pit.example.test/x', 'user@pit.example.test']) {
    assert.equal(hostAllowed(header, 4791, allowed), false, String(header))
  }
  assert.equal(hostAllowed('pit.example.test', 4791, []), false)
})

test('originAllowed accepts the loopback origins, and http or https on an allowed host', () => {
  const allowed = ['pit.example.test']
  for (const origin of ['http://127.0.0.1:4791', 'http://localhost:4791', 'http://[::1]:4791', 'https://pit.example.test', 'http://pit.example.test', 'https://pit.example.test:8443', 'HTTPS://PIT.EXAMPLE.TEST']) {
    assert.equal(originAllowed(origin, 4791, allowed), true, origin)
  }
  for (const origin of ['null', 'http://127.0.0.1:4792', 'https://127.0.0.1:4791', 'http://attacker.test', 'https://pit.example.test.attacker.test', 'ftp://pit.example.test', 'https://pit.example.test/', 'https://user@pit.example.test', 'pit.example.test']) {
    assert.equal(originAllowed(origin, 4791, allowed), false, origin)
  }
  assert.equal(originAllowed('https://pit.example.test', 4791, []), false)
})

test('with allowedHosts set, a proxied host is served, its page may write, and the event stream is unbuffered with keepalives', async () => {
  const h = await setup({ config: { allowedHosts: ['pit.example.test'] } })
  try {
    assert.equal((await raw(h.server.port, '/api/view', { Host: 'pit.example.test' })).status, 200)
    assert.equal((await raw(h.server.port, '/api/view', { Host: 'other.example.test' })).status, 403)
    const write = (origin: string): Promise<{ status: number, type: string, body: string }> =>
      raw(h.server.port, '/api/refresh', { Host: 'pit.example.test', Origin: origin }, 'POST')
    assert.equal((await write('http://attacker.test')).status, 403)
    assert.equal(h.server.cache.latestCycle(scenario.repo), null)
    assert.equal((await write('https://pit.example.test')).status, 200)
    await h.server.poller.idle()

    // a stream through the proxy's Host: headers that keep a proxy from buffering, then keepalives
    const stream = await new Promise<{ headers: Record<string, unknown>, next: () => Promise<string>, close: () => void }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: h.server.port, path: '/api/events?client=proxied&visible=false&paused=false', headers: { Host: 'pit.example.test' } }, (res) => {
        res.setEncoding('utf8')
        let buffer = ''
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
        const next = (): Promise<string> => new Promise((resolveFrame) => {
          waiting.push(resolveFrame)
          drain()
        })
        resolve({ headers: res.headers, next, close: () => req.destroy() })
      })
      req.on('error', reject)
      req.end()
    })
    assert.match(String(stream.headers['content-type']), /^text\/event-stream/)
    assert.match(String(stream.headers['cache-control']), /no-cache/)
    assert.match(String(stream.headers['cache-control']), /no-transform/)
    assert.equal(stream.headers['x-accel-buffering'], 'no')
    assert.equal(stream.headers['content-length'], undefined)
    assert.equal(await stream.next(), ': connected')
    await until(() => h.server.clients.size() === 1)
    h.time.advance(30_000)
    assert.equal(await stream.next(), ': keepalive')
    h.time.advance(30_000)
    assert.equal(await stream.next(), ': keepalive')
    stream.close()
  } finally {
    await h.cleanup()
  }
})

test('allowedHosts saved through PUT /api/config apply at once, and a malformed one is refused', async () => {
  const h = await setup()
  try {
    assert.equal((await raw(h.server.port, '/api/view', { Host: 'pit.example.test' })).status, 403)
    const { body: stored } = await getJson<Config>(`${h.base}/api/config`)
    assert.deepEqual(stored.allowedHosts, [])
    const bad = await send(`${h.base}/api/config`, 'PUT', { ...stored, allowedHosts: ['https://pit.example.test'] })
    assert.equal(bad.status, 400)
    assert.match(String(bad.body.error), /allowedHosts/)
    assert.equal((await send(`${h.base}/api/config`, 'PUT', { ...stored, allowedHosts: ['Pit.Example.Test'] })).status, 200)
    assert.deepEqual(JSON.parse(await readFile(h.configPath, 'utf8')).allowedHosts, ['pit.example.test'])
    assert.equal((await raw(h.server.port, '/api/view', { Host: 'pit.example.test' })).status, 200)
    await h.server.poller.idle()
  } finally {
    await h.cleanup()
  }
})

test('a local avatar is served from its configured file under home, and nothing else is', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const h = await setup({
    config: {
      people: [
        { login: 'vera-quill', alias: 'Vera', initials: 'VQ', color: '#1D4ED8', avatar: '~/pictures/vera.png' },
        { login: 'lee-park', alias: 'Lee', initials: 'LP', color: '#BE123C', avatar: '~/pictures/lee.svg' },
        { login: 'sam-tran', alias: 'Sam', initials: 'ST', color: '#7C3AED', avatar: '~/../escape.png' },
        { login: 'priya-k', alias: 'Priya', initials: 'PK', color: '#B45309', avatar: 'initials' },
      ],
    },
    files: { 'pictures/vera.png': png, 'pictures/lee.svg': '<svg/>' },
  })
  try {
    const { body: view } = await getJson<View>(`${h.base}/api/view`)
    assert.equal(view.viewer.avatarUrl, '/api/avatar/vera-quill')
    const response = await fetch(`${h.base}${view.viewer.avatarUrl}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png)
    assert.equal((await raw(h.server.port, '/api/avatar/Vera-Quill')).status, 200)
    assert.equal((await raw(h.server.port, '/api/avatar/lee-park')).status, 404)
    assert.equal((await raw(h.server.port, '/api/avatar/sam-tran')).status, 404)
    assert.equal((await raw(h.server.port, '/api/avatar/priya-k')).status, 404)
    assert.equal((await raw(h.server.port, '/api/avatar/nobody')).status, 404)
  } finally {
    await h.cleanup()
  }
})

test('people suggestions list the cached logins that config.people does not', async () => {
  const h = await setup({ config: { people: [{ login: 'alex-mendez', alias: 'Alex', initials: 'AM', color: '#0F766E', avatar: 'github' }] } })
  try {
    assert.deepEqual((await getJson(`${h.base}/api/people/suggestions`)).body, [])
    await send(`${h.base}/api/refresh`, 'POST')
    await h.server.poller.idle()
    const { body } = await getJson<{ login: string, avatarUrl: string, count: number }[]>(`${h.base}/api/people/suggestions`)
    const logins = body.map((entry) => entry.login)
    assert.ok(logins.includes('sam-tran'))
    assert.ok(logins.includes('dependabot'))
    assert.ok(!logins.includes('alex-mendez'))
    // the viewer always shows as You
    assert.ok(!logins.some((login) => login.toLowerCase() === scenario.viewer.toLowerCase()))
    assert.ok(body.every((entry) => entry.count > 0 && entry.avatarUrl.startsWith('https://')))
  } finally {
    await h.cleanup()
  }
})

test('a port already in use is an error naming the port, and the running server\'s cache is left alone', async () => {
  const runner = gatedRunner(fixtureRunner())
  const h = await setup({ runner })
  try {
    // the running server is mid-cycle; a second start must not mark that cycle interrupted
    const { cycle } = h.server.poller.refresh('manual')
    await assert.rejects(startServer({
      home: h.home,
      port: h.server.port,
      runner: fixtureRunner().runner,
      clock: h.time.clock,
      timers: h.time.timers,
      timeZone: scenario.timeZone,
      configPath: h.configPath,
      cachePath: join(h.home, '.local', 'state', 'pit-view', 'cache.sqlite'),
      publicDir: join(h.home, 'public'),
      log: () => {},
    }), (error: unknown) => error instanceof PortInUseError && error.message.includes(String(h.server.port)))
    assert.equal(h.server.cache.cycle(cycle!)?.state, 'running')
    runner.release()
    await h.server.poller.idle()
    assert.equal(h.server.cache.cycle(cycle!)?.state, 'finished')
  } finally {
    await h.cleanup()
  }
})

test('GET /api/instance names the default instance, its config file under ~ and its process', async () => {
  const h = await setup()
  try {
    const { status, body } = await getJson<Record<string, unknown>>(`${h.base}/api/instance`)
    assert.equal(status, 200)
    assert.deepEqual(body, { name: '', configPath: '~/.config/pit-view/config.json', pid: process.pid })
  } finally {
    await h.cleanup()
  }
})

test('a dev instance runs beside the app with its own config and cache, sharing neither', async () => {
  const h = await setup()
  const dev = resolveRuntime({ PIT_VIEW_INSTANCE: 'dev' }, h.home)
  await mkdir(join(dev.configPath, '..'), { recursive: true })
  await writeFile(dev.configPath, JSON.stringify({ repo: scenario.repo, viewer: scenario.viewer }), 'utf8')
  const server = await startServer({
    home: h.home,
    instance: dev.instance,
    port: 0,
    runner: fixtureRunner().runner,
    clock: h.time.clock,
    timers: h.time.timers,
    timeZone: scenario.timeZone,
    configPath: dev.configPath,
    cachePath: dev.cachePath,
    publicDir: join(h.home, 'public'),
    log: () => {},
    pageSize: scenario.pageSize,
  })
  try {
    const { body } = await getJson<Record<string, unknown>>(`${server.url}/api/instance`)
    assert.deepEqual(body, { name: 'dev', configPath: '~/.config/pit-view-dev/config.json', pid: process.pid })
    const stored = (await getJson<Config>(`${server.url}/api/config`)).body
    const saved = await send(`${server.url}/api/config`, 'PUT', { ...stored, repo: 'octo-org/dev-only' })
    assert.equal(saved.status, 200)
    assert.equal(JSON.parse(await readFile(dev.configPath, 'utf8')).repo, 'octo-org/dev-only')
    assert.equal(JSON.parse(await readFile(h.configPath, 'utf8')).repo, scenario.repo)
    assert.equal((await getJson<View>(`${h.base}/api/view`)).body.repo, scenario.repo)
    await server.poller.idle()
    // the save started a config cycle in the dev cache only
    assert.notEqual(server.cache.latestCycle('octo-org/dev-only'), null)
    assert.equal(h.server.cache.latestCycle('octo-org/dev-only'), null)
    assert.notEqual(dev.cachePath, join(h.home, '.local', 'state', 'pit-view', 'cache.sqlite'))
  } finally {
    await server.close()
    await h.cleanup()
  }
})

test('an empty viewer is read from gh\'s local config at start, not from the GitHub API', async () => {
  const base = fixtureRunner()
  const runner: FakeRunner = {
    calls: base.calls,
    runner: async (args, options) => {
      if (args[0] === 'config' && args[1] === 'get') {
        base.calls.push({ args, options })
        return { code: 0, stdout: `${scenario.viewer}\n`, stderr: '' }
      }
      return base.runner(args, options)
    },
  }
  const h = await setup({ runner, config: { viewer: '' } })
  try {
    const { body: view } = await getJson<View>(`${h.base}/api/view`)
    assert.equal(view.viewer.login, scenario.viewer)
    assert.equal(githubCalls(runner).length, 0)
    // the stored config keeps its empty viewer
    assert.equal((await getJson<Config>(`${h.base}/api/config`)).body.viewer, '')
  } finally {
    await h.cleanup()
  }
})

test('close ends the open streams and fails the cycle in flight', async () => {
  const runner = gatedRunner(fixtureRunner())
  const h = await setup({ runner })
  const stream = await openStream(h.base, 'client=tab-1&visible=true&paused=false')
  const first = await stream.patch()
  assert.equal(first.sync?.cycle?.state, 'running')
  const cache = h.server.cache
  const cycle = cache.runningCycle()
  await h.server.close()
  await assert.rejects(stream.frame(), /ended|terminated|aborted/i)
  runner.release()
  // the cache is closed; reopening it shows the cycle failed by the shutdown
  const reopened = openCache({ path: join(h.home, '.local', 'state', 'pit-view', 'cache.sqlite'), clock: h.time.clock })
  assert.equal(reopened.cycle(cycle!.id)?.state, 'failed')
  assert.match(reopened.cycle(cycle!.id)?.error ?? '', /^stopped/)
  reopened.close()
  await delay(10)
  await rm(h.home, { recursive: true, force: true })
})

// one-PR refreshes

const isSingle = (args: string[]): boolean => args[0] === 'api' && (field(args, 'query') ?? '').includes('query SinglePullRequest')

// the fixture gh, with the one-PR query answered by answer whenever it returns a result
const withSingle = (answer: (number: number) => RunResult | null | Promise<RunResult | null>): FakeRunner => {
  const base = fixtureRunner()
  return fakeRunner(async (args) => (isSingle(args) ? await answer(Number(field(args, 'number'))) : null) ?? base.runner(args))
}

const singleCalls = (fake: FakeRunner) => githubCalls(fake).filter((call) => isSingle(call.args))

const rowsOf = (view: View): OpenRow[] => [...view.mine.groups, ...view.others.groups].flatMap((group) => group.rows as OpenRow[])

const rowIn = (view: View, number: number): OpenRow | undefined => rowsOf(view).find((row) => row.number === number)

const filled = async (h: Harness): Promise<void> => {
  assert.equal((await send(`${h.base}/api/refresh`, 'POST')).status, 200)
  await h.server.poller.idle()
}

test('POST /api/prs/<n>/refresh fetches that PR alone and patches its row to every page, paused and hidden ones too, with no cycle', async () => {
  const retitled = 'fix(webhooks): retry with backoff, take two'
  const runner = withSingle(async (number) => number === 101 ? ok(JSON.stringify(await singlePr(101, { patch: { title: retitled } }))) : null)
  const h = await setup({ runner })
  try {
    await filled(h)
    const paused = await openStream(h.base, 'client=tab-1&visible=true&paused=true')
    const hidden = await openStream(h.base, 'client=tab-2&visible=false&paused=false')
    const before = githubCalls(runner).length
    const { status, body } = await send(`${h.base}/api/prs/101/refresh`, 'POST')
    assert.equal(status, 200)
    assert.deepEqual(body, { number: 101, outcome: 'open', joined: false, error: null, errorKind: null })
    // exactly one GitHub call, the one-PR query for #101
    const made = githubCalls(runner).slice(before)
    assert.equal(made.length, 1)
    assert.match(field(made[0]!.args, 'query') ?? '', /^query SinglePullRequest\(/)
    assert.equal(field(made[0]!.args, 'number'), '101')
    for (const stream of [paused, hidden]) {
      // first the row alone, marked refreshing
      const started = await stream.patch()
      assert.deepEqual(started.rows.map((row) => [row.number, row.refresh?.state]), [[101, 'running']])
      assert.deepEqual([started.removed, started.tiles, started.sync], [[], undefined, undefined])
      // then the fetched row, with tiles and counts, and no sync: no cycle ran
      const done = await stream.patch()
      assert.equal(done.version, started.version + 1)
      const row = done.rows.find((entry) => entry.number === 101)
      assert.deepEqual([row?.title, row?.refresh, row?.freshness.state], [retitled, null, 'current'])
      assert.ok(done.rows.every((entry) => entry.number === 101))
      assert.ok(done.tiles !== undefined && done.counts !== undefined)
      assert.equal(done.sync, undefined)
      stream.close()
    }
    assert.equal(h.server.cache.latestCycle(scenario.repo)?.id, 1)
    assert.equal(h.server.cache.runningCycle(), null)
    const { body: view } = await getJson<View>(`${h.base}/api/view`)
    assert.equal(rowIn(view, 101)?.title, retitled)
    assert.equal(view.sync.cycle?.id, 1)
  } finally {
    await h.cleanup()
  }
})

test('refreshes of one PR already in flight are joined, each PR asking GitHub once', async () => {
  const runner = gatedRunner(fixtureRunner())
  const h = await setup({ runner })
  try {
    runner.release()
    await filled(h)
    runner.hold()
    const asks = [101, 101, 104].map((number) => send(`${h.base}/api/prs/${number}/refresh`, 'POST'))
    await delay(30)
    runner.release()
    const answers = await Promise.all(asks)
    assert.deepEqual(answers.map((answer) => [answer.body.number, answer.body.outcome]), [[101, 'open'], [101, 'open'], [104, 'open']])
    assert.deepEqual([answers[0]!.body.joined, answers[1]!.body.joined].sort(), [false, true])
    assert.equal(answers[2]!.body.joined, false)
    assert.deepEqual(singleCalls(runner).map((call) => field(call.args, 'number')).sort(), ['101', '104'])
    // done is done: the next ask fetches again
    assert.equal((await send(`${h.base}/api/prs/101/refresh`, 'POST')).body.joined, false)
    assert.equal(singleCalls(runner).length, 3)
  } finally {
    await h.cleanup()
  }
})

test('a PR found merged or closed leaves the open rows at once, and the next cycle\'s closed search shows it', async () => {
  const runner = withSingle(async (number) => number === 102 ? ok(JSON.stringify(await singlePr(102, { state: 'MERGED' }))) : null)
  const h = await setup({ runner })
  try {
    await filled(h)
    const { body: before } = await getJson<View>(`${h.base}/api/view`)
    const stream = await openStream(h.base, 'client=tab-1&visible=true&paused=true')
    assert.deepEqual((await send(`${h.base}/api/prs/102/refresh`, 'POST')).body, { number: 102, outcome: 'closed', joined: false, error: null, errorKind: null })
    await stream.patch()
    const done = await stream.patch()
    assert.deepEqual([done.removed, done.rows], [[102], []])
    assert.equal(done.counts?.mine.open, before.counts.mine.open - 1)
    assert.equal(done.tiles?.mineReadyToMerge, before.tiles.mineReadyToMerge - 1)
    stream.close()
    const { body: after } = await getJson<View>(`${h.base}/api/view`)
    assert.equal(rowIn(after, 102), undefined)
    // Closed is the closed search's, unchanged until the next cycle
    assert.deepEqual(after.closed, before.closed)
    const stored = h.server.cache.db.prepare('SELECT state FROM prs WHERE repo = $repo AND number = 102').get({ repo: scenario.repo })
    assert.equal(stored?.state, 'closed')
    assert.equal(h.server.cache.latestCycle(scenario.repo)?.id, 1)
  } finally {
    await h.cleanup()
  }
})

test('a failed one-PR refresh stays on its row with its kind, and the board never reads offline', async () => {
  let mode: 'up' | 'auth' | 'limited' | 'down' | 'missing' = 'up'
  const runner = withSingle((number) => {
    if (mode === 'auth') return failed('HTTP 401: Bad credentials (https://api.github.com/graphql)')
    if (mode === 'limited') return { code: 1, stdout: JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }), stderr: '' }
    if (mode === 'down') return failed('error connecting to api.github.com')
    if (mode === 'missing') return { code: 1, stdout: JSON.stringify({ errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a PullRequest with the number of ${number}.` }] }), stderr: '' }
    return null
  })
  const h = await setup({ runner })
  try {
    await filled(h)
    for (const [next, kind] of [['auth', 'auth'], ['limited', 'rateLimit'], ['down', 'network'], ['missing', 'graphql']] as const) {
      mode = next
      const { status, body } = await send(`${h.base}/api/prs/101/refresh`, 'POST')
      assert.equal(status, 200)
      assert.deepEqual([body.outcome, body.errorKind, typeof body.error], ['failed', kind, 'string'])
      const { body: view } = await getJson<View>(`${h.base}/api/view`)
      const row = rowIn(view, 101)
      assert.deepEqual([row?.refresh?.state, row?.refresh?.state === 'failed' ? row.refresh.errorKind : null], ['failed', kind])
      // the cached row and every section stay as they were; no cycle failed
      assert.equal(row?.freshness.state, 'current')
      assert.deepEqual([view.sync.cycle?.state, view.sync.cycle?.errorKind], ['finished', null])
      assert.deepEqual([view.sync.sections.open.state, view.sync.sections.closed.state], ['current', 'current'])
      assert.ok(rowsOf(view).filter((entry) => entry.number !== 101).every((entry) => entry.refresh === null))
    }
    // a cycle that fetches the row clears its failure
    mode = 'up'
    await filled(h)
    assert.equal(rowIn((await getJson<View>(`${h.base}/api/view`)).body, 101)?.refresh, null)
    // and so does a refresh of its own that succeeds
    mode = 'auth'
    await send(`${h.base}/api/prs/101/refresh`, 'POST')
    mode = 'up'
    assert.equal((await send(`${h.base}/api/prs/101/refresh`, 'POST')).body.outcome, 'open')
    assert.equal(rowIn((await getJson<View>(`${h.base}/api/view`)).body, 101)?.refresh, null)
  } finally {
    await h.cleanup()
  }
})

test('a one-PR refresh re-derives the stacks it moves and rescans its own self-review report', async () => {
  const runner = withSingle(async (number) => number === 111 ? ok(JSON.stringify(await singlePr(111, { patch: { baseRefName: 'main' } }))) : null)
  const h = await setup({ runner })
  try {
    await filled(h)
    const { body: before } = await getJson<View>(`${h.base}/api/view`)
    assert.deepEqual([110, 111, 112].map((number) => rowIn(before, number)?.stack), [{ position: 1, size: 3 }, { position: 2, size: 3 }, { position: 3, size: 3 }])
    const stream = await openStream(h.base, 'client=tab-1&visible=false&paused=false')
    await send(`${h.base}/api/prs/111/refresh`, 'POST')
    await stream.patch()
    const done = await stream.patch()
    // #111 now starts its own stack: every row whose stack changed comes along
    assert.deepEqual(done.rows.map((row) => [row.number, row.stack]).sort((a, b) => Number(a[0]) - Number(b[0])), [
      [110, null], [111, { position: 1, size: 2 }], [112, { position: 2, size: 2 }],
    ])
    stream.close()

    // a self-review written since the last cycle shows on the next refresh of that PR
    assert.equal((rowIn(before, 101) as MineRow).selfReview.state, 'none')
    await mkdir(join(h.home, 'agents', 'output'), { recursive: true })
    await writeFile(join(h.home, 'agents', 'output', 'PR-101.md'), 'Reviewed commit: `fix/webhook-retry` @ `e37eacd`\n', 'utf8')
    await send(`${h.base}/api/prs/101/refresh`, 'POST')
    assert.equal((rowIn((await getJson<View>(`${h.base}/api/view`)).body, 101) as MineRow).selfReview.state, 'current')
  } finally {
    await h.cleanup()
  }
})

test('a one-PR refresh passes the Host, Origin and content-type checks for writes, and wants a PR number', async () => {
  const h = await setup()
  try {
    await filled(h)
    const before = githubCalls(h.runner).length
    assert.equal((await send(`${h.base}/api/prs/101/refresh`, 'POST', undefined, { Origin: 'http://attacker.test' })).status, 403)
    assert.equal((await raw(h.server.port, '/api/prs/101/refresh', { Host: 'pit-view.attacker.test' }, 'POST')).status, 403)
    assert.equal((await send(`${h.base}/api/prs/101/refresh`, 'POST', 'number=101', { 'Content-Type': 'text/plain' })).status, 415)
    assert.equal((await send(`${h.base}/api/prs/abc/refresh`, 'POST')).status, 400)
    assert.equal((await send(`${h.base}/api/prs/0/refresh`, 'POST')).status, 400)
    assert.equal((await raw(h.server.port, '/api/prs/101/refresh')).status, 405)
    assert.equal(githubCalls(h.runner).length, before)
    // the page's own origin, with no body or a JSON one
    assert.equal((await send(`${h.base}/api/prs/101/refresh`, 'POST', undefined, { Origin: h.base })).status, 200)
    assert.equal((await send(`${h.base}/api/prs/101/refresh`, 'POST', {})).status, 200)
    assert.equal(singleCalls(h.runner).length, 2)
  } finally {
    await h.cleanup()
  }
})
