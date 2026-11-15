// test/ui-modelsview.test.ts
// the Models card's elements on the fake page in test/fake-dom.ts: a built-in registry row is text with no control, a custom row has a control for each field and a Remove, and the fallback and each slot are one labeled choice with what the server reads and its warnings beside it
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addCustomRow, builtInEntries, editRow, slotChoices, toModelsForm } from '../public/models-form.ts'
import { choiceField, registryRow } from '../public/modelsview.ts'
import { installFakeBrowser, press, typeInto } from './fake-dom.ts'
import type { FakeElement } from './fake-dom.ts'

// the page's builders answer real element types; under the fake page they are fake elements
const fake = (element: unknown): FakeElement => element as FakeElement

const withPage = (check: () => void): void => {
  const fake = installFakeBrowser((async () => new Response('{}')) as typeof fetch)
  try {
    check()
  } finally {
    fake.restore()
  }
}

test('a built-in row is read-only text marked built-in, and a custom row edits and removes through its controls', () => withPage(() => {
  const calls: string[] = []
  const handlers = { edit: (id: string, field: string, value: string) => calls.push(`edit ${id} ${field} ${value}`), remove: (id: string) => calls.push(`remove ${id}`) }
  const form = editRow(addCustomRow(toModelsForm(undefined, (() => { let n = 0; return () => `b${++n}` })()), 'c1'), 'c1', 'entryId', 'mine')
  const builtIn = fake(registryRow(form.registry[0]!, 0, true, handlers))
  assert.equal(builtIn.querySelectorAll('input').length + builtIn.querySelectorAll('select').length + builtIn.querySelectorAll('button').length, 0)
  assert.match(builtIn.textContent, /sonnet/)
  assert.match(builtIn.textContent, /Built-in/)
  const custom = fake(registryRow(form.registry[builtInEntries.length]!, builtInEntries.length, false, handlers))
  assert.equal(custom.querySelectorAll('input').length, 3)
  assert.deepEqual(custom.querySelectorAll('option').map((option) => option.getAttribute('value')), ['claude', 'codex', 'hermes'])
  const [id, provider, model] = custom.querySelectorAll('input') as [FakeElement, FakeElement, FakeElement]
  typeInto(id, 'other')
  typeInto(provider, 'openrouter')
  typeInto(model, 'vendor/model-x')
  const runner = custom.querySelector('select') as FakeElement
  runner.value = 'hermes'
  runner.dispatch('change')
  press(custom.querySelector('button') as FakeElement)
  assert.deepEqual(calls, ['edit c1 entryId other', 'edit c1 provider openrouter', 'edit c1 model vendor/model-x', 'edit c1 runner hermes', 'remove c1'])
  assert.equal(custom.querySelector('button')?.getAttribute('aria-label'), 'Remove mine')
}))

test('a slot control is a labeled choice among registry ids with what the server reads and its warnings beside it', () => withPage(() => {
  const changes: string[] = []
  const form = toModelsForm(undefined, () => 'r')
  const field = fake(choiceField({
    field: 'models.slots.stack',
    label: 'Stack review',
    value: '',
    choices: slotChoices(form, '', 'sonnet'),
    onChange: (value) => changes.push(value),
    asRead: 'sonnet',
    warnings: ['Slot stack names gone, which is not in the registry, so sonnet is used.'],
  }))
  assert.equal(field.querySelector('label')?.textContent, 'Stack review')
  assert.equal(field.querySelector('label')?.getAttribute('for'), 'f-models-slots-stack')
  const select = field.querySelector('select') as FakeElement
  assert.equal(select.id, 'f-models-slots-stack')
  assert.deepEqual(select.querySelectorAll('option').map((option) => option.textContent), ['Built-in default (sonnet)', ...builtInEntries.map((entry) => entry.id)])
  select.value = 'opus'
  select.dispatch('change')
  assert.deepEqual(changes, ['opus'])
  assert.equal(field.querySelector('#f-models-slots-stack-read')?.textContent, 'As read: sonnet')
  assert.equal(field.querySelector('#f-models-slots-stack-error')?.hidden, true)
  assert.match(field.querySelector('#f-models-slots-stack-warnings')?.textContent ?? '', /Slot stack names gone/)
  assert.equal(select.getAttribute('aria-describedby'), 'f-models-slots-stack-read')
}))
