// test/config.test.ts
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  cacheFile, ConfigError, configFile, defaultConfig, expandHome, loadConfig, readConfig, saveConfig, validateConfig,
} from '../src/config.ts'
import { tempDir } from './helpers.ts'

const home = '/home/tester'
const noViewer = () => Promise.reject(new Error('viewer lookup should not run'))

test('config.example.json matches the built-in defaults', async () => {
  const example = JSON.parse(await readFile(join(import.meta.dirname, '..', 'config.example.json'), 'utf8'))
  assert.deepEqual(example, defaultConfig())
  assert.deepEqual(validateConfig(example), example)
})

test('expandHome resolves ~ and ~/ against home only', () => {
  assert.equal(expandHome('~', home), home)
  assert.equal(expandHome('~/agents/output', home), '/home/tester/agents/output')
  assert.equal(expandHome('/srv/reports', home), '/srv/reports')
  assert.equal(expandHome('~other/x', home), '~other/x')
})

test('config and cache files live under the given home', () => {
  assert.equal(configFile(home), '/home/tester/.config/pit-view/config.json')
  assert.equal(cacheFile(home), '/home/tester/.local/state/pit-view/cache.sqlite')
})

test('allowedHosts holds bare host names only, lowercased and without repeats', () => {
  const base = defaultConfig()
  assert.deepEqual(base.allowedHosts, [])
  assert.deepEqual(validateConfig({ ...base, allowedHosts: [' Pit.Example.Test ', 'pit.example.test', 'dash.example.test', '192.168.10.5'] }).allowedHosts,
    ['pit.example.test', 'dash.example.test', '192.168.10.5'])
  for (const bad of ['https://pit.example.test', 'pit.example.test:443', 'pit.example.test/', 'pit.example.test/x', '*.example.test', '', 'pit_view.example.test', '-pit.example.test', 'pit..example.test', 'user@pit.example.test', '[::1]', `${'a'.repeat(64)}.example.test`]) {
    assert.throws(() => validateConfig({ ...base, allowedHosts: [bad] }), (error: unknown) => error instanceof ConfigError && /config\.allowedHosts/.test(error.message), bad)
  }
  assert.throws(() => validateConfig({ ...base, allowedHosts: 'pit.example.test' }), /config\.allowedHosts must be a list/)
  assert.throws(() => validateConfig({ ...base, allowedHosts: [42] }), /config\.allowedHosts must hold strings/)
  const { allowedHosts: _hosts, ...missing } = base
  assert.throws(() => validateConfig(missing), /config\.allowedHosts must be a list/)
})

test('cloneDir is optional: an absolute path or one under ~, trimmed, and left out when empty', () => {
  const base = defaultConfig()
  assert.equal('cloneDir' in validateConfig(base), false)
  assert.equal(validateConfig({ ...base, cloneDir: ' ~/dev/orbit ' }).cloneDir, '~/dev/orbit')
  assert.equal(validateConfig({ ...base, cloneDir: '/srv/clones/orbit' }).cloneDir, '/srv/clones/orbit')
  assert.equal('cloneDir' in validateConfig({ ...base, cloneDir: '  ' }), false)
  // whether it is a clone of repo is checked when a run starts, not here
  assert.equal(validateConfig({ ...base, cloneDir: '~/no/such/folder' }).cloneDir, '~/no/such/folder')
  assert.throws(() => validateConfig({ ...base, cloneDir: 'dev/orbit' }), /config\.cloneDir must be an absolute path or a path under ~/)
  assert.throws(() => validateConfig({ ...base, cloneDir: 42 }), /config\.cloneDir must be a string path/)
  // the saved file keeps the keys in the documented order
  assert.deepEqual(Object.keys(validateConfig({ ...base, cloneDir: '~/dev/orbit' })).slice(-3), ['allowedHosts', 'cloneDir', 'agent'])
})

