// test/server.test.ts
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { openCache } from '../src/cache.ts'
import type { Config } from '../src/config.ts'
import type { Patch, View } from '../src/poller.ts'
import { hostAllowed, originAllowed, PortInUseError, resolveRuntime, startServer } from '../src/server.ts'
import type { PitServer } from '../src/server.ts'
import { iso } from '../src/time.ts'
import { scenario } from './fixtures/scenario.ts'
import type { MineRow, OpenRow } from '../src/derive.ts'
import type { RunResult } from '../src/github.ts'
import { emptySweepResult, failed, fakeLaunch, fakeRunner, fakeTime, field, fixtureRunner, gatedRunner, githubCalls, ok, singlePr, sweepResult, tempDir } from './helpers.ts'
import type { FakeLaunch, FakeRunner, FakeTime } from './helpers.ts'

type Harness = { server: PitServer, time: FakeTime, runner: FakeRunner, launch: FakeLaunch, home: string, configPath: string, base: string, cleanup: () => Promise<void> }

const setup = async ({ config = {}, runner = fixtureRunner(), files = {}, launch = fakeLaunch() }: {
  config?: Partial<Config>
  runner?: FakeRunner
  launch?: FakeLaunch
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
    stateDir: join(home, '.local', 'state', 'pit-view'),
    publicDir: join(home, 'public'),
    launch: launch.deps,
    log: () => {},
    pageSize: scenario.pageSize,
  })
  // closes the server the harness holds now, which a restart may have replaced
  const cleanup = async (): Promise<void> => {
    await harness.server.close()
    await removeHome()
  }
  const harness: Harness = { server, time, runner, launch, home, configPath, base: server.url, cleanup }
  return harness
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

