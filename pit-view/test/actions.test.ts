// test/actions.test.ts
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { ghArgs, parseAction } from '../src/actions.ts'
import type { Config } from '../src/config.ts'
import type { OpenRow } from '../src/derive.ts'
import type { Patch, View } from '../src/poller.ts'
import { startServer } from '../src/server.ts'
import type { PitServer } from '../src/server.ts'
import { scenario } from './fixtures/scenario.ts'
import { failed, fakeLaunch, fakeRunner, fakeTime, field, fixtureRunner, ok, singlePr, tempDir } from './helpers.ts'
import type { Call, FakeRunner } from './helpers.ts'

// every GitHub write below goes to a fake gh; nothing here can reach a real PR

type Harness = { server: PitServer, runner: FakeRunner, base: string, cleanup: () => Promise<void> }

const people = [
  { login: 'alex-mendez', alias: 'Alex', initials: 'AM', color: '#0F766E', avatar: 'github' },
  { login: 'sam-tran', alias: 'Sam', initials: 'ST', color: '#B45309', avatar: 'github' },
]

// a gh that answers the fixture world, records the writes it was asked for, and lets a test change
// what the one-PR query and the account lookup say
type Behavior = {
  // the account `gh api user` reports
  account?: string
  // a write that fails with this stderr
  writeError?: string
  // holds every write until the returned function is called
  gate?: Promise<void>
  single?: (number: number) => Promise<unknown>
}

const isWrite = (args: string[]): boolean =>
  (args[0] === 'pr' && args[1] === 'ready') || (args[0] === 'api' && args.includes('--method'))

const writesOf = (runner: FakeRunner): Call[] => runner.calls.filter((call) => isWrite(call.args))
const singleCallsOf = (runner: FakeRunner): Call[] =>
  runner.calls.filter((call) => call.args[0] === 'api' && (field(call.args, 'query') ?? '').includes('query SinglePullRequest'))

const ghWorld = (behavior: Behavior = {}): FakeRunner => {
  const base = fixtureRunner()
  return fakeRunner(async (args) => {
    if (isWrite(args)) {
      await behavior.gate
      return behavior.writeError === undefined ? ok('') : failed(behavior.writeError)
    }
    if (args[0] === 'api' && args[1] === 'user') return ok(`${behavior.account ?? scenario.viewer}\n`)
    if (args[0] === 'api' && args[1] === 'graphql' && (field(args, 'query') ?? '').includes('query SinglePullRequest') && behavior.single !== undefined) {
      return ok(JSON.stringify(await behavior.single(Number(field(args, 'number')))))
    }
    return base.runner(args)
  })
}

const setup = async ({ config = {}, runner = ghWorld() }: { config?: Partial<Config>, runner?: FakeRunner } = {}): Promise<Harness> => {
  const { dir: home, cleanup: removeHome } = await tempDir()
  const configPath = join(home, '.config', 'pit-view', 'config.json')
  await mkdir(join(configPath, '..'), { recursive: true })
  await writeFile(configPath, JSON.stringify({ repo: scenario.repo, viewer: scenario.viewer, people, ...config }), 'utf8')
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
    launch: fakeLaunch().deps,
    log: () => {},
    pageSize: scenario.pageSize,
  })
  const cleanup = async (): Promise<void> => {
    await server.close()
    await removeHome()
  }
  return { server, runner, base: server.url, cleanup }
}

const filled = async (h: Harness): Promise<void> => {
  const response = await fetch(`${h.base}/api/refresh`, { method: 'POST' })
  assert.equal(response.status, 200)
  await h.server.poller.idle()
}

