// test/hermes.test.ts
// the hermes runner (section 8 of DESIGN.md, Launching runs, The hermes runner): its command line and resume line, the stream it prints, the environment its child gets, which models it may start with, and what is refused. The end-to-end tests run the real launcher over a small fake hermes executable on a temp PATH and a recorded stream with invented content, so no model is ever called
import assert from 'node:assert/strict'
import { chmod, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { openCache } from '../src/cache.ts'
import type { Run } from '../src/cache.ts'
import { defaultConfig, validateConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { commandRunner, createGh } from '../src/github.ts'
import {
  childEnv, claudeInvocation, codexInvocation, createLauncher, createReviewLine, emptyStream, foldStream, hermesChildEnv, hermesEnvKeys, hermesInvocation, hermesMaxTurns, LaunchError,
  procsFrom, runners, runView, systemFs, systemSpawn,
} from '../src/launcher.ts'
import type { LaunchSpec } from '../src/launcher.ts'
import { runnerLabels } from '../public/agent.ts'
import { openRouterKeyPath, writeOpenRouterKey } from '../src/openrouter.ts'
import { systemTimers } from '../src/poller.ts'
import { scenario } from './fixtures/scenario.ts'
import { fakeRemotes, fixtureRunner, ok, tempDir } from './helpers.ts'

// a recognizable fake key, scanned for everywhere it must never appear
const fakeKey = 'sk-or-v1-PLANTEDfakefakefakefakefakefake9f3a7c'

const spec = (over: Partial<LaunchSpec> = {}): LaunchSpec => ({
  command: 'review-pr', args: ['104', '--no-post'], cwd: '/home/tester/agents/worktrees/orbit-104', runDir: '/home/tester/.local/state/pit-view/runs/7', home: '/home/tester',
  sessionId: null, claudeModel: 'sonnet', reportsDir: '/home/tester/agents/output', worktreesDir: '/home/tester/agents/worktrees',
  hermes: { provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code' }, hermesProfile: 'pitview', ...over,
})

test('a hermes run is hermes -p <profile> chat with the query file, one-shot, the registry entry\'s provider and model, the terminal and file tools, a turn bound, and stream-json, and never a key or a prompt on the command line', () => {
  const invocation = hermesInvocation(spec())
  assert.equal(invocation.command, 'hermes')
  assert.deepEqual(invocation.args, [
    '-p', 'pitview', 'chat', '--query-file', '/home/tester/.local/state/pit-view/runs/7/prompt.txt', '--oneshot', '--provider', 'openrouter', '--model', 'moonshotai/kimi-k2.7-code',
    '-t', 'terminal,file', '--max-turns', String(hermesMaxTurns), '--format', 'stream-json',
  ])
  // the request is a file, never stdin or an argument; the run directory is named in it as the other runners' requests do
  assert.equal(invocation.stdin, null)
  assert.deepEqual(invocation.promptFile, { path: '/home/tester/.local/state/pit-view/runs/7/prompt.txt', text: '/review-pr 104 --no-post --emit-json=/home/tester/.local/state/pit-view/runs/7' })
  assert.ok(!invocation.args.some((arg) => /api-key|sk-/.test(arg)))
  // the profile is whatever the setting says
  assert.deepEqual(hermesInvocation(spec({ hermesProfile: 'review2' })).args.slice(0, 3), ['-p', 'review2', 'chat'])
  // a spec with no registry entry is no hermes launch
  assert.throws(() => hermesInvocation(spec({ hermes: undefined })), /registry/)
})

test('the other runners take no query file, and the hermes resume line carries the profile and the session', () => {
  assert.equal(claudeInvocation(spec({ sessionId: 'abc' })).promptFile, undefined)
  assert.equal(codexInvocation(spec()).promptFile, undefined)
  assert.equal(runners.hermes.resume('~/agents/worktrees/orbit-104', 'local-0001', spec(), '/home/tester'), 'cd ~/agents/worktrees/orbit-104 && hermes -p pitview chat --resume local-0001')
  assert.equal(runners.hermes.resume('~/dev/orbit', 'local-0001', spec({ hermesProfile: 'review2' }), '/home/tester'), 'cd ~/dev/orbit && hermes -p review2 chat --resume local-0001')
  // a session id with a quote or a space is one word to the shell
  assert.equal(runners.hermes.resume('~/dev/orbit', "a b'c", spec(), '/home/tester'), `cd ~/dev/orbit && hermes -p pitview chat --resume 'a b'\\''c'`)
})

test('the hermes child environment is the launcher\'s own plus one named variable, and nothing from the server\'s environment', () => {
  assert.deepEqual([...hermesEnvKeys], ['OPENROUTER_API_KEY'])
  const server = { PATH: '/usr/bin', USER: 'tester', OPENROUTER_API_KEY: 'sk-or-server-env', HERMES_HOME: '/elsewhere', ANTHROPIC_API_KEY: 'sk-ant-x', GH_TOKEN: 'gho_x', SSH_AUTH_SOCK: '/s' }
  const env = hermesChildEnv(server, '/home/tester', 'review-pr', fakeKey)
  assert.deepEqual(env, { ...childEnv(server, '/home/tester', 'review-pr'), OPENROUTER_API_KEY: fakeKey })
  assert.deepEqual(Object.keys(env).sort(), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_KEY_2', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_VALUE_1', 'GIT_CONFIG_VALUE_2', 'HOME', 'OPENROUTER_API_KEY', 'PATH', 'USER'])
  // the server's own value of the variable, and its other names, never reach any child
  assert.equal(childEnv(server, '/home/tester', 'review-pr').OPENROUTER_API_KEY, undefined)
  assert.doesNotMatch(JSON.stringify(env), /sk-or-server-env|sk-ant-x|gho_x|elsewhere/)
})

const streamLines = async (): Promise<string[]> => (await readFile(new URL('./fixtures/hermes-stream.jsonl', import.meta.url), 'utf8')).split('\n').filter((line) => line !== '')

test('the recorded hermes stream folds into the same stream state: a session id from the result, no cost, no denial, the last line kept, and an event type it does not know changes nothing', async () => {
  let state = emptyStream()
  const lines = await streamLines()
  assert.ok(lines.length > 10)
  const types = new Set(lines.map((line) => (JSON.parse(line) as { type: string }).type))
  assert.deepEqual([...types].sort(), ['result', 'system', 'text', 'tool_result', 'tool_use'])
  for (const line of lines.slice(0, -1)) {
    const folded = foldStream(state, line)
    assert.equal(folded.closeStdin, false)
    state = folded.state
  }
  // the init event carries an empty session id, which names nothing
  assert.equal(state.sessionId, null)
  assert.deepEqual(state.denials, [])
  const unknown = foldStream(state, JSON.stringify({ type: 'future_event', payload: { anything: 1 }, session_id: 'not-a-session' }))
  assert.equal(unknown.state.sessionId, null)
  assert.deepEqual({ ...unknown.state, lastEvent: null }, { ...state, lastEvent: null })
  const last = foldStream(unknown.state, lines.at(-1) as string)
  assert.match(last.state.sessionId ?? '', /^local-/)
  assert.equal(last.state.costUsd, null)
  assert.deepEqual(last.state.denials, [])
  assert.equal(last.state.deniedPosts, null)
  assert.match(last.state.lastEvent ?? '', /"type": "result"/)
  // a Claude result keeps meaning what it meant: its session id is its own and is not read here
  assert.equal(foldStream(emptyStream(), JSON.stringify({ type: 'result', session_id: 'claude-own', total_cost_usd: 1 })).state.sessionId, null)
})

test('agent.hermesProfile is lowercase letters and digits, defaults to pitview, and anything else is refused', () => {
  const base = defaultConfig()
  assert.equal(validateConfig({ ...base }).agent.hermesProfile, undefined)
  assert.equal(validateConfig({ ...base, agent: { runner: 'claude', hermesProfile: 'review2' } }).agent.hermesProfile, 'review2')
  for (const bad of ['Pit', 'pit-view', 'pit view', '-p', '../x', '', 7]) {
    assert.throws(() => validateConfig({ ...base, agent: { runner: 'claude', hermesProfile: bad } }), /hermesProfile/, String(bad))
  }
  // hermes is never the default runner: it starts only for a registry entry
  assert.throws(() => validateConfig({ ...base, agent: { runner: 'hermes' } }), /runner/)
})

test('a hermes run is named Hermes wherever the drawer names a run\'s runner', () => {
  assert.deepEqual(runnerLabels, { claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes' })
})

// the fake hermes: replays the recorded stream with an unknown event among its lines, writes the steps, the report, and the result a clean --no-post review writes, and records what it was called with. Its mode is a file in HOME
const fakeHermes = (key: string): string => `
const fs = require('node:fs')
const path = require('node:path')
const argv = process.argv.slice(2)
const out = (line) => process.stdout.write(line + '\\n')
const at = () => new Date().toISOString().replace(/\\.\\d{3}Z$/, 'Z')
const mode = fs.readFileSync(path.join(process.env.HOME, 'mode.txt'), 'utf8').trim()
const queryFile = argv[argv.indexOf('--query-file') + 1]
const request = fs.readFileSync(queryFile, 'utf8').trim()
const dir = /--emit-json=(\\S+)/.exec(request)[1]
fs.writeFileSync(path.join(dir, 'fake-call.json'), JSON.stringify({ argv, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), keyIsTheFile: process.env.OPENROUTER_API_KEY === '${key}', request, queryMode: (fs.statSync(queryFile).mode & 0o777) }))
const lines = fs.readFileSync(path.join(process.env.HOME, 'stream.jsonl'), 'utf8').split('\\n').filter((line) => line !== '')
if (mode === 'noresult') {
  out(lines[0])
  process.stderr.write('provider error: auth failed for ' + process.env.OPENROUTER_API_KEY + '\\n')
  process.stderr.write('Error: the model did not answer\\n')
  process.exit(1)
}
const step = (name, state, note = null) => fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ at: at(), step: name, state, note }) + '\\n')
for (const line of lines.slice(0, -1)) out(line)
out(JSON.stringify({ type: 'future_event', detail: 'not in the recorded stream' }))
const number = Number(/^\\/review-pr (\\d+)/.exec(request)[1])
step('resolveBase', 'started'); step('resolveBase', 'done'); step('review', 'started'); step('review', 'done')
step('consolidate', 'skipped', 'no tandem review'); step('writeReport', 'started')
fs.writeFileSync(path.join(process.env.HOME, 'agents', 'output', 'PR-' + number + '.md'), 'Reviewed commit: feat/x @ f00dfac\\n')
step('writeReport', 'done'); step('post', 'skipped', 'run with --no-post')
fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
  schema: 'pit-crew/review-result@1', command: 'review-pr', status: 'done', target: { repo: '${scenario.repo}', pr: number },
  reviewed: { kind: 'commit', sha: 'f00dfacecafebeefdeadbeef0123456789abcdef' }, verdict: 'clean', recommendation: null, findings: [],
  ci: null, fixAttempts: 0, posted: null, notPostedReason: 'noPost', report: '~/agents/output/PR-' + number + '.md', question: null, error: null,
}))
out(lines[lines.length - 1])
`

type Setup = { home: string, launcher: ReturnType<typeof createLauncher>, cache: ReturnType<typeof openCache>, logs: string[], keyPath: string, runDir: (run: Run) => string, mode: (mode: string) => Promise<void>, cleanup: () => Promise<void> }

const setup = async ({ config = {}, key = fakeKey, env = {} }: { config?: Partial<Config>, key?: string | null, env?: Record<string, string> } = {}): Promise<Setup> => {
  const temp = await tempDir()
  const home = await realpath(temp.dir)
  const bin = join(home, 'bin')
  for (const dir of [bin, join(home, 'dev', 'orbit'), join(home, 'agents', 'output'), join(home, 'agents', 'worktrees')]) await mkdir(dir, { recursive: true })
  await writeFile(join(bin, 'hermes.cjs'), fakeHermes(fakeKey))
  await writeFile(join(bin, 'hermes'), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, 'hermes.cjs')}" "$@"\n`)
  await chmod(join(bin, 'hermes'), 0o755)
  await writeFile(join(home, 'stream.jsonl'), await readFile(new URL('./fixtures/hermes-stream.jsonl', import.meta.url)))
  const keyPath = openRouterKeyPath(home)
  if (key !== null) await writeOpenRouterKey(keyPath, key)
  const cache = openCache({ path: ':memory:', clock: { now: () => Date.now() } })
  const logs: string[] = []
  const lineConfig = (): Config => ({ ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit', ...config })
  const launcher = createLauncher({
    cache, gh: createGh(fixtureRunner().runner), git: async () => ok(fakeRemotes(scenario.repo)), spawn: systemSpawn, fs: systemFs, kill: (pid, signal) => process.kill(pid, signal),
    procs: procsFrom(commandRunner('ps')), clock: { now: () => Date.now() }, timers: systemTimers, config: lineConfig, home, stateDir: join(home, '.local', 'state', 'pit-view'),
    env: { PATH: `${bin}:/usr/bin:/bin`, USER: 'tester', LANG: 'en_US.UTF-8', OPENROUTER_API_KEY: 'sk-or-the-servers-own-environment', ...env },
    newSessionId: () => '00000000-0000-4000-8000-0000000000e2', onWatch: () => {}, onChange: () => {}, line: createReviewLine({ config: lineConfig, timers: systemTimers }),
    log: (line) => logs.push(line), pollMs: 50, watchedPollMs: 200, openRouterKeyFile: keyPath,
  })
  const mode = (value: string): Promise<void> => writeFile(join(home, 'mode.txt'), value)
  await mode('ok')
  return {
    home, launcher, cache, logs, keyPath, mode,
    runDir: (run) => join(home, '.local', 'state', 'pit-view', 'runs', String(run.id)),
    cleanup: async () => {
      launcher.close()
      cache.close()
      await temp.cleanup()
    },
  }
}

const request = { repo: scenario.repo, number: 104, command: 'review-pr', args: ['104', '--no-post'], label: 'Review', runner: 'hermes' as const, model: 'kimi-code' }
// the variables the /bin/sh wrapper in front of the fake adds for itself
const shellAdded: ReadonlySet<string> = new Set(['PWD', 'SHLVL', '_', 'OLDPWD', '__CF_USER_TEXT_ENCODING'])
type Call = { argv: string[], cwd: string, envKeys: string[], keyIsTheFile: boolean, request: string, queryMode: number }
const callOf = async (dir: string): Promise<Call> => JSON.parse(await readFile(join(dir, 'fake-call.json'), 'utf8')) as Call

test('a hermes review starts through the launcher on the registry entry named, in the run\'s folder, with its request in the query file, the key in the one variable, and ends done with the result its prompt wrote', async () => {
  const h = await setup()
  try {
    const run = await h.launcher.start(request)
    assert.equal(run.runner, 'hermes')
    assert.equal(run.sessionId, null)
    const final = await h.launcher.settled(run.id)
    assert.equal(final.status, 'done', final.note ?? '')
    const dir = h.runDir(run)
    const call = await callOf(dir)
    assert.deepEqual(call.argv, [
      '-p', 'pitview', 'chat', '--query-file', join(dir, 'prompt.txt'), '--oneshot', '--provider', 'openrouter', '--model', 'moonshotai/kimi-k2.7-code',
      '-t', 'terminal,file', '--max-turns', String(hermesMaxTurns), '--format', 'stream-json',
    ])
    assert.equal(call.request, `/review-pr 104 --no-post --emit-json=${dir}`)
    assert.equal(call.cwd, join(h.home, 'dev', 'orbit'))
    assert.equal(call.keyIsTheFile, true, 'the key in the file reaches the child, not the server\'s own variable')
    assert.deepEqual(call.envKeys.filter((name) => !name.startsWith('GIT_CONFIG') && !shellAdded.has(name)), ['HOME', 'LANG', 'OPENROUTER_API_KEY', 'PATH', 'USER'])
    assert.equal(call.envKeys.filter((name) => name.startsWith('GIT_CONFIG')).length, 7)
    // the stream's session id becomes the row's, with the resume line
    assert.match(final.sessionId ?? '', /^local-/)
    assert.equal(final.resume, `cd ~/dev/orbit && hermes -p pitview chat --resume ${final.sessionId}`)
    // the whole stream, the unknown event included, is kept
    const stream = await readFile(join(dir, 'stream.jsonl'), 'utf8')
    assert.match(stream, /"type":"future_event"/)
    assert.equal(stream.split('\n').filter((line) => line !== '').length, (await streamLines()).length + 1)
    // the unknown event left the steps alone and failed nothing
    assert.deepEqual(final.steps?.map((slot) => [slot.step, slot.state]), [['resolveBase', 'done'], ['review', 'done'], ['consolidate', 'skipped'], ['writeReport', 'done'], ['post', 'skipped']])
    assert.deepEqual(final.models?.roles.map((role) => [role.role, role.id, role.runner, role.provider, role.model]), [['reviewer', 'kimi-code', 'hermes', 'openrouter', 'moonshotai/kimi-k2.7-code']])
  } finally {
    await h.cleanup()
  }
})

test('a hermes review that is asked to post is made --no-post, whoever asked, and its request says so', async () => {
  const h = await setup()
  try {
    const run = await h.launcher.start({ ...request, args: ['104'] })
    assert.deepEqual(run.args, ['104', '--no-post'])
    await h.launcher.settled(run.id)
    assert.equal((await callOf(h.runDir(run))).request, `/review-pr 104 --no-post --emit-json=${h.runDir(run)}`)
    assert.equal(JSON.parse(await readFile(join(h.runDir(run), 'request.json'), 'utf8')).args.includes('--no-post'), true)
  } finally {
    await h.cleanup()
  }
})

test('hermes starts only for a hermes entry in the registry: no model, a model that is not in it, and a Claude or Codex entry are refused before any row exists', async () => {
  const custom = { models: { registry: [{ id: 'mine', runner: 'hermes', provider: 'openrouter', model: 'vendor/model-name' }, { id: 'opus', runner: 'claude', provider: 'anthropic', model: 'opus' }] } } as Partial<Config>
  const h = await setup({ config: custom })
  try {
    for (const model of [undefined, 'ghost', 'opus', 'deepseek-flash', '', 'vendor/model-name']) {
      const { model: _, ...without } = request
      await assert.rejects(h.launcher.start({ ...without, ...(model === undefined ? {} : { model }) }), (error: unknown) => error instanceof LaunchError && error.code === 'hermesModel', String(model))
    }
    assert.deepEqual(h.cache.runsFor(scenario.repo, 104), [])
    // the owner's own entry is used when it names a hermes model
    const run = await h.launcher.start({ ...request, model: 'mine' })
    await h.launcher.settled(run.id)
    assert.equal((await callOf(h.runDir(run))).argv[(await callOf(h.runDir(run))).argv.indexOf('--model') + 1], 'vendor/model-name')
  } finally {
    await h.cleanup()
  }
})

test('a model on a Claude or Codex start is refused, so a registry id never picks a runner by accident', async () => {
  const h = await setup()
  try {
    for (const runner of ['claude', 'codex'] as const) {
      await assert.rejects(h.launcher.start({ ...request, runner }), (error: unknown) => error instanceof LaunchError && error.code === 'hermesModel', runner)
    }
  } finally {
    await h.cleanup()
  }
})

test('the fix session, the update session, and a review in tandem never run under hermes, whoever asks', async () => {
  const h = await setup()
  try {
    const cases: [string, string[], string][] = [['fix-pr', ['104'], 'fixRunner'], ['update-pr', ['104', '--head=f00dfacecafebeefdeadbeef0123456789abcdef'], 'updateRunner'], ['review-pr', ['104', '--tandem'], 'tandemRunner']]
    for (const [command, args, code] of cases) {
      await assert.rejects(h.launcher.start({ ...request, command, args }), (error: unknown) => error instanceof LaunchError && error.code === code, command)
    }
    assert.deepEqual(h.cache.runsFor(scenario.repo, 104), [])
  } finally {
    await h.cleanup()
  }
})

test('a hermes launch with no key file, an empty one, or one with the wrong shape fails with a plain note naming the file and never a key, and spawns nothing', async () => {
  const h = await setup({ key: null })
  try {
    const run = await h.launcher.start(request)
    assert.equal(run.status, 'failed')
    assert.match(run.note ?? '', /^hermesKey: .*~\/\.config\/pit-view\/openrouter\.json/)
    assert.equal(run.pid, null)
    assert.deepEqual(await readdir(h.runDir(run)).then((names) => names.includes('fake-call.json')), false)
    await mkdir(dirname(h.keyPath), { recursive: true })
    await writeFile(h.keyPath, JSON.stringify({ apiKey: '' }), { mode: 0o600 })
    const empty = await h.launcher.start(request)
    assert.match(empty.note ?? '', /^hermesKey: .*openrouter\.json/)
    await writeFile(h.keyPath, JSON.stringify({ apiKey: fakeKey, other: 1 }), { mode: 0o600 })
    const shaped = await h.launcher.start(request)
    assert.match(shaped.note ?? '', /^hermesKey: .*openrouter\.json/)
    assert.doesNotMatch(JSON.stringify([run, empty, shaped, h.logs]), new RegExp(fakeKey))
  } finally {
    await h.cleanup()
  }
})

test('a hermes run that ends with no valid result fails like any run and keeps the tail of its output, with the key taken out of it', async () => {
  const h = await setup()
  try {
    await h.mode('noresult')
    const run = await h.launcher.start(request)
    const final = await h.launcher.settled(run.id)
    assert.equal(final.status, 'failed')
    assert.match(final.note ?? '', /^noResult: no result\.json; exit code 1; last event: /)
    assert.match(final.note ?? '', /stderr: .*Error: the model did not answer/s)
    assert.match(final.note ?? '', /auth failed for \[key\]/)
    assert.doesNotMatch(final.note ?? '', new RegExp(fakeKey))
  } finally {
    await h.cleanup()
  }
})

const walk = async (dir: string): Promise<string[]> => {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await walk(path))
    else found.push(path)
  }
  return found
}

test('a planted key is in no log line, request.json, run row, report, or drawer view, and the key file is the only file under home that holds it', async () => {
  const h = await setup()
  try {
    const run = await h.launcher.start(request)
    const final = await h.launcher.settled(run.id)
    assert.equal(final.status, 'done')
    const planted = new RegExp(fakeKey)
    const request_json = await readFile(join(h.runDir(run), 'request.json'), 'utf8')
    assert.doesNotMatch(request_json, planted)
    assert.doesNotMatch(h.logs.join('\n'), planted)
    assert.doesNotMatch(JSON.stringify(h.cache.getRun(run.id)), planted)
    assert.doesNotMatch(JSON.stringify(runView(final)), planted)
    assert.doesNotMatch(await readFile(join(h.home, 'agents', 'output', 'PR-104.md'), 'utf8'), planted)
    const holders: string[] = []
    for (const path of await walk(h.home)) {
      if (path.endsWith('hermes.cjs')) continue
      if (planted.test(await readFile(path, 'utf8').catch(() => ''))) holders.push(path)
    }
    assert.deepEqual(holders, [h.keyPath])
    assert.equal((await stat(h.keyPath)).mode & 0o777, 0o600)
  } finally {
    await h.cleanup()
  }
})
