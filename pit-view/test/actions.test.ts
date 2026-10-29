// test/actions.test.ts
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { ghArgs, parseAction } from '../src/actions.ts'
import { isPrimaryBase } from '../src/derive.ts'
import type { Config } from '../src/config.ts'
import type { OpenRow } from '../src/derive.ts'
import type { RawOpenResponse } from '../src/github.ts'
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

// a gh that answers the fixture world, records the writes it was asked for, and lets a test change what the one-PR query and the account lookup say
type Behavior = {
  // the account `gh api user` reports
  account?: string
  // a write that fails with this stderr
  writeError?: string
  // holds every write until the returned function is called
  gate?: Promise<void>
  single?: (number: number) => Promise<unknown>
  // the base branch each listed PR has, by number, instead of the fixture's
  bases?: Record<number, string>
  // called when a write has been accepted
  onWrite?: () => void
  // what the live read of one PR (just before a merge) says, over the fixture's own state
  live?: (number: number) => Record<string, unknown>
}

const isWrite = (args: string[]): boolean =>
  (args[0] === 'pr' && (args[1] === 'ready' || args[1] === 'merge')) || (args[0] === 'api' && args.includes('--method'))

const writesOf = (runner: FakeRunner): Call[] => runner.calls.filter((call) => isWrite(call.args))
const singleCallsOf = (runner: FakeRunner): Call[] =>
  runner.calls.filter((call) => call.args[0] === 'api' && (field(call.args, 'query') ?? '').includes('query SinglePullRequest'))

const isLiveRead = (args: string[]): boolean => args[0] === 'api' && /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(args[1] ?? '') && !args.includes('--method')
const liveReadsOf = (runner: FakeRunner): Call[] => runner.calls.filter((call) => isLiveRead(call.args))

// the head SHA and base the fixture world gives each listed PR
const listed = async (number: number): Promise<{ sha: string, base: string }> => {
  const node = (await singlePr(number)).data.repository!.pullRequest!
  return { sha: node.headRefOid, base: node.baseRefName }
}

// a merge request as the page sends it: the full head SHA and base branch the confirmation showed
const mergeBody = async (number: number): Promise<{ action: 'merge', headSha: string, base: string }> => {
  const { sha, base } = await listed(number)
  return { action: 'merge', headSha: sha, base }
}

// a well-formed merge body for refusals that come before the binding is compared
const placeholderMerge = { action: 'merge', headSha: 'a'.repeat(40), base: 'main' }

