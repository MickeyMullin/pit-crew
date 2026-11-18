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
  addCustomRow, builtInEntries, builtInSlotDefaults, choicesNeedRedraw, editRow, fallbackChoices, modelsErrors, modelsServerError, modelsSetting, readOnlyChanged, readOnlyRows, registryIds, removeRow, routeWarnings, runnerChoices, setFallback, setSlot,
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
  assert.deepEqual(form.registry.map((row, at) => [row.entryId, readOnlyRows(form)[at]]), builtInRegistry.map((model) => [model.id, true]))
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
  assert.deepEqual(form.registry.map((row, at) => [readOnlyRows(form)[at], row.entryId, row.runner, row.provider, row.model]), [[false, 'mine', 'hermes', 'openrouter', 'vendor/model-x']])
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
  assert.deepEqual(readOnlyRows(restated), [true, true, true, true, true, true, true, false])
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
  assert.deepEqual([row?.rowId, readOnlyRows(added)[added.registry.length - 1], row?.entryId, row?.provider, row?.model], ['new1', false, '', '', ''])
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
  assert.deepEqual(Object.keys(form.registry[0] ?? {}).sort(), ['entryId', 'model', 'provider', 'rowId', 'runner'])
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
  assert.match(hint, /no start passes these models yet/i)
  assert.match(hint, /auto-review of people pair, which must have a primary on Claude and two different models/)
  assert.match(hint, /the Post it offer and the post of a stored report/)
  assert.match(hint, /governed by the review prompt/)
  assert.match(hint, /stops the first Post click/)
  assert.match(hint, /a second click on that same refusal posts it/)
  assert.doesNotMatch(hint, /is refused when it names/)
  assert.doesNotMatch(hint, /four fields|JSON|restate/)
  assert.ok(hint.length < 700, `the hint is ${hint.length} characters`)
})

const sonnet = { id: 'sonnet', runner: 'claude', provider: 'anthropic', model: 'sonnet' }

test('only the first entry that restates a built-in entry is the read-only built-in row; a repeat of it is an editable custom row that is flagged as a repeated id', () => {
  const stored = { registry: [sonnet, sonnet] }
  const form = formOf(stored)
  assert.deepEqual(readOnlyRows(form), [true, false])
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
  assert.deepEqual(readOnlyRows(next), [true])
  assert.deepEqual(modelsErrors(next), [])
  const saved = modelsSetting(next)
  assert.equal(modelsSaveProblem(saved), null)
  assert.deepEqual(saved, { registry: [sonnet] })
})

test('a repeat of a custom id, a custom row restating a built-in id differently, and an empty id are each flagged on their own field', () => {
  const twice = formOf({ registry: [entry, { ...entry }] })
  assert.deepEqual(modelsErrors(twice).map((error) => error.field), ['models.registry.1.id'])
  const differs = formOf({ registry: [{ ...sonnet, model: 'other' }] })
  assert.deepEqual(readOnlyRows(differs), [false])
  assert.deepEqual(modelsErrors(differs).map((error) => error.field), ['models.registry.0.id'])
  assert.match(modelsErrors(differs)[0]?.message ?? '', /built-in model id/)
  const empty = formOf({ registry: [{ ...entry, id: '' }] })
  assert.deepEqual(modelsErrors(empty).map((error) => error.field), ['models.registry.0.id'])
})

test('a custom row that holds a built-in id with other values holds nothing, so the first exact restatement after it is the read-only row and the next is the repeat, and the server names the earlier row first', () => {
  const stored = { registry: [{ ...sonnet, model: 'other' }, sonnet, sonnet] }
  const form = formOf(stored)
  assert.deepEqual(readOnlyRows(form), [false, true, false])
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
    // a stored bare id is written back as that bare id
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
  // the first row to hold an id is never a repeat, an exact restatement after a row that fails its own checks is the read-only row, and a repeat is named only against a row that stood, as the server names only the first row it refuses
  const restated = formOf({ registry: [{ ...entry, id: 'sonnet', model: 'haiku' }, builtInRegistry[0]] })
  assert.deepEqual(readOnlyRows(restated), [false, true])
  assert.deepEqual(modelsErrors(restated).map((error) => error.field), ['models.registry.0.id'])
})

