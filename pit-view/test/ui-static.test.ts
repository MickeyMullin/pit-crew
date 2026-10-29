// test/ui-static.test.ts
// checks on public/ as files: colors only as tokens, contrast in both schemes, and modules the
// browser can load (path comments, and no value import from outside public/)
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'

const publicDir = join(import.meta.dirname, '..', 'public')

const publicFiles = async (): Promise<string[]> => (await readdir(publicDir)).filter((name) => !name.startsWith('.')).sort()

const read = (name: string): Promise<string> => readFile(join(publicDir, name), 'utf8')

type Rgb = [number, number, number]

const parseHex = (hex: string): Rgb => {
  const digits = hex.slice(1)
  const full = digits.length === 3 ? [...digits].map((digit) => digit + digit).join('') : digits.slice(0, 6)
  return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)) as Rgb
}

const luminance = ([r, g, b]: Rgb): number => {
  const channel = (value: number): number => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

const contrast = (a: string, b: string): number => {
  const [high, low] = [luminance(parseHex(a)), luminance(parseHex(b))].sort((x, y) => y - x) as [number, number]
  return (high + 0.05) / (low + 0.05)
}

const tokenPattern = /^\s*--([a-z-]+):\s*light-dark\((#[0-9A-Fa-f]{3,8}),\s*(#[0-9A-Fa-f]{3,8})\);\s*$/gm

const tokens = async (): Promise<Map<string, { light: string, dark: string }>> => {
  const css = await read('styles.css')
  const found = new Map<string, { light: string, dark: string }>()
  for (const match of css.matchAll(tokenPattern)) found.set(match[1]!, { light: match[2]!, dark: match[3]! })
  return found
}

// a color literal: hex, or a color function other than light-dark
const colorLiteral = /#[0-9A-Fa-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/

test('every color is a light-dark() token in styles.css, and no other file holds a color literal', async () => {
  const css = await read('styles.css')
  const outside = css.replace(tokenPattern, '').split('\n').filter((line) => colorLiteral.test(line))
  assert.deepEqual(outside, [], 'styles.css uses colors only through tokens')
  assert.match(css, /color-scheme: light dark/)
  for (const name of await publicFiles()) {
    if (name === 'styles.css') continue
    const text = await read(name)
    // svg path data such as M6 9l6 6 is not a color; strip d="..." before looking
    const lines = text.replace(/\sd="[^"]*"/g, '').split('\n').filter((line) => colorLiteral.test(line))
    assert.deepEqual(lines, [], `${name} holds no color literal`)
  }
})

// text on the backgrounds it is drawn on, in both schemes; each pair must reach 4.5:1
const textPairs: [string, string][] = [
  ['ink', 'surface'], ['ink', 'ground'], ['ink', 'red-row'], ['ink', 'red-bg'],
  ['muted', 'surface'], ['muted', 'ground'], ['muted', 'red-row'], ['muted', 'red-bg'],
  ['blue-fg', 'blue-bg'], ['blue-fg', 'surface'], ['blue-fg', 'ground'], ['blue-fg', 'red-row'],
  ['red-fg', 'red-bg'], ['red-fg', 'surface'], ['red-fg', 'red-row'],
  ['amber-fg', 'amber-bg'], ['amber-fg', 'surface'], ['amber-fg', 'red-row'],
  ['green-fg', 'green-bg'], ['green-fg', 'surface'], ['green-fg', 'ground'], ['green-fg', 'red-row'],
  ['purple-fg', 'purple-bg'], ['purple-fg', 'surface'],
  ['gray-fg', 'gray-bg'], ['gray-fg', 'surface'], ['gray-fg', 'ground'], ['gray-fg', 'red-row'],
  ['red-ink', 'red-bg'], ['red-ink-soft', 'red-bg'], ['on-red-button', 'red-button'],
  ['link-hover', 'surface'], ['on-person', 'person-fallback'],
  // the pressed Today / Yesterday button
  ['surface', 'ink'],
  // the Settings page's Save button, and the drawer's Start
  ['surface', 'blue-fg'],
  // the Agent cell's own pairs, some also listed above: the dashed start and its hover, the
  // running label and timer, the done texts on surface and on Mine's changes-requested rows, the
  // confirmation's command and refusal, and its Stop button
  ['blue-fg', 'surface'], ['blue-fg', 'blue-bg'], ['blue-fg', 'red-row'], ['muted', 'surface'], ['muted', 'red-row'],
  ['red-fg', 'surface'], ['amber-fg', 'surface'], ['green-fg', 'surface'], ['gray-fg', 'surface'],
  ['red-fg', 'red-row'], ['amber-fg', 'red-row'], ['green-fg', 'red-row'], ['gray-fg', 'red-row'],
  ['gray-fg', 'gray-bg'], ['on-red-button', 'red-button'],
  // the Fix session's caution confirmation: its heading and push line, its refusal, its facts and
  // its Start; and a finished fix's worktree notice
  ['amber-fg', 'amber-bg'], ['red-fg', 'amber-bg'], ['muted', 'amber-bg'], ['ink', 'amber-bg'], ['on-amber-button', 'amber-button'],
  // the drawer: the confirmation sits on ground, the waiting card on amber-bg, the no-longer-open
  // note is amber on amber-bg; the report panel's code is ink on gray-bg (also the iframe's)
  ['red-fg', 'ground'], ['ink', 'ground'], ['muted', 'ground'], ['ink', 'amber-bg'], ['muted', 'amber-bg'], ['amber-fg', 'amber-bg'],
  ['ink', 'gray-bg'], ['red-fg', 'surface'], ['green-fg', 'green-bg'], ['blue-fg', 'blue-bg'],
  // the sweep drawer's card a PR's link opened it at (ink, muted, and the chips' own pairs on blue-bg) and the bot group header's sweep status in each tone on ground
  ['ink', 'blue-bg'], ['muted', 'blue-bg'], ['amber-fg', 'ground'],
]

test('text meets 4.5:1 contrast in both color schemes', async () => {
  const found = await tokens()
  const failures: string[] = []
  for (const [fg, bg] of textPairs) {
    const a = found.get(fg)
    const b = found.get(bg)
    assert.ok(a !== undefined && b !== undefined, `tokens ${fg} and ${bg} exist`)
    for (const scheme of ['light', 'dark'] as const) {
      const ratio = contrast(a[scheme], b[scheme])
      if (ratio < 4.5) failures.push(`${scheme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`)
    }
  }
  assert.deepEqual(failures, [])
})

test('every public file starts with its path comment', async () => {
  const comment: Record<string, (name: string) => string> = {
    '.ts': (name) => `// public/${name}`,
    '.css': (name) => `/* public/${name} */`,
    '.html': (name) => `<!-- public/${name} -->`,
  }
  for (const name of await publicFiles()) {
    const expected = comment[name.slice(name.lastIndexOf('.'))]
    assert.ok(expected !== undefined, `${name} is a TypeScript, CSS or HTML file`)
    assert.equal((await read(name)).split('\n')[0], expected(name))
  }
})

// the server serves only public/, so a value import from src/ would fail in the browser;
// type-only imports are erased by type stripping and are fine
test('public modules import only each other once types are stripped', async () => {
  for (const name of (await publicFiles()).filter((file) => file.endsWith('.ts'))) {
    const code = stripTypeScriptTypes(await read(name), { mode: 'strip' })
    const sources = [...code.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1]!)
    for (const source of sources) assert.match(source, /^\.\/[a-z-]+\.ts$/, `${name} imports ${source}`)
  }
})

// every link the page builds to GitHub or a ticket system opens in a new tab; only in-page and
// in-app links (an href starting with # or /) may open in place
test('every link built in public/ opens in a new tab unless it stays in the app', async () => {
  const inPlace: string[] = []
  for (const name of (await publicFiles()).filter((file) => file.endsWith('.ts'))) {
    for (const [attrs] of (await read(name)).matchAll(/h\('a', \{[^}]*\}/g)) {
      if (attrs.includes('...newTab') || /href: [`'][#/]/.test(attrs)) continue
      inPlace.push(`${name}: ${attrs}`)
    }
  }
  assert.deepEqual(inPlace, [])
})
