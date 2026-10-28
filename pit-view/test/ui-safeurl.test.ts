// test/ui-safeurl.test.ts
// the page links to a server-supplied string only when it is an absolute http or https URL
// (public/safeurl.ts), and every place in public/ that turns such a string into an href or src
// goes through it
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { safeHref, safeImage } from '../public/safeurl.ts'

test('only absolute http and https URLs become links, in their parsed form', () => {
  assert.equal(safeHref('https://github.com/octo-example/orbit/pull/101'), 'https://github.com/octo-example/orbit/pull/101')
  assert.equal(safeHref('http://example.test'), 'http://example.test/')
  assert.equal(safeHref('HTTPS://Example.test/a b'.replace(' ', '%20')), 'https://example.test/a%20b')
  const hostile = [
    'javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' javascript:alert(1)', 'javascript:alert(1) ', 'java\tscript:alert(1)', 'java\nscript:alert(1)',
    'java&#115;cript:alert(1)', 'javascript&colon;alert(1)', '&#106;avascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:x',
    'file:///etc/passwd', 'mailto:a@example.test', '//example.test/x', '/pull/101', 'pull/101', '#top', '', '   ', 'https://', 'https://example.test/ x',
    null, undefined, 7, {}, [],
  ]
  for (const value of hostile) assert.equal(safeHref(value), null, JSON.stringify(value))
})

test('an image source may also be this server\'s own avatar endpoint', () => {
  assert.equal(safeImage('/api/avatar/alex-mendez'), '/api/avatar/alex-mendez')
  assert.equal(safeImage('https://avatars.example.test/u/1'), 'https://avatars.example.test/u/1')
  assert.equal(safeImage('/api/config'), null)
  assert.equal(safeImage('/api/avatar/../config?x'), null)
  assert.equal(safeImage('javascript:alert(1)'), null)
  assert.equal(safeImage(null), null)
})

// every href or src that public/ sets from a variable passes through safeHref or safeImage; a
// literal ('#', or a path built from this app's own routes) is the only other thing allowed
test('every href and src built in public/ from a value is checked', async () => {
  const dir = join(import.meta.dirname, '..', 'public')
  const loose: string[] = []
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.ts'))) {
    const lines = (await readFile(join(dir, name), 'utf8')).split('\n')
    lines.forEach((line, index) => {
      for (const [, attribute, value] of line.matchAll(/\b(href|src): ([^,}]+)/g)) {
        const text = (value ?? '').trim()
        // fact.href is the drawer model's, already checked there (ui-drawer.test.ts)
        if (/^safeHref\(|^safeImage\(|^source\b|^href\b|^null\b|^string \| null|^fact\.href\b|^[`']([#/]|[^`'$]*\/api\/)/.test(text)) continue
        loose.push(`${name}:${index + 1} ${attribute}: ${text}`)
      }
    })
  }
  assert.deepEqual(loose, [])
})
