// test/ui-static.test.ts
// checks on public/ as files: colors only as tokens, contrast in both schemes, and modules the
// browser can load (path comments, and no value import from outside public/)
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'

const publicDir = join(import.meta.dirname, '..', 'public')

// pictures and the manifest are data: the checks below on colors and path comments read text files, and the icon test reads the rest
const dataExtensions = ['.png', '.ico', '.webmanifest']

const publicFiles = async (): Promise<string[]> => (await readdir(publicDir)).filter((name) => !name.startsWith('.') && !dataExtensions.some((extension) => name.endsWith(extension))).sort()

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
  // the header's auto-review button (muted, or amber for a skipped tick) and its popover on surface, with the Settings link
  ['muted', 'surface'], ['amber-fg', 'surface'], ['ink', 'surface'], ['blue-fg', 'surface'],
  // the Settings Auto-review card: the Now line's label, meta, and text on ground, its amber skip on amber-bg, a checked day chip, and the amber notes on surface
  ['muted', 'ground'], ['ink', 'ground'], ['amber-fg', 'amber-bg'], ['ink', 'amber-bg'], ['blue-fg', 'blue-bg'], ['amber-fg', 'surface'],
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
    assert.ok(expected !== undefined, `${name} is a TypeScript, CSS, or HTML file`)
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

// the icons: the owner's art as committed PNGs, linked from every page's head, with no outside request
const pngInfo = (bytes: Buffer): { signature: string, width: number, height: number, colorType: number } =>
  ({ signature: bytes.subarray(0, 8).toString('hex'), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25]! })

const pngSignature = '89504e470d0a1a0a'

test('every page links the favicon sizes, the Apple touch icon, and the manifest, and no page leaves an empty icon link', async () => {
  const pages = (await readdir(publicDir)).filter((file) => file.endsWith('.html'))
  assert.deepEqual(pages.sort(), ['index.html', 'settings.html'])
  for (const name of pages) {
    const head = (await read(name)).split('</head>')[0]!
    assert.doesNotMatch(head, /rel="icon"[^>]*href="data:/, `${name} has no empty icon link that hides the favicon`)
    assert.doesNotMatch(head, /favicon\.svg/, `${name} does not link the old SVG`)
    assert.match(head, /<link rel="icon" type="image\/png" sizes="16x16" href="\/favicon-16\.png">/, `${name} links the 16 pixel favicon`)
    assert.match(head, /<link rel="icon" type="image\/png" sizes="32x32" href="\/favicon-32\.png">/, `${name} links the 32 pixel favicon`)
    assert.match(head, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/, `${name} links the touch icon`)
    // the manifest is read with the page's cookies, so a signed-in proxied page can fetch it
    assert.match(head, /<link rel="manifest" href="\/site\.webmanifest" crossorigin="use-credentials">/, `${name} links the manifest`)
  }
})

test('the icon files are the owner\'s art at the sizes the pages and the manifest name, and the app icons are opaque', async () => {
  const bytes = (name: string): Promise<Buffer> => readFile(join(publicDir, name))
  const designFavicon = await readFile(join(import.meta.dirname, '..', 'design', 'pit-view-favicon.png'))
  assert.ok((await bytes('favicon-16.png')).equals(designFavicon), 'the 16 pixel favicon is the owner\'s own file')
  const sizes: [string, number][] = [['favicon-16.png', 16], ['favicon-32.png', 32], ['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]
  for (const [name, size] of sizes) {
    const info = pngInfo(await bytes(name))
    assert.deepEqual([info.signature, info.width, info.height], [pngSignature, size, size], `${name} is a ${size} pixel square PNG`)
  }
  // an app icon with a transparent corner is filled in black by some systems: color type 2 is RGB with no alpha
  for (const name of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) assert.equal(pngInfo(await bytes(name)).colorType, 2, `${name} is opaque`)
  const designApp = await readFile(join(import.meta.dirname, '..', 'design', 'pit-view-icon-blue-on-white.png'))
  assert.ok((await bytes('icon-512.png')).equals(designApp), 'the 512 pixel app icon is the owner\'s blue-on-white file')
  // favicon.ico holds the 16, 32, and 48 pixel images as PNG entries
  const ico = await bytes('favicon.ico')
  assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)], [0, 1, 3])
  const entries = [0, 1, 2].map((at) => ({ width: ico[6 + at * 16]!, height: ico[7 + at * 16]!, length: ico.readUInt32LE(14 + at * 16), offset: ico.readUInt32LE(18 + at * 16) }))
  assert.deepEqual(entries.map((entry) => [entry.width, entry.height]), [[16, 16], [32, 32], [48, 48]])
  for (const entry of entries) assert.equal(ico.subarray(entry.offset, entry.offset + 8).toString('hex'), pngSignature, 'each entry is a PNG')
})

test('the manifest names the app and its two icons, which exist, and holds no color', async () => {
  const manifest = JSON.parse(await readFile(join(publicDir, 'site.webmanifest'), 'utf8')) as Record<string, unknown>
  assert.equal(manifest.name, 'Pit View')
  assert.equal(manifest.short_name, 'Pit View')
  assert.equal(manifest.start_url, '/')
  assert.equal(manifest.display, 'standalone')
  assert.deepEqual(manifest.icons, [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
  ])
  for (const icon of manifest.icons as { src: string }[]) assert.ok((await readdir(publicDir)).includes(icon.src.slice(1)), `${icon.src} exists`)
  assert.doesNotMatch(JSON.stringify(manifest), colorLiteral, 'colors live in styles.css tokens alone')
})

// the logo in the page header is the owner's art, drawn as a mask in a theme token, not the old inline branch glyph
test('the header brand is the logo picture masked in a theme color, and the old inline branch glyph is gone', async () => {
  const brand = (await read('index.html')).split('<div class="brand">')[1]!.split('</div>')[0]!
  assert.match(brand, /<span class="brand-logo" aria-hidden="true"><\/span>/)
  assert.doesNotMatch(brand, /<svg/, 'no inline glyph in the brand')
  const rule = (await read('styles.css')).match(/\.brand-logo \{[^}]*\}/)?.[0] ?? ''
  assert.match(rule, /mask: url\("\/logo\.png"\) center \/ contain no-repeat/)
  assert.match(rule, /background-color: var\(--blue-fg\)/)
  const logo = await readFile(join(publicDir, 'logo.png'))
  assert.deepEqual([logo.subarray(0, 8).toString('hex'), logo.readUInt32BE(16), logo.readUInt32BE(20), logo[25]], ['89504e470d0a1a0a', 96, 96, 6], 'a 96 pixel square PNG with an alpha channel')
})
