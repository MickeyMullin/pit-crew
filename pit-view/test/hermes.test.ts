// test/hermes.test.ts
// the hermes runner (section 8 of DESIGN.md, Launching runs, The hermes runner): its command line and resume line, the stream it prints, the environment its child gets, which models it may start with, and what is refused. The end-to-end tests run the real launcher over a small fake hermes executable on a temp PATH and a recorded stream with invented content, so no model is ever called
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chmod, link, lstat, mkdir, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { openCache } from '../src/cache.ts'
import type { Run } from '../src/cache.ts'
import { defaultConfig, validateConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { commandRunner, createGh } from '../src/github.ts'
import {
  childEnv, claudeInvocation, codexInvocation, createLauncher, createReviewLine, createSweepLauncher, emptyStream, foldStream, hermesInvocation, hermesMaxTurns, LaunchError,
  procsFrom, runners, runView, systemFs, systemSpawn,
} from '../src/launcher.ts'
import type { LauncherFs, LaunchSpec, StartRequest } from '../src/launcher.ts'
import { runnerLabels } from '../public/agent.ts'
import { readReport, reportHash } from '../src/reports.ts'
import { renderMarkdown } from '../src/markdown.ts'
import { keyPrefix, openRouterKeyPath, profileEnvPath } from '../src/openrouter.ts'
import { sweepRequest } from '../src/sweeps.ts'
import { systemTimers } from '../src/poller.ts'
import { scenario } from './fixtures/scenario.ts'
import { fakeRemotes, fixtureRunner, ok, tempDir } from './helpers.ts'

// a recognizable fake key, scanned for everywhere it must never appear
const fakeKey = 'sk-or-v1-PLANTEDfakefakefakefakefakefake9f3a7c'
// the copy in the profile's .env, which differs from the one above in the tests that say so
const otherKey = 'sk-or-v1-PLANTEDstalestalestalestalestale0b1d2e'

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

test('the hermes child environment is exactly the launcher\'s own, as for Claude and Codex, with no key of any kind, whatever the server\'s environment holds', () => {
  const server = { PATH: '/usr/bin', USER: 'tester', OPENROUTER_API_KEY: 'sk-or-server-env', HERMES_HOME: '/elsewhere', ANTHROPIC_API_KEY: 'sk-ant-x', GH_TOKEN: 'gho_x', SSH_AUTH_SOCK: '/s' }
  const env = childEnv(server, '/home/tester', 'review-pr')
  assert.deepEqual(Object.keys(env).sort(), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_KEY_2', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_VALUE_1', 'GIT_CONFIG_VALUE_2', 'HOME', 'PATH', 'USER'])
  assert.doesNotMatch(JSON.stringify(env), /sk-or-server-env|sk-ant-x|gho_x|elsewhere|OPENROUTER/)
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
const fakeHermes = (keys: string[]): string => `
const fs = require('node:fs')
const path = require('node:path')
const argv = process.argv.slice(2)
const out = (line) => process.stdout.write(line + '\\n')
const at = () => new Date().toISOString().replace(/\\.\\d{3}Z$/, 'Z')
const mode = fs.readFileSync(path.join(process.env.HOME, 'mode.txt'), 'utf8').trim()
const queryFile = argv[argv.indexOf('--query-file') + 1]
const request = fs.readFileSync(queryFile, 'utf8').trim()
const dir = /--emit-json=(\\S+)/.exec(request)[1]
fs.writeFileSync(path.join(dir, 'fake-call.json'), JSON.stringify({ argv, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), request, queryMode: (fs.statSync(queryFile).mode & 0o777) }))
const lines = fs.readFileSync(path.join(process.env.HOME, 'stream.jsonl'), 'utf8').split('\\n').filter((line) => line !== '')
const allKeys = ${JSON.stringify(keys)}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
// prints every key on stderr and in a stream event, each split across two writes, into files whose mode it sets to 0640
const leak = () => {
  fs.fchmodSync(1, 0o640)
  fs.fchmodSync(2, 0o640)
  for (const key of allKeys) {
    const half = Math.floor(key.length / 2)
    process.stderr.write('auth failed for ' + key.slice(0, half)); sleep(40); process.stderr.write(key.slice(half) + '\\n')
    process.stdout.write('{"type":"tool","text":"' + key.slice(0, half)); sleep(40); process.stdout.write(key.slice(half) + '"}\\n')
  }
}
if (mode.startsWith('requestlink ')) {
  // 'requestlink <symlink|hardlink>': as soon as it runs, request.json in the run's folder is replaced by a link to outside-key.txt in HOME, and planted.txt says so; then it runs as an ordinary clean review
  const target = path.join(process.env.HOME, 'outside-key.txt')
  const file = path.join(dir, 'request.json')
  fs.rmSync(file, { force: true })
  if (mode.endsWith('symlink')) fs.symlinkSync(target, file)
  else fs.linkSync(target, file)
  fs.writeFileSync(path.join(process.env.HOME, 'planted.txt'), 'yes')
}
if (mode.startsWith('plant ')) {
  // 'plant <name> <symlink|hardlink>': the run's ordinary files, with keys on both logs, and then, as it exits, <name> (or the report) replaced by a link to the file outside-key.txt in HOME
  const [, name, kind] = mode.split(' ')
  leak()
  process.on('exit', () => {
    const target = path.join(process.env.HOME, 'outside-key.txt')
    const file = name === 'report' ? path.join(process.env.HOME, 'agents', 'output', 'PR-104.md') : path.join(dir, name)
    fs.rmSync(file, { force: true })
    if (kind === 'symlink') fs.symlinkSync(target, file)
    else fs.linkSync(target, file)
  })
}
if (mode === 'leakwait') {
  // the test changes the configured profile while this waits
  while (!fs.existsSync(path.join(process.env.HOME, 'go.txt'))) sleep(20)
  leak()
  process.exit(1)
}
if (mode === 'leakhang') {
  leak()
  setInterval(() => {}, 1000)
  return
}
if (mode === 'leakfail') {
  leak()
  process.exit(1)
}
if (mode === 'leakok') leak()
if (mode === 'stepkey' || mode === 'failsession' || mode === 'denials') {
  // 'stepkey': a valid step whose note holds both keys, written while the run is active; 'failsession': the whole recorded stream and no result, so a session to resume exists; 'denials': a clean review whose result event also lists a permission denial
  const number = Number(/^\\/review-pr (\\d+)/.exec(request)[1])
  if (mode === 'stepkey') {
    fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ at: at(), step: 'review', state: 'started', note: 'checking with ' + allKeys.join(' and ') }) + '\\n')
    sleep(600)
  }
  const last = JSON.parse(lines[lines.length - 1])
  if (mode === 'denials') last.permission_denials = [{ tool_name: 'terminal', tool_input: {} }]
  for (const line of lines.slice(0, -1)) out(line)
  out(JSON.stringify(last))
  if (mode === 'failsession') process.exit(1)
  fs.writeFileSync(path.join(process.env.HOME, 'agents', 'output', 'PR-' + number + '.md'), 'Reviewed commit: feat/x @ f00dfac\\n')
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
    schema: 'pit-crew/review-result@1', command: 'review-pr', status: 'done', target: { repo: '${scenario.repo}', pr: number },
    reviewed: { kind: 'commit', sha: 'f00dfacecafebeefdeadbeef0123456789abcdef' }, verdict: 'clean', recommendation: null, findings: [],
    ci: null, fixAttempts: 0, posted: null, notPostedReason: 'noPost', report: '~/agents/output/PR-' + number + '.md', question: null, error: null,
  }))
  process.exit(0)
}
if (mode === 'reportat') {
  // a clean review whose valid result names, as its report, the path in target.txt
  const number = Number(/^\\/review-pr (\\d+)/.exec(request)[1])
  for (const line of lines) out(line)
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
    schema: 'pit-crew/review-result@1', command: 'review-pr', status: 'done', target: { repo: '${scenario.repo}', pr: number },
    reviewed: { kind: 'commit', sha: 'f00dfacecafebeefdeadbeef0123456789abcdef' }, verdict: 'clean', recommendation: null, findings: [],
    ci: null, fixAttempts: 0, posted: null, notPostedReason: 'noPost', report: fs.readFileSync(path.join(process.env.HOME, 'target.txt'), 'utf8').trim(), question: null, error: null,
  }))
  process.exit(0)
}
if (mode === 'namedreport') {
  // a clean review whose report has a key in its own file name and in its content, and whose valid result names it
  const number = Number(/^\\/review-pr (\\d+)/.exec(request)[1])
  for (const line of lines) out(line)
  const named = '~/agents/output/PR-' + number + '-' + allKeys[0] + '.md'
  fs.writeFileSync(path.join(process.env.HOME, 'agents', 'output', 'PR-' + number + '-' + allKeys[0] + '.md'), 'Reviewed commit: feat/x @ f00dfac\\nthe token was ' + allKeys[0] + ' and ' + allKeys[1] + '\\n')
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
    schema: 'pit-crew/review-result@1', command: 'review-pr', status: 'done', target: { repo: '${scenario.repo}', pr: number },
    reviewed: { kind: 'commit', sha: 'f00dfacecafebeefdeadbeef0123456789abcdef' }, verdict: 'clean', recommendation: null, findings: [],
    ci: null, fixAttempts: 0, posted: null, notPostedReason: 'noPost', report: named, question: null, error: null,
  }))
  process.exit(0)
}
if (mode === 'reportkey' || mode === 'sessionkey') {
  // 'reportkey': a clean review whose report holds both keys; 'sessionkey': a clean review whose last stream event names a key as its session
  const number = Number(/^\\/review-pr (\\d+)/.exec(request)[1])
  const last = JSON.parse(lines[lines.length - 1])
  if (mode === 'sessionkey') last.session_id = allKeys[0]
  for (const line of lines.slice(0, -1)) out(line)
  out(JSON.stringify(last))
  fs.writeFileSync(path.join(process.env.HOME, 'agents', 'output', 'PR-' + number + '.md'), 'Reviewed commit: feat/x @ f00dfac\\n' + (mode === 'reportkey' ? 'the token was ' + allKeys[0] + ' and ' + allKeys[1] + '\\n' : ''))
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
    schema: 'pit-crew/review-result@1', command: 'review-pr', status: 'done', target: { repo: '${scenario.repo}', pr: number },
    reviewed: { kind: 'commit', sha: 'f00dfacecafebeefdeadbeef0123456789abcdef' }, verdict: 'clean', recommendation: null, findings: [],
    ci: null, fixAttempts: 0, posted: null, notPostedReason: 'noPost', report: '~/agents/output/PR-' + number + '.md', question: null, error: null,
  }))
  process.exit(0)
}
if (mode === 'noresult') {
  out(lines[0])
  process.stderr.write('provider error: auth failed for ${keys.join(' and ')}\\n')
  process.stderr.write('Error: the model did not answer\\n')
  process.exit(1)
}
if (mode.startsWith('boundary')) {
  // 'boundary <o> <n> <event key> <stderr key>': the stderr text is cut to its last 600 characters inside the stderr key at offset o, and the last stream event is cut to its first 300 inside the event key after n of its characters
  const [o, n, eventKey, errKey] = mode.split(' ').slice(1).map(Number)
  const keys = ${JSON.stringify(keys)}
  const head = '{"type":"tool","text":"'
  out(lines[0])
  out(head + 'p'.repeat(300 - n - head.length) + keys[eventKey] + '"}')
  process.stderr.write('x'.repeat(40) + keys[errKey] + 's'.repeat(600 - keys[errKey].length + o) + '\\n')
  process.exit(1)
}
if (mode.startsWith('result')) {
  // 'result error|summary|nested': a valid result.json with the keys in a string field, in a finding's summary, or in nested fields and an object name
  const [fakeKey, other] = allKeys
  const number = Number(/^\\/review-pr (\\d+)/.exec(request)[1])
  const base = {
    schema: 'pit-crew/review-result@1', command: 'review-pr', status: 'done', target: { repo: '${scenario.repo}', pr: number },
    reviewed: { kind: 'commit', sha: 'f00dfacecafebeefdeadbeef0123456789abcdef' }, verdict: 'clean', recommendation: null, findings: [],
    ci: null, fixAttempts: 0, posted: null, notPostedReason: 'noPost', report: '~/agents/output/PR-' + number + '.md', question: null, error: null,
  }
  const variant = mode.split(' ')[1]
  if (variant === 'error') Object.assign(base, { status: 'failed', report: null, error: 'the provider said: bad key ' + fakeKey + ' and ' + other })
  if (variant === 'summary') base.findings = [{ priority: 'P2', summary: 'a finding that quotes ' + fakeKey + ' and ' + other, files: [] }]
  if (variant === 'nested') base.findings = [{ priority: 'P3', summary: 'plain', files: ['a.ts'], evidence: { lines: [['x', fakeKey]], [other]: other }, [fakeKey]: 1 }]
  fs.writeFileSync(path.join(process.env.HOME, 'agents', 'output', 'PR-' + number + '.md'), 'Reviewed commit: feat/x @ f00dfac\\n')
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(base))
  for (const line of lines) out(line)
  process.exit(0)
}
const step = (name, state, note = null) => mode !== 'nosteps' && fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ at: at(), step: name, state, note }) + '\\n')
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

type Setup = { home: string, launcher: ReturnType<typeof createLauncher>, sweeps: ReturnType<typeof createSweepLauncher>, cache: ReturnType<typeof openCache>, logs: string[], keyPath: string, envPath: string, runDir: (run: Run) => string, mode: (mode: string) => Promise<void>, cleanup: () => Promise<void> }

// key is the copy in openrouter.json and profileKey the one in the profile's .env; each is the same fake key unless it says otherwise, and null leaves the file out
const setup = async ({ config = {}, key = fakeKey, profileKey = fakeKey, env = {}, fs = {} }: { config?: Partial<Config>, key?: string | null, profileKey?: string | null, env?: Record<string, string>, fs?: Partial<LauncherFs> } = {}): Promise<Setup> => {
  const temp = await tempDir()
  const home = await realpath(temp.dir)
  const bin = join(home, 'bin')
  for (const dir of [bin, join(home, 'dev', 'orbit'), join(home, 'agents', 'output'), join(home, 'agents', 'worktrees')]) await mkdir(dir, { recursive: true })
  await writeFile(join(bin, 'hermes.cjs'), fakeHermes([fakeKey, otherKey]))
  await writeFile(join(bin, 'hermes'), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, 'hermes.cjs')}" "$@"\n`)
  await chmod(join(bin, 'hermes'), 0o755)
  await writeFile(join(home, 'stream.jsonl'), await readFile(new URL('./fixtures/hermes-stream.jsonl', import.meta.url)))
  const keyPath = openRouterKeyPath(home)
  const envPath = profileEnvPath(home, 'pitview')
  // planted by hand and long ago, so a write by the launcher shows in the bytes or the modification time
  const plant = async (path: string, text: string | null): Promise<void> => {
    if (text === null) return
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text, { mode: 0o600 })
    await utimes(path, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))
  }
  await plant(keyPath, key === null ? null : `${JSON.stringify({ apiKey: key })}\n`)
  await plant(envPath, profileKey === null ? null : `SOME_OTHER=1\nOPENROUTER_API_KEY=${profileKey}\nGIT_CONFIG_COUNT=3\n`)
  const cache = openCache({ path: ':memory:', clock: { now: () => Date.now() } })
  const logs: string[] = []
  const lineConfig = (): Config => ({ ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit', ...config })
  const options = {
    cache, gh: createGh(fixtureRunner().runner), git: async () => ok(fakeRemotes(scenario.repo)), spawn: systemSpawn, fs: { ...systemFs, ...fs }, kill: (pid: number, signal: NodeJS.Signals | 0) => process.kill(pid, signal),
    procs: procsFrom(commandRunner('ps')), clock: { now: () => Date.now() }, timers: systemTimers, config: lineConfig, home, stateDir: join(home, '.local', 'state', 'pit-view'),
    env: { PATH: `${bin}:/usr/bin:/bin`, USER: 'tester', LANG: 'en_US.UTF-8', OPENROUTER_API_KEY: 'sk-or-the-servers-own-environment', ...env },
    newSessionId: () => '00000000-0000-4000-8000-0000000000e2', onWatch: () => {}, onChange: () => {}, line: createReviewLine({ config: lineConfig, timers: systemTimers }),
    log: (line: string) => logs.push(line), pollMs: 50, watchedPollMs: 200, openRouterKeyFile: keyPath,
  }
  const launcher = createLauncher(options)
  const sweeps = createSweepLauncher(options)
  const mode = (value: string): Promise<void> => writeFile(join(home, 'mode.txt'), value)
  await mode('ok')
  return {
    home, launcher, sweeps, cache, logs, keyPath, envPath, mode,
    runDir: (run) => join(home, '.local', 'state', 'pit-view', 'runs', String(run.id)),
    cleanup: async () => {
      launcher.close()
      sweeps.close()
      cache.close()
      await temp.cleanup()
    },
  }
}

const request = { repo: scenario.repo, number: 104, command: 'review-pr', args: ['104', '--no-post'], label: 'Review', runner: 'hermes' as const, model: 'kimi-code' }
// the variables the /bin/sh wrapper in front of the fake adds for itself
const shellAdded: ReadonlySet<string> = new Set(['PWD', 'SHLVL', '_', 'OLDPWD', '__CF_USER_TEXT_ENCODING'])
type Call = { argv: string[], cwd: string, envKeys: string[], request: string, queryMode: number }
const callOf = async (dir: string): Promise<Call> => JSON.parse(await readFile(join(dir, 'fake-call.json'), 'utf8')) as Call

test('a hermes review starts through the launcher on the registry entry named, in the run\'s folder, with its request in the query file, no key in its environment, and ends done with the result its prompt wrote', async () => {
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
    assert.deepEqual(call.envKeys.filter((name) => !name.startsWith('GIT_CONFIG') && !shellAdded.has(name)), ['HOME', 'LANG', 'PATH', 'USER'], 'the server\'s own OPENROUTER_API_KEY and both files\' keys reach no child')
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

test('a hermes launch never refuses over the key: with no key file, no profile .env, an empty or malformed one, or a mode that is too wide, it starts, ends done, and carries no note', async () => {
  const h = await setup({ key: null, profileKey: null })
  try {
    const none = await h.launcher.start(request)
    assert.equal(none.status, 'running')
    assert.equal((await h.launcher.settled(none.id)).note, null)
    await mkdir(dirname(h.keyPath), { recursive: true })
    await writeFile(h.keyPath, JSON.stringify({ apiKey: '' }), { mode: 0o600 })
    await mkdir(dirname(h.envPath), { recursive: true })
    await writeFile(h.envPath, 'OPENROUTER_API_KEY=\n', { mode: 0o600 })
    const empty = await h.launcher.start(request)
    assert.equal((await h.launcher.settled(empty.id)).note, null)
    await writeFile(h.keyPath, JSON.stringify({ apiKey: fakeKey, other: 1 }), { mode: 0o600 })
    await writeFile(h.envPath, `OPENROUTER_API_KEY=${otherKey}\n`, { mode: 0o644 })
    await chmod(h.envPath, 0o644)
    const shaped = await h.launcher.start(request)
    const final = await h.launcher.settled(shaped.id)
    assert.equal(final.status, 'done', final.note ?? '')
    assert.equal(final.note, null, 'a side that cannot be read makes the comparison unknown, which warns of nothing')
    assert.doesNotMatch(JSON.stringify([none, empty, shaped, h.logs]), new RegExp(`${fakeKey}|${otherKey}`))
  } finally {
    await h.cleanup()
  }
})

test('a hermes launch whose two keys differ starts anyway and says so on the run, naming both files and both 8-character prefixes and no key; in sync, it says nothing', async () => {
  const h = await setup({ profileKey: otherKey })
  try {
    const run = await h.launcher.start(request)
    assert.equal(run.status, 'running')
    const warning = run.note ?? ''
    assert.match(warning, /~\/\.config\/pit-view\/openrouter\.json/)
    assert.match(warning, /~\/\.hermes\/profiles\/pitview\/\.env/)
    assert.ok(warning.includes(keyPrefix(fakeKey)) && warning.includes(keyPrefix(otherKey)), warning)
    assert.doesNotMatch(warning, new RegExp(`${fakeKey}|${otherKey}|${h.home}`))
    const final = await h.launcher.settled(run.id)
    assert.equal(final.status, 'done', final.note ?? '')
    assert.equal(final.note, warning, 'the warning stays on the run that finished')
    assert.equal((await callOf(h.runDir(run))).argv.includes('chat'), true)
    await writeFile(h.envPath, `OPENROUTER_API_KEY=${fakeKey}\n`, { mode: 0o600 })
    const same = await h.launcher.start(request)
    assert.equal(same.note, null)
    assert.equal((await h.launcher.settled(same.id)).note, null)
  } finally {
    await h.cleanup()
  }
})

test('a hermes run that differs and then fails keeps the noResult note as it is, with both keys taken out of its stderr tail', async () => {
  const h = await setup({ profileKey: otherKey })
  try {
    await h.mode('noresult')
    const run = await h.launcher.start(request)
    const final = await h.launcher.settled(run.id)
    assert.equal(final.status, 'failed')
    assert.match(final.note ?? '', /^noResult: no result\.json; exit code 1; last event: /)
    assert.match(final.note ?? '', /auth failed for \[key\] and \[key\]/)
    assert.doesNotMatch(final.note ?? '', new RegExp(`${fakeKey}|${otherKey}`))
  } finally {
    await h.cleanup()
  }
})

test('nothing in a hermes launch writes either key file: bytes and modification times are as planted after a run, a failed run, and a warning run', async () => {
  const h = await setup({ profileKey: otherKey })
  try {
    const before = await Promise.all([h.keyPath, h.envPath].map(async (path) => ({ path, bytes: await readFile(path), mtime: (await stat(path)).mtimeMs, mode: (await stat(path)).mode })))
    for (const mode of ['ok', 'noresult']) {
      await h.mode(mode)
      await h.launcher.settled((await h.launcher.start(request)).id)
    }
    for (const file of before) {
      assert.deepEqual(await readFile(file.path), file.bytes, file.path)
      const after = await stat(file.path)
      assert.equal(after.mtimeMs, file.mtime, file.path)
      assert.equal(after.mode, file.mode, file.path)
    }
    // and no file was made beside them
    assert.deepEqual(await readdir(dirname(h.keyPath)), ['openrouter.json'])
    assert.deepEqual(await readdir(dirname(h.envPath)), ['.env'])
  } finally {
    await h.cleanup()
  }
})

test('a hermes run that ends with no valid result fails like any run and keeps the tail of its output, with both keys taken out of it', async () => {
  const h = await setup()
  try {
    await h.mode('noresult')
    const run = await h.launcher.start(request)
    const final = await h.launcher.settled(run.id)
    assert.equal(final.status, 'failed')
    assert.match(final.note ?? '', /^noResult: no result\.json; exit code 1; last event: /)
    assert.match(final.note ?? '', /stderr: .*Error: the model did not answer/s)
    assert.match(final.note ?? '', /auth failed for \[key\] and sk-or-v1-PLANTEDstalestalestalestalestale0b1d2e/)
    assert.doesNotMatch(final.note ?? '', new RegExp(fakeKey))
  } finally {
    await h.cleanup()
  }
})

// every run of four characters of a key: none may survive anywhere the key is taken out of
const fragmentsOf = (key: string): string[] => Array.from({ length: key.length - 3 }, (_, at) => key.slice(at, at + 4))

for (const [name, profileKey, eventKey, errKey] of [['one key in both', fakeKey, 0, 0], ['two keys that differ, one in each', otherKey, 1, 0], ['two keys that differ, swapped', otherKey, 0, 1]] as const) {
  test(`no fragment of a key survives a cut of the stderr tail or the last stream event, however the cut falls in it (${name})`, async () => {
    const h = await setup({ profileKey })
    try {
      const length = fakeKey.length
      for (const [offset, kept] of [[0, 4], [length - 1, 6], [Math.floor(length / 2), Math.floor(length / 2)], [length - 1, length - 1], [length - 1, 4], [0, length]]) {
        await h.mode(`boundary ${offset} ${kept} ${eventKey} ${errKey}`)
        const run = await h.launcher.start(request)
        const final = await h.launcher.settled(run.id)
        assert.equal(final.status, 'failed')
        const shown = [final.note ?? '', JSON.stringify(runView(final)), h.logs.filter((line) => line.includes(`${run.id}`)).join('\n')]
        for (const text of shown) {
          for (const key of [fakeKey, otherKey]) {
            for (const piece of fragmentsOf(key)) {
              assert.ok(!text.includes(piece), `offset ${offset}, kept ${kept}: ${piece} of a key is in ${text.slice(0, 80)}`)
            }
          }
        }
      }
    } finally {
      await h.cleanup()
    }
  })
}

const walk = async (dir: string): Promise<string[]> => {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await walk(path))
    else found.push(path)
  }
  return found
}

test('planted keys are in no log line, request.json, run row, report, or drawer view, and only the two key files under home hold them; the prefixes of their hashes may appear, the keys never', async () => {
  const h = await setup({ profileKey: otherKey })
  try {
    const run = await h.launcher.start(request)
    const final = await h.launcher.settled(run.id)
    assert.equal(final.status, 'done')
    const planted = new RegExp(`${fakeKey}|${otherKey}`)
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
    assert.deepEqual(holders.sort(), [h.envPath, h.keyPath].sort())
    assert.equal((await stat(h.keyPath)).mode & 0o777, 0o600)
  } finally {
    await h.cleanup()
  }
})

// every start of a review the hermes runner serves carries --no-post, whichever command it is, and the extra-instructions flag stays last
test('every hermes start of review-pr, review-stack, review-dependabot, and the Dependabot sweep carries --no-post, and the Claude and Codex starts of them do not gain it', async () => {
  const stack: StartRequest = { ...request, number: 106, command: 'review-stack', args: ['106'], label: 'Review stack' }
  const dependabot: StartRequest = { ...request, number: 107, command: 'review-dependabot', args: ['107'], label: 'Review' }
  const sweep: StartRequest = { ...sweepRequest(scenario.repo, 'hermes'), model: 'kimi-code' }
  // these runs fail at once, so one may have ended before settled is asked for it, which then refuses it as not running; settled is called and a refusal is read as having ended
  const ended = async (launcher: { settled: (id: number) => Promise<unknown> }, id: number): Promise<void> => {
    await launcher.settled(id).catch((error: unknown) => {
      if (!(error instanceof LaunchError)) throw error
    })
  }
  for (const [name, asked, sweeping] of [['review-pr', { ...request, args: ['104'] } as StartRequest, false], ['review-stack', stack, false], ['review-dependabot', dependabot, false], ['review-dependabot-sweep', sweep, true]] as [string, StartRequest, boolean][]) {
    const h = await setup()
    try {
      await h.mode('noresult')
      const launcher = sweeping ? h.sweeps : h.launcher
      const run = await launcher.start(asked)
      assert.equal(run.args.filter((arg) => arg === '--no-post').length, 1, name)
      assert.equal(run.args.at(-1), '--no-post', name)
      await ended(launcher, run.id)
      const call = await callOf(join(h.home, '.local', 'state', 'pit-view', sweeping ? 'sweeps' : 'runs', String(run.id)))
      assert.match(call.request, / --no-post --emit-json=/, name)
      assert.ok(!call.argv.includes('--no-post'), 'the flag is in the request text, never an argument')
      // the extra-instructions flag stays last
      const flagged = await launcher.start({ ...asked, args: [...asked.args.filter((arg) => arg !== '--no-post'), '--extra-instructions'], number: sweeping ? 0 : asked.number + 1 })
      assert.deepEqual(flagged.args.slice(-2), ['--no-post', '--extra-instructions'], name)
      await ended(launcher, flagged.id)
    } finally {
      await h.cleanup()
    }
  }
  // a Claude or Codex start is passed as it was asked: no flag added
  const h = await setup()
  try {
    for (const runner of ['claude', 'codex'] as const) {
      const { model: _, ...asked } = request
      const run = await h.launcher.start({ ...asked, number: 110, command: 'review-stack', args: ['110'], runner })
      assert.deepEqual(run.args, ['110'], runner)
      try {
        h.launcher.stop(run.id)
      } catch (error) {
        if (!(error instanceof LaunchError)) throw error
      }
      await ended(h.launcher, run.id)
    }
  } finally {
    await h.cleanup()
  }
})

test('the fix session, the update session, and a tandem review stay refused under hermes after the review-only flag is added', async () => {
  const h = await setup()
  try {
    for (const [command, args, code] of [['fix-pr', ['104'], 'fixRunner'], ['update-pr', ['104'], 'updateRunner'], ['review-stack', ['106', '--tandem'], 'tandemRunner']] as const) {
      await assert.rejects(h.launcher.start({ ...request, command, args: [...args] }), (error: unknown) => error instanceof LaunchError && error.code === code, command)
    }
  } finally {
    await h.cleanup()
  }
})

// the least a file may hold of a key: nothing of four characters or more
// except a piece that the recorded stream, which holds no key, or the differing-keys warning has in its own words
const recorded = `${readFileSync(new URL('./fixtures/hermes-stream.jsonl', import.meta.url), 'utf8')} update whichever is stale`
const holdsNoPiece = (text: string, where: string): void => {
  for (const key of [fakeKey, otherKey]) {
    for (const piece of fragmentsOf(key)) assert.ok(recorded.includes(piece) || !text.includes(piece), `${piece} of a key is in ${where}`)
  }
}

for (const mode of ['leakok', 'leakfail']) {
  test(`when a hermes run settles (${mode}), neither stderr.log nor stream.jsonl holds any 4-character piece of either key, though each was printed split across two writes, and their mode and the rest of their text stay`, async () => {
    const h = await setup({ profileKey: otherKey })
    try {
      await h.mode(mode)
      const run = await h.launcher.start(request)
      const final = await h.launcher.settled(run.id)
      assert.equal(final.status, mode === 'leakok' ? 'done' : 'failed')
      const dir = h.runDir(run)
      for (const name of ['stderr.log', 'stream.jsonl']) {
        const text = await readFile(join(dir, name), 'utf8')
        holdsNoPiece(text, name)
        assert.match(text, /\[key\]/, `${name} says where the keys were`)
        assert.equal((await stat(join(dir, name))).mode & 0o777, 0o640, `${name} keeps its mode`)
      }
      assert.match(await readFile(join(dir, 'stderr.log'), 'utf8'), /auth failed for \[key\]/)
      assert.match(await readFile(join(dir, 'stream.jsonl'), 'utf8'), /"type":"tool","text":"\[key\]"/)
      // written through a temp file that is gone, so the folder holds nothing new
      assert.deepEqual((await readdir(dir)).filter((name) => /tmp|\.new|\.part/i.test(name)), [])
      holdsNoPiece(JSON.stringify([final, runView(final), h.logs]).replace(/\\s/g, ' '), 'the row, the drawer, or the log')
    } finally {
      await h.cleanup()
    }
  })
}

test('a stopped hermes run is cleared of its keys in both logs like one that ended by itself', async () => {
  const h = await setup({ profileKey: otherKey })
  try {
    await h.mode('leakhang')
    const run = await h.launcher.start(request)
    for (let waited = 0; waited < 100 && (await readFile(join(h.runDir(run), 'stderr.log'), 'utf8').catch(() => '')).split('\n').length <= 2; waited++) await new Promise((resolve) => setTimeout(resolve, 50))
    h.launcher.stop(run.id)
    await h.launcher.settled(run.id)
    for (const name of ['stderr.log', 'stream.jsonl']) holdsNoPiece(await readFile(join(h.runDir(run), name), 'utf8'), name)
  } finally {
    await h.cleanup()
  }
})

test('a log whose rewrite fails is replaced by a one-line notice, and when even that fails it is removed, so a key is never left in it', async () => {
  let failing: 'rewrite' | 'both' = 'rewrite'
  const h = await setup({
    profileKey: otherKey,
    fs: {
      replaceFile: async () => {
        throw new Error('disk full')
      },
      createFile: async (path, text) => {
        if (failing === 'both' && /stderr\.log$/.test(path)) throw new Error('read-only')
        await systemFs.createFile(path, text)
      },
    },
  })
  try {
    await h.mode('leakfail')
    const first = await h.launcher.start(request)
    await h.launcher.settled(first.id)
    for (const name of ['stderr.log', 'stream.jsonl']) {
      const text = await readFile(join(h.runDir(first), name), 'utf8')
      holdsNoPiece(text, name)
      assert.equal(text.trim().split('\n').length, 1, `${name} is one line`)
      assert.match(text, /key/)
    }
    failing = 'both'
    const second = await h.launcher.start(request)
    await h.launcher.settled(second.id)
    assert.equal((await readdir(h.runDir(second))).includes('stderr.log'), false, 'a log that cannot be rewritten or replaced is removed')
    holdsNoPiece(await readFile(join(h.runDir(second), 'stream.jsonl'), 'utf8'), 'stream.jsonl')
    holdsNoPiece(JSON.stringify([h.cache.getRun(first.id), h.cache.getRun(second.id), h.logs]), 'the rows or the log')
  } finally {
    await h.cleanup()
  }
})

test('a run whose profile setting changes while it runs is still cleared of the key of the profile it started under, in its note, its drawer, its log, and both files', async () => {
  const config = { agent: { ...defaultConfig().agent, runner: 'claude' as const } } as Partial<Config>
  const h = await setup({ config, key: fakeKey, profileKey: otherKey })
  try {
    await h.mode('leakwait')
    const run = await h.launcher.start(request)
    for (let waited = 0; waited < 100 && !(await stat(join(h.runDir(run), 'fake-call.json')).catch(() => null)); waited++) await new Promise((resolve) => setTimeout(resolve, 50))
    // the configured profile moves to one with no .env, so the original profile's key is nowhere the settle looks now
    config.agent = { ...config.agent!, hermesProfile: 'elsewhere' }
    await writeFile(join(h.home, 'go.txt'), 'go')
    const final = await h.launcher.settled(run.id)
    assert.equal(final.status, 'failed')
    holdsNoPiece(JSON.stringify([final, runView(final), h.logs]), 'the note, the drawer, or the log')
    for (const name of ['stderr.log', 'stream.jsonl']) holdsNoPiece(await readFile(join(h.runDir(run), name), 'utf8'), name)
  } finally {
    await h.cleanup()
  }
})

test('the stream alone gives a hermes run its session id, resume line, and last event: with the fake writing no events.jsonl lines the steps stay pending, which is also what a Claude or Codex stream gives, since the steps come from the command\'s own events.jsonl', async () => {
  const h = await setup()
  try {
    await h.mode('nosteps')
    const run = await h.launcher.start(request)
    const final = await h.launcher.settled(run.id)
    assert.equal(final.status, 'done', final.note ?? '')
    assert.match(final.sessionId ?? '', /^local-/)
    assert.equal(final.resume, `cd ~/dev/orbit && hermes -p pitview chat --resume ${final.sessionId}`)
    assert.match(await readFile(join(h.runDir(run), 'stream.jsonl'), 'utf8'), /"type":"future_event"/)
    assert.equal((await readFile(join(h.runDir(run), 'events.jsonl'), 'utf8').catch(() => '')), '')
    assert.deepEqual(runView(final).steps.map((slot) => slot.state), ['pending', 'pending', 'pending', 'pending', 'pending'])
  } finally {
    await h.cleanup()
  }
})

// a Hermes child may put a key into a valid result.json, and the result goes to the judge, the row, the note, and the log
for (const variant of ['error', 'summary', 'nested']) {
  test(`a key a hermes child writes into a valid result.json (${variant}) reaches no note, row, drawer view, log, API answer, or stored result file, whole or in any piece of four characters`, async () => {
    const h = await setup({ profileKey: otherKey })
    try {
      await h.mode(`result ${variant}`)
      const run = await h.launcher.start(request)
      const final = await h.launcher.settled(run.id)
      assert.equal(final.status, variant === 'error' ? 'failed' : 'done', final.note ?? '')
      if (variant === 'error') assert.match(final.note ?? '', /bad key \[key\] and \[key\]/)
      if (variant === 'summary') assert.match(JSON.stringify(final.result), /a finding that quotes \[key\] and \[key\]/)
      holdsNoPiece(JSON.stringify([final, h.cache.getRun(run.id), runView(final), h.logs]).replace(/\s/g, ' '), 'the row, the drawer, or the log')
      holdsNoPiece(await readFile(join(h.runDir(run), 'result.json'), 'utf8'), 'the stored result.json')
    } finally {
      await h.cleanup()
    }
  })
}

// a Hermes child may put a key into the note of a valid events.jsonl step, and the steps are folded into the row and published
test('a key a hermes child writes into a step note reaches no row, steps column, drawer view, log, or stored events.jsonl, whole or in any piece of four characters, during the run and after it', async () => {
  const h = await setup({ profileKey: otherKey })
  try {
    await h.mode('stepkey')
    const run = await h.launcher.start(request)
    // while the run is active: the step is folded from the live file
    let active: Run | null = null
    for (let waited = 0; waited < 60 && active === null; waited++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      const row = h.cache.getRun(run.id)
      if (row?.status === 'running' && (row.steps ?? []).some((slot) => slot.note !== null)) active = row
    }
    assert.ok(active !== null, 'the step was folded while the run was active')
    holdsNoPiece(JSON.stringify([active, runView(active)]), 'the active row or its drawer view')
    const final = await h.launcher.settled(run.id)
    assert.equal(final.status, 'done', final.note ?? '')
    assert.match(JSON.stringify(final.steps), /checking with \[key\] and \[key\]/)
    holdsNoPiece(JSON.stringify([final, h.cache.getRun(run.id), runView(final), h.logs]), 'the row, the steps, the drawer, or the log')
    holdsNoPiece(await readFile(join(h.runDir(run), 'events.jsonl'), 'utf8'), 'the stored events.jsonl')
  } finally {
    await h.cleanup()
  }
})

test('a result a resumed hermes session writes after the run failed is read again with every key cleared, in the stored result, the note, the log, and result.json, and the step notes of events.jsonl are cleared too', async () => {
  const h = await setup({ profileKey: otherKey })
  try {
    await h.mode('failsession')
    const run = await h.launcher.start(request)
    const failed = await h.launcher.settled(run.id)
    assert.equal(failed.status, 'failed')
    assert.notEqual(failed.resume, null)
    const dir = h.runDir(run)
    const number = 104
    await writeFile(join(h.home, 'agents', 'output', `PR-${number}.md`), 'Reviewed commit: feat/x @ f00dfac\n')
    await writeFile(join(dir, 'result.json'), JSON.stringify({
      schema: 'pit-crew/review-result@1', command: 'review-pr', status: 'failed', target: { repo: scenario.repo, pr: number }, reviewed: null, verdict: null, recommendation: null,
      findings: [{ priority: 'P2', summary: `quotes ${fakeKey} and ${otherKey}`, files: [] }], ci: null, fixAttempts: 0, posted: null, notPostedReason: null, report: null, question: null,
      error: `bad key ${fakeKey} and ${otherKey}`,
    }))
    await writeFile(join(dir, 'events.jsonl'), `${JSON.stringify({ at: '2026-01-01T00:00:00Z', step: 'review', state: 'started', note: `with ${fakeKey} and ${otherKey}` })}\n`)
    const read = await h.launcher.reread(run.id)
    assert.match(read.note ?? '', /bad key \[key\] and \[key\]/)
    holdsNoPiece(JSON.stringify([read, h.cache.getRun(run.id), runView(read), h.logs]), 'the row, the drawer, or the log')
    for (const name of ['result.json', 'events.jsonl']) holdsNoPiece(await readFile(join(dir, name), 'utf8'), name)
  } finally {
    await h.cleanup()
  }
})

test('the permission denials of a stream result are ignored for a hermes run, which reports none, and kept for Claude and Codex', async () => {
  const lines = await streamLines()
  const withDenial = JSON.stringify({ ...(JSON.parse(lines.at(-1) as string) as object), permission_denials: [{ tool_name: 'terminal' }] })
  assert.deepEqual(foldStream(emptyStream(), withDenial, 'hermes').state.denials, [])
  assert.equal(foldStream(emptyStream(), withDenial, 'hermes').state.deniedPosts, null)
  for (const runner of ['claude', 'codex']) assert.deepEqual(foldStream(emptyStream(), withDenial, runner).state.denials, ['terminal'], runner)
  assert.deepEqual(foldStream(emptyStream(), withDenial).state.denials, ['terminal'])
  const h = await setup()
  try {
    await h.mode('denials')
    const run = await h.launcher.start(request)
    const final = await h.launcher.settled(run.id)
    assert.equal(final.status, 'done', final.note ?? '')
    assert.equal(final.note, null)
  } finally {
    await h.cleanup()
  }
})

test('a key a hermes child writes into the report its valid result names is taken out of the file before the report is hashed, at settle and on a re-read, so the report route, the row, the log, and the drawer hold no piece of it, and the file keeps its mode', async () => {
  const h = await setup({ profileKey: otherKey })
  try {
    await h.mode('reportkey')
    const run = await h.launcher.start(request)
    const final = await h.launcher.settled(run.id)
    assert.equal(final.status, 'done', final.note ?? '')
    const file = join(h.home, 'agents', 'output', 'PR-104.md')
    await chmod(file, 0o640)
    const cleared = await readFile(file, 'utf8')
    holdsNoPiece(cleared, 'the report')
    assert.match(cleared, /the token was \[key\] and \[key\]/)
    assert.equal(final.reportHash, reportHash(cleared), 'the stored hash is that of the cleared text')
    holdsNoPiece(JSON.stringify([final, h.cache.getRun(run.id), runView(final), h.logs]), 'the row, the drawer, or the log')
    // the report route answers from the same file
    const served = await readReport(join(h.home, 'agents', 'output'), 'PR-104.md')
    holdsNoPiece(JSON.stringify([served.raw, renderMarkdown(served.raw)]), 'the report route')
    // a re-read of a failed run whose resumed session wrote a report with keys
    await h.mode('failsession')
    const second = await h.launcher.start(request)
    const failed = await h.launcher.settled(second.id)
    assert.equal(failed.status, 'failed')
    const dir = h.runDir(second)
    await writeFile(file, `Reviewed commit: feat/x @ f00dfac\nagain ${fakeKey} and ${otherKey}\n`, { mode: 0o640 })
    await writeFile(join(dir, 'result.json'), JSON.stringify({
      schema: 'pit-crew/review-result@1', command: 'review-pr', status: 'done', target: { repo: scenario.repo, pr: 104 }, reviewed: { kind: 'commit', sha: 'f00dfacecafebeefdeadbeef0123456789abcdef' },
      verdict: 'clean', recommendation: null, findings: [], ci: null, fixAttempts: 0, posted: null, notPostedReason: 'noPost', report: '~/agents/output/PR-104.md', question: null, error: null,
    }))
    const read = await h.launcher.reread(second.id)
    assert.equal(read.status, 'done', read.note ?? '')
    const again = await readFile(file, 'utf8')
    holdsNoPiece(again, 'the re-read report')
    assert.equal(read.reportHash, reportHash(again))
    assert.equal((await stat(file)).mode & 0o777, 0o640)
    holdsNoPiece(JSON.stringify([read, runView(read), h.logs]), 'the re-read row, drawer, or log')
  } finally {
    await h.cleanup()
  }
})

test('the clearing of a report touches only a regular file inside the reports folder: a result that names a key file, a path that climbs out by .., or a symbolic link to a key file leaves that file byte for byte and in its modification time, at settle and on a re-read', async () => {
  const h = await setup({ profileKey: otherKey })
  try {
    const outside = join(h.home, 'agents', 'outside.md')
    await writeFile(outside, `held ${fakeKey} and ${otherKey}\n`)
    await utimes(outside, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))
    const link = join(h.home, 'agents', 'output', 'link.md')
    await symlink(h.keyPath, link)
    const targets = [h.keyPath, h.envPath, join(h.home, 'agents', 'output', '..', 'outside.md'), link]
    const watched = [h.keyPath, h.envPath, outside]
    const before = await Promise.all(watched.map(async (path) => ({ text: await readFile(path, 'utf8'), mtime: (await stat(path)).mtimeMs })))
    const same = async (label: string): Promise<void> => {
      const after = await Promise.all(watched.map(async (path) => ({ text: await readFile(path, 'utf8'), mtime: (await stat(path)).mtimeMs })))
      assert.deepEqual(after, before, label)
    }
    for (const target of targets) {
      await writeFile(join(h.home, 'target.txt'), target)
      await h.mode('reportat')
      const run = await h.launcher.start(request)
      await h.launcher.settled(run.id)
      await same(`after settle, naming ${target}`)
      await h.mode('failsession')
      const second = await h.launcher.start(request)
      const failed = await h.launcher.settled(second.id)
      assert.equal(failed.status, 'failed')
      await writeFile(join(h.runDir(second), 'result.json'), JSON.stringify({
        schema: 'pit-crew/review-result@1', command: 'review-pr', status: 'done', target: { repo: scenario.repo, pr: 104 }, reviewed: { kind: 'commit', sha: 'f00dfacecafebeefdeadbeef0123456789abcdef' },
        verdict: 'clean', recommendation: null, findings: [], ci: null, fixAttempts: 0, posted: null, notPostedReason: 'noPost', report: target, question: null, error: null,
      }))
      await h.launcher.reread(second.id)
      await same(`after a re-read, naming ${target}`)
    }
  } finally {
    await h.cleanup()
  }
})

