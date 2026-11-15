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

// each row carries an id of its own, so a row keeps its elements while others come and go; a built-in row is one of the built-in entries and is never edited
export type RegistryRow = { rowId: string, builtIn: boolean, entryId: string, runner: string, provider: string, model: string }

export type RowField = 'entryId' | 'runner' | 'provider' | 'model'

// a slot as typed: the id a control chose, or empty for unset, which leaves the key out
export type SlotsForm = { review: [string, string], autoReviewHuman: [string, string], stack: string, sweep: string, autoReviewBot: string }

export type ModelsForm = { registry: RegistryRow[], fallback: string, slots: SlotsForm }

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

const builtInRow = (entry: ModelEntry, rowId: string): RegistryRow => ({ rowId, builtIn: true, entryId: entry.id, runner: entry.runner, provider: entry.provider, model: entry.model })

const builtInRows = (makeId: () => string): RegistryRow[] => builtInEntries.map((entry) => builtInRow(entry, makeId()))

const restatesBuiltIn = (row: Pick<RegistryRow, 'entryId' | 'runner' | 'provider' | 'model'>): boolean =>
  builtInEntries.some((entry) => entry.id === row.entryId && entry.runner === row.runner && entry.provider === row.provider && entry.model === row.model)

const slotValue = (raw: unknown, index: 0 | 1 | null): string => {
  if (index === null) return text(raw)
  if (Array.isArray(raw)) return text(raw[index])
  // a single id for a pair slot reads as the primary, which is what an owner meant by it
  return index === 0 ? text(raw) : ''
}

// the setting as the config holds it to form state: no setting, or a registry that holds no entry, shows the built-in table; otherwise the entries as stored, the first one that restates a built-in entry exactly being that built-in row, and any later repeat of an id already held a custom row. Only the four entry fields, the fallback, and the five slot names are read, so anything else in the value is not carried
export const toModelsForm = (raw: unknown, makeId: () => string): ModelsForm => {
  const setting = isObject(raw) ? raw : {}
  const stored = own(setting, 'registry')
  const entries = Array.isArray(stored) ? stored.filter(isObject).filter((entry) => (['id', 'runner', 'provider', 'model'] as const).some((field) => typeof own(entry, field) === 'string')) : []
  const seen = new Set<string>()
  const registry = entries.length === 0
    ? builtInRows(makeId)
    : entries.map((entry): RegistryRow => {
      const row = { entryId: text(own(entry, 'id')), runner: text(own(entry, 'runner')), provider: text(own(entry, 'provider')), model: text(own(entry, 'model')) }
      // the first entry to hold an id is the one that stands, as on the server, so a repeat of a built-in entry is a custom row that can be edited or removed
      const first = !seen.has(row.entryId.trim())
      seen.add(row.entryId.trim())
      return { rowId: makeId(), builtIn: first && restatesBuiltIn(row), ...row }
    })
  const slots = own(setting, 'slots')
  const given = isObject(slots) ? slots : {}
  const pair = (name: 'review' | 'autoReviewHuman'): [string, string] => [slotValue(own(given, name), 0), slotValue(own(given, name), 1)]
  return {
    registry,
    fallback: text(own(setting, 'fallback')),
    slots: { review: pair('review'), autoReviewHuman: pair('autoReviewHuman'), stack: text(own(given, 'stack')), sweep: text(own(given, 'sweep')), autoReviewBot: text(own(given, 'autoReviewBot')) },
  }
}

// the built-in table untouched is the empty registry, which is what an absent key means
const isBuiltInTable = (rows: readonly RegistryRow[]): boolean =>
  rows.length === 0 || (rows.length === builtInEntries.length && rows.every((row, at) => row.builtIn && row.entryId === builtInEntries[at]?.id))

