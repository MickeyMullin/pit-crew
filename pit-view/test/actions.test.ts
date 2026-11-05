// test/actions.test.ts
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { ghArgs, orList, parseAction } from '../src/actions.ts'
import { isPrimaryBase } from '../src/derive.ts'
import type { Config } from '../src/config.ts'
import type { OpenRow } from '../src/derive.ts'
import type { RawOpenResponse } from '../src/github.ts'
import type { Patch, View } from '../src/poller.ts'
import { startServer } from '../src/server.ts'
import type { PitServer } from '../src/server.ts'
import { scenario } from './fixtures/scenario.ts'
import { failed, fakeLaunch, fakeRunner, fakeTime, field, fixtureRunner, ok, singlePr, tempDir, updateResult } from './helpers.ts'
import type { Call, FakeLaunch, FakeRunner } from './helpers.ts'

// every GitHub write below goes to a fake gh; nothing here can reach a real PR

type Harness = { server: PitServer, runner: FakeRunner, launch: FakeLaunch, base: string, home: string, removeHome: () => Promise<void>, cleanup: () => Promise<void> }

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
  // the mergeable value each listed PR has, by number, instead of the fixture's
  mergeable?: Record<number, string>
  // called when a write has been accepted
  onWrite?: () => void
  // what the live read of one PR (just before a merge) says, over the fixture's own state
  live?: (number: number) => Record<string, unknown>
  // the lines the live read of a PR's reviews prints: login, commit, and state, tab separated
  reviews?: string
  // what a post prints on stdout
  postOutput?: string
  // what each post's --body-file held when gh opened it
  bodies?: { path: string, text: string, mode: number }[]
  // runs when the reviews are read live: after the report is checked and before gh writes
  onReviews?: () => Promise<void>
}

const isWrite = (args: string[]): boolean =>
  (args[0] === 'pr' && ['ready', 'merge', 'review', 'comment'].includes(args[1] ?? '')) || (args[0] === 'api' && args.includes('--method'))

const writesOf = (runner: FakeRunner): Call[] => runner.calls.filter((call) => isWrite(call.args))
const singleCallsOf = (runner: FakeRunner): Call[] =>
  runner.calls.filter((call) => call.args[0] === 'api' && (field(call.args, 'query') ?? '').includes('query SinglePullRequest'))

const isLiveRead = (args: string[]): boolean => args[0] === 'api' && /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(args[1] ?? '') && !args.includes('--method')
const liveReadsOf = (runner: FakeRunner): Call[] => runner.calls.filter((call) => isLiveRead(call.args))
const isReviewsRead = (args: string[]): boolean => args[0] === 'api' && args.some((arg) => /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews$/.test(arg))

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
    if (isReviewsRead(args)) {
      await behavior.onReviews?.()
      return ok(behavior.reviews ?? '')
    }
    if (isWrite(args)) {
      await behavior.gate
      const bodyFile = args.includes('--body-file') ? args[args.indexOf('--body-file') + 1] : undefined
      if (bodyFile !== undefined && behavior.bodies !== undefined) {
        behavior.bodies.push({ path: bodyFile, text: await readFile(bodyFile, 'utf8'), mode: (await stat(bodyFile)).mode & 0o777 })
      }
      if (behavior.writeError !== undefined) return failed(behavior.writeError)
      behavior.onWrite?.()
      return ok(args[1] === 'review' || args[1] === 'comment' ? behavior.postOutput ?? '' : '')
    }
    if (args[0] === 'api' && args[1] === 'user') return ok(`${behavior.account ?? scenario.viewer}\n`)
    if (args[0] === 'api' && args[1] === 'graphql' && (field(args, 'query') ?? '').includes('query SinglePullRequest') && behavior.single !== undefined) {
      return ok(JSON.stringify(await behavior.single(Number(field(args, 'number')))))
    }
    const answer = await base.runner(args)
    if ((behavior.bases !== undefined || behavior.mergeable !== undefined) && args[0] === 'api' && args[1] === 'graphql' && (field(args, 'query') ?? '').includes('query OpenPullRequests')) {
      const parsed = JSON.parse(answer.stdout) as RawOpenResponse
      for (const node of parsed.data.repository?.pullRequests.nodes ?? []) {
        node.baseRefName = behavior.bases?.[node.number] ?? node.baseRefName
        node.mergeable = (behavior.mergeable?.[node.number] ?? node.mergeable) as typeof node.mergeable
      }
      return ok(JSON.stringify(parsed))
    }
    return answer
  })
}

