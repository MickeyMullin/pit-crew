// test/ui-models-settings.test.ts
// the Models card on the Settings page (section 6 of DESIGN.md, Settings page): the registry as a table, the pinned fallback, and one choice per slot, built from the config and serialized back to the stored models setting by pure functions, with the server's refusals placed on the control they name
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultConfig } from '../src/config.ts'
import { builtInFallbackId, builtInRegistry, modelsSaveProblem, resolveModels } from '../src/models.ts'
import { isDirty, serverError, toConfig, toForm, validateForm } from '../public/settings-form.ts'
import {
  addCustomRow, builtInEntries, builtInSlotDefaults, editRow, fallbackChoices, modelsErrors, modelsServerError, modelsSetting, removeRow, routeWarnings, runnerChoices, setSlot,
  slotAsRead, slotChoices, slotControls, toModelsForm,
} from '../public/models-form.ts'
import type { ModelsForm } from '../public/models-form.ts'

const publicFile = (name: string): Promise<string> => readFile(join(import.meta.dirname, '..', 'public', name), 'utf8')

const entry = { id: 'mine', runner: 'hermes', provider: 'openrouter', model: 'vendor/model-x' }
const ids = (): (() => string) => {
  let count = 0
  return () => `r${++count}`
}
const formOf = (raw: unknown): ModelsForm => toModelsForm(raw, ids())
const control = (field: string) => slotControls.find((candidate) => candidate.field === field) as (typeof slotControls)[number]

test('the page keeps a copy of the built-in table and the defaults, and a test keeps it in step with src/models.ts', () => {
  assert.deepEqual(builtInEntries, builtInRegistry)
  const resolved = resolveModels(undefined)
  assert.equal(builtInFallbackId, resolved.fallback.id)
  assert.deepEqual(builtInSlotDefaults.review, resolved.slots.review.map((model) => model.id))
  assert.deepEqual(builtInSlotDefaults.autoReviewHuman, resolved.slots.autoReviewHuman.map((model) => model.id))
  assert.equal(builtInSlotDefaults.stack, resolved.slots.stack.id)
  assert.equal(builtInSlotDefaults.sweep, resolved.slots.sweep.id)
  assert.equal(builtInSlotDefaults.autoReviewBot, resolved.slots.autoReviewBot.id)
})

test('the empty setting shows the built-in models: every built-in row read-only, nothing set, and nothing to save', () => {
  const form = formOf(undefined)
  assert.deepEqual(form.registry.map((row) => [row.entryId, row.builtIn]), builtInRegistry.map((model) => [model.id, true]))
  assert.deepEqual(form.registry.map((row) => [row.runner, row.provider, row.model]), builtInRegistry.map((model) => [model.runner, model.provider, model.model]))
  assert.equal(form.fallback, '')
  assert.deepEqual(slotControls.map((one) => [one.field, one.defaultId]), [
    ['models.slots.review.0', 'sonnet'], ['models.slots.review.1', 'gpt-6.1-terra'],
    ['models.slots.autoReviewHuman.0', 'sonnet'], ['models.slots.autoReviewHuman.1', 'gpt-6.1-terra'],
    ['models.slots.stack', 'sonnet'], ['models.slots.sweep', 'sonnet'], ['models.slots.autoReviewBot', 'sonnet'],
  ])
  assert.equal(modelsSetting(form), undefined)
  const saved = defaultConfig()
  const whole = toForm(saved, () => 'id')
  assert.equal('models' in toConfig(whole, saved), false)
  assert.equal(isDirty(whole, saved), false)
})

test('a non-object, a list, and an empty registry read as the empty setting', () => {
  for (const raw of [null, 'x', 7, true, [entry], { registry: [] }, { registry: 'x' }, {}]) {
    const form = formOf(raw)
    assert.equal(form.registry.length, builtInRegistry.length)
    assert.equal(modelsSetting(form), undefined)
  }
})

test('a stored setting fills each control and serializes back to exactly the stored shape', () => {
  const raw = { registry: [entry], fallback: 'mine', slots: { review: ['mine', 'mine'], stack: 'mine', autoReviewBot: 'mine' } }
  const form = formOf(raw)
  assert.deepEqual(form.registry.map((row) => [row.builtIn, row.entryId, row.runner, row.provider, row.model]), [[false, 'mine', 'hermes', 'openrouter', 'vendor/model-x']])
  assert.equal(form.fallback, 'mine')
  assert.equal(form.slots.stack, 'mine')
  assert.equal(form.slots.sweep, '')
  assert.deepEqual(form.slots.review, ['mine', 'mine'])
  assert.deepEqual(modelsSetting(form), raw)
  const saved = { ...defaultConfig(), models: raw }
  const whole = toForm(saved, () => 'id')
  assert.deepEqual(toConfig(whole, saved).models, raw)
  assert.equal(isDirty(whole, saved), false)
})

