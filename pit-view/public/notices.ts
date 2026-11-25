// public/notices.ts
// the header's bell, its panel, and the toasts (noticesview.ts says what each reads and where the toasts sit): the stored list is read with every view, new ones come on the event stream, and what is read, dismissed, or cleared is kept in this browser's localStorage and nowhere else
import type { PushedNotification, StoredNotification } from '../src/notifications.ts'
import { popoverFocus } from './autoreviewbar.ts'
import { append, h, newTab, setText, svg } from './dom.ts'
import { arrivalAge, bellModel, clearAll, dismissNotice, emptyRead, markAllRead, markRead, mergeNotices, noticeModel, panelModel, parseRead, readKey, settleRead, toastPlace, unreadCount } from './noticesview.ts'
import type { NoticeModel, NoticeTarget, ReadState } from './noticesview.ts'
import { getJson } from './runapi.ts'
import { safeHref } from './safeurl.ts'

// how long a toast stays, unless a pointer or focus is on it
export const toastMs = 8_000
// the most toasts on screen; the oldest go first, and the panel holds every one
export const toastLimit = 4

export type Notices = {
  // reads the stored list, with each view
  load: () => Promise<void>
  // new ones from the event stream
  take: (pushed: readonly PushedNotification[]) => void
  // after each draw: the times, what each entry leads to, and the toasts' place
  update: () => void
  // another tab changed this browser's marks
  storageChanged: (key: string | null) => void
  // the window's size changed, and the panel's place with it
  resize: () => void
  isOpen: () => boolean
  close: (returnFocus?: boolean) => void
}

export type NoticesOptions = {
  root: HTMLElement
  button: HTMLButtonElement
  badge: HTMLElement
  panel: HTMLElement
  toastBox: HTMLElement
  nowMs: () => number
  // whether the stylesheet's phone-width layout is on
  phone: () => boolean
  // the window's width without its scroll bar
  windowWidth: () => number
  // whether the page holds this PR, open or in Closed, so its drawer can open
  holds: (number: number) => boolean
  // opens the target's drawer; false when it cannot open now
  open: (target: NoticeTarget) => boolean
  // a getter, since even reading window.localStorage can throw when blocked
  storage: () => Pick<Storage, 'getItem' | 'setItem'>
  timers: { set: (run: () => void, ms: number) => unknown, clear: (handle: unknown) => void }
}

