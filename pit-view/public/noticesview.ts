// public/noticesview.ts
// the notifications area's pure parts (section 6 of DESIGN.md, Notifications area): what this browser has read, dismissed, and cleared, the merged list, the bell's count, where a notification leads, the panel's entries, where the toasts sit around the panel, and which entry has just arrived; no DOM here. The server's rows are never changed by any of it
import type { StoredNotification } from '../src/notifications.ts'
import { formatCached, formatSince } from './format.ts'
import { safeHref } from './safeurl.ts'

// this browser's marks on one repository's notifications, by their ids, which only go up. Every one up to readThrough is read, and each in read besides; every one up to clearedThrough is hidden, and each in dismissed besides
export type ReadState = { readThrough: number, read: number[], clearedThrough: number, dismissed: number[] }

export const emptyRead = (): ReadState => ({ readThrough: 0, read: [], clearedThrough: 0, dismissed: [] })

export const readKeyPrefix = 'pit-view.notifications:'
export const readKey = (repo: string): string => `${readKeyPrefix}${repo}`

const isId = (value: unknown): value is number => Number.isInteger(value)

// anything but a whole set of marks reads as none
export const parseRead = (text: string | null): ReadState => {
  let value: Partial<Record<keyof ReadState, unknown>> | null
  try {
    value = JSON.parse(text ?? 'null') as typeof value
  } catch {
    return emptyRead()
  }
  const { readThrough, read, clearedThrough, dismissed } = value ?? {}
  if (!isId(readThrough) || !isId(clearedThrough) || !Array.isArray(read) || !Array.isArray(dismissed) || ![...read, ...dismissed].every(isId)) return emptyRead()
  return { readThrough, read, clearedThrough, dismissed }
}

// marks past the highest id the server ever gave were made on a cache file that is gone, so they say nothing of this one
export const settleRead = (state: ReadState, lastId: number): ReadState =>
  Math.max(state.readThrough, state.clearedThrough, ...state.read, ...state.dismissed) > lastId ? emptyRead() : state

type Marked = Pick<StoredNotification, 'id'>

const newest = (items: readonly Marked[]): number => items.reduce((most, item) => Math.max(most, item.id), 0)

export const isUnread = (item: Marked, state: ReadState): boolean => item.id > state.readThrough && !state.read.includes(item.id)

export const shownNotices = <T extends Marked>(items: readonly T[], state: ReadState): T[] =>
  items.filter((item) => item.id > state.clearedThrough && !state.dismissed.includes(item.id))

export const unreadCount = (items: readonly Marked[], state: ReadState): number => shownNotices(items, state).filter((item) => isUnread(item, state)).length

export const markAllRead = (state: ReadState, items: readonly Marked[]): ReadState => {
  const readThrough = Math.max(state.readThrough, newest(items))
  return { ...state, readThrough, read: state.read.filter((id) => id > readThrough) }
}

export const markRead = (state: ReadState, id: number): ReadState =>
  isUnread({ id }, state) ? { ...state, read: [...state.read, id] } : state

export const dismissNotice = (state: ReadState, id: number): ReadState =>
  state.dismissed.includes(id) || id <= state.clearedThrough ? state : { ...state, dismissed: [...state.dismissed, id] }

// hides every one listed; one that comes later shows
export const clearAll = (state: ReadState, items: readonly Marked[]): ReadState => {
  const clearedThrough = Math.max(state.clearedThrough, newest(items))
  return { ...state, clearedThrough, dismissed: state.dismissed.filter((id) => id > clearedThrough) }
}

// newest first, each once
export const mergeNotices = (held: readonly StoredNotification[], more: readonly StoredNotification[]): StoredNotification[] =>
  [...new Map([...held, ...more].map((item) => [item.id, item])).values()].sort((a, b) => b.id - a.id)

export const bellModel = (unread: number): { badge: string, label: string } =>
  unread === 0 ? { badge: '', label: 'Notifications' } : { badge: unread > 99 ? '99+' : String(unread), label: `Notifications, ${unread} unread` }

// a run's notification opens the drawer on that run, whether or not its PR is still open; any other opens its PR's drawer while the page holds the PR (a Closed row's read-only), and otherwise there is no drawer to open and it leads to GitHub
export type NoticeTarget = { kind: 'run', number: number, runId: number, title: string | null } | { kind: 'drawer', number: number } | { kind: 'github' }

export const noticeTarget = (item: StoredNotification, holds: (number: number) => boolean): NoticeTarget => {
  if (item.run !== null) return { kind: 'run', number: item.number, runId: item.run, title: item.title }
  return holds(item.number) ? { kind: 'drawer', number: item.number } : { kind: 'github' }
}

export type NoticeModel = { id: number, label: string, text: string, detail: string | null, when: string, tip: string, unread: boolean, href: string | null, target: NoticeTarget }

export type NoticeContext = { nowMs: number, holds: (number: number) => boolean }

// one entry, in the panel or a toast
export const noticeModel = (item: StoredNotification, state: ReadState, { nowMs, holds }: NoticeContext): NoticeModel => ({
  id: item.id,
  label: item.label,
  text: item.title === null ? `#${item.number}` : `#${item.number} ${item.title}`,
  detail: item.detail,
  when: formatSince(item.at, nowMs),
  tip: formatCached(item.at, nowMs),
  unread: isUnread(item, state),
  href: safeHref(`https://github.com/${item.repo}/pull/${item.number}`),
  target: noticeTarget(item, holds),
})

// the panel's entries, newest first; state is what was read as it opened, so what was new then still reads as new
export const panelModel = (items: readonly StoredNotification[], state: ReadState, context: NoticeContext): NoticeModel[] =>
  shownNotices(items, state).map((item) => noticeModel(item, state, context))

// where the panel's list is scrolled to as it is drawn: where it was, and the top when the panel has just opened or had no list
export const keptScroll = (opened: boolean, scrollTop: number | undefined): number => opened ? 0 : scrollTop ?? 0

// the space between the toasts and the open panel, and at least as much between them and the window's left edge
export const toastGap = 16

// how far from the window's right edge the toasts sit while the panel is open, so their right edge is a gap short of the panel's left one; null when the whole stack does not fit there
export const toastRight = (panelLeft: number, stackWidth: number, windowWidth: number): number | null =>
  panelLeft < stackWidth + 2 * toastGap ? null : Math.ceil(windowWidth - panelLeft) + toastGap

export type ToastPlace = { shown: boolean, right: number | null }

// whether a toast may show, and where; a null right is the stylesheet's own place. An open panel moves the stack aside, and where it leaves no room, at phone width or in a window too narrow for both, no toast shows
export const toastPlace = ({ open, phone, left, stackWidth, windowWidth }: { open: boolean, phone: boolean, left: number, stackWidth: number, windowWidth: number }): ToastPlace => {
  if (!open) return { shown: true, right: null }
  const right = phone ? null : toastRight(left, stackWidth, windowWidth)
  return { shown: right !== null, right }
}

// how long an entry that arrives while the panel is open is highlighted; the stylesheet's animation lasts as long
export const arrivalMs = 2_500

// how far into its highlight an entry is, so a redraw goes on from there; null for one that did not arrive while the panel was open, or whose highlight is over
export const arrivalAge = (arrivedMs: number | undefined, nowMs: number): number | null => {
  const age = arrivedMs === undefined ? arrivalMs : nowMs - arrivedMs
  return age >= 0 && age < arrivalMs ? age : null
}