test('an entry that restates a built-in entry exactly is that built-in row, read-only, and a registry of built-ins in table order is the empty registry', () => {
  const restated = formOf({ registry: [...builtInRegistry, entry] })
  assert.deepEqual(restated.registry.map((row) => row.builtIn), [true, true, true, true, true, true, true, false])
  assert.deepEqual(modelsSetting(restated), { registry: [...builtInRegistry, entry] })
  assert.equal(modelsSetting(formOf({ registry: [...builtInRegistry] })), undefined)
  // a registry the owner trimmed by hand stays as it is, so saving never changes which models a slot can name
  const trimmed = formOf({ registry: [builtInRegistry[0], entry] })
  assert.deepEqual(trimmed.registry.map((row) => row.entryId), ['sonnet', 'mine'])
  assert.deepEqual(modelsSetting(trimmed), { registry: [builtInRegistry[0], entry] })
})

test('an unset control leaves its key out, and each part is left out when nothing in it is set', () => {
  const form = formOf({ fallback: 'sonnet', slots: { stack: 'opus', sweep: 'opus' } })
  assert.deepEqual(modelsSetting(form), { fallback: 'sonnet', slots: { stack: 'opus', sweep: 'opus' } })
  const noFallback = { ...form, fallback: '' }
  assert.deepEqual(modelsSetting(noFallback), { slots: { stack: 'opus', sweep: 'opus' } })
  const noStack = setSlot(noFallback, control('models.slots.stack'), '')
  assert.deepEqual(modelsSetting(noStack), { slots: { sweep: 'opus' } })
  const none = setSlot(noStack, control('models.slots.sweep'), '')
  assert.equal(modelsSetting(none), undefined)
})

test('a pair slot is saved as a pair: both unset leaves it out, and one set takes the built-in default for the other', () => {
  const form = formOf(undefined)
  const primary = setSlot(form, control('models.slots.review.0'), 'opus')
  assert.deepEqual(modelsSetting(primary), { slots: { review: ['opus', 'gpt-6.1-terra'] } })
  const secondary = setSlot(form, control('models.slots.autoReviewHuman.1'), 'gpt-6.1-sol')
  assert.deepEqual(modelsSetting(secondary), { slots: { autoReviewHuman: ['sonnet', 'gpt-6.1-sol'] } })
  assert.equal(modelsSetting(setSlot(primary, control('models.slots.review.0'), '')), undefined)
  // a hand-edited single id for a pair slot reads as the primary
  assert.deepEqual(formOf({ slots: { review: 'opus' } }).slots.review, ['opus', ''])
})

test('adding, editing, and removing a custom entry changes the registry and nothing else', () => {
  const start = formOf(undefined)
  const added = addCustomRow(start, 'new1')
  assert.equal(added.registry.length, builtInRegistry.length + 1)
  const row = added.registry[added.registry.length - 1]
  assert.deepEqual([row?.rowId, row?.builtIn, row?.entryId, row?.provider, row?.model], ['new1', false, '', '', ''])
  assert.equal(start.registry.length, builtInRegistry.length)
  const edited = editRow(editRow(editRow(editRow(added, 'new1', 'entryId', ' mine '), 'new1', 'runner', 'hermes'), 'new1', 'provider', 'openrouter'), 'new1', 'model', 'vendor/model-x')
  assert.deepEqual(modelsSetting(edited), { registry: [...builtInRegistry, entry] })
  assert.deepEqual(modelsErrors(edited), [])
  const again = editRow(edited, 'new1', 'model', 'vendor/model-y')
  assert.deepEqual(modelsSetting(again), { registry: [...builtInRegistry, { ...entry, model: 'vendor/model-y' }] })
  const removed = removeRow(again, 'new1')
  assert.equal(removed.registry.length, builtInRegistry.length)
  assert.equal(modelsSetting(removed), undefined)
})

test('a built-in row cannot be edited or removed', () => {
  const form = formOf(undefined)
  const first = form.registry[0]?.rowId as string
  assert.deepEqual(editRow(form, first, 'model', 'opus'), form)
  assert.deepEqual(editRow(form, first, 'entryId', 'other'), form)
  assert.deepEqual(removeRow(form, first), form)
  assert.equal(modelsSetting(editRow(form, first, 'model', 'opus')), undefined)
})

