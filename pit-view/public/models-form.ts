// public/models-form.ts
// the Models card's pure logic: the models setting (section 1 of DESIGN.md, Configuration, the models key) as form state, one control per part, and back to exactly the stored shape; the page's copy of the server's entry checks; the server's refusals and warnings placed on the control they name. Nothing here can hold a key, a key reference, a token, or a secret: a row has the four entry fields and nothing else
import type { ModelEntry, ModelsView, SlotName } from '../src/models.ts'
import type { Choice, FieldError } from './settings-form.ts'

// a copy of builtInRegistry, builtInFallbackId, and the slot defaults in src/models.ts, which a test keeps in step (the page cannot import that module's code)
export const builtInEntries: readonly ModelEntry[] = [
  { id: 'sonnet', runner: 'claude', provider: 'anthropic', model: 'sonnet' },
  { id: 'opus', runner: 'claude', provider: 'anthropic', model: 'opus' },
  { id: 'gpt-6.1-terra', runner: 'codex', provider: 'openai', model: 'gpt-6.1-terra' },
  { id: 'gpt-6.1-sol', runner: 'codex', provider: 'openai', model: 'gpt-6.1-sol' },
  { id: 'deepseek-flash', runner: 'hermes', provider: 'openrouter', model: '~deepseek/deepseek-flash-latest' },
  { id: 'kimi-code', runner: 'hermes', provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code' },
  { id: 'qwen-coder-flash', runner: 'hermes', provider: 'openrouter', model: 'qwen/qwen3-coder-flash' },
]

export const builtInFallbackId = 'kimi-code'

export const builtInSlotDefaults: { review: readonly [string, string], autoReviewHuman: readonly [string, string], stack: string, sweep: string, autoReviewBot: string } = {
  review: ['sonnet', 'gpt-6.1-terra'],
  autoReviewHuman: ['sonnet', 'gpt-6.1-terra'],
  stack: 'sonnet',
  sweep: 'sonnet',
  autoReviewBot: 'sonnet',
}

export const runnerNames: readonly string[] = ['claude', 'codex', 'hermes']

// each row carries an id of its own, so a row keeps its elements while others come and go. Whether a row is the read-only built-in row is never stored: `readOnlyRows` decides it from the rows as they are
export type RegistryRow = { rowId: string, entryId: string, runner: string, provider: string, model: string }

export type RowField = 'entryId' | 'runner' | 'provider' | 'model'

// a slot as typed: the id a control chose, or empty for unset, which leaves the key out
export type SlotsForm = { review: [string, string], autoReviewHuman: [string, string], stack: string, sweep: string, autoReviewBot: string }

// what the config held for a part the owner has not touched since it was read, as the server reads it: a row's entry fields that were stored, untrimmed and none added (by row id), the fallback, and each slot's value. A save writes these back as they were until the control is changed, so it never rewrites what the owner did not touch and never changes what the server resolves
export type OriginalValues = { rows: Record<string, Partial<Record<'id' | 'runner' | 'provider' | 'model', string>>>, fallback?: string, slots: Partial<Record<SlotName, string | [string, string]>> }

export type ModelsForm = { registry: RegistryRow[], fallback: string, slots: SlotsForm, original: OriginalValues }

// one slot control: its field key, the slot and the position in it (null for a slot that holds one id), its label, and the built-in default it shows while unset
export type SlotControl = { field: string, slot: SlotName, index: 0 | 1 | null, label: string, defaultId: string }

export const slotControls: readonly SlotControl[] = [
  { field: 'models.slots.review.0', slot: 'review', index: 0, label: 'Review, primary', defaultId: builtInSlotDefaults.review[0] },
  { field: 'models.slots.review.1', slot: 'review', index: 1, label: 'Review, secondary', defaultId: builtInSlotDefaults.review[1] },
  { field: 'models.slots.autoReviewHuman.0', slot: 'autoReviewHuman', index: 0, label: 'Auto-review of people, primary', defaultId: builtInSlotDefaults.autoReviewHuman[0] },
  { field: 'models.slots.autoReviewHuman.1', slot: 'autoReviewHuman', index: 1, label: 'Auto-review of people, secondary', defaultId: builtInSlotDefaults.autoReviewHuman[1] },
  { field: 'models.slots.stack', slot: 'stack', index: null, label: 'Stack review', defaultId: builtInSlotDefaults.stack },
  { field: 'models.slots.sweep', slot: 'sweep', index: null, label: 'Dependabot sweep', defaultId: builtInSlotDefaults.sweep },
  { field: 'models.slots.autoReviewBot', slot: 'autoReviewBot', index: null, label: 'Auto-review of bots', defaultId: builtInSlotDefaults.autoReviewBot },
]

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const own = (value: Record<string, unknown>, key: string): unknown => Object.hasOwn(value, key) ? value[key] : undefined
const text = (value: unknown): string => typeof value === 'string' ? value : ''

const capitalize = (words: string): string => words === '' ? words : `${words[0]!.toUpperCase()}${words.slice(1)}`

const builtInRow = (entry: ModelEntry, rowId: string): RegistryRow => ({ rowId, entryId: entry.id, runner: entry.runner, provider: entry.provider, model: entry.model })

const builtInRows = (makeId: () => string): RegistryRow[] => builtInEntries.map((entry) => builtInRow(entry, makeId()))

const restatesBuiltIn = (row: { id: string, runner: string, provider: string, model: string }): boolean =>
  builtInEntries.some((entry) => entry.id === row.id && entry.runner === row.runner && entry.provider === row.provider && entry.model === row.model)

// the longest a stored id may be, as in src/models.ts
const maxText = 200
const isText = (value: unknown): value is string => typeof value === 'string' && value.length <= maxText

// the value a slot holds in the stored setting, in the shapes the server keeps on a read (projectModels in src/models.ts): one id, or for a pair slot also a pair of two ids; undefined for anything else, which the server drops
const storedSlot = (name: SlotName, raw: unknown): string | [string, string] | undefined => {
  if (isText(raw)) return raw
  return (name === 'review' || name === 'autoReviewHuman') && Array.isArray(raw) && raw.length === 2 && isText(raw[0]) && isText(raw[1]) ? [raw[0], raw[1]] : undefined
}

// what the server resolves from a stored slot, shown by the controls: a single slot holds one id, and a pair slot holds exactly a pair, since one id for a pair slot takes both built-in defaults (src/models.ts, resolveModels), so it shows unset
const shownSlot = (name: SlotName, stored: string | [string, string] | undefined): string | [string, string] => {
  if (name === 'review' || name === 'autoReviewHuman') return Array.isArray(stored) ? [...stored] : ['', '']
  return typeof stored === 'string' ? stored : ''
}

// the setting as the config holds it to form state: no setting, or a registry that holds no entry, shows the built-in table; otherwise the entries as stored, none of them marked, since `readOnlyRows` decides from the rows as they are which one is a built-in row. Each slot shows what the server resolves for it (a slot the server takes the built-in default for shows unset), and the stored values stay in `original` until a control changes them. Only the four entry fields, the fallback, and the five slot names are read, so anything else in the value is not carried
export const toModelsForm = (raw: unknown, makeId: () => string): ModelsForm => {
  const setting = isObject(raw) ? raw : {}
  const stored = own(setting, 'registry')
  const entries = Array.isArray(stored) ? stored.filter(isObject).filter((entry) => (['id', 'runner', 'provider', 'model'] as const).some((field) => typeof own(entry, field) === 'string')) : []
  const original: OriginalValues = { rows: {}, slots: {} }
  const registry = entries.length === 0
    ? builtInRows(makeId)
    : entries.map((entry): RegistryRow => {
      const row = { entryId: text(own(entry, 'id')), runner: text(own(entry, 'runner')), provider: text(own(entry, 'provider')), model: text(own(entry, 'model')) }
      const given: Partial<Record<'id' | 'runner' | 'provider' | 'model', string>> = {}
      for (const field of ['id', 'runner', 'provider', 'model'] as const) if (typeof own(entry, field) === 'string') given[field] = own(entry, field) as string
      const rowId = makeId()
      original.rows[rowId] = given
      return { rowId, ...row }
    })
  const slots = own(setting, 'slots')
  const given = isObject(slots) ? slots : {}
  const shown = (name: SlotName): string | [string, string] => {
    const stored = storedSlot(name, own(given, name))
    if (stored !== undefined) original.slots[name] = stored
    return shownSlot(name, stored)
  }
  const fallback = own(setting, 'fallback')
  if (isText(fallback)) original.fallback = fallback
  return {
    registry,
    fallback: text(fallback),
    slots: { review: shown('review') as [string, string], autoReviewHuman: shown('autoReviewHuman') as [string, string], stack: shown('stack') as string, sweep: shown('sweep') as string, autoReviewBot: shown('autoReviewBot') as string },
    original,
  }
}

// the built-in table untouched is the empty registry, which is what an absent key means
const isBuiltInTable = (form: ModelsForm): boolean => {
  const rows = form.registry
  const readOnly = readOnlyRows(form)
  return rows.length === 0 || (rows.length === builtInEntries.length && rows.every((row, at) => readOnly[at] === true && row.entryId === builtInEntries[at]?.id))
}

// a row's entry as the config stores it: exactly the fields that were stored while the owner has not edited the row (a field that was missing stays missing), otherwise its four fields, trimmed
const storedEntry = (form: ModelsForm, row: RegistryRow): Partial<Record<'id' | 'runner' | 'provider' | 'model', string>> => {
  const stored = form.original.rows[row.rowId]
  return stored === undefined ? { id: row.entryId.trim(), runner: row.runner, provider: row.provider.trim(), model: row.model.trim() } : { ...stored }
}

// a row's four fields as the server would read them, a missing one as empty, which the entry rules refuse in the same words
const fieldsOf = (form: ModelsForm, row: RegistryRow): { id: string, runner: string, provider: string, model: string } => {
  const { id = '', runner = '', provider = '', model = '' } = storedEntry(form, row)
  return { id, runner, provider, model }
}

// the models value the config stores, in exactly the stored shape, or undefined when every part is at its default, which leaves the key out of the file. A part the owner has not changed since it was read (a row, the fallback, a slot) is written as it was stored, so a save never changes what the server resolves for it. Otherwise an unset control leaves its key out, and a pair slot with one side set takes the built-in default for the other, since a pair holds two ids
export const modelsSetting = (form: ModelsForm): Record<string, unknown> | undefined => {
  const setting: Record<string, unknown> = {}
  if (!isBuiltInTable(form)) setting.registry = form.registry.map((row) => storedEntry(form, row))
  const fallback = form.original.fallback ?? form.fallback
  if (fallback !== '' || form.original.fallback !== undefined) setting.fallback = fallback
  const slots: Record<string, unknown> = {}
  for (const name of ['review', 'autoReviewHuman'] as const) {
    const kept = form.original.slots[name]
    const [primary, secondary] = form.slots[name]
    if (kept !== undefined) slots[name] = typeof kept === 'string' ? kept : [...kept]
    else if (primary !== '' || secondary !== '') slots[name] = [primary === '' ? builtInSlotDefaults[name][0] : primary, secondary === '' ? builtInSlotDefaults[name][1] : secondary]
  }
  for (const name of ['stack', 'sweep', 'autoReviewBot'] as const) {
    const kept = form.original.slots[name]
    if (kept !== undefined) slots[name] = kept
    else if (form.slots[name] !== '') slots[name] = form.slots[name]
  }
  if (Object.keys(slots).length > 0) setting.slots = slots
  return Object.keys(setting).length === 0 ? undefined : setting
}

// the controls' operations, each answering a new form and leaving the old one alone

export const addCustomRow = (form: ModelsForm, rowId: string): ModelsForm =>
  ({ ...form, registry: [...form.registry, { rowId, entryId: '', runner: 'claude', provider: '', model: '' }] })

// a built-in row is read-only: an edit of one answers the form as it was
export const editRow = (form: ModelsForm, rowId: string, field: RowField, value: string): ModelsForm => {
  const at = form.registry.findIndex((candidate) => candidate.rowId === rowId)
  const row = form.registry[at]
  if (row === undefined || readOnlyRows(form)[at] === true) return form
  // an edited row is written from its fields, no longer as it was stored
  const { [rowId]: _stored, ...rows } = form.original.rows
  return { ...form, registry: form.registry.map((candidate) => candidate === row ? { ...row, [field]: value } : candidate), original: { ...form.original, rows } }
}

// a built-in row cannot be removed; a registry left with no row at all shows the built-in table again, which is what an empty registry means
export const removeRow = (form: ModelsForm, rowId: string): ModelsForm => {
  const at = form.registry.findIndex((candidate) => candidate.rowId === rowId)
  const row = form.registry[at]
  if (row === undefined || readOnlyRows(form)[at] === true) return form
  const registry = form.registry.filter((candidate) => candidate !== row)
  return { ...form, registry: registry.length === 0 ? builtInEntries.map((entry) => builtInRow(entry, `built-in:${entry.id}`)) : registry }
}

export const slotOf = (form: ModelsForm, control: SlotControl): string => {
  const value = form.slots[control.slot]
  return Array.isArray(value) ? value[control.index ?? 0] as string : value
}

export const setSlot = (form: ModelsForm, control: SlotControl, value: string): ModelsForm => {
  const current = form.slots[control.slot]
  const next = Array.isArray(current) ? (control.index === 1 ? [current[0], value] : [value, current[1]]) as [string, string] : value
  // a changed control writes its slot from the controls, no longer as it was stored
  const { [control.slot]: _stored, ...slots } = form.original.slots
  return { ...form, slots: { ...form.slots, [control.slot]: next }, original: { ...form.original, slots } }
}

export const setFallback = (form: ModelsForm, value: string): ModelsForm => {
  const { fallback: _stored, ...rest } = form.original
  return { ...form, fallback: value, original: rest }
}

// the choices

export const runnerChoices = (value: string): Choice<string>[] => {
  const all = runnerNames.map((name): Choice<string> => ({ value: name, label: name }))
  if (runnerNames.includes(value)) return all
  return [value === '' ? { value: '', label: 'Choose a runner' } : { value, label: `${value} (not a runner)` }, ...all]
}

// the ids a slot or the fallback can name: those of the rows the server would keep, in row order, once each. A row it sets aside for a bad field or a built-in id used for another entry, and a later row repeating an id, name nothing
export const registryIds = (form: ModelsForm): string[] => {
  const seen: string[] = []
  const readOnly = readOnlyRows(form)
  form.registry.forEach((row, at) => {
    const { id } = fieldsOf(form, row)
    if (!seen.includes(id) && rowProblems(form, row, readOnly[at] === true).length === 0) seen.push(id)
  })
  return seen
}

// whether the fallback and slot choices must be drawn again after an edit, an add, or a remove: exactly when the ids they offer changed, whichever field or operation changed them, since a row turns valid or invalid by any of its four fields
export const choicesNeedRedraw = (before: ModelsForm, after: ModelsForm): boolean => {
  const was = registryIds(before)
  const now = registryIds(after)
  return was.length !== now.length || was.some((id, at) => id !== now[at])
}

// unset first, showing the built-in default it stands for, then the registry's ids; an id the setting names that the registry lacks stays as a choice, marked, so a save keeps it and the owner can see it
const idChoices = (form: ModelsForm, current: string, defaultId: string): Choice<string>[] => {
  const known = registryIds(form)
  return [
    { value: '', label: `Built-in default (${defaultId})` },
    ...known.map((id): Choice<string> => ({ value: id, label: id })),
    ...(current === '' || known.includes(current) ? [] : [{ value: current, label: `${current} (not in the registry)` }]),
  ]
}

export const slotChoices = (form: ModelsForm, current: string, defaultId: string): Choice<string>[] => idChoices(form, current, defaultId)

export const fallbackChoices = (form: ModelsForm, current: string): Choice<string>[] => idChoices(form, current, builtInFallbackId)

// the checks made before saving: the same rules and the same words as entryProblem and modelsSaveProblem in src/models.ts, which a test keeps in step. One error for each field, the first the server would name, and none for a built-in row, which cannot be edited
const labelPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const labelRule = 'must be letters, digits, dots, underscores, and dashes'

const modelProblem = (model: string): string | null => {
  if (model === '') return 'model must be a name such as sonnet or vendor/model-name, and not empty'
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(model)) return 'model must have no spaces or control characters'
  if (model.startsWith('-')) return 'model must not start with a dash'
  return model.length > 200 ? 'model must be at most 200 characters' : null
}

