// src/markdown.ts
import { Marked } from 'marked'
import type { RendererObject } from 'marked'

// a report quotes other people's PRs, so its text is hostile input. Two independent defenses
// apply (section 3 of DESIGN.md, Runtime dependencies). This module is the first: raw HTML is
// escaped rather than passed through, and a link or image URL whose scheme is not http, https
// or mailto is dropped. The second is the caller's sandboxed iframe, which runs no script even
// if something did survive this pass. The result is a body fragment, never a whole document

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

// a code point the HTML parser would produce; anything out of range decodes to nothing rather
// than throwing
const fromCode = (code: number): string => Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''

// the destination is written into an attribute, so the HTML parser decodes entities in it before
// the URL parser ever sees it: `javascript&#58;alert(1)` is a javascript URL. Decode the same
// way before deciding whether the scheme is allowed
const decodeEntities = (value: string): string =>
  value
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_, hex: string) => fromCode(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});?/g, (_, dec: string) => fromCode(Number(dec)))
    .replace(/&colon;/gi, ':')
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n')

// browsers strip control characters and whitespace out of a URL before resolving it, so
// `java\nscript:alert(1)` is a javascript URL; strip them here too before reading the scheme.
// Anything with no scheme at all is relative and harmless
export const isSafeUrl = (href: string): boolean => {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(decodeEntities(href).replace(/[\u0000- \u007f-\u009f]+/g, ''))
  if (scheme === null) return true
  const name = (scheme[1] ?? '').toLowerCase()
  return name === 'http' || name === 'https' || name === 'mailto'
}

const attribute = (name: string, value: string | null | undefined): string =>
  value === null || value === undefined || value === '' ? '' : ` ${name}="${escapeHtml(value)}"`

// object methods rather than arrow functions because marked binds them to its renderer, which is
// how `this.parser` reaches the inline parser for a link's own text
const renderer: RendererObject = {
  // block-level and inline raw HTML alike arrive here, and leave as text
  html ({ text }) {
    return escapeHtml(text)
  },
  link ({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens)
    // an unsafe destination loses the anchor entirely; the words stay, so nothing disappears
    if (!isSafeUrl(href)) return text
    return `<a${attribute('href', href)}${attribute('title', title)} target="_blank" rel="noopener noreferrer nofollow">${text}</a>`
  },
  image ({ href, title, text }) {
    if (!isSafeUrl(href)) return escapeHtml(text)
    return `<img${attribute('src', href)}${attribute('alt', text)}${attribute('title', title)} />`
  },
}

const engine = new Marked({ gfm: true, renderer })

// Markdown to an HTML body fragment with every raw HTML construct escaped; only ever meant to be
// shown inside a sandboxed document
export const renderMarkdown = (source: string): string => engine.parse(source, { async: false })
