// test/ui-report.test.ts
// the report panel's pure pieces (public/reportview.ts): the document the rendered view builds for
// its sandboxed iframe, what a hostile fragment or theme value can and cannot do to it, the
// iframe's sandbox attribute, the Rendered | Raw control and the error words
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { cssValue, modeButtons, reportCsp, reportDocument, reportError, reportSandbox, reportSub, safeFragment, themeSources } from '../public/reportview.ts'
import type { ReportTheme } from '../public/reportview.ts'

// invented values in the shape getComputedStyle returns
const theme: ReportTheme = {
  colorScheme: 'light dark',
  ink: 'rgb(23, 24, 26)',
  muted: 'rgb(91, 95, 102)',
  accent: 'rgb(29, 78, 216)',
  line: 'rgb(217, 217, 212)',
  surface: 'rgb(255, 255, 255)',
  code: 'rgb(238, 238, 235)',
  codeInk: 'rgb(23, 24, 26)',
  font: 'Inter, system-ui, sans-serif',
  mono: '\'JetBrains Mono\', ui-monospace, monospace',
}

const count = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length

test('the iframe\'s sandbox grants popups so a link opens in a new tab, and nothing else', () => {
  assert.equal(reportSandbox, 'allow-popups allow-popups-to-escape-sandbox')
  const tokens = reportSandbox.split(' ')
  assert.deepEqual(tokens.sort(), ['allow-popups', 'allow-popups-to-escape-sandbox'])
  for (const forbidden of ['allow-scripts', 'allow-same-origin', 'allow-top-navigation', 'allow-forms']) {
    assert.ok(!tokens.some((token) => token.startsWith(forbidden)), `${forbidden} is not granted`)
  }
})

