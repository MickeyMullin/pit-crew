// test/service.test.ts
// the launchd agent: the committed template, its rendering as a pure function, and install,
// uninstall, restart and status against a fake launchctl and git under a temporary home
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import type { RunResult } from '../src/github.ts'
import {
  install, label, logFiles, parseLaunchctlPrint, plistFile, renderPlist, restart, ServiceError, servicePath, status, templateFile, uninstall,
} from '../scripts/service.ts'
import type { Answer, ServiceDeps } from '../scripts/service.ts'
import { fakeRunner, failed, ok, tempDir } from './helpers.ts'

const appRoot = join(import.meta.dirname, '..')
const template = (): Promise<string> => readFile(templateFile(appRoot), 'utf8')

const values = { home: '/home/tester', appDir: '/home/tester/app/pit-crew/pit-view', node: '/opt/node/bin/node', path: '/opt/node/bin:/usr/bin:/bin' }

test('the committed template holds placeholders only, never a real path', async () => {
  const text = await template()
  for (const token of ['__HOME__', '__APP_DIR__', '__NODE__', '__PATH__']) assert.ok(text.includes(token), token)
  assert.doesNotMatch(text, /\/Users\/|\/home\//)
  assert.match(text, /<string>com\.mickey\.pit-view<\/string>/)
})

test('renderPlist fills every placeholder: the label, node, the app folder, PATH, KeepAlive, RunAtLoad and logs under the state folder', async () => {
  const plist = renderPlist(await template(), values)
  assert.doesNotMatch(plist, /__[A-Z_]+__/)
  assert.equal(label, 'com.mickey.pit-view')
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.mickey\.pit-view<\/string>/)
  assert.match(plist, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/node\/bin\/node<\/string>\s*<string>\/home\/tester\/app\/pit-crew\/pit-view\/src\/server\.ts<\/string>\s*<\/array>/)
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/home\/tester\/app\/pit-crew\/pit-view<\/string>/)
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/opt\/node\/bin:\/usr\/bin:\/bin<\/string>/)
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/)
  assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/home\/tester\/\.local\/state\/pit-view\/server\.log<\/string>/)
  assert.match(plist, /<key>StandardErrorPath<\/key>\s*<string>\/home\/tester\/\.local\/state\/pit-view\/server\.err\.log<\/string>/)
  // the service is the default instance, so nothing selects another
  assert.doesNotMatch(plist, /<key>PIT_VIEW_/)
})

test('renderPlist escapes XML and refuses unknown placeholders and relative paths', () => {
  assert.equal(renderPlist('<string>__APP_DIR__</string>', { ...values, appDir: '/srv/a&b<c>' }), '<string>/srv/a&amp;b&lt;c&gt;</string>')
  assert.throws(() => renderPlist('__LABEL__', values), (error: unknown) => error instanceof ServiceError && /unknown placeholder __LABEL__/.test(error.message))
  assert.throws(() => renderPlist('__NODE__', { ...values, node: 'node' }), /node must be an absolute path/)
  assert.throws(() => renderPlist('__HOME__', { ...values, home: '~' }), /home must be an absolute path/)
  assert.throws(() => renderPlist('__PATH__', { ...values, path: '' }), /path must not be empty/)
})

test('the rendered plist is one plutil accepts', { skip: process.platform !== 'darwin' }, async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const file = join(dir, 'agent.plist')
    await writeFile(file, renderPlist(await template(), values), 'utf8')
    const { stdout } = await promisify(execFile)('plutil', ['-lint', file])
    assert.match(stdout, /OK/)
  } finally {
    await cleanup()
  }
})

test('servicePath keeps the shell PATH without pnpm\'s additions, Node\'s folder first', () => {
  const envPath = ['./node_modules/.bin', '/x/pit-view/node_modules/.bin', '/opt/pnpm/dist/node-gyp-bin', '/opt/homebrew/bin', '', '/usr/bin', '/opt/node/bin', '/usr/bin'].join(':')
  assert.equal(servicePath(envPath, '/opt/node/bin'), '/opt/node/bin:/opt/homebrew/bin:/usr/bin')
})

test('parseLaunchctlPrint reads loaded, state, pid and the last exit code', () => {
  assert.deepEqual(parseLaunchctlPrint(113, 'Could not find service'), { loaded: false, state: null, pid: null, lastExit: null })
  assert.deepEqual(parseLaunchctlPrint(0, `gui/501/${label} = {\n\tactive count = 1\n\tstate = running\n\tparent pid = 1\n\tpid = 4242\n\tlast exit code = (never exited)\n}`),
    { loaded: true, state: 'running', pid: 4242, lastExit: '(never exited)' })
  assert.deepEqual(parseLaunchctlPrint(0, '\tstate = not running\n\tlast exit code = 1\n'), { loaded: true, state: 'not running', pid: null, lastExit: '1' })
})

type World = {
  deps: ServiceDeps
  home: string
  appDir: string
  // every launchctl call so far, as its arguments
  launchctl: () => string[][]
  lines: string[]
  setLoaded: (loaded: boolean) => void
  setAnswer: (answer: Answer | null) => void
  cleanup: () => Promise<void>
}

