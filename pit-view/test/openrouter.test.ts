// test/openrouter.test.ts
// Pit View's dedicated OpenRouter key (section 8 of DESIGN.md, The OpenRouter key): a file of its own in the config folder, read the way oauth.json is and never written, compared with the copy in the Hermes profile's .env, and never part of config.json
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { configDir } from '../src/config.ts'
import { keyStatus, openRouterFileName, openRouterKeyPath, profileEnvPath, readOpenRouterKey, readProfileEnvKey } from '../src/openrouter.ts'
import { tempDir } from './helpers.ts'

const fake = 'sk-or-v1-fakefakefakefakefakefakefakefake0001'

const rig = async () => {
  const temp = await tempDir()
  const path = openRouterKeyPath(temp.dir)
  await mkdir(configDir(temp.dir), { recursive: true })
  return { ...temp, path }
}

const prefix = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 8)

test('the key file lives beside config.json under the instance folder, with its own name', () => {
  assert.equal(openRouterFileName, 'openrouter.json')
  assert.equal(openRouterKeyPath('/home/t'), join(configDir('/home/t'), 'openrouter.json'))
  assert.equal(openRouterKeyPath('/home/t', 'dev'), join(configDir('/home/t', 'dev'), 'openrouter.json'))
  assert.notEqual(openRouterKeyPath('/home/t'), openRouterKeyPath('/home/t', 'dev'))
})

test('a file that is not the owner\'s own plain 0600 file with exactly an apiKey is a problem naming the file, and an empty key reads as missing', async () => {
  const h = await rig()
  try {
    await writeFile(h.path, JSON.stringify({ apiKey: fake }), { mode: 0o644 })
    await chmod(h.path, 0o644)
    const loose = await readOpenRouterKey(h.path)
    assert.ok('problem' in loose && /0644.*0600/.test(loose.problem), JSON.stringify(loose))
    await chmod(h.path, 0o600)
    for (const text of ['not json', '[]', JSON.stringify({ apiKey: fake, extra: 1 }), JSON.stringify({ apiKey: 7 }), JSON.stringify({ key: fake })]) {
      await writeFile(h.path, text)
      const bad = await readOpenRouterKey(h.path)
      assert.ok('problem' in bad, text)
      assert.doesNotMatch(bad.problem, new RegExp(fake), 'a problem never carries the key')
    }
    for (const text of [JSON.stringify({ apiKey: '' }), JSON.stringify({ apiKey: '   ' })]) {
      await writeFile(h.path, text, { mode: 0o600 })
      assert.deepEqual(await readOpenRouterKey(h.path), { missing: true }, text)
    }
    await writeFile(`${h.path}.real`, JSON.stringify({ apiKey: fake }), { mode: 0o600 })
    await rm(h.path)
    await symlink(`${h.path}.real`, h.path)
    const link = await readOpenRouterKey(h.path)
    assert.ok('problem' in link && /symbolic link/.test(link.problem))
  } finally {
    await h.cleanup()
  }
})

test('the profile .env is the Hermes profile\'s own file under the home directory, and the profile name is the only thing that moves it', () => {
  assert.equal(profileEnvPath('/home/t', 'pitview'), '/home/t/.hermes/profiles/pitview/.env')
  assert.equal(profileEnvPath('/home/t', 'review2'), '/home/t/.hermes/profiles/review2/.env')
})

test('the profile .env is read for OPENROUTER_API_KEY alone: other lines are ignored, the last assignment wins, quotes and a trailing comment are not part of the key, and an empty value is missing', async () => {
  const h = await rig()
  try {
    const path = join(h.dir, 'profile.env')
    const read = async (text: string) => {
      await writeFile(path, text, { mode: 0o600 })
      return readProfileEnvKey(path)
    }
    assert.deepEqual(await readProfileEnvKey(join(h.dir, 'absent.env')), { missing: true })
    assert.deepEqual(await read(`OTHER=1\nOPENROUTER_API_KEY=${fake}\nGIT_CONFIG_COUNT=3\n`), { key: fake })
    assert.deepEqual(await read(`# a comment\nexport OPENROUTER_API_KEY = "${fake}"  # note\n`), { key: fake })
    assert.deepEqual(await read(`OPENROUTER_API_KEY='${fake}'\n`), { key: fake })
    assert.deepEqual(await read(`OPENROUTER_API_KEY=${fake} # trailing\n`), { key: fake })
    assert.deepEqual(await read(`OPENROUTER_API_KEY=old\nOPENROUTER_API_KEY=${fake}\n`), { key: fake })
    assert.deepEqual(await read('OPENROUTER_API_KEY=\nOPENROUTER_API_KEY_EXTRA=x\n'), { missing: true })
    assert.deepEqual(await read('NOT_IT=1\n'), { missing: true })
    assert.deepEqual(await read(''), { missing: true })
    // a file that is not the owner's own 0600 file is a problem, whatever it holds
    await chmod(path, 0o644)
    const loose = await readProfileEnvKey(path)
    assert.ok('problem' in loose && /0644.*0600/.test(loose.problem), JSON.stringify(loose))
    assert.doesNotMatch(JSON.stringify(loose), new RegExp(fake))
    await rm(path)
    await writeFile(`${path}.real`, `OPENROUTER_API_KEY=${fake}\n`, { mode: 0o600 })
    await symlink(`${path}.real`, path)
    const link = await readProfileEnvKey(path)
    assert.ok('problem' in link && /symbolic link/.test(link.problem))
  } finally {
    await h.cleanup()
  }
})

test('the status compares the two keys by SHA-256 held in memory: in sync when equal, differs with both 8-character prefixes when not, and unknown when either side is not set', () => {
  const same = keyStatus({ key: fake }, { key: fake })
  assert.deepEqual(same, { keyFile: 'set', profileEnv: 'set', sync: 'in sync', prefixes: null, problems: { keyFile: null, profileEnv: null } })
  const other = `${fake}-stale`
  const differs = keyStatus({ key: fake }, { key: other })
  assert.deepEqual(differs, { keyFile: 'set', profileEnv: 'set', sync: 'differs', prefixes: { keyFile: prefix(fake), profileEnv: prefix(other) }, problems: { keyFile: null, profileEnv: null } })
  assert.match(differs.prefixes?.keyFile ?? '', /^[0-9a-f]{8}$/)
  assert.doesNotMatch(JSON.stringify(differs), new RegExp(fake))
  assert.deepEqual(keyStatus({ missing: true }, { key: fake }), { keyFile: 'missing', profileEnv: 'set', sync: 'unknown', prefixes: null, problems: { keyFile: null, profileEnv: null } })
  assert.deepEqual(keyStatus({ key: fake }, { missing: true }).sync, 'unknown')
  const broken = keyStatus({ problem: '~/.config/pit-view/openrouter.json has mode 0644; it must be 0600' }, { key: fake })
  assert.deepEqual(broken, { keyFile: 'problem', profileEnv: 'set', sync: 'unknown', prefixes: null, problems: { keyFile: '~/.config/pit-view/openrouter.json has mode 0644; it must be 0600', profileEnv: null } })
})