test('the document has a doctype, a charset, a no-referrer policy and a CSP that allows no script, and holds no script', () => {
  const doc = reportDocument('<h1>PR-101</h1><p>text</p>', theme)
  assert.ok(doc.startsWith('<!doctype html>'))
  assert.match(doc, /<meta charset="utf-8">/)
  assert.match(doc, /<meta name="referrer" content="no-referrer">/)
  assert.match(doc, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https:; style-src 'unsafe-inline'">/)
  assert.equal(reportCsp, 'default-src \'none\'; img-src https:; style-src \'unsafe-inline\'')
  // images over https only: an http image could make the browser send a GET to a local service
  assert.ok(!/img-src[^;"]*\bhttp:/.test(doc))
  assert.ok(!/<script/i.test(doc))
  assert.equal(count(doc, /<style>/g), 1)
  assert.equal(count(doc, /<\/style>/g), 1)
  assert.match(doc, /<body><h1>PR-101<\/h1><p>text<\/p><\/body>/)
})

test('the stylesheet takes its colors and fonts from the theme it is given', () => {
  const doc = reportDocument('<p>x</p>', theme)
  for (const value of [theme.ink, theme.accent, theme.line, theme.surface, theme.code, theme.font, theme.mono]) {
    assert.ok(doc.includes(value), `${value} is used`)
  }
  assert.match(doc, /color-scheme: light dark/)
  const dark = reportDocument('<p>x</p>', { ...theme, colorScheme: 'dark', surface: 'rgb(28, 29, 32)' })
  assert.match(dark, /color-scheme: dark/)
  assert.ok(dark.includes('rgb(28, 29, 32)') && !dark.includes('rgb(255, 255, 255)'))
})

test('a theme value cannot close the style element, end a declaration or reach the network', () => {
  const hostile: ReportTheme = {
    ...theme,
    ink: 'red; } </style><script>alert(1)</script><style>',
    accent: 'blue}\\3c /style>',
    font: 'x; background: url(https://tracker.example.test/p.png)',
    mono: '@import "https://example.test/x.css"',
    surface: 'white /* comment',
    colorScheme: '',
  }
  const doc = reportDocument('<p>x</p>', hostile)
  assert.equal(count(doc, /<\/style>/gi), 1, 'the style element closes once, at its end')
  assert.equal(count(doc, /<style>/gi), 1)
  assert.ok(!/<script/i.test(doc))
  assert.ok(!/url\s*\(/i.test(doc) && !/@import/i.test(doc))
  const sheet = doc.slice(doc.indexOf('<style>') + 7, doc.indexOf('</style>'))
  assert.ok(!sheet.includes('\\') && !sheet.includes('/*') && !sheet.includes('<'))
  // an empty color scheme falls back to both
  assert.match(doc, /color-scheme: light dark/)
  assert.equal(cssValue('a;b{c}<d>'), 'abcd')
  assert.equal(cssValue('  rgb(1, 2, 3)  '), 'rgb(1, 2, 3)')
})

test('a hostile fragment still cannot add a script or any element that loads or navigates: the tags are shown as text', () => {
  const fragment = [
    '<p>fine <strong>text</strong> and <code>&lt;script&gt;alert(1)&lt;/script&gt;</code></p>',
    '<script>alert(1)</script>',
    '</style><SCRIPT src=https://example.test/x.js></SCRIPT>',
    '<iframe src="https://example.test"></iframe><object data="x"></object><embed src="x"><meta http-equiv="refresh" content="0;url=https://example.test">',
    '<base href="https://example.test/"><link rel="stylesheet" href="https://example.test/x.css"><form action="https://example.test"></form><svg onload="x"></svg>',
    '<img src="https://example.test/a.png" alt="ok">',
  ].join('\n')
  const doc = reportDocument(fragment, theme)
  assert.ok(!/<script/i.test(doc))
  assert.equal(count(doc, /<\/style>/gi), 1)
  for (const tag of ['iframe', 'object', 'embed', 'base', 'link', 'form', 'svg']) {
    assert.ok(!doc.toLowerCase().includes(`<${tag}`), `<${tag} is not live`)
  }
  assert.equal(count(doc, /<meta /g), 3, 'only the document\'s own three meta tags')
  // the entity-escaped text the server produces for a code span is left exactly as it is
  assert.ok(doc.includes('<code>&lt;script&gt;alert(1)&lt;/script&gt;</code>'))
  // harmless markup passes through
  assert.ok(doc.includes('<strong>text</strong>') && doc.includes('<img src="https://example.test/a.png" alt="ok">'))
  assert.equal(safeFragment('<p>a &lt; b</p>'), '<p>a &lt; b</p>')
  assert.equal(safeFragment('<scriptx>'), '<scriptx>')
})

test('every token the theme reads exists in styles.css, as a color pair or a font', async () => {
  const css = await readFile(join(import.meta.dirname, '..', 'public', 'styles.css'), 'utf8')
  for (const [key, source] of Object.entries(themeSources)) {
    const pattern = source.kind === 'color' ? new RegExp(`--${source.token}: light-dark\\(`) : new RegExp(`--${source.token}: `)
    assert.match(css, pattern, `${key} reads --${source.token}`)
  }
})

test('the Rendered | Raw control starts on Rendered and presses one button at a time', () => {
  assert.deepEqual(modeButtons('rendered'), [
    { key: 'rendered', label: 'Rendered', pressed: true },
    { key: 'raw', label: 'Raw', pressed: false },
  ])
  assert.deepEqual(modeButtons('raw').map((button) => button.pressed), [false, true])
})

test('the header line and the errors read in plain words', () => {
  assert.equal(reportSub('2026-10-28T10:00:00Z', () => '5m ago'), 'modified 5m ago')
  assert.equal(reportSub(null, () => 'x'), '')
  assert.equal(reportError('PR-101.md', 0, null), 'Could not open PR-101.md: Pit View did not answer.')
  assert.equal(reportError('PR-101.md', 404, 'no report named PR-101.md'), 'PR-101.md is no longer in the reports folder.')
  assert.equal(reportError('PR-101.md', 413, null), 'PR-101.md is too large to show here.')
  assert.equal(reportError('PR-101.md', 400, 'a report is named like PR-101.md'), 'Could not open PR-101.md: a report is named like PR-101.md')
  assert.equal(reportError('PR-101.md', 500, null), 'Could not open PR-101.md: Pit View answered 500.')
})
