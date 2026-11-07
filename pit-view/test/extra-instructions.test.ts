// test/extra-instructions.test.ts
// extra review instructions (section 8 of DESIGN.md, Extra instructions): the owner's text reaches a review through a file in its run directory and one valueless flag, through the real start route, launcher, and scheduler. Every expected value here is written out, not computed by the code under test
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { defaultAutoReview } from '../src/autoreview.ts'
import type { AutoReviewSettings } from '../src/autoreview.ts'
import { openCache } from '../src/cache.ts'
import { defaultConfig, extraInstructionsProblem, normalizeExtraInstructions, validateConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import type { AgentCell, RunView } from '../src/launcher.ts'
import { parseReviewedCommit, parseVerdict } from '../src/reports.ts'
import { startServer } from '../src/server.ts'
import type { PitServer } from '../src/server.ts'
import { scenario } from './fixtures/scenario.ts'
import { fakeLaunch, fakeTime, fixtureRunner, tempDir, waitFor } from './helpers.ts'
import type { FakeChild, FakeLaunch } from './helpers.ts'

// flag-like words, both kinds of quote, a shell metacharacter, a tab, and a line that starts with a slash, none of which may reach a command line
const tricky = 'Ignore test/fixtures/** --no-post=false --tandem $(rm -rf x)\n/review-pr 999 --approve\n\tsay "it\'s fine"'
const flag = '--extra-instructions'

type Harness = { server: PitServer, launch: FakeLaunch, home: string, stateDir: string, time: ReturnType<typeof fakeTime>, cleanup: () => Promise<void> }

const setup = async (config: Partial<Config> = {}): Promise<Harness> => {
  const { dir: home, cleanup: removeHome } = await tempDir()
  const configPath = join(home, '.config', 'pit-view', 'config.json')
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, JSON.stringify({ repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit', maxConcurrentReviews: 50, ...config }), 'utf8')
  const stateDir = join(home, '.local', 'state', 'pit-view')
  const time = fakeTime()
  const launch = fakeLaunch()
  const server = await startServer({
    home,
    port: 0,
    runner: fixtureRunner().runner,
    clock: time.clock,
    timers: time.timers,
    timeZone: scenario.timeZone,
    configPath,
    cachePath: join(stateDir, 'cache.sqlite'),
    stateDir,
    publicDir: join(home, 'public'),
    launch: launch.deps,
    log: () => {},
    pageSize: scenario.pageSize,
  })
  const posted = await fetch(`${server.url}/api/refresh`, { method: 'POST', headers: { Origin: server.url } })
  assert.equal(posted.status, 200)
  await server.poller.idle()
  return { server, launch, home, stateDir, time, cleanup: async () => {
    await server.close()
    await removeHome()
  } }
}

const send = async (h: Harness, method: string, path: string, body?: unknown): Promise<{ status: number, body: Record<string, unknown> }> => {
  const response = await fetch(`${h.server.url}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: h.server.url, 'X-Pit-View-Token': h.server.token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

const start = (h: Harness, number: number, ask: Record<string, unknown> = {}): Promise<{ status: number, body: Record<string, unknown> }> =>
  send(h, 'POST', `/api/prs/${number}/runs`, { repo: scenario.repo, ...ask })

const runDir = (h: Harness, id: unknown): string => join(h.stateDir, 'runs', String(id))
const fileOf = (h: Harness, id: unknown): string => join(runDir(h, id), 'extra-instructions.txt')
const requestOf = async (h: Harness, id: unknown): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(runDir(h, id), 'request.json'), 'utf8')) as Record<string, unknown>
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false)
const stop = async (h: Harness, id: unknown): Promise<void> => {
  const settled = h.server.launcher.settled(Number(id))
  await send(h, 'POST', `/api/runs/${String(id)}/stop`)
  await settled
}

// what the runner is handed: Claude's one stdin line, or Codex's prompt argument without its note
const claudeRequest = (child: FakeChild): string =>
  (JSON.parse(child.writes[0] ?? '{}') as { message: { content: string } }).message.content
const codexRequest = (child: FakeChild): string => (child.request.args.at(-1) ?? '').split('\n\n')[0] ?? ''

// nothing of the text anywhere the runner's process can see it but the file
const trickyParts = ['test/fixtures/**', '--no-post=false', '$(rm -rf x)', '/review-pr 999', '--approve', 'it\'s fine']
const assertNotOnCommandLine = (child: FakeChild, parts: readonly string[]): void => {
  const everything = [child.request.command, ...child.request.args, ...child.writes, ...Object.values(child.request.env)].join('\n')
  for (const part of parts) assert.equal(everything.includes(part), false, part)
}

const cellOf = async (h: Harness, number: number): Promise<AgentCell> => {
  const view = await (await fetch(`${h.server.url}/api/view`)).json() as { mine: { groups: { rows: { number: number, agent: AgentCell }[] }[] }, others: { groups: { rows: { number: number, agent: AgentCell }[] }[] } }
  const rows = [...view.mine.groups, ...view.others.groups].flatMap((group) => group.rows)
  const row = rows.find((candidate) => candidate.number === number)
  assert.ok(row, `#${number} is on the page`)
  return row.agent
}

// the text rule

test('the text rule: at most 2,000 characters, plain text with line breaks and tabs, and each refusal names its exact reason', () => {
  assert.equal(extraInstructionsProblem('x'.repeat(2000)), null)
  assert.equal(extraInstructionsProblem('x'.repeat(2001)), 'must be at most 2,000 characters; it has 2,001')
  // a character is what a reader counts: one emoji is one, not two code units
  assert.equal(extraInstructionsProblem('😀'.repeat(2000)), null)
  assert.equal(extraInstructionsProblem(`${'😀'.repeat(2000)}x`), 'must be at most 2,000 characters; it has 2,001')
  // a Windows line break counts once, and spaces around the text count for nothing
  assert.equal(extraInstructionsProblem(`${'x'.repeat(999)}\r\n${'x'.repeat(1000)}`), null)
  assert.equal(extraInstructionsProblem(`  ${'x'.repeat(2000)}\n\n`), null)
  assert.equal(extraInstructionsProblem('a\tb\nc\r\nd'), null)
  assert.equal(extraInstructionsProblem(''), null)
  assert.equal(extraInstructionsProblem('ab\u0007c'), 'must be plain text: character 3 is the control character U+0007, and only line breaks and tabs are allowed')
  assert.equal(extraInstructionsProblem('\u0000'), 'must be plain text: character 1 is the control character U+0000, and only line breaks and tabs are allowed')
  // not only the C0 set, and trimming never hides one
  assert.equal(extraInstructionsProblem('ab\u007f'), 'must be plain text: character 3 is the control character U+007F, and only line breaks and tabs are allowed')
  assert.equal(extraInstructionsProblem('\u0085ab'), 'must be plain text: character 1 is the control character U+0085, and only line breaks and tabs are allowed')
  assert.equal(extraInstructionsProblem('ab\f'), 'must be plain text: character 3 is the control character U+000C, and only line breaks and tabs are allowed')
  assert.equal(extraInstructionsProblem('😀\u0001'), 'must be plain text: character 2 is the control character U+0001, and only line breaks and tabs are allowed')
  assert.equal(normalizeExtraInstructions('  a\r\nb\rc d e\n\n'), 'a\nb\nc\nd\ne')
  assert.equal(normalizeExtraInstructions(' \t\r\n '), '')
  assert.equal(normalizeExtraInstructions(tricky), tricky)
})

test('Settings keeps the standing default: empty unless set, stored normalized, and refused with the exact reason', () => {
  const base = defaultConfig()
  assert.equal(base.extraReviewInstructions, '')
  assert.equal(validateConfig({ ...base, extraReviewInstructions: ` ${tricky}\r\n` }).extraReviewInstructions, tricky)
  assert.throws(() => validateConfig({ ...base, extraReviewInstructions: 'x'.repeat(2001) }), /^ConfigError: config\.extraReviewInstructions must be at most 2,000 characters; it has 2,001$/)
  assert.throws(() => validateConfig({ ...base, extraReviewInstructions: 'a\u0007' }), /^ConfigError: config\.extraReviewInstructions must be plain text: character 2 is the control character U\+0007, and only line breaks and tabs are allowed$/)
  assert.throws(() => validateConfig({ ...base, extraReviewInstructions: 7 }), /^ConfigError: config\.extraReviewInstructions must be a string$/)
})

// the invocation, for each kind and runner, through the start route

const kinds: { name: string, number: number, ask: Record<string, unknown>, args: string[] }[] = [
  { name: 'a review', number: 113, ask: { kind: 'default', runner: 'claude' }, args: ['113', flag] },
  { name: 'a re-review', number: 106, ask: { kind: 'default', runner: 'claude' }, args: ['106', flag] },
  { name: 'a self-review', number: 104, ask: { kind: 'default', runner: 'claude' }, args: ['104', '--no-post', flag] },
  { name: 'a tandem review', number: 113, ask: { kind: 'tandem', runner: 'claude' }, args: ['113', '--tandem', flag] },
  { name: 'a tandem self-review', number: 104, ask: { kind: 'tandem', runner: 'claude' }, args: ['104', '--tandem', '--no-post', flag] },
  { name: 'a stack review', number: 111, ask: { kind: 'stack', runner: 'claude' }, args: ['111', flag] },
  { name: 'a review with Codex', number: 113, ask: { kind: 'default', runner: 'codex' }, args: ['113', flag] },
  { name: 'a self-review with Codex', number: 104, ask: { kind: 'default', runner: 'codex' }, args: ['104', '--no-post', flag] },
  { name: 'a stack review with Codex', number: 112, ask: { kind: 'stack', runner: 'codex' }, args: ['112', flag] },
]

test('every review kind on every runner takes one valueless flag beside --emit-json, and the text reaches only the file', async () => {
  const h = await setup()
  try {
    for (const { name, number, ask, args } of kinds) {
      const started = await start(h, number, { ...ask, extraInstructions: tricky })
      assert.equal(started.status, 200, name)
      assert.deepEqual(started.body.args, args, name)
      const child = h.launch.children.at(-1) as FakeChild
      const dir = runDir(h, started.body.id)
      const command = number === 111 || number === 112 ? 'review-stack' : 'review-pr'
      if (ask.runner === 'claude') assert.equal(claudeRequest(child), `/${command} ${args.join(' ')} --emit-json=${dir}`, name)
      else assert.equal(codexRequest(child), `$${command} ${args.join(' ')} --emit-json=${dir}`, name)
      assertNotOnCommandLine(child, trickyParts)
      assert.equal(await readFile(fileOf(h, started.body.id), 'utf8'), `${tricky}\n`, name)
      await stop(h, started.body.id)
    }
  } finally {
    await h.cleanup()
  }
})

test('with the comments check the flag follows it, and neither changes the other', async () => {
  const h = await setup()
  try {
    const started = await start(h, 104, { checkComments: true, extraInstructions: 'look harder' })
    assert.deepEqual(started.body.args, ['104', '--no-post', '--check-comments', flag])
    assert.equal(claudeRequest(h.launch.children.at(-1) as FakeChild), `/review-pr 104 --no-post --check-comments ${flag} --emit-json=${runDir(h, started.body.id)}`)
  } finally {
    await h.cleanup()
  }
})

test('a Fix session and a Dependabot review offer no box, and a start that sends one anyway is refused with nothing run', async () => {
  const h = await setup({ extraReviewInstructions: 'skip fixtures' })
  try {
    const before = h.launch.children.length
    for (const [number, ask] of [[104, { kind: 'fix' }], [114, { kind: 'default' }]] as const) {
      for (const value of ['skip fixtures', '']) {
        const refused = await start(h, number, { ...ask, extraInstructions: value })
        assert.equal(refused.status, 422, `#${number}`)
        assert.equal(refused.body.error, `Extra instructions are offered only on a review, a re-review, a self-review, a tandem review, or a stack review, and this start of #${number} is not one`)
      }
    }
    assert.equal(h.launch.children.length, before)
    // and with none sent, each runs as it always did, with the standing default left out
    const fix = await start(h, 104, { kind: 'fix' })
    assert.deepEqual(fix.body.args, ['104'])
    assert.equal(await exists(fileOf(h, fix.body.id)), false)
    assert.equal(claudeRequest(h.launch.children.at(-1) as FakeChild), `/fix-pr 104 --emit-json=${runDir(h, fix.body.id)}`)
    assert.equal(Object.hasOwn(await requestOf(h, fix.body.id), 'extraInstructions'), false)
    const dependabot = await start(h, 114, { kind: 'default' })
    assert.deepEqual(dependabot.body.args, ['114'])
    assert.equal(await exists(fileOf(h, dependabot.body.id)), false)
  } finally {
    await h.cleanup()
  }
})

test('the starts a row offers name the standing default and the flag on review starts alone', async () => {
  const h = await setup({ extraReviewInstructions: 'skip fixtures' })
  try {
    const offered = { standing: 'skip fixtures', flag }
    const own = await cellOf(h, 104)
    assert.deepEqual(own.starts.map((option) => [option.kind, option.extraInstructions]), [['default', offered], ['tandem', offered], ['fix', undefined]])
    const others = await cellOf(h, 113)
    assert.deepEqual(others.starts.map((option) => [option.kind, option.extraInstructions]), [['default', offered], ['tandem', offered]])
    const stacked = await cellOf(h, 111)
    assert.deepEqual(stacked.starts.find((option) => option.kind === 'stack')?.extraInstructions, offered)
    const dependabot = await cellOf(h, 114)
    assert.deepEqual(dependabot.starts.map((option) => option.extraInstructions), [undefined])
    // a saved default reaches the open rows as a patch would, with no cycle
    const stored = await send(h, 'GET', '/api/config')
    assert.equal((await send(h, 'PUT', '/api/config', { ...stored.body, extraReviewInstructions: 'read the tests first' })).status, 200)
    assert.deepEqual((await cellOf(h, 113)).starts[0]?.extraInstructions, { standing: 'read the tests first', flag })
  } finally {
    await h.cleanup()
  }
})

test('text over the limit, with a control character, or of another type is refused with the exact reason before anything runs', async () => {
  const h = await setup()
  try {
    const before = h.launch.children.length
    const over = await start(h, 113, { extraInstructions: 'x'.repeat(2001) })
    assert.deepEqual([over.status, over.body.error], [400, 'extraInstructions must be at most 2,000 characters; it has 2,001'])
    const control = await start(h, 113, { extraInstructions: 'ok\u0007' })
    assert.deepEqual([control.status, control.body.error], [400, 'extraInstructions must be plain text: character 3 is the control character U+0007, and only line breaks and tabs are allowed'])
    for (const value of [7, null, ['x'], {}, true]) {
      const bad = await start(h, 113, { extraInstructions: value })
      assert.deepEqual([bad.status, bad.body.error], [400, 'extraInstructions must be a string'], JSON.stringify(value))
    }
    assert.equal(h.launch.children.length, before)
    const limit = await start(h, 113, { extraInstructions: 'x'.repeat(2000) })
    assert.equal(limit.status, 200)
    assert.equal(await readFile(fileOf(h, limit.body.id), 'utf8'), `${'x'.repeat(2000)}\n`)
  } finally {
    await h.cleanup()
  }
})

test('the box decides: an unchanged box is the default, an edited one is the box, a cleared one is none, and a start with no field takes the default', async () => {
  const h = await setup({ extraReviewInstructions: 'skip fixtures' })
  try {
    const unchanged = await start(h, 113, { extraInstructions: 'skip fixtures' })
    assert.deepEqual((await requestOf(h, unchanged.body.id)).extraInstructions, { text: 'skip fixtures', source: 'default' })
    assert.deepEqual(unchanged.body.extraInstructions, { text: 'skip fixtures', source: 'default' })
    await stop(h, unchanged.body.id)

    const edited = await start(h, 113, { extraInstructions: 'skip docs too' })
    assert.deepEqual((await requestOf(h, edited.body.id)).extraInstructions, { text: 'skip docs too', source: 'box' })
    assert.equal(await readFile(fileOf(h, edited.body.id), 'utf8'), 'skip docs too\n')
    await stop(h, edited.body.id)

    for (const cleared of ['', '  \n\t ']) {
      const none = await start(h, 113, { extraInstructions: cleared })
      assert.equal(none.status, 200)
      assert.deepEqual(none.body.args, ['113'])
      assert.equal(none.body.extraInstructions, null)
      assert.equal(await exists(fileOf(h, none.body.id)), false)
      assert.equal(Object.hasOwn(await requestOf(h, none.body.id), 'extraInstructions'), false)
      assert.equal(claudeRequest(h.launch.children.at(-1) as FakeChild), `/review-pr 113 --emit-json=${runDir(h, none.body.id)}`)
      await stop(h, none.body.id)
    }

    const absent = await start(h, 113)
    assert.deepEqual(absent.body.args, ['113', flag])
    assert.deepEqual((await requestOf(h, absent.body.id)).extraInstructions, { text: 'skip fixtures', source: 'default' })
  } finally {
    await h.cleanup()
  }
})

test('with no default and no box a review is the invocation it always was', async () => {
  const h = await setup()
  try {
    const started = await start(h, 113)
    assert.deepEqual(started.body.args, ['113'])
    assert.equal(await exists(fileOf(h, started.body.id)), false)
    assert.equal(claudeRequest(h.launch.children.at(-1) as FakeChild), `/review-pr 113 --emit-json=${runDir(h, started.body.id)}`)
    assert.deepEqual((await cellOf(h, 113)).extraInstructions, null)
  } finally {
    await h.cleanup()
  }
})

test('a re-review started from Pit View sends the then-current text and never reuses an old run directory\'s file', async () => {
  const h = await setup({ extraReviewInstructions: 'first text' })
  try {
    const first = await start(h, 113)
    await stop(h, first.body.id)
    const stored = await send(h, 'GET', '/api/config')
    assert.equal((await send(h, 'PUT', '/api/config', { ...stored.body, extraReviewInstructions: 'second text' })).status, 200)
    const second = await start(h, 113)
    assert.notEqual(second.body.id, first.body.id)
    const request = claudeRequest(h.launch.children.at(-1) as FakeChild)
    assert.equal(request, `/review-pr 113 ${flag} --emit-json=${runDir(h, second.body.id)}`)
    assert.equal(request.includes(runDir(h, first.body.id)), false)
    assert.equal(await readFile(fileOf(h, second.body.id), 'utf8'), 'second text\n')
    // the earlier run's file and record stay as they were, for that run alone
    assert.equal(await readFile(fileOf(h, first.body.id), 'utf8'), 'first text\n')
    assert.deepEqual((await requestOf(h, first.body.id)).extraInstructions, { text: 'first text', source: 'default' })
  } finally {
    await h.cleanup()
  }
})

test('a queued review keeps the text its confirmation showed, whatever Settings says when its turn comes, and its file is written when it starts', async () => {
  const h = await setup({ maxConcurrentReviews: 1 })
  try {
    const running = await start(h, 106)
    const queued = await start(h, 113, { extraInstructions: 'confirmed text' })
    assert.equal(queued.body.status, 'queued')
    assert.deepEqual(queued.body.args, ['113', flag])
    assert.deepEqual(queued.body.extraInstructions, { text: 'confirmed text', source: 'box' })
    assert.equal(await exists(fileOf(h, queued.body.id)), false)
    const stored = await send(h, 'GET', '/api/config')
    assert.equal((await send(h, 'PUT', '/api/config', { ...stored.body, extraReviewInstructions: 'later text' })).status, 200)
    await stop(h, running.body.id)
    await waitFor(() => h.launch.children.length === 2)
    const started = h.launch.children.at(-1) as FakeChild
    assert.equal(claudeRequest(started), `/review-pr 113 ${flag} --emit-json=${runDir(h, queued.body.id)}`)
    assert.equal(await readFile(fileOf(h, queued.body.id), 'utf8'), 'confirmed text\n')
    assert.deepEqual((await requestOf(h, queued.body.id)).extraInstructions, { text: 'confirmed text', source: 'box' })
  } finally {
    await h.cleanup()
  }
})

test('a start whose file cannot be written fails with nothing spawned, so no run ever carries the flag without its file', async () => {
  const { dir: home, cleanup } = await tempDir()
  const launch = fakeLaunch({ fs: { writeFile: async (path, text) => {
    if (path.endsWith('extra-instructions.txt')) throw new Error('ENOSPC: no space left on device')
    await writeFile(path, text)
  } } })
  const configPath = join(home, 'config.json')
  await writeFile(configPath, JSON.stringify({ repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit' }), 'utf8')
  await mkdir(join(home, 'state'), { recursive: true })
  const time = fakeTime()
  const server = await startServer({ home, port: 0, runner: fixtureRunner().runner, clock: time.clock, timers: time.timers, timeZone: scenario.timeZone, configPath, cachePath: join(home, 'state', 'cache.sqlite'), stateDir: join(home, 'state'), publicDir: join(home, 'public'), launch: launch.deps, log: () => {}, pageSize: scenario.pageSize })
  try {
    await fetch(`${server.url}/api/refresh`, { method: 'POST', headers: { Origin: server.url } })
    await server.poller.idle()
    const answer = await fetch(`${server.url}/api/prs/113/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.url, 'X-Pit-View-Token': server.token }, body: JSON.stringify({ repo: scenario.repo, extraInstructions: 'skip fixtures' }) })
    const run = await answer.json() as RunView
    assert.equal(run.status, 'failed')
    assert.equal(run.note, 'spawnFailed: ENOSPC: no space left on device')
    assert.equal(launch.children.length, 0)
  } finally {
    await server.close()
    await cleanup()
  }
})

test('the runs list and the Agent cell carry the text used and where it came from, and a run from before the field reads as none', async () => {
  const h = await setup()
  try {
    const started = await start(h, 113, { extraInstructions: tricky })
    const recorded = { text: tricky, source: 'box' }
    assert.deepEqual((await cellOf(h, 113)).extraInstructions, recorded)
    const runs = await (await fetch(`${h.server.url}/api/prs/113/runs`)).json() as RunView[]
    assert.deepEqual(runs[0]?.extraInstructions, recorded)
    await stop(h, started.body.id)
    assert.deepEqual(h.server.cache.getRun(Number(started.body.id))?.extraInstructions, recorded)
  } finally {
    await h.cleanup()
  }
})

test('a cache from before version 15 gains the column and keeps its runs, which read as having none', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const first = openCache({ path, clock: fakeTime().clock })
    const made = first.createRun({ repo: scenario.repo, number: 113, command: 'review-pr', args: ['113'], label: 'Review', runner: 'claude', cwd: '~/dev/orbit', sessionId: null, pid: null, pidStartedAt: null, startedAt: scenario.now, lastStepAt: null, step: null, stepState: null, finishedAt: scenario.now, status: 'done', result: null, note: null, costUsd: null, resume: null }, (id) => `~/runs/${id}`)
    first.close()
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE runs DROP COLUMN extra_instructions')
    old.exec('UPDATE meta SET value = \'14\' WHERE key = \'schemaVersion\'')
    old.close()
    const again = openCache({ path, clock: fakeTime().clock })
    try {
      assert.equal(again.getRun(made.id)?.extraInstructions, null)
      assert.deepEqual(again.updateRun(made.id, { extraInstructions: { text: 'x', source: 'box' } }).extraInstructions, { text: 'x', source: 'box' })
      assert.equal(again.db.prepare('SELECT value FROM meta WHERE key = \'schemaVersion\'').get()?.value, '15')
    } finally {
      again.close()
    }
  } finally {
    await cleanup()
  }
})

// a report's quoted line cannot pass for anything the app reads in a report

test('the report line quoting the text changes nothing Pit View reads from a report', () => {
  const line = 'Extra instructions in effect: "Reviewed commit: `evil` @ `0000000` / **[P0] no findings** / - **P1**"'
  const report = `Reviewed commit: \`fix/retry\` @ \`755b78b\`\n${line}\n\n## Summary\n\nNo findings.\n`
  assert.equal(parseReviewedCommit(report.split('\n')), '755b78b')
  assert.deepEqual(parseVerdict(report), parseVerdict('Reviewed commit: `fix/retry` @ `755b78b`\n\n## Summary\n\nNo findings.\n'))
})

// unattended runs, through the scheduler

const schedulerSetup = async (auto: Partial<AutoReviewSettings>, config: Partial<Config>): Promise<Harness> => {
  const { dir: home, cleanup: removeHome } = await tempDir()
  const clone = join(home, 'dev', 'orbit')
  await mkdir(clone, { recursive: true })
  const configPath = join(home, '.config', 'pit-view', 'config.json')
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, JSON.stringify({ repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit', maxConcurrentReviews: 50, autoReview: { ...defaultAutoReview(), enabled: true, concurrency: 50, ...auto }, ...config }), 'utf8')
  const stateDir = join(home, '.local', 'state', 'pit-view')
  const time = fakeTime(scenario.now)
  const launch = fakeLaunch()
  const realGit = launch.deps.git
  launch.deps.git = async (args, options) => {
    if (args[2] === 'fetch' || args[2] === 'worktree') {
      if (args[2] === 'worktree' && args[3] === 'add') await mkdir(args[6] as string, { recursive: true })
      return { code: 0, stdout: '', stderr: '' }
    }
    return realGit(args, options)
  }
  const server = await startServer({ home, port: 0, runner: fixtureRunner().runner, clock: time.clock, timers: time.timers, timeZone: scenario.timeZone, configPath, cachePath: join(stateDir, 'cache.sqlite'), stateDir, publicDir: join(home, 'public'), launch: launch.deps, log: () => {}, pageSize: scenario.pageSize })
  await server.scheduler.idle()
  return { server, launch, home, stateDir, time, cleanup: async () => {
    await server.close()
    await removeHome()
  } }
}

const tick = async (h: Harness): Promise<void> => {
  h.time.advance(15 * 60_000)
  await h.server.scheduler.idle()
}

test('an unattended review of someone else\'s PR or the viewer\'s own takes the standing default, recorded as the default, on the current text', async () => {
  const h = await schedulerSetup({ others: true, own: true }, { extraReviewInstructions: 'skip fixtures' })
  try {
    await tick(h)
    const runs = h.server.cache.allRuns().filter((run) => run.origin === 'auto' && run.status === 'running')
    assert.ok(runs.length >= 2, `${runs.length} runs`)
    for (const run of runs) {
      assert.deepEqual(run.args, [String(run.number), '--no-post', flag])
      assert.deepEqual(run.extraInstructions, { text: 'skip fixtures', source: 'default' })
      assert.equal(await readFile(fileOf(h, run.id), 'utf8'), 'skip fixtures\n')
      assert.deepEqual((await requestOf(h, run.id)).extraInstructions, { text: 'skip fixtures', source: 'default' })
    }
    for (const child of h.launch.children) {
      assert.match(claudeRequest(child), /^\/review-pr \d+ --no-post --extra-instructions --emit-json=/)
      assertNotOnCommandLine(child, ['skip fixtures'])
    }
  } finally {
    await h.cleanup()
  }
})

test('a queued unattended review takes the text in effect when it starts, and takes none once the default is cleared', async () => {
  const h = await schedulerSetup({ others: true, own: false, concurrency: 1 }, { extraReviewInstructions: 'skip fixtures', maxConcurrentReviews: 1 })
  try {
    await tick(h)
    const first = h.server.cache.allRuns().find((run) => run.origin === 'auto' && run.status === 'running')
    const waiting = h.server.cache.allRuns().find((run) => run.origin === 'auto' && run.status === 'queued')
    assert.ok(first && waiting)
    assert.deepEqual(waiting.extraInstructions, { text: 'skip fixtures', source: 'default' })
    const stored = await send(h, 'GET', '/api/config')
    assert.equal((await send(h, 'PUT', '/api/config', { ...stored.body, extraReviewInstructions: '' })).status, 200)
    await stop(h, first.id)
    await tick(h)
    const started = h.server.cache.getRun(waiting.id)
    assert.equal(started?.status, 'running')
    assert.deepEqual(started?.args, [String(waiting.number), '--no-post'])
    assert.equal(started?.extraInstructions, null)
    assert.equal(await exists(fileOf(h, waiting.id)), false)
  } finally {
    await h.cleanup()
  }
})

test('an unattended Dependabot sweep takes no extra instructions', async () => {
  const h = await schedulerSetup({ others: false, own: false, dependabot: true }, { extraReviewInstructions: 'skip fixtures' })
  try {
    await tick(h)
    const sweeps = h.server.cache.allSweeps().filter((sweep) => sweep.origin === 'auto')
    assert.equal(sweeps.length, 1)
    assert.equal(sweeps[0]?.args.includes(flag), false)
    const child = h.launch.children.at(-1) as FakeChild
    assert.doesNotMatch(claudeRequest(child), /--extra-instructions/)
    assert.equal(await exists(join(h.stateDir, 'sweeps', String(sweeps[0]?.id), 'extra-instructions.txt')), false)
  } finally {
    await h.cleanup()
  }
})

// the launcher that starts a tandem secondary, run for real against a fake gh and codex

const installTool = async (dir: string, name: string, body: string): Promise<void> => {
  await writeFile(join(dir, name), `#!/usr/bin/env bash\n${body}\n`)
  await chmod(join(dir, name), 0o755)
}

const runSecondary = async (extra: string[]): Promise<{ code: number | null, stdout: string, stderr: string, prompt: string | null }> => {
  const { dir, cleanup } = await tempDir()
  try {
    const tools = join(dir, 'tools')
    await mkdir(tools)
    const agents = join(dir, 'agents')
    await mkdir(join(agents, 'prompts', 'review'), { recursive: true })
    for (const name of ['review-pr', 'review-stack', 'review-local', 'tandem']) await writeFile(join(agents, 'prompts', 'review', `${name}.md`), 'prompt\n')
    const source = await readFile(join(import.meta.dirname, '..', '..', 'bin', 'tandem-secondary'), 'utf8')
    const script = join(dir, 'tandem-secondary')
    // the deployed form of the placeholder, in this test's own folder alone
    await writeFile(script, source.split('{{HOME}}').join(dir))
    await chmod(script, 0o755)
    const worktree = join(dir, 'worktree')
    await mkdir(worktree)
    const git = (args: string[]): Promise<void> => new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd: worktree, env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.test', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.test' } })
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')}: ${code}`)))
    })
    await git(['init', '-q'])
    await git(['commit', '-q', '--allow-empty', '-m', 'x'])
    const sha = await new Promise<string>((resolve) => {
      const child = spawn('git', ['rev-parse', '--short', 'HEAD'], { cwd: worktree })
      let out = ''
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString()
      })
      child.on('exit', () => resolve(out.trim()))
    })
    const promptCopy = join(dir, 'prompt-seen.txt')
    await installTool(tools, 'gh', `case "$1 $2" in\n  "repo view") echo octo-example/orbit ;;\n  "pr view") echo '{"number":5,"baseRefName":"main"}' ;;\n  *) echo null ;;\nesac`)
    await installTool(tools, 'codex', `cat > '${promptCopy}'\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then printf 'Reviewed commit: x @ ${sha}\\n\\n## Summary\\n' > "$2"; fi; shift; done`)
    const instructions = join(dir, 'extra-instructions.txt')
    await writeFile(instructions, 'skip fixtures\n')
    const args = ['--mode', 'pr', '--target', '5', '--sha', sha, '--worktree', worktree, '--draft', join(agents, 'output', 'PR-5-codex.md'), ...extra.map((word) => word === 'FILE' ? instructions : word)]
    const child = spawn(script, args, { env: { PATH: `${tools}:${process.env.PATH ?? ''}`, HOME: dir } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
    const prompt = await readFile(promptCopy, 'utf8').catch(() => null)
    return { code, stdout, stderr, prompt: prompt?.split(dir).join('<root>') ?? null }
  } finally {
    await cleanup()
  }
}

test('a launched tandem secondary is told to read the same file through the launcher, and is told nothing of it without the option', { timeout: 30_000 }, async () => {
  const given = await runSecondary(['--extra-instructions-file', 'FILE'])
  assert.equal(given.code, 0, given.stderr)
  assert.match(given.stdout, /tandem-secondary: ok /)
  assert.match(given.prompt ?? '', /Extra instructions: <root>\/extra-instructions\.txt\nRead <root>\/agents\/prompts\/review\/extra-instructions\.md in full and apply that file as it says\./)
  // the text itself is read from the file by the reviewer, never copied into its brief
  assert.equal(given.prompt?.includes('skip fixtures'), false)
  const without = await runSecondary([])
  assert.equal(without.code, 0, without.stderr)
  assert.equal(without.prompt?.includes('Extra instructions'), false)
  assert.equal(without.prompt?.includes('extra-instructions'), false)
})

test('the secondary launcher refuses a file that does not exist before it starts anything', { timeout: 30_000 }, async () => {
  const missing = await runSecondary(['--extra-instructions-file', '/nonexistent/extra-instructions.txt'])
  assert.equal(missing.code, 2)
  assert.match(missing.stderr, /error: no such extra instructions file: \/nonexistent\/extra-instructions\.txt/)
  assert.equal(missing.prompt, null)
})
