// public/settings.ts
// the Settings page: loads the config, edits it in a form, checks it, and saves it through
// PUT /api/config, which patches open dashboards and starts the refresh a change needs
import type { Config } from '../src/config.ts'
import type { View } from '../src/poller.ts'
import { avatar } from './cells.ts'
import { byId, h, setText, svg } from './dom.ts'
import type { Shape } from './dom.ts'
import { formatClock } from './format.ts'
import { loadInstance, showInstance } from './instance.ts'
import {
  avatarChoices, changeKind, configChannel, configPathText, densityChoices, errorId, fieldId, isDirty, kindChoices, needsRefresh,
  newPerson, newTicket, openSuggestions, previewPerson, refreshChoices, sampleTextsFrom, serverError, sourceChoices, ticketSample,
  toConfig, todayChoices, toForm, validateForm,
} from './settings-form.ts'
import type { AvatarMode, Choice, FieldError, FieldKey, Form, PersonForm, SampleText, Suggestion, TicketForm, TicketKind } from './settings-form.ts'
import { mountThemeToggle } from './theme.ts'

const removeIcon: Shape[] = [['path', { d: 'M6 6l12 12' }], ['path', { d: 'M18 6L6 18' }]]

let idCount = 0
const makeId = (): string => {
  idCount += 1
  return `r${idCount}`
}

type Tone = 'normal' | 'ok' | 'error'

type PageState = {
  saved: Config
  form: Form
  // the gh login an empty viewer stands for, from the view
  ghLogin: string
  texts: SampleText[]
  suggestions: Suggestion[]
  errors: FieldError[]
  // after a refused save the checks follow every edit; before one they wait for Save
  checking: boolean
  saving: boolean
  status: { text: string, tone: Tone } | null
}

let page: PageState | null = null

const getJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`)
  return await response.json() as T
}

const options = <T extends string | number>(select: HTMLSelectElement, choices: readonly Choice<T>[], value: T): void => {
  select.replaceChildren(...choices.map((choice) => h('option', { value: String(choice.value) }, choice.label)))
  select.value = String(value)
}

// a row cell: its label, the control, and a slot for the control's error
const cell = (key: FieldKey, name: string, label: string, control: HTMLElement, extra: HTMLElement[] = []): HTMLDivElement =>
  h('div', { class: `cell cell-${name}` },
    h('label', { for: fieldId(key), class: 'row-label' }, label),
    control,
    ...extra,
    h('p', { id: errorId(key), class: 'field-error', hidden: true }))

const textInput = (key: FieldKey, value: string, onInput: (value: string) => void, attrs: Record<string, string> = {}): HTMLInputElement => {
  const input = h('input', { id: fieldId(key), class: 'input', type: 'text', autocomplete: 'off', spellcheck: 'false', ...attrs })
  input.value = value
  input.addEventListener('input', () => onInput(input.value))
  return input
}

const selectInput = <T extends string>(key: FieldKey, choices: readonly Choice<T>[], value: T, onChange: (value: T) => void): HTMLSelectElement => {
  const select = h('select', { id: fieldId(key), class: 'input' })
  options(select, choices, value)
  // the options come from the choices, so the value is one of them
  select.addEventListener('change', () => onChange(select.value as T))
  return select
}

const removeButton = (label: string, onClick: () => void): HTMLButtonElement => {
  const button = h('button', { type: 'button', class: 'icon-button remove', 'aria-label': label, title: label }, svg(removeIcon, { size: 14 }))
  button.addEventListener('click', onClick)
  return button
}

// people

const personPreview = (person: PersonForm): HTMLElement[] => {
  const view = previewPerson(person, page?.saved.people ?? [])
  return [
    avatar(view, 'row'),
    h('span', { class: 'preview-name' }, view.alias === '' ? 'New person' : view.alias),
    h('span', { class: 'preview-color mono' }, view.color ?? 'no color'),
  ]
}

const personRow = (person: PersonForm, index: number): HTMLFieldSetElement => {
  const at = (name: string): FieldKey => `people.${index}.${name}`
  const preview = h('div', { class: 'preview', 'data-preview': person.id }, ...personPreview(person))
  const legend = h('legend', { class: 'sr-only' })
  const remove = removeButton('', () => removePerson(person.id))
  const named = (): void => {
    const login = person.login.trim()
    setText(legend, `Person ${index + 1}${login === '' ? '' : `: ${login}`}`)
    const label = `Remove ${login === '' ? `person ${index + 1}` : login}`
    remove.setAttribute('aria-label', label)
    remove.title = label
  }
  named()
  const edited = (): void => {
    preview.replaceChildren(...personPreview(person))
    named()
    changed()
  }
  const path = textInput(at('avatarPath'), person.avatarPath, (value) => {
    person.avatarPath = value
    edited()
  }, { class: 'input mono', placeholder: '~/Pictures/face.png' })
  const pathWrap = h('div', { class: 'avatar-path' },
    h('label', { for: fieldId(at('avatarPath')), class: 'sr-only' }, 'Image file under ~'),
    path,
    h('p', { id: errorId(at('avatarPath')), class: 'field-error', hidden: true }))
  pathWrap.hidden = person.avatarMode !== 'image'
  const color = h('input', { id: fieldId(at('color')), class: 'input input-color', type: 'color' })
  // a color the picker cannot show keeps the picker's own default, and the check flags it
  if (/^#[0-9A-Fa-f]{6}$/.test(person.color)) color.value = person.color.toLowerCase()
  color.addEventListener('input', () => {
    // the picker answers in lowercase; colors are kept in uppercase like the defaults
    person.color = color.value.toUpperCase()
    edited()
  })
  return h('fieldset', { class: 'row person-grid', 'data-row': person.id },
    legend,
    cell(at('login'), 'login', 'GitHub login', textInput(at('login'), person.login, (value) => {
      person.login = value
      edited()
    }, { class: 'input mono' })),
    cell(at('alias'), 'alias', 'Alias', textInput(at('alias'), person.alias, (value) => {
      person.alias = value
      edited()
    })),
    cell(at('initials'), 'initials', 'Initials', textInput(at('initials'), person.initials, (value) => {
      person.initials = value
      edited()
    }, { maxlength: '3' })),
    cell(at('avatarMode'), 'avatar', 'Avatar', selectInput<AvatarMode>(at('avatarMode'), avatarChoices, person.avatarMode, (value) => {
      person.avatarMode = value
      pathWrap.hidden = value !== 'image'
      edited()
      if (value === 'image') path.focus()
    }), [pathWrap]),
    cell(at('color'), 'color', 'Color', color),
    h('div', { class: 'cell cell-preview' }, h('span', { class: 'row-label', 'aria-hidden': 'true' }, 'Preview'), preview),
    h('div', { class: 'cell cell-remove' }, remove),
  )
}

const renderPeople = (): void => {
  if (page === null) return
  const list = byId('people-list')
  list.replaceChildren(...page.form.people.map(personRow))
  byId('people-empty').hidden = page.form.people.length > 0
  renderSuggestions()
}

const focusField = (key: FieldKey): void => {
  document.getElementById(fieldId(key))?.focus()
}

const addPerson = (login = ''): void => {
  if (page === null) return
  page.form.people.push(newPerson(makeId(), login))
  renderPeople()
  changed()
  focusField(`people.${page.form.people.length - 1}.${login === '' ? 'login' : 'alias'}`)
}

const removePerson = (id: string): void => {
  if (page === null) return
  const index = page.form.people.findIndex((person) => person.id === id)
  if (index < 0) return
  page.form.people.splice(index, 1)
  renderPeople()
  changed()
  // focus moves to the row that took its place, or to Add person when none did
  const next = byId('people-list').querySelectorAll<HTMLButtonElement>('.remove')[Math.min(index, page.form.people.length - 1)]
  ;(next ?? byId('add-person')).focus()
}

const renderSuggestions = (): void => {
  if (page === null) return
  const open = openSuggestions(page.suggestions, page.form)
  byId('suggestions').hidden = open.length === 0
  byId('suggestions-list').replaceChildren(...open.map((suggestion) => {
    const label = `Add ${suggestion.login}, seen ${suggestion.count} ${suggestion.count === 1 ? 'time' : 'times'}`
    const button = h('button', { type: 'button', class: 'button button-small suggestion', 'aria-label': label, title: label },
      avatar({ login: suggestion.login, alias: suggestion.login, initials: '', color: null, avatarUrl: suggestion.avatarUrl }, 'pip'),
      h('span', { class: 'mono' }, suggestion.login),
      h('span', { class: 'muted' }, String(suggestion.count)))
    button.addEventListener('click', () => addPerson(suggestion.login))
    return h('li', {}, button)
  }))
}

// tickets

const sampleChip = (system: TicketForm): HTMLElement => {
  if (page === null) return h('span', {})
  const sample = ticketSample(system, page.form.repo, page.texts)
  if (sample.label === null) return h('span', { class: 'muted small' }, sample.reason)
  const tip = `From ${sample.where}; ${sample.url === null ? 'no link, since the base URL is empty' : `links to ${sample.url}`}`
  return h('span', { class: 'ticket', title: tip }, sample.label, h('span', { class: 'sr-only' }, ` (${tip})`))
}

const ticketRow = (system: TicketForm, index: number): HTMLFieldSetElement => {
  const at = (name: string): FieldKey => `tickets.${index}.${name}`
  const sample = h('div', { class: 'sample' }, sampleChip(system))
  const legend = h('legend', { class: 'sr-only' }, `Ticket system ${index + 1}: ${system.name}`)
  const edited = (): void => {
    sample.replaceChildren(sampleChip(system))
    setText(legend, `Ticket system ${index + 1}: ${system.name.trim()}`)
    changed()
  }
  const pattern = textInput(at('pattern'), system.pattern, (value) => {
    system.pattern = value
    edited()
  }, { class: 'input mono' })
  const linked = (): void => {
    pattern.disabled = system.source === 'linked-issues'
    pattern.placeholder = pattern.disabled ? 'linked, no pattern' : '\\b[a-z]+-\\d+\\b'
  }
  linked()
  const enabled = h('input', { id: fieldId(at('enabled')), type: 'checkbox' })
  enabled.checked = system.enabled
  enabled.addEventListener('change', () => {
    system.enabled = enabled.checked
    edited()
  })
  return h('fieldset', { class: 'row ticket-grid', 'data-row': system.id },
    legend,
    h('div', { class: 'cell cell-on' }, h('label', { class: 'check' }, enabled, 'On')),
    cell(at('kind'), 'kind', 'Kind', selectInput<TicketKind>(at('kind'), kindChoices, system.kind, (value) => {
      const next = changeKind(system, value)
      const list = page?.form.tickets
      if (list === undefined) return
      list[index] = next
      renderTickets()
      changed()
      focusField(at('kind'))
    })),
    cell(at('name'), 'name', 'Name', textInput(at('name'), system.name, (value) => {
      system.name = value
      edited()
    })),
    cell(at('source'), 'source', 'Finds tickets in', selectInput(at('source'), sourceChoices, system.source, (value) => {
      system.source = value
      linked()
      edited()
    })),
    h('div', { class: 'cell cell-sample' }, h('span', { class: 'row-label', 'aria-hidden': 'true' }, 'Shows as'), sample),
    h('div', { class: 'cell cell-remove' }, removeButton(`Remove ${system.name.trim() === '' ? `ticket system ${index + 1}` : system.name.trim()}`, () => removeTicket(system.id))),
    cell(at('pattern'), 'pattern', 'Key pattern', pattern),
    cell(at('baseUrl'), 'base', 'Base URL', textInput(at('baseUrl'), system.baseUrl, (value) => {
      system.baseUrl = value
      edited()
    }, { class: 'input mono', placeholder: 'https://tickets.example.com', inputmode: 'url' })),
    cell(at('linkTemplate'), 'template', 'Link template', textInput(at('linkTemplate'), system.linkTemplate, (value) => {
      system.linkTemplate = value
      edited()
    }, { class: 'input mono' })),
  )
}

const renderTickets = (): void => {
  if (page === null) return
  byId('tickets-list').replaceChildren(...page.form.tickets.map(ticketRow))
  byId('tickets-empty').hidden = page.form.tickets.length > 0
}

const refreshSamples = (): void => {
  if (page === null) return
  for (const system of page.form.tickets) {
    const slot = document.querySelector(`[data-row="${system.id}"] .sample`)
    slot?.replaceChildren(sampleChip(system))
  }
}

const removeTicket = (id: string): void => {
  if (page === null) return
  const index = page.form.tickets.findIndex((system) => system.id === id)
  if (index < 0) return
  page.form.tickets.splice(index, 1)
  renderTickets()
  changed()
  const next = byId('tickets-list').querySelectorAll<HTMLButtonElement>('.remove')[Math.min(index, page.form.tickets.length - 1)]
  ;(next ?? byId('add-ticket')).focus()
}

// the fixed fields

const staticText = ['repo', 'viewer', 'bots', 'reportsDir'] as const

const fillStatic = (): void => {
  if (page === null) return
  const { form, ghLogin } = page
  for (const key of staticText) byId<HTMLInputElement>(fieldId(key)).value = form[key]
  const viewer = byId<HTMLInputElement>(fieldId('viewer'))
  viewer.placeholder = ghLogin === '' ? 'the gh login' : `${ghLogin} (the gh login)`
  setText(byId('f-viewer-hint'), `Defaults to the gh login${ghLogin === '' ? '' : `, ${ghLogin}`}. Uses gh's own token; nothing else to sign in to.`)
  options(byId<HTMLSelectElement>(fieldId('refreshSeconds')), refreshChoices, form.refreshSeconds)
  options(byId<HTMLSelectElement>(fieldId('todayStartsAt')), todayChoices(Intl.DateTimeFormat().resolvedOptions().timeZone), form.todayStartsAt)
  options(byId<HTMLSelectElement>(fieldId('density')), densityChoices, form.density)
  byId<HTMLInputElement>(fieldId('showAgentColumn')).checked = form.showAgentColumn
}

