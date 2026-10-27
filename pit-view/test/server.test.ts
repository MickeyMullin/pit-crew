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
import { PortInUseError, startServer } from '../src/server.ts'
import type { PitServer } from '../src/server.ts'
import { scenario } from './fixtures/scenario.ts'
import { failed, fakeRunner, fakeTime, fixtureRunner, gatedRunner, githubCalls, tempDir } from './helpers.ts'
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

