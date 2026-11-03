// test/ui-timeformat.test.ts
// the time format preference: the one shared formatter in public/format.ts reads it, and no other browser code turns a time into text
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { test } from 'node:test'
import { formatCached, formatClock, formatDay, getTimeFormat, parseTimeFormat, setTimeFormat } from '../public/format.ts'
import { browserSources, checkTimeText, codeExtensions, inertExtensions, pageExtensions, publicFiles, root } from './timetext.ts'

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

test('a time given as milliseconds reads as its ISO string does, in either format', () => {
  const ms = Date.parse('2026-10-25T21:53:00Z')
  assert.equal(formatClock(ms, true, zone), 'Sun 5:53 PM')
  assert.equal(formatDay(ms, zone), 'Sun Oct 25')
  withFormat('24h', () => assert.equal(formatClock(ms, false, zone), '17:53'))
})

test('setting the preference back to 12 hour restores AM and PM at once', () => {
  setTimeFormat('24h')
  setTimeFormat('12h')
  assert.equal(formatClock('2026-10-25T21:53:00Z', false, zone), '5:53 PM')
})

test('no code the browser runs turns a time into text outside public/format.ts', async () => {
  const { offenders } = checkTimeText(await browserSources())
  assert.deepEqual(offenders, [], 'outside public/format.ts, hold no Date or Intl value and call the Date constructor only for milliseconds; write the time through public/format.ts, which reads the time format preference')
})

test('the check reads every file the static handler can serve: code and pages are checked, the rest hold no script', async () => {
  const server = await readFile(join(root, 'src/server.ts'), 'utf8')
  const served = [...(server.match(/const staticTypes[^{]*\{([^}]*)\}/s)?.[1] ?? '').matchAll(/'(\.[a-z0-9]+)'\s*:/g)].map((match) => match[1] ?? '')
  assert.ok(served.length > 0, 'the static handler\'s extensions were not found')
  const known = (extension: string): boolean => codeExtensions.has(extension) || pageExtensions.has(extension) || inertExtensions.has(extension)
  for (const extension of served) assert.ok(known(extension), `${extension} is served to the browser: check it as code or a page, or list it as inert`)
  for (const file of await publicFiles()) {
    const extension = extname(file).toLowerCase()
    assert.ok(known(extension), `${file}: ${extension} is neither checked nor listed as inert`)
    const text = await readFile(file, 'utf8')
    if (inertExtensions.has(extension)) assert.doesNotMatch(text, /<script\b/i, `${file} holds a script the check cannot read`)
    if (pageExtensions.has(extension)) assert.doesNotMatch(text.replace(/<script\b[\s\S]*?<\/script>/gi, ''), /<[^>]*\son[a-z]+\s*=/i, `${file} holds an inline event handler the check cannot read`)
  }
  const { shipped } = checkTimeText(await browserSources())
  for (const expected of ['public/format.ts', 'public/app.ts', 'public/settings.ts', 'public/index.html.inline-1.js', 'public/settings.html.inline-1.js']) assert.ok(shipped.includes(expected), expected)
})

// each sample is its own browser module beside the real ones, so it may import the shared formatter
const samplePath = (name: string): string => join(root, 'public', `timetext-sample-${name}.ts`)

const flagged: Record<string, string> = {
  dateToString: 'export const at = new Date().toString()',
  stringOfDate: 'export const at = String(new Date())',
  templateDate: 'const now = new Date()\nexport const at = `saved ${now}`',
  plusDate: 'export const at = \'saved \' + new Date()',
  isoUnsliced: 'export const at = new Date().toISOString()',
  timeString: 'export const at = new Date(Date.now()).toTimeString()',
  intlWithoutNew: 'export const at = Intl.DateTimeFormat(\'en-US\', { hour: \'numeric\', minute: \'2-digit\' }).format(0)',
  intlWithNew: 'export const at = new Intl.DateTimeFormat(\'en-US\').format(0)',
  dateCalled: 'export const at = Date()',
  aliasedConstructor: 'const Clock = Date\nexport const at = new Clock().getHours()',
  domDate: 'export const at = (input: HTMLInputElement): string => `${input.valueAsDate?.getHours()}`',
  textSink: 'export const show = (cell: HTMLElement, ms: number): void => {\n  cell.textContent = new Date(ms).toLocaleTimeString()\n}',
  attributeSink: 'export const show = (cell: HTMLElement, ms: number): void => cell.setAttribute(\'title\', new Date(ms).toUTCString())',
}

const passed: Record<string, string> = {
  age: 'export const age = (iso: string, now: number): number => Math.floor((now - Date.parse(iso)) / 60_000)',
  comparison: 'export const newer = (a: string, b: string): boolean => Date.parse(a) > Date.parse(b)',
  sorting: 'export const oldestFirst = (times: string[]): string[] => [...times].sort((a, b) => Date.parse(a) - Date.parse(b))',
  now: 'export const skew = (serverNow: string): number => Date.parse(serverNow) - Date.now()',
  formatter: 'import { formatClock } from \'./format.ts\'\nexport const at = formatClock(\'2026-10-25T21:53:00Z\')',
  wordsOnly: '// new Date().toString() in a comment is not code\nexport const help = \'String(new Date()) and toTimeString() are words here\'',
}

test('the rule flags a Date or an Intl value however it would become text, and passes arithmetic, comparisons, and the shared formatter', () => {
  const sources = Object.entries({ ...flagged, ...passed }).map(([name, text]) => ({ path: samplePath(name), text }))
  const { offenders } = checkTimeText(sources)
  const flaggedIn = (name: string): string[] => offenders.filter((line) => line.startsWith(`public/timetext-sample-${name}.ts:`))
  for (const name of Object.keys(flagged)) assert.ok(flaggedIn(name).length > 0, `${name} should be flagged: ${flagged[name]}`)
  for (const name of Object.keys(passed)) assert.deepEqual(flaggedIn(name), [], `${name} should pass: ${passed[name]}`)
})

test('a file reached by a value import is browser code and is checked; a type import is erased and is not', () => {
  const { offenders, shipped } = checkTimeText([
    { path: samplePath('valueImport'), text: 'import { iso } from \'../src/time.ts\'\nexport const at = iso(0)' },
    { path: samplePath('typeImport'), text: 'import type { Config } from \'../src/config.ts\'\nexport const repo = (config: Config): string => config.repo' },
  ])
  assert.ok(shipped.includes('src/time.ts'))
  assert.ok(!shipped.includes('src/config.ts'))
  assert.ok(offenders.some((line) => line.startsWith('src/time.ts:')), 'src/time.ts holds Date values, so a page that imports it fails')
})

test('only 24h reads as 24 hour; anything else the config holds reads as the 12 hour default', () => {
  assert.equal(parseTimeFormat('24h'), '24h')
  for (const other of ['12h', undefined, null, 24, '', '24H']) assert.equal(parseTimeFormat(other), '12h')
})