// a launchctl that keeps one job's loaded state, a git on the given branch, and a probe that
// answers as the agent's process while it is loaded
const world = async ({ branch = 'master', loaded: startLoaded = false } = {}): Promise<World> => {
  const { dir, cleanup } = await tempDir()
  const home = join(dir, 'home')
  const appDir = join(dir, 'app', 'pit-crew', 'pit-view')
  await mkdir(join(appDir, 'deploy'), { recursive: true })
  await writeFile(templateFile(appDir), await template(), 'utf8')
  let loaded = startLoaded
  let answer: Answer | null | undefined
  const pid = 4242
  const launchctl = fakeRunner((args): RunResult => {
    if (args[0] === 'print') return loaded ? ok(`\tstate = running\n\tpid = ${pid}\n`) : failed('Could not find service')
    if (args[0] === 'bootout') {
      loaded = false
      return ok('')
    }
    if (args[0] === 'bootstrap') {
      loaded = true
      return ok('')
    }
    if (args[0] === 'kickstart') return ok('')
    return failed(`unexpected launchctl ${args.join(' ')}`)
  })
  const git = fakeRunner((args) => args.includes('rev-parse') ? ok(`${branch}\n`) : failed('unexpected git'))
  const lines: string[] = []
  const deps: ServiceDeps = {
    home,
    appDir,
    node: '/opt/node/bin/node',
    envPath: '/opt/homebrew/bin:/usr/bin:/bin',
    uid: 501,
    launchctl: launchctl.runner,
    git: git.runner,
    probe: async () => answer !== undefined ? answer : loaded ? { name: '', pid } : null,
    sleep: async () => {},
    log: (line) => lines.push(line),
  }
  return {
    deps,
    home,
    appDir,
    launchctl: () => launchctl.calls.map((call) => call.args),
    lines,
    setLoaded: (value) => {
      loaded = value
    },
    setAnswer: (value) => {
      answer = value
    },
    cleanup,
  }
}

const present = async (file: string): Promise<boolean> => access(file).then(() => true, () => false)

test('install renders the plist into the temp LaunchAgents folder, creates the log folder, bootstraps and waits for the agent to answer', async () => {
  const w = await world()
  try {
    await install(w.deps)
    const plist = await readFile(plistFile(w.home), 'utf8')
    assert.match(plist, new RegExp(`<string>${w.appDir}/src/server\\.ts</string>`))
    assert.match(plist, /<string>\/opt\/node\/bin:\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/)
    assert.ok(await present(join(w.home, '.local', 'state', 'pit-view')))
    assert.deepEqual(w.launchctl().filter((args) => args[0] !== 'print'), [['bootstrap', 'gui/501', plistFile(w.home)]])
    assert.ok(w.lines.some((line) => line.includes('answers from the agent (pid 4242)')))
  } finally {
    await w.cleanup()
  }
})

test('install replaces an earlier install, booting it out first', async () => {
  const w = await world({ loaded: true })
  try {
    await install(w.deps)
    assert.deepEqual(w.launchctl().filter((args) => args[0] !== 'print').map((args) => args[0]), ['bootout', 'bootstrap'])
  } finally {
    await w.cleanup()
  }
})

test('install refuses a checkout that is not on master and writes nothing', async () => {
  const w = await world({ branch: 'feat/pit-view-v1' })
  try {
    await assert.rejects(install(w.deps), /on master, and this checkout is on feat\/pit-view-v1/)
    assert.equal(await present(plistFile(w.home)), false)
    assert.equal(await present(w.home), false)
    assert.deepEqual(w.launchctl(), [])
  } finally {
    await w.cleanup()
  }
})

test('install fails when another process holds the port, rather than reporting success', async () => {
  const w = await world()
  try {
    w.setAnswer({ name: '', pid: 999 })
    await assert.rejects(install(w.deps), /did not answer from it/)
  } finally {
    await w.cleanup()
  }
})

test('uninstall boots the agent out and removes the plist; a second run is harmless', async () => {
  const w = await world()
  try {
    await install(w.deps)
    await uninstall(w.deps)
    assert.equal(await present(plistFile(w.home)), false)
    assert.ok(w.launchctl().some((args) => args[0] === 'bootout' && args[1] === `gui/501/${label}`))
    await uninstall(w.deps)
    assert.ok(w.lines.includes(`${label} was not loaded`))
  } finally {
    await w.cleanup()
  }
})

test('restart kicks the loaded agent and refuses when it is not loaded', async () => {
  const w = await world()
  try {
    await assert.rejects(restart(w.deps), /is not loaded; run pnpm service:install/)
    w.setLoaded(true)
    await restart(w.deps)
    assert.ok(w.launchctl().some((args) => args.join(' ') === `kickstart -k gui/501/${label}`))
  } finally {
    await w.cleanup()
  }
})

test('status is healthy only when the agent runs and its own process answers as the app', async () => {
  const w = await world()
  try {
    assert.equal(await status(w.deps), false)
    assert.ok(w.lines.some((line) => line.endsWith('is not loaded')))
    w.setLoaded(true)
    w.lines.length = 0
    assert.equal(await status(w.deps), true)
    assert.ok(w.lines.some((line) => line.includes('answers from the agent')))
    assert.ok(w.lines.some((line) => line === 'logs: ~/.local/state/pit-view/server.log, ~/.local/state/pit-view/server.err.log'))
    w.setAnswer({ name: '', pid: 999 })
    assert.equal(await status(w.deps), false)
    w.setAnswer({ name: 'dev', pid: 4242 })
    assert.equal(await status(w.deps), false)
    assert.deepEqual(logFiles(w.home), { out: join(w.home, '.local', 'state', 'pit-view', 'server.log'), err: join(w.home, '.local', 'state', 'pit-view', 'server.err.log') })
  } finally {
    await w.cleanup()
  }
})