test('the controls offer registry ids only, show the built-in default when unset, and keep a slot that names an id the registry lacks', () => {
  const form = addCustomRow(formOf(undefined), 'new1')
  const blank = slotChoices(form, '', 'sonnet')
  assert.deepEqual(blank[0], { value: '', label: 'Built-in default (sonnet)' })
  assert.deepEqual(blank.slice(1).map((choice) => choice.value), builtInRegistry.map((model) => model.id))
  const named = editRow(form, 'new1', 'entryId', 'mine')
  assert.deepEqual(slotChoices(named, '', 'sonnet').map((choice) => choice.value), ['', ...builtInRegistry.map((model) => model.id), 'mine'])
  const unknown = slotChoices(named, 'gone', 'sonnet')
  assert.deepEqual(unknown[unknown.length - 1], { value: 'gone', label: 'gone (not in the registry)' })
  assert.deepEqual(fallbackChoices(named, '')[0], { value: '', label: 'Built-in default (kimi-code)' })
  assert.deepEqual(fallbackChoices(named, 'gone').at(-1), { value: 'gone', label: 'gone (not in the registry)' })
  // the kept id saves as stored, and nothing the registry offers is changed by it
  assert.deepEqual(modelsSetting(formOf({ slots: { stack: 'gone' } })), { slots: { stack: 'gone' } })
})

test('the runner is a choice of claude, codex, or hermes, and an unreadable stored runner is kept until another is chosen', () => {
  assert.deepEqual(runnerChoices('hermes').map((choice) => choice.value), ['claude', 'codex', 'hermes'])
  assert.deepEqual(runnerChoices('').map((choice) => choice.value), ['', 'claude', 'codex', 'hermes'])
  assert.equal(runnerChoices('').at(0)?.label, 'Choose a runner')
  assert.deepEqual(runnerChoices('other').map((choice) => choice.value), ['other', 'claude', 'codex', 'hermes'])
})

test('nothing in the form can carry a key, a secret, a token, or a password', () => {
  const hostile = {
    registry: [{ ...entry, apiKey: 'a', token: 't', password: 'p', secret: 's', nested: { key: 'k' } }],
    fallback: 'mine',
    slots: { review: ['mine', 'mine'], stack: 'mine', password: 'x' },
    secret: 'z',
  }
  const form = formOf(hostile)
  assert.deepEqual(Object.keys(form.registry[0] ?? {}).sort(), ['builtIn', 'entryId', 'model', 'provider', 'rowId', 'runner'])
  const text = JSON.stringify(modelsSetting(form))
  assert.doesNotMatch(text, /key|token|password|secret/i)
  assert.deepEqual(modelsSetting(form), { registry: [entry], fallback: 'mine', slots: { review: ['mine', 'mine'], stack: 'mine' } })
  assert.equal(modelsSaveProblem(modelsSetting(form)), null)
})

// each case is an entry the server refuses, with the control the page puts the reason on; the page's check and the server's save check must agree
const refused: { name: string, entry: Record<string, string>, field: string }[] = [
  { name: 'a bad id', entry: { ...entry, id: '-bad id' }, field: 'models.registry.8.id' },
  { name: 'an empty id', entry: { ...entry, id: '' }, field: 'models.registry.8.id' },
  { name: 'a built-in id restated differently', entry: { ...entry, id: 'sonnet' }, field: 'models.registry.8.id' },
  { name: 'a bad runner', entry: { ...entry, runner: 'other' }, field: 'models.registry.8.runner' },
  { name: 'an unset runner', entry: { ...entry, runner: '' }, field: 'models.registry.8.runner' },
  { name: 'a bad provider', entry: { ...entry, provider: 'open router' }, field: 'models.registry.8.provider' },
  { name: 'an empty provider', entry: { ...entry, provider: '' }, field: 'models.registry.8.provider' },
  { name: 'a model with a space', entry: { ...entry, model: 'vendor/model x' }, field: 'models.registry.8.model' },
  { name: 'a model that starts with a dash', entry: { ...entry, model: '--flag' }, field: 'models.registry.8.model' },
  { name: 'an empty model', entry: { ...entry, model: '' }, field: 'models.registry.8.model' },
  { name: 'a model that is too long', entry: { ...entry, model: 'm'.repeat(201) }, field: 'models.registry.8.model' },
]