test('a report that cannot be rewritten is replaced by a one-line notice, and one that cannot be written is removed, so a key is never left in it', async () => {
  let failing: 'rewrite' | 'both' = 'rewrite'
  const h = await setup({
    profileKey: otherKey,
    fs: {
      replaceFile: async () => {
        throw new Error('disk full')
      },
      createFile: async (path, text) => {
        if (failing === 'both' && /PR-104\.md$/.test(path)) throw new Error('read-only')
        await systemFs.createFile(path, text)
      },
    },
  })
  try {
    await h.mode('reportkey')
    const first = await h.launcher.start(request)
    await h.launcher.settled(first.id)
    const file = join(h.home, 'agents', 'output', 'PR-104.md')
    const text = await readFile(file, 'utf8')
    holdsNoPiece(text, 'the report')
    assert.equal(text.trim().split('\n').length, 1)
    failing = 'both'
    const second = await h.launcher.start(request)
    const done = await h.launcher.settled(second.id)
    assert.equal(await readFile(file, 'utf8').catch(() => null), null, 'a report that cannot be rewritten or replaced is removed')
    holdsNoPiece(JSON.stringify([done, h.logs]), 'the row or the log')
  } finally {
    await h.cleanup()
  }
})

test('a session id that is a key is not stored and no resume line is built for it, while a normal session id still is', async () => {
  const h = await setup({ profileKey: otherKey })
  try {
    await h.mode('sessionkey')
    const run = await h.launcher.start(request)
    const final = await h.launcher.settled(run.id)
    assert.equal(final.sessionId, null)
    assert.equal(final.resume, null)
    holdsNoPiece(JSON.stringify([final, h.cache.getRun(run.id), runView(final), h.logs]), 'the row, the resume field, the drawer, or the log')
    await h.mode('ok')
    const normal = await h.launcher.start(request)
    const done = await h.launcher.settled(normal.id)
    assert.match(done.sessionId ?? '', /^local-/)
    assert.match(done.resume ?? '', /hermes -p pitview chat --resume local-/)
  } finally {
    await h.cleanup()
  }
})

