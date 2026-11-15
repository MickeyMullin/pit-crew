// test/ui-models-settings.test.ts
// the Models card on the Settings page (section 6 of DESIGN.md, Settings page): the registry as a table, the pinned fallback, and one choice per slot, built from the config and serialized back to the stored models setting by pure functions, with the server's refusals placed on the control they name
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultConfig } from '../src/config.ts'
import { builtInFallbackId, builtInRegistry, modelsSaveProblem, projectModels, resolveModels } from '../src/models.ts'
import { isDirty, serverError, toConfig, toForm, validateForm } from '../public/settings-form.ts'
import {
  addCustomRow, builtInEntries, builtInSlotDefaults, editRow, fallbackChoices, modelsErrors, modelsServerError, modelsSetting, registryIds, removeRow, routeWarnings, runnerChoices, setFallback, setSlot,
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
  const noFallback = setFallback(form, '')
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
  // a hand-edited single id for a pair slot resolves to both built-in defaults on the server, so the controls show both unset
  assert.deepEqual(formOf({ slots: { review: 'opus' } }).slots.review, ['', ''])
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
  const named = (['entryId', 'runner', 'provider', 'model'] as const).reduce((current, key) => editRow(current, 'new1', key, { entryId: 'mine', runner: 'hermes', provider: 'openrouter', model: 'vendor/model-x' }[key]), form)
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
  assert.deepEqual(serverError('models.registry[7] (mine): runner must be one of claude, codex, hermes', form).field, 'models.registry.7.runner')
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

const sonnet = { id: 'sonnet', runner: 'claude', provider: 'anthropic', model: 'sonnet' }

test('only the first entry that restates a built-in entry is the read-only built-in row; a repeat of it is an editable custom row that is flagged as a repeated id', () => {
  const stored = { registry: [sonnet, sonnet] }
  const form = formOf(stored)
  assert.deepEqual(form.registry.map((row) => row.builtIn), [true, false])
  assert.equal(modelsSaveProblem(stored) !== null, true)
  assert.deepEqual(modelsErrors(form).map((error) => error.field), ['models.registry.1.id'])
  assert.match(modelsErrors(form)[0]?.message ?? '', /appears twice/)
  // the server's refusal lands on the same field, which exists because the row is editable
  const refusal = modelsServerError(modelsSaveProblem(stored) as string, form)
  assert.equal(refusal.field, 'models.registry.1.id')
})

test('removing the repeated built-in row clears the error and saves what the server accepts', () => {
  const form = formOf({ registry: [sonnet, sonnet] })
  const repeat = form.registry[1] as { rowId: string }
  const next = removeRow(form, repeat.rowId)
  assert.deepEqual(next.registry.map((row) => row.builtIn), [true])
  assert.deepEqual(modelsErrors(next), [])
  const saved = modelsSetting(next)
  assert.equal(modelsSaveProblem(saved), null)
  assert.deepEqual(saved, { registry: [sonnet] })
})

test('a repeat of a custom id, a custom row restating a built-in id differently, and an empty id are each flagged on their own field', () => {
  const twice = formOf({ registry: [entry, { ...entry }] })
  assert.deepEqual(modelsErrors(twice).map((error) => error.field), ['models.registry.1.id'])
  const differs = formOf({ registry: [{ ...sonnet, model: 'other' }] })
  assert.deepEqual(differs.registry.map((row) => row.builtIn), [false])
  assert.deepEqual(modelsErrors(differs).map((error) => error.field), ['models.registry.0.id'])
  assert.match(modelsErrors(differs)[0]?.message ?? '', /built-in model id/)
  const empty = formOf({ registry: [{ ...entry, id: '' }] })
  assert.deepEqual(modelsErrors(empty).map((error) => error.field), ['models.registry.0.id'])
})

test('a custom row that holds a built-in id with other values makes every later entry with that id a custom row too, in the server\'s order', () => {
  const stored = { registry: [{ ...sonnet, model: 'other' }, sonnet, sonnet] }
  const form = formOf(stored)
  assert.deepEqual(form.registry.map((row) => row.builtIn), [false, false, false])
  const message = modelsSaveProblem(stored) as string
  assert.equal(modelsServerError(message, form).field, 'models.registry.0.id')
})

test('a server refusal that names a read-only row never vanishes: it stays a message for the whole form', () => {
  const form = formOf(undefined)
  const refusal = modelsServerError('models.registry[0] (sonnet): id appears twice', form)
  assert.equal(refusal.field, null)
  assert.match(refusal.message, /appears twice/)
  const field = modelsServerError('models.registry[1].extra: not allowed', form)
  assert.equal(field.field, null)
  assert.match(field.message, /not allowed/)
})

// what the server resolves for a setting: each slot's ids, the fallback's id, and the registry's ids
const resolvedOf = (raw: unknown) => {
  const resolved = resolveModels(raw)
  return {
    slots: Object.fromEntries(Object.entries(resolved.slots).map(([slot, value]) => [slot, Array.isArray(value) ? value.map((model) => model.id) : value.id])),
    fallback: resolved.fallback.id,
    registry: resolved.registry.map((model) => model.id),
    warnings: resolved.warnings,
  }
}

const usable = { id: 'extra', runner: 'claude', provider: 'anthropic', model: 'sonnet' }
const setAside = { id: 'aside', runner: 'bogus', provider: 'anthropic', model: 'sonnet' }
// every shape a hand-edited file can hold that the server accepts or warns on
const handEdited: { name: string, raw: Record<string, unknown> }[] = [
  { name: 'a single id on a pair slot', raw: { slots: { review: 'opus', autoReviewHuman: 'sonnet' } } },
  { name: 'a pair with one side unknown', raw: { slots: { review: ['opus', 'nope'], autoReviewHuman: ['nope', 'gpt-6.1-sol'] } } },
  { name: 'a pair with one side empty', raw: { slots: { review: ['', 'opus'], autoReviewHuman: ['opus', ''] } } },
  { name: 'an id not in the registry on a single slot', raw: { slots: { stack: 'nope', sweep: 'nope', autoReviewBot: '' } } },
  { name: 'a fallback that names an unknown id', raw: { fallback: 'nope' } },
  { name: 'an empty fallback', raw: { fallback: '' } },
  { name: 'a pair of the wrong length, a number, and a pair on a single slot', raw: { fallback: 7, slots: { review: ['a', 'b', 'c'], autoReviewHuman: 5, stack: ['sonnet', 'opus'], sweep: { id: 'x' } } } },
  { name: 'a slots value that is not an object', raw: { slots: ['opus'] } },
  { name: 'a slot naming the id of a set-aside entry', raw: { registry: [setAside, usable], slots: { stack: 'aside', review: ['aside', 'extra'] }, fallback: 'aside' } },
  { name: 'a slot naming an id a repeat makes ambiguous', raw: { registry: [usable, { ...usable, runner: 'codex' }], slots: { stack: 'extra', review: ['extra', 'extra'] }, fallback: 'extra' } },
  { name: 'a built-in id restated differently, set aside', raw: { registry: [{ ...usable, id: 'opus', model: 'haiku' }, usable], slots: { stack: 'opus', review: ['opus', 'extra'] } } },
  { name: 'an entry the server sets aside for spaces around a field', raw: { registry: [{ ...usable, provider: ' anthropic' }, { ...usable, id: 'other' }], slots: { stack: 'extra' } } },
  { name: 'a registry that is not usable at all', raw: { registry: [setAside], slots: { stack: 'aside' } } },
  { name: 'a bare model id on both pair slots', raw: { registry: [usable], slots: { review: 'extra', autoReviewHuman: 'sonnet' } } },
]

test('a save with no edit never changes what the server resolves for any slot or the fallback, for every hand-edited shape', () => {
  for (const { name, raw } of handEdited) {
    // the config serves the projected setting, which keeps every warning; a raw one with a wrong shape is dropped, so only what it resolves must hold
    const served = projectModels(raw)
    assert.deepEqual(resolvedOf(modelsSetting(formOf(served))), resolvedOf(served), name)
    assert.deepEqual({ ...resolvedOf(modelsSetting(formOf(raw))), warnings: [] }, { ...resolvedOf(raw), warnings: [] }, name)
    // what the form writes back must pass the same save check the server applies, whenever the stored value did, and a stored bare id is written back as that bare id
    if (modelsSaveProblem(raw) === null) assert.equal(modelsSaveProblem(modelsSetting(formOf(raw))), null, name)
    const slotsOf = (raw as { slots?: Record<string, unknown> }).slots
    for (const slot of ['review', 'autoReviewHuman']) if (typeof slotsOf?.[slot] === 'string') assert.equal((modelsSetting(formOf(raw))?.slots as Record<string, unknown>)[slot], slotsOf[slot], `${name}: ${slot}`)
  }
})

test('changing one control leaves every untouched slot and the fallback resolving as before, for every hand-edited shape', () => {
  for (const { name, raw } of handEdited) {
    const base = resolvedOf(raw)
    const withExtra = addCustomRow(formOf(projectModels(raw)), 'add')
    const filled = (['entryId', 'runner', 'provider', 'model'] as const).reduce((current, key) => editRow(current, 'add', key, { entryId: 'brand-new', runner: 'claude', provider: 'anthropic', model: 'sonnet' }[key]), withExtra)
    const touched = setSlot(filled, slotControls.find((candidate) => candidate.field === 'models.slots.sweep') as (typeof slotControls)[number], 'brand-new')
    const after = resolvedOf(modelsSetting(touched))
    assert.equal(after.slots.sweep, 'brand-new', name)
    assert.deepEqual({ ...after.slots, sweep: null }, { ...base.slots, sweep: null }, name)
    assert.equal(after.fallback, base.fallback, name)
  }
  // touching one control of a pair slot rewrites that pair from its controls, and the other side still resolves as it did
  const single = setSlot(formOf({ slots: { review: 'opus' } }), control('models.slots.review.1'), 'gpt-6.1-sol')
  assert.deepEqual(resolvedOf(modelsSetting(single)).slots.review, ['sonnet', 'gpt-6.1-sol'])
  const unknown = setSlot(formOf({ slots: { review: ['opus', 'nope'] } }), control('models.slots.review.0'), 'sonnet')
  assert.deepEqual(resolvedOf(modelsSetting(unknown)).slots.review, ['sonnet', 'gpt-6.1-terra'])
  // the fallback is rewritten only when its own choice is touched
  assert.deepEqual(modelsSetting(formOf({ fallback: 'nope' })), { fallback: 'nope' })
  assert.deepEqual(modelsSetting(setFallback(formOf({ fallback: 'nope' }), 'sonnet')), { fallback: 'sonnet' })
  assert.equal(modelsSetting(setFallback(formOf({ fallback: 'nope' }), '')), undefined)
})

test('a row the owner did not edit is written as stored, so a field the server sets aside is not made valid by a trim', () => {
  const raw = { registry: [{ ...usable, provider: ' anthropic' }, { ...usable, id: 'other' }] }
  assert.deepEqual(modelsSetting(formOf(raw)), raw)
  const edited = editRow(formOf(raw), formOf(raw).registry[1]?.rowId as string, 'model', 'opus')
  assert.equal(modelsSetting(edited) !== undefined, true)
})

test('the controls offer only the ids the server would keep, and show a slot naming any other id as not in the registry', () => {
  const form = formOf({ registry: [setAside, usable, { ...usable, runner: 'codex' }, { ...usable, id: 'late' }] })
  assert.deepEqual(registryIds(form), ['extra', 'late'])
  const named = slotChoices(form, 'aside', 'sonnet')
  assert.deepEqual(named.at(-1), { value: 'aside', label: 'aside (not in the registry)' })
})

test('a row with several problems shows its field problems first, and the repeated-id message only when no field of the row has an error', () => {
  const form = formOf({ registry: [entry, { ...entry, runner: 'other' }, { ...entry, id: 'sonnet', model: 'haiku' }, { ...entry }] })
  assert.deepEqual(modelsErrors(form).map((error) => [error.field, error.message]), [
    ['models.registry.1.runner', 'Runner must be one of claude, codex, hermes.'],
    ['models.registry.2.id', modelsErrors(form)[1]?.message],
    ['models.registry.3.id', 'Id appears twice.'],
  ])
  // the first row to hold an id is never a repeat, and a later exact restatement after a custom row holding that built-in id is an editable repeat
  const restated = formOf({ registry: [{ ...entry, id: 'sonnet', model: 'haiku' }, builtInRegistry[0]] })
  assert.deepEqual(restated.registry.map((row) => row.builtIn), [false, false])
  assert.deepEqual(modelsErrors(restated).map((error) => error.field), ['models.registry.0.id', 'models.registry.1.id'])
})