const act = async (h: Harness, number: number | string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number, body: Record<string, unknown> }> => {
  const response = await fetch(`${h.base}/api/prs/${number}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: h.base, 'X-Pit-View-Token': h.server.token, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

const rowOf = async (h: Harness, number: number): Promise<OpenRow | undefined> => {
  const view = await (await fetch(`${h.base}/api/view`)).json() as View
  return [...view.mine.groups, ...view.others.groups].flatMap((group) => group.rows as OpenRow[]).find((row) => row.number === number)
}

const until = async (check: () => boolean): Promise<void> => {
  for (let tries = 0; tries < 400 && !check(); tries += 1) await delay(5)
  assert.ok(check(), 'condition reached')
}

// the patches the event stream carries, collected from the moment it is opened
const collectPatches = async (base: string): Promise<{ patches: Patch[], close: () => void }> => {
  const controller = new AbortController()
  const response = await fetch(`${base}/api/events?client=tab-1&visible=true&paused=true`, { signal: controller.signal })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const patches: Patch[] = []
  let buffer = ''
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          if (frame.startsWith('event: patch\n')) patches.push(JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as Patch)
        }
      }
    } catch {
      // aborted at the end of the test
    }
  })()
  return { patches, close: () => controller.abort() }
}

// the scenario's PRs: 101 is the viewer's and open for review, 103 the viewer's draft, 106 and 113
// are other people's
const requestReview = { action: 'requestReview', reviewer: 'sam-tran' }

test('an action needs a same-origin Origin header and this start\'s token, and a refusal reaches neither gh nor GitHub', async () => {
  const h = await setup()
  try {
    await filled(h)
    const before = h.runner.calls.length
    assert.equal((await act(h, 103, { action: 'markReady' }, { Origin: '' })).status, 403)
    const noOrigin = await fetch(`${h.base}/api/prs/103/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pit-View-Token': h.server.token },
      body: JSON.stringify({ action: 'markReady' }),
    })
    assert.equal(noOrigin.status, 403)
    assert.match(String((await noOrigin.json() as { error: string }).error), /Origin/)
    assert.equal((await act(h, 103, { action: 'markReady' }, { Origin: 'http://attacker.test' })).status, 403)
    assert.equal((await act(h, 103, { action: 'markReady' }, { Origin: 'https://127.0.0.1' })).status, 403)
    const noToken = await fetch(`${h.base}/api/prs/103/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: h.base },
      body: JSON.stringify({ action: 'markReady' }),
    })
    assert.equal(noToken.status, 403)
    assert.match(String((await noToken.json() as { error: string }).error), /token/)
    const wrong = await act(h, 103, { action: 'markReady' }, { 'X-Pit-View-Token': 'not-the-token' })
    assert.equal(wrong.status, 403)
    assert.match(String(wrong.body.error), /token/)
    // nothing was asked of gh at all: not even the account lookup
    assert.equal(h.runner.calls.length, before)
  } finally {
    await h.cleanup()
  }
})

test('the Host check applies, and the body must be JSON', async () => {
  const h = await setup()
  try {
    await filled(h)
    // fetch will not set Host, so this one goes out as a raw request
    const foreignHost = await new Promise<number>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port: h.server.port,
        path: '/api/prs/103/actions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pit-View-Token': h.server.token, Origin: h.base, Host: 'pit-view.attacker.test' },
      }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end(JSON.stringify({ action: 'markReady' }))
    })
    assert.equal(foreignHost, 403)
    assert.equal((await act(h, 103, 'action=markReady', { 'Content-Type': 'text/plain' })).status, 415)
    assert.equal((await act(h, 103, '{not json')).status, 400)
    assert.equal(writesOf(h.runner).length, 0)
  } finally {
    await h.cleanup()
  }
})

test('the server refuses what the page should never send: a bad number, body, action or field', async () => {
  const h = await setup()
  try {
    await filled(h)
    assert.equal((await act(h, 'abc', { action: 'markReady' })).status, 400)
    assert.equal((await act(h, 0, { action: 'markReady' })).status, 400)
    assert.equal((await act(h, 103, [])).status, 400)
    assert.equal((await act(h, 103, {})).status, 400)
    assert.equal((await act(h, 103, { action: 'approve' })).status, 400)
    assert.equal((await act(h, 103, { action: 'comment' })).status, 400)
    assert.equal((await act(h, 103, { action: 'markReady', batch: [101, 102] })).status, 400)
    assert.equal((await act(h, 103, { action: 'markReady', reviewer: 'sam-tran' })).status, 400)
    assert.equal((await act(h, 101, { action: 'requestReview' })).status, 400)
    assert.equal((await act(h, 101, { action: 'requestReview', reviewer: '' })).status, 400)
    assert.equal((await act(h, 101, { action: 'requestReview', reviewer: ['sam-tran'] })).status, 400)
    assert.equal(writesOf(h.runner).length, 0)
  } finally {
    await h.cleanup()
  }
})

test('an action is refused for other people\'s PRs and for PRs that are not open, whatever the page says', async () => {
  const h = await setup()
  try {
    await filled(h)
    for (const [number, action] of [[106, { action: 'markReady' }], [106, { action: 'convertToDraft' }], [113, requestReview], [119, { action: 'markReady' }]] as const) {
      const refused = await act(h, number, action)
      assert.equal(refused.status, 422, `#${number} ${action.action}`)
      assert.match(String(refused.body.error), /not your PR/)
    }
    const unknown = await act(h, 999, { action: 'markReady' })
    assert.equal(unknown.status, 422)
    assert.match(String(unknown.body.error), /not an open PR/)
    assert.equal(writesOf(h.runner).length, 0)
  } finally {
    await h.cleanup()
  }
})