// a Claude run's fake, for the tests that show the Claude path unchanged: it reads the one request from stdin, writes a clean result naming the path in target.txt, and exits when stdin closes
const fakeClaudeNaming = `
const fs = require('node:fs')
const path = require('node:path')
let buffer = ''
let done = false
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const end = buffer.indexOf('\\n')
  if (done || end < 0) return
  done = true
  const request = JSON.parse(buffer.slice(0, end)).message.content
  const dir = /--emit-json=(\\S+)/.exec(request)[1]
  const number = Number(/^[/$]review-pr (\\d+)/.exec(request)[1])
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: process.argv[process.argv.indexOf('--session-id') + 1] }) + '\\n')
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
    schema: 'pit-crew/review-result@1', command: 'review-pr', status: 'done', target: { repo: '${scenario.repo}', pr: number },
    reviewed: { kind: 'commit', sha: 'f00dfacecafebeefdeadbeef0123456789abcdef' }, verdict: 'clean', recommendation: null, findings: [],
    ci: null, fixAttempts: 0, posted: null, notPostedReason: 'noPost', report: fs.readFileSync(path.join(process.env.HOME, 'target.txt'), 'utf8').trim(), question: null, error: null,
  }))
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1, permission_denials: [] }) + '\\n')
})
process.stdin.on('end', () => process.exit(0))
`

