// public/cells.ts
// the small pieces rows are made of: avatars, chips, reviewer pips and icons
import type { Issue, IssueKind, MergeStateKind, PersonView, Reviewer, ReviewerState, Ticket } from '../src/derive.ts'
import { h, newTab, svg } from './dom.ts'
import type { Shape } from './dom.ts'

export type Tone = 'blue' | 'red' | 'amber' | 'green' | 'purple' | 'gray' | 'none'

export const chip = (label: string, tone: Tone, attrs: Record<string, string> = {}): HTMLSpanElement =>
  h('span', { ...attrs, class: `chip tone-${tone}` }, label)

export const icons = {
  external: [['path', { d: 'M14 4h6v6' }], ['path', { d: 'M20 4l-9 9' }], ['path', { d: 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' }]],
  chevron: [['path', { d: 'M6 9l6 6 6-6' }]],
  refresh: [['path', { d: 'M20 12a8 8 0 1 1-2.3-5.6' }], ['path', { d: 'M20 4v5h-5' }]],
  pause: [['rect', { x: '6', y: '4.5', width: '4', height: '15', rx: '1' }], ['rect', { x: '14', y: '4.5', width: '4', height: '15', rx: '1' }]],
  play: [['path', { d: 'M7 4.5v15l12-7.5z' }]],
  alert: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M12 7.5v5.5' }], ['path', { d: 'M12 16.5v.01' }]],
  offline: [['path', { d: 'M2 8.5a15 15 0 0 1 20 0' }], ['path', { d: 'M5.5 12a10 10 0 0 1 13 0' }], ['path', { d: 'M9 15.5a5 5 0 0 1 6 0' }], ['path', { d: 'M3 3l18 18' }]],
} satisfies Record<string, Shape[]>

// initials on the person's color, or their image; the name beside it carries the meaning
export const avatar = (person: PersonView, size: 'row' | 'closed' | 'pip' | 'header'): HTMLSpanElement => {
  const element = h('span', { class: `avatar avatar-${size}`, 'aria-hidden': 'true' }, person.initials)
  // config data, not styling: the stylesheet reads it as --person
  if (person.color !== null) element.style.setProperty('--person', person.color)
  if (person.avatarUrl !== null) {
    const image = h('img', { src: person.avatarUrl, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' })
    // a broken image falls back to the initials underneath
    image.addEventListener('error', () => image.remove(), { once: true })
    element.appendChild(image)
  }
  return element
}

const issueTones: Record<IssueKind, Tone> = {
  changesRequested: 'red',
  conflicts: 'amber',
  ciFailing: 'red',
  ciRunning: 'amber',
  ciCanceled: 'gray',
  ciNotRun: 'gray',
}

// a failing check links to its job run, with the job name as its tooltip
export const issueChip = (issue: Issue): HTMLElement => {
  if (issue.url === undefined) return chip(issue.label, issueTones[issue.kind])
  return h('a', { ...newTab, class: `chip chip-link tone-${issueTones[issue.kind]}`, href: issue.url, title: issue.tip ?? null },
    issue.label, svg(icons.external, { size: 10, stroke: '2.6' }))
}

const mergeTones: Record<MergeStateKind, Tone> = {
  ready: 'green',
  needsReview: 'gray',
  needsApproval: 'gray',
  checking: 'gray',
  blocked: 'none',
  draft: 'none',
}

const mergeAttributes: Partial<Record<MergeStateKind, Record<string, string>>> = {
  draft: { 'aria-label': 'draft' },
  checking: { title: 'GitHub has not worked out whether this merges cleanly yet; the next refresh asks again' },
}

export const mergeChip = (state: MergeStateKind, label: string): HTMLSpanElement =>
  chip(label, mergeTones[state], mergeAttributes[state] ?? {})

const marks: Record<ReviewerState, { mark: string, text: string }> = {
  approved: { mark: '✓', text: 'approved' },
  changes: { mark: '✗', text: 'requested changes' },
  commented: { mark: '…', text: 'commented' },
  requested: { mark: '○', text: 'review requested, pending' },
}

export const pip = (reviewer: Reviewer): HTMLSpanElement => {
  const { mark, text } = marks[reviewer.state]
  const label = `${reviewer.alias}${reviewer.team === true ? ' (team)' : ''}: ${text}`
  return h('span', { class: `pip pip-${reviewer.state}`, title: label },
    avatar(reviewer, 'pip'),
    h('span', { class: 'pip-mark', 'aria-hidden': 'true' }, mark),
    h('span', { class: 'sr-only' }, label))
}

// a ticket chip, linked when its system gives it a URL
export const ticketChip = (ticket: Ticket): HTMLElement => {
  const tip = ticket.system === 'none' ? 'Description carries the no-ticket marker' : `${ticket.system} ${ticket.label}`
  if (ticket.url === undefined) return h('span', { class: 'ticket', title: tip }, ticket.label)
  return h('a', { ...newTab, class: 'ticket', href: ticket.url, title: `Open ${tip}` }, ticket.label)
}
