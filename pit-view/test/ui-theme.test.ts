// test/ui-theme.test.ts
// the theme toggle (public/theme.ts): the cycle, its labels, storage that fails, and the inline
// script each page runs before first paint, which must agree with theme.ts
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { colorSchemeOf, nextTheme, parseTheme, readTheme, themeKey, themeLabel, writeTheme } from '../public/theme.ts'
import type { Theme, ThemeStorage } from '../public/theme.ts'

const memory = (initial: Record<string, string> = {}): ThemeStorage & { items: Map<string, string> } => {
  const items = new Map(Object.entries(initial))
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value)
    },
    removeItem: (key) => {
      items.delete(key)
    },
  }
}

const refusing = (): ThemeStorage => ({
  getItem: () => {
    throw new Error('SecurityError: storage is blocked')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  },
  removeItem: () => {
    throw new Error('SecurityError: storage is blocked')
  },
})

test('one click moves System to Light to Dark and back to System', () => {
  const seen: Theme[] = ['system']
  for (let step = 0; step < 3; step += 1) seen.push(nextTheme(seen.at(-1)!))
  assert.deepEqual(seen, ['system', 'light', 'dark', 'system'])
})

test('the color scheme and the label follow the theme', () => {
  assert.equal(colorSchemeOf('system'), 'light dark')
  assert.equal(colorSchemeOf('light'), 'light')
  assert.equal(colorSchemeOf('dark'), 'dark')
  assert.equal(themeLabel('system'), 'Theme: System. Switch to light')
  assert.equal(themeLabel('light'), 'Theme: Light. Switch to dark')
  assert.equal(themeLabel('dark'), 'Theme: Dark. Switch to system')
})

test('a stored light or dark is read back, and anything else is System', () => {
  assert.equal(readTheme(() => memory({ [themeKey]: 'light' })), 'light')
  assert.equal(readTheme(() => memory({ [themeKey]: 'dark' })), 'dark')
  assert.equal(readTheme(() => memory()), 'system')
  assert.equal(readTheme(() => memory({ [themeKey]: 'sepia' })), 'system')
  assert.equal(parseTheme(undefined), 'system')
})

test('storage that is blocked, or throws on access, falls back to System', () => {
  assert.equal(readTheme(refusing), 'system')
  assert.equal(readTheme(() => {
    throw new Error('SecurityError: localStorage is not available')
  }), 'system')
  assert.equal(writeTheme(refusing, 'dark'), false)
  assert.equal(writeTheme(() => {
    throw new Error('SecurityError')
  }, 'light'), false)
})

test('choosing a theme stores it, and System removes the choice', () => {
  const storage = memory()
  assert.equal(writeTheme(() => storage, 'dark'), true)
  assert.equal(storage.items.get(themeKey), 'dark')
  assert.equal(readTheme(() => storage), 'dark')
  assert.equal(writeTheme(() => storage, 'system'), true)
  assert.equal(storage.items.has(themeKey), false)
})

// the classic script in each page's head, run as the browser would before the stylesheet
const earlyScript = async (page: string): Promise<string> => {
  const html = await readFile(join(import.meta.dirname, '..', 'public', page), 'utf8')
  const head = html.slice(0, html.indexOf('</head>'))
  const match = /<script>([\s\S]*?)<\/script>/.exec(head)
  assert.ok(match !== null, `${page} has an inline script in its head`)
  // it must come before the stylesheet, so the first paint already has the theme
  assert.ok(head.indexOf('<script>') < head.indexOf('/styles.css'), `${page} applies the theme before the stylesheet`)
  return match[1]!
}

const runEarly = (code: string, storage: () => ThemeStorage): { theme: string | undefined, scheme: string | undefined } => {
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> }
  const window = {}
  Object.defineProperty(window, 'localStorage', { get: storage })
  runInNewContext(code, { window, document: { documentElement: root } })
  return { theme: root.dataset.theme, scheme: root.style.colorScheme }
}

for (const page of ['index.html', 'settings.html']) {
  test(`${page} applies the stored theme before first paint, exactly as theme.ts reads it`, async () => {
    const code = await earlyScript(page)
    const cases: [string, () => ThemeStorage][] = [
      ['nothing stored', () => memory()],
      ['light', () => memory({ [themeKey]: 'light' })],
      ['dark', () => memory({ [themeKey]: 'dark' })],
      ['a stray value', () => memory({ [themeKey]: 'sepia' })],
      ['blocked storage', refusing],
      ['storage that throws on access', () => {
        throw new Error('SecurityError')
      }],
    ]
    for (const [name, storage] of cases) {
      const expected = readTheme(storage)
      assert.deepEqual(runEarly(code, storage), { theme: expected, scheme: colorSchemeOf(expected) }, name)
    }
  })
}
