// test/ui-timeformat.test.ts
// the time format preference: the one shared formatter in public/format.ts reads it, and no other file formats a time
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { formatCached, formatClock, getTimeFormat, parseTimeFormat, setTimeFormat } from '../public/format.ts'

const zone = 'America/New_York'

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

// code that turns an instant into clock text; only the shared formatter may do it
const clockText = [
  /\btoLocale(?:Time|Date)?String\b/,
  /\bgetU?TC?Hours\b|\bgetHours\b|\bgetUTCHours\b|\bgetMinutes\b|\bgetUTCMinutes\b/,
  /\bhour12\b|\bhourCycle\b|\btimeStyle\b|\bdateStyle\b/,
  /\bnew Intl\.(?:DateTimeFormat|RelativeTimeFormat)\b/,
  /\.toISOString\(\)\.(?:slice|substring|substr)\(/,
]

// the server's calendar arithmetic reads a zone's wall clock to find day boundaries; it shows nothing
const allowed = new Set(['src/time.ts'])

const sourceFiles = async (): Promise<string[]> => {
  const root = join(import.meta.dirname, '..')
  const files: string[] = []
  for (const dir of ['public', 'src']) {
    for (const name of await readdir(join(root, dir))) {
      if (name.endsWith('.ts') || name.endsWith('.html')) files.push(`${dir}/${name}`)
    }
  }
  return files.sort()
}

test('no file formats a time outside public/format.ts', async () => {
  const offenders: string[] = []
  for (const file of await sourceFiles()) {
    if (file === 'public/format.ts' || allowed.has(file)) continue
    const lines = (await readFile(join(import.meta.dirname, '..', file), 'utf8')).split('\n')
    lines.forEach((line, at) => {
      if (line.trimStart().startsWith('//')) return
      if (clockText.some((pattern) => pattern.test(line))) offenders.push(`${file}:${at + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], 'format times through public/format.ts, which reads the time format preference')
})

test('the check catches what it looks for', () => {
  const sample = ['new Date().toLocaleTimeString()', 'date.getHours()', 'new Intl.DateTimeFormat(\'en-US\', { hour12: false })', 'iso.toISOString().slice(11, 16)']
  for (const line of sample) assert.ok(clockText.some((pattern) => pattern.test(line)), line)
  assert.ok(!clockText.some((pattern) => pattern.test('Intl.DateTimeFormat().resolvedOptions().timeZone')))
})

test('only 24h reads as 24 hour; anything else the config holds reads as the 12 hour default', () => {
  assert.equal(parseTimeFormat('24h'), '24h')
  for (const other of ['12h', undefined, null, 24, '', '24H']) assert.equal(parseTimeFormat(other), '12h')
})