test('agent names the default runner, claude unless set, the Claude model, and an optional Codex model', () => {
  const base = defaultConfig()
  assert.deepEqual(base.agent, { runner: 'claude', claudeModel: 'sonnet' })
  assert.deepEqual(validateConfig({ ...base, agent: { runner: 'codex', claudeModel: 'sonnet' } }).agent, { runner: 'codex', claudeModel: 'sonnet' })
  assert.deepEqual(validateConfig({ ...base, agent: { runner: 'codex', codexModel: ' gpt-6.1-terra ' } }).agent, { runner: 'codex', claudeModel: 'sonnet', codexModel: 'gpt-6.1-terra' })
  assert.deepEqual(validateConfig({ ...base, agent: { runner: 'claude', codexModel: '' } }).agent, { runner: 'claude', claudeModel: 'sonnet' })
  // a config written before phase 2 has none
  const { agent: _agent, ...older } = base
  assert.deepEqual(validateConfig(older).agent, { runner: 'claude', claudeModel: 'sonnet' })
  assert.throws(() => validateConfig({ ...base, agent: { runner: 'hermes' } }), /agent\.runner must be one of claude, codex/)
  assert.throws(() => validateConfig({ ...base, agent: 'claude' }), /config\.agent must be an object/)
  assert.throws(() => validateConfig({ ...base, agent: { runner: 'codex', codexModel: '--dangerously-bypass' } }), /agent\.codexModel must be a model name/)
  assert.throws(() => validateConfig({ ...base, agent: { runner: 'codex', codexModel: 'gpt 6' } }), /agent\.codexModel/)
  assert.throws(() => validateConfig({ ...base, agent: { runner: 'codex', tandem: true } }), /agent\.tandem is not a known setting/)
})

test('agent.claudeModel reads as sonnet when missing or empty, takes an explicit model, and refuses a flag or a space', () => {
  const base = defaultConfig()
  assert.equal(validateConfig({ ...base, agent: { runner: 'claude', claudeModel: 'sonnet' } }).agent.claudeModel, 'sonnet')
  assert.equal(validateConfig({ ...base, agent: { runner: 'claude', claudeModel: '' } }).agent.claudeModel, 'sonnet')
  assert.equal(validateConfig({ ...base, agent: { runner: 'claude', claudeModel: '   ' } }).agent.claudeModel, 'sonnet')
  assert.equal(validateConfig({ ...base, agent: { runner: 'claude', claudeModel: ' opus ' } }).agent.claudeModel, 'opus')
  assert.equal(validateConfig({ ...base, agent: { runner: 'codex', claudeModel: 'claude-sonnet-5-5' } }).agent.claudeModel, 'claude-sonnet-5-5')
  assert.throws(() => validateConfig({ ...base, agent: { runner: 'claude', claudeModel: '--dangerously-skip-permissions' } }), /agent\.claudeModel must be a model name/)
  assert.throws(() => validateConfig({ ...base, agent: { runner: 'claude', claudeModel: 'opus 5' } }), /agent\.claudeModel must be a model name/)
  assert.throws(() => validateConfig({ ...base, agent: { runner: 'claude', claudeModel: 7 } }), /agent\.claudeModel/)
})

test('a stored cloneDir and agent survive a save and a read', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const file = join(dir, 'config.json')
    const config = { ...defaultConfig(), cloneDir: '~/dev/orbit', agent: { runner: 'codex' as const, claudeModel: 'opus', codexModel: 'gpt-6.1-terra' } }
    await saveConfig(file, config)
    assert.deepEqual(await readConfig(file), config)
  } finally {
    await cleanup()
  }
})

test('idleMinutes is 0 for never or a whole number of minutes from 5 to 1440, 90 by default', () => {
  const base = defaultConfig()
  assert.equal(base.idleMinutes, 90)
  for (const good of [0, 5, 60, 90, 120, 1440]) assert.equal(validateConfig({ ...base, idleMinutes: good }).idleMinutes, good)
  for (const bad of [-1, 1, 4, 1441, 90.5, '90', null, true, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => validateConfig({ ...base, idleMinutes: bad }), /config\.idleMinutes must be 0 \(never idle\) or a whole number of minutes from 5 to 1440/, String(bad))
  }
  const { idleMinutes: _idle, ...missing } = base
  assert.throws(() => validateConfig(missing), /config\.idleMinutes/)
})