test('the viewer must be known: with no viewer configured and none from gh, every PR is someone else\'s', async () => {
  const h = await setup({ config: { viewer: '' }, runner: fakeRunner((args) => (args[0] === 'config' ? failed('') : args[0] === 'api' && args[1] === 'user' ? failed('no account') : ok(''))) })
  try {
    const refused = await act(h, 103, { action: 'markReady' })
    assert.equal(refused.status, 422)
    assert.equal(writesOf(h.runner).length, 0)
  } finally {
    await h.cleanup()
  }
})

test('merge is a known action that is not offered: it is refused before gh is asked anything', async () => {
  const h = await setup()
  try {
    await filled(h)
    const before = h.runner.calls.length
    for (const number of [102, 101, 106]) {
      const refused = await act(h, number, { action: 'merge' })
      assert.equal(refused.status, 422)
      assert.match(String(refused.body.error), /merge is not offered/)
    }
    assert.equal(h.runner.calls.length, before)
  } finally {
    await h.cleanup()
  }
})

test('mark ready runs gh pr ready on a draft of the viewer\'s own and nothing else', async () => {
  const h = await setup()
  try {
    await filled(h)
    assert.equal((await rowOf(h, 103))?.merge.state, 'draft')
    const done = await act(h, 103, { action: 'markReady' })
    assert.equal(done.status, 200)
    assert.deepEqual(done.body, { number: 103, action: 'markReady', done: true })
    assert.deepEqual(writesOf(h.runner).map((call) => call.args), [['pr', 'ready', '103', '--repo', scenario.repo]])
    // the write ran with the viewer's own token, read from gh and passed as GH_TOKEN
    assert.equal(writesOf(h.runner)[0]?.options?.env?.GH_TOKEN, 'gho_fixture_token')
    await until(() => singleCallsOf(h.runner).length === 1)
    assert.equal(field(singleCallsOf(h.runner)[0]!.args, 'number'), '103')
  } finally {
    await h.cleanup()
  }
})

test('mark ready is refused for a PR that is not a draft, and convert to draft for one that is', async () => {
  const h = await setup()
  try {
    await filled(h)
    const ready = await act(h, 101, { action: 'markReady' })
    assert.equal(ready.status, 422)
    assert.match(String(ready.body.error), /not a draft/)
    const draft = await act(h, 103, { action: 'convertToDraft' })
    assert.equal(draft.status, 422)
    assert.match(String(draft.body.error), /already a draft/)
    assert.equal(writesOf(h.runner).length, 0)
  } finally {
    await h.cleanup()
  }
})

test('convert to draft runs gh pr ready --undo on an open PR of the viewer\'s own', async () => {
  const h = await setup()
  try {
    await filled(h)
    const done = await act(h, 101, { action: 'convertToDraft' })
    assert.equal(done.status, 200)
    assert.deepEqual(done.body, { number: 101, action: 'convertToDraft', done: true })
    assert.deepEqual(writesOf(h.runner).map((call) => call.args), [['pr', 'ready', '101', '--undo', '--repo', scenario.repo]])
    await until(() => singleCallsOf(h.runner).length === 1)
  } finally {
    await h.cleanup()
  }
})

test('request review asks GitHub for one reviewer chosen from people, and refuses anyone else', async () => {
  const h = await setup()
  try {
    await filled(h)
    const done = await act(h, 101, { action: 'requestReview', reviewer: 'Sam-Tran' })
    assert.equal(done.status, 200)
    assert.deepEqual(done.body, { number: 101, action: 'requestReview', done: true, reviewer: 'sam-tran' })
    assert.deepEqual(writesOf(h.runner).map((call) => call.args), [
      ['api', '--method', 'POST', `repos/${scenario.repo}/pulls/101/requested_reviewers`, '-f', 'reviewers[]=sam-tran'],
    ])
    await until(() => singleCallsOf(h.runner).length === 1)

    // someone who is not in people, the viewer themself, and a flag-shaped name
    for (const reviewer of ['priya-k', scenario.viewer, '--add-reviewer=x']) {
      const refused = await act(h, 101, { action: 'requestReview', reviewer })
      assert.equal(refused.status, 422, reviewer)
    }
    assert.equal(writesOf(h.runner).length, 1)
  } finally {
    await h.cleanup()
  }
})