const setup = async ({ config = {}, runner = ghWorld(), restarting }: { config?: Partial<Config>, runner?: FakeRunner, restarting?: Harness } = {}): Promise<Harness> => {
  const { dir: home, cleanup: removeHome } = restarting === undefined ? await tempDir() : { dir: restarting.home, cleanup: restarting.removeHome }
  const configPath = join(home, '.config', 'pit-view', 'config.json')
  await mkdir(join(configPath, '..'), { recursive: true })
  await writeFile(configPath, JSON.stringify({ repo: scenario.repo, viewer: scenario.viewer, people, ...config }), 'utf8')
  const time = fakeTime()
  const launch = fakeLaunch()
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
  const cleanup = async (): Promise<void> => {
    await server.close()
    await removeHome()
  }
  return { server, runner, launch, base: server.url, home, removeHome, cleanup }
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

test('orList joins one, two, and three or more items as plain English', () => {
  assert.equal(orList(['a']), 'a')
  assert.equal(orList(['a', 'b']), 'a or b')
  assert.equal(orList(['a', 'b', 'c']), 'a, b, or c')
  assert.equal(orList(['a', 'b', 'c', 'd']), 'a, b, c, or d')
})

test('an unknown action names the allowed actions with a final "or"', () => {
  assert.throws(() => parseAction({ action: 'comment', repo: 'o/r' }), /action must be one of merge, markReady, convertToDraft, requestReview, update, or resolveConflicts;/)
})

// Update (section 9 of DESIGN.md, Direct actions): an agent session through the launcher, never a gh write of its own. The runner is the fake launch, so no git command runs and no branch is rebased or pushed

const updateBody = async (number: number): Promise<{ action: 'update', viewer: string, headSha: string, base: string }> => {
  const { sha, base } = await listed(number)
  return { action: 'update', viewer: scenario.viewer, headSha: sha, base }
}

const withClone: Partial<Config> = { cloneDir: '~/dev/orbit' }

const userCalls = (runner: FakeRunner): number => runner.calls.filter((call) => call.args[0] === 'api' && call.args[1] === 'user').length

test('an update starts update-pr with Claude in an agent session, bound to the head it showed, and its settled run reads the PR again as a patch', async () => {
  // the configured runner is Codex: an update session is Claude's all the same
  const h = await setup({ config: { ...withClone, agent: { runner: 'codex', claudeModel: 'sonnet' } } })
  const stream = await collectPatches(h.base)
  try {
    await filled(h)
    const body = await updateBody(101)
    const started = await act(h, 101, body)
    assert.equal(started.status, 200, JSON.stringify(started.body))
    const run = started.body.run as { id: number, command: string, args: string[], runner: string, label: string, status: string }
    assert.deepEqual([started.body.number, started.body.action, started.body.started], [101, 'update', true])
    assert.deepEqual([run.command, run.args, run.runner, run.label, run.status], ['update-pr', ['101', `--head=${body.headSha}`], 'claude', 'Update branch', 'running'])
    const child = h.launch.children[0]!
    assert.equal(child.request.command, 'claude')
    assert.match(JSON.parse(child.writes[0]!).message.content as string, new RegExp(`^/update-pr 101 --head=${body.headSha} --emit-json=\\S+$`))
    // an Update session keeps the repository's git hooks, so its push runs a pre-push check
    assert.equal(child.request.env.GIT_CONFIG_COUNT, '2')
    assert.equal(child.request.env.GIT_CONFIG_KEY_2, undefined)
    // the account is checked once, by the launcher; Pit View itself writes nothing to GitHub
    assert.equal(userCalls(h.runner), 1)
    assert.equal(writesOf(h.runner).length, 0)
    // never two at once: the action is still settling, and then the PR's run is in flight
    const again = await act(h, 101, body)
    assert.equal(again.status, 409)
    assert.equal(h.launch.children.length, 1)
    assert.equal((await rowOf(h, 101))?.agent?.state, 'running')

    const reads = singleCallsOf(h.runner).length
    await child.result(updateResult({ head: { sha: body.headSha } }))
    child.exit(0)
    await until(() => singleCallsOf(h.runner).length === reads + 1)
    await until(() => stream.patches.some((patch) => patch.rows.some((row) => row.number === 101 && row.refresh?.state === 'running')))
    await until(() => stream.patches.some((patch) => patch.rows.some((row) => row.number === 101 && row.refresh === null && row.agent?.status === 'done')))
    await h.server.poller.idle()
    const row = await rowOf(h, 101)
    assert.deepEqual([row?.agent?.state, row?.agent?.text, row?.agent?.result?.kind], ['done', 'Rebased onto main', 'update'])
    // exactly one read after the session; a merge is still a gh write of its own, which nothing here made
    assert.equal(singleCallsOf(h.runner).length, reads + 1)
    assert.equal(writesOf(h.runner).length, 0)
  } finally {
    stream.close()
    await h.cleanup()
  }
})

test('an update needs the full binding the confirmation showed, and a request that differs from what is in effect now starts nothing', async () => {
  const h = await setup({ config: withClone })
  try {
    await filled(h)
    const body = await updateBody(101)
    const { viewer: _viewer, ...noViewer } = body
    const { headSha: _headSha, ...noHead } = body
    const { base: _base, ...noBase } = body
    for (const bad of [noViewer, noHead, noBase, { ...body, headSha: body.headSha.slice(0, 7) }, { ...body, viewer: '' }, { ...body, reviewer: 'sam-tran' }, { ...body, runner: 'codex' }]) {
      assert.equal((await act(h, 101, bad)).status, 400, JSON.stringify(bad))
    }
    // the other actions take no viewer
    assert.equal((await act(h, 103, { action: 'markReady', viewer: scenario.viewer })).status, 400)
    // Origin and token, as for every action
    assert.equal((await act(h, 101, body, { Origin: '' })).status, 403)
    assert.equal((await act(h, 101, body, { 'X-Pit-View-Token': 'not-the-token' })).status, 403)

    // the repository or the viewer changed while the confirmation was open: nothing is looked up or started
    const otherRepo = await act(h, 101, { ...body, repo: 'octo-example/other' })
    assert.equal(otherRepo.status, 409)
    assert.match(String(otherRepo.body.error), /the repository is now octo-example\/orbit, not octo-example\/other/)
    const otherViewer = await act(h, 101, { ...body, viewer: 'someone-else' })
    assert.equal(otherViewer.status, 409)
    assert.match(String(otherViewer.body.error), /the viewer is now vera-quill, not someone-else; .*nothing was started/)
    // the viewer is compared as the identity check compares it
    assert.equal(userCalls(h.runner), 0)

    // the head or base moved in the cache since the confirmation was shown: refused, and the row is read again
    const reads = singleCallsOf(h.runner).length
    const moved = await act(h, 101, { ...body, headSha: 'a'.repeat(40) })
    assert.equal(moved.status, 409)
    assert.match(String(moved.body.error), /#101 changed since you saw it \(it has new commits\); nothing was started/)
    const retargeted = await act(h, 101, { ...body, base: 'master' })
    assert.equal(retargeted.status, 409)
    assert.match(String(retargeted.body.error), /it now targets main, not master/)
    await until(() => singleCallsOf(h.runner).length >= reads + 1)

    // someone else's PR, and one that is not open
    const others = await act(h, 113, await updateBody(113))
    assert.equal(others.status, 422)
    assert.match(String(others.body.error), /not your PR/)
    assert.equal((await act(h, 999, { ...body })).status, 422)
    assert.equal(h.launch.children.length, 0)
    assert.equal(userCalls(h.runner), 0)
  } finally {
    await h.cleanup()
  }
})

test('an update is refused on a PR that does not target the primary branch, without cloneDir, and when gh is signed in as someone else', async () => {
  const retargeted = await setup({ config: withClone, runner: ghWorld({ bases: { 104: 'release/2026-10' } }) })
  try {
    await filled(retargeted)
    const refused = await act(retargeted, 104, { ...(await updateBody(104)), base: 'release/2026-10' })
    assert.equal(refused.status, 422)
    assert.match(String(refused.body.error), /#104 targets release\/2026-10, not the primary branch \(main\); Pit View updates only PRs that target the primary branch/)
    assert.equal(retargeted.launch.children.length, 0)
    // a confirmation that showed the primary base while the cache has since moved to another branch is stale, not merely refused
    const stale = await act(retargeted, 104, { ...(await updateBody(104)), base: 'main' })
    assert.equal(stale.status, 409)
    assert.match(String(stale.body.error), /it now targets release\/2026-10, not main/)
    assert.equal(retargeted.launch.children.length, 0)
  } finally {
    await retargeted.cleanup()
  }
  const noClone = await setup()
  try {
    await filled(noClone)
    const refused = await act(noClone, 101, await updateBody(101))
    assert.equal(refused.status, 422)
    assert.match(String(refused.body.error), /set cloneDir/)
    assert.equal(noClone.launch.children.length, 0)
  } finally {
    await noClone.cleanup()
  }
  const otherAccount = await setup({ config: withClone, runner: ghWorld({ account: 'someone-else' }) })
  try {
    await filled(otherAccount)
    const refused = await act(otherAccount, 101, await updateBody(101))
    assert.equal(refused.status, 422)
    assert.match(String(refused.body.error), /gh is signed in as someone-else, but the viewer is vera-quill/)
    assert.equal(otherAccount.launch.children.length, 0)
    assert.equal(writesOf(otherAccount.runner).length, 0)
  } finally {
    await otherAccount.cleanup()
  }
})

// Resolve conflicts (section 9 of DESIGN.md, Direct actions): the Update session itself, started only on a PR the cache holds as conflicting. The runner is the fake launch, so no git command runs and no branch is rebased or pushed

const resolveBody = async (number: number): Promise<{ action: 'resolveConflicts', viewer: string, headSha: string, base: string }> => ({ ...(await updateBody(number)), action: 'resolveConflicts' })

test('Resolve conflicts starts the Update session, update-pr with Claude bound to the head it showed, labeled Resolve conflicts, and its settled run reads the PR again as a patch', async () => {
  const h = await setup({ config: { ...withClone, agent: { runner: 'codex', claudeModel: 'sonnet' } }, runner: ghWorld({ mergeable: { 101: 'CONFLICTING' } }) })
  const stream = await collectPatches(h.base)
  try {
    await filled(h)
    assert.ok((await rowOf(h, 101))?.issues.some((issue) => issue.kind === 'conflicts'))
    const body = await resolveBody(101)
    const started = await act(h, 101, body)
    assert.equal(started.status, 200, JSON.stringify(started.body))
    const run = started.body.run as { id: number, command: string, args: string[], runner: string, label: string, status: string }
    assert.deepEqual([started.body.number, started.body.action, started.body.started], [101, 'resolveConflicts', true])
    // the same command and arguments as Update, so the same lease, push rules, and result
    assert.deepEqual([run.command, run.args, run.runner, run.label, run.status], ['update-pr', ['101', `--head=${body.headSha}`], 'claude', 'Resolve conflicts', 'running'])
    const child = h.launch.children[0]!
    assert.equal(child.request.command, 'claude')
    assert.match(JSON.parse(child.writes[0]!).message.content as string, new RegExp(`^/update-pr 101 --head=${body.headSha} --emit-json=\\S+$`))
    // it is the Update session, so it keeps the repository's git hooks too
    assert.equal(child.request.env.GIT_CONFIG_COUNT, '2')
    assert.equal(child.request.env.GIT_CONFIG_KEY_2, undefined)
    assert.equal(userCalls(h.runner), 1)
    assert.equal(writesOf(h.runner).length, 0)
    // one run per PR, across Update and Resolve conflicts
    assert.equal((await act(h, 101, await updateBody(101))).status, 409)
    assert.equal((await act(h, 101, body)).status, 409)
    assert.equal(h.launch.children.length, 1)
    assert.deepEqual([(await rowOf(h, 101))?.agent?.state, (await rowOf(h, 101))?.agent?.label], ['running', 'Resolve conflicts'])

    const reads = singleCallsOf(h.runner).length
    await child.result(updateResult({ head: { sha: body.headSha }, conflicts: [{ path: 'src/retry.ts', resolution: 'kept both the new backoff and the renamed option' }] }))
    child.exit(0)
    await until(() => singleCallsOf(h.runner).length === reads + 1)
    await until(() => stream.patches.some((patch) => patch.rows.some((row) => row.number === 101 && row.refresh === null && row.agent?.status === 'done')))
    await h.server.poller.idle()
    const row = await rowOf(h, 101)
    assert.deepEqual([row?.agent?.state, row?.agent?.text, row?.agent?.result?.kind], ['done', 'Rebased onto main', 'update'])
    assert.equal(writesOf(h.runner).length, 0)
  } finally {
    stream.close()
    await h.cleanup()
  }
})

test('Resolve conflicts is refused, starting nothing, on a PR the cache does not hold as conflicting, and takes the Update session\'s binding and refusals', async () => {
  const h = await setup({ config: withClone, runner: ghWorld({ mergeable: { 101: 'MERGEABLE', 120: 'UNKNOWN', 104: 'CONFLICTING' }, bases: { 104: 'release/2026-10' } }) })
  try {
    await filled(h)
    // no conflict that GitHub reports, or mergeability not computed yet: refused before the account is looked up
    for (const number of [101, 120]) {
      const refused = await act(h, number, await resolveBody(number))
      assert.equal(refused.status, 422, `#${number}`)
      assert.match(String(refused.body.error), new RegExp(`#${number} has no conflicts that GitHub reports; nothing was started`))
    }
    assert.equal(h.launch.children.length, 0)
    assert.equal(userCalls(h.runner), 0)

    // the binding is the Update session's
    const body = await resolveBody(101)
    const { viewer: _viewer, ...noViewer } = body
    const { headSha: _headSha, ...noHead } = body
    for (const bad of [noViewer, noHead, { ...body, headSha: body.headSha.slice(0, 7) }, { ...body, reviewer: 'sam-tran' }, { ...body, runner: 'codex' }, { ...body, method: 'merge' }, { ...body, force: true }]) {
      assert.equal((await act(h, 101, bad)).status, 400, JSON.stringify(bad))
    }
    assert.equal((await act(h, 101, body, { Origin: '' })).status, 403)
    assert.equal((await act(h, 101, body, { 'X-Pit-View-Token': 'not-the-token' })).status, 403)
    assert.equal((await act(h, 101, { ...body, repo: 'octo-example/other' })).status, 409)
    const otherViewer = await act(h, 101, { ...body, viewer: 'someone-else' })
    assert.equal(otherViewer.status, 409)
    assert.match(String(otherViewer.body.error), /nothing was started/)
    // a moved head is stale before it is judged not conflicting
    const moved = await act(h, 101, { ...body, headSha: 'a'.repeat(40) })
    assert.equal(moved.status, 409)
    assert.match(String(moved.body.error), /#101 changed since you saw it \(it has new commits\); nothing was started/)
    // a conflicting PR that does not target the primary branch has no Update session
    const release = await act(h, 104, { ...(await resolveBody(104)), base: 'release/2026-10' })
    assert.equal(release.status, 422)
    assert.match(String(release.body.error), /#104 targets release\/2026-10, not the primary branch/)
    // someone else's conflicting PR
    const others = await act(h, 108, await resolveBody(108))
    assert.equal(others.status, 422)
    assert.match(String(others.body.error), /not your PR/)
    assert.equal(h.launch.children.length, 0)
    assert.equal(userCalls(h.runner), 0)
  } finally {
    await h.cleanup()
  }
})

test('parseAction reads resolveConflicts with exactly the Update session\'s fields', () => {
  const headSha = 'B'.repeat(40)
  assert.deepEqual(parseAction({ action: 'resolveConflicts', repo: 'o/r', viewer: 'vera-quill', headSha, base: 'main' }), { action: 'resolveConflicts', repo: 'o/r', viewer: 'vera-quill', headSha: headSha.toLowerCase(), base: 'main' })
  assert.throws(() => parseAction({ action: 'resolveConflicts', repo: 'o/r', headSha, base: 'main' }), /resolveConflicts needs viewer/)
  assert.throws(() => parseAction({ action: 'resolveConflicts', repo: 'o/r', viewer: 'vera-quill', base: 'main' }), /resolveConflicts needs headSha and base/)
  assert.throws(() => parseAction({ action: 'resolveConflicts', repo: 'o/r', viewer: 'vera-quill', headSha, base: 'main', reviewer: 'sam-tran' }), /resolveConflicts takes no reviewer/)
})

// Post it (section 8, Drawer, and section 9, Direct actions): the saved report of a run whose post was refused, posted through a fake gh; nothing here can reach a real PR

const deniedPostEvent = (number: number): Record<string, unknown> => ({
  type: 'result',
  total_cost_usd: 0.5,
  permission_denials: [{ tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: `gh pr review ${number} --approve --body-file /home/tester/agents/output/PR-${number}.md` } }],
})

// a run of #106 that finished its review and could not post, its report on disk
const blockedRun = async (h: Harness, result: Record<string, unknown> = {}, report?: string | null): Promise<{ id: number, sha: string }> => {
  const number = 106
  await filled(h)
  const { sha } = await listed(number)
  const reports = join(h.home, 'agents', 'output')
  await mkdir(reports, { recursive: true })
  if (report !== null) await writeFile(join(reports, `PR-${number}.md`), report ?? `# Review\n\nReviewed commit: \`fix/x\` @ \`${sha.slice(0, 7)}\`\n\nNo actionable findings.\n`)
  const start = await fetch(`${h.base}/api/prs/${number}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: h.base, 'X-Pit-View-Token': h.server.token },
    body: JSON.stringify({ kind: 'default', runner: 'claude', repo: scenario.repo, viewer: scenario.viewer }),
  })
  assert.equal(start.status, 200)
  const id = (await start.json() as { id: number }).id
  const child = h.launch.children.at(-1)!
  await child.stream(deniedPostEvent(number))
  await child.result({
    schema: 'pit-crew/review-result@1', command: 'review-pr', status: 'needsInput', target: { repo: scenario.repo, pr: number }, reviewed: { kind: 'commit', sha },
    verdict: 'clean', recommendation: null, findings: [], ci: 'green', fixAttempts: 0, posted: null, notPostedReason: 'awaitingAnswer', report: `~/agents/output/PR-${number}.md`,
    question: 'The post was blocked. Allow it?', error: null, ...result,
  })
  child.exit(0)
  await untilAsync(async () => (await rowOf(h, number))?.agent?.status !== 'running')
  return { id, sha }
}

const untilAsync = async (check: () => Promise<boolean>): Promise<void> => {
  for (let tries = 0; tries < 400; tries += 1) {
    if (await check()) return
    await delay(5)
  }
  assert.fail('condition reached')
}

const postBody = (sha: string, form = 'approve'): Record<string, unknown> => ({ repo: scenario.repo, viewer: scenario.viewer, number: 106, headSha: sha, form })

const postIt = async (h: Harness, id: number | string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number, body: Record<string, unknown> }> => {
  const response = await fetch(`${h.base}/api/runs/${id}/post`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: h.base, 'X-Pit-View-Token': h.server.token, ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

const postsOf = (runner: FakeRunner): Call[] => runner.calls.filter((call) => call.args[0] === 'pr' && (call.args[1] === 'review' || call.args[1] === 'comment'))

const blockedHarness = async (behavior: Behavior = {}): Promise<Harness> => setup({ config: withClone, runner: ghWorld(behavior) })

test('a blocked post reads as review done, post not made, and the row offers Post it', async () => {
  const h = await blockedHarness()
  try {
    const { id, sha } = await blockedRun(h)
    const agent = (await rowOf(h, 106))?.agent
    assert.equal(agent?.status, 'done')
    assert.equal(agent?.text, 'Clean · post not made')
    assert.equal(agent?.question, null)
    assert.equal(agent?.note, null)
    assert.equal(agent?.postOffer?.runId, id)
    assert.equal(agent?.postOffer?.form, 'approve')
    assert.equal(agent?.postOffer?.headSha, sha)
    // finishing the review posted nothing by itself
    assert.deepEqual(postsOf(h.runner), [])
    // its report stays readable through the report endpoint
    const report = await fetch(`${h.base}/api/reports/PR-106.md`)
    assert.equal(report.status, 200)
    assert.match((await report.json() as { raw: string }).raw, /No actionable findings/)
  } finally {
    await h.cleanup()
  }
})

test('Post it posts the saved report once with the worker\'s gh command, after the identity check and a live read', async () => {
  const h = await blockedHarness()
  try {
    const { id, sha } = await blockedRun(h)
    const answer = await postIt(h, id, postBody(sha))
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body.posted, { form: 'approve', url: `https://github.com/${scenario.repo}/pull/106` })
    const posts = postsOf(h.runner)
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0]?.args.slice(0, -1), ['pr', 'review', '106', '--repo', scenario.repo, '--approve', '--body-file'])
    const order = h.runner.calls.map((call) => call.args)
    const writeAt = order.findIndex((args) => args[0] === 'pr' && args[1] === 'review')
    assert.ok(order.slice(0, writeAt).some((args) => args[0] === 'api' && args[1] === 'user'), 'the account was confirmed first')
    assert.ok(order.slice(0, writeAt).some(isLiveRead), 'the PR was read live first')
    assert.ok(order.slice(0, writeAt).some(isReviewsRead), 'the reviews were read live first')
    // the row follows: the review now reads as posted, with nothing left to offer
    const agent = (await rowOf(h, 106))?.agent
    assert.equal(agent?.text, 'Approved')
    assert.equal(agent?.postOffer, null)
    assert.equal(agent?.result?.kind === 'review' && agent.result.notPostedReason, null)
    assert.deepEqual(agent?.result?.kind === 'review' && agent.result.posted, { form: 'approve', url: `https://github.com/${scenario.repo}/pull/106` })
    assert.equal(agent?.steps.find((slot) => slot.step === 'post')?.state, 'done')
    // a second click writes nothing
    const again = await postIt(h, id, postBody(sha))
    assert.equal(again.status, 422)
    assert.equal(postsOf(h.runner).length, 1)
  } finally {
    await h.cleanup()
  }
})

test('the form follows the findings and CI, and a comment keeps the URL gh printed', async () => {
  const requestChanges = await blockedHarness()
  try {
    const { id, sha } = await blockedRun(requestChanges, { verdict: 'changesRequested', findings: [{ priority: 'P1', summary: 'Retry loop never backs off', files: ['src/retry.ts'] }] })
    assert.equal((await rowOf(requestChanges, 106))?.agent?.text, 'Changes requested · post not made')
    const answer = await postIt(requestChanges, id, postBody(sha, 'requestChanges'))
    assert.equal(answer.status, 200)
    assert.deepEqual(postsOf(requestChanges.runner)[0]?.args.slice(0, -1), ['pr', 'review', '106', '--repo', scenario.repo, '--request-changes', '--body-file'])
    assert.equal((await rowOf(requestChanges, 106))?.agent?.text, 'Changes requested')
  } finally {
    await requestChanges.cleanup()
  }
  const url = `https://github.com/${scenario.repo}/pull/106#issuecomment-1`
  const comment = await blockedHarness({ postOutput: `${url}\n` })
  try {
    const { id, sha } = await blockedRun(comment, { ci: 'failed' })
    const answer = await postIt(comment, id, postBody(sha, 'comment'))
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body.posted, { form: 'comment', url })
    assert.deepEqual(postsOf(comment.runner)[0]?.args.slice(0, -1), ['pr', 'comment', '106', '--repo', scenario.repo, '--body-file'])
  } finally {
    await comment.cleanup()
  }
})