test('a reload within the interval keeps the schedule: no active cycle on arrival, and the interval cycle on time', async () => {
  const h = await setup()
  try {
    const first = await openStream(h.base, 'client=load-1&visible=true&paused=false')
    await first.untilCycleEnds()
    await h.server.poller.idle()
    const startedAt = h.server.cache.latestCycle(scenario.repo)?.startedAt ?? ''
    first.close()
    await until(() => h.server.clients.size() === 0)

    // two minutes on, the page reloads carrying the start its browser stored: nothing runs
    h.time.advance(2 * 60_000)
    const calls = githubCalls(h.runner).length
    const reload = await openStream(h.base, `client=load-2&visible=true&paused=false&lastUpdate=${encodeURIComponent(startedAt)}`)
    const arrived = await reload.patch()
    assert.deepEqual(arrived.sync?.ui, { activeClients: 1, nextCycleAt: iso(Date.parse(startedAt) + 300_000) })
    assert.equal(githubCalls(h.runner).length, calls)
    assert.equal(h.server.cache.latestCycle(scenario.repo)?.id, 1)

    // the interval cycle comes five minutes after the first start, not five after the reload
    h.time.advance(3 * 60_000)
    for (;;) {
      const next = await reload.patch()
      if (next.sync?.cycle?.id === 2 && next.sync.cycle.state !== 'running') break
    }
    assert.equal(h.server.cache.latestCycle(scenario.repo)?.trigger, 'interval')
    assert.equal(h.server.cache.latestCycle(scenario.repo)?.startedAt, iso(Date.parse(startedAt) + 300_000))
    await h.server.poller.idle()
    reload.close()
    await until(() => h.server.clients.size() === 0)

    // without a stored time, the same reload refreshes on arrival under the 30-second rule
    h.time.advance(2 * 60_000)
    const fresh = await openStream(h.base, 'client=load-3&visible=true&paused=false')
    const patches = await fresh.untilCycleEnds()
    assert.equal(patches.find((patch) => patch.sync?.cycle?.id === 3)?.sync?.cycle?.trigger, 'active')
    await h.server.poller.idle()
    fresh.close()

    assert.equal((await raw(h.server.port, '/api/events?client=load-4&lastUpdate=soon')).status, 400)
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
      stateDir: join(h.home, '.local', 'state', 'pit-view'),
      publicDir: join(h.home, 'public'),
      launch: fakeLaunch().deps,
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
    stateDir: dev.stateDir,
    publicDir: join(h.home, 'public'),
    launch: fakeLaunch().deps,
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

// phase 2: starting and stopping review runs

const page = (title: string): string => `<!-- public/${title}.html -->\n<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n</head>\n<body></body>\n</html>\n`

test('each served page carries this start\'s token in a meta tag, added at serve time and never written to disk', async () => {
  const files = { 'public/index.html': page('index'), 'public/settings.html': page('settings'), 'public/app.ts': '// public/app.ts\nexport const x = 1\n' }
  const h = await setup({ files })
  try {
    assert.match(h.server.token, /^[A-Za-z0-9_-]{43}$/)
    const tag = `<meta name="pit-view-token" content="${h.server.token}">\n</head>`
    for (const [path, name] of [['/', 'index'], ['/settings.html', 'settings']] as const) {
      const response = await fetch(`${h.base}${path}`)
      const body = await response.text()
      assert.ok(body.includes(tag), `${path} carries the token`)
      assert.equal(body.split('pit-view-token').length, 2)
      // a stored copy would hold a token the next start no longer accepts
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(await readFile(join(h.home, 'public', `${name}.html`), 'utf8'), page(name))
    }
    assert.ok(!(await (await fetch(`${h.base}/app.ts`)).text()).includes(h.server.token))
  } finally {
    await h.cleanup()
  }
})

const token = (h: Harness): Record<string, string> => ({ 'X-Pit-View-Token': h.server.token })

test('starting and stopping a run need the token as well as the Host and Origin checks; one run per PR', async () => {
  const h = await setup({ config: { cloneDir: '~/dev/orbit' } })
  try {
    await filled(h)
    const url = `${h.base}/api/prs/106/runs`
    assert.equal((await send(url, 'POST')).status, 403)
    assert.match(String((await send(url, 'POST', undefined, { 'X-Pit-View-Token': 'not-the-token' })).body.error), /token/)
    assert.equal((await send(url, 'POST', undefined, { ...token(h), Origin: 'http://attacker.test' })).status, 403)
    assert.equal((await raw(h.server.port, '/api/prs/106/runs', { ...token(h), Host: 'pit-view.attacker.test' }, 'POST')).status, 403)
    assert.equal(h.launch.children.length, 0)

    const started = await send(url, 'POST', { repo: scenario.repo }, { ...token(h), Origin: h.base })
    assert.equal(started.status, 200)
    assert.equal(started.body.status, 'running')
    assert.equal(started.body.command, 'review-pr')
    assert.deepEqual(started.body.args, ['106'])
    assert.equal(started.body.label, 'Re-review')
    assert.equal(started.body.runner, 'claude')
    assert.equal(started.body.cwd, '~/dev/orbit')
    assert.equal(h.launch.children.length, 1)
    const busy = await send(url, 'POST', { repo: scenario.repo }, token(h))
    assert.equal(busy.status, 409)
    assert.match(String(busy.body.error), /already in flight/)

    const id = Number(started.body.id)
    const listed = await getJson<Record<string, unknown>[]>(url)
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body.map((run) => run.id), [id])
    assert.deepEqual((await getJson<unknown[]>(`${h.base}/api/prs/113/runs`)).body, [])

    const stopUrl = `${h.base}/api/runs/${id}/stop`
    assert.equal((await send(stopUrl, 'POST')).status, 403)
    const settled = h.server.launcher.settled(id)
    const stopping = await send(stopUrl, 'POST', undefined, token(h))
    assert.equal(stopping.status, 200)
    assert.equal((await settled).status, 'stopped')
    assert.deepEqual(h.launch.kills, [{ pid: -h.launch.children[0]!.pid, signal: 'SIGTERM' }])
    assert.equal((await send(stopUrl, 'POST', undefined, token(h))).status, 409)
    assert.equal((await send(`${h.base}/api/runs/999/stop`, 'POST', undefined, token(h))).status, 404)
    assert.equal((await send(`${h.base}/api/runs/abc/stop`, 'POST', undefined, token(h))).status, 400)
    assert.equal((await getJson<Record<string, unknown>[]>(url)).body[0]?.status, 'stopped')

    // stopped, the PR may start again, with the other runner for this one run
    const codex = await send(url, 'POST', { repo: scenario.repo, runner: 'codex' }, token(h))
    assert.equal(codex.status, 200)
    assert.equal(codex.body.runner, 'codex')
    assert.deepEqual((await getJson<Record<string, unknown>[]>(url)).body.map((run) => run.id), [Number(codex.body.id), id])
  } finally {
    await h.cleanup()
  }
})

test('a start is refused with a clear error: unknown PR, no cloneDir, another gh account, a bad body', async () => {
  const h = await setup({ config: { cloneDir: '~/dev/orbit' } })
  try {
    await filled(h)
    const unknown = await send(`${h.base}/api/prs/999/runs`, 'POST', { repo: scenario.repo }, token(h))
    assert.equal(unknown.status, 422)
    assert.match(String(unknown.body.error), /#999 is not an open PR/)
    assert.equal((await send(`${h.base}/api/prs/abc/runs`, 'POST', { repo: scenario.repo }, token(h))).status, 400)
    assert.equal((await send(`${h.base}/api/prs/106/runs`, 'POST', { repo: scenario.repo, runner: 'hermes' }, token(h))).status, 400)
    assert.equal((await send(`${h.base}/api/prs/106/runs`, 'POST', { repo: scenario.repo, runner: 'claude', tandem: true }, token(h))).status, 400)
    assert.equal((await send(`${h.base}/api/prs/106/runs`, 'POST', 'runner=codex', { ...token(h), 'Content-Type': 'text/plain' })).status, 415)
    assert.equal(h.launch.children.length, 0)
  } finally {
    await h.cleanup()
  }
  const unset = await setup()
  try {
    await filled(unset)
    const refused = await send(`${unset.base}/api/prs/106/runs`, 'POST', { repo: scenario.repo }, token(unset))
    assert.equal(refused.status, 422)
    assert.match(String(refused.body.error), /set cloneDir/)
  } finally {
    await unset.cleanup()
  }
  const fixtures = fixtureRunner()
  const other = fakeRunner((args) => args[0] === 'api' && args[1] === 'user' ? ok('someone-else\n') : fixtures.runner(args))
  const mismatch = await setup({ runner: other, config: { cloneDir: '~/dev/orbit' } })
  try {
    await filled(mismatch)
    const refused = await send(`${mismatch.base}/api/prs/106/runs`, 'POST', { repo: scenario.repo }, token(mismatch))
    assert.equal(refused.status, 422)
    assert.match(String(refused.body.error), /gh is signed in as someone-else, but the viewer is vera-quill/)
    assert.equal(mismatch.launch.children.length, 0)
  } finally {
    await mismatch.cleanup()
  }
})

test('the view carries each row\'s Agent cell, and a start on the viewer\'s own PR passes --no-post', async () => {
  const h = await setup({ config: { cloneDir: '~/dev/orbit' } })
  try {
    await filled(h)
    const view = (await getJson<View>(`${h.base}/api/view`)).body
    assert.deepEqual([rowIn(view, 106)?.agent?.state, rowIn(view, 106)?.agent?.action.label], ['idle', 'Re-review'])
    assert.deepEqual(rowIn(view, 113)?.agent?.action, { kind: 'review', label: 'Review', command: 'review-pr', args: ['113'], runner: 'claude' })
    assert.deepEqual(rowIn(view, 101)?.agent?.action.args, ['101', '--no-post'])
    assert.equal(rowIn(view, 114)?.agent?.action.command, 'review-dependabot')
    const own = await send(`${h.base}/api/prs/101/runs`, 'POST', { repo: scenario.repo }, token(h))
    assert.equal(own.status, 200)
    assert.deepEqual(own.body.args, ['101', '--no-post'])
    assert.equal(own.body.label, 'Self-review')
    assert.match(h.launch.children[0]!.writes[0] ?? '', /\/review-pr 101 --no-post --emit-json=/)
    const after = rowIn((await getJson<View>(`${h.base}/api/view`)).body, 101)
    assert.deepEqual([after?.agent?.state, after?.agent?.runId, after?.agent?.label], ['running', Number(own.body.id), 'Self-review'])
  } finally {
    await h.cleanup()
  }
})

const lastWrite = (h: Harness): string => h.launch.children.at(-1)?.writes[0] ?? ''

test('a start takes a kind beside the runner: default, tandem (Claude only) or stack, each with its own command line and label', async () => {
  const h = await setup({ config: { cloneDir: '~/dev/orbit', agent: { runner: 'codex' } } })
  try {
    await filled(h)
    const url = (number: number): string => `${h.base}/api/prs/${number}/runs`
    const stop = async (run: Record<string, unknown>): Promise<void> => {
      const settled = h.server.launcher.settled(Number(run.id))
      await send(`${h.base}/api/runs/${run.id}/stop`, 'POST', undefined, token(h))
      await settled
    }

    // omitted and explicit default are the same start, with the configured runner
    const plain = await send(url(113), 'POST', { repo: scenario.repo, kind: 'default' }, token(h))
    assert.equal(plain.status, 200)
    assert.deepEqual([plain.body.runner, plain.body.label, plain.body.args, plain.body.tandem], ['codex', 'Review', ['113'], false])
    // Codex gets its request as an argument, not on stdin
    assert.equal(lastWrite(h), '')
    await stop(plain.body)

    // tandem with no runner is Claude's, whatever the configured default is
    const tandem = await send(url(113), 'POST', { repo: scenario.repo, kind: 'tandem' }, token(h))
    assert.equal(tandem.status, 200)
    assert.deepEqual([tandem.body.runner, tandem.body.command, tandem.body.args, tandem.body.label, tandem.body.tandem], ['claude', 'review-pr', ['113', '--tandem'], 'Tandem review', true])
    assert.match(lastWrite(h), /\/review-pr 113 --tandem --emit-json=/)
    assert.equal(tandem.body.steps instanceof Array && tandem.body.steps.length, 5)
    await stop(tandem.body)

    // on the viewer's own PR a tandem review still passes --no-post
    const own = await send(url(104), 'POST', { repo: scenario.repo, kind: 'tandem', runner: 'claude' }, token(h))
    assert.deepEqual([own.status, own.body.args, own.body.label], [200, ['104', '--tandem', '--no-post'], 'Tandem self-review'])
    assert.match(lastWrite(h), /\/review-pr 104 --tandem --no-post --emit-json=/)
    await stop(own.body)

    // a stack review starts from any layer, with either runner
    const stack = await send(url(111), 'POST', { repo: scenario.repo, kind: 'stack', runner: 'claude' }, token(h))
    assert.deepEqual([stack.status, stack.body.command, stack.body.args, stack.body.label], [200, 'review-stack', ['111'], 'Review stack'])
    assert.match(lastWrite(h), /^\{.*\/review-stack 111 --emit-json=/)
    await stop(stack.body)
    const codexStack = await send(url(112), 'POST', { repo: scenario.repo, kind: 'stack' }, token(h))
    assert.deepEqual([codexStack.status, codexStack.body.runner, codexStack.body.args], [200, 'codex', ['112']])
  } finally {
    await h.cleanup()
  }
})

test('a kind that cannot start is refused before anything runs: bad kind 400, tandem with Codex 400, not offered 422, and the usual checks still apply', async () => {
  const h = await setup({ config: { cloneDir: '~/dev/orbit' } })
  try {
    await filled(h)
    const url = (number: number): string => `${h.base}/api/prs/${number}/runs`
    assert.equal((await send(url(113), 'POST', { repo: scenario.repo, kind: 'lint' }, token(h))).status, 400)
    assert.equal((await send(url(113), 'POST', { repo: scenario.repo, kind: 7 }, token(h))).status, 400)
    // a body that is not a plain object of known fields, or a field of the wrong type, is 400
    assert.equal((await send(url(113), 'POST', { repo: scenario.repo, kind: null }, token(h))).status, 400)
    assert.equal((await send(url(113), 'POST', { repo: scenario.repo, runner: null }, token(h))).status, 400)
    assert.equal((await send(url(113), 'POST', ['tandem'], token(h))).status, 400)
    assert.equal((await send(url(113), 'POST', 'tandem', token(h))).status, 400)
    assert.equal((await send(url(113), 'POST', { repo: scenario.repo, kind: ['tandem'] }, token(h))).status, 400)
    assert.equal((await send(url(113), 'POST', { repo: scenario.repo, kind: { toString: 'tandem' } }, token(h))).status, 400)
    // an own __proto__ key (JSON.parse makes it a plain property) is an unknown field, not a prototype
    const proto = await fetch(url(113), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: h.base, ...token(h) },
      body: '{"__proto__":{"kind":"tandem"}}',
    })
    assert.equal(proto.status, 400)
    assert.equal((await send(url(113), 'POST', { repo: scenario.repo, kind: 'tandem', fix: true }, token(h))).status, 400)
    const codex = await send(url(113), 'POST', { repo: scenario.repo, kind: 'tandem', runner: 'codex' }, token(h))
    assert.equal(codex.status, 400)
    assert.match(String(codex.body.error), /tandem runs with Claude only/)
    const dependabot = await send(url(114), 'POST', { repo: scenario.repo, kind: 'tandem' }, token(h))
    assert.equal(dependabot.status, 422)
    assert.match(String(dependabot.body.error), /#114.*no tandem mode/)
    const flat = await send(url(113), 'POST', { repo: scenario.repo, kind: 'stack' }, token(h))
    assert.equal(flat.status, 422)
    assert.match(String(flat.body.error), /#113.*not part of a stack/)
    assert.equal((await send(url(999), 'POST', { repo: scenario.repo, kind: 'tandem' }, token(h))).status, 422)
    assert.equal((await send(url(111), 'POST', { repo: scenario.repo, kind: 'stack' })).status, 403)
    assert.equal(h.launch.children.length, 0)
    // the one-run-per-PR rule holds across kinds
    assert.equal((await send(url(113), 'POST', { repo: scenario.repo, kind: 'tandem' }, token(h))).status, 200)
    assert.equal((await send(url(113), 'POST', { repo: scenario.repo, kind: 'default' }, token(h))).status, 409)
    assert.equal((await send(url(113), 'POST', { repo: scenario.repo, kind: 'tandem' }, token(h))).status, 409)
    assert.equal(h.launch.children.length, 1)
  } finally {
    await h.cleanup()
  }
})

test('the view\'s Agent cell lists the starts a row offers, and the run list carries steps and tandem', async () => {
  const h = await setup({ config: { cloneDir: '~/dev/orbit' } })
  try {
    await filled(h)
    const view = (await getJson<View>(`${h.base}/api/view`)).body
    const kinds = (number: number): string[] => (rowIn(view, number)?.agent?.starts ?? []).map((start) => start.kind)
    assert.deepEqual(kinds(113), ['default', 'tandem'])
    assert.deepEqual(kinds(111), ['default', 'tandem', 'stack'])
    assert.deepEqual(kinds(114), ['default'])
    assert.deepEqual(rowIn(view, 111)?.agent?.starts[0], {
      kind: 'default', label: 'Review', button: 'Review PR', command: 'review-pr', args: ['111'], runners: ['claude', 'codex'],
      posts: { kind: 'review', text: 'Posts its report to the PR as @vera-quill: an approval, a request for changes, or a comment, per the findings.' },
      repo: scenario.repo,
      viewer: 'vera-quill',
      unavailable: null,
    })
    assert.equal(rowIn(view, 113)?.agent?.tandem, false)
    assert.equal(rowIn(view, 113)?.agent?.steps.length, 5)

    const started = await send(`${h.base}/api/prs/113/runs`, 'POST', { repo: scenario.repo, kind: 'tandem' }, token(h))
    const id = Number(started.body.id)
    // the child writes a step, and the row's patch carries it
    const stream = await openStream(h.base, 'client=steps&visible=true&paused=false')
    try {
      const child = h.launch.children[0]!
      await child.events({ at: '2026-10-28T14:00:00Z', step: 'review', state: 'started', note: 'primary reviewing' })
      await h.server.launcher.check()
      let carried: Patch | null = null
      while (carried === null) {
        const next = await stream.patch()
        if (next.rows.some((row) => row.number === 113 && (row as OpenRow).agent?.steps[1]?.note === 'primary reviewing')) carried = next
      }
      const cell = (carried.rows.find((row) => row.number === 113) as OpenRow).agent!
      assert.deepEqual([cell.state, cell.tandem, cell.steps[1]?.state, cell.runId], ['running', true, 'started', id])
      assert.deepEqual(cell.starts.map((start) => start.unavailable?.includes('in flight')), [true, true])
    } finally {
      stream.close()
    }
    const listed = await getJson<Record<string, unknown>[]>(`${h.base}/api/prs/113/runs`)
    assert.deepEqual([listed.body[0]?.tandem, (listed.body[0]?.steps as { note: string }[])[1]?.note], [true, 'primary reviewing'])
    assert.ok('sessionId' in (listed.body[0] ?? {}) && 'resume' in (listed.body[0] ?? {}) && 'costUsd' in (listed.body[0] ?? {}))
  } finally {
    await h.cleanup()
  }
})

test('a fix session starts only on the viewer\'s own PR: fix-pr with Claude, never --no-post, after the identity check; others\' PRs 422, Codex 400', async () => {
  const h = await setup({ config: { cloneDir: '~/dev/orbit', agent: { runner: 'codex' } } })
  try {
    await filled(h)
    const url = (number: number): string => `${h.base}/api/prs/${number}/runs`
    const view = (await getJson<View>(`${h.base}/api/view`)).body
    // offered on the viewer's own PRs, drafts included, and listed after the reviews; the default is still Self-review
    for (const number of [101, 103, 104, 120]) assert.equal(rowIn(view, number)?.agent?.starts.at(-1)?.kind, 'fix', `#${number}`)
    for (const number of [113, 106, 114, 115]) assert.ok(!(rowIn(view, number)?.agent?.starts ?? []).some((start) => start.kind === 'fix'), `#${number}`)
    assert.deepEqual(rowIn(view, 101)?.agent?.starts.find((start) => start.kind === 'fix'), {
      kind: 'fix', label: 'Fix session', button: 'Fix requested changes', command: 'fix-pr', args: ['101'], runners: ['claude'],
      posts: { kind: 'push', text: 'Pushes new commits to fix/webhook-retry on GitHub. It posts no replies or reviews, and stops to ask when a request needs judgment.' },
      repo: scenario.repo,
      viewer: 'vera-quill',
      unavailable: null,
    })
    assert.deepEqual([rowIn(view, 101)?.agent?.action.kind, rowIn(view, 101)?.agent?.action.args], ['selfReview', ['101', '--no-post']])

    // refusals come before anything runs
    const others = await send(url(113), 'POST', { repo: scenario.repo, kind: 'fix' }, token(h))
    assert.equal(others.status, 422)
    assert.match(String(others.body.error), /Fix session is offered only on your own PRs, and #113 is not yours/)
    assert.equal((await send(url(114), 'POST', { repo: scenario.repo, kind: 'fix', runner: 'claude' }, token(h))).status, 422)
    const codex = await send(url(101), 'POST', { repo: scenario.repo, kind: 'fix', runner: 'codex' }, token(h))
    assert.equal(codex.status, 400)
    assert.match(String(codex.body.error), /Fix session runs with Claude only/)
    assert.equal((await send(url(113), 'POST', { repo: scenario.repo, kind: 'fix', runner: 'codex' }, token(h))).status, 400)
    assert.equal((await send(url(101), 'POST', { repo: scenario.repo, kind: 'fix' })).status, 403)
    assert.equal(h.launch.children.length, 0)
    assert.equal(githubCalls(h.runner).filter((call) => call.args[1] === 'user').length, 0)

    // with no runner it is Claude's, whatever the configured default is
    const started = await send(url(101), 'POST', { repo: scenario.repo, kind: 'fix' }, token(h))
    assert.equal(started.status, 200)
    assert.deepEqual([started.body.runner, started.body.command, started.body.args, started.body.label, started.body.tandem], ['claude', 'fix-pr', ['101'], 'Fix session', false])
    assert.match(lastWrite(h), /"\/fix-pr 101 --emit-json=[^"]+"/)
    assert.ok(!lastWrite(h).includes('--no-post'))
    assert.equal(githubCalls(h.runner).filter((call) => call.args[1] === 'user').length, 1)
    // one run per PR, whatever the kind
    assert.equal((await send(url(101), 'POST', { repo: scenario.repo }, token(h))).status, 409)
  } finally {
    await h.cleanup()
  }
})

test('a fix start is refused when gh is signed in as someone else, even on the viewer\'s own PR', async () => {
  const fixtures = fixtureRunner()
  const other = fakeRunner((args) => args[0] === 'api' && args[1] === 'user' ? ok('someone-else\n') : fixtures.runner(args))
  const h = await setup({ config: { cloneDir: '~/dev/orbit' }, runner: other })
  try {
    await filled(h)
    const refused = await send(`${h.base}/api/prs/101/runs`, 'POST', { repo: scenario.repo, kind: 'fix' }, token(h))
    assert.equal(refused.status, 422)
    assert.match(String(refused.body.error), /gh is signed in as someone-else, but the viewer is vera-quill/)
    assert.equal(h.launch.children.length, 0)
  } finally {
    await h.cleanup()
  }
})

const reportBody = (priorities: string[], sha = 'abc1234'): string =>
  `Reviewed commit: \`feat/x\` @ \`${sha}\`\n\n## Summary\n\n${priorities.length === 0 ? 'No actionable findings.' : priorities.map((priority) => `- **${priority}**\n  - Something (a.ts)`).join('\n')}\n`

test('GET /api/prs/<n>/reports lists a PR\'s reports newest first, and GET /api/reports/<name> serves one as HTML and raw Markdown', async () => {
  const hostile = '## Findings\n\n**[P1] Bad**\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1)) ![y](javascript:alert(2)) [ok](https://example.test/a)\n'
  const h = await setup({ files: {
    'agents/output/PR-101.md': reportBody(['P1']),
    'agents/output/PR-101-codex.md': reportBody([]),
    'agents/output/PR-102.md': hostile,
    'agents/output/PR-1010.md': reportBody(['P3']),
  } })
  try {
    const listed = await getJson<{ name: string, modifiedAt: string, sha: string | null, verdict: string | null, tandem: boolean }[]>(`${h.base}/api/prs/101/reports`)
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body.map((entry) => entry.name).sort(), ['PR-101-codex.md', 'PR-101.md'])
    const own = listed.body.find((entry) => entry.name === 'PR-101.md')!
    assert.deepEqual([own.sha, own.verdict, own.tandem, Number.isNaN(Date.parse(own.modifiedAt))], ['abc1234', 'changesRequested', true, false])
    assert.deepEqual(Object.keys(own).sort(), ['kind', 'modifiedAt', 'name', 'sha', 'tandem', 'verdict'])
    assert.deepEqual((await getJson<unknown[]>(`${h.base}/api/prs/103/reports`)).body, [])
    assert.equal((await getJson<unknown>(`${h.base}/api/prs/abc/reports`)).status, 400)

    const report = await getJson<{ name: string, modifiedAt: string, html: string, raw: string }>(`${h.base}/api/reports/PR-102.md`)
    assert.equal(report.status, 200)
    assert.deepEqual(Object.keys(report.body).sort(), ['html', 'modifiedAt', 'name', 'raw'])
    assert.equal(report.body.raw, hostile)
    assert.match(report.body.html, /<h2>Findings<\/h2>/)
    assert.ok(!report.body.html.includes('<script'))
    assert.ok(!/javascript:/i.test(report.body.html))
    assert.match(report.body.html, /<a href="https:\/\/example\.test\/a" target="_blank" rel="noopener noreferrer nofollow">ok<\/a>/)
    assert.equal((await getJson<unknown>(`${h.base}/api/reports/PR-103.md`)).status, 404)
  } finally {
    await h.cleanup()
  }
})

test('the report endpoints read nothing outside reportsDir: odd names, symlinks out, directories and big files', async () => {
  const h = await setup({ files: { 'agents/output/PR-101.md': reportBody([]), 'secret/PR-104.md': 'outside', 'agents/PR-105.md': 'parent' } })
  try {
    const output = join(h.home, 'agents', 'output')
    await symlink(join(h.home, 'secret', 'PR-104.md'), join(output, 'PR-104.md'))
    await symlink(join(h.home, 'agents', 'PR-105.md'), join(output, 'PR-105.md'))
    await mkdir(join(output, 'PR-106.md'))
    await writeFile(join(output, 'PR-107.md'), 'x'.repeat(1024 * 1024 + 1))
    await writeFile(join(output, 'PR-108.md'), 'x'.repeat(1024 * 1024))
    const get = (name: string) => raw(h.server.port, `/api/reports/${name}`)
    assert.equal((await get('PR-101.md')).status, 200)
    assert.equal((await get('PR-108.md')).status, 200)
    assert.equal((await get('PR-107.md')).status, 413)
    for (const name of ['PR-104.md', 'PR-105.md', 'PR-106.md', 'PR-999.md']) {
      const refused = await get(name)
      assert.equal(refused.status, 404, name)
      assert.ok(!refused.body.includes('outside') && !refused.body.includes('parent'), name)
    }
    for (const name of ['..%2Fsecret%2FPR-104.md', '..%2FPR-105.md', '%2e%2e%2fPR-105.md', 'PR-1%2F..%2FPR-101.md', '%2Fetc%2Fpasswd', 'PR-101.md%00', 'PR-..md', 'notes.md', 'PR-101.txt', '%E0%A4%A']) {
      assert.equal((await get(name)).status, 400, name)
    }
    for (const path of ['/api/reports/../PR-105.md', '/api/reports//PR-101.md', '/api/reports/', '/api/reports/sub/PR-101.md']) {
      assert.ok([400, 404].includes((await raw(h.server.port, path)).status), path)
    }
    // the listing skips the symlinks, the directory and any file that is not this PR's
    assert.deepEqual((await getJson<unknown[]>(`${h.base}/api/prs/104/reports`)).body, [])
    assert.deepEqual((await getJson<unknown[]>(`${h.base}/api/prs/106/reports`)).body, [])
  } finally {
    await h.cleanup()
  }
})

test('GET /api/prs/<n>/reports lists FIX-<n>.md beside the review reports, and GET /api/reports/FIX-<n>.md serves it', async () => {
  const fix = 'PR: #101 `fix/webhook-retry` @ `aaaaaaa`\nBase: `main`\nPush: pushed `bbbbbbb` (2 commits)\n\n## Summary\n\n- **P1** is not a verdict here\n\n[x](javascript:alert(1))\n'
  const h = await setup({ files: {
    'agents/output/PR-101.md': reportBody(['P1']),
    'agents/output/FIX-101.md': fix,
    'agents/output/FIX-1010.md': fix,
    'agents/output/FIX-101-old.md': fix,
    'secret/FIX-104.md': 'outside',
  } })
  try {
    const output = join(h.home, 'agents', 'output')
    await symlink(join(h.home, 'secret', 'FIX-104.md'), join(output, 'FIX-104.md'))
    const listed = await getJson<{ name: string, kind: string, sha: string | null, verdict: string | null, tandem: boolean }[]>(`${h.base}/api/prs/101/reports`)
    assert.deepEqual(listed.body.map((entry) => [entry.name, entry.kind, entry.sha, entry.verdict, entry.tandem]).sort(), [
      ['FIX-101.md', 'fix', 'aaaaaaa', null, false],
      ['PR-101.md', 'review', 'abc1234', 'changesRequested', false],
    ])
    assert.deepEqual((await getJson<unknown[]>(`${h.base}/api/prs/1010/reports`)).body.length, 1)
    assert.deepEqual((await getJson<unknown[]>(`${h.base}/api/prs/104/reports`)).body, [])
    const served = await getJson<{ name: string, html: string, raw: string }>(`${h.base}/api/reports/FIX-101.md`)
    assert.equal(served.status, 200)
    assert.equal(served.body.raw, fix)
    assert.ok(!/javascript:/i.test(served.body.html))
    const get = (name: string) => raw(h.server.port, `/api/reports/${name}`)
    assert.equal((await get('FIX-104.md')).status, 404)
    assert.ok(!(await get('FIX-104.md')).body.includes('outside'))
    for (const name of ['FIX-101-old.md', '..%2Fsecret%2FFIX-104.md', 'FIX-1%2F..%2FFIX-101.md', 'fix-101.md', 'FIX-101.md%00', 'FIX-.md']) {
      assert.equal((await get(name)).status, 400, name)
    }
    // a fix report is never a self-review
    await filled(h)
    const view = (await getJson<View>(`${h.base}/api/view`)).body
    assert.equal((rowIn(view, 101) as MineRow | undefined)?.selfReview.file, 'PR-101.md')
  } finally {
    await h.cleanup()
  }
})

test('the report endpoints are reads with no token, but the Host check applies; a missing reportsDir means no reports', async () => {
  const h = await setup({ config: { reportsDir: '~/missing/output' }, files: { 'agents/output/PR-101.md': reportBody([]) } })
  try {
    assert.equal((await raw(h.server.port, '/api/prs/101/reports', { Host: 'pit-view.attacker.test' })).status, 403)
    assert.equal((await raw(h.server.port, '/api/reports/PR-101.md', { Host: 'pit-view.attacker.test' })).status, 403)
    assert.deepEqual((await getJson<unknown[]>(`${h.base}/api/prs/101/reports`)).body, [])
    assert.equal((await getJson<unknown>(`${h.base}/api/reports/PR-101.md`)).status, 404)
    assert.equal((await raw(h.server.port, '/api/reports/PR-101.md', {}, 'POST')).status, 405)
    await send(`${h.base}/api/config`, 'PUT', { ...(await getJson<Config>(`${h.base}/api/config`)).body, reportsDir: '~/agents/output' })
    assert.equal((await getJson<unknown[]>(`${h.base}/api/prs/101/reports`)).body.length, 1)
    assert.equal((await getJson<unknown>(`${h.base}/api/reports/PR-101.md`)).status, 200)
  } finally {
    await h.cleanup()
  }
})

// Dependabot sweeps: their own endpoints, view, and live feed (section 8, Sweeps)

const sweepsUrl = (h: Harness): string => `${h.base}/api/sweeps`

const writeSweepSummary = (h: Harness): Promise<void> =>
  mkdir(join(h.home, 'agents', 'output'), { recursive: true }).then(() => writeFile(join(h.home, 'agents', 'output', 'dependabot-sweep-octo-example-orbit-2026-10-26.md'), '# sweep\n'))

test('starting a sweep needs the token and the Host, Origin, and content-type checks, takes only a runner, and is one per repository', async () => {
  const h = await setup({ config: { cloneDir: '~/dev/orbit' } })
  try {
    const url = sweepsUrl(h)
    assert.equal((await send(url, 'POST')).status, 403)
    assert.match(String((await send(url, 'POST', undefined, { 'X-Pit-View-Token': 'not-the-token' })).body.error), /token/)
    assert.equal((await send(url, 'POST', undefined, { ...token(h), Origin: 'http://attacker.test' })).status, 403)
    assert.equal((await raw(h.server.port, '/api/sweeps', { ...token(h), Host: 'pit-view.attacker.test' }, 'POST')).status, 403)
    assert.equal((await send(url, 'POST', 'runner=codex', { ...token(h), 'Content-Type': 'text/plain' })).status, 415)
    // the body may carry the runner and nothing else: no --no-post, no arguments
    assert.equal((await send(url, 'POST', { runner: 'hermes' }, token(h))).status, 400)
    assert.equal((await send(url, 'POST', { noPost: true }, token(h))).status, 400)
    assert.equal((await send(url, 'POST', { args: ['--no-post'] }, token(h))).status, 400)
    assert.equal((await send(url, 'POST', ['codex'], token(h))).status, 400)
    assert.equal(h.launch.children.length, 0)

    const started = await send(url, 'POST', { repo: scenario.repo }, { ...token(h), Origin: h.base })
    assert.equal(started.status, 200)
    assert.deepEqual([started.body.status, started.body.command, started.body.args, started.body.label, started.body.runner, started.body.cwd],
      ['running', 'review-dependabot-sweep', [scenario.repo, '--parallel', '1'], 'Dependabot sweep', 'claude', '~/dev/orbit'])
    assert.equal('number' in started.body, false)
    const line = lastWrite(h)
    assert.match(line, /\/review-dependabot-sweep octo-example\/orbit --parallel 1 --emit-json=.*\/sweeps\/1/)
    assert.doesNotMatch(line, /--no-post/)
    // the start's one GitHub call is the identity check
    assert.equal(githubCalls(h.runner).filter((call) => call.args[0] === 'api' && call.args[1] === 'user').length, 1)

    const busy = await send(url, 'POST', {}, token(h))
    assert.equal(busy.status, 409)
    assert.match(String(busy.body.error), /sweep for octo-example\/orbit is already in flight/)
    assert.equal(h.launch.children.length, 1)
    // a sweep does not hold up a PR's own run, and its record is not in that PR's runs
    await filled(h)
    const run = await send(`${h.base}/api/prs/106/runs`, 'POST', { repo: scenario.repo }, token(h))
    assert.equal(run.status, 200)
    assert.deepEqual((await getJson<Record<string, unknown>[]>(`${h.base}/api/prs/106/runs`)).body.map((entry) => entry.command), ['review-pr'])
  } finally {
    await h.cleanup()
  }
})

test('a sweep start naming a repository that is no longer the one in effect is refused with 409 and starts nothing', async () => {
  const h = await setup({ config: { cloneDir: '~/dev/orbit' } })
  try {
    const url = sweepsUrl(h)
    const stale = await send(url, 'POST', { runner: 'claude', repo: 'octo-example/other' }, token(h))
    assert.equal(stale.status, 409)
    assert.match(String(stale.body.error), /octo-example\/other/)
    assert.equal((await send(url, 'POST', { repo: 7 }, token(h))).status, 400)
    assert.equal(h.launch.children.length, 0)
    assert.deepEqual((await getJson<unknown[]>(url)).body, [])
    // the repository changes under an open confirmation: the one it showed is stale now
    const { body: stored } = await getJson<Config>(`${h.base}/api/config`)
    assert.equal((await send(`${h.base}/api/config`, 'PUT', { ...stored, repo: 'octo-example/other' })).status, 200)
    const moved = await send(url, 'POST', { runner: 'claude', repo: scenario.repo }, token(h))
    assert.equal(moved.status, 409)
    assert.equal(h.launch.children.length, 0)
    assert.deepEqual((await getJson<unknown[]>(url)).body, [])
  } finally {
    await h.cleanup()
  }
})

test('a run start naming a repository that is no longer the one in effect is refused with 409 and starts nothing, and one naming none is refused with 400', async () => {
  const h = await setup({ config: { cloneDir: '~/dev/orbit' } })
  try {
    await filled(h)
    const url = `${h.base}/api/prs/106/runs`
    // an older page that names no repository is refused rather than guessed at
    const omitted = await send(url, 'POST', { kind: 'default', runner: 'claude', viewer: scenario.viewer }, token(h))
    assert.equal(omitted.status, 400)
    assert.match(String(omitted.body.error), /repo is required/)
    assert.equal((await send(url, 'POST', undefined, token(h))).status, 400)
    assert.equal((await send(url, 'POST', { repo: 7 }, token(h))).status, 400)
    // another repository than the one in effect
    const stale = await send(url, 'POST', { kind: 'default', runner: 'claude', repo: 'octo-example/other', viewer: scenario.viewer }, token(h))
    assert.equal(stale.status, 409)
    assert.match(String(stale.body.error), /octo-example\/other/)
    assert.equal(h.launch.children.length, 0)
    assert.deepEqual((await getJson<unknown[]>(url)).body, [])
    // the repository changes under an open confirmation: the one it showed is stale now, though the PR number may exist in the new one
    const { body: stored } = await getJson<Config>(`${h.base}/api/config`)
    assert.equal((await send(`${h.base}/api/config`, 'PUT', { ...stored, repo: 'octo-example/other' })).status, 200)
    const moved = await send(url, 'POST', { kind: 'default', runner: 'claude', repo: scenario.repo, viewer: scenario.viewer }, token(h))
    assert.equal(moved.status, 409)
    assert.equal(h.launch.children.length, 0)
  } finally {
    await h.cleanup()
  }
})

// the viewer and the gh account change together while a confirmation is open: the server's configuration has moved on, and the page still shows the old account until its feed patch arrives
const switchedAccount = async (): Promise<{ h: Harness, switchTo: (login: string) => Promise<void> }> => {
  let login: string = scenario.viewer
  const fixtures = fixtureRunner()
  const runner = fakeRunner((args) => args[0] === 'api' && args[1] === 'user' ? ok(`${login}\n`) : fixtures.runner(args))
  const h = await setup({ runner, config: { cloneDir: '~/dev/orbit' } })
  const switchTo = async (next: string): Promise<void> => {
    login = next
    const { body: stored } = await getJson<Config>(`${h.base}/api/config`)
    assert.equal((await send(`${h.base}/api/config`, 'PUT', { ...stored, viewer: next })).status, 200)
  }
  return { h, switchTo }
}

test('a sweep start naming a viewer that is no longer the one in effect is refused with 409 and starts nothing', async () => {
  const { h, switchTo } = await switchedAccount()
  try {
    const url = sweepsUrl(h)
    assert.equal((await send(url, 'POST', { repo: scenario.repo, viewer: 7 }, token(h))).status, 400)
    await switchTo('new-account')
    const stale = await send(url, 'POST', { runner: 'claude', repo: scenario.repo, viewer: scenario.viewer }, token(h))
    assert.equal(stale.status, 409)
    assert.match(String(stale.body.error), /new-account/)
    assert.match(String(stale.body.error), new RegExp(scenario.viewer))
    assert.equal(h.launch.children.length, 0)
    assert.deepEqual((await getJson<unknown[]>(url)).body, [])
    // the confirmation named the viewer now in effect, in any letter case, so it starts
    const current = await send(url, 'POST', { runner: 'claude', repo: scenario.repo, viewer: 'NEW-ACCOUNT' }, token(h))
    assert.equal(current.status, 200)
    assert.equal(h.launch.children.length, 1)
  } finally {
    await h.cleanup()
  }
})

test('a run start naming a viewer that is no longer the one in effect is refused with 409 and starts nothing', async () => {
  const { h, switchTo } = await switchedAccount()
  try {
    await filled(h)
    const url = `${h.base}/api/prs/106/runs`
    assert.equal((await send(url, 'POST', { repo: scenario.repo, viewer: 7 }, token(h))).status, 400)
    await switchTo('new-account')
    const stale = await send(url, 'POST', { kind: 'default', runner: 'claude', repo: scenario.repo, viewer: scenario.viewer }, token(h))
    assert.equal(stale.status, 409)
    assert.match(String(stale.body.error), /new-account/)
    assert.equal(h.launch.children.length, 0)
    assert.deepEqual((await getJson<unknown[]>(url)).body, [])
    // the confirmation named the viewer now in effect, in any letter case, so it starts
    const current = await send(url, 'POST', { kind: 'default', runner: 'claude', repo: scenario.repo, viewer: 'NEW-ACCOUNT' }, token(h))
    assert.equal(current.status, 200)
    assert.equal(h.launch.children.length, 1)
  } finally {
    await h.cleanup()
  }
})

test('the sweeps the cache prunes leave memory, the list, and the feed with the same ids', async () => {
  const h = await setup({ config: { cloneDir: '~/dev/orbit' } })
  try {
    const { cache } = h.server
    const fields = { command: 'review-dependabot-sweep', args: [scenario.repo, '--parallel', '1'], label: 'Dependabot sweep', runner: 'claude' as const, cwd: '~/dev/orbit', sessionId: null, pid: null, pidStartedAt: null, startedAt: '2026-10-26T17:00:00Z', lastStepAt: null, step: null, stepState: null, finishedAt: '2026-10-26T17:05:00Z', status: 'done' as const, result: null, note: null, costUsd: null, resume: null }
    const oldest = cache.createSweep({ ...fields, repo: scenario.repo }, (id) => `~/s/${id}`)
    // memory holds it, as the launcher's change announces it
    h.server.sweeps.set(oldest)
    assert.deepEqual((await getJson<{ id: number }[]>(sweepsUrl(h))).body.map((sweep) => sweep.id), [oldest.id])
    for (let index = 0; index < 49; index += 1) cache.createSweep({ ...fields, repo: 'octo-example/other' }, (id) => `~/s/${id}`)
    const stream = await openStream(h.base, 'client=tab-1&visible=false&paused=false')
    // the 51st sweep pushes the oldest out of the table
    const started = await send(sweepsUrl(h), 'POST', undefined, token(h))
    assert.equal(started.status, 200)
    assert.equal(cache.getSweep(oldest.id), null)
    assert.equal(h.server.sweeps.get(oldest.id), undefined)
    assert.deepEqual((await getJson<{ id: number }[]>(sweepsUrl(h))).body.map((sweep) => sweep.id), [started.body.id])
    const view = (await getJson<{ sweeps: { items: { id: number }[] } }>(`${h.base}/api/view`)).body
    assert.deepEqual(view.sweeps.items.map((sweep) => sweep.id), [started.body.id])
    // the feed announced the start, then the removal, each with the sweeps whole
    const first = await stream.patch()
    assert.deepEqual(first.sweeps?.items.map((sweep) => sweep.id), [started.body.id, oldest.id])
    const second = await stream.patch()
    assert.deepEqual(second.sweeps?.items.map((sweep) => sweep.id), [started.body.id])
    stream.close()
  } finally {
    await h.cleanup()
  }
})

test('a sweep start is refused with a clear error: no cloneDir, a folder that is not the clone, another gh account', async () => {
  const unset = await setup()
  try {
    const refused = await send(sweepsUrl(unset), 'POST', undefined, token(unset))
    assert.equal(refused.status, 422)
    assert.match(String(refused.body.error), /set cloneDir/)
    assert.equal(unset.launch.children.length, 0)
  } finally {
    await unset.cleanup()
  }
  const notClone = await setup({ config: { cloneDir: '~/dev/orbit' }, launch: fakeLaunch({ remotes: 'origin\thttps://github.com/octo-example/other (fetch)\n' }) })
  try {
    const refused = await send(sweepsUrl(notClone), 'POST', undefined, token(notClone))
    assert.equal(refused.status, 422)
    assert.match(String(refused.body.error), /no remote for octo-example\/orbit/)
  } finally {
    await notClone.cleanup()
  }
  const fixtures = fixtureRunner()
  const other = fakeRunner((args) => args[0] === 'api' && args[1] === 'user' ? ok('someone-else\n') : fixtures.runner(args))
  const mismatch = await setup({ runner: other, config: { cloneDir: '~/dev/orbit' } })
  try {
    const refused = await send(sweepsUrl(mismatch), 'POST', undefined, token(mismatch))
    assert.equal(refused.status, 422)
    assert.match(String(refused.body.error), /gh is signed in as someone-else, but the viewer is vera-quill/)
    assert.equal(mismatch.launch.children.length, 0)
  } finally {
    await mismatch.cleanup()
  }
})

test('GET /api/sweeps lists the repository\'s sweeps newest first with the parsed result, and a sweep stops at its own path with the same rules', async () => {
  const h = await setup({ config: { cloneDir: '~/dev/orbit' } })
  try {
    assert.deepEqual((await getJson<unknown[]>(sweepsUrl(h))).body, [])
    await writeSweepSummary(h)
    const first = await send(sweepsUrl(h), 'POST', undefined, token(h))
    const child = h.launch.children[0]!
    await child.result(sweepResult())
    const settled = h.server.sweepLauncher.settled(Number(first.body.id))
    child.exit(0)
    await settled
    const second = await send(sweepsUrl(h), 'POST', undefined, token(h))
    const listed = await getJson<Record<string, any>[]>(sweepsUrl(h))
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body.map((sweep) => [sweep.id, sweep.status]), [[second.body.id, 'running'], [first.body.id, 'done']])
    assert.equal(listed.body[1]?.text, 'Done · 2 swept')
    assert.deepEqual(listed.body[1]?.result.counts, { swept: 2, fresh: 1, reused: 1, failed: 0 })
    assert.deepEqual(listed.body[1]?.result.rows.map((row: Record<string, unknown>) => row.number), [201, 202])
    assert.equal(listed.body[1]?.result.summary, '~/agents/output/dependabot-sweep-octo-example-orbit-2026-10-26.md')
    assert.equal('result' in (listed.body[0] ?? {}) && listed.body[0]?.result, null)

    // why stop has a path of its own: sweeps and runs count their ids apart
    const stopUrl = `${h.base}/api/sweeps/${second.body.id}/stop`
    assert.equal((await send(stopUrl, 'POST')).status, 403)
    assert.equal((await send(stopUrl, 'POST', undefined, { ...token(h), Origin: 'http://attacker.test' })).status, 403)
    assert.equal((await send(`${h.base}/api/sweeps/abc/stop`, 'POST', undefined, token(h))).status, 400)
    assert.equal((await send(`${h.base}/api/sweeps/999/stop`, 'POST', undefined, token(h))).status, 404)
    const stopping = h.server.sweepLauncher.settled(Number(second.body.id))
    const stopped = await send(stopUrl, 'POST', undefined, token(h))
    assert.equal(stopped.status, 200)
    assert.equal(stopped.body.status, 'running')
    assert.equal((await stopping).status, 'stopped')
    assert.deepEqual(h.launch.kills, [{ pid: -h.launch.children[1]!.pid, signal: 'SIGTERM' }])
    assert.equal((await send(stopUrl, 'POST', undefined, token(h))).status, 409)
    // a run's stop path does not reach a sweep
    assert.equal((await send(`${h.base}/api/runs/${first.body.id}/stop`, 'POST', undefined, token(h))).status, 404)
  } finally {
    await h.cleanup()
  }
})

test('the view carries the sweeps and how to start one, and the live feed sends them whole when a sweep starts, steps, and settles', async () => {
  const h = await setup({ config: { cloneDir: '~/dev/orbit' } })
  try {
    await filled(h)
    const before = (await getJson<View>(`${h.base}/api/view`)).body
    assert.deepEqual(before.sweeps.items, [])
    assert.match(before.sweeps.start.heading, /octo-example\/orbit/)
    assert.equal(before.sweeps.start.unavailable, null)
    assert.match(before.sweeps.start.posts, /@vera-quill/)
    const stream = await openStream(h.base, 'client=tab-1&visible=false&paused=false')

    const started = await send(sweepsUrl(h), 'POST', undefined, token(h))
    const first = await stream.patch()
    assert.deepEqual(first.rows, [])
    assert.deepEqual(first.sweeps?.items.map((sweep) => [sweep.id, sweep.status]), [[started.body.id, 'running']])
    assert.match(first.sweeps?.start.unavailable ?? '', /already in flight/)

    const child = h.launch.children[0]!
    await child.events({ at: '2026-10-26T14:06:00Z', step: 'resolveBase', state: 'done', note: null })
    await h.server.sweepLauncher.check()
    const stepped = await stream.patch()
    assert.equal(stepped.sweeps?.items[0]?.step, 'resolveBase')
    assert.equal(stepped.version, first.version + 1)

    await writeSweepSummary(h)
    await child.result(sweepResult())
    const settled = h.server.sweepLauncher.settled(Number(started.body.id))
    child.exit(0)
    await settled
    const done = await stream.patch()
    assert.deepEqual([done.sweeps?.items[0]?.status, done.sweeps?.items[0]?.text, done.sweeps?.start.unavailable], ['done', 'Done · 2 swept', null])
    assert.equal(done.sweeps?.items[0]?.result?.rows.length, 2)
    // sweeps are not an Agent cell: no row of the view mentions them
    const after = (await getJson<View>(`${h.base}/api/view`)).body
    assert.equal(after.sweeps.items[0]?.id, started.body.id)
    assert.equal(JSON.stringify([...after.mine.groups, ...after.others.groups]).includes('sweep'), false)
    stream.close()
  } finally {
    await h.cleanup()
  }
})

test('a sweep with nothing to sweep settles done with zero counts, and the feed shows it so', async () => {
  const h = await setup({ config: { cloneDir: '~/dev/orbit' } })
  try {
    const started = await send(sweepsUrl(h), 'POST', undefined, token(h))
    const child = h.launch.children[0]!
    await child.result(emptySweepResult())
    const settled = h.server.sweepLauncher.settled(Number(started.body.id))
    child.exit(0)
    await settled
    const listed = (await getJson<Record<string, any>[]>(sweepsUrl(h))).body[0]
    assert.deepEqual([listed?.status, listed?.note, listed?.text], ['done', null, 'Done · nothing to sweep'])
    assert.deepEqual([listed?.result.counts, listed?.result.rows, listed?.result.summary], [{ swept: 0, fresh: 0, reused: 0, failed: 0 }, [], null])
  } finally {
    await h.cleanup()
  }
})

// a second start over the same home, cache, and state folder: what a restart of the server is
const restart = async (h: Harness): Promise<PitServer> => {
  await h.server.close()
  h.server = await startServer(restartOptions(h))
  return h.server
}

test('sweeps survive a restart: one still running is watched again, one whose process is gone settles from its result or fails as serverRestarted', async () => {
  const h = await setup({ config: { cloneDir: '~/dev/orbit' } })
  try {
    await writeSweepSummary(h)
    const live = await send(sweepsUrl(h), 'POST', undefined, token(h))
    const liveChild = h.launch.children[0]!
    let again = await restart(h)
    // memory is rebuilt at startup: the sweep is there, running, and its process is watched
    assert.deepEqual(again.sweeps.list(scenario.repo).map((sweep) => [sweep.id, sweep.status]), [[live.body.id, 'running']])
    const view = await (await fetch(`${again.url}/api/view`)).json() as View
    assert.deepEqual(view.sweeps.items.map((sweep) => sweep.status), ['running'])
    assert.match(view.sweeps.start.unavailable ?? '', /already in flight/)
    await liveChild.result(sweepResult())
    const settled = again.sweepLauncher.settled(Number(live.body.id))
    liveChild.exit(0)
    h.time.advance(20_000)
    assert.equal((await settled).status, 'done')
    assert.equal(again.sweeps.get(Number(live.body.id))?.text, 'Done · 2 swept')

    // a second sweep is lost while the server is down: with a result on disk it settles from it
    const withResult = await fetch(`${again.url}/api/sweeps`, { method: 'POST', headers: { 'X-Pit-View-Token': again.token } }).then((response) => response.json()) as Record<string, unknown>
    const child = h.launch.children[1]!
    await child.result(emptySweepResult())
    h.launch.alive.delete(child.pid)
    again = await restart(h)
    assert.deepEqual(again.sweeps.get(Number(withResult.id))?.text, 'Done · nothing to sweep')

    // and without one it fails as serverRestarted
    const lost = await fetch(`${again.url}/api/sweeps`, { method: 'POST', headers: { 'X-Pit-View-Token': again.token } }).then((response) => response.json()) as Record<string, unknown>
    h.launch.alive.delete(h.launch.children[2]!.pid)
    again = await restart(h)
    const failed = again.sweeps.get(Number(lost.id))
    assert.deepEqual([failed?.status, failed?.note, failed?.text], ['failed', 'serverRestarted', 'Failed · server restarted'])
    // the runs table never held any of them
    assert.deepEqual(again.cache.runningRuns(), [])
  } finally {
    await h.cleanup()
  }
})

const restartOptions = (h: Harness) => ({
  home: h.home,
  port: 0,
  runner: h.runner.runner,
  clock: h.time.clock,
  timers: h.time.timers,
  timeZone: scenario.timeZone,
  configPath: h.configPath,
  cachePath: join(h.home, '.local', 'state', 'pit-view', 'cache.sqlite'),
  stateDir: join(h.home, '.local', 'state', 'pit-view'),
  publicDir: join(h.home, 'public'),
  launch: h.launch.deps,
  log: () => {},
  pageSize: scenario.pageSize,
})
