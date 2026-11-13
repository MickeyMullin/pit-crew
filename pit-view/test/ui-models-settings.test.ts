// test/ui-models-settings.test.ts
// the Models card on the Settings page (section 6 of DESIGN.md, Settings page): the registry and slots as one JSON setting the owner edits, the warnings and the effective slots the server reads back, and the refusal a save answers with
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultConfig } from '../src/config.ts'
import { isDirty, serverError, toConfig, toForm, validateForm } from '../public/settings-form.ts'

const publicFile = (name: string): Promise<string> => readFile(join(import.meta.dirname, '..', 'public', name), 'utf8')

const entry = { id: 'mine', runner: 'hermes', provider: 'openrouter', model: 'vendor/model-x' }

test('a config with no models setting shows an empty field and saves without the key', () => {
  const saved = defaultConfig()
  const form = toForm(saved, () => 'id')
  assert.equal(form.models, '')
  assert.equal('models' in toConfig(form, saved), false)
  assert.equal(isDirty(form, saved), false)
})

test('a stored setting shows as formatted JSON, round trips whole, and typing in the field is a change', () => {
  const saved = { ...defaultConfig(), models: { registry: [entry], slots: { stack: 'mine' } } }
  const form = toForm(saved, () => 'id')
  assert.equal(form.models, JSON.stringify(saved.models, null, 2))
  assert.deepEqual(toConfig(form, saved).models, saved.models)
  assert.equal(isDirty(form, saved), false)
  form.models = JSON.stringify({ slots: { stack: 'opus' } })
  assert.equal(isDirty(form, saved), true)
  assert.deepEqual(toConfig(form, saved).models, { slots: { stack: 'opus' } })
  // clearing the field goes back to the built-in models
  form.models = '  \n'
  assert.equal('models' in toConfig(form, saved), false)
})

test('text that is not a JSON object is a problem on the field, before anything is sent', () => {
  const form = toForm(defaultConfig(), () => 'id')
  const problem = (text: string): string | undefined => {
    form.models = text
    return validateForm(form).find((error) => error.field === 'models')?.message
  }
  assert.equal(problem(''), undefined)
  assert.equal(problem('{"slots":{"stack":"opus"}}'), undefined)
  assert.match(problem('{"slots":') ?? '', /not valid JSON/)
  assert.match(problem('[1]') ?? '', /JSON object/)
  assert.match(problem('"sonnet"') ?? '', /JSON object/)
})

test('a refusal from the server about the registry lands on the models field', () => {
  const form = toForm(defaultConfig(), () => 'id')
  assert.deepEqual(serverError('models.registry[0] (mine): model must have no spaces or control characters', form), { field: 'models', message: 'models.registry[0] (mine): model must have no spaces or control characters' })
  assert.deepEqual(serverError('models must be an object with registry, fallback, and slots', form).field, 'models')
})

test('the page has the Models card: its field, its error slot, its warnings, and its effective slots', async () => {
  const html = await publicFile('settings.html')
  assert.match(html, /<section id="models" class="card settings-card" aria-labelledby="models-heading">/)
  assert.match(html, /<textarea id="f-models"/)
  assert.match(html, /id="f-models-error" class="field-error" hidden/)
  assert.match(html, /id="models-warnings"/)
  assert.match(html, /id="models-effective"/)
  assert.doesNotMatch(html, /api[_-]?key|spend/i)
})

test('settings.ts reads the effective models from /api/models and keeps the field in its text bindings', async () => {
  const source = await publicFile('settings.ts')
  assert.ok(source.includes("'/api/models'"))
  assert.ok(source.includes("'models'"))
})