const bindStatic = (): void => {
  for (const key of staticText) {
    const input = byId<HTMLInputElement>(fieldId(key))
    input.addEventListener('input', () => {
      if (page === null) return
      page.form[key] = input.value
      // the repo fills {repo} in the samples
      if (key === 'repo') refreshSamples()
      changed()
    })
  }
  const refresh = byId<HTMLSelectElement>(fieldId('refreshSeconds'))
  refresh.addEventListener('change', () => {
    if (page === null) return
    page.form.refreshSeconds = refreshChoices.find((choice) => String(choice.value) === refresh.value)?.value ?? 300
    changed()
  })
  const today = byId<HTMLSelectElement>(fieldId('todayStartsAt'))
  today.addEventListener('change', () => {
    if (page === null) return
    page.form.todayStartsAt = today.value === 'utc' ? 'utc' : 'local'
    changed()
  })
  const density = byId<HTMLSelectElement>(fieldId('density'))
  density.addEventListener('change', () => {
    if (page === null) return
    page.form.density = density.value === 'compact' ? 'compact' : 'comfortable'
    changed()
  })
  const agent = byId<HTMLInputElement>(fieldId('showAgentColumn'))
  agent.addEventListener('change', () => {
    if (page === null) return
    page.form.showAgentColumn = agent.checked
    changed()
  })
}

