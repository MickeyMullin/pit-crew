// test/relevancy-server.test.ts
// the Relevancy check through the real start route and launcher, Close PR through the real action route, and the Fix session that takes the check's prompt through a file. Every GitHub write goes to a fake gh, and every expected value is written out
import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Config } from '../src/config.ts'
import { startServer } from '../src/server.ts'
import type { PitServer } from '../src/server.ts'
import { scenario } from './fixtures/scenario.ts'
import { fakeLaunch, fakeRunner, fakeTime, failed, fixtureRunner, ok, relevancyResult, singlePr, tempDir } from './helpers.ts'
import type { Call, FakeChild, FakeLaunch, FakeRunner } from './helpers.ts'

type Harness = { server: PitServer, gh: FakeRunner, launch: FakeLaunch, stateDir: string, cleanup: () => Promise<void> }

const prompt = 'In src/retry.ts, call the renamed backoffDelay from src/timing.ts instead of computeDelay, which #88 removed.\nUpdate test/retry.test.ts to match.'
const reason = 'Addressed by #88, which added the same backoff to main.'

const isLiveRead = (args: string[]): boolean => args[0] === 'api' && /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(args[1] ?? '') && !args.includes('--method')
const isWrite = (args: string[]): boolean => (args[0] === 'pr' && ['close', 'comment', 'review', 'merge', 'ready'].includes(args[1] ?? '')) || (args[0] === 'api' && args.includes('--method'))
const writesOf = (gh: FakeRunner): Call[] => gh.calls.filter((call) => isWrite(call.args))

const headOf = async (number: number): Promise<string> => (await singlePr(number)).data.repository!.pullRequest!.headRefOid

// the fixture world, a live read that says the PR is open at its cached head unless a test says otherwise, and writes that succeed unless told to fail
const ghWorld = (live: { state?: string, head?: string, base?: string } = {}, writeError?: string): FakeRunner => {
  const base = fixtureRunner()
  return fakeRunner(async (args) => {
    if (isLiveRead(args)) {
      const number = Number(args[1]!.split('/').pop())
      return ok(JSON.stringify({ state: live.state ?? 'open', merged: false, base: { ref: live.base ?? 'main' }, head: { sha: live.head ?? await headOf(number) } }))
    }
    if (isWrite(args)) return writeError === undefined ? ok('') : failed(writeError)
    if (args[0] === 'api' && args[1] === 'user') return ok(`${scenario.viewer}\n`)
    return base.runner(args)
  })
}