test('a hermes result that names a path outside the reports folder (a key file, the profile .env, a path that climbs out, or a symbolic link) is neither read nor hashed, so its report hash is null, while a Claude run naming the same path is hashed as before', async () => {
  const h = await setup({ profileKey: otherKey })
  try {
    await writeFile(join(h.home, 'bin', 'claude.cjs'), fakeClaudeNaming)
    await writeFile(join(h.home, 'bin', 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${join(h.home, 'bin', 'claude.cjs')}" "$@"\n`)
    await chmod(join(h.home, 'bin', 'claude'), 0o755)
    const outside = join(h.home, 'agents', 'outside.md')
    await writeFile(outside, `held ${fakeKey}\n`)
    const link = join(h.home, 'agents', 'output', 'link.md')
    await symlink(h.keyPath, link)
    for (const target of [h.keyPath, h.envPath, join(h.home, 'agents', 'output', '..', 'outside.md'), link]) {
      await writeFile(join(h.home, 'target.txt'), target)
      const text = await readFile(target, 'utf8')
      await h.mode('reportat')
      const run = await h.launcher.start(request)
      const final = await h.launcher.settled(run.id)
      assert.equal(final.reportHash, null, `a hermes run naming ${target} stores no hash`)
      assert.equal(h.cache.getRun(run.id)?.reportHash, null)
      assert.notEqual(final.reportHash, reportHash(text))
      const claude = await h.launcher.start({ repo: scenario.repo, number: 104, command: 'review-pr', args: ['104', '--no-post'], label: 'Review' })
      const claudeFinal = await h.launcher.settled(claude.id)
      assert.equal(claudeFinal.runner, 'claude')
      assert.equal(claudeFinal.reportHash, reportHash(text), `a Claude run naming ${target} is hashed as before`)
    }
  } finally {
    await h.cleanup()
  }
})

test('a rewrite never writes through the old predictable temporary name: planted as a symbolic link to a file outside, it leaves that file byte for byte and in its modification time, while the key is still taken out of the real report, stderr.log, and stream.jsonl, and no temporary file is left', async () => {
  const h = await setup({ profileKey: otherKey })
  try {
    const outside = join(h.home, 'agents', 'outside.md')
    await writeFile(outside, 'not a report\n')
    await utimes(outside, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))
    const before = { text: await readFile(outside, 'utf8'), mtime: (await stat(outside)).mtimeMs, mode: (await stat(outside)).mode }
    const runDir = join(h.home, '.local', 'state', 'pit-view', 'runs', '1')
    await mkdir(runDir, { recursive: true })
    const planted = [join(h.home, 'agents', 'output', `PR-104.md.${process.pid}.tmp`), join(runDir, `stderr.log.${process.pid}.tmp`), join(runDir, `stream.jsonl.${process.pid}.tmp`)]
    for (const name of planted) await symlink(outside, name)
    await h.mode('leakok')
    const run = await h.launcher.start(request)
    assert.equal(run.id, 1)
    await h.launcher.settled(run.id)
    for (const name of ['stderr.log', 'stream.jsonl']) {
      const text = await readFile(join(runDir, name), 'utf8')
      holdsNoPiece(text, name)
      assert.match(text, /\[key\]/)
    }
    await h.mode('reportkey')
    const second = await h.launcher.start(request)
    await h.launcher.settled(second.id)
    const report = join(h.home, 'agents', 'output', 'PR-104.md')
    holdsNoPiece(await readFile(report, 'utf8'), 'the report')
    assert.match(await readFile(report, 'utf8'), /\[key\]/)
    assert.equal((await lstat(report)).isFile(), true, 'the report is a regular file, not a link')
    const after = { text: await readFile(outside, 'utf8'), mtime: (await stat(outside)).mtimeMs, mode: (await stat(outside)).mode }
    assert.deepEqual(after, before, 'the outside file is untouched')
    // only the links the test planted are left; the launcher's own temporary files are gone
    const left = [...(await readdir(runDir)), ...(await readdir(join(h.home, 'agents', 'output')))].filter((name) => name.endsWith('.tmp')).sort()
    assert.deepEqual(left, planted.map((name) => basename(name)).sort())
  } finally {
    await h.cleanup()
  }
})

test('a key in the file name of the report a valid result names does not hide the report from the clearing: its content is cleared, the stored path shows [key], and the run has no report hash, at settle and on a re-read', async () => {
  const h = await setup({ profileKey: otherKey })
  try {
    await h.mode('namedreport')
    const run = await h.launcher.start(request)
    const final = await h.launcher.settled(run.id)
    assert.equal(final.status, 'done', final.note ?? '')
    const folder = join(h.home, 'agents', 'output')
    const file = join(folder, `PR-104-${fakeKey}.md`)
    const cleared = await readFile(file, 'utf8')
    holdsNoPiece(cleared, 'the report content')
    assert.match(cleared, /the token was \[key\] and \[key\]/)
    assert.equal(final.reportHash, null, 'the stored path does not name the file, so there is no hash')
    assert.equal((final.result as { report?: string } | null)?.report, '~/agents/output/PR-104-[key].md')
    holdsNoPiece(JSON.stringify([final, h.cache.getRun(run.id), runView(final), h.logs]), 'the row, the drawer, or the log')
    // a re-read of a failed run whose resumed session writes such a report
    await h.mode('failsession')
    const second = await h.launcher.start(request)
    assert.equal((await h.launcher.settled(second.id)).status, 'failed')
    const again = join(folder, `PR-104-${otherKey}.md`)
    await writeFile(again, `Reviewed commit: feat/x @ f00dfac\nagain ${fakeKey} and ${otherKey}\n`)
    await writeFile(join(h.runDir(second), 'result.json'), JSON.stringify({
      schema: 'pit-crew/review-result@1', command: 'review-pr', status: 'done', target: { repo: scenario.repo, pr: 104 }, reviewed: { kind: 'commit', sha: 'f00dfacecafebeefdeadbeef0123456789abcdef' },
      verdict: 'clean', recommendation: null, findings: [], ci: null, fixAttempts: 0, posted: null, notPostedReason: 'noPost', report: `~/agents/output/PR-104-${otherKey}.md`, question: null, error: null,
    }))
    const read = await h.launcher.reread(second.id)
    assert.equal(read.status, 'done', read.note ?? '')
    holdsNoPiece(await readFile(again, 'utf8'), 'the re-read report content')
    assert.equal(read.reportHash, null)
    assert.equal((read.result as { report?: string } | null)?.report, '~/agents/output/PR-104-[key].md')
    holdsNoPiece(JSON.stringify([read, runView(read), h.logs]), 'the re-read row, drawer, or log')
  } finally {
    await h.cleanup()
  }
})

test('a re-read that is refused because result.json has not changed still takes a key out of the report the result names', async () => {
  const h = await setup({ profileKey: otherKey })
  try {
    await h.mode('failsession')
    const run = await h.launcher.start(request)
    const failed = await h.launcher.settled(run.id)
    assert.equal(failed.status, 'failed')
    const dir = h.runDir(run)
    const file = join(h.home, 'agents', 'output', 'PR-104.md')
    await writeFile(file, 'Reviewed commit: feat/x @ f00dfac\n')
    await writeFile(join(dir, 'result.json'), JSON.stringify({
      schema: 'pit-crew/review-result@1', command: 'review-pr', status: 'failed', target: { repo: scenario.repo, pr: 104 }, reviewed: null, verdict: null, recommendation: null,
      findings: [], ci: null, fixAttempts: 0, posted: null, notPostedReason: null, report: '~/agents/output/PR-104.md', question: null, error: 'it could not finish',
    }))
    // the first re-read records this failed result; the second finds it unchanged
    await h.launcher.reread(run.id).catch(() => {})
    await writeFile(file, `Reviewed commit: feat/x @ f00dfac\nleft behind ${fakeKey} and ${otherKey}\n`)
    await assert.rejects(h.launcher.reread(run.id), /has not changed since the run settled/)
    const text = await readFile(file, 'utf8')
    holdsNoPiece(text, 'the report')
    assert.match(text, /left behind \[key\] and \[key\]/)
  } finally {
    await h.cleanup()
  }
})

// a fake key file outside every folder Pit View keeps, with both fake keys in it, planted long ago so any write or read-for-write shows in its bytes, its modification time, or its link count
const plantOutside = async (home: string): Promise<string> => {
  const outside = join(home, 'outside-key.txt')
  await writeFile(outside, `{"apiKey":"${fakeKey}"} ${otherKey}\n`, { mode: 0o600 })
  await utimes(outside, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))
  return outside
}
const fingerprint = async (path: string): Promise<{ text: string, mtime: number, mode: number }> => ({ text: await readFile(path, 'utf8'), mtime: (await stat(path)).mtimeMs, mode: (await stat(path)).mode })