test('a stored file without idleMinutes takes the default', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const file = join(dir, 'config.json')
    await writeFile(file, JSON.stringify({ repo: 'example-org/app', viewer: 'someone' }))
    assert.equal((await readConfig(file)).idleMinutes, 90)
    await writeFile(file, JSON.stringify({ repo: 'example-org/app', viewer: 'someone', idleMinutes: 0 }))
    assert.equal((await readConfig(file)).idleMinutes, 0)
  } finally {
    await cleanup()
  }
})

test('a missing file loads the defaults plus the gh login', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    let asked = 0
    const config = await loadConfig({
      file: join(dir, 'absent.json'),
      viewerLogin: async () => {
        asked += 1
        return 'octo-viewer\n'
      },
    })
    assert.equal(asked, 1)
    assert.deepEqual(config, { ...defaultConfig(), viewer: 'octo-viewer' })
  } finally {
    await cleanup()
  }
})

test('a stored file is merged over the defaults and its viewer wins', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const file = join(dir, 'config.json')
    await writeFile(file, JSON.stringify({ repo: 'example-org/app', viewer: 'someone', refreshSeconds: 60 }))
    const config = await loadConfig({ file, viewerLogin: noViewer })
    assert.equal(config.repo, 'example-org/app')
    assert.equal(config.viewer, 'someone')
    assert.equal(config.refreshSeconds, 60)
    assert.deepEqual(config.bots, ['dependabot', 'renovate'])
    assert.equal(config.reportsDir, '~/agents/output')
  } finally {
    await cleanup()
  }
})

test('unreadable or invalid files raise ConfigError', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const file = join(dir, 'config.json')
    await writeFile(file, '{ not json')
    await assert.rejects(loadConfig({ file, viewerLogin: noViewer }), ConfigError)
    await writeFile(file, '[]')
    await assert.rejects(loadConfig({ file, viewerLogin: noViewer }), /must hold a JSON object/)
    await writeFile(file, JSON.stringify({ density: 'roomy' }))
    await assert.rejects(loadConfig({ file, viewerLogin: noViewer }), /config\.density must be one of comfortable, compact/)
  } finally {
    await cleanup()
  }
})

test('an empty gh login is an error, not a silent blank viewer', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    await assert.rejects(
      loadConfig({ file: join(dir, 'absent.json'), viewerLogin: async () => '  ' }),
      /no viewer configured/,
    )
  } finally {
    await cleanup()
  }
})

test('validateConfig names the offending setting', () => {
  const base = defaultConfig()
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ ...base, colour: 'blue' }, /config\.colour is not a known setting/],
    [{ ...base, repo: 'just-a-name' }, /owner\/name/],
    [{ ...base, refreshSeconds: 30 }, /refreshSeconds must be one of 60, 120, 300/],
    [{ ...base, todayStartsAt: 'noon' }, /todayStartsAt/],
    [{ ...base, bots: ['dependabot', 7] }, /bots must hold strings/],
    [{ ...base, showAgentColumn: 'yes' }, /showAgentColumn must be true or false/],
    [{ ...base, people: [{ login: 'a', alias: 'A', initials: 'A', color: '#000000', avatar: '/tmp/a.png' }] }, /people\[0\]\.avatar/],
    [{ ...base, people: [{ login: 'a', alias: 'A', initials: 'A', color: '#000000' }] }, /people\[0\]\.avatar must be a string/],
    [{ ...base, tickets: [{ ...base.tickets[0], pattern: '(' }] }, /tickets\[0\]\.pattern is not a valid regular expression/],
    [{ ...base, tickets: [{ ...base.tickets[0], kind: 'trello' }] }, /tickets\[0\]\.kind/],
    [{ ...base, notifications: { enabled: true } }, /notifications\.kinds must be a list/],
  ]
  for (const [input, message] of cases) assert.throws(() => validateConfig(input), message)
})