// the page's own sequence for an edit: the new form from the control's operation, then the decision the page makes from the two forms
const registryEdits: { name: string, form: ModelsForm, apply: (form: ModelsForm) => ModelsForm, redraw: boolean }[] = (() => {
  const valid = { entryId: 'extra', runner: 'claude', provider: 'anthropic', model: 'sonnet' }
  const withRow = (fields: Partial<typeof valid>): ModelsForm => {
    const base = addCustomRow(formOf(undefined), 'row')
    return (Object.entries({ ...valid, ...fields }) as [keyof typeof valid, string][]).reduce((current, [key, value]) => editRow(current, 'row', key, value), base)
  }
  const edit = (field: 'entryId' | 'runner' | 'provider' | 'model', value: string) => (form: ModelsForm): ModelsForm => editRow(form, 'row', field, value)
  return [
    { name: 'adding a blank row names nothing yet', form: formOf(undefined), apply: (form) => addCustomRow(form, 'row'), redraw: false },
    { name: 'a new id on a valid row', form: withRow({}), apply: edit('entryId', 'other'), redraw: true },
    { name: 'an id typed first, on a row that is still invalid, adds nothing', form: withRow({ entryId: '', provider: '', model: '' }), apply: edit('entryId', 'extra'), redraw: false },
    { name: 'the provider typed after the id makes the row valid when the model is there', form: withRow({ provider: '' }), apply: edit('provider', 'anthropic'), redraw: true },
    { name: 'the model typed last makes the row valid', form: withRow({ model: '' }), apply: edit('model', 'sonnet'), redraw: true },
    { name: 'a runner chosen makes the row valid', form: withRow({ runner: '' }), apply: edit('runner', 'codex'), redraw: true },
    { name: 'an id made bad makes the row invalid', form: withRow({}), apply: edit('entryId', '-bad'), redraw: true },
    { name: 'a runner made bad makes the row invalid', form: withRow({}), apply: edit('runner', 'bogus'), redraw: true },
    { name: 'a provider emptied makes the row invalid', form: withRow({}), apply: edit('provider', ''), redraw: true },
    { name: 'a model emptied makes the row invalid', form: withRow({}), apply: edit('model', ''), redraw: true },
    { name: 'a model changed on a valid row changes no id', form: withRow({}), apply: edit('model', 'opus'), redraw: false },
    { name: 'a provider changed on a valid row changes no id', form: withRow({}), apply: edit('provider', 'openai'), redraw: false },
    { name: 'a runner changed on a valid row changes no id', form: withRow({}), apply: edit('runner', 'hermes'), redraw: false },
    { name: 'a model changed on an invalid row changes no id', form: withRow({ provider: '' }), apply: edit('model', 'opus'), redraw: false },
    { name: 'a valid row becoming a repeat of an earlier id stops naming anything new', form: withRow({ entryId: 'other' }), apply: (form) => editRow(addCustomRow(form, 'second'), 'second', 'entryId', 'x'), redraw: false },
    { name: 'removing a valid row', form: withRow({}), apply: (form) => removeRow(form, 'row'), redraw: true },
    { name: 'removing an invalid row', form: withRow({ model: '' }), apply: (form) => removeRow(form, 'row'), redraw: false },
    { name: 'removing a repeat of an id another row holds', form: addCustomRow(withRow({}), 'again'), apply: (form) => removeRow(editRow(editRow(editRow(editRow(form, 'again', 'entryId', 'extra'), 'again', 'provider', 'anthropic'), 'again', 'model', 'sonnet'), 'again', 'runner', 'claude'), 'again'), redraw: false },
  ]
})()

test('the choices are redrawn exactly when the ids they offer changed, for an edit of each field, an add, a remove, and a row turning valid or invalid', () => {
  for (const { name, form, apply, redraw } of registryEdits) {
    const after = apply(form)
    assert.equal(choicesNeedRedraw(form, after), redraw, name)
    assert.equal(redraw, JSON.stringify(registryIds(form)) !== JSON.stringify(registryIds(after)), name)
  }
})