test('the page refuses what the server refuses, on the same control and in the server\'s words', () => {
  for (const { name, entry: bad, field } of refused) {
    const rows = [['entryId', bad.id], ['runner', bad.runner], ['provider', bad.provider], ['model', bad.model]].reduce(
      (current, [key, value]) => editRow(current, 'bad', key as 'entryId', value as string),
      addCustomRow(formOf({ registry: [...builtInRegistry, entry] }), 'bad'),
    )
    const index = rows.registry.length - 1
    const server = modelsSaveProblem(modelsSetting(rows))
    assert.notEqual(server, null, name)
    const errors = modelsErrors(rows).filter((error) => error.field === `models.registry.${index}.${field.split('.').pop()}`)
    assert.equal(errors.length, 1, name)
    const reason = (server as string).replace(/^models\.registry\[\d+\] \([^)]*\): /, '')
    assert.equal(errors[0]?.message, `${reason[0]?.toUpperCase()}${reason.slice(1)}.`, name)
    // the same refusal arriving from the server lands on the same control
    assert.deepEqual(modelsServerError(server as string, rows), errors[0], name)
  }
})

test('a repeated id is refused on the later row, and an entry the server accepts is accepted by the page', () => {
  const twice = editRow(addCustomRow(formOf({ registry: [...builtInRegistry, entry] }), 'dup'), 'dup', 'entryId', 'mine')
  const filled = (['runner', 'provider', 'model'] as const).reduce((current, key) => editRow(current, 'dup', key, entry[key]), twice)
  assert.equal(modelsSaveProblem(modelsSetting(filled)) !== null, true)
  assert.deepEqual(modelsErrors(filled).map((error) => error.field), ['models.registry.8.id'])
  assert.deepEqual(modelsServerError(modelsSaveProblem(modelsSetting(filled)) as string, filled)?.field, 'models.registry.8.id')
  assert.deepEqual(modelsErrors(formOf({ registry: [...builtInRegistry, entry], fallback: 'mine', slots: { stack: 'mine' } })), [])
  // the restated built-in entries and the empty setting are never errors
  assert.deepEqual(modelsErrors(formOf(undefined)), [])
})

test('validateForm carries the registry errors, and a refusal from the server lands on the field or row it names', () => {
  const form = toForm(defaultConfig(), () => 'id')
  form.models = addCustomRow(form.models, 'row')
  assert.equal(validateForm(form).some((error) => error.field === `models.registry.${builtInRegistry.length}.id`), true)
  const refusal = 'models.registry[7] (mine): model must have no spaces or control characters'
  form.models = formOf({ registry: [...builtInRegistry, entry] })
  assert.deepEqual(serverError(refusal, form), { field: 'models.registry.7.model', message: 'Model must have no spaces or control characters.' })
  assert.deepEqual(serverError('models.registry[0] (sonnet): runner must be one of claude, codex, hermes', form).field, 'models.registry.0.runner')
  assert.deepEqual(serverError('models.registry[7] (mine): id appears twice', form).field, 'models.registry.7.id')
  assert.deepEqual(serverError('models.registry[7] (mine): provider must be letters, digits, dots, underscores, and dashes, such as anthropic', form).field, 'models.registry.7.provider')
  assert.deepEqual(serverError('models.registry[7] (mine): an entry must be an object with id, runner, provider, and model', form).field, 'models.registry.7.id')
  assert.deepEqual(serverError('models.registry must be a list of entries', form), { field: 'models.registry', message: 'Must be a list of entries.' })
  assert.deepEqual(serverError('models.fallback must be a model id, a string of at most 200 characters', form).field, 'models.fallback')
  assert.deepEqual(serverError('models.slots.stack must be one model id, strings of at most 200 characters', form), { field: 'models.slots.stack', message: 'Must be one model id, strings of at most 200 characters.' })
  assert.deepEqual(serverError('models.slots.review must be a model id or a pair of two model ids, strings of at most 200 characters', form).field, 'models.slots.review.0')
  assert.deepEqual(serverError('models.slots.autoReviewHuman must be a model id or a pair of two model ids, strings of at most 200 characters', form).field, 'models.slots.autoReviewHuman.0')
  // a row the form no longer has, and a refusal about the whole value, stay messages for the whole form
  assert.equal(serverError('models.registry[40] (mine): id appears twice', form).field, null)
  assert.equal(serverError('models must be an object with registry, fallback, and slots', form).field, null)
  assert.match(serverError('models must be an object with registry, fallback, and slots', form).message, /^models must be an object/i)
  // a credential-like key cannot come from these controls, but a refusal of one names the row it is in
  assert.equal(serverError('models.registry[7].apiKey: a field named apiKey looks like a credential, and the models setting never holds a key, a key reference, a token, or a secret; remove it', form).field, 'models.registry.7.id')
})