const setup = async (gh: FakeRunner = ghWorld(), config: Partial<Config> = {}): Promise<Harness> => {
  const { dir: home, cleanup: removeHome } = await tempDir()
  const configPath = join(home, '.config', 'pit-view', 'config.json')
  await mkdir(join(configPath, '..'), { recursive: true })
  await writeFile(configPath, JSON.stringify({ repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit', ...config }), 'utf8')
  const stateDir = join(home, '.local', 'state', 'pit-view')
  const time = fakeTime()
  const launch = fakeLaunch()
  const server = await startServer({
    home, port: 0, runner: gh.runner, clock: time.clock, timers: time.timers, timeZone: scenario.timeZone, configPath,
    cachePath: join(stateDir, 'cache.sqlite'), stateDir, publicDir: join(home, 'public'), launch: launch.deps, log: () => {}, pageSize: scenario.pageSize,
  })
  const refreshed = await fetch(`${server.url}/api/refresh`, { method: 'POST', headers: { Origin: server.url } })
  assert.equal(refreshed.status, 200)
  await server.poller.idle()
  return { server, gh, launch, stateDir, cleanup: async () => { await server.close(); await removeHome() } }
}

const send = async (h: Harness, path: string, body: unknown): Promise<{ status: number, body: Record<string, unknown> }> => {
  const response = await fetch(`${h.server.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: h.server.url, 'X-Pit-View-Token': h.server.token },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

const start = (h: Harness, number: number, ask: Record<string, unknown>): Promise<{ status: number, body: Record<string, unknown> }> =>
  send(h, `/api/prs/${number}/runs`, { repo: scenario.repo, viewer: scenario.viewer, ...ask })

const runDir = (h: Harness, id: unknown): string => join(h.stateDir, 'runs', String(id))
const claudeRequest = (child: FakeChild): string => (JSON.parse(child.writes[0] ?? '{}') as { message: { content: string } }).message.content
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

// a Relevancy check of #104, or of the PR named, that ran and finished with this result
const checked = async (h: Harness, patch: Record<string, unknown>, number = 104): Promise<number> => {
  const started = await start(h, number, { kind: 'relevancy', runner: 'claude' })
  assert.equal(started.status, 200, JSON.stringify(started.body))
  const id = Number(started.body.id)
  const settled = h.server.launcher.settled(id)
  await writeFile(join(runDir(h, id), 'result.json'), JSON.stringify(relevancyResult({ target: { repo: scenario.repo, pr: number, base: 'main' }, head: { sha: await headOf(number) }, ...patch })))
  ;(h.launch.children.at(-1) as FakeChild).exit(0)
  await settled
  return id
}

const close = async (h: Harness, number: number, body: Record<string, unknown>): Promise<{ status: number, body: Record<string, unknown> }> =>
  send(h, `/api/prs/${number}/actions`, { action: 'close', repo: scenario.repo, viewer: scenario.viewer, headSha: await headOf(number), ...body })

test('the start route runs relevancy-pr on the viewer\'s own PR and refuses it on anyone else\'s with nothing run', async () => {
  const h = await setup()
  try {
    for (const number of [113, 114]) {
      const refused = await start(h, number, { kind: 'relevancy' })
      assert.equal(refused.status, 422, `#${number}`)
      assert.equal(refused.body.error, `Relevancy check is offered only on your own PRs, and #${number} is not yours`)
    }
    assert.equal(h.launch.children.length, 0)
    const started = await start(h, 104, { kind: 'relevancy', runner: 'claude' })
    assert.equal(started.status, 200)
    assert.deepEqual([started.body.command, started.body.args, started.body.label], ['relevancy-pr', ['104'], 'Relevancy check'])
    assert.equal(claudeRequest(h.launch.children.at(-1) as FakeChild), `/relevancy-pr 104 --emit-json=${runDir(h, started.body.id)}`)
    const box = await start(h, 104, { kind: 'relevancy', extraInstructions: 'look harder' })
    assert.equal(box.status, 422, 'a relevancy check offers no Special instructions box')
  } finally {
    await h.cleanup()
  }
})

test('the Fix session takes the relevancy check\'s prompt through extra-instructions.txt and one valueless flag, never on a command line', async () => {
  const h = await setup()
  try {
    const id = await checked(h, { reason: 'Still needed, but it calls computeDelay, which #88 renamed.', needsUpdates: true, fixPrompt: prompt })
    const fix = await start(h, 104, { kind: 'fix', fixPrompt: { runId: id, text: prompt } })
    assert.equal(fix.status, 200, JSON.stringify(fix.body))
    assert.deepEqual(fix.body.args, ['104', '--extra-instructions'])
    assert.deepEqual(fix.body.extraInstructions, { text: prompt, source: 'relevancy' })
    const child = h.launch.children.at(-1) as FakeChild
    assert.equal(claudeRequest(child), `/fix-pr 104 --extra-instructions --emit-json=${runDir(h, fix.body.id)}`)
    assert.equal(await readFile(join(runDir(h, fix.body.id), 'extra-instructions.txt'), 'utf8'), `${prompt}\n`)
    const everything = [child.request.command, ...child.request.args, ...child.writes, ...Object.values(child.request.env)].join('\n')
    assert.equal(everything.includes('backoffDelay'), false, 'the text reaches only the file')
  } finally {
    await h.cleanup()
  }
})

test('a Fix session with a prompt is refused, with nothing run, when the prompt is not the latest relevancy check\'s', async () => {
  const h = await setup()
  try {
    const id = await checked(h, { reason: 'Still needed, but it calls computeDelay, which #88 renamed.', needsUpdates: true, fixPrompt: prompt })
    const before = h.launch.children.length
    const stale = await start(h, 104, { kind: 'fix', fixPrompt: { runId: id, text: `${prompt} And more.` } })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.error, `the relevancy check's prompt for #104 is no longer the one you saw; nothing was started. Open the drawer again to see the current one`)
    assert.equal((await start(h, 104, { kind: 'fix', fixPrompt: { runId: id + 100, text: prompt } })).status, 409)
    for (const bad of ['text', { runId: id }, { runId: 'x', text: prompt }, { runId: id, text: prompt, extra: 1 }]) {
      assert.equal((await start(h, 104, { kind: 'fix', fixPrompt: bad })).status, 400, JSON.stringify(bad))
    }
    assert.equal((await start(h, 104, { kind: 'default', fixPrompt: { runId: id, text: prompt } })).status, 422, 'only a Fix session takes it')
    // the PR has no change request and no self-review: the plain Fix session is still not offered
    const plain = await start(h, 104, { kind: 'fix' })
    assert.equal(plain.status, 422)
    assert.match(String(plain.body.error), /^Fix requested changes is not offered for #104/)
    assert.equal(h.launch.children.length, before)
  } finally {
    await h.cleanup()
  }
})

test('a Fix session takes the prompt only while the PR targets the base the check judged: a retarget refuses it with nothing run', async () => {
  // #101 has a change request standing, so its Fix session is offered whatever the check says, and the prompt is what the server re-checks
  const updates = { reason: 'Still needed, but it calls computeDelay, which #88 renamed.', needsUpdates: true, fixPrompt: prompt }
  const h = await setup()
  try {
    const elsewhere = await checked(h, { ...updates, target: { repo: scenario.repo, pr: 101, base: 'release/2.4' } }, 101)
    const before = h.launch.children.length
    const refused = await start(h, 101, { kind: 'fix', fixPrompt: { runId: elsewhere, text: prompt } })
    assert.equal(refused.status, 409, JSON.stringify(refused.body))
    assert.equal(refused.body.error, `the relevancy check's prompt for #101 is no longer the one you saw; nothing was started. Open the drawer again to see the current one`)
    assert.equal(h.launch.children.length, before)
    const same = await checked(h, updates, 101)
    const taken = await start(h, 101, { kind: 'fix', fixPrompt: { runId: same, text: prompt } })
    assert.equal(taken.status, 200, JSON.stringify(taken.body))
    assert.deepEqual(taken.body.args, ['101', '--extra-instructions'])
  } finally {
    await h.cleanup()
  }
})

test('Close PR stands only while the PR targets the base the check judged, in the cache and in the live read, and a retarget writes nothing', async () => {
  const gone = { verdict: 'irrelevant', reason, needsUpdates: false, fixPrompt: null }
  const cached = await setup()
  try {
    const id = await checked(cached, { ...gone, target: { repo: scenario.repo, pr: 104, base: 'release/2.4' } })
    const refused = await close(cached, 104, { runId: id, comment: reason })
    assert.equal(refused.status, 422)
    assert.equal(refused.body.error, '#104 has no relevancy check that found it irrelevant; Close PR is offered only then')
    assert.deepEqual(writesOf(cached.gh), [])
  } finally {
    await cached.cleanup()
  }
  const live = await setup(ghWorld({ base: 'release/2.4' }))
  try {
    const id = await checked(live, gone)
    const refused = await close(live, 104, { runId: id, comment: reason })
    assert.equal(refused.status, 422)
    assert.equal(refused.body.error, '#104 now targets release/2.4, not main, the base the relevancy check judged; nothing was closed')
    assert.deepEqual(writesOf(live.gh), [])
  } finally {
    await live.cleanup()
  }
  const same = await setup(ghWorld({ base: 'main' }))
  try {
    const id = await checked(same, gone)
    assert.equal((await close(same, 104, { runId: id, comment: reason })).status, 200, 'same base')
    assert.deepEqual(writesOf(same.gh).map((call) => call.args), [['pr', 'close', '104', '--repo', scenario.repo, '--comment', reason]])
  } finally {
    await same.cleanup()
  }
})

test('Close PR closes without merging and posts the box as its one comment; an empty box closes with no comment', async () => {
  const h = await setup()
  try {
    const id = await checked(h, { verdict: 'irrelevant', reason, needsUpdates: false, fixPrompt: null })
    const closed = await close(h, 104, { runId: id, comment: `  ${reason}\u0007\r\nThanks.\u0000 ` })
    assert.equal(closed.status, 200, JSON.stringify(closed.body))
    assert.deepEqual(closed.body, { number: 104, action: 'close', done: true })
    assert.deepEqual(writesOf(h.gh).map((call) => call.args), [['pr', 'close', '104', '--repo', scenario.repo, '--comment', `${reason}\nThanks.`]])
  } finally {
    await h.cleanup()
  }
  for (const comment of ['', ' \n\t ', '\u0007', undefined]) {
    const empty = await setup()
    try {
      const id = await checked(empty, { verdict: 'irrelevant', reason, needsUpdates: false, fixPrompt: null })
      const done = await close(empty, 104, { runId: id, ...(comment === undefined ? {} : { comment }) })
      assert.equal(done.status, 200, JSON.stringify(comment))
      assert.deepEqual(writesOf(empty.gh).map((call) => call.args), [['pr', 'close', '104', '--repo', scenario.repo]], JSON.stringify(comment))
    } finally {
      await empty.cleanup()
    }
  }
})

test('Close PR is refused, with nothing written, unless it is the viewer\'s PR whose latest run is a done check that found it irrelevant at the head the confirmation showed', async () => {
  const h = await setup()
  try {
    // no check yet
    const none = await close(h, 104, { runId: 1, comment: reason })
    assert.equal(none.status, 422)
    assert.equal(none.body.error, '#104 has no relevancy check that found it irrelevant; Close PR is offered only then')
    assert.equal((await close(h, 113, { runId: 1, comment: reason })).status, 422, 'someone else\'s PR')
    const relevant = await checked(h, {})
    assert.equal((await close(h, 104, { runId: relevant, comment: reason })).status, 422, 'a check that found it relevant')
    const id = await checked(h, { verdict: 'irrelevant', reason, needsUpdates: false, fixPrompt: null })
    assert.equal((await close(h, 104, { runId: relevant, comment: reason })).status, 409, 'not the latest check')
    assert.equal((await close(h, 104, { runId: id, comment: reason, headSha: 'f'.repeat(40) })).status, 409, 'another head')
    assert.equal((await close(h, 104, { runId: id, comment: reason, viewer: 'someone-else' })).status, 409, 'another viewer')
    assert.equal((await close(h, 104, { runId: id, comment: reason, repo: 'octo-example/other' })).status, 409, 'another repository')
    const long = await close(h, 104, { runId: id, comment: 'x'.repeat(2001) })
    assert.equal(long.status, 400)
    assert.equal(long.body.error, 'comment must be at most 2,000 characters; it has 2,001')
    assert.equal((await close(h, 104, { runId: id, comment: 7 })).status, 400)
    assert.equal((await close(h, 104, { comment: reason })).status, 400, 'no runId')
    assert.deepEqual(writesOf(h.gh), [])
  } finally {
    await h.cleanup()
  }
})

test('Close PR is refused when the live read says the PR closed or moved, and nothing is written', async () => {
  for (const live of [{ state: 'closed' }, { head: 'f'.repeat(40) }]) {
    const h = await setup(ghWorld(live))
    try {
      const id = await checked(h, { verdict: 'irrelevant', reason, needsUpdates: false, fixPrompt: null })
      const refused = await close(h, 104, { runId: id, comment: reason })
      assert.equal(refused.status, 422, JSON.stringify(live))
      assert.match(String(refused.body.error), /nothing was closed/)
      assert.deepEqual(writesOf(h.gh), [])
    } finally {
      await h.cleanup()
    }
  }
})

test('the one comment Pit View posts is Close PR\'s: every other action refuses a comment, and approving or commenting is no action at all', async () => {
  const h = await setup()
  try {
    for (const action of ['comment', 'approve', 'requestChanges', 'review']) {
      const refused = await send(h, '/api/prs/104/actions', { action, repo: scenario.repo, body: 'LGTM' })
      assert.equal(refused.status, 400, action)
      assert.match(String(refused.body.error), /^action must be one of merge, markReady, convertToDraft, requestReview, update, resolveConflicts, or close/)
    }
    for (const body of [{ action: 'markReady' }, { action: 'convertToDraft' }, { action: 'requestReview', reviewer: 'alex-mendez' }, { action: 'merge', headSha: 'a'.repeat(40), base: 'main' }]) {
      const refused = await send(h, '/api/prs/104/actions', { repo: scenario.repo, comment: 'hello', ...body })
      assert.equal(refused.status, 400, body.action)
      assert.match(String(refused.body.error), new RegExp(`^${body.action} takes no comment`))
    }
    assert.deepEqual(writesOf(h.gh), [])
  } finally {
    await h.cleanup()
  }
})

test('a Close PR that GitHub refuses says so, and a check whose run folder holds no extra file starts nothing extra', async () => {
  const h = await setup(ghWorld({}, 'GraphQL: Could not close the pull request'))
  try {
    const id = await checked(h, { verdict: 'irrelevant', reason, needsUpdates: false, fixPrompt: null })
    assert.equal(await exists(join(runDir(h, id), 'extra-instructions.txt')), false)
    const refused = await close(h, 104, { runId: id, comment: reason })
    assert.equal(refused.status, 502)
  } finally {
    await h.cleanup()
  }
})