test('Post it takes the same token and Origin as a direct action and what its confirmation showed', async () => {
  const h = await blockedHarness()
  try {
    const { id, sha } = await blockedRun(h)
    const cases: [string, unknown, Record<string, string>, number][] = [
      ['no token', postBody(sha), { 'X-Pit-View-Token': 'wrong' }, 403],
      ['a foreign Origin', postBody(sha), { Origin: 'https://example.test' }, 403],
      ['an unknown field', { ...postBody(sha), body: 'anything' }, {}, 400],
      ['a report path from the page', { ...postBody(sha), report: '~/.ssh/id_rsa' }, {}, 400],
      ['no form', { repo: scenario.repo, viewer: scenario.viewer, number: 106, headSha: sha }, {}, 400],
      ['a form the page made up', postBody(sha, 'dismiss'), {}, 400],
      ['a short head', postBody(sha.slice(0, 7)), {}, 400],
      ['another repository', { ...postBody(sha), repo: 'other-org/other-repo' }, {}, 409],
      ['another viewer', { ...postBody(sha), viewer: 'sam-tran' }, {}, 409],
      ['another PR', { ...postBody(sha), number: 113 }, {}, 409],
      ['another head', postBody('0'.repeat(40)), {}, 409],
      ['another form than the one in effect', postBody(sha, 'requestChanges'), {}, 409],
    ]
    for (const [name, body, headers, status] of cases) {
      const answer = await postIt(h, id, body, headers)
      assert.equal(answer.status, status, name)
      assert.equal(typeof answer.body.error, 'string', name)
    }
    assert.equal((await postIt(h, 99999, postBody(sha))).status, 404)
    assert.equal((await postIt(h, 'nope', postBody(sha))).status, 400)
    assert.deepEqual(postsOf(h.runner), [])
    // none of those changed anything: the offer still stands
    assert.equal((await rowOf(h, 106))?.agent?.postOffer?.runId, id)
    // a request with no Origin header at all is refused too
    const response = await fetch(`${h.base}/api/runs/${id}/post`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pit-View-Token': h.server.token }, body: JSON.stringify(postBody(sha)) })
    assert.equal(response.status, 403)
    assert.deepEqual(postsOf(h.runner), [])
  } finally {
    await h.cleanup()
  }
})

test('a run whose own flags forbid a post is never posted, whatever its result says', async () => {
  const h = await blockedHarness()
  try {
    await filled(h)
    const { sha } = await listed(106)
    await mkdir(join(h.home, 'agents', 'output'), { recursive: true })
    await writeFile(join(h.home, 'agents', 'output', 'PR-106.md'), `Reviewed commit: \`x\` @ \`${sha.slice(0, 7)}\`\n`)
    const run = await h.server.launcher.start({ repo: scenario.repo, number: 106, command: 'review-pr', args: ['106', '--no-post'], label: 'Review' })
    const child = h.launch.children.at(-1)!
    await child.result({
      schema: 'pit-crew/review-result@1', command: 'review-pr', status: 'done', target: { repo: scenario.repo, pr: 106 }, reviewed: { kind: 'commit', sha }, verdict: 'clean',
      recommendation: null, findings: [], ci: 'green', fixAttempts: 0, posted: null, notPostedReason: 'postBlocked', report: '~/agents/output/PR-106.md', question: null, error: null,
    })
    child.exit(0)
    await h.server.launcher.settled(run.id)
    assert.equal((await rowOf(h, 106))?.agent?.postOffer, null)
    const answer = await postIt(h, run.id, postBody(sha))
    assert.equal(answer.status, 422)
    assert.deepEqual(postsOf(h.runner), [])
  } finally {
    await h.cleanup()
  }
})

test('the report must be the one this run wrote: a missing file or another commit\'s report posts nothing', async () => {
  const missing = await blockedHarness()
  try {
    // the review finished with its report on disk; it is gone by the time of the click
    const { id, sha } = await blockedRun(missing)
    await rm(join(missing.home, 'agents', 'output', 'PR-106.md'))
    const answer = await postIt(missing, id, postBody(sha))
    assert.equal(answer.status, 422)
    assert.match(String(answer.body.error), /nothing was posted/)
    assert.deepEqual(postsOf(missing.runner), [])
  } finally {
    await missing.cleanup()
  }
  const replaced = await blockedHarness()
  try {
    const { id, sha } = await blockedRun(replaced, {}, 'Reviewed commit: `fix/x` @ `0123456`\n\nNo actionable findings.\n')
    const answer = await postIt(replaced, id, postBody(sha))
    assert.equal(answer.status, 422)
    assert.match(String(answer.body.error), /another commit/)
    assert.deepEqual(postsOf(replaced.runner), [])
  } finally {
    await replaced.cleanup()
  }
  const unmarked = await blockedHarness()
  try {
    const { id, sha } = await blockedRun(unmarked, {}, 'No actionable findings.\n')
    assert.equal((await postIt(unmarked, id, postBody(sha))).status, 422)
    assert.deepEqual(postsOf(unmarked.runner), [])
  } finally {
    await unmarked.cleanup()
  }
})

test('what GitHub says just before the post decides: a moved head, a closed PR, or a review already there posts nothing', async () => {
  const live: [string, Behavior, RegExp][] = [
    ['a head moved since the cache', { live: () => ({ head: { sha: '0'.repeat(40) } }) }, /new commits/],
    ['a closed PR', { live: () => ({ state: 'closed' }) }, /no longer open/],
    ['a merged PR', { live: () => ({ merged: true }) }, /no longer open/],
  ]
  for (const [name, behavior, error] of live) {
    const h = await blockedHarness(behavior)
    try {
      const { id, sha } = await blockedRun(h)
      const answer = await postIt(h, id, postBody(sha))
      assert.equal(answer.status, 422, name)
      assert.match(String(answer.body.error), error, name)
      assert.deepEqual(postsOf(h.runner), [], name)
    } finally {
      await h.cleanup()
    }
  }
  const { sha } = await listed(106)
  const reviewed = await blockedHarness({ reviews: `sam-tran\t${sha}\tAPPROVED\n${scenario.viewer.toUpperCase()}\t${sha}\tAPPROVED\n` })
  try {
    const { id } = await blockedRun(reviewed)
    const answer = await postIt(reviewed, id, postBody(sha))
    assert.equal(answer.status, 422)
    assert.match(String(answer.body.error), /already reviewed/)
    assert.deepEqual(postsOf(reviewed.runner), [])
  } finally {
    await reviewed.cleanup()
  }
  // someone else's review, or the viewer's own on an earlier commit or a plain comment, is no reason to refuse
  const earlier = await blockedHarness({ reviews: `sam-tran\t${sha}\tAPPROVED\n${scenario.viewer}\t${'0'.repeat(40)}\tAPPROVED\n${scenario.viewer}\t${sha}\tCOMMENTED\n` })
  try {
    const { id } = await blockedRun(earlier)
    assert.equal((await postIt(earlier, id, postBody(sha))).status, 200)
    assert.equal(postsOf(earlier.runner).length, 1)
  } finally {
    await earlier.cleanup()
  }
})

test('a gh signed in as someone else posts nothing, and a post GitHub refuses leaves the offer standing', async () => {
  const behavior: Behavior = {}
  const other = await blockedHarness(behavior)
  try {
    const { id, sha } = await blockedRun(other)
    // the launcher checked the account at the start; the post checks it again with its own token
    behavior.account = 'sam-tran'
    const answer = await postIt(other, id, postBody(sha))
    assert.equal(answer.status, 422)
    assert.match(String(answer.body.error), /signed in as sam-tran/)
    assert.deepEqual(postsOf(other.runner), [])
  } finally {
    await other.cleanup()
  }
  const refused = await blockedHarness({ writeError: 'HTTP 422: Can not approve your own pull request' })
  try {
    const { id, sha } = await blockedRun(refused)
    const answer = await postIt(refused, id, postBody(sha))
    assert.equal(answer.status, 502)
    assert.match(String(answer.body.error), /HTTP 422/)
    const agent = (await rowOf(refused, 106))?.agent
    assert.equal(agent?.text, 'Clean · post not made')
    assert.equal(agent?.postOffer?.runId, id)
  } finally {
    await refused.cleanup()
  }
})

test('two quick clicks write once', async () => {
  let open: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  const h = await blockedHarness({ gate })
  try {
    const { id, sha } = await blockedRun(h)
    const first = postIt(h, id, postBody(sha))
    await until(() => h.runner.calls.some((call) => call.args[0] === 'pr' && call.args[1] === 'review'))
    const second = await postIt(h, id, postBody(sha))
    assert.equal(second.status, 409)
    open()
    assert.equal((await first).status, 200)
    assert.equal(postsOf(h.runner).length, 1)
  } finally {
    await h.cleanup()
  }
})

test('Post it writes through gh and starts no run', async () => {
  const h = await blockedHarness()
  try {
    const { id, sha } = await blockedRun(h)
    const before = h.launch.children.length
    assert.equal((await postIt(h, id, postBody(sha))).status, 200)
    assert.equal(h.launch.children.length, before)
  } finally {
    await h.cleanup()
  }
})

// a run posts the report it finished with, from a private copy of what was checked

const reportOf = (h: Harness): string => join(h.home, 'agents', 'output', 'PR-106.md')
const reportText = (sha: string, findings: string): string => `# Review\n\nReviewed commit: \`fix/x\` @ \`${sha.slice(0, 7)}\`\n\n${findings}\n`

test('a report another run replaced at the same head posts nothing, and the run\'s own text posts again once it is back', async () => {
  const behavior: Behavior = { bodies: [] }
  const h = await blockedHarness(behavior)
  try {
    const { sha } = await listed(106)
    const own = reportText(sha, 'No actionable findings.')
    const { id } = await blockedRun(h, {}, own)
    await writeFile(reportOf(h), reportText(sha, '- **P1**\n\n**[P1] A later run found this**'))
    const refused = await postIt(h, id, postBody(sha))
    assert.equal(refused.status, 422)
    assert.match(String(refused.body.error), /PR-106\.md has changed since run \d+ finished/)
    assert.match(String(refused.body.error), /nothing was posted/)
    assert.deepEqual(postsOf(h.runner), [])
    // a refusal made before gh ran leaves the offer standing
    assert.equal((await rowOf(h, 106))?.agent?.postOffer?.runId, id)
    await writeFile(reportOf(h), own)
    assert.equal((await postIt(h, id, postBody(sha))).status, 200)
    assert.equal(behavior.bodies?.[0]?.text, own)
  } finally {
    await h.cleanup()
  }
})

test('a replacement after the report was checked never reaches GitHub: gh reads a private copy of the checked text, and the copy goes away', async () => {
  const behavior: Behavior = { bodies: [] }
  const h = await blockedHarness(behavior)
  try {
    const { sha } = await listed(106)
    const own = reportText(sha, 'No actionable findings.')
    const later = reportText(sha, '- **P1**\n\n**[P1] A later run found this**')
    const { id } = await blockedRun(h, {}, own)
    behavior.onReviews = () => writeFile(reportOf(h), later)
    assert.equal((await postIt(h, id, postBody(sha))).status, 200)
    assert.equal(await readFile(reportOf(h), 'utf8'), later)
    const body = behavior.bodies?.[0]
    assert.equal(body?.text, own)
    assert.notEqual(body?.path, reportOf(h))
    assert.equal(body?.mode, 0o600)
    await assert.rejects(stat(body?.path ?? ''), /ENOENT/)
  } finally {
    await h.cleanup()
  }
})

test('the copy goes away after a refused post too', async () => {
  const behavior: Behavior = { bodies: [], writeError: 'HTTP 422: Can not approve your own pull request' }
  const h = await blockedHarness(behavior)
  try {
    const { id, sha } = await blockedRun(h)
    assert.equal((await postIt(h, id, postBody(sha))).status, 502)
    assert.equal(behavior.bodies?.length, 1)
    assert.notEqual(behavior.bodies?.[0]?.path, reportOf(h))
    await assert.rejects(stat(behavior.bodies?.[0]?.path ?? ''), /ENOENT/)
  } finally {
    await h.cleanup()
  }
})

test('a run with no report of its own on record is offered nothing and posts nothing', async () => {
  const h = await blockedHarness()
  try {
    const { id, sha } = await blockedRun(h)
    h.server.cache.updateRun(id, { reportHash: null })
    assert.equal((await rowOf(h, 106))?.agent?.postOffer, null)
    assert.equal((await postIt(h, id, postBody(sha))).status, 422)
    assert.deepEqual(postsOf(h.runner), [])
  } finally {
    await h.cleanup()
  }
})

// one post per run, across a restart: the mark goes on the record before gh writes

const restart = async (h: Harness, runner: FakeRunner): Promise<Harness> => {
  await h.server.close()
  return setup({ config: withClone, runner, restarting: h })
}

test('the mark is on the record before gh writes, and a post stopped before that leaves none', async () => {
  const behavior: Behavior = {}
  const h = await blockedHarness(behavior)
  try {
    const { id, sha } = await blockedRun(h)
    behavior.account = 'sam-tran'
    assert.equal((await postIt(h, id, postBody(sha))).status, 422)
    assert.equal(h.server.cache.getRun(id)?.postAttemptedAt, null)
    behavior.account = undefined
    behavior.live = () => ({ state: 'closed' })
    assert.equal((await postIt(h, id, postBody(sha))).status, 422)
    assert.equal(h.server.cache.getRun(id)?.postAttemptedAt, null)
    behavior.live = undefined
    let marked: string | null | undefined
    behavior.onWrite = () => {
      marked = h.server.cache.getRun(id)?.postAttemptedAt
    }
    assert.equal((await postIt(h, id, postBody(sha))).status, 200)
    assert.equal(typeof marked, 'string')
  } finally {
    await h.cleanup()
  }
})

test('a mark that cannot be written posts nothing', async () => {
  const h = await blockedHarness()
  try {
    const { id, sha } = await blockedRun(h)
    h.server.cache.db.exec('CREATE TEMP TRIGGER refuse_mark BEFORE UPDATE OF post_attempted_at ON runs BEGIN SELECT RAISE(ABORT, \'disk is full\'); END')
    const answer = await postIt(h, id, postBody(sha))
    assert.equal(answer.status, 422)
    assert.match(String(answer.body.error), /nothing was posted/)
    assert.deepEqual(postsOf(h.runner), [])
  } finally {
    await h.cleanup()
  }
})

test('a comment that landed and could not be recorded is not offered or posted again after a restart', async () => {
  const url = `https://github.com/${scenario.repo}/pull/106#issuecomment-1`
  const runner = ghWorld({ postOutput: `${url}\n` })
  let h = await setup({ config: withClone, runner })
  try {
    const { id, sha } = await blockedRun(h, { ci: 'failed' })
    assert.equal((await rowOf(h, 106))?.agent?.postOffer?.form, 'comment')
    // only this connection's writes to the result are refused, so the restart below finds the database well
    h.server.cache.db.exec('CREATE TEMP TRIGGER refuse_record BEFORE UPDATE OF result ON runs BEGIN SELECT RAISE(ABORT, \'disk is full\'); END')
    const answer = await postIt(h, id, postBody(sha, 'comment'))
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body.posted, { form: 'comment', url })
    assert.equal(answer.body.run, null)
    assert.equal(postsOf(runner).length, 1)
    h = await restart(h, runner)
    const agent = (await rowOf(h, 106))?.agent
    assert.equal(agent?.postOffer, null)
    assert.equal(agent?.text, 'Clean · post failed')
    assert.equal(agent?.result?.kind === 'review' && agent.result.notPostedReason, 'ghFailed')
    const again = await postIt(h, id, postBody(sha, 'comment'))
    assert.equal(again.status, 422)
    assert.match(String(again.body.error), /nothing was posted/)
    assert.equal(postsOf(runner).length, 1)
  } finally {
    await h.cleanup()
  }
})

