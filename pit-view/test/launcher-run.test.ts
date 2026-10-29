// test/launcher-run.test.ts
// the launcher end to end with real processes: small fake claude and codex executables on a
// temp PATH read their request, append events, print stream lines and write result.json, so no
// model is ever called and no real runner, gh or review ever starts
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { openCache } from '../src/cache.ts'
import type { Run } from '../src/cache.ts'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { commandRunner, createGh } from '../src/github.ts'
import { claudeInvocation, codexInvocation, createLauncher, procsFrom, systemFs, systemSpawn } from '../src/launcher.ts'
import { systemTimers } from '../src/poller.ts'
import { scenario } from './fixtures/scenario.ts'
import { fakeRemotes, fixtureRunner, ok, tempDir } from './helpers.ts'

// shared by both fakes: the steps, the report and the result a clean --no-post self-review writes
const common = `
const fs = require('node:fs')
const path = require('node:path')
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
const at = () => new Date().toISOString().replace(/\\.\\d{3}Z$/, 'Z')
const review = (request) => {
  const dir = /--emit-json=(\\S+)/.exec(request)[1]
  const number = Number(/^[/$]review-pr (\\d+)/.exec(request)[1])
  const step = (name, state, note = null) => fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ at: at(), step: name, state, note }) + '\\n')
  fs.writeFileSync(path.join(dir, 'fake-call.json'), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, request }))
  step('resolveBase', 'started')
  step('resolveBase', 'done')
  step('review', 'started')
  step('review', 'done')
  step('consolidate', 'skipped', 'no tandem review')
  step('writeReport', 'started')
  const report = path.join(process.env.HOME, 'agents', 'output', 'PR-' + number + '.md')
  fs.writeFileSync(report, 'Reviewed commit: \`feat/x\` @ \`f00dfac\`\\n')
  step('writeReport', 'done')
  step('post', 'skipped', 'run with --no-post')
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
    schema: 'pit-crew/review-result@1', command: 'review-pr', status: 'done', target: { repo: '${scenario.repo}', pr: number },
    reviewed: { kind: 'commit', sha: 'f00dfacecafebeefdeadbeef0123456789abcdef' }, verdict: 'clean', recommendation: null, findings: [],
    ci: null, fixAttempts: 0, posted: null, notPostedReason: 'noPost', report: '~/agents/output/PR-' + number + '.md', question: null, error: null,
  }))
  return dir
}
`

const fakeClaude = `${common}
let buffer = ''
let dir = null
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const end = buffer.indexOf('\\n')
  if (dir !== null || end < 0) return
  const message = JSON.parse(buffer.slice(0, end))
  out({ type: 'system', subtype: 'hook_response' })
  out({ type: 'system', subtype: 'init', session_id: process.argv[process.argv.indexOf('--session-id') + 1] })
  dir = review(message.message.content)
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.42, permission_denials: [] })
})
// Pit View closes stdin once the result is out with nothing in the background; only then does it exit
process.stdin.on('end', () => {
  if (dir !== null) fs.writeFileSync(path.join(dir, 'fake-stdin-closed'), at())
  process.exit(0)
})
`

const fakeCodex = `${common}
out({ type: 'thread.started', thread_id: 'th-fake-1' })
out({ type: 'turn.started' })
review(process.argv[process.argv.length - 1])
out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
`

// an executable on PATH named like the runner, running its script with this Node
const install = async (bin: string, name: string, script: string): Promise<void> => {
  await writeFile(join(bin, `${name}.cjs`), script)
  await writeFile(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, `${name}.cjs`)}" "$@"\n`)
  await chmod(join(bin, name), 0o755)
}