test('warnings go beside the control they describe, and the rest stay at the top of the card', () => {
  const routed = routeWarnings([
    'Registry entry bad is ignored: runner must be one of claude, codex, hermes.',
    'Registry entry bad appears twice, so the first one stands.',
    'models.registry holds no usable entry, so the built-in table is used',
    'models.registry must be a list of entries, so the built-in table is used',
    'The pinned fallback gone is not in the registry, so kimi-code is used.',
    'Slot stack names gone, which is not in the registry, so sonnet is used.',
    'Slot review names gone, which is not in the registry, so sonnet is used.',
    'Slot review holds a pair of models, primary and secondary, so sonnet and gpt-6.1-terra are used.',
    'Slot autoReviewBot holds one model, so sonnet is used.',
    'models.slots must be an object, so every slot takes its built-in default',
    'models must be an object with registry, fallback, and slots, so the built-in models are used',
  ])
  assert.equal(routed.registry.length, 4)
  assert.deepEqual(routed.fallback, ['The pinned fallback gone is not in the registry, so kimi-code is used.'])
  assert.equal(routed.slots.stack.length, 1)
  assert.equal(routed.slots.review.length, 2)
  assert.equal(routed.slots.autoReviewBot.length, 1)
  assert.deepEqual(routed.slots.sweep, [])
  assert.deepEqual(routed.general, ['models.slots must be an object, so every slot takes its built-in default', 'models must be an object with registry, fallback, and slots, so the built-in models are used'])
})

test('each control shows what the server reads from the saved setting, and the pinned fallback does too', () => {
  const view = {
    registry: [...builtInRegistry],
    fallback: builtInRegistry[5] as (typeof builtInRegistry)[number],
    slots: { review: ['opus', 'gpt-6.1-sol'] as [string, string], stack: 'sonnet', sweep: 'opus', autoReviewHuman: ['sonnet', 'gpt-6.1-terra'] as [string, string], autoReviewBot: 'opus' },
    warnings: [],
  }
  assert.equal(slotAsRead(view, control('models.slots.review.0')), 'opus')
  assert.equal(slotAsRead(view, control('models.slots.review.1')), 'gpt-6.1-sol')
  assert.equal(slotAsRead(view, control('models.slots.autoReviewHuman.1')), 'gpt-6.1-terra')
  assert.equal(slotAsRead(view, control('models.slots.sweep')), 'opus')
  assert.equal(slotAsRead(null, control('models.slots.sweep')), null)
})

test('the card has labeled controls for the pinned fallback and every slot, in the words the page already uses', () => {
  assert.deepEqual(slotControls.map((one) => one.label), [
    'Review, primary', 'Review, secondary', 'Auto-review of people, primary', 'Auto-review of people, secondary', 'Stack review', 'Dependabot sweep', 'Auto-review of bots',
  ])
})

test('the page has the Models card with a registry table, a fallback choice, and slot controls, and no JSON text area or editor', async () => {
  const html = await publicFile('settings.html')
  const card = html.slice(html.indexOf('<section id="models"'), html.indexOf('</section>', html.indexOf('<section id="models"')))
  assert.match(card, /<section id="models" class="card settings-card" aria-labelledby="models-heading">/)
  assert.match(card, /id="models-registry"/)
  assert.match(card, /id="add-model"/)
  assert.match(card, /id="f-models-registry-error" class="field-error" hidden/)
  assert.match(card, /id="models-fallback"/)
  assert.match(card, /id="models-slots"/)
  assert.match(card, /id="models-warnings"/)
  assert.doesNotMatch(card, /<textarea/)
  assert.doesNotMatch(card, /json/i)
  assert.doesNotMatch(card, /api[_-]?key|spend|secret|token|password/i)
  const source = await publicFile('settings.ts')
  assert.ok(source.includes("'/api/models'"))
  assert.doesNotMatch(source, /fieldId\('models'\)|parseModels|JSON\.parse/)
})

test('the hint is reduced to the posted-text name check and to no start reading the slots yet', async () => {
  const html = await publicFile('settings.html')
  const hint = html.slice(html.indexOf('id="models-hint"'), html.indexOf('</p>', html.indexOf('id="models-hint"'))).replace(/<[^>]+>/g, '')
  assert.match(hint, /no start reads these slots yet/i)
  assert.match(hint, /the Post it offer and the post of a stored report/)
  assert.match(hint, /governed by the review prompt/)
  assert.doesNotMatch(hint, /four fields|JSON|restate/)
  assert.ok(hint.length < 700, `the hint is ${hint.length} characters`)
})
