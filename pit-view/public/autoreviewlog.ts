// public/autoreviewlog.ts
// the auto-review log panel (autoreviewlogview.ts says what each line reads): opened with Log in the header's Auto-review menu, a non-modal panel on the right where the drawer sits, its lines fetched when it opens and again when the scheduler's state changes, three labeled filters, and a run link that opens that run's drawer, whose link back shows the log again at that line (restore). Escape and Close shut it and put focus back on the header's Auto-review button
import type { LogEntry } from '../src/autoreviewlog.ts'
import type { View } from '../src/poller.ts'
import { entryAnchor, logModel, noFilters } from './autoreviewlogview.ts'
import type { LogChoice, LogFilters, LogModel, LogRunLink } from './autoreviewlogview.ts'
import { h, setText, svg } from './dom.ts'
import { getJson } from './runapi.ts'

export type AutoReviewLogPanel = {
  open: () => void
  // the log shown again for a link back from a run's drawer: the filters it had are kept, and when its lines arrive the line with that entry id is scrolled into view and its run link takes focus. A line that is gone or hidden by a filter leaves the log at the top, with nothing said
  restore: (entryId: number) => void
  // returnFocus puts focus back on the header's Auto-review button
  close: (returnFocus?: boolean) => void
  isOpen: () => boolean
  // after each draw: ages move, and a change in the scheduler's state reads the log again
  update: () => void
}

type Deps = {
  root: HTMLElement
  nowMs: () => number
  view: () => View | null
  isOpen: (number: number) => boolean
  // a run link was pressed: the panel has closed, and the run's drawer opens
  openRun: (link: LogRunLink) => void
  // where focus goes back to when the panel closes
  returnTo: () => HTMLElement | null
}

type Load = { state: 'loading' } | { state: 'error' } | { state: 'ready', days: number, entries: LogEntry[] }

const filterKeys = ['pr', 'decision', 'day'] as const