test('typing an id first and then the provider and model makes the new id appear among the offered ids only once the row is valid', () => {
  let form = addCustomRow(formOf(undefined), 'row')
  const steps: [typeof registryEdits[number]['name'], 'entryId' | 'provider' | 'model', string, boolean][] = [['id', 'entryId', 'fresh', false], ['provider', 'provider', 'anthropic', false], ['model', 'model', 'sonnet', true]]
  for (const [name, field, value, redraw] of steps) {
    const next = editRow(form, 'row', field, value)
    assert.equal(choicesNeedRedraw(form, next), redraw, name)
    form = next
  }
  assert.equal(registryIds(form).includes('fresh'), true)
  assert.equal(slotChoices(form, '', 'sonnet').some((choice) => choice.value === 'fresh'), true)
  assert.equal(fallbackChoices(form, '').some((choice) => choice.value === 'fresh'), true)
})

test('the page asks choicesNeedRedraw after every registry edit, add, and remove, and never decides from the field alone', async () => {
  const page = await publicFile('settings.ts')
  assert.equal((page.match(/choicesNeedRedraw\(/g) ?? []).length, 3)
  assert.doesNotMatch(page, /field === 'entryId'/)
})

// the registry shapes the server refuses on a save (modelsSaveProblem) that a hand-edited file can hold: each is served as stored, so the form shows the row, refuses the save at that row, writes the stored value back unchanged, and passes the server's check once the row is removed or fixed
const refusedRegistries: { name: string, raw: Record<string, unknown>, row: number, field: string }[] = [
  { name: 'a repeat of a custom id', raw: { registry: [usable, { ...usable }] }, row: 1, field: 'id' },
  { name: 'a repeat of a set-aside entry', raw: { registry: [setAside, { ...setAside }] }, row: 0, field: 'runner' },
  { name: 'an entry set aside for a bad runner', raw: { registry: [usable, setAside] }, row: 1, field: 'runner' },
  { name: 'an empty id', raw: { registry: [{ ...usable, id: '' }] }, row: 0, field: 'id' },
  { name: 'an entry with no id', raw: { registry: [{ runner: 'claude', provider: 'anthropic', model: 'sonnet' }] }, row: 0, field: 'id' },
  { name: 'an entry with only an id', raw: { registry: [{ id: 'lonely' }] }, row: 0, field: 'runner' },
  { name: 'a built-in id restated differently', raw: { registry: [{ ...usable, id: 'opus', model: 'haiku' }] }, row: 0, field: 'id' },
  { name: 'a space around a field', raw: { registry: [{ ...usable, provider: ' anthropic' }] }, row: 0, field: 'provider' },
  { name: 'an exact restatement after a custom entry holding that built-in id', raw: { registry: [{ ...usable, id: 'sonnet', model: 'haiku' }, sonnet] }, row: 0, field: 'id' },
]

test('a stored registry the server would refuse is refused visibly at its row, written back unchanged, and passes once the row is removed', () => {
  for (const { name, raw, row, field } of refusedRegistries) {
    assert.notEqual(modelsSaveProblem(projectModels(raw)), null, `${name}: the server refuses it`)
    const form = formOf(projectModels(raw))
    const errors = modelsErrors(form)
    assert.equal(errors.some((error) => error.field === `models.registry.${row}.${field}`), true, `${name}: an error at the row`)
    assert.equal(errors.length > 0 && errors.every((error) => error.field !== null && /^models\.registry\.\d+\.(id|runner|provider|model)$/.test(error.field)), true, `${name}: every error is on a control`)
    assert.deepEqual(modelsSetting(form), projectModels(raw), `${name}: written back as stored`)
    const refusal = modelsServerError(modelsSaveProblem(modelsSetting(form)) as string, form)
    assert.notEqual(refusal.field, null, `${name}: the server's refusal lands on a control`)
    assert.equal(readOnlyRows(form)[row], false, `${name}: the row is editable`)
    // removing every row with an error makes the save pass the server's check
    let fixed = form
    for (const bad of [...new Set(errors.map((error) => Number(/^models\.registry\.(\d+)\./.exec(error.field as string)?.[1])))].sort((a, b) => b - a)) fixed = removeRow(fixed, form.registry[bad]?.rowId as string)
    assert.deepEqual(modelsErrors(fixed), [], name)
    assert.equal(modelsSaveProblem(modelsSetting(fixed)), null, `${name}: passes once removed`)
  }
})

test('a stored registry the server would refuse passes once the row is fixed, and an unrelated save of it is blocked until then', () => {
  const form = formOf({ registry: [usable, setAside], slots: { stack: 'extra' } })
  assert.equal(validateForm(toForm({ ...defaultConfig(), models: { registry: [usable, setAside], slots: { stack: 'extra' } } }, ids())).some((error) => error.field === 'models.registry.1.runner'), true)
  const fixed = editRow(form, form.registry[1]?.rowId as string, 'runner', 'claude')
  assert.deepEqual(modelsErrors(fixed), [])
  assert.equal(modelsSaveProblem(modelsSetting(fixed)), null)
})

test('a stored registry the server accepts is written back as stored and passes the same check, for every hand-edited shape it accepts', () => {
  const accepted = handEdited.filter(({ raw }) => modelsSaveProblem(projectModels(raw)) === null)
  const refused = handEdited.filter(({ raw }) => modelsSaveProblem(projectModels(raw)) !== null)
  assert.equal(accepted.length > 0 && refused.length > 0, true)
  for (const { name, raw } of accepted) {
    const form = formOf(projectModels(raw))
    assert.deepEqual(modelsErrors(form), [], name)
    assert.equal(modelsSaveProblem(modelsSetting(form)), null, name)
  }
  // a shape the server refuses is refused at a row, never repaired by the form
  for (const { name, raw } of refused) {
    const form = formOf(projectModels(raw))
    assert.notEqual(modelsErrors(form).length, 0, name)
    assert.deepEqual(modelsSetting(form), Object.keys(projectModels(raw)).length === 0 ? undefined : projectModels(raw), name)
  }
})

// which row is the read-only built-in row follows the rows as they are now: after every edit, add, and remove the form's errors must name what the server's save check names, on the same row and in the same words, and the row it names must be one the owner can edit or remove
const agrees = (form: ModelsForm, name: string): void => {
  const server = modelsSaveProblem(modelsSetting(form))
  const errors = modelsErrors(form)
  if (server === null) return assert.deepEqual(errors, [], `${name}: no error where the server accepts`)
  const first = errors[0]
  assert.notEqual(first, undefined, `${name}: an error where the server refuses`)
  assert.deepEqual(first, modelsServerError(server, form), `${name}: the first error is the server's refusal, on its row`)
  const row = Number(/^models\.registry\[(\d+)\]/.exec(server)?.[1])
  assert.equal(readOnlyRows(form)[row], false, `${name}: the named row is not read-only`)
}

const customSonnet = { id: 'custom', runner: 'claude', provider: 'anthropic', model: 'sonnet' }

test('renaming an earlier custom row to a built-in id with that entry\'s values makes it the read-only row and the later row the editable repeat, as the server names it', () => {
  const start = formOf({ registry: [customSonnet, builtInRegistry[0]] })
  assert.deepEqual(readOnlyRows(start), [false, true])
  agrees(start, 'start')
  const renamed = editRow(start, start.registry[0]?.rowId as string, 'entryId', 'sonnet')
  assert.deepEqual(readOnlyRows(renamed), [true, false])
  assert.deepEqual(modelsErrors(renamed).map((error) => [error.field, error.message]), [['models.registry.1.id', 'Id appears twice.']])
  agrees(renamed, 'renamed')
  assert.deepEqual(readOnlyChanged(start, renamed), [0, 1])
  // the repeated row can be edited or removed on its own, and either passes the server's check
  const rowId = renamed.registry[1]?.rowId as string
  assert.equal(modelsSaveProblem(modelsSetting(removeRow(renamed, rowId))), null)
  const reworked = editRow(renamed, rowId, 'entryId', 'other')
  assert.notEqual(reworked, renamed)
  agrees(reworked, 'edited')
  assert.equal(modelsSaveProblem(modelsSetting(reworked)), null)
})

test('a row that takes a built-in id with other values holds nothing, and removing it leaves the exact restatement read-only', () => {
  const differing = formOf({ registry: [{ ...customSonnet, model: 'other' }, builtInRegistry[0]] })
  const renamed = editRow(differing, 'r1', 'entryId', 'sonnet')
  assert.deepEqual(readOnlyRows(renamed), [false, true])
  agrees(renamed, 'renamed to a built-in id with other values')
  const back = editRow(renamed, 'r1', 'entryId', 'custom')
  assert.deepEqual(readOnlyRows(back), [false, true])
  agrees(back, 'renamed back')
  const typing = editRow(renamed, 'r1', 'entryId', 'sonne')
  assert.deepEqual(readOnlyRows(typing), [false, true])
  agrees(typing, 'typing')
  const removed = removeRow(renamed, 'r1')
  assert.deepEqual(readOnlyRows(removed), [true])
  agrees(removed, 'earlier row removed')
  assert.deepEqual(modelsSetting(removed), { registry: [builtInRegistry[0]] })
  // an edit that changes no row's mark redraws no row
  assert.deepEqual(readOnlyChanged(back, editRow(back, 'r1', 'model', 'opus')), [])
})

test('an added row that restates a built-in id, and an added row that takes a later row\'s id, are named as the server names them', () => {
  const table = formOf(undefined)
  const fill = (form: ModelsForm, id: string, fields: Record<string, string>): ModelsForm =>
    Object.entries({ entryId: id, ...fields }).reduce((current, [key, value]) => editRow(current, 'new', key as 'entryId', value), form)
  const added = fill(addCustomRow(table, 'new'), 'sonnet', { provider: 'anthropic', model: 'sonnet' })
  assert.equal(readOnlyRows(added)[0], true)
  assert.deepEqual(modelsErrors(added).map((error) => error.field), [`models.registry.${builtInEntries.length}.id`])
  agrees(added, 'added restatement')
  // a custom row first, then an exact built-in row: a row added at the end takes nothing from either
  const base = formOf({ registry: [customSonnet, builtInRegistry[0]] })
  agrees(fill(addCustomRow(base, 'new'), 'extra', { provider: 'anthropic', model: 'sonnet' }), 'added unrelated')
  // a repeat is named only against a row that stood: a custom row holding the id with a bad field is refused alone
  const badModel = editRow(editRow(base, 'r1', 'model', ''), 'r1', 'entryId', 'sonnet')
  assert.deepEqual(modelsErrors(badModel).map((error) => error.field), ['models.registry.0.model'])
  assert.deepEqual(readOnlyRows(badModel), [false, true])
  agrees(badModel, 'earlier row with a bad field')
  const fixed = editRow(badModel, 'r1', 'model', 'sonnet')
  assert.deepEqual(readOnlyRows(fixed), [true, false])
  agrees(fixed, 'earlier row fixed')
})

test('the offered ids, the built-in table state, and the choices follow the rows as they are after each of these edits', () => {
  const renamed = editRow(formOf({ registry: [customSonnet, builtInRegistry[0]] }), 'r1', 'entryId', 'sonnet')
  assert.deepEqual(registryIds(renamed), ['sonnet'])
  assert.deepEqual(registryIds(formOf({ registry: [customSonnet, builtInRegistry[0]] })), ['custom', 'sonnet'])
  assert.equal(choicesNeedRedraw(formOf({ registry: [customSonnet, builtInRegistry[0]] }), renamed), true)
  // every row restating its built-in entry in order is the untouched table, and only while each is the read-only row
  assert.equal(modelsSetting(formOf({ registry: [...builtInRegistry] })), undefined)
})

test('the page redraws only the rows whose read-only mark changed, so the field being typed in keeps its focus and text', async () => {
  const page = await publicFile('settings.ts')
  assert.match(page, /redrawRows\(readOnlyChanged\(before, page\.form\.models\)\)/)
  assert.doesNotMatch(page, /\.builtIn\b/)
  const view = await publicFile('modelsview.ts')
  assert.doesNotMatch(view, /\.builtIn\b/)
})

// the read-only rows are a function of the current rows alone, compared with the server on every small registry: the form as built, after removing each row, and after editing each field of each row to each other value
type Fields = { id: string, runner: string, provider: string, model: string }
const rowKinds = (id: string): Fields[] => {
  const exact = builtInRegistry.find((model) => model.id === id) ?? { id, runner: 'hermes', provider: 'openrouter', model: 'vendor/model-x' }
  return [{ ...exact, id }, { ...exact, id, model: 'other-model' }, { ...exact, id, runner: 'bogus' }, { id, runner: exact.runner, model: exact.model } as Fields]
}
const shapes = (): Fields[][] => {
  const rows = ['sonnet', 'mine', ''].flatMap(rowKinds)
  const all: Fields[][] = rows.map((row) => [row])
  for (const first of rows) for (const second of rows) {
    all.push([first, second])
    for (const third of rows) all.push([first, second, third])
  }
  return all
}
const editValues: Record<RowFieldName, string[]> = { entryId: ['sonnet', 'mine', ''], runner: ['claude', 'hermes', 'bogus'], provider: ['anthropic', ''], model: ['sonnet', 'other-model', ''] }
type RowFieldName = 'entryId' | 'runner' | 'provider' | 'model'

// the server's rule written out separately: a row is the built-in row when the server accepts it alone, it restates a built-in entry, and no earlier row the server accepts alone holds its id
const serverReadOnly = (setting: Record<string, unknown> | undefined): boolean[] => {
  const rows = (setting?.registry ?? []) as Record<string, unknown>[]
  const held: unknown[] = []
  return rows.map((row) => {
    const alone = modelsSaveProblem({ registry: [row] }) === null
    const readOnly = alone && builtInRegistry.some((model) => model.id === row.id && model.runner === row.runner && model.provider === row.provider && model.model === row.model) && !held.includes(row.id)
    if (alone) held.push(row.id)
    return readOnly
  })
}

const agreesWithServer = (form: ModelsForm, name: string): void => {
  const setting = modelsSetting(form)
  const rule = setting === undefined ? form.registry.map(() => true) : serverReadOnly(setting)
  assert.deepEqual(readOnlyRows(form), rule, `${name}: read-only rows`)
  const server = modelsSaveProblem(setting)
  const errors = modelsErrors(form)
  if (server === null) return assert.deepEqual(errors, [], `${name}: no error where the server accepts`)
  assert.deepEqual(errors[0], modelsServerError(server, form), `${name}: the first error is the server's refusal`)
  assert.equal(readOnlyRows(form)[Number(/^models\.registry\[(\d+)\]/.exec(server)?.[1])], false, `${name}: the named row is editable`)
}

test('read-only rows follow the current rows alone and agree with the server on every small registry, after every removal and every single-field edit', () => {
  for (const shape of shapes()) {
    const name = JSON.stringify(shape)
    const form = formOf({ registry: shape })
    agreesWithServer(form, name)
    for (const row of form.registry) {
      const removed = removeRow(form, row.rowId)
      agreesWithServer(removed, `${name} without ${row.rowId}`)
      for (const [field, values] of Object.entries(editValues) as [RowFieldName, string[]][]) {
        for (const value of values) agreesWithServer(editRow(form, row.rowId, field, value), `${name}: ${row.rowId}.${field}=${value}`)
      }
    }
  }
})

test('an invalid earlier row never claims a built-in id: removing it leaves the exact restatement read-only and not removable, and the reverse order does too', () => {
  const invalid = { ...sonnet, model: 'other' }
  const form = formOf({ registry: [invalid, sonnet] })
  assert.deepEqual(readOnlyRows(form), [false, true])
  const removed = removeRow(form, form.registry[0]?.rowId as string)
  assert.deepEqual(readOnlyRows(removed), [true])
  assert.equal(removeRow(removed, removed.registry[0]?.rowId as string), removed)
  assert.equal(editRow(removed, removed.registry[0]?.rowId as string, 'model', 'x'), removed)
  const reverse = formOf({ registry: [sonnet, invalid] })
  assert.deepEqual(readOnlyRows(reverse), [true, false])
  assert.deepEqual(readOnlyRows(removeRow(reverse, reverse.registry[1]?.rowId as string)), [true])
  agreesWithServer(form, 'finding')
  agreesWithServer(reverse, 'reverse')
})
