// test/ui-timeformat.test.ts
// the time format preference: the one shared formatter in public/format.ts reads it, and no other file formats a time
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { test } from 'node:test'
import { formatCached, formatClock, getTimeFormat, parseTimeFormat, setTimeFormat } from '../public/format.ts'

const zone = 'America/New_York'
const root = join(import.meta.dirname, '..')

// the preference is module state, so every test that changes it puts it back
const withFormat = (format: '12h' | '24h', body: () => void): void => {
  try {
    setTimeFormat(format)
    body()
  } finally {
    setTimeFormat('12h')
  }
}

test('the time format is 12 hour until something sets it', () => {
  assert.equal(getTimeFormat(), '12h')
  assert.equal(formatClock('2026-10-25T21:53:00Z', false, zone), '5:53 PM')
})

test('24 hour shows clock times without AM or PM, zero-padded, with and without a weekday', () => {
  withFormat('24h', () => {
    assert.equal(formatClock('2026-10-25T21:53:00Z', false, zone), '17:53')
    assert.equal(formatClock('2026-10-25T21:53:00Z', true, zone), 'Sun 17:53')
    assert.equal(formatClock('2026-10-26T13:05:00Z', false, zone), '09:05')
    assert.equal(formatClock('2026-10-26T04:00:00Z', false, zone), '00:00')
  })
})

test('a cache time follows the preference, today and on an earlier day', () => {
  const now = Date.parse('2026-10-26T18:00:00Z')
  withFormat('24h', () => {
    assert.equal(formatCached('2026-10-26T14:02:00Z', now, zone), '10:02')
    assert.equal(formatCached('2026-10-23T14:02:00Z', now, zone), 'Fri 10:02')
  })
  assert.equal(formatCached('2026-10-26T14:02:00Z', now, zone), '10:02 AM')
})

test('setting the preference back to 12 hour restores AM and PM at once', () => {
  setTimeFormat('24h')
  setTimeFormat('12h')
  assert.equal(formatClock('2026-10-25T21:53:00Z', false, zone), '5:53 PM')
})

// code that turns an instant into clock text; only the shared formatter may do it. The Intl constructors match with or without new
const clockText = [
  /\b(?:toTimeString|toLocaleTimeString|toLocaleDateString|toLocaleString|toDateString|toUTCString|toGMTString)\b/,
  /\b(?:getHours|getMinutes|getUTCHours|getUTCMinutes)\b/,
  /\b(?:hour12|hourCycle|timeStyle|dateStyle)\b/,
  /\bIntl\s*\.\s*(?:DateTimeFormat|RelativeTimeFormat)\b/,
  /\.toISOString\(\)\s*\.\s*(?:slice|substring|substr)\(/,
]

// the browser's own zone name is not a time: Settings reads it to offer the day boundary's zone, and shows no clock from it
const zoneLookup = /\bIntl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone\b/g

const formatsClock = (line: string): boolean => {
  const code = line.replace(zoneLookup, '')
  return clockText.some((pattern) => pattern.test(code))
}

// the server's calendar arithmetic reads a zone's wall clock to find day boundaries; it shows nothing
const allowed = new Set(['src/time.ts'])

// every file the server ships to the browser, or that a build step could read, that can hold code; the rest are inert data
const scanned = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.html', '.htm', '.svg'])
const inert = new Set(['.css', '.json', '.png', '.ico', '.webp', '.woff2'])

const walk = async (dir: string): Promise<string[]> => {
  const files: string[] = []
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) files.push(...await walk(path))
    else files.push(path)
  }
  return files
}

const sourceFiles = async (): Promise<string[]> =>
  (await Promise.all(['public', 'src'].map(walk))).flat().filter((file) => scanned.has(extname(file).toLowerCase())).sort()

const isComment = (line: string): boolean => /^(?:\/\/|\/\*|\*|<!--)/.test(line.trimStart())

test('no file formats a time outside public/format.ts', async () => {
  const offenders: string[] = []
  for (const file of await sourceFiles()) {
    if (file === 'public/format.ts' || allowed.has(file)) continue
    const lines = (await readFile(join(root, file), 'utf8')).split('\n')
    lines.forEach((line, at) => {
      if (!isComment(line) && formatsClock(line)) offenders.push(`${file}:${at + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], 'format times through public/format.ts, which reads the time format preference')
})

test('the scan reaches nested folders and every extension the static handler can serve as code', async () => {
  const files = await sourceFiles()
  for (const expected of ['public/format.ts', 'public/index.html', 'public/settings.html', 'src/time.ts', 'src/server.ts']) assert.ok(files.includes(expected), expected)
  const server = await readFile(join(root, 'src/server.ts'), 'utf8')
  const served = [...(server.match(/const staticTypes[^{]*\{([^}]*)\}/s)?.[1] ?? '').matchAll(/'(\.[a-z0-9]+)'\s*:/g)].map((match) => match[1] ?? '')
  assert.ok(served.length > 0, 'the static handler\'s extensions were not found')
  for (const extension of served) assert.ok(scanned.has(extension) || inert.has(extension), `${extension} is served to the browser: scan it or list it as inert`)
  const all = (await Promise.all(['public', 'src'].map(walk))).flat()
  for (const file of all) {
    const extension = extname(file).toLowerCase()
    assert.ok(scanned.has(extension) || inert.has(extension), `${file}: ${extension} is neither scanned nor listed as inert`)
  }
})

test('the check catches what it looks for, with and without new', () => {
  const sample = [
    'new Date().toLocaleTimeString()', 'date.toLocaleDateString()', 'date.toLocaleString(\'en-US\')', 'date.toTimeString()', 'date.toDateString()', 'date.toUTCString()', 'date.toGMTString()',
    'date.getHours()', 'date.getMinutes()', 'date.getUTCHours()', 'date.getUTCMinutes()', 'const options = { hour12: false }', '{ hourCycle: \'h23\' }', '{ timeStyle: \'short\' }', '{ dateStyle: \'medium\' }',
    'new Intl.DateTimeFormat(\'en-US\', { hour12: false })', 'Intl.DateTimeFormat(\'en-US\', { hour: \'numeric\', minute: \'2-digit\' })', 'Intl.RelativeTimeFormat(\'en\')', 'new Intl.RelativeTimeFormat(\'en\')',
    'iso.toISOString().slice(11, 16)', 'iso.toISOString().substring(11, 16)', 'iso.toISOString() .slice(11, 16)',
  ]
  for (const line of sample) assert.ok(formatsClock(line), line)
  assert.ok(!formatsClock('const zone = Intl.DateTimeFormat().resolvedOptions().timeZone'))
  assert.ok(formatsClock('Intl.DateTimeFormat().resolvedOptions().timeZone; Intl.DateTimeFormat(\'en-US\', { hour: \'numeric\' })'))
})

test('only 24h reads as 24 hour; anything else the config holds reads as the 12 hour default', () => {
  assert.equal(parseTimeFormat('24h'), '24h')
  for (const other of ['12h', undefined, null, 24, '', '24H']) assert.equal(parseTimeFormat(other), '12h')
})
