// test/ui-openrouterkey.test.ts
// the Settings card for Pit View's OpenRouter key (public/openrouterkey.ts): it shows whether a key is set and replaces or clears it, and has no way to show the key
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { clearRequest, keyInputProblem, keyStatus, replaceRequest } from '../public/openrouterkey.ts'
import { toConfig, toForm } from '../public/settings-form.ts'
import { defaultConfig } from '../src/config.ts'

test('the card says only whether a key is set, names a problem with the file, and says nothing while the answer is unknown', () => {
  assert.deepEqual(keyStatus(null), { text: 'Could not read whether a key is set.', tone: 'error' })
  assert.deepEqual(keyStatus({ set: false, problem: null }), { text: 'Not set. Hermes runs fail to start until a key is set.', tone: 'normal' })
  assert.deepEqual(keyStatus({ set: true, problem: null }), { text: 'Set.', tone: 'ok' })
  assert.deepEqual(keyStatus({ set: false, problem: '~/.config/pit-view/openrouter.json has mode 0644; it must be 0600' }), { text: 'Not usable: ~/.config/pit-view/openrouter.json has mode 0644; it must be 0600', tone: 'error' })
  // whatever else an answer carried is never shown
  assert.doesNotMatch(JSON.stringify(keyStatus({ set: true, problem: null, apiKey: 'sk-or-PLANTED' } as never)), /PLANTED/)
})

test('a replace sends the key to its own route and nothing else, with the token, and a clear sends no body', () => {
  const put = replaceRequest('sk-or-fake', 'tok')
  assert.equal(put.url, '/api/openrouter-key')
  assert.equal(put.init.method, 'PUT')
  assert.deepEqual(JSON.parse(put.init.body as string), { apiKey: 'sk-or-fake' })
  assert.equal((put.init.headers as Record<string, string>)['X-Pit-View-Token'], 'tok')
  const del = clearRequest('tok')
  assert.equal(del.url, '/api/openrouter-key')
  assert.equal(del.init.method, 'DELETE')
  assert.equal(del.init.body, undefined)
  assert.equal((del.init.headers as Record<string, string>)['X-Pit-View-Token'], 'tok')
})

test('a key is checked before it is sent: not empty, no whitespace inside, and the message never repeats it', () => {
  assert.equal(keyInputProblem('sk-or-fake'), null)
  assert.equal(keyInputProblem(''), 'Enter the key.')
  assert.equal(keyInputProblem('   '), 'Enter the key.')
  assert.equal(keyInputProblem('sk or fake'), 'A key has no spaces.')
  assert.equal(keyInputProblem(' sk-or-fake '), null)
})

test('the page has a password field that is never filled in, and Replace and Clear buttons, and the config form never carries the key', async () => {
  const html = await readFile(new URL('../public/settings.html', import.meta.url), 'utf8')
  assert.match(html, /<input id="openrouter-key"[^>]*type="password"[^>]*autocomplete="off"/)
  assert.match(html, /id="openrouter-replace"/)
  assert.match(html, /id="openrouter-clear"/)
  assert.doesNotMatch(html.slice(html.indexOf('id="openrouter-key"'), html.indexOf('id="openrouter-key"') + 200), /value=/)
  // a save of other settings has no key to write: the config the form builds has no field for it
  const config = { ...defaultConfig(), agent: { runner: 'claude' as const, claudeModel: 'sonnet', hermesProfile: 'review2' } }
  const saved = toConfig(toForm(config, () => 'id'), config)
  assert.equal(saved.agent.hermesProfile, 'review2')
  assert.doesNotMatch(JSON.stringify(saved), /apiKey|openrouter/i)
})