export const createNotices = ({ root, button, badge, panel, toastBox, nowMs, phone, windowWidth, holds, open: openTarget, storage, timers }: NoticesOptions): Notices => {
  let repo: string | null = null
  let items: StoredNotification[] = []
  let days = 0
  let failed = false
  let state: ReadState = emptyRead()
  // the marks as the panel opened, so what was new then reads as new until it closes
  let opening: ReadState = state
  let isShown = false
  // when each entry arrived while the panel was open, until its highlight is over
  const arrivals = new Map<number, number>()
  let drawn = ''
  // only the newest read counts; what is pushed while it runs is added to its answer
  let request = 0
  let during: PushedNotification[] = []

  const stored = (): ReadState => {
    if (repo === null) return state
    try {
      return parseRead(storage().getItem(readKey(repo)))
    } catch {
      // blocked storage keeps the marks for this page alone
      return state
    }
  }

  const keep = (next: ReadState): void => {
    state = next
    if (repo === null) return
    try {
      storage().setItem(readKey(repo), JSON.stringify(state))
    } catch {
      // the page still shows them so; a reload forgets it
    }
  }

  const context = () => ({ nowMs: nowMs(), holds })

  // an entry's own control: the button that opens its drawer, or a link to GitHub when there is none. Its click opens, marks it read, and then does what the surface it is on asks for
  const openControl = (model: NoticeModel, opened: () => void): HTMLElement => {
    const control = model.target.kind === 'github'
      ? h('a', { class: 'notice-open', href: safeHref(model.href), ...newTab, 'data-notice-open': model.id, 'data-focus-key': `notice-open:${model.id}` }, model.text)
      : h('button', { type: 'button', class: 'notice-open', 'data-notice-open': model.id, 'data-focus-key': `notice-open:${model.id}` }, model.text)
    control.addEventListener('click', () => {
      if (!openTarget(model.target)) return
      keep(markRead(state, model.id))
      opened()
      paint()
    })
    return control
  }

  const dismissControl = (model: NoticeModel, name: string, dismiss: () => void): HTMLElement => {
    const control = h('button', { type: 'button', class: 'notice-dismiss', 'aria-label': name, title: 'Dismiss', 'data-notice-dismiss': model.id, 'data-focus-key': `notice-dismiss:${model.id}` },
      svg([['path', { d: 'M6 6l12 12' }], ['path', { d: 'M18 6L6 18' }]], { size: 12, stroke: '2.6' }))
    control.addEventListener('click', dismiss)
    return control
  }

  const meta = (model: NoticeModel): HTMLElement => h('div', { class: 'notice-meta' },
    h('span', { class: 'notice-label' }, model.label),
    h('span', { class: 'muted', title: model.tip }, model.when),
    model.unread ? h('span', { class: 'sr-only' }, 'Unread') : null)

  const entryParts = (model: NoticeModel): (HTMLElement | null)[] => [
    meta(model),
    openControl(model, () => close()),
    model.detail === null ? null : h('p', { class: 'notice-detail' }, model.detail),
    model.target.kind === 'github' ? null : h('a', { class: 'notice-github', href: safeHref(model.href), ...newTab, 'data-focus-key': `notice-github:${model.id}`, 'aria-label': `Open ${model.text} on GitHub` }, 'GitHub'),
    dismissControl(model, `Dismiss ${model.text}`, () => {
      keep(dismissNotice(state, model.id))
      opening = dismissNotice(opening, model.id)
      paint()
    }),
  ]

  const entry = (model: NoticeModel): HTMLElement => {
    // an entry drawn again goes on from its age, and one whose highlight is over is never highlighted again
    const age = arrivalAge(arrivals.get(model.id), nowMs())
    if (age === null) arrivals.delete(model.id)
    const element = h('li', { class: 'notice-item', 'data-unread': model.unread, 'data-arrived': age !== null }, ...entryParts(model))
    if (age !== null) element.style.setProperty('--arrived-age', `${age}ms`)
    return element
  }

  const paintPanel = (): void => {
    if (!isShown) return
    const models = panelModel(items, opening, context())
    const empty = failed ? 'The notifications could not be loaded.' : models.length === 0 ? 'No notifications.' : null
    // rebuilt only when what it says changes, so a focused control is never replaced under the keyboard
    const sig = JSON.stringify([models, empty, days])
    if (sig === drawn) return
    drawn = sig
    const active = document.activeElement
    const focused = active instanceof HTMLElement && panel.contains(active) ? active.dataset.focusKey ?? '' : null
    const clear = h('button', { type: 'button', class: 'button button-small', disabled: models.length === 0, 'data-notices-clear': '', 'data-focus-key': 'notices-clear' }, 'Clear all')
    clear.addEventListener('click', () => {
      keep(clearAll(state, items))
      opening = clearAll(opening, items)
      paint()
    })
    panel.replaceChildren()
    append(panel, [
      h('div', { class: 'notices-head' }, h('h2', { class: 'auto-title' }, 'Notifications'), clear),
      empty === null ? null : h('p', { class: 'notices-empty muted' }, empty),
      models.length === 0 ? null : h('ol', { class: 'notices-list' }, models.map(entry)),
      days === 0 ? null : h('p', { class: 'auto-note' }, `Kept for ${days} days. Clearing and dismissing hide entries in this browser only.`),
    ])
    const keys = [...panel.querySelectorAll<HTMLButtonElement>('[data-focus-key]')].filter((control) => !control.disabled).map((control) => control.dataset.focusKey ?? '')
    const focus = popoverFocus(focused, keys)
    if (focus.target === 'toggle') button.focus({ preventScroll: true })
    else if (focus.target === 'key') [...panel.querySelectorAll<HTMLElement>('[data-focus-key]')].find((control) => control.dataset.focusKey === focus.key)?.focus({ preventScroll: true })
  }

  const paint = (): void => {
    const bell = bellModel(unreadCount(items, state))
    setText(badge, bell.badge)
    badge.hidden = bell.badge === ''
    button.setAttribute('aria-label', bell.label)
    button.title = bell.label
    paintPanel()
  }

  const close = (returnFocus = false): void => {
    if (!isShown) return
    isShown = false
    panel.hidden = true
    button.setAttribute('aria-expanded', 'false')
    arrivals.clear()
    placeToasts()
    if (returnFocus) button.focus()
  }

  const show = (): void => {
    isShown = true
    drawn = ''
    opening = state
    keep(markAllRead(state, items))
    panel.hidden = false
    button.setAttribute('aria-expanded', 'true')
    paint()
    placeToasts()
  }

  // the toasts on screen, oldest first, each with what takes it off
  const toastList: (() => void)[] = []

  // moves the toasts out of the panel's way, or takes them off where it leaves them no room; answers whether one may show
  const placeToasts = (): boolean => {
    const place = toastPlace({ open: isShown, phone: phone(), left: panel.getBoundingClientRect().left, stackWidth: toastBox.getBoundingClientRect().width, windowWidth: windowWidth() })
    if (place.right === null) toastBox.style.removeProperty('--toasts-right')
    else toastBox.style.setProperty('--toasts-right', `${place.right}px`)
    if (!place.shown) {
      if (toastBox.contains(document.activeElement)) button.focus({ preventScroll: true })
      for (const remove of [...toastList]) remove()
    }
    return place.shown
  }

  const addToast = (item: StoredNotification): void => {
    let timer: unknown = null
    const hold = (): void => {
      if (timer !== null) timers.clear(timer)
      timer = null
    }
    const remove = (): void => {
      hold()
      const at = toastList.indexOf(remove)
      if (at >= 0) toastList.splice(at, 1)
      element.remove()
    }
    const run = (): void => {
      hold()
      timer = timers.set(remove, toastMs)
    }
    const model = noticeModel(item, state, context())
    const element = h('div', { class: 'toast' },
      h('div', { class: 'notice-meta' }, h('span', { class: 'notice-label' }, model.label)),
      openControl(model, () => {
        remove()
        close()
      }),
      model.detail === null ? null : h('p', { class: 'notice-detail' }, model.detail),
      dismissControl(model, `Dismiss ${model.text}`, () => {
        const focused = element.contains(document.activeElement)
        remove()
        // its button is gone, and focus on nothing would start the keyboard over at the top of the page
        if (focused) button.focus({ preventScroll: true })
      }))
    element.addEventListener('pointerenter', hold)
    element.addEventListener('pointerleave', run)
    element.addEventListener('focusin', hold)
    element.addEventListener('focusout', run)
    toastBox.append(element)
    toastList.push(remove)
    while (toastList.length > toastLimit) toastList[0]?.()
    run()
  }

  const take = (pushed: readonly PushedNotification[]): void => {
    during.push(...pushed)
    const fresh = pushed.filter((item) => (repo === null || item.repo === repo) && !items.some((held) => held.id === item.id))
    if (fresh.length === 0) return
    items = mergeNotices(items, fresh)
    // one that arrives while the panel is open is seen
    if (isShown) {
      keep(markAllRead(state, items))
      for (const item of fresh) arrivals.set(item.id, nowMs())
    }
    if (placeToasts()) for (const item of fresh) if (item.toast) addToast(item)
    paint()
  }

  const load = async (): Promise<void> => {
    request += 1
    const asked = request
    during = []
    const answer = await getJson<{ repo: string, days: number, lastId: number, entries: StoredNotification[] }>('/api/notifications')
    if (asked !== request) return
    failed = !answer.ok
    if (answer.ok) {
      const { value } = answer
      const late = during.filter((item) => item.repo === value.repo)
      repo = value.repo
      days = value.days
      items = mergeNotices(value.entries, late)
      const lastId = Math.max(value.lastId, ...late.map((item) => item.id))
      const kept = stored()
      state = settleRead(kept, lastId)
      // dropped marks go from storage as well, or they would cover the new ids once those reach them
      if (state !== kept) keep(state)
      opening = isShown ? settleRead(opening, lastId) : state
      if (isShown) keep(markAllRead(state, items))
    }
    paint()
  }

  const storageChanged = (key: string | null): void => {
    if (repo === null || (key !== null && key !== readKey(repo))) return
    state = stored()
    // what another tab cleared or dismissed goes from an open panel too
    opening = { ...opening, clearedThrough: state.clearedThrough, dismissed: state.dismissed }
    paint()
  }

  // the header can wrap, and the bell move with it, on any draw
  const update = (): void => {
    paint()
    placeToasts()
  }

  button.addEventListener('click', () => isShown ? close() : show())

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isShown && !event.defaultPrevented) {
      event.preventDefault()
      close(true)
    }
  })
  document.addEventListener('pointerdown', (event) => {
    // a press on a toast leaves the panel open: closing it would move the toast from under the pointer before its click
    if (isShown && event.target instanceof Node && !root.contains(event.target) && !toastBox.contains(event.target)) close()
  })

  paint()

  return { load, take, update, storageChanged, resize: () => void placeToasts(), isOpen: () => isShown, close }
}