// what is wrong with one custom row by its own fields, as the entry rules the server applies to it: a field and its reason, none for a built-in row, which cannot be edited. A repeated id is not here, since it depends on the rows before
type RowProblem = { field: 'id' | 'runner' | 'provider' | 'model', reason: string }

const fieldProblems = ({ id, runner, provider, model }: { id: string, runner: string, provider: string, model: string }): RowProblem[] => {
  const problems: RowProblem[] = []
  const idBad = !labelPattern.test(id)
  const runnerBad = !runnerNames.includes(runner)
  const providerBad = !labelPattern.test(provider)
  const modelBad = modelProblem(model)
  if (idBad) problems.push({ field: 'id', reason: `id ${labelRule}, starting with a letter or digit` })
  if (runnerBad) problems.push({ field: 'runner', reason: `runner must be one of ${runnerNames.join(', ')}` })
  if (providerBad) problems.push({ field: 'provider', reason: `provider ${labelRule}, such as anthropic` })
  if (modelBad !== null) problems.push({ field: 'model', reason: modelBad })
  if (!idBad && !runnerBad && !providerBad && modelBad === null) {
    const builtIn = builtInEntries.find((entry) => entry.id === id)
    if (builtIn !== undefined && (builtIn.runner !== runner || builtIn.provider !== provider || builtIn.model !== model)) {
      problems.push({ field: 'id', reason: `id ${builtIn.id} is a built-in model id (${builtIn.runner}, ${builtIn.provider}, ${builtIn.model}), so an entry may use it only to restate that entry exactly; choose another id` })
    }
  }
  return problems
}