const ghWorld = (behavior: Behavior = {}): FakeRunner => {
  const base = fixtureRunner()
  return fakeRunner(async (args) => {
    if (isLiveRead(args)) {
      const number = Number(args[1]!.split('/').pop())
      const { sha, base: ref } = await listed(number)
      return ok(JSON.stringify({ state: 'open', draft: false, merged: false, mergeable: true, mergeable_state: 'clean', base: { ref }, head: { sha }, ...behavior.live?.(number) }))
    }
    if (isWrite(args)) {
      await behavior.gate
      if (behavior.writeError !== undefined) return failed(behavior.writeError)
      behavior.onWrite?.()
      return ok('')
    }
    if (args[0] === 'api' && args[1] === 'user') return ok(`${behavior.account ?? scenario.viewer}\n`)
    if (args[0] === 'api' && args[1] === 'graphql' && (field(args, 'query') ?? '').includes('query SinglePullRequest') && behavior.single !== undefined) {
      return ok(JSON.stringify(await behavior.single(Number(field(args, 'number')))))
    }
    const answer = await base.runner(args)
    if (behavior.bases !== undefined && args[0] === 'api' && args[1] === 'graphql' && (field(args, 'query') ?? '').includes('query OpenPullRequests')) {
      const parsed = JSON.parse(answer.stdout) as RawOpenResponse
      for (const node of parsed.data.repository?.pullRequests.nodes ?? []) node.baseRefName = behavior.bases[node.number] ?? node.baseRefName
      return ok(JSON.stringify(parsed))
    }
    return answer
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

// a request body as the page sends it: the repository the confirmation displayed is always in it, so a test that does not mean to vary it gets the configured one
const withRepo = (body: unknown): unknown =>
  typeof body === 'object' && body !== null && !Array.isArray(body) && !('repo' in body) ? { repo: scenario.repo, ...body } : body

const act = async (h: Harness, number: number | string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number, body: Record<string, unknown> }> => {
  const response = await fetch(`${h.base}/api/prs/${number}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: h.base, 'X-Pit-View-Token': h.server.token, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(withRepo(body)),
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

// the scenario's PRs: 101 is the viewer's and open for review, 103 the viewer's draft, 106 and 113 are other people's
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

test('the server refuses what the page should never send: a bad number, body, action, or field', async () => {
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

// the scenario's merge states for the viewer's own PRs: 102 is ready (approved, CLEAN), 101 and 120 are blocked, 104 needs review, 103 is a draft; 110 is ready but someone else's, and 100 was merged
const refusedWithoutGh = async (h: Harness, number: number | string, body: unknown, status: number, error: RegExp): Promise<void> => {
  const before = h.runner.calls.length
  const refused = await act(h, number, body)
  assert.equal(refused.status, status, `#${number}`)
  assert.match(String(refused.body.error), error, `#${number}`)
  // not even the account lookup: the refusal came before gh was asked anything
  assert.equal(h.runner.calls.length, before, `#${number} asked gh nothing`)
  assert.equal(writesOf(h.runner).length, 0)
}

test('merge squashes a ready PR of the viewer\'s own into its primary base through the REST endpoint, with the viewer\'s token', async () => {
  const h = await setup()
  try {
    await filled(h)
    const row = (await rowOf(h, 102))!
    assert.equal(row.merge.state, 'ready')
    assert.equal(row.section, 'mine')
    const done = await act(h, 102, await mergeBody(102))
    assert.equal(done.status, 200)
    assert.deepEqual(done.body, { number: 102, action: 'merge', done: true })
    assert.deepEqual(writesOf(h.runner).map((call) => call.args), [['api', '--method', 'PUT', `repos/${scenario.repo}/pulls/102/merge`, '-f', 'merge_method=squash', '-f', `sha=${(await listed(102)).sha}`]])
    assert.equal(writesOf(h.runner)[0]?.options?.env?.GH_TOKEN, 'gho_fixture_token')
    // the account was confirmed before the write
    const lookup = h.runner.calls.findIndex((call) => call.args[0] === 'api' && call.args[1] === 'user')
    assert.ok(lookup >= 0 && lookup < h.runner.calls.indexOf(writesOf(h.runner)[0]!))
    await until(() => singleCallsOf(h.runner).length === 1)
    assert.equal(field(singleCallsOf(h.runner)[0]!.args, 'number'), '102')
  } finally {
    await h.cleanup()
  }
})

test('merge is refused unless the cached merge state is ready, and gh is not asked anything', async () => {
  const h = await setup()
  try {
    await filled(h)
    for (const [number, state] of [[101, 'blocked'], [104, 'needsReview'], [120, 'blocked']] as const) {
      assert.equal((await rowOf(h, number))?.merge.state, state)
      await refusedWithoutGh(h, number, await mergeBody(102), 422, /not ready to merge/)
    }
  } finally {
    await h.cleanup()
  }
})

test('merge is refused for a draft, and gh is not asked anything', async () => {
  const h = await setup()
  try {
    await filled(h)
    assert.equal((await rowOf(h, 103))?.merge.state, 'draft')
    await refusedWithoutGh(h, 103, placeholderMerge, 422, /is a draft/)
  } finally {
    await h.cleanup()
  }
})

test('merge is refused for other people\'s PRs, even a ready one, and gh is not asked anything', async () => {
  const h = await setup()
  try {
    await filled(h)
    assert.equal((await rowOf(h, 110))?.merge.state, 'ready')
    await refusedWithoutGh(h, 110, placeholderMerge, 422, /not your PR/)
    await refusedWithoutGh(h, 106, placeholderMerge, 422, /not your PR/)
  } finally {
    await h.cleanup()
  }
})

test('merge is refused for a PR that is not open, and gh is not asked anything', async () => {
  const h = await setup()
  try {
    await filled(h)
    // 100 is the viewer's own PR, already merged; 999 was never fetched
    await refusedWithoutGh(h, 100, placeholderMerge, 422, /not an open PR/)
    await refusedWithoutGh(h, 999, placeholderMerge, 422, /not an open PR/)
  } finally {
    await h.cleanup()
  }
})

test('merge is refused unless the PR targets the primary branch: a stacked PR or a release branch is refused with no gh call', async () => {
  const h = await setup({ runner: ghWorld({ bases: { 102: 'feat/parent-branch' } }) })
  try {
    await filled(h)
    const row = (await rowOf(h, 102))!
    assert.equal(row.merge.state, 'ready')
    assert.equal(row.baseRef, 'feat/parent-branch')
    await refusedWithoutGh(h, 102, placeholderMerge, 422, /feat\/parent-branch.*main|primary branch/)
  } finally {
    await h.cleanup()
  }
  const release = await setup({ runner: ghWorld({ bases: { 102: 'release/2.4' } }) })
  try {
    await filled(release)
    await refusedWithoutGh(release, 102, placeholderMerge, 422, /release\/2\.4/)
    assert.equal(writesOf(release.runner).length, 0)
  } finally {
    await release.cleanup()
  }
})

test('merge goes by the default branch the cache holds: master is refused where the repository\'s default is main', async () => {
  const h = await setup({ runner: ghWorld({ bases: { 102: 'master' } }) })
  try {
    await filled(h)
    await refusedWithoutGh(h, 102, placeholderMerge, 422, /master/)
  } finally {
    await h.cleanup()
  }
})

test('the primary branch is the default branch when it is known, and exactly master or main when it is not', () => {
  assert.equal(isPrimaryBase('main', 'main'), true)
  assert.equal(isPrimaryBase('master', 'main'), false)
  assert.equal(isPrimaryBase('develop', 'develop'), true)
  assert.equal(isPrimaryBase('release/2.4', 'main'), false)
  for (const name of ['master', 'main']) assert.equal(isPrimaryBase(name, null), true)
  for (const name of ['Main', 'main2', 'release', 'feat/x', '', 'origin/main', 'main ']) assert.equal(isPrimaryBase(name, null), false, name)
})

test('merge takes no other field: a method, a branch deletion, admin or auto flag, or a message is refused before gh is asked', async () => {
  const h = await setup()
  try {
    await filled(h)
    for (const extra of [{ method: 'merge' }, { deleteBranch: true }, { admin: true }, { auto: true }, { subject: 'x' }, { body: 'x' }, { reviewer: 'sam-tran' }]) {
      await refusedWithoutGh(h, 102, { ...(await mergeBody(102)), ...extra }, 400, /unknown field|takes no reviewer/)
    }
  } finally {
    await h.cleanup()
  }
})

test('merge needs the same Origin and token as every action, and a refusal reaches neither gh nor GitHub', async () => {
  const h = await setup()
  try {
    await filled(h)
    const before = h.runner.calls.length
    assert.equal((await act(h, 102, await mergeBody(102), { Origin: 'http://attacker.test' })).status, 403)
    assert.equal((await act(h, 102, await mergeBody(102), { Origin: '' })).status, 403)
    assert.equal((await act(h, 102, await mergeBody(102), { 'X-Pit-View-Token': 'not-the-token' })).status, 403)
    const noToken = await fetch(`${h.base}/api/prs/102/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: h.base },
      body: JSON.stringify(await mergeBody(102)),
    })
    assert.equal(noToken.status, 403)
    assert.equal(h.runner.calls.length, before)
  } finally {
    await h.cleanup()
  }
})

test('merge is refused while gh is signed in as another account than the viewer, before any write', async () => {
  const h = await setup({ runner: ghWorld({ account: 'someone-else' }) })
  try {
    await filled(h)
    const refused = await act(h, 102, await mergeBody(102))
    assert.equal(refused.status, 422)
    assert.match(String(refused.body.error), /someone-else/)
    assert.equal(writesOf(h.runner).length, 0)
  } finally {
    await h.cleanup()
  }
})

test('a merge GitHub refuses is a 502 with the reason and claims nothing: no done, no state change, and the row is read again', async () => {
  const h = await setup({ runner: ghWorld({ writeError: 'X Pull request is not mergeable: the base branch policy prohibits the merge' }) })
  try {
    await filled(h)
    const refused = await act(h, 102, await mergeBody(102))
    assert.equal(refused.status, 502)
    assert.match(String(refused.body.error), /base branch policy/)
    assert.equal(refused.body.errorKind, 'command')
    assert.equal(refused.body.done, undefined)
    assert.equal(writesOf(h.runner).length, 1)
    // the cache was not touched by the refusal: the PR is still an open, ready row
    await until(() => singleCallsOf(h.runner).length === 1)
    assert.equal((await rowOf(h, 102))?.merge.state, 'ready')
  } finally {
    await h.cleanup()
  }
})

test('after a merge the PR is refreshed on its own and its row leaves the open tables as a patch', async () => {
  const h = await setup({
    runner: ghWorld({
      // GitHub now says the PR is merged
      single: async (number) => singlePr(number, { state: 'MERGED' }),
    }),
  })
  try {
    await filled(h)
    const stream = await collectPatches(h.base)
    const cyclesBefore = (await (await fetch(`${h.base}/api/view`)).json() as View).sync.cycle?.id
    const done = await act(h, 102, await mergeBody(102))
    assert.equal(done.status, 200)
    await until(() => stream.patches.some((patch) => patch.removed.includes(102)))
    const mine = stream.patches.filter((patch) => patch.rows.some((row) => row.number === 102) || patch.removed.includes(102))
    assert.equal(mine[0]?.rows.find((row) => row.number === 102)?.refresh?.state, 'running')
    assert.equal(await rowOf(h, 102), undefined)
    // no cycle ran
    assert.equal((await (await fetch(`${h.base}/api/view`)).json() as View).sync.cycle?.id, cyclesBefore)
    assert.ok(stream.patches.every((patch) => patch.sync === undefined))
    stream.close()
  } finally {
    await h.cleanup()
  }
})

test('a second click while a merge is in flight writes once', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const h = await setup({ runner: ghWorld({ gate }) })
  try {
    await filled(h)
    const first = act(h, 102, await mergeBody(102))
    await until(() => writesOf(h.runner).length === 1)
    const second = await act(h, 102, await mergeBody(102))
    assert.equal(second.status, 409)
    release()
    assert.equal((await first).status, 200)
    assert.equal(writesOf(h.runner).length, 1)
  } finally {
    release()
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

test('a write that fails is not retried, even with a 401, and the write used the viewer\'s token', async () => {
  const h = await setup({ runner: ghWorld({ writeError: 'HTTP 401: Bad credentials' }) })
  try {
    await filled(h)
    const refused = await act(h, 103, { action: 'markReady' })
    assert.equal(refused.status, 502)
    assert.equal(refused.body.errorKind, 'auth')
    assert.equal(writesOf(h.runner).length, 1)
    assert.equal(writesOf(h.runner)[0]?.options?.env?.GH_TOKEN, 'gho_fixture_token')
    await until(() => singleCallsOf(h.runner).length === 1)
    await h.server.poller.idle()
    assert.equal(writesOf(h.runner).length, 1)
  } finally {
    await h.cleanup()
  }
})

test('a refresh already in flight when an action finishes cannot be the post-action answer: one more refresh runs after it, and its row is the one that arrives last', async () => {
  let written = false
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let asked = 0
  const h = await setup({
    runner: ghWorld({
      onWrite: () => {
        written = true
      },
      single: async (number) => {
        asked += 1
        // what GitHub says at the moment this read starts; the first one is then held open
        const stale = !written
        if (asked === 1) await held
        return singlePr(number, { patch: { isDraft: stale } })
      },
    }),
  })
  try {
    await filled(h)
    const stream = await collectPatches(h.base)
    // an earlier refresh of #103 (a page asking) reads the draft, and is still waiting on GitHub
    const earlier = fetch(`${h.base}/api/prs/103/refresh`, { method: 'POST' })
    await until(() => singleCallsOf(h.runner).length === 1)
    const done = await act(h, 103, { action: 'markReady' })
    assert.equal(done.status, 200)
    // the held answer arrives only now, after the write, and it still says draft
    release()
    await earlier
    await until(() => singleCallsOf(h.runner).length === 2)
    await h.server.poller.idle()
    await until(() => stream.patches.some((patch) => patch.rows.some((row) => row.number === 103 && row.refresh === null && row.merge.state !== 'draft')))
    const last = [...stream.patches].reverse().find((patch) => patch.rows.some((row) => row.number === 103))
    assert.notEqual(last?.rows.find((row) => row.number === 103)?.merge.state, 'draft')
    assert.notEqual((await rowOf(h, 103))?.merge.state, 'draft')
    assert.equal(singleCallsOf(h.runner).length, 2)
    stream.close()
  } finally {
    release()
    await h.cleanup()
  }
})

test('several post-write refreshes asked while one is in flight coalesce into one more', async () => {
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let asked = 0
  const h = await setup({
    runner: ghWorld({
      single: async (number) => {
        asked += 1
        if (asked === 1) await held
        return singlePr(number)
      },
    }),
  })
  try {
    await filled(h)
    const first = h.server.poller.refreshPr(103)
    await until(() => singleCallsOf(h.runner).length === 1)
    const after = [h.server.poller.refreshPrAfterWrite(scenario.repo, 103), h.server.poller.refreshPrAfterWrite(scenario.repo, 103), h.server.poller.refreshPrAfterWrite(scenario.repo, 103)]
    release()
    await first
    await Promise.all(after)
    assert.equal(singleCallsOf(h.runner).length, 2)
    // with nothing in flight it is simply one refresh
    await h.server.poller.refreshPrAfterWrite(scenario.repo, 103)
    assert.equal(singleCallsOf(h.runner).length, 3)
  } finally {
    release()
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
  assert.deepEqual(parseAction({ action: 'markReady', repo: 'o/r' }), { action: 'markReady', repo: 'o/r' })
  assert.deepEqual(parseAction({ action: 'requestReview', repo: 'o/r', reviewer: 'sam-tran' }), { action: 'requestReview', repo: 'o/r', reviewer: 'sam-tran' })
  assert.throws(() => parseAction(null), /send \{/)
  const sha = 'a'.repeat(40)
  assert.deepEqual(parseAction({ action: 'merge', repo: 'o/r', headSha: sha, base: 'main' }), { action: 'merge', repo: 'o/r', headSha: sha, base: 'main' })
  assert.deepEqual(parseAction({ action: 'merge', repo: 'o/r', headSha: sha.toUpperCase(), base: 'main' }), { action: 'merge', repo: 'o/r', headSha: sha, base: 'main' })
  // the repository the confirmation displayed is required on all four, as a non-empty string
  for (const body of [{ action: 'merge', headSha: sha, base: 'main' }, { action: 'markReady' }, { action: 'convertToDraft' }, { action: 'requestReview', reviewer: 'sam-tran' }]) {
    assert.throws(() => parseAction(body), /needs repo/, JSON.stringify(body))
    assert.throws(() => parseAction({ ...body, repo: '' }), /needs repo/)
    assert.throws(() => parseAction({ ...body, repo: ['o/r'] }), /needs repo/)
  }
  assert.throws(() => parseAction({ action: 'merge', repo: 'o/r', headSha: sha, base: 'main', method: 'rebase' }), /unknown field method/)
  assert.throws(() => parseAction({ action: 'merge', repo: 'o/r', headSha: sha, base: 'main', reviewer: 'sam-tran' }), /takes no reviewer/)
  // the confirmation's head and base are required, and the head must be a full SHA
  assert.throws(() => parseAction({ action: 'merge', repo: 'o/r' }), /merge needs headSha/)
  assert.throws(() => parseAction({ action: 'merge', repo: 'o/r', base: 'main' }), /merge needs headSha/)
  assert.throws(() => parseAction({ action: 'merge', repo: 'o/r', headSha: sha }), /merge needs .*base/)
  assert.throws(() => parseAction({ action: 'merge', repo: 'o/r', headSha: sha, base: '' }), /merge needs .*base/)
  assert.throws(() => parseAction({ action: 'merge', repo: 'o/r', headSha: 'a'.repeat(7), base: 'main' }), /full 40-character/)
  assert.throws(() => parseAction({ action: 'merge', repo: 'o/r', headSha: 'z'.repeat(40), base: 'main' }), /full 40-character/)
  for (const action of ['markReady', 'convertToDraft']) {
    assert.throws(() => parseAction({ action, repo: 'o/r', headSha: sha }), /takes no headSha/)
    assert.throws(() => parseAction({ action, repo: 'o/r', base: 'main' }), /takes no base/)
  }
  assert.throws(() => parseAction({ action: 'requestReview', repo: 'o/r', reviewer: 'sam-tran', headSha: sha }), /takes no headSha/)
  assert.deepEqual(ghArgs('o/r', 7, { action: 'merge', repo: 'o/r', headSha: 'a'.repeat(40), base: 'main' }, 'a'.repeat(40)), ['api', '--method', 'PUT', 'repos/o/r/pulls/7/merge', '-f', 'merge_method=squash', '-f', `sha=${'a'.repeat(40)}`])
  assert.deepEqual(ghArgs('o/r', 7, { action: 'markReady', repo: 'o/r' }), ['pr', 'ready', '7', '--repo', 'o/r'])
  assert.deepEqual(ghArgs('o/r', 7, { action: 'convertToDraft', repo: 'o/r' }), ['pr', 'ready', '7', '--undo', '--repo', 'o/r'])
})

test('the merge names the cached full head SHA, and the live PR is read once, with the verified token, before the write', async () => {
  const h = await setup()
  try {
    await filled(h)
    assert.equal((await act(h, 102, await mergeBody(102))).status, 200)
    const write = writesOf(h.runner)[0]!
    const { sha } = await listed(102)
    assert.equal(sha.length, 40)
    assert.ok(write.args.includes(`sha=${sha}`))
    assert.deepEqual(write.args.filter((arg) => arg.includes('=')), ['merge_method=squash', `sha=${sha}`])
    const reads = liveReadsOf(h.runner)
    assert.equal(reads.length, 1)
    assert.equal(reads[0]!.options?.env?.GH_TOKEN, 'gho_fixture_token')
    assert.ok(h.runner.calls.indexOf(reads[0]!) < h.runner.calls.indexOf(write))
  } finally {
    await h.cleanup()
  }
})

test('a merge is refused with no write when the live head differs from the cached one, and the row is read again', async () => {
  const h = await setup({ runner: ghWorld({ live: () => ({ head: { sha: 'b'.repeat(40) } }) }) })
  try {
    await filled(h)
    const refused = await act(h, 102, await mergeBody(102))
    assert.equal(refused.status, 422)
    assert.match(String(refused.body.error), /new commits/)
    assert.match(String(refused.body.error), /nothing was merged/)
    assert.equal(writesOf(h.runner).length, 0)
    await until(() => singleCallsOf(h.runner).length === 1)
  } finally {
    await h.cleanup()
  }
})

test('a merge is refused with no write when the base was retargeted, or the PR is no longer open and mergeable', async () => {
  for (const [live, error] of [
    [{ base: { ref: 'release/2' } }, /now targets release\/2/],
    [{ state: 'closed' }, /no longer open/],
    [{ merged: true, state: 'closed' }, /no longer open/],
    [{ draft: true }, /draft/],
    [{ mergeable: null }, /not mergeable/],
    [{ mergeable_state: 'dirty', mergeable: false }, /not mergeable/],
  ] as const) {
    const h = await setup({ runner: ghWorld({ live: () => live }) })
    try {
      await filled(h)
      const refused = await act(h, 102, await mergeBody(102))
      assert.equal(refused.status, 422, JSON.stringify(live))
      assert.match(String(refused.body.error), error)
      assert.equal(writesOf(h.runner).length, 0, JSON.stringify(live))
    } finally {
      await h.cleanup()
    }
  }
})

test('GitHub answering 409 to the merge is a refusal that claims nothing was merged, and the row is read again', async () => {
  const h = await setup({ runner: ghWorld({ writeError: 'gh: Head branch was modified. Review and try the merge again. (HTTP 409)' }) })
  try {
    await filled(h)
    const refused = await act(h, 102, await mergeBody(102))
    assert.equal(refused.status, 502)
    assert.match(String(refused.body.error), /changed since you saw it/)
    assert.match(String(refused.body.error), /nothing was merged/)
    assert.equal(writesOf(h.runner).length, 1)
    await until(() => singleCallsOf(h.runner).length === 1)
  } finally {
    await h.cleanup()
  }
})

test('a refresh after an action targets the repository the write used, even when Settings changes it mid-flight, and never patches the other repository\'s table', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const other = 'other-org/other-repo'
  const h = await setup({ runner: ghWorld({ gate }) })
  try {
    await filled(h)
    const stream = await collectPatches(h.base)
    const pending = act(h, 103, { action: 'markReady' })
    await until(() => writesOf(h.runner).length === 1)
    const stored = await (await fetch(`${h.base}/api/config`)).json() as Config
    const changed = await fetch(`${h.base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...stored, repo: other }),
    })
    assert.equal(changed.status, 200)
    const before = singleCallsOf(h.runner).length
    release()
    assert.equal((await pending).status, 200)
    await until(() => singleCallsOf(h.runner).length > before)
    const asked = singleCallsOf(h.runner).slice(before)
    assert.ok(asked.every((call) => field(call.args, 'owner') === scenario.repo.split('/')[0] && field(call.args, 'name') === scenario.repo.split('/')[1]))
    await h.server.poller.idle()
    assert.ok(stream.patches.every((patch) => !patch.rows.some((row) => row.number === 103 && row.refresh === null && row.merge.state !== 'draft')))
    stream.close()
  } finally {
    release()
    await h.cleanup()
  }
})

// the confirmation named a head and a base; the cache can move before the page learns of it, so the request carries them and the server refuses, writing nothing, when its row differs
const staleRefusal = async (h: Harness, body: unknown, error: RegExp): Promise<void> => {
  const refused = await act(h, 102, body)
  assert.equal(refused.status, 409)
  assert.match(String(refused.body.error), error)
  assert.equal(refused.body.done, undefined)
  assert.equal(writesOf(h.runner).length, 0, 'nothing was written')
  assert.equal(liveReadsOf(h.runner).length, 0, 'refused before the live read')
  assert.equal(h.runner.calls.some((call) => call.args[0] === 'api' && call.args[1] === 'user'), false, 'refused before the account lookup')
}

test('a merge request carrying a head SHA other than the cached row\'s is refused with 409 and no write, and the row is read again', async () => {
  const h = await setup()
  try {
    await filled(h)
    const body = await mergeBody(102)
    // the viewer saw an older head; the cache has moved on
    await staleRefusal(h, { ...body, headSha: 'b'.repeat(40) }, /new commits|changed since you saw it/)
    await until(() => singleCallsOf(h.runner).length === 1)
  } finally {
    await h.cleanup()
  }
})

test('a merge request carrying a base other than the cached row\'s is refused with 409 and no write', async () => {
  const h = await setup()
  try {
    await filled(h)
    const body = await mergeBody(102)
    await staleRefusal(h, { ...body, base: 'release/2.4' }, /targets|changed since you saw it/)
  } finally {
    await h.cleanup()
  }
})

test('a cache that moved after the confirmation was shown makes it stale: the newer head is never merged', async () => {
  // a base that moved to a non-primary branch is refused earlier (422, not the primary branch); the head is what can move unseen
  for (const patch of [{ headRefOid: 'c'.repeat(40) }]) {
    const h = await setup({ runner: ghWorld({ single: async (number) => singlePr(number, { patch }) }) })
    try {
      await filled(h)
      // what the viewer's page showed when the confirmation opened
      const shown = await mergeBody(102)
      // the poller then caches the PR's new state, and the page has not been patched with it yet
      const refresh = await fetch(`${h.base}/api/prs/102/refresh`, { method: 'POST', headers: { Origin: h.base, 'X-Pit-View-Token': h.server.token } })
      assert.equal(refresh.status, 200)
      await until(() => singleCallsOf(h.runner).length === 1)
      for (let tries = 0; tries < 400; tries += 1) {
        const row = await rowOf(h, 102)
        if (row !== undefined && (row.baseRef !== shown.base || row.headSha !== shown.headSha)) break
        await delay(5)
      }
      const moved = await rowOf(h, 102)
      assert.ok(moved !== undefined && (moved.baseRef !== shown.base || moved.headSha !== shown.headSha), 'the cache moved')
      const before = h.runner.calls.length
      const refused = await act(h, 102, shown)
      assert.equal(refused.status, 409, JSON.stringify(patch))
      assert.equal(writesOf(h.runner).length, 0)
      assert.equal(liveReadsOf(h.runner).length, 0)
      assert.equal(h.runner.calls.slice(before).filter((call) => call.args[0] === 'api' && call.args[1] === 'user').length, 0)
    } finally {
      await h.cleanup()
    }
  }
})

test('a merge request carrying the cached head and base succeeds, and the write uses the confirmed SHA as its precondition', async () => {
  const h = await setup()
  try {
    await filled(h)
    const body = await mergeBody(102)
    const done = await act(h, 102, { ...body, headSha: body.headSha.toUpperCase() })
    assert.equal(done.status, 200)
    const write = writesOf(h.runner)[0]!
    assert.ok(write.args.includes(`sha=${body.headSha}`))
    assert.equal(writesOf(h.runner).length, 1)
    assert.equal(liveReadsOf(h.runner).length, 1)
  } finally {
    await h.cleanup()
  }
})

test('the other actions carry nothing to bind: a head SHA or base on them is refused, and their state is the action\'s own precondition', async () => {
  const h = await setup()
  try {
    await filled(h)
    const sha = (await listed(103)).sha
    await refusedWithoutGh(h, 103, { action: 'markReady', headSha: sha }, 400, /takes no headSha/)
    await refusedWithoutGh(h, 101, { action: 'convertToDraft', base: 'main' }, 400, /takes no base/)
    await refusedWithoutGh(h, 101, { action: 'requestReview', reviewer: 'sam-tran', headSha: sha }, 400, /takes no headSha/)
    // the state each confirmation shows is checked against the cache already: a draft shown as ready-to-convert, or a ready PR shown as a draft, is refused
    await refusedWithoutGh(h, 102, { action: 'markReady' }, 422, /not a draft/)
    await refusedWithoutGh(h, 103, { action: 'convertToDraft' }, 422, /already a draft/)
  } finally {
    await h.cleanup()
  }
})

// the confirmation displayed a repository; Settings can change it before the page's feed patch arrives, and #<n> in the new repository is another PR, so every action names the repository and the server refuses one that is not in effect
const other = 'other-org/other-repo'

const stranger = async (h: Harness, repo: string): Promise<void> => {
  const stored = await (await fetch(`${h.base}/api/config`)).json() as Config
  const changed = await fetch(`${h.base}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...stored, repo }),
  })
  assert.equal(changed.status, 200)
}

const actionBodies = async (): Promise<[number, Record<string, unknown>][]> => [
  [102, { ...await mergeBody(102) }],
  [103, { action: 'markReady' }],
  [101, { action: 'convertToDraft' }],
  [101, { action: 'requestReview', reviewer: 'sam-tran' }],
]

test('every action carrying a repository other than the one in effect is refused with 409, no gh call at all, and leaves nothing in flight', async () => {
  const h = await setup()
  try {
    await filled(h)
    for (const [number, body] of await actionBodies()) {
      const before = h.runner.calls.length
      const refused = await act(h, number, { ...body, repo: other })
      assert.equal(refused.status, 409, String(body.action))
      assert.match(String(refused.body.error), new RegExp(`the repository is now ${scenario.repo}, not ${other}.*nothing was done`))
      assert.equal(refused.body.done, undefined)
      assert.equal(h.runner.calls.length, before, 'refused before any account lookup, live read, refresh, or write')
      // nothing is left in flight: the same action for the right repository goes through at once
      const done = await act(h, number, body)
      assert.equal(done.status, 200, `${String(body.action)}: ${JSON.stringify(done.body)}`)
    }
    assert.equal(writesOf(h.runner).length, 4, 'only the four matching requests wrote')
  } finally {
    await h.cleanup()
  }
})

test('a repository switched in Settings after the confirmation opened refuses its action, and switching back lets the same request through', async () => {
  const h = await setup()
  try {
    await filled(h)
    for (const [number, body] of await actionBodies()) {
      await stranger(h, other)
      const before = writesOf(h.runner).length
      const refused = await act(h, number, body)
      assert.equal(refused.status, 409, String(body.action))
      assert.match(String(refused.body.error), new RegExp(`the repository is now ${other}, not ${scenario.repo}`))
      assert.equal(writesOf(h.runner).length, before, 'nothing was written')
      await stranger(h, scenario.repo)
      assert.equal((await act(h, number, body)).status, 200, String(body.action))
    }
  } finally {
    await h.cleanup()
  }
})

test('an action without a repository is 400, with no gh call, and the matching repository is compared exactly', async () => {
  const h = await setup()
  try {
    await filled(h)
    const before = h.runner.calls.length
    for (const [number, body] of await actionBodies()) {
      const missing = await fetch(`${h.base}/api/prs/${number}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: h.base, 'X-Pit-View-Token': h.server.token },
        body: JSON.stringify(body),
      })
      assert.equal(missing.status, 400, String(body.action))
      assert.match(String((await missing.json() as Record<string, unknown>).error), /needs repo/)
      assert.equal((await act(h, number, { ...body, repo: 7 })).status, 400)
      assert.equal((await act(h, number, { ...body, repo: '' })).status, 400)
    }
    assert.equal(h.runner.calls.length, before)
  } finally {
    await h.cleanup()
  }
})
