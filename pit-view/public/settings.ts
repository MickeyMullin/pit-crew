// public/settings.ts
// the Settings page: loads the config, edits it in a form, checks it, and saves it through
// PUT /api/config, which patches open dashboards and starts the refresh a change needs
import type { AutoReviewView } from '../src/autoreview.ts'
import type { Config } from '../src/config.ts'
import type { View } from '../src/poller.ts'
import { avatar } from './cells.ts'
import { tokenHeader } from './agent.ts'
import { byId, h, setText, svg } from './dom.ts'
import type { Shape } from './dom.ts'
import { browserTimeZone, formatClock, parseTimeFormat, setTimeFormat } from './format.ts'
import { loadInstance, loginAgentText, showInstance, showSignOut } from './instance.ts'
import {
  atSectionDefaults, autoCapError, avatarChoices, changeKind, configChannel, configPathText, dayNames, densityChoices, errorId, fieldId, inertPostKinds, inertPostNote, instructionsLine, intervalLegacyNote, intervalOptions, isDirty,
  kindChoices, limitsSummary, needsRefresh, nowLine, nowUnsavedNote, opensLimits, postingAsLine, resetSection, scheduleSummary,
  newPerson, newTicket, notifyChoices, openSuggestions, previewPerson, refreshChoices, sampleTextsFrom, serverError, sourceChoices, ticketSample, timeFormatChoices,
  postAskIsStale, postSwitchesToTurnOff, postViewerNeededText, postingAsk, postingLoginOf, postingNeedsViewer, toConfig, todayChoices, toForm, validateForm, wantsPostConfirm, weekdayChoices,
} from './settings-form.ts'
import type { AutoSection, AvatarMode, Choice, FieldError, FieldKey, Form, PersonForm, PostConfirmed, PostKind, SampleText, Suggestion, TicketForm, TicketKind } from './settings-form.ts'
import { readToken } from './runapi.ts'
import { mountStickyHeader, trackHeight } from './sticky.ts'
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
  texts: SampleText[]
  suggestions: Suggestion[]
  errors: FieldError[]
  // after a refused save the checks follow every edit; before one they wait for Save
  checking: boolean
  saving: boolean
  status: { text: string, tone: Tone } | null
  // the posting switch whose confirmation is open; the switch stays off until it is confirmed
  postAsk: PostKind | null
  // the login that question named when it was drawn
  postAskLogin: string
  // the login each posting switch was confirmed for, until the form is saved or reloaded; a switch already saved on has none
  postConfirmed: PostConfirmed
  // the scheduler's view for the Now line; null when it could not be read
  autoView: AutoReviewView | null
  // the Limits disclosure; not stored, and held open while an error stands in its fields
  limitsOpen: boolean
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

