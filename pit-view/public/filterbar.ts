// public/filterbar.ts
// a table's filter bar: search, selects, Group by status, the count and Clear; built once per
// table and updated in place, so typing and focus survive every redraw and patch
import { h, setText, sync } from './dom.ts'
import type { Option } from './filters.ts'
import type { TableKey } from './tables.ts'

export type SelectModel = { field: string, label: string, value: string, options: Option[] }

export type FilterBarModel = {
  table: TableKey
  // the section's name in accessible labels: 'Mine', "Others'", 'Closed'
  name: string
  query: string
  selects: SelectModel[]
  // null: this table has no Group by status
  grouped: boolean | null
  count: string
  filtered: boolean
}

export type FilterBarActions = {
  setQuery: (table: TableKey, query: string) => void
  setSelect: (table: TableKey, field: string, value: string) => void
  setGrouped: (table: TableKey, grouped: boolean) => void
  clear: (table: TableKey) => void
}

type Parts = {
  bar: HTMLDivElement
  search: HTMLInputElement
  selects: Map<string, HTMLSelectElement>
  grouped: HTMLInputElement | null
  count: HTMLSpanElement
  clear: HTMLButtonElement
}

const built = new WeakMap<Element, Parts>()

const build = (model: FilterBarModel, actions: FilterBarActions): Parts => {
  const { table, name } = model
  const search = h('input', {
    type: 'search', class: 'filter-search', placeholder: 'Filter by title or #', 'aria-label': `Filter ${name} by title or number`, autocomplete: 'off', spellcheck: 'false',
  })
  search.addEventListener('input', () => actions.setQuery(table, search.value))
  const selects = new Map(model.selects.map((select) => {
    const element = h('select', { class: 'filter-select', 'aria-label': select.label })
    element.addEventListener('change', () => actions.setSelect(table, select.field, element.value))
    return [select.field, element] as const
  }))
  let grouped: HTMLInputElement | null = null
  if (model.grouped !== null) {
    const box = h('input', { type: 'checkbox' })
    box.addEventListener('change', () => actions.setGrouped(table, box.checked))
    grouped = box
  }
  const count = h('span', { class: 'filter-count' })
  const clear = h('button', { type: 'button', class: 'button button-small' }, 'Clear')
  clear.addEventListener('click', () => {
    actions.clear(table)
    // the button hides itself, so focus goes back to the search
    search.focus()
  })
  const bar = h('div', { class: 'filter-bar', role: 'group', 'aria-label': `${name} filters` },
    search,
    [...selects.values()],
    grouped === null ? null : h('label', { class: 'filter-check' }, grouped, 'Group by status'),
    h('span', { class: 'spacer' }),
    count,
    clear)
  return { bar, search, selects, grouped, count, clear }
}

// the bar sits in the table's card, before its scrolling box
export const renderFilterBar = (box: HTMLElement, model: FilterBarModel, actions: FilterBarActions): void => {
  const card = box.parentElement
  if (card === null) return
  let parts = built.get(card)
  if (parts === undefined) {
    parts = build(model, actions)
    built.set(card, parts)
    card.insertBefore(parts.bar, box)
  }
  if (parts.search.value !== model.query) parts.search.value = model.query
  for (const select of model.selects) {
    const element = parts.selects.get(select.field)
    if (element === undefined) continue
    sync(element, select.options.map((option) => ({
      key: `option-${option.value}`,
      sig: option.label,
      build: () => h('option', { value: option.value }, option.label),
    })))
    if (element.value !== select.value) element.value = select.value
    element.classList.toggle('filter-set', select.value !== (select.options[0]?.value ?? ''))
  }
  if (parts.grouped !== null && model.grouped !== null && parts.grouped.checked !== model.grouped) parts.grouped.checked = model.grouped
  setText(parts.count, model.count)
  parts.clear.hidden = !model.filtered
}
