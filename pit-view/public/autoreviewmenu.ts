// public/autoreviewmenu.ts
// the header's auto-review button and its popover (autoreviewbar.ts says what each reads): hidden until the config has autoReview, a button rather than a live region so a tick never announces itself, the last ticks fetched when it opens, and Run now with the per-start token
import type { Tick } from '../src/cache.ts'
import type { View } from '../src/poller.ts'
import { indicator, popoverFocus, popoverModel, runLinkKey, runNowRequest, runNowResult } from './autoreviewbar.ts'
import type { PopoverModel } from './autoreviewbar.ts'
import { append, h, newTab, setText } from './dom.ts'
import { getJson, sendRun } from './runapi.ts'
import { safeHref } from './safeurl.ts'
import { openRows } from './state.ts'

export type AutoReviewMenu = {
  // after each draw: the button's words, and the popover when it is open
  update: () => void
  isOpen: () => boolean
  close: (returnFocus?: boolean) => void
}

type Deps = {
  root: HTMLElement
  button: HTMLButtonElement
  popover: HTMLElement
  token: string
  nowMs: () => number
  view: () => View | null
}

export const createAutoReviewMenu = ({ root, button, popover, token, nowMs, view }: Deps): AutoReviewMenu => {
  let open = false
  let ticks: Tick[] = []
  let ticksFailed = false
  // what Run now last said, shown until the popover closes
  let message = ''
  let running = false
  let drawn = ''

  const close = (returnFocus = false): void => {
    if (!open) return
    open = false
    message = ''
    popover.hidden = true
    button.setAttribute('aria-expanded', 'false')
    if (returnFocus) button.focus()
  }

  const list = (items: readonly (Node | string)[], className: string): HTMLUListElement =>
    h('ul', { class: className }, items.map((item) => h('li', {}, item)))

  const section = (title: string, ...children: Node[]): HTMLElement => h('section', { class: 'auto-section' }, h('h3', { class: 'auto-heading' }, title), ...children)

  const content = (model: PopoverModel): Node[] => {
    const parts: Node[] = []
    const runs = model.runs.map((run) => {
      const href = safeHref(run.url)
      return href === null ? run.text : h('a', { href, ...newTab, title: run.title, 'data-focus-key': runLinkKey(run) }, run.text)
    })
    if (runs.length + model.sweeps.length > 0) parts.push(section('Running and queued', list([...runs, ...model.sweeps], 'auto-list')))
    if (model.hold !== null) parts.push(h('p', { class: 'auto-note auto-warn' }, model.hold))
    parts.push(section('Recent ticks', ticksFailed
      ? h('p', { class: 'auto-note' }, 'The ticks could not be loaded.')
      : model.ticks.length === 0
        ? h('p', { class: 'auto-note' }, 'No ticks yet.')
        : h('ol', { class: 'auto-list auto-ticks' }, model.ticks.map((tick) => h('li', { class: tick.tone === 'warn' ? 'auto-warn' : null }, tick.text)))))
    if (model.worktrees.length > 0) parts.push(section('Worktrees', list(model.worktrees, 'auto-list mono')))
    parts.push(h('div', { class: 'auto-footer' },
      h('button', {
        type: 'button', class: 'button', 'data-auto-run': '', 'data-focus-key': 'auto-run-now',
        disabled: model.runNow.disabled || running, title: model.runNow.reason,
      }, running ? 'Starting…' : 'Run now'),
      h('a', { class: 'auto-settings', 'data-focus-key': 'auto-settings', href: '/settings.html#auto-review' }, 'Settings')))
    if (model.runNow.reason !== null) parts.push(h('p', { class: 'auto-note' }, model.runNow.reason))
    parts.push(h('p', { class: 'auto-note', role: 'status' }, message))
    return parts
  }

  const draw = (): void => {
    const current = view()
    const auto = current?.autoReview ?? null
    if (current === null || auto === null || !open) return
    const model = popoverModel(auto, ticks, openRows(current), current.sweeps.items, { nowMs: nowMs() })
    // rebuilt only when what it says changes, so the focused Run now is never replaced under the keyboard
    const sig = JSON.stringify([model, ticksFailed, message, running])
    if (sig === drawn) return
    drawn = sig
    // a rebuild that replaces the focused control puts focus on its replacement, or on the header button when that is gone or disabled
    const active = document.activeElement
    const focusedKey = active instanceof HTMLElement && popover.contains(active) ? active.dataset.focusKey ?? '' : null
    popover.replaceChildren()
    append(popover, [h('h2', { class: 'auto-title' }, 'Auto-review'), ...content(model)])
    const enabledKeys = [...popover.querySelectorAll<HTMLElement>('[data-focus-key]')].filter((el) => !(el instanceof HTMLButtonElement && el.disabled)).map((el) => el.dataset.focusKey ?? '')
    const focus = popoverFocus(focusedKey, enabledKeys)
    if (focus.target === 'toggle') button.focus({ preventScroll: true })
    else if (focus.target === 'key') popover.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focus.key)}"]`)?.focus({ preventScroll: true })
  }

  const loadTicks = async (): Promise<void> => {
    const answer = await getJson<Tick[]>('/api/auto-review/ticks')
    ticksFailed = !answer.ok
    if (answer.ok) ticks = answer.value
    drawn = ''
    draw()
  }

  const update = (): void => {
    const current = view()
    const auto = current?.autoReview ?? null
    const shown = auto === null ? null : indicator(auto, { nowMs: nowMs() })
    root.hidden = shown === null
    if (shown === null) {
      close()
      return
    }
    setText(button, shown.text)
    button.dataset.tone = shown.tone
    draw()
  }

  button.addEventListener('click', () => {
    if (open) {
      close()
      return
    }
    open = true
    drawn = ''
    popover.hidden = false
    button.setAttribute('aria-expanded', 'true')
    draw()
    void loadTicks()
  })

  popover.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-auto-run]') : null
    if (target === null || running) return
    running = true
    message = ''
    drawn = ''
    draw()
    void sendRun(runNowRequest(token)).then((answer) => {
      running = false
      message = answer.ok
        ? runNowResult(answer.status, answer.value as { started: boolean, tick: number } | null, null)
        : runNowResult(answer.status, null, answer.error)
      drawn = ''
      draw()
      // the new tick's row exists by now, or soon: the list shows it
      if (answer.ok) void loadTicks()
    })
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open && !event.defaultPrevented) {
      event.preventDefault()
      close(true)
    }
  })
  document.addEventListener('pointerdown', (event) => {
    if (open && event.target instanceof Node && !root.contains(event.target)) close()
  })

  return { update, isOpen: () => open, close }
}