test('a server that stopped between the mark and gh\'s answer offers nothing after its restart', async () => {
  const runner = ghWorld()
  let h = await setup({ config: withClone, runner })
  try {
    const { id, sha } = await blockedRun(h)
    h.server.cache.updateRun(id, { postAttemptedAt: '2026-10-26T14:04:00Z' })
    h = await restart(h, runner)
    assert.equal((await rowOf(h, 106))?.agent?.postOffer, null)
    assert.equal((await postIt(h, id, postBody(sha))).status, 422)
    assert.deepEqual(postsOf(runner), [])
  } finally {
    await h.cleanup()
  }
})

test('a post whose fate gh cannot tell keeps its mark and is not offered again; one GitHub refused leaves the offer standing', async () => {
  const unknown = ['dial tcp 192.0.2.1:443: connection reset by peer', 'HTTP 502: Bad Gateway', 'HTTP 500: Internal Server Error', 'something gh has never said before']
  for (const writeError of unknown) {
    const h = await blockedHarness({ writeError })
    try {
      const { id, sha } = await blockedRun(h)
      const answer = await postIt(h, id, postBody(sha))
      assert.equal(answer.status, 502, writeError)
      assert.match(String(answer.body.error), /may have landed/, writeError)
      const agent = (await rowOf(h, 106))?.agent
      assert.equal(agent?.postOffer, null, writeError)
      assert.equal(agent?.text, 'Clean · post failed', writeError)
      assert.equal((await postIt(h, id, postBody(sha))).status, 422, writeError)
      assert.equal(postsOf(h.runner).length, 1, writeError)
    } finally {
      await h.cleanup()
    }
  }
  const refused = ['HTTP 422: Can not approve your own pull request', 'GraphQL: Could not resolve to a PullRequest (repository.pullRequest)', 'HTTP 401: Bad credentials', 'API rate limit exceeded (HTTP 403)']
  for (const writeError of refused) {
    const h = await blockedHarness({ writeError })
    try {
      const { id, sha } = await blockedRun(h)
      const answer = await postIt(h, id, postBody(sha))
      assert.equal(answer.status, 502, writeError)
      assert.doesNotMatch(String(answer.body.error), /may have landed/, writeError)
      assert.equal(h.server.cache.getRun(id)?.postAttemptedAt, null, writeError)
      const agent = (await rowOf(h, 106))?.agent
      assert.equal(agent?.postOffer?.runId, id, writeError)
      assert.equal(agent?.text, 'Clean · post not made', writeError)
    } finally {
      await h.cleanup()
    }
  }
})