// which rows are the read-only built-in rows, by position, from the current rows alone: a row is one when it restates a built-in entry exactly and no earlier row that passes its own checks holds its id, the server's rule that the first entry holding an id stands and a later one is refused as a repeat. An earlier row that fails its own checks holds no id
export const readOnlyRows = (form: ModelsForm): boolean[] => {
  const held: string[] = []
  return form.registry.map((row) => {
    const fields = fieldsOf(form, row)
    const readOnly = restatesBuiltIn(fields) && !held.includes(fields.id)
    if (fieldProblems(fields).length === 0) held.push(fields.id)
    return readOnly
  })
}

// whether a row's read-only mark differs between two forms, by position, which the page redraws those rows for; a row an edit did not touch keeps its elements, and with them the focus and the text being typed
export const readOnlyChanged = (before: ModelsForm, after: ModelsForm): number[] => {
  const was = readOnlyRows(before)
  const now = readOnlyRows(after)
  const changed: number[] = []
  if (before.registry.length !== after.registry.length) return after.registry.map((_row, at) => at)
  now.forEach((value, at) => { if (was[at] !== value || before.registry[at]?.rowId !== after.registry[at]?.rowId) changed.push(at) })
  return changed
}

const rowProblems = (form: ModelsForm, row: RegistryRow, readOnly: boolean): RowProblem[] => readOnly ? [] : fieldProblems(fieldsOf(form, row))