test('validateConfig accepts people, a local avatar and notifications', () => {
  const input = {
    ...defaultConfig(),
    viewer: ' octo-viewer ',
    people: [{ login: 'octo-friend', alias: 'Friend', initials: 'OF', color: '#0F766E', avatar: '~/avatars/friend.png' }],
    notifications: { enabled: false, kinds: ['changesRequested'] },
  }
  const config = validateConfig(input)
  assert.equal(config.viewer, 'octo-viewer')
  assert.equal(config.people[0]?.avatar, '~/avatars/friend.png')
  assert.deepEqual(config.notifications, { enabled: false, kinds: ['changesRequested'] })
})

test('saveConfig creates the folder, writes formatted JSON and round-trips', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const file = join(dir, 'nested', 'pit-view', 'config.json')
    const config = { ...defaultConfig(), viewer: 'octo-viewer', density: 'compact' as const }
    assert.deepEqual(await saveConfig(file, config), config)
    const text = await readFile(file, 'utf8')
    assert.ok(text.endsWith('}\n'))
    assert.ok(text.includes('\n  "repo": "Port-City/meridian",\n'))
    assert.deepEqual(await loadConfig({ file, viewerLogin: noViewer }), config)
  } finally {
    await cleanup()
  }
})

test('saveConfig refuses an invalid config and leaves the file alone', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const file = join(dir, 'config.json')
    await writeFile(file, '{}')
    const bad = { ...defaultConfig(), refreshSeconds: 5 } as unknown as ReturnType<typeof defaultConfig>
    await assert.rejects(saveConfig(file, bad), ConfigError)
    assert.equal(await readFile(file, 'utf8'), '{}')
  } finally {
    await cleanup()
  }
})

test('readConfig keeps an empty viewer, as the file stores it', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const file = join(dir, 'config.json')
    assert.equal((await readConfig(file)).viewer, '')
    await writeFile(file, JSON.stringify({ repo: 'octo-example/orbit', viewer: '' }), 'utf8')
    const stored = await readConfig(file)
    assert.equal(stored.repo, 'octo-example/orbit')
    assert.equal(stored.viewer, '')
  } finally {
    await cleanup()
  }
})

test('notifications validate their kinds, drop repeats, and are optional', () => {
  const base = defaultConfig()
  assert.equal('notifications' in validateConfig(base), false)
  const all = ['changesRequested', 'readyToMerge', 'reviewRequested', 'ciFailing', 'runFinished', 'runNeedsInput']
  assert.deepEqual(validateConfig({ ...base, notifications: { enabled: true, kinds: [...all, 'ciFailing'] } }).notifications, { enabled: true, kinds: all })
  assert.deepEqual(validateConfig({ ...base, notifications: { enabled: true, kinds: [] } }).notifications, { enabled: true, kinds: [] })
  assert.throws(() => validateConfig({ ...base, notifications: { enabled: true, kinds: ['mineReady'] } }), /notifications\.kinds must hold only changesRequested.*got mineReady/)
  assert.throws(() => validateConfig({ ...base, notifications: { enabled: true, kinds: [3] } }), /got number/)
  assert.throws(() => validateConfig({ ...base, notifications: { enabled: 'yes', kinds: [] } }), /notifications\.enabled must be true or false/)
  assert.throws(() => validateConfig({ ...base, notifications: { kinds: [] } }), /notifications\.enabled/)
  assert.throws(() => validateConfig({ ...base, notifications: { enabled: true, kinds: [], sound: true } }), /notifications\.sound is not a known setting/)
  assert.throws(() => validateConfig({ ...base, notifications: true }), /config\.notifications must be an object/)
})