// what is left at a planted name: nothing, or a regular file with one link, and never the link itself
const notALink = async (path: string, label: string): Promise<void> => {
  const info = await lstat(path).catch(() => null)
  if (info !== null) assert.ok(info.isFile() && info.nlink === 1, `${label} is still a link`)
}

for (const rewrite of ['works', 'fails'] as const) {
  for (const kind of ['symlink', 'hardlink']) {
    for (const name of ['result.json', 'events.jsonl', 'stderr.log', 'stream.jsonl', 'report']) {
      test(`a child that makes ${name} a ${kind} to a file outside is never followed at settle, with the rewrite ${rewrite === 'works' ? 'working' : 'failing'}: the outside file is untouched, no key stays in anything Pit View keeps, and the link is gone or a regular notice`, async () => {
        const h = await setup({ profileKey: otherKey, fs: rewrite === 'fails' ? { replaceFile: async () => { throw new Error('disk full') } } : {} })
        try {
          const outside = await plantOutside(h.home)
          const before = await fingerprint(outside)
          const linksBefore = (await stat(outside)).nlink
          await h.mode(`plant ${name} ${kind}`)
          const run = await h.launcher.start(request)
          const final = await h.launcher.settled(run.id)
          assert.deepEqual(await fingerprint(outside), before, 'the outside file is as planted')
          // a link left in a run's folder is removed, which gives back the link the child made; a hard link the child made to the report stays, since that name is no report
          assert.equal((await stat(outside)).nlink, linksBefore + (kind === 'hardlink' && name === 'report' ? 1 : 0), 'its link count is as expected')
          const dir = h.runDir(run)
          if (name === 'report') {
            // a report that is a link or has another link is no report in the folder: it is neither read, hashed, nor changed
            assert.equal(final.reportHash, null)
          } else {
            await notALink(join(dir, name), name)
          }
          for (const file of (await readdir(dir)).filter((entry) => entry !== name || name === 'report')) {
            const info = await lstat(join(dir, file))
            if (info.isFile() && info.nlink === 1) holdsNoPiece(await readFile(join(dir, file), 'utf8'), file)
          }
          holdsNoPiece(JSON.stringify([final, runView(final), h.cache.getRun(run.id), h.logs]), 'the row, the drawer, or the log')
          assert.deepEqual((await readdir(dir)).filter((entry) => /tmp/.test(entry)), [], 'no temporary file is left')
        } finally {
          await h.cleanup()
        }
      })
    }
  }
}

