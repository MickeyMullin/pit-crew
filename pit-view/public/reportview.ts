// public/reportview.ts
// the report panel's pure pieces: the document the rendered view puts in its sandboxed iframe, the
// theme values it is built from, and the Rendered | Raw control. The server's fragment is already
// sanitized Markdown (src/markdown.ts); this is the second defense of the two in section 3 of
// DESIGN.md: the document carries no script, a CSP that allows none, a no-referrer policy, and is
// shown in an iframe granted nothing but popups: a link (http, https or mailto only, from the
// server's renderer) opens in a new tab that is not itself sandboxed, and no script can run

export type ReportMode = 'rendered' | 'raw'

export type ModeButton = { key: ReportMode, label: string, pressed: boolean }

export const modeButtons = (mode: ReportMode): ModeButton[] => [
  { key: 'rendered', label: 'Rendered', pressed: mode === 'rendered' },
  { key: 'raw', label: 'Raw', pressed: mode === 'raw' },
]

// the iframe's sandbox attribute, exactly: no allow-scripts, allow-same-origin, allow-top-navigation
// or allow-forms, so nothing in the document can run or reach the page
export const reportSandbox = 'allow-popups allow-popups-to-escape-sandbox'

// no scripts, no frames, no forms, no network except images over https (an http image from a
// hostile report could otherwise make the browser send a GET to a service on this machine)
export const reportCsp = 'default-src \'none\'; img-src https:; style-src \'unsafe-inline\''

// the values the stylesheet takes from the page's own design tokens. The DOM side reads them with
// getComputedStyle when the panel opens (reportpanel.ts); nothing here names a color
export type ReportTheme = {
  colorScheme: string
  ink: string
  muted: string
  accent: string
  line: string
  surface: string
  code: string
  codeInk: string
  font: string
  mono: string
}

// which token feeds each value, and how it is read: a color token is resolved through an element
// that uses it, since a light-dark() pair only resolves on an element; the rest are text
export const themeSources: Readonly<Record<Exclude<keyof ReportTheme, 'colorScheme'>, { token: string, kind: 'color' | 'text' }>> = {
  ink: { token: 'ink', kind: 'color' },
  muted: { token: 'muted', kind: 'color' },
  accent: { token: 'blue-fg', kind: 'color' },
  line: { token: 'line-control', kind: 'color' },
  surface: { token: 'surface', kind: 'color' },
  code: { token: 'gray-bg', kind: 'color' },
  codeInk: { token: 'ink', kind: 'color' },
  font: { token: 'font-ui', kind: 'text' },
  mono: { token: 'font-mono', kind: 'text' },
}

// the stylesheet is built by concatenation, so a value that could close the style element, end a
// declaration, open a comment or an escape, or fetch something is not allowed through. The
// values come from our own tokens; the filter keeps that true if a token ever changes
export const cssValue = (value: string): string =>
  value
    .replace(/[<>{};\\\r\n]/g, '')
    .replace(/\/\*|\*\//g, '')
    .replace(/url\s*\(|@import|expression\s*\(/gi, '')
    .trim()

// the markup the server renders never holds a raw tag of these kinds (it escapes all raw HTML,
// so a document's own `<script>` arrives as `&lt;script&gt;`). If one ever did, its angle bracket
// is escaped here, so it shows as text instead of taking effect
const dangerousTag = /<(?=\/?(?:script|style|iframe|frame|frameset|object|embed|applet|meta|base|link|form|svg|math|template|noscript|title|textarea|xmp|plaintext)\b)/gi

export const safeFragment = (fragment: string): string => fragment.replace(dangerousTag, '&lt;')

const sheet = (theme: ReportTheme): string => {
  const t = {
    scheme: cssValue(theme.colorScheme) || 'light dark',
    ink: cssValue(theme.ink),
    muted: cssValue(theme.muted),
    accent: cssValue(theme.accent),
    line: cssValue(theme.line),
    surface: cssValue(theme.surface),
    code: cssValue(theme.code),
    codeInk: cssValue(theme.codeInk),
    font: cssValue(theme.font),
    mono: cssValue(theme.mono),
  }
  return `:root { color-scheme: ${t.scheme}; }
html, body { margin: 0; background: ${t.surface}; }
body {
  color: ${t.ink};
  font-family: ${t.font};
  font-size: 13px;
  line-height: 1.55;
  padding: 14px 18px 28px;
  overflow-wrap: anywhere;
}
:where(h1, h2, h3, h4, h5, h6) { line-height: 1.3; margin: 1.2em 0 0.45em; }
h1 { font-size: 1.3em; }
h2 { font-size: 1.15em; }
:where(h3, h4, h5, h6) { font-size: 1.02em; }
p, ul, ol, blockquote, pre, table { margin: 0 0 0.8em; }
:where(ul, ol) { padding-left: 1.5em; }
a { color: ${t.accent}; }
code { font-family: ${t.mono}; font-size: 0.92em; background: ${t.code}; color: ${t.codeInk}; padding: 1px 4px; border-radius: 4px; }
pre { background: ${t.code}; color: ${t.codeInk}; padding: 9px 11px; border-radius: 6px; overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid ${t.line}; padding-left: 11px; margin-left: 0; color: ${t.muted}; }
hr { border: none; border-top: 1px solid ${t.line}; }
img { max-width: 100%; }
table { border-collapse: collapse; display: block; overflow-x: auto; }
th, td { border: 1px solid ${t.line}; padding: 4px 8px; text-align: left; }
:where(h1, h2, h3, h4, h5, h6):first-child, p:first-child { margin-top: 0; }`
}

// a complete document for `<iframe sandbox="allow-popups ..." srcdoc>` (reportSandbox)
export const reportDocument = (fragment: string, theme: ReportTheme): string =>
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${reportCsp}">
<style>
${sheet(theme)}
</style></head>
<body>${safeFragment(fragment)}</body></html>`

// the panel's header line: the report's age, or nothing before it loads
export const reportSub = (modifiedAt: string | null, ageText: (iso: string) => string): string =>
  modifiedAt === null ? '' : `modified ${ageText(modifiedAt)}`

// a failed fetch of one report, in words
export const reportError = (name: string, status: number, error: string | null): string => {
  if (status === 0) return `Could not open ${name}: Pit View did not answer.`
  if (status === 404) return `${name} is no longer in the reports folder.`
  if (status === 413) return `${name} is too large to show here.`
  const detail = (error ?? '').trim()
  return detail === '' ? `Could not open ${name}: Pit View answered ${status}.` : `Could not open ${name}: ${detail}`
}