export const createAutoReviewLogPanel = ({ root, nowMs, view, isOpen, openRun, returnTo }: Deps): AutoReviewLogPanel => {
  let load: Load = { state: 'loading' }
  let filters: LogFilters = { ...noFilters }
  let request = 0
  // the scheduler's state when the log was last read: a change reads it again
  let readFor = ''
  // the entry a link back from a run's drawer asked to land on, until the lines have arrived and it has been looked for once; no scroll position is kept anywhere, since the line's own element is the place
  let landOn: number | null = null

  const heading = h('h2', { id: 'auto-log-heading', class: 'drawer-heading', tabindex: '-1' }, 'Auto-review log')
  const sub = h('p', { class: 'drawer-pr-sub', id: 'auto-log-summary' })
  const closeButton = h('button', { type: 'button', class: 'icon-button drawer-close', 'aria-label': 'Close the auto-review log', title: 'Close the auto-review log' },
    svg([['path', { d: 'M6 6l12 12' }], ['path', { d: 'M18 6L6 18' }]], { size: 14, stroke: '2.4' }))
  const selects: Record<typeof filterKeys[number], HTMLSelectElement> = {
    pr: h('select', { id: 'auto-log-pr', class: 'filter-select' }),
    decision: h('select', { id: 'auto-log-decision', class: 'filter-select' }),
    day: h('select', { id: 'auto-log-day', class: 'filter-select' }),
  }
  const labels: Record<typeof filterKeys[number], string> = { pr: 'PR', decision: 'Decision', day: 'Day' }
  const filterBar = h('div', { class: 'auto-log-filters', role: 'group', 'aria-label': 'Filter the log' },
    filterKeys.map((key) => h('div', { class: 'auto-log-filter' }, h('label', { for: selects[key].id }, labels[key]), selects[key])))
  const clear = h('button', { type: 'button', class: 'button button-small', 'data-auto-log-key': 'clear' }, 'Clear filters')
  const body = h('div', { class: 'auto-log-body' })
  const foot = h('div', { class: 'report-foot' },
    h('span', { class: 'report-hint' }, 'Esc closes this panel'),
    h('button', { type: 'button', class: 'button button-small', 'data-auto-log-close': '' }, 'Close'))
  root.replaceChildren(
    h('div', { class: 'drawer-head' }, h('div', { class: 'drawer-titles' }, heading, sub), closeButton),
    filterBar,
    body,
    foot)

  const stateKey = (): string => JSON.stringify(view()?.autoReview ?? null)

  const fillSelect = (select: HTMLSelectElement, choices: readonly LogChoice[], value: string): void => {
    const sig = JSON.stringify(choices)
    if (select.dataset.choices !== sig) {
      select.replaceChildren(...choices.map((choice) => h('option', { value: choice.value }, choice.label)))
      select.dataset.choices = sig
    }
    select.value = value
    // a select away from All reads as set, as the table's filters do
    select.setAttribute('class', value === '' ? 'filter-select' : 'filter-select filter-set')
  }

  const lineItem = (line: LogModel['lines'][number]): HTMLLIElement => {
    const run = line.run
    let runPart: HTMLElement | null = null
    if (run !== null && run.opens) {
      const button = h('button', { type: 'button', class: 'link-button mono', 'aria-label': run.name, title: run.name, 'data-auto-log-run': `${run.kind}-${run.id}`, 'data-auto-log-key': run.key }, run.text)
      button.addEventListener('click', () => {
        close()
        openRun(run)
      })
      runPart = button
    } else if (run !== null) runPart = h('span', { class: 'mono auto-log-muted', title: run.name }, run.text)
    return h('li', { id: line.anchor, class: 'auto-log-line' },
      h('div', { class: 'auto-log-meta' },
        h('span', { class: 'mono auto-log-when' }, line.when),
        h('strong', { class: 'auto-log-subject' }, line.subject),
        line.title === null ? null : h('span', { class: 'auto-log-title', title: line.title }, line.title)),
      h('div', { class: `auto-log-text${line.tone === 'warn' ? ' auto-warn' : ''}` }, line.text),
      h('div', { class: 'auto-log-details' },
        line.note === null ? null : h('span', {}, line.note),
        line.count === null ? null : h('span', {}, line.count),
        line.head === null ? null : h('span', { class: 'mono', title: 'Head' }, line.head),
        line.model === null ? null : h('span', { 'data-auto-log-model': '', title: 'The model that ran the review' }, `Model: ${line.model}`),
        runPart))
  }

  // every repaint replaces what the body holds, and a replaced control loses focus: the one that had it is found again by its key, which is unique to it (a line's link by its line, the buttons by name)
  const repaint = (...children: (Node | string)[]): void => {
    const focused = document.activeElement instanceof HTMLElement && body.contains(document.activeElement) ? document.activeElement.getAttribute('data-auto-log-key') : null
    body.replaceChildren(...children)
    if (focused === null) return
    for (const candidate of body.querySelectorAll<HTMLElement>('[data-auto-log-key]')) {
      if (candidate.getAttribute('data-auto-log-key') === focused) candidate.focus({ preventScroll: true })
    }
  }

  const paint = (): void => {
    if (root.hidden) return
    if (load.state === 'loading') {
      setText(sub, 'Loading…')
      repaint(h('p', { class: 'auto-note', role: 'status' }, 'Loading the log…'))
      return
    }
    if (load.state === 'error') {
      landOn = null
      const retry = h('button', { type: 'button', class: 'button button-small', 'data-auto-log-key': 'retry' }, 'Try again')
      retry.addEventListener('click', () => void read())
      setText(sub, '')
      repaint(h('div', {}, h('p', { class: 'auto-note', role: 'alert' }, 'The log could not be loaded.'), retry))
      return
    }
    const model = logModel(load.entries, filters, { nowMs: nowMs(), days: load.days, isOpen })
    setText(sub, model.summary)
    fillSelect(selects.pr, model.prs, filters.pr)
    fillSelect(selects.decision, model.decisions, filters.decision)
    fillSelect(selects.day, model.days, filters.day)
    clear.hidden = !model.filtered
    const lines = model.empty === null
      ? h('ol', { class: 'auto-log-list', 'aria-labelledby': 'auto-log-heading' }, model.lines.map(lineItem))
      : h('p', { class: 'auto-note' }, model.empty)
    repaint(model.filtered ? h('div', { class: 'auto-log-clear' }, clear) : '', lines)
    land()
  }

  // once, after the lines have been drawn: the line a link back asked for comes into view and its run link, the control the owner pressed, takes focus. When it is not on the page (pruned, or hidden by a filter) the log stays at the top and says nothing about it
  const land = (): void => {
    if (landOn === null) return
    const wanted = landOn
    landOn = null
    const line = document.getElementById(entryAnchor(wanted))
    if (line === null) return
    line.scrollIntoView({ block: 'center' })
    line.querySelector<HTMLElement>('[data-auto-log-run]')?.focus({ preventScroll: true })
  }

  const read = async (): Promise<void> => {
    request += 1
    const mine = request
    readFor = stateKey()
    const answer = await getJson<{ days: number, entries: LogEntry[] }>('/api/auto-review/log')
    if (mine !== request || root.hidden) return
    load = answer.ok && answer.value !== null ? { state: 'ready', days: answer.value.days, entries: answer.value.entries } : { state: 'error' }
    paint()
  }

  const close = (returnFocus = false): void => {
    if (root.hidden) return
    request += 1
    root.hidden = true
    landOn = null
    body.replaceChildren()
    if (returnFocus) returnTo()?.focus({ preventScroll: true })
  }

  const open = (): void => {
    const wasOpen = !root.hidden
    root.hidden = false
    if (!wasOpen) {
      load = { state: 'loading' }
      filters = { ...noFilters }
    }
    paint()
    heading.focus({ preventScroll: true })
    void read()
  }

  // the log again for a link back: open as ever, without the clean start of a first opening, so the filters stay as they were
  const restore = (entryId: number): void => {
    landOn = entryId
    root.hidden = false
    load = { state: 'loading' }
    paint()
    heading.focus({ preventScroll: true })
    void read()
  }

  for (const key of filterKeys) {
    selects[key].addEventListener('change', () => {
      filters = { ...filters, [key]: selects[key].value }
      paint()
    })
  }
  clear.addEventListener('click', () => {
    filters = { ...noFilters }
    paint()
    selects.pr.focus({ preventScroll: true })
  })
  closeButton.addEventListener('click', () => close(true))
  foot.querySelector('button')?.addEventListener('click', () => close(true))
  // Escape on anything in the panel closes it, and only it
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    close(true)
  })

  return {
    open,
    restore,
    close,
    isOpen: () => !root.hidden,
    update: () => {
      if (root.hidden) return
      if (stateKey() !== readFor) void read()
      else paint()
    },
  }
}