// the models value the config stores, in exactly the stored shape, or undefined when every part is at its default, which leaves the key out of the file. An unset control leaves its key out; a pair slot with one side set takes the built-in default for the other, since a pair holds two ids
export const modelsSetting = (form: ModelsForm): Record<string, unknown> | undefined => {
  const setting: Record<string, unknown> = {}
  if (!isBuiltInTable(form.registry)) setting.registry = form.registry.map((row) => ({ id: row.entryId.trim(), runner: row.runner, provider: row.provider.trim(), model: row.model.trim() }))
  if (form.fallback !== '') setting.fallback = form.fallback
  const slots: Record<string, unknown> = {}
  for (const name of ['review', 'autoReviewHuman'] as const) {
    const [primary, secondary] = form.slots[name]
    if (primary !== '' || secondary !== '') slots[name] = [primary === '' ? builtInSlotDefaults[name][0] : primary, secondary === '' ? builtInSlotDefaults[name][1] : secondary]
  }
  for (const name of ['stack', 'sweep', 'autoReviewBot'] as const) if (form.slots[name] !== '') slots[name] = form.slots[name]
  if (Object.keys(slots).length > 0) setting.slots = slots
  return Object.keys(setting).length === 0 ? undefined : setting
}

// the controls' operations, each answering a new form and leaving the old one alone

export const addCustomRow = (form: ModelsForm, rowId: string): ModelsForm =>
  ({ ...form, registry: [...form.registry, { rowId, builtIn: false, entryId: '', runner: 'claude', provider: '', model: '' }] })

// a built-in row is read-only: an edit of one answers the form as it was
export const editRow = (form: ModelsForm, rowId: string, field: RowField, value: string): ModelsForm => {
  const row = form.registry.find((candidate) => candidate.rowId === rowId)
  if (row === undefined || row.builtIn) return form
  return { ...form, registry: form.registry.map((candidate) => candidate === row ? { ...row, [field]: value } : candidate) }
}

// a built-in row cannot be removed; a registry left with no row at all shows the built-in table again, which is what an empty registry means
export const removeRow = (form: ModelsForm, rowId: string): ModelsForm => {
  const row = form.registry.find((candidate) => candidate.rowId === rowId)
  if (row === undefined || row.builtIn) return form
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
  return { ...form, slots: { ...form.slots, [control.slot]: next } }
}

// the choices

export const runnerChoices = (value: string): Choice<string>[] => {
  const all = runnerNames.map((name): Choice<string> => ({ value: name, label: name }))
  if (runnerNames.includes(value)) return all
  return [value === '' ? { value: '', label: 'Choose a runner' } : { value, label: `${value} (not a runner)` }, ...all]
}

// the ids a slot or the fallback can name: the registry's, in row order, once each
export const registryIds = (form: ModelsForm): string[] => {
  const seen: string[] = []
  for (const row of form.registry) {
    const id = row.entryId.trim()
    if (id !== '' && !seen.includes(id)) seen.push(id)
  }
  return seen
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

export const modelsErrors = (form: ModelsForm): FieldError[] => {
  const errors: FieldError[] = []
  const earlier: string[] = []
  form.registry.forEach((row, index) => {
    const id = row.entryId.trim()
    const provider = row.provider.trim()
    const model = row.model.trim()
    const at = (field: string, reason: string): void => void errors.push({ field: `models.registry.${index}.${field}`, message: `${capitalize(reason)}.` })
    if (!row.builtIn) {
      const idBad = !labelPattern.test(id)
      const runnerBad = !runnerNames.includes(row.runner)
      const providerBad = !labelPattern.test(provider)
      const modelBad = modelProblem(model)
      if (idBad) at('id', `id ${labelRule}, starting with a letter or digit`)
      if (runnerBad) at('runner', `runner must be one of ${runnerNames.join(', ')}`)
      if (providerBad) at('provider', `provider ${labelRule}, such as anthropic`)
      if (modelBad !== null) at('model', modelBad)
      if (!idBad && !runnerBad && !providerBad && modelBad === null) {
        const builtIn = builtInEntries.find((entry) => entry.id === id)
        if (builtIn !== undefined && (builtIn.runner !== row.runner || builtIn.provider !== provider || builtIn.model !== model)) {
          at('id', `id ${builtIn.id} is a built-in model id (${builtIn.runner}, ${builtIn.provider}, ${builtIn.model}), so an entry may use it only to restate that entry exactly; choose another id`)
        } else if (earlier.includes(id)) at('id', 'id appears twice')
      }
    }
    earlier.push(id)
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
    if (row === undefined || row.builtIn) return whole
    return { field: `models.registry.${index}.${rowField(reason)}`, message: `${capitalize(reason)}.` }
  }
  const field = /^models\.registry\[(\d+)\]\.[^:]*: /.exec(message)
  if (field !== null) return form.registry[Number(field[1])]?.builtIn !== false ? whole : { field: `models.registry.${field[1]}.id`, message }
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