export const modelsErrors = (form: ModelsForm): FieldError[] => {
  const errors: FieldError[] = []
  // the ids the server has seen by each row: those of the rows before it that pass their own checks, since it refuses the first that does not, so a repeat is only ever named against a row that stood
  const earlier: string[] = []
  const readOnly = readOnlyRows(form)
  form.registry.forEach((row, index) => {
    const problems = rowProblems(form, row, readOnly[index] === true)
    for (const { field, reason } of problems) errors.push({ field: `models.registry.${index}.${field}`, message: `${capitalize(reason)}.` })
    const { id } = fieldsOf(form, row)
    if (problems.length === 0 && earlier.includes(id)) errors.push({ field: `models.registry.${index}.id`, message: 'Id appears twice.' })
    if (problems.length === 0) earlier.push(id)
  })
  return errors
}

// the control a reason is about, named as the server names the entry's fields: `id` is the row's `entryId`
const rowField = (reason: string): string => /^runner /.test(reason) ? 'runner' : /^provider /.test(reason) ? 'provider' : /^model /.test(reason) ? 'model' : 'id'

// a refusal from PUT /api/config about the models setting (src/models.ts, modelsSaveProblem) placed on the control it names: a registry entry's field on its row, the registry as a whole on the table, the fallback on its choice, and a slot on its control (the primary of a pair); anything about the whole value, or about a row the form no longer has, stays a message for the whole form
export const modelsServerError = (message: string, form: ModelsForm): FieldError => {
  const whole: FieldError = { field: null, message }
  const entry = /^models\.registry\[(\d+)\] \([^)]*\): (.+)$/.exec(message)
  if (entry !== null) {
    const index = Number(entry[1])
    const reason = entry[2] ?? ''
    const row = form.registry[index]
    // a read-only row has no control to hold the message, so it stays in the card's summary with the row named
    if (row === undefined || readOnlyRows(form)[index] === true) return whole
    return { field: `models.registry.${index}.${rowField(reason)}`, message: `${capitalize(reason)}.` }
  }
  const field = /^models\.registry\[(\d+)\]\.[^:]*: /.exec(message)
  if (field !== null) return form.registry[Number(field[1])] === undefined || readOnlyRows(form)[Number(field[1])] === true ? whole : { field: `models.registry.${field[1]}.id`, message }
  const registry = /^models\.registry must (.+)$/.exec(message)
  if (registry !== null) return { field: 'models.registry', message: `Must ${registry[1]}.` }
  const fallback = /^models\.fallback must (.+)$/.exec(message)
  if (fallback !== null) return { field: 'models.fallback', message: `Must ${fallback[1]}.` }
  const slot = /^models\.slots\.(\w+) must (.+)$/.exec(message)
  const control = slot === null ? undefined : slotControls.find((candidate) => candidate.slot === slot[1] && candidate.index !== 1)
  return slot === null || control === undefined ? whole : { field: control.field, message: `Must ${slot[2]}.` }
}

