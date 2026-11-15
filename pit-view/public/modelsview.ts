// public/modelsview.ts
// the Models card's elements: a registry table, and one labeled choice for the pinned fallback and for each slot. The page script wires them to its form; the choice is a small function of its own, so a later change can put a note beside any slot's control
import { h, svg } from './dom.ts'
import type { Shape } from './dom.ts'
import { runnerChoices } from './models-form.ts'
import type { RegistryRow, RowField } from './models-form.ts'
import { errorId, fieldId } from './settings-form.ts'
import type { Choice } from './settings-form.ts'

const removeIcon: Shape[] = [['path', { d: 'M6 6l12 12' }], ['path', { d: 'M18 6L6 18' }]]

export type RegistryHandlers = {
  // an edit of a custom row's field; a built-in row has no control to edit
  edit: (rowId: string, field: RowField, value: string) => void
  remove: (rowId: string) => void
}

const rowKey = (index: number, name: string): string => `models.registry.${index}.${name}`

const cell = (key: string, name: string, label: string, control: HTMLElement): HTMLDivElement =>
  h('div', { class: `cell cell-${name}` },
    h('label', { for: fieldId(key), class: 'row-label' }, label),
    control,
    h('p', { id: errorId(key), class: 'field-error', hidden: true }))

const input = (key: string, value: string, onInput: (value: string) => void): HTMLInputElement => {
  const field = h('input', { id: fieldId(key), class: 'input mono', type: 'text', autocomplete: 'off', spellcheck: 'false' })
  field.value = value
  field.addEventListener('input', () => onInput(field.value))
  return field
}

// a built-in row shows its values as text and is marked built-in; nothing in it is a control
const builtInCells = (row: RegistryRow): HTMLElement[] => [
  h('div', { class: 'cell cell-id' }, h('span', { class: 'row-label', 'aria-hidden': 'true' }, 'Id'), h('span', { class: 'mono' }, row.entryId)),
  h('div', { class: 'cell cell-runner' }, h('span', { class: 'row-label', 'aria-hidden': 'true' }, 'Runner'), h('span', { class: 'mono' }, row.runner)),
  h('div', { class: 'cell cell-provider' }, h('span', { class: 'row-label', 'aria-hidden': 'true' }, 'Provider'), h('span', { class: 'mono' }, row.provider)),
  h('div', { class: 'cell cell-model' }, h('span', { class: 'row-label', 'aria-hidden': 'true' }, 'Model'), h('span', { class: 'mono' }, row.model)),
  h('div', { class: 'cell cell-remove' }, h('span', { class: 'chip' }, 'Built-in')),
]

const customCells = (row: RegistryRow, index: number, handlers: RegistryHandlers): HTMLElement[] => {
  const runner = h('select', { id: fieldId(rowKey(index, 'runner')), class: 'input' })
  runner.replaceChildren(...runnerChoices(row.runner).map((choice) => h('option', { value: choice.value }, choice.label)))
  runner.value = row.runner
  runner.addEventListener('change', () => handlers.edit(row.rowId, 'runner', runner.value))
  const label = `Remove ${row.entryId.trim() === '' ? `model ${index + 1}` : row.entryId.trim()}`
  const remove = h('button', { type: 'button', class: 'icon-button remove', 'aria-label': label, title: label }, svg(removeIcon, { size: 14 }))
  remove.addEventListener('click', () => handlers.remove(row.rowId))
  return [
    cell(rowKey(index, 'id'), 'id', 'Id', input(rowKey(index, 'id'), row.entryId, (value) => handlers.edit(row.rowId, 'entryId', value))),
    cell(rowKey(index, 'runner'), 'runner', 'Runner', runner),
    cell(rowKey(index, 'provider'), 'provider', 'Provider', input(rowKey(index, 'provider'), row.provider, (value) => handlers.edit(row.rowId, 'provider', value))),
    cell(rowKey(index, 'model'), 'model', 'Model', input(rowKey(index, 'model'), row.model, (value) => handlers.edit(row.rowId, 'model', value))),
    h('div', { class: 'cell cell-remove' }, remove),
  ]
}

// one row of the registry: the read-only built-in row (as `readOnlyRows` decides) shown and marked, any other with a control for each field and a Remove
export const registryRow = (row: RegistryRow, index: number, readOnly: boolean, handlers: RegistryHandlers): HTMLFieldSetElement =>
  h('fieldset', { class: `row models-grid${readOnly ? ' models-builtin' : ''}`, 'data-row': row.rowId },
    h('legend', { class: 'sr-only' }, readOnly ? `Built-in model ${row.entryId}` : `Model ${index + 1}${row.entryId.trim() === '' ? '' : `: ${row.entryId.trim()}`}`),
    ...(readOnly ? builtInCells(row) : customCells(row, index, handlers)))

export type ChoiceProps = {
  // the field key, which names the control, its error, and its notes
  field: string
  label: string
  value: string
  choices: readonly Choice<string>[]
  onChange: (value: string) => void
  // what the server reads from the saved setting for this control, or null while it could not be read
  asRead: string | null
  // the server's warnings about this control
  warnings: readonly string[]
  // anything else a later change puts beside the control, such as a note
  extra?: readonly HTMLElement[]
}

// one labeled choice among registry ids, with what the server reads for it, its warnings, and its error slot beside it; the pinned fallback and every slot are one of these
export const choiceField = ({ field, label, value, choices, onChange, asRead, warnings, extra = [] }: ChoiceProps): HTMLDivElement => {
  const id = fieldId(field)
  const select = h('select', { id, class: 'input mono', 'aria-describedby': `${id}-read` })
  select.replaceChildren(...choices.map((choice) => h('option', { value: choice.value }, choice.label)))
  select.value = value
  select.addEventListener('change', () => onChange(select.value))
  return h('div', { class: 'field' },
    h('label', { for: id }, label),
    select,
    h('p', { id: `${id}-read`, class: 'hint mono', hidden: asRead === null }, asRead === null ? '' : `As read: ${asRead}`),
    ...extra,
    h('p', { id: errorId(field), class: 'field-error', hidden: true }),
    h('ul', { id: `${id}-warnings`, class: 'warn-list', 'aria-live': 'polite' }, ...warnings.map((warning) => h('li', { class: 'warn-text' }, warning))))
}