// errors: each on its field, through aria-invalid and aria-describedby, and listed above the form

// a field's name in the summary: its label, with the row it sits in
const fieldName = (key: FieldKey): string => {
  const label = document.querySelector(`label[for="${fieldId(key)}"]`)?.textContent?.trim() ?? key
  const row = /^(people|tickets)\.(\d+)\./.exec(key)
  if (row === null) return label
  return `${row[1] === 'people' ? 'Person' : 'Ticket system'} ${Number(row[2]) + 1}, ${label.toLowerCase()}`
}

const showErrors = (): void => {
  if (page === null) return
  for (const element of document.querySelectorAll<HTMLElement>('[aria-invalid="true"]')) {
    element.removeAttribute('aria-invalid')
    const hint = element.dataset.hint
    if (hint === undefined) element.removeAttribute('aria-describedby')
    else element.setAttribute('aria-describedby', hint)
  }
  for (const slot of document.querySelectorAll<HTMLElement>('.field-error')) {
    slot.hidden = true
    slot.textContent = ''
  }
  for (const error of page.errors) {
    if (error.field === null) continue
    const control = document.getElementById(fieldId(error.field))
    const slot = document.getElementById(errorId(error.field))
    if (control === null || slot === null) continue
    slot.textContent = error.message
    slot.hidden = false
    if (control.getAttribute('aria-invalid') !== 'true') {
      const hint = control.getAttribute('aria-describedby')
      if (hint !== null) control.dataset.hint = hint
      else delete control.dataset.hint
      control.setAttribute('aria-invalid', 'true')
      control.setAttribute('aria-describedby', [hint, errorId(error.field)].filter((id) => id !== null).join(' '))
    }
  }
  const summary = byId('form-errors')
  summary.hidden = page.errors.length === 0
  if (page.errors.length === 0) {
    summary.replaceChildren()
    return
  }
  const count = page.errors.length
  summary.replaceChildren(
    h('h2', { class: 'form-errors-title' }, `${count === 1 ? 'One problem' : `${count} problems`} to fix before saving`),
    h('ul', {}, ...page.errors.map((error) => {
      if (error.field === null) return h('li', {}, error.message)
      const key = error.field
      const link = h('a', { href: `#${fieldId(key)}` }, `${fieldName(key)}: ${error.message}`)
      link.addEventListener('click', (event) => {
        event.preventDefault()
        focusField(key)
      })
      return h('li', {}, link)
    })),
  )
}

