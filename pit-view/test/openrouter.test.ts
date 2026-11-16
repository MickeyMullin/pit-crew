// test/openrouter.test.ts
// Pit View's dedicated OpenRouter key (section 8 of DESIGN.md, The OpenRouter key): a file of its own in the config folder, read and written the way oauth.json is, and never part of config.json
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { configDir } from '../src/config.ts'
import { clearOpenRouterKey, keyProblem, openRouterFileName, openRouterKeyPath, readOpenRouterKey, writeOpenRouterKey } from '../src/openrouter.ts'
import { tempDir } from './helpers.ts'

const fake = 'sk-or-v1-fakefakefakefakefakefakefakefake0001'

const rig = async () => {
  const temp = await tempDir()
  const path = openRouterKeyPath(temp.dir)
  await mkdir(configDir(temp.dir), { recursive: true })
  return { ...temp, path }
}

test('the key file lives beside config.json under the instance folder, with its own name', () => {
  assert.equal(openRouterFileName, 'openrouter.json')
  assert.equal(openRouterKeyPath('/home/t'), join(configDir('/home/t'), 'openrouter.json'))
  assert.equal(openRouterKeyPath('/home/t', 'dev'), join(configDir('/home/t', 'dev'), 'openrouter.json'))
  assert.notEqual(openRouterKeyPath('/home/t'), openRouterKeyPath('/home/t', 'dev'))
})

test('a key is written to a file of mode 0600 as { "apiKey": ... } and read back, and a replace leaves no other file in the folder', async () => {
  const h = await rig()
  try {
    assert.deepEqual(await readOpenRouterKey(h.path), { missing: true })
    await writeOpenRouterKey(h.path, fake)
    assert.equal((await stat(h.path)).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(await readFile(h.path, 'utf8')), { apiKey: fake })
    assert.deepEqual(await readOpenRouterKey(h.path), { key: fake })
    await writeOpenRouterKey(h.path, `${fake}-two`)
    assert.deepEqual(await readOpenRouterKey(h.path), { key: `${fake}-two` })
    assert.equal((await stat(h.path)).mode & 0o777, 0o600)
    const { readdir } = await import('node:fs/promises')
    assert.deepEqual(await readdir(configDir(h.dir)), [openRouterFileName])
  } finally {
    await h.cleanup()
  }
})

test('a write creates the config folder when it is missing, and a clear removes the file and is harmless twice', async () => {
  const temp = await tempDir()
  try {
    const path = openRouterKeyPath(temp.dir)
    await writeOpenRouterKey(path, fake)
    assert.deepEqual(await readOpenRouterKey(path), { key: fake })
    await clearOpenRouterKey(path)
    assert.deepEqual(await readOpenRouterKey(path), { missing: true })
    await clearOpenRouterKey(path)
  } finally {
    await temp.cleanup()
  }
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
      await writeFile(h.path, text)
      assert.deepEqual(await readOpenRouterKey(h.path), { missing: true }, text)
    }
    await writeFile(`${h.path}.real`, JSON.stringify({ apiKey: fake }), { mode: 0o600 })
    await (await import('node:fs/promises')).rm(h.path)
    await symlink(`${h.path}.real`, h.path)
    const link = await readOpenRouterKey(h.path)
    assert.ok('problem' in link && /symbolic link/.test(link.problem))
  } finally {
    await h.cleanup()
  }
})

test('a key is refused when it is empty, has whitespace or a control character, or is far too long, and the reason never repeats it', () => {
  assert.equal(keyProblem(fake), null)
  for (const bad of ['', '   ', 'has space', 'tab\there', 'new\nline', 'x'.repeat(501)]) {
    const problem = keyProblem(bad)
    assert.notEqual(problem, null, JSON.stringify(bad))
    assert.doesNotMatch(problem as string, /has space|tab|new/)
  }
  assert.equal(keyProblem(7), 'the key must be text')
})