// the server's warnings, each placed with the control it describes: a registry entry or the registry as a whole on the table, the pinned fallback on its choice, a slot on its control, and the rest at the top of the card
export type RoutedWarnings = { general: string[], registry: string[], fallback: string[], slots: Record<SlotName, string[]> }

export const routeWarnings = (warnings: readonly string[]): RoutedWarnings => {
  const routed: RoutedWarnings = { general: [], registry: [], fallback: [], slots: { review: [], stack: [], sweep: [], autoReviewHuman: [], autoReviewBot: [] } }
  for (const warning of warnings) {
    const slot = /^Slot (\w+) /.exec(warning)?.[1]
    if (/^Registry entry |^models\.registry /.test(warning)) routed.registry.push(warning)
    else if (/^The pinned fallback /.test(warning)) routed.fallback.push(warning)
    else if (slot !== undefined && Object.hasOwn(routed.slots, slot)) routed.slots[slot as SlotName].push(warning)
    else routed.general.push(warning)
  }
  return routed
}

// the id the server reads for a control from the saved setting, or null while the view could not be read
export const slotAsRead = (view: ModelsView | null, control: SlotControl): string | null => {
  if (view === null) return null
  const value = view.slots[control.slot]
  return Array.isArray(value) ? value[control.index ?? 0] ?? null : value
}
