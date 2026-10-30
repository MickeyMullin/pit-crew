// public/hovercard.ts
// the card on a PR number or title: full title, refs, size, head and tickets, never the body;
// it stays with its PR by number across updates and closes when the row goes
import type { OpenRow } from '../src/derive.ts'
import type { View } from '../src/poller.ts'
import { ticketChip } from './cells.ts'
import { h } from './dom.ts'
import { formatAge, formatCached, shortSha } from './format.ts'
import { findOpenRow, rowFreshness } from './state.ts'

type Anchor = { table: string, number: number, kind: string }

const showDelay = 150
const hideDelay = 200

const content = (row: OpenRow, view: View, nowMs: number): Node[] => {
  const freshness = rowFreshness(row, view.sync)
  return [
    h('p', { class: 'hc-title' }, row.title),
    h('p', { class: 'hc-refs mono' }, `${row.headRef} → ${row.baseRef}`),
    h('p', { class: 'hc-meta' },
      h('span', {}, `@${row.author.login}`),
      h('span', {}, `opened ${formatAge(row.createdAt, nowMs)} ago`),
      h('span', {}, `+${row.additions} −${row.deletions} · ${row.changedFiles} ${row.changedFiles === 1 ? 'file' : 'files'}`),
      h('span', {}, `head ${shortSha(row.headOid)}`)),
    row.tickets.length === 0 ? null : h('p', { class: 'hc-tickets' }, h('span', {}, 'Tickets'), row.tickets.map((ticket) => ticketChip(ticket))),
    freshness === 'current' ? null : h('p', { class: 'hc-cached' }, `cached ${formatCached(row.freshness.fetchedAt, nowMs)}`),
  ].filter((node): node is HTMLParagraphElement => node !== null)
}

const anchorOf = (target: EventTarget | null): { anchor: Anchor, element: HTMLElement } | null => {
  if (!(target instanceof Element)) return null
  const element = target.closest<HTMLElement>('[data-hover]')
  const row = element?.closest<HTMLElement>('tr[data-pr][data-table]')
  if (element == null || row == null) return null
  return { anchor: { table: row.dataset.table ?? '', number: Number(row.dataset.pr), kind: element.dataset.hover ?? '' }, element }
}

const find = (anchor: Anchor): HTMLElement | null =>
  document.querySelector<HTMLElement>(`tr[data-table="${anchor.table}"][data-pr="${anchor.number}"] [data-hover="${anchor.kind}"]`)

export type HoverCard = {
  // after every render: follow the PR to its new element, refresh the card, or close it
  refresh: () => void
}

export const createHoverCard = (card: HTMLElement, current: () => { view: View, nowMs: number } | null): HoverCard => {
  let open: Anchor | null = null
  let showTimer: ReturnType<typeof setTimeout> | undefined
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  let shownSig = ''

  const place = (element: HTMLElement): void => {
    const rect = element.getBoundingClientRect()
    const width = card.offsetWidth
    const height = card.offsetHeight
    const left = Math.max(16, Math.min(rect.left, document.documentElement.clientWidth - width - 16))
    const below = rect.bottom + 6
    const top = below + height > window.innerHeight && rect.top - height - 6 > 0 ? rect.top - height - 6 : below
    card.style.left = `${left + window.scrollX}px`
    card.style.top = `${top + window.scrollY}px`
  }

  const fill = (anchor: Anchor, element: HTMLElement): boolean => {
    const state = current()
    const row = state === null ? undefined : findOpenRow(state.view, anchor.number)
    if (state === null || row === undefined) return false
    const freshness = rowFreshness(row, state.view.sync)
    const sig = JSON.stringify([row, freshness, formatAge(row.createdAt, state.nowMs)])
    if (sig !== shownSig) {
      card.replaceChildren(...content(row, state.view, state.nowMs))
      shownSig = sig
    }
    if (element.getAttribute('aria-describedby') !== card.id) element.setAttribute('aria-describedby', card.id)
    card.hidden = false
    place(element)
    return true
  }

  const hide = (): void => {
    clearTimeout(showTimer)
    clearTimeout(hideTimer)
    if (open !== null) find(open)?.removeAttribute('aria-describedby')
    open = null
    shownSig = ''
    card.hidden = true
  }

  const show = (anchor: Anchor, element: HTMLElement): void => {
    clearTimeout(hideTimer)
    if (open !== null && (open.table !== anchor.table || open.number !== anchor.number || open.kind !== anchor.kind)) find(open)?.removeAttribute('aria-describedby')
    open = anchor
    if (!fill(anchor, element)) hide()
  }

  const later = (run: () => void, ms: number): ReturnType<typeof setTimeout> => setTimeout(run, ms)

  document.addEventListener('pointerover', (event) => {
    if (card.contains(event.target as Node)) {
      clearTimeout(hideTimer)
      return
    }
    const found = anchorOf(event.target)
    if (found === null) return
    clearTimeout(showTimer)
    showTimer = later(() => show(found.anchor, found.element), showDelay)
  })
  document.addEventListener('pointerout', (event) => {
    const into = event.relatedTarget as Node | null
    if (into !== null && (card.contains(into) || (open !== null && find(open)?.contains(into) === true))) return
    clearTimeout(showTimer)
    if (open !== null) hideTimer = later(hide, hideDelay)
  })
  document.addEventListener('focusin', (event) => {
    const found = anchorOf(event.target)
    if (found !== null && found.anchor.kind === 'pr') show(found.anchor, found.element)
  })
  document.addEventListener('focusout', (event) => {
    const into = event.relatedTarget as Node | null
    if (into === null || !card.contains(into)) hide()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open !== null) hide()
  })
  // a table box scrolling sideways moves the anchor
  document.addEventListener('scroll', () => {
    if (open === null) return
    const element = find(open)
    if (element === null) hide()
    else place(element)
  }, { capture: true, passive: true })
  window.addEventListener('resize', () => {
    if (open !== null) hide()
  })

  return {
    refresh: () => {
      if (open === null) return
      const element = find(open)
      if (element === null || !fill(open, element)) hide()
    },
  }
}