const setup = async (config: Partial<Config> = {}) => {
  const temp = await tempDir()
  const home = await realpath(temp.dir)
  const bin = join(home, 'bin')
  const cwd = join(home, 'dev', 'orbit')
  for (const dir of [bin, cwd, join(home, 'agents', 'output'), join(home, 'agents', 'worktrees')]) await mkdir(dir, { recursive: true })
  await install(bin, 'claude', fakeClaude)
  await install(bin, 'codex', fakeCodex)
  const cache = openCache({ path: ':memory:', clock: { now: () => Date.now() } })
  const changes: Run[] = []
  const launcher = createLauncher({
    cache,
    gh: createGh(fixtureRunner().runner),
    git: async () => ok(fakeRemotes(scenario.repo)),
    spawn: systemSpawn,
    fs: systemFs,
    kill: (pid, signal) => process.kill(pid, signal),
    procs: procsFrom(commandRunner('ps')),
    clock: { now: () => Date.now() },
    timers: systemTimers,
    config: () => ({ ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit', ...config }),
    home,
    stateDir: join(home, '.local', 'state', 'pit-view'),
    // a server started inside an agent session must not pass that session on
    env: { PATH: `${bin}:/usr/bin:/bin`, USER: 'tester', LANG: 'en_US.UTF-8', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'desktop', ANTHROPIC_API_KEY: 'sk-fake' },
    newSessionId: () => '00000000-0000-4000-8000-0000000000e2',
    onWatch: () => {},
    onChange: (run) => changes.push(run),
    pollMs: 50,
    watchedPollMs: 200,
  })
  const cleanup = async (): Promise<void> => {
    launcher.close()
    cache.close()
    await temp.cleanup()
  }
  return { home, cwd, launcher, cache, changes, cleanup }
}

const request = { repo: scenario.repo, number: 104, command: 'review-pr', args: ['104', '--no-post'], label: 'Self-review' }

const callOf = async (dir: string): Promise<{ argv: string[], cwd: string, env: Record<string, string>, request: string }> =>
  JSON.parse(await readFile(join(dir, 'fake-call.json'), 'utf8'))

const checkEnv = (env: Record<string, string>, home: string): void => {
  assert.equal(env.HOME, home)
  assert.equal(env.USER, 'tester')
  assert.ok(Object.keys(env).every((key) => !key.startsWith('CLAUDE') && !key.startsWith('ANTHROPIC')), Object.keys(env).join(', '))
}

test('a Claude run end to end: stream-json request on stdin, steps, stdin closed on the result, settled done', { timeout: 20_000 }, async () => {
  const h = await setup()
  try {
    const run = await h.launcher.start(request)
    assert.equal(run.status, 'running')
    assert.ok(run.pid !== null && run.pidStartedAt !== null)
    const final = await h.launcher.settled(run.id)
    const dir = join(h.home, '.local', 'state', 'pit-view', 'runs', String(run.id))
    assert.deepEqual([final.status, final.note, final.costUsd], ['done', null, 0.42])
    assert.deepEqual([final.step, final.stepState], ['post', 'skipped'])
    assert.equal(final.result?.schema === 'pit-crew/review-result@1' && final.result.notPostedReason, 'noPost')
    const call = await callOf(dir)
    assert.deepEqual(call.argv, claudeInvocation({
      command: 'review-pr', args: ['104', '--no-post'], cwd: h.cwd, runDir: dir, home: h.home, sessionId: '00000000-0000-4000-8000-0000000000e2', claudeModel: 'sonnet',
      reportsDir: join(h.home, 'agents', 'output'), worktreesDir: join(h.home, 'agents', 'worktrees'),
    }).args)
    assert.equal(call.request, `/review-pr 104 --no-post --emit-json=${dir}`)
    assert.equal(call.cwd, h.cwd)
    checkEnv(call.env, h.home)
    // it exited only because Pit View closed its stdin
    assert.ok((await readFile(join(dir, 'fake-stdin-closed'), 'utf8')).length > 0)
    const recorded = JSON.parse(await readFile(join(dir, 'request.json'), 'utf8'))
    assert.deepEqual([recorded.pid, recorded.pidStartedAt], [run.pid, run.pidStartedAt])
    assert.match(await readFile(join(dir, 'stream.jsonl'), 'utf8'), /"type":"result"/)
    assert.equal(h.changes.at(-1)?.status, 'done')
  } finally {
    await h.cleanup()
  }
})

test('a Claude run carries the configured model on its real command line, sonnet unless the config sets another', { timeout: 20_000 }, async () => {
  const modelOf = (argv: readonly string[]): string | undefined => argv[argv.indexOf('--model') + 1]
  const first = await setup()
  try {
    const run = await first.launcher.start(request)
    await first.launcher.settled(run.id)
    const call = await callOf(join(first.home, '.local', 'state', 'pit-view', 'runs', String(run.id)))
    assert.equal(modelOf(call.argv), 'sonnet')
    // the resumed session keeps its own model, so the resume command carries none
    assert.doesNotMatch((await first.launcher.settled(run.id)).resume ?? '', /--model/)
  } finally {
    await first.cleanup()
  }
  const second = await setup({ agent: { runner: 'claude', claudeModel: 'opus' } })
  try {
    const run = await second.launcher.start(request)
    await second.launcher.settled(run.id)
    const call = await callOf(join(second.home, '.local', 'state', 'pit-view', 'runs', String(run.id)))
    assert.equal(modelOf(call.argv), 'opus')
  } finally {
    await second.cleanup()
  }
})

test('a Codex run end to end: the $ skill and note as its prompt, the session from thread.started, settled done by its files', { timeout: 20_000 }, async () => {
  const h = await setup({ agent: { runner: 'codex', claudeModel: 'sonnet', codexModel: 'gpt-6.1-terra' } })
  try {
    const run = await h.launcher.start(request)
    const final = await h.launcher.settled(run.id)
    const dir = join(h.home, '.local', 'state', 'pit-view', 'runs', String(run.id))
    assert.deepEqual([final.status, final.note, final.costUsd, final.sessionId], ['done', null, null, 'th-fake-1'])
    assert.match(final.resume ?? '', /^cd ~\/dev\/orbit && codex resume th-fake-1 -m gpt-6\.1-terra -s workspace-write /)
    const call = await callOf(dir)
    assert.deepEqual(call.argv, codexInvocation({
      command: 'review-pr', args: ['104', '--no-post'], cwd: h.cwd, runDir: dir, home: h.home, sessionId: null, claudeModel: 'sonnet', codexModel: 'gpt-6.1-terra',
      reportsDir: join(h.home, 'agents', 'output'), worktreesDir: join(h.home, 'agents', 'worktrees'),
    }).args)
    assert.ok(call.request.startsWith(`$review-pr 104 --no-post --emit-json=${dir}\n\nNote: `))
    checkEnv(call.env, h.home)
  } finally {
    await h.cleanup()
  }
})
