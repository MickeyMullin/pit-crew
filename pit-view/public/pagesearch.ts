// public/pagesearch.ts
// the header's page search, pure: which words it looks for, which rows match, where a match falls
// in a piece of text, and when "/" may focus the field; no DOM here beyond the highlight builder
import type { Ticket } from '../src/derive.ts'
import { h } from './dom.ts'
import type { Child } from './dom.ts'

// the fields the search reads, which every open and closed row has
export type Searchable = {
  number: number
  title: string
  author: { alias: string, login: string }
  headRef: string
  tickets: readonly Ticket[]
}

// lowercase words; each loses a leading hash mark, so a PR number typed with one still finds it
export const searchTerms = (query: string): string[] =>
  query.toLowerCase().split(/\s+/).map((word) => word.replace(/^#/, '')).filter((word) => word !== '')

// every word must appear in some field
export const matchesPage = (terms: readonly string[]) => (row: Searchable): boolean => {
  if (terms.length === 0) return true
  const fields = [String(row.number), row.title, row.author.alias, row.author.login, row.headRef, ...row.tickets.map((ticket) => ticket.label)]
    .map((field) => field.toLowerCase())
  return terms.every((term) => fields.some((field) => field.includes(term)))
}

export type Hit = { label: 'branch' | 'login' | 'ticket', text: string }

const hasTerm = (text: string, terms: readonly string[]): boolean => {
  const lower = text.toLowerCase()
  return terms.some((term) => lower.includes(term))
}

// matches in fields no cell shows: the branch, a login its alias hides, and the tickets of an
// open row; the row says so beside its title, so a match never looks arbitrary
export const hiddenHits = (terms: readonly string[], row: Searchable, shown: { tickets: boolean }): Hit[] => {
  const hits: Hit[] = []
  if (hasTerm(row.headRef, terms)) hits.push({ label: 'branch', text: row.headRef })
  if (hasTerm(row.author.login, terms) && !hasTerm(row.author.alias, terms)) hits.push({ label: 'login', text: row.author.login })
  if (shown.tickets) {
    for (const ticket of row.tickets) {
      if (hasTerm(ticket.label, terms)) hits.push({ label: 'ticket', text: ticket.label })
    }
  }
  return hits
}

export type Piece = { text: string, hit: boolean }

// the text cut at every occurrence of a word, overlapping or touching occurrences merged
export const splitMatches = (text: string, terms: readonly string[]): Piece[] => {
  if (text === '') return []
  const lower = text.toLowerCase()
  const spans: [number, number][] = []
  for (const term of terms) {
    for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + 1)) spans.push([at, at + term.length])
  }
  spans.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last !== undefined && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else merged.push([...span])
  }
  const pieces: Piece[] = []
  let from = 0
  for (const [start, end] of merged) {
    if (start > from) pieces.push({ text: text.slice(from, start), hit: false })
    pieces.push({ text: text.slice(start, end), hit: true })
    from = end
  }
  if (from < text.length) pieces.push({ text: text.slice(from), hit: false })
  return pieces
}

// text with its matches in <mark>; without words it is the text itself
export const highlighted = (text: string, terms: readonly string[]): Child[] =>
  terms.length === 0 ? [text] : splitMatches(text, terms).map((piece) => piece.hit ? h('mark', { class: 'search-hit' }, piece.text) : piece.text)

// the line under a title that names a match in a field the row does not show
export const hitsLine = (hits: readonly Hit[], terms: readonly string[]): HTMLElement | null =>
  hits.length === 0
    ? null
    : h('span', { class: 'search-hits' }, hits.map((hit) => h('span', { class: 'search-hit-field' }, `${hit.label} `, h('span', { class: 'mono' }, highlighted(hit.text, terms)))))

// "/" focuses the search from anywhere no field has focus; a modified "/" is the browser's or the system's
export const slashApplies = (event: { key: string, tag: string, editable: boolean, ctrl: boolean, meta: boolean, alt: boolean }): boolean =>
  event.key === '/' && !event.ctrl && !event.meta && !event.alt && !event.editable && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.tag)