for (const rewrite of ['works', 'fails'] as const) {
  for (const kind of ['symlink', 'hardlink']) {
    for (const name of ['result.json', 'events.jsonl', 'report']) {
      test(`a child that makes ${name} a ${kind} to a file outside, after the run failed, is never followed by a re-read, with the rewrite ${rewrite === 'works' ? 'working' : 'failing'}`, async () => {
        const failing: { replace: boolean } = { replace: false }
        const h = await setup({ profileKey: otherKey, fs: { replaceFile: async (path, text) => {
          if (failing.replace) throw new Error('disk full')
          await systemFs.replaceFile(path, text)
        } } })
        try {
          await h.mode('failsession')
          const run = await h.launcher.start(request)
          const failed = await h.launcher.settled(run.id)
          assert.equal(failed.status, 'failed')
          const dir = h.runDir(run)
          const outside = await plantOutside(h.home)
          const before = await fingerprint(outside)
          const report = join(h.home, 'agents', 'output', 'PR-104.md')
          await writeFile(report, `Reviewed commit: feat/x @ f00dfac\n${fakeKey}\n`)
          await writeFile(join(dir, 'result.json'), JSON.stringify({
            schema: 'pit-crew/review-result@1', command: 'review-pr', status: 'done', target: { repo: scenario.repo, pr: 104 }, reviewed: { kind: 'commit', sha: 'f00dfacecafebeefdeadbeef0123456789abcdef' },
            verdict: 'clean', recommendation: null, findings: [], ci: null, fixAttempts: 0, posted: null, notPostedReason: 'noPost', report: '~/agents/output/PR-104.md', question: null, error: null,
          }))
          await writeFile(join(dir, 'events.jsonl'), `${JSON.stringify({ at: '2026-01-01T00:00:00Z', step: 'review', state: 'started', note: `with ${fakeKey}` })}\n`)
          failing.replace = rewrite === 'fails'
          const planted = name === 'report' ? report : join(dir, name)
          await rm(planted)
          await (kind === 'symlink' ? symlink(outside, planted) : link(outside, planted))
          await h.launcher.reread(run.id).catch(() => {})
          assert.deepEqual(await fingerprint(outside), before, 'the outside file is as planted')
          if (name !== 'report') await notALink(planted, name)
          holdsNoPiece(JSON.stringify([h.cache.getRun(run.id), h.logs]), 'the row or the log')
          for (const file of ['result.json', 'events.jsonl']) {
            const info = await lstat(join(dir, file)).catch(() => null)
            if (info?.isFile() === true && info.nlink === 1) holdsNoPiece(await readFile(join(dir, file), 'utf8'), file)
          }
        } finally {
          await h.cleanup()
        }
      })
    }
  }
}