// a group of checkboxes (the active days) takes focus on its first box
const focusField = (key: FieldKey): void => {
  // a field inside the closed Limits disclosure opens it first
  if (opensLimits(key) && page !== null && !page.limitsOpen) {
    page.limitsOpen = true
    showLimits()
  }
  const field = document.getElementById(fieldId(key))
  const target = field instanceof HTMLFieldSetElement ? field.querySelector<HTMLElement>('input') : field
  target?.focus()
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

const staticText = ['repo', 'viewer', 'idleMinutes', 'bots', 'reportsDir', 'maxConcurrentReviews', 'extraReviewInstructions', 'cloneDir', 'autoFrom', 'autoTo', 'autoConcurrency', 'autoDailyLimit'] as const

// the auto-review switches that need no question, by form key
const autoSwitches = ['autoEnabled', 'autoOthers', 'autoOwn', 'autoDependabot'] as const

const postSwitches: readonly { kind: PostKind, key: 'autoPostOthers' | 'autoPostDependabot' }[] = [
  { kind: 'others', key: 'autoPostOthers' },
  { kind: 'dependabot', key: 'autoPostDependabot' },
]

const fillStatic = (): void => {
  if (page === null) return
  const { form } = page
  for (const key of staticText) byId<HTMLInputElement>(fieldId(key)).value = form[key]
  // the saved interval is offered even when it is not one of the four, until another value is saved
  options(byId<HTMLSelectElement>(fieldId('autoInterval')), intervalOptions(String(page.saved.autoReview?.intervalMinutes ?? form.autoInterval)), Number(form.autoInterval.trim()))
  options(byId<HTMLSelectElement>(fieldId('refreshSeconds')), refreshChoices, form.refreshSeconds)
  options(byId<HTMLSelectElement>(fieldId('todayStartsAt')), todayChoices(browserTimeZone()), form.todayStartsAt)
  options(byId<HTMLSelectElement>(fieldId('density')), densityChoices, form.density)
  options(byId<HTMLSelectElement>(fieldId('timeFormat')), timeFormatChoices, form.timeFormat)
  byId<HTMLInputElement>(fieldId('showAgentColumn')).checked = form.showAgentColumn
  byId<HTMLInputElement>(fieldId('selfReviewOverCap')).checked = form.selfReviewOverCap
  byId<HTMLInputElement>(fieldId('notifyEnabled')).checked = form.notifyEnabled
  for (const key of autoSwitches) byId<HTMLInputElement>(fieldId(key)).checked = form[key]
  for (const { key } of postSwitches) byId<HTMLInputElement>(fieldId(key)).checked = form[key]
  byId('auto-days').replaceChildren(...weekdayChoices.map((day) => {
    const box = h('input', { id: fieldId(`autoDay.${day.value}`), type: 'checkbox' })
    box.checked = form.autoDays.includes(day.value)
    box.addEventListener('change', () => {
      if (page === null) return
      const without = page.form.autoDays.filter((chosen) => chosen !== day.value)
      page.form.autoDays = box.checked ? [...without, day.value] : without
      changed()
    })
    box.setAttribute('aria-label', dayNames[day.value])
    return h('label', { class: 'day-chip' }, box, day.label)
  }))
  showPostAsk()
  byId('notify-kinds').replaceChildren(...notifyChoices.map((choice) => {
    const id = fieldId(`notifyKind.${choice.kind}`)
    const box = h('input', { id, type: 'checkbox', 'aria-describedby': `${id}-hint` })
    box.checked = form.notifyKinds.includes(choice.kind)
    box.addEventListener('change', () => {
      if (page === null) return
      const without = page.form.notifyKinds.filter((kind) => kind !== choice.kind)
      page.form.notifyKinds = box.checked ? [...without, choice.kind] : without
      changed()
    })
    return h('div', { class: 'kind' }, h('label', { class: 'check' }, box, choice.label), h('p', { id: `${id}-hint`, class: 'hint' }, choice.hint))
  }))
}

// the login a posting question names: the viewer typed in the form and nothing else
const postingLogin = (): string => page === null ? '' : postingLoginOf(page.form.viewer)

// an open question closes, with its switch still off, when the login it names is no longer the one typed in the viewer field, or the field is cleared; it does not move focus, since the viewer field is usually being typed in
const closeStalePostAsk = (): void => {
  if (page === null || page.postAsk === null || !postAskIsStale(page.postAskLogin, page.form.viewer)) return
  page.postAsk = null
  showPostAsk()
}

const postNoticeText = 'Turned off because the login changed. Turn it on again to be asked again.'

// a switch confirmed for a login the viewer field no longer holds goes back off, with a short notice beside it and no move of focus, and its record is cleared so it stays off until turned on again
const turnOffUnconfirmed = (): void => {
  if (page === null) return
  const kinds = postSwitchesToTurnOff(page.postConfirmed, page.form, postingLogin())
  if (kinds.length === 0) return
  for (const kind of kinds) {
    const key = postSwitches.find((entry) => entry.kind === kind)?.key
    if (key === undefined) continue
    page.form[key] = false
    byId<HTMLInputElement>(fieldId(key)).checked = false
    delete page.postConfirmed[kind]
    const notice = byId(`${fieldId(key)}-notice`)
    setText(notice, postNoticeText)
    notice.hidden = false
  }
  changed()
}

// the open confirmation under its switch, and none under the other; Cancel and the confirm button are real buttons inside the group, and focus returns to the switch; the confirm button takes focus only when the user has just opened the question, never on a redraw
const showPostAsk = (opened = false): void => {
  if (page === null) return
  for (const { kind, key } of postSwitches) {
    const slot = byId(`auto-post-ask-${kind}`)
    if (page.postAsk !== kind) {
      slot.hidden = true
      slot.replaceChildren()
      continue
    }
    const ask = postingAsk(kind, postingLogin())
    const confirm = h('button', { type: 'button', class: 'button button-primary', 'data-focus-key': `post-ask-confirm:${kind}` }, ask.confirm)
    const cancel = h('button', { type: 'button', class: 'button' }, ask.cancel)
    const close = (): void => {
      if (page === null) return
      page.postAsk = null
      showPostAsk()
      byId<HTMLInputElement>(fieldId(key)).focus()
    }
    confirm.addEventListener('click', () => {
      if (page === null) return
      page.form[key] = true
      page.postConfirmed[kind] = page.postAskLogin
      byId<HTMLInputElement>(fieldId(key)).checked = true
      changed()
      close()
    })
    cancel.addEventListener('click', () => {
      if (page !== null) delete page.postConfirmed[kind]
      close()
    })
    slot.setAttribute('aria-labelledby', `post-ask-title-${kind}`)
    slot.replaceChildren(
      h('p', { id: `post-ask-title-${kind}`, class: 'post-ask-title' }, ask.title),
      ...ask.lines.map((line) => h('p', {}, line)),
      h('div', { class: 'post-ask-buttons' }, confirm, cancel))
    slot.hidden = false
    if (opened) confirm.focus()
  }
}

const bindStatic = (): void => {
  for (const key of autoSwitches) {
    const box = byId<HTMLInputElement>(fieldId(key))
    box.addEventListener('change', () => {
      if (page === null) return
      page.form[key] = box.checked
      changed()
    })
  }
  // turning a posting switch on asks first and stays off until confirmed; turning one off is immediate
  for (const { kind, key } of postSwitches) {
    const box = byId<HTMLInputElement>(fieldId(key))
    box.addEventListener('change', () => {
      if (page === null) return
      // the same box again while its question is open is Cancel: the question closes, the switch stays off, and nothing is confirmed
      if (page.postAsk === kind) {
        dismissPostAsk(kind, key)
        return
      }
      if (wantsPostConfirm(page.form, kind, box.checked)) {
        box.checked = false
        const notice = byId(`${fieldId(key)}-notice`)
        // the confirmation has to name an account, so an empty viewer field opens no question and the switch stays off; the notice does not take focus
        if (postingNeedsViewer(page.form.viewer)) {
          showViewerNotice(notice, postViewerNeededText)
          return
        }
        notice.hidden = true
        page.postAsk = kind
        page.postAskLogin = postingLogin()
        showPostAsk(true)
        return
      }
      page.postAsk = null
      page.form[key] = box.checked
      delete page.postConfirmed[kind]
      byId(`${fieldId(key)}-notice`).hidden = true
      showPostAsk()
      changed()
    })
  }
  for (const key of staticText) {
    const input = byId<HTMLInputElement>(fieldId(key))
    input.addEventListener('input', () => {
      if (page === null) return
      page.form[key] = input.value
      // the repo fills {repo} in the samples
      if (key === 'repo') refreshSamples()
      if (key === 'viewer') {
        closeStalePostAsk()
        turnOffUnconfirmed()
      }
      changed()
    })
  }
  const interval = byId<HTMLSelectElement>(fieldId('autoInterval'))
  interval.addEventListener('change', () => {
    if (page === null) return
    page.form.autoInterval = interval.value
    changed()
  })
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
  const timeFormat = byId<HTMLSelectElement>(fieldId('timeFormat'))
  timeFormat.addEventListener('change', () => {
    if (page === null) return
    page.form.timeFormat = parseTimeFormat(timeFormat.value)
    changed()
  })
  const notify = byId<HTMLInputElement>(fieldId('notifyEnabled'))
  notify.addEventListener('change', () => {
    if (page === null) return
    page.form.notifyEnabled = notify.checked
    changed()
  })
  const agent = byId<HTMLInputElement>(fieldId('showAgentColumn'))
  agent.addEventListener('change', () => {
    if (page === null) return
    page.form.showAgentColumn = agent.checked
    changed()
  })
  const over = byId<HTMLInputElement>(fieldId('selfReviewOverCap'))
  over.addEventListener('change', () => {
    if (page === null) return
    page.form.selfReviewOverCap = over.checked
    changed()
  })
}

// clicking the box of an open question again is Cancel: it closes the question, forgets any confirmation, leaves the switch off, and returns focus to the switch as Cancel does
const dismissPostAsk = (kind: PostKind, key: 'autoPostOthers' | 'autoPostDependabot'): void => {
  if (page === null) return
  delete page.postConfirmed[kind]
  page.postAsk = null
  showPostAsk()
  const box = byId<HTMLInputElement>(fieldId(key))
  box.checked = false
  box.focus()
}

// a link to the Viewing as field that moves focus only when it is used
const viewerLink = (text: string): HTMLAnchorElement => {
  const link = h('a', { href: `#${fieldId('viewer')}` }, text)
  link.addEventListener('click', (event) => {
    event.preventDefault()
    byId(fieldId('viewer')).focus()
  })
  return link
}

// the empty-viewer notice: its sentence, then a link to the field; the notice itself takes no focus
const showViewerNotice = (notice: HTMLElement, text: string): void => {
  notice.replaceChildren(text, ' ', viewerLink('Go to Viewing as'))
  notice.hidden = false
}

// the Limits disclosure and its Reset to Defaults button, which shows only while it is open
const showLimits = (): void => {
  if (page === null) return
  byId('limits-toggle').setAttribute('aria-expanded', String(page.limitsOpen))
  byId('limits-body').hidden = !page.limitsOpen
  byId('reset-limits').hidden = !page.limitsOpen
}

const resetButtons: readonly { id: string, section: AutoSection, focus: string }[] = [
  { id: 'reset-schedule', section: 'schedule', focus: fieldId('autoDay.sun') },
  { id: 'reset-what', section: 'what', focus: fieldId('autoOthers') },
  { id: 'reset-post', section: 'post', focus: fieldId('autoPostOthers') },
  { id: 'reset-limits', section: 'limits', focus: fieldId('autoConcurrency') },
]

// Reset to Defaults sets one section's fields in the form and saves nothing; in the posting section it turns both switches off without asking, closes an open question, and clears the notices
const resetAuto = (section: AutoSection, focus: string): void => {
  if (page === null) return
  page.form = resetSection(page.form, section)
  if (section === 'post') {
    page.postAsk = null
    page.postConfirmed = {}
    for (const { key } of postSwitches) byId(`${fieldId(key)}-notice`).hidden = true
  }
  fillStatic()
  changed()
  byId(focus).focus()
}

const link = (text: string, target: string): HTMLAnchorElement => {
  const anchor = h('a', { href: `#${target}` }, text)
  anchor.addEventListener('click', (event) => {
    event.preventDefault()
    byId(target).focus()
  })
  return anchor
}

// everything the card derives from the form and the saved settings: the Now line, the summaries, the notes, and the reference lines; text only, so it never moves focus
const showAuto = (): void => {
  if (page === null) return
  const { form } = page
  const now = nowLine({ saved: page.saved.autoReview, view: page.autoView, viewer: page.saved.viewer, reading: { nowMs: Date.now() } })
  byId('auto-now').dataset.tone = now.tone
  setText(byId('auto-now-text'), now.text)
  setText(byId('auto-now-meta'), now.meta)
  const fix = byId('auto-now-fix')
  setText(fix, now.fix ?? '')
  fix.hidden = now.fix === null
  const unsaved = byId('auto-now-unsaved')
  setText(unsaved, nowUnsavedNote)
  unsaved.hidden = !isDirty(form, page.saved)
  setText(byId('schedule-summary'), scheduleSummary(form, browserTimeZone()))
  const select = byId<HTMLSelectElement>(fieldId('autoInterval'))
  const legacy = byId('f-autoInterval-legacy')
  const note = intervalLegacyNote(form.autoInterval)
  setText(legacy, note ?? '')
  legacy.hidden = note === null
  if (select.getAttribute('aria-invalid') !== 'true') {
    if (note === null) select.removeAttribute('aria-describedby')
    else select.setAttribute('aria-describedby', 'f-autoInterval-legacy')
  }
  setText(byId('limits-summary'), limitsSummary(form))
  const cap = Number(form.maxConcurrentReviews.trim())
  const concurrency = byId<HTMLInputElement>(fieldId('autoConcurrency'))
  if (Number.isSafeInteger(cap) && cap >= 1 && form.maxConcurrentReviews.trim() !== '') concurrency.setAttribute('max', String(cap))
  else concurrency.removeAttribute('max')
  for (const { id, section } of resetButtons) byId<HTMLButtonElement>(id).disabled = atSectionDefaults(form, section)
  const as = postingAsLine(form.viewer)
  const posting = byId('posting-as')
  posting.replaceChildren(as.before, ...(as.login === '' ? [] : [h('strong', {}, as.login), as.after]), viewerLink(as.link))
  const inert = inertPostKinds(form)
  for (const { kind, key } of postSwitches) {
    const slot = byId(`${fieldId(key)}-inert`)
    setText(slot, inert.includes(kind) ? inertPostNote(kind) : '')
    slot.hidden = !inert.includes(kind)
  }
  byId('instructions-ref').replaceChildren(instructionsLine(form.extraReviewInstructions), link('Edit in Agent', fieldId('extraReviewInstructions')))
  const clone = form.cloneDir.trim()
  byId('clone-ref').replaceChildren(...(clone === ''
    ? [h('span', { class: 'warn-text' }, 'No clone folder is set, so no auto-review run can start.'), ' ', link('Set it in Agent', fieldId('cloneDir'))]
    : ['Each run works in its own worktree of ', h('span', { class: 'mono' }, clone), ', never in the checkout itself. ', link('Change in Agent', fieldId('cloneDir'))]))
  showLimits()
}

// the errors the form shows without a Save: only the cap rule, which follows either number as it is typed; every other check waits for the first Save
const liveErrors = (form: Form): FieldError[] => {
  const over = autoCapError(form)
  return over === null ? [] : [over]
}

// errors: each on its field, through aria-invalid and aria-describedby, and listed above the form

// a field's name in the summary: its label, with the row it sits in
const fieldName = (key: FieldKey): string => {
  const label = document.querySelector(`label[for="${fieldId(key)}"]`)?.textContent?.trim() ?? document.getElementById(fieldId(key))?.querySelector('legend')?.textContent?.trim() ?? key
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
  // a field with an error is never left inside the closed Limits disclosure
  if (page.errors.some((error) => opensLimits(error.field)) && !page.limitsOpen) {
    page.limitsOpen = true
    showLimits()
  }
  // the cap rule shows on its field as the numbers change; the summary waits for a Save
  const summary = byId('form-errors')
  summary.hidden = !page.checking || page.errors.length === 0
  if (summary.hidden) {
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
  page.errors = page.checking ? validateForm(page.form) : liveErrors(page.form)
  // a message about the last save no longer describes the form
  page.status = null
  showErrors()
  showAuto()
  renderSuggestions()
  showStatus()
}

const renderAll = (): void => {
  for (const { key } of postSwitches) byId(`${fieldId(key)}-notice`).hidden = true
  fillStatic()
  renderPeople()
  renderTickets()
  if (page !== null) page.errors = page.checking ? page.errors : liveErrors(page.form)
  showErrors()
  showAuto()
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
      headers: { 'Content-Type': 'application/json', [tokenHeader]: readToken(document) },
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
    setTimeFormat(parseTimeFormat(current.saved.timeFormat))
    current.form = toForm(current.saved, makeId)
    current.errors = []
    current.checking = false
    current.postAsk = null
    current.postConfirmed = {}
    renderAll()
    const at = formatClock(Date.now())
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
  page.postAsk = null
  page.postConfirmed = {}
  renderAll()
  setStatus('Changes discarded.')
}

// the view (for sample keys) and the suggestions are extras: the form works without them
const loadExtras = async (): Promise<void> => {
  const [view, suggestions] = await Promise.all([
    getJson<View>('/api/view').catch(() => null),
    getJson<Suggestion[]>('/api/people/suggestions').catch(() => []),
  ])
  if (page === null) return
  page.texts = sampleTextsFrom(view)
  page.suggestions = suggestions
  page.autoView = view?.autoReview ?? null
  refreshSamples()
  renderSuggestions()
  showAuto()
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
    texts: [],
    suggestions: [],
    errors: [],
    checking: false,
    saving: false,
    status: null,
    postAsk: null,
    postAskLogin: '',
    postConfirmed: {},
    autoView: null,
    limitsOpen: false,
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
  setText(byId('login-agent-status'), loginAgentText(info.loginAgent))
})
mountStickyHeader(byId('site-header'))
trackHeight(byId('save-bar'), '--save-bar-height')
mountThemeToggle(byId<HTMLButtonElement>('theme'))
showSignOut(document)
bindStatic()

byId('settings-form').addEventListener('submit', (event) => {
  event.preventDefault()
  void save()
})
byId('revert').addEventListener('click', revert)
byId('limits-toggle').addEventListener('click', () => {
  if (page === null) return
  // it stays open while an error stands in its fields
  if (page.limitsOpen && page.errors.some((error) => opensLimits(error.field))) return
  page.limitsOpen = !page.limitsOpen
  showLimits()
})
for (const { id, section, focus } of resetButtons) byId(id).addEventListener('click', () => resetAuto(section, focus))
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