// the save bar's line, and Discard only while there is something to discard

const setStatus = (text: string, tone: Tone = 'normal'): void => {
  if (page === null) return
  page.status = { text, tone }
  showStatus()
}

const showStatus = (): void => {
  if (page === null) return
  const dirty = isDirty(page.form, page.saved)
  const line = byId('save-status')
  const status = page.status ?? (dirty ? { text: 'Unsaved changes', tone: 'normal' as Tone } : { text: '', tone: 'normal' as Tone })
  setText(line, status.text)
  line.dataset.tone = status.tone
  byId<HTMLButtonElement>('revert').disabled = !dirty || page.saving
  byId<HTMLButtonElement>('save').disabled = page.saving
}

// every edit: errors follow along once a save was refused, and the status line catches up
const changed = (): void => {
  if (page === null) return
  if (page.checking) page.errors = validateForm(page.form)
  // a message about the last save no longer describes the form
  page.status = null
  showErrors()
  renderSuggestions()
  showStatus()
}

const renderAll = (): void => {
  fillStatic()
  renderPeople()
  renderTickets()
  showErrors()
  showStatus()
}

const save = async (): Promise<void> => {
  if (page === null || page.saving) return
  const current = page
  current.errors = validateForm(current.form)
  current.checking = true
  showErrors()
  if (current.errors.length > 0) {
    setStatus('Nothing saved yet: fix the fields marked above.', 'error')
    byId('form-errors').focus()
    return
  }
  if (!isDirty(current.form, current.saved)) {
    setStatus('No changes to save.')
    return
  }
  const config = toConfig(current.form, current.saved)
  current.saving = true
  setStatus('Saving…')
  try {
    const response = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
    const body = await response.json() as Config | { error?: string }
    if (response.status === 400) {
      current.errors = [serverError('error' in body ? body.error ?? 'the settings were refused' : 'the settings were refused', current.form)]
      showErrors()
      setStatus('Nothing saved: Pit View refused the settings.', 'error')
      byId('form-errors').focus()
      return
    }
    if (!response.ok) throw new Error(`PUT /api/config answered ${response.status}`)
    const before = current.saved
    current.saved = body as Config
    current.form = toForm(current.saved, makeId)
    current.errors = []
    current.checking = false
    renderAll()
    const at = formatClock(new Date().toISOString())
    setStatus(needsRefresh(before, current.saved) ? `Saved at ${at}. The dashboard is refreshing from GitHub with these settings.` : `Saved at ${at}.`, 'ok')
    try {
      const channel = new BroadcastChannel(configChannel)
      channel.postMessage('saved')
      channel.close()
    } catch {
      // an open dashboard still gets the server's patch; only density and the agent column wait
    }
    // a new repo or new people change what the suggestions and samples come from
    void loadExtras()
  } catch {
    setStatus('Could not reach Pit View; nothing was saved.', 'error')
  } finally {
    current.saving = false
    showStatus()
  }
}