test('a hard link inside the reports folder to a file outside it is no report: it is not cleared, not rewritten, not read, and has a null hash, exactly like a path outside the folder', async () => {
  const h = await setup({ profileKey: otherKey })
  try {
    const outside = await plantOutside(h.home)
    const before = await fingerprint(outside)
    const inside = join(h.home, 'agents', 'output', 'hard.md')
    await link(outside, inside)
    await writeFile(join(h.home, 'target.txt'), inside)
    await h.mode('reportat')
    const run = await h.launcher.start(request)
    const final = await h.launcher.settled(run.id)
    assert.equal(final.reportHash, null)
    assert.deepEqual(await fingerprint(outside), before)
    assert.deepEqual(await fingerprint(inside), before, 'the in-folder name is the same file and is untouched')
    assert.equal((await stat(outside)).nlink, 2)
  } finally {
    await h.cleanup()
  }
})

// every write of request.json after the first (the ones after the spawn) waits until the fake has planted its link, so the child's replacement is certain to come first; it wraps both the ordinary write and the link-safe one
const afterPlanting = (home: () => string): Partial<LauncherFs> => {
  let writes = 0
  const wait = async (): Promise<void> => {
    writes += 1
    if (writes < 2) return
    for (let tries = 0; tries < 400 && !await systemFs.exists(join(home(), 'planted.txt')); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const gated = (name: 'writeFile' | 'writeOwn') => async (path: string, text: string): Promise<void> => {
    if (path.endsWith('request.json')) await wait()
    await (systemFs[name] as (path: string, text: string) => Promise<void>)(path, text)
  }
  return { writeFile: gated('writeFile'), writeOwn: gated('writeOwn') } as Partial<LauncherFs>
}

for (const kind of ['symlink', 'hardlink']) {
  test(`a child that makes request.json a ${kind} to a fake key file before the launcher's second write never has that file overwritten: the file is byte for byte and in its modification time unchanged, and request.json is a regular file holding what Pit View wrote`, async () => {
    let where = ''
    const h = await setup({ profileKey: otherKey, fs: afterPlanting(() => where) })
    where = h.home
    try {
      const outside = await plantOutside(h.home)
      const before = await fingerprint(outside)
      await h.mode(`requestlink ${kind}`)
      const run = await h.launcher.start(request)
      const final = await h.launcher.settled(run.id)
      assert.equal(final.status, 'done', final.note ?? '')
      assert.deepEqual(await fingerprint(outside), before, 'the fake key file is as planted')
      assert.equal((await stat(outside)).nlink, 1, 'no link to it is left')
      const file = join(h.runDir(run), 'request.json')
      const info = await lstat(file)
      assert.ok(info.isFile() && info.nlink === 1, 'request.json is a regular file with one link')
      const text = await readFile(file, 'utf8')
      const written = JSON.parse(text) as { runner: string, pid: number }
      assert.equal(written.runner, 'hermes')
      assert.equal(typeof written.pid, 'number')
      assert.doesNotMatch(text, new RegExp(`${fakeKey}|${otherKey}`))
    } finally {
      await h.cleanup()
    }
  })
}

test('a normal run still leaves request.json a regular file with one link that holds the pid and the start time', async () => {
  const h = await setup()
  try {
    const run = await h.launcher.start(request)
    await h.launcher.settled(run.id)
    const file = join(h.runDir(run), 'request.json')
    const info = await lstat(file)
    assert.ok(info.isFile() && info.nlink === 1)
    const written = JSON.parse(await readFile(file, 'utf8')) as { pid: number | null, pidStartedAt: string | null }
    assert.equal(typeof written.pid, 'number')
    assert.ok(written.pidStartedAt !== null)
  } finally {
    await h.cleanup()
  }
})

test('a symbolic link, a hard link, or a non-regular file in a run\'s folder reads as absent for the live read, and a regular file is read', async () => {
  const temp = await tempDir()
  try {
    const outside = join(temp.dir, 'outside.txt')
    await writeFile(outside, 'secret line\n')
    await symlink(outside, join(temp.dir, 'sym'))
    await link(outside, join(temp.dir, 'hard'))
    await writeFile(join(temp.dir, 'plain'), 'plain line\n')
    await mkdir(join(temp.dir, 'folder'))
    assert.equal((await systemFs.readFrom(join(temp.dir, 'sym'), 0)).length, 0)
    assert.equal((await systemFs.readFrom(join(temp.dir, 'hard'), 0)).length, 0)
    assert.equal((await systemFs.readFrom(join(temp.dir, 'plain'), 0)).toString(), 'plain line\n')
    assert.deepEqual(await systemFs.readOwn(join(temp.dir, 'sym')), { kind: 'unsafe' })
    assert.deepEqual(await systemFs.readOwn(join(temp.dir, 'hard')), { kind: 'unsafe' })
    assert.deepEqual(await systemFs.readOwn(join(temp.dir, 'folder')), { kind: 'unsafe' })
    assert.deepEqual(await systemFs.readOwn(join(temp.dir, 'none')), { kind: 'absent' })
    assert.deepEqual(await systemFs.readOwn(join(temp.dir, 'plain')), { kind: 'file', text: 'plain line\n' })
    await assert.rejects(systemFs.createFile(join(temp.dir, 'sym'), 'x'), /EEXIST/)
    assert.equal(await readFile(outside, 'utf8'), 'secret line\n')
  } finally {
    await temp.cleanup()
  }
})
