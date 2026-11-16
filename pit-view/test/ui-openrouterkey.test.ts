// test/ui-openrouterkey.test.ts
// the Settings card for Pit View's OpenRouter key (public/openrouterkey.ts): three read-only status lines, no field, no button, and no way to show or send a key
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { keyLines, keyRoute } from '../public/openrouterkey.ts'
import type { KeyView } from '../public/openrouterkey.ts'
import { toConfig, toForm } from '../public/settings-form.ts'
import { defaultConfig } from '../src/config.ts'

const view = (over: Partial<KeyView> = {}): KeyView => ({ keyFile: 'set', profileEnv: 'set', sync: 'in sync', prefixes: null, problems: { keyFile: null, profileEnv: null }, ...over })

test('the card has three lines, key file, profile .env, and whether they agree, and says nothing but that while the answer is unknown', () => {
  assert.deepEqual(keyLines(null), [{ id: 'sync', text: 'Could not read the state of the OpenRouter key.', tone: 'error' }])
  assert.deepEqual(keyLines(view()), [
    { id: 'keyFile', text: 'Key file: set.', tone: 'ok' },
    { id: 'profileEnv', text: 'Profile .env: set.', tone: 'ok' },
    { id: 'sync', text: 'The two keys are in sync.', tone: 'ok' },
  ])
  assert.deepEqual(keyLines(view({ keyFile: 'missing', sync: 'unknown' })).map((line) => [line.id, line.text]), [
    ['keyFile', 'Key file: not set.'], ['profileEnv', 'Profile .env: set.'], ['sync', 'The two keys cannot be compared until both are set.'],
  ])
})

test('a differing pair shows both 8-character prefixes, and a prefix is never shown when the keys agree or cannot be compared', () => {
  const differs = keyLines(view({ sync: 'differs', prefixes: { keyFile: 'a1b2c3d4', profileEnv: 'e5f6a7b8' } }))
  assert.equal(differs[2]?.text, 'The two keys differ: key file a1b2c3d4, profile .env e5f6a7b8.')
  assert.equal(differs[2]?.tone, 'error')
  assert.doesNotMatch(JSON.stringify(keyLines(view({ prefixes: { keyFile: 'a1b2c3d4', profileEnv: 'e5f6a7b8' } }))), /a1b2c3d4|e5f6a7b8/)
  assert.doesNotMatch(JSON.stringify(keyLines(view({ sync: 'unknown', prefixes: { keyFile: 'a1b2c3d4', profileEnv: 'e5f6a7b8' } }))), /a1b2c3d4|e5f6a7b8/)
})

test('a file with a problem is named as not usable with the server\'s message, and nothing else the answer carried is shown', () => {
  const lines = keyLines(view({ keyFile: 'problem', sync: 'unknown', problems: { keyFile: '~/.config/pit-view/openrouter.json has mode 0644; it must be 0600', profileEnv: null } }))
  assert.equal(lines[0]?.text, 'Key file: not usable, ~/.config/pit-view/openrouter.json has mode 0644; it must be 0600')
  assert.equal(lines[0]?.tone, 'error')
  assert.doesNotMatch(JSON.stringify(keyLines({ ...view(), apiKey: 'sk-or-PLANTED' } as never)), /PLANTED/)
})

test('the page reads only: no input, no Replace or Clear, no request that writes, one sentence naming the two files to edit by hand, and the config form never carries a key', async () => {
  assert.equal(keyRoute, '/api/openrouter-key')
  const html = await readFile(new URL('../public/settings.html', import.meta.url), 'utf8')
  const card = html.slice(html.indexOf('id="openrouter"'), html.indexOf('id="models"'))
  assert.doesNotMatch(card, /<input|<textarea|<button|type="password"/)
  for (const id of ['openrouter-keyFile', 'openrouter-profileEnv', 'openrouter-sync']) assert.match(card, new RegExp(`id="${id}"`))
  assert.match(card, /openrouter\.json/)
  assert.match(card, /\.env/)
  const script = await readFile(new URL('../public/settings.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(script.slice(script.indexOf('OpenRouter key card')), /method: 'PUT'|method: 'DELETE'|replaceRequest|clearRequest/)
  const config = { ...defaultConfig(), agent: { runner: 'claude' as const, claudeModel: 'sonnet', hermesProfile: 'review2' } }
  const saved = toConfig(toForm(config, () => 'id'), config)
  assert.equal(saved.agent.hermesProfile, 'review2')
  assert.doesNotMatch(JSON.stringify(saved), /apiKey|openrouter/i)
})