const revert = (): void => {
  if (page === null) return
  page.form = toForm(page.saved, makeId)
  page.errors = []
  page.checking = false
  page.status = null
  renderAll()
  setStatus('Changes discarded.')
}

// the view (for the gh login and sample keys) and the suggestions are extras: the form works without them
const loadExtras = async (): Promise<void> => {
  const [view, suggestions] = await Promise.all([
    getJson<View>('/api/view').catch(() => null),
    getJson<Suggestion[]>('/api/people/suggestions').catch(() => []),
  ])
  if (page === null) return
  page.ghLogin = view?.viewer.login ?? ''
  page.texts = sampleTextsFrom(view)
  page.suggestions = suggestions
  const viewer = byId<HTMLInputElement>(fieldId('viewer'))
  viewer.placeholder = page.ghLogin === '' ? 'the gh login' : `${page.ghLogin} (the gh login)`
  setText(byId('f-viewer-hint'), `Defaults to the gh login${page.ghLogin === '' ? '' : `, ${page.ghLogin}`}. Uses gh's own token; nothing else to sign in to.`)
  refreshSamples()
  renderSuggestions()
}

const load = async (): Promise<void> => {
  const state = byId('load-state')
  let saved: Config
  try {
    saved = await getJson<Config>('/api/config')
  } catch {
    const retry = h('button', { type: 'button', class: 'button button-small' }, 'Try again')
    retry.addEventListener('click', () => {
      setText(state, 'Loading the settings…')
      void load()
    })
    state.replaceChildren('Could not load the settings from Pit View. ', retry)
    return
  }
  page = {
    saved,
    form: toForm(saved, makeId),
    ghLogin: '',
    texts: [],
    suggestions: [],
    errors: [],
    checking: false,
    saving: false,
    status: null,
  }
  renderAll()
  state.hidden = true
  byId('settings-form').hidden = false
  // the header's repo button links to #repository: land in its field
  const target = window.location.hash.slice(1)
  if (target === 'repository') focusField('repo')
  else if (target !== '') document.getElementById(target)?.scrollIntoView()
  await loadExtras()
}

setText(byId('config-path'), configPathText)
void loadInstance().then((info) => {
  if (info === null) return
  showInstance(info)
  setText(byId('config-path'), info.configPath)
})
mountThemeToggle(byId<HTMLButtonElement>('theme'))
bindStatic()

byId('settings-form').addEventListener('submit', (event) => {
  event.preventDefault()
  void save()
})
byId('revert').addEventListener('click', revert)
byId('add-person').addEventListener('click', () => addPerson())
byId('add-ticket').addEventListener('click', () => {
  if (page === null) return
  page.form.tickets.push(newTicket(makeId(), page.form.tickets.length === 0 ? 'jira' : 'template'))
  renderTickets()
  changed()
  focusField(`tickets.${page.form.tickets.length - 1}.kind`)
})

// leaving with unsaved changes asks first
window.addEventListener('beforeunload', (event) => {
  if (page !== null && isDirty(page.form, page.saved)) event.preventDefault()
})

void load()