test('request review is allowed on a draft, since GitHub allows it', async () => {
  const h = await setup()
  try {
    await filled(h)
    assert.equal((await act(h, 103, requestReview)).status, 200)
    assert.equal(writesOf(h.runner).length, 1)
  } finally {
    await h.cleanup()
  }
})

test('after an action the PR is refreshed on its own and the updated row arrives as a patch', async () => {
  const h = await setup({
    runner: ghWorld({
      single: async (number) => {
        // GitHub now says the draft is ready for review
        return singlePr(number, { patch: { isDraft: false } })
      },
    }),
  })
  try {
    await filled(h)
    const stream = await collectPatches(h.base)
    const cyclesBefore = (await (await fetch(`${h.base}/api/view`)).json() as View).sync.cycle?.id
    const done = await act(h, 103, { action: 'markReady' })
    assert.equal(done.status, 200)
    await until(() => stream.patches.some((patch) => patch.rows.some((row) => row.number === 103 && row.refresh === null && row.merge.state !== 'draft')))
    // two patches, as for any one-PR refresh: the row refreshing, then the row as GitHub now has it
    const mine = stream.patches.filter((patch) => patch.rows.some((row) => row.number === 103))
    assert.equal(mine[0]?.rows.find((row) => row.number === 103)?.refresh?.state, 'running')
    const row = (await rowOf(h, 103))!
    assert.notEqual(row.merge.state, 'draft')
    assert.equal(row.refresh, null)
    // no cycle ran
    assert.equal((await (await fetch(`${h.base}/api/view`)).json() as View).sync.cycle?.id, cyclesBefore)
    assert.ok(stream.patches.every((patch) => patch.sync === undefined))
    stream.close()
  } finally {
    await h.cleanup()
  }
})

test('a write GitHub refuses is a 502 with the reason, and the row is read again since the cache may be what is wrong', async () => {
  const h = await setup({ runner: ghWorld({ writeError: 'GraphQL: Pull request is not a draft (markPullRequestReadyForReview)' }) })
  try {
    await filled(h)
    const refused = await act(h, 103, { action: 'markReady' })
    assert.equal(refused.status, 502)
    assert.match(String(refused.body.error), /not a draft/)
    assert.equal(refused.body.errorKind, 'command')
    assert.equal(writesOf(h.runner).length, 1)
    await until(() => singleCallsOf(h.runner).length === 1)
  } finally {
    await h.cleanup()
  }
})

test('an action is refused while gh is signed in as another account than the viewer, before any write', async () => {
  const h = await setup({ runner: ghWorld({ account: 'someone-else' }) })
  try {
    await filled(h)
    const refused = await act(h, 103, { action: 'markReady' })
    assert.equal(refused.status, 422)
    assert.match(String(refused.body.error), /someone-else/)
    assert.match(String(refused.body.error), new RegExp(scenario.viewer))
    assert.equal(writesOf(h.runner).length, 0)
  } finally {
    await h.cleanup()
  }
})

test('a second click while an action on the same PR is in flight writes once', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const h = await setup({ runner: ghWorld({ gate }) })
  try {
    await filled(h)
    const first = act(h, 103, { action: 'markReady' })
    await until(() => writesOf(h.runner).length === 1)
    const second = await act(h, 103, { action: 'markReady' })
    assert.equal(second.status, 409)
    release()
    assert.equal((await first).status, 200)
    assert.equal(writesOf(h.runner).length, 1)
  } finally {
    release()
    await h.cleanup()
  }
})

test('the pure parts: parseAction names what it refuses, and ghArgs is exactly what gh is asked', () => {
  assert.deepEqual(parseAction({ action: 'markReady' }), { action: 'markReady' })
  assert.deepEqual(parseAction({ action: 'requestReview', reviewer: 'sam-tran' }), { action: 'requestReview', reviewer: 'sam-tran' })
  assert.throws(() => parseAction(null), /send \{/)
  assert.throws(() => parseAction({ action: 'merge' }), /not offered/)
  assert.deepEqual(ghArgs('o/r', 7, { action: 'markReady' }), ['pr', 'ready', '7', '--repo', 'o/r'])
  assert.deepEqual(ghArgs('o/r', 7, { action: 'convertToDraft' }), ['pr', 'ready', '7', '--undo', '--repo', 'o/r'])
})
