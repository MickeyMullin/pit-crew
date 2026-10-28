// test/markdown.test.ts
// report text quotes other people's PRs, so it is hostile input: raw HTML is escaped, and a link
// or image URL with any scheme but http, https or mailto is dropped
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSafeUrl, renderMarkdown } from '../src/markdown.ts'

test('the Markdown a report actually uses renders as a body fragment', () => {
  const html = renderMarkdown('## Summary\n\n- **P1**\n  - Retry loop never backs off (src/retry.ts)\n\nA `code span` and a [link](https://example.test/a).\n\n```ts\nconst x = 1\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n')
  assert.match(html, /<h2>Summary<\/h2>/)
  assert.match(html, /<strong>P1<\/strong>/)
  assert.match(html, /<code>code span<\/code>/)
  assert.match(html, /<pre><code class="language-ts">/)
  assert.match(html, /<table>/)
  assert.match(html, /<a href="https:\/\/example\.test\/a" target="_blank" rel="noopener noreferrer nofollow">link<\/a>/)
  // a fragment, not a document
  assert.ok(!/<(html|head|body|!doctype)/i.test(html))
})

test('every link opens in a new tab with no opener, referrer or ranking credit', () => {
  const html = renderMarkdown('[a](https://example.test) <https://auto.example.test> [m](mailto:someone@example.test "to") https://bare.example.test/x')
  const anchors = html.match(/<a [^>]*>/g) ?? []
  assert.equal(anchors.length, 4)
  for (const anchor of anchors) {
    assert.match(anchor, /target="_blank"/)
    assert.match(anchor, /rel="noopener noreferrer nofollow"/)
  }
  assert.match(html, /title="to"/)
})

test('raw HTML, block and inline, leaves as text', () => {
  const block = renderMarkdown('before\n\n<script>alert(1)</script>\n\nafter')
  assert.ok(!block.includes('<script'))
  assert.match(block, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(block, /before/)
  assert.match(block, /after/)
  const inline = renderMarkdown('a <b onclick="alert(1)">bold</b> and <img src=x onerror=alert(1)> and <svg/onload=alert(1)>')
  for (const tag of ['<b ', '<b>', '<img', '<svg']) assert.ok(!inline.includes(tag), tag)
  assert.ok(!/<[a-z]+[^>]*\son[a-z]+\s*=/i.test(inline))
  assert.match(inline, /&lt;img src=x onerror=alert\(1\)&gt;/)
  for (const source of ['<iframe src="https://evil.test"></iframe>', '<style>*{display:none}</style>', '<base href="https://evil.test/">', '<meta http-equiv="refresh" content="0;url=https://evil.test">', '<a href="javascript:alert(1)">x</a>', '<!-- hidden --><div>y</div>']) {
    const html = renderMarkdown(source)
    assert.ok(!/<(iframe|style|base|meta|a|div)\b/i.test(html), source)
    assert.ok(html.includes('&lt;'), source)
  }
})

test('a javascript, vbscript or data link loses its anchor and keeps its words, however the scheme is spelled', () => {
  for (const source of [
    '[click](javascript:alert(1))',
    '[click](JaVaScRiPt:alert(1))',
    '[click](  javascript:alert(1))',
    '[click](javascript&#58;alert(1))',
    '[click](javascript&#x3a;alert(1))',
    '[click](javascript&colon;alert(1))',
    '[click](&#106;avascript:alert(1))',
    '[click](&#x6A;avascript:alert(1))',
    '[click](java&#9;script:alert(1))',
    '[click](java&Tab;script:alert(1))',
    '[click](java&NewLine;script:alert(1))',
    '[click](<java\tscript:alert(1)>)',
    '[click](<java\nscript:alert(1)>)',
    '[click](<jav\u0000ascript:alert(1)>)',
    '[click](<\u0001javascript:alert(1)>)',
    '[click](vbscript:msgbox(1))',
    '[click](data:text/html,<script>alert(1)</script>)',
    '[click](file:///etc/passwd)',
    '[click][ref]\n\n[ref]: javascript:alert(1)',
  ]) {
    const html = renderMarkdown(source)
    assert.match(html, /click/, source)
    assert.ok(!html.includes('<a '), source)
    assert.ok(!/javascript:|vbscript:|data:text|file:/i.test(html.replace(/&[a-z#0-9]+;/gi, '')), source)
  }
})

test('an image with an unsafe source renders as its alt text, and a safe one as an image', () => {
  for (const source of ['![boom](javascript:alert(1))', '![boom](java&#10;script:alert(1))', '![boom](data:image/svg+xml,<svg onload=alert(1)>)']) {
    const html = renderMarkdown(source)
    assert.ok(!html.includes('<img'), source)
    assert.match(html, /boom/)
  }
  assert.match(renderMarkdown('![shot](https://example.test/a.png "t")'), /<img src="https:\/\/example\.test\/a\.png" alt="shot" title="t" \/>/)
  // alt text and titles cannot break out of their attribute
  const quoted = renderMarkdown('![a" onerror="alert(1)](https://example.test/a.png "x\\" onload=\\"y")')
  assert.ok(!/\sonerror="/.test(quoted))
  assert.ok(!/\sonload="/.test(quoted))
})

test('http, https, mailto and relative destinations still link', () => {
  const html = renderMarkdown('[a](https://example.test) [b](http://example.test) [c](mailto:someone@example.test) [d](/tasks/5) [e](#anchor) [f](../up.md)')
  assert.equal((html.match(/<a /g) ?? []).length, 6)
  assert.deepEqual(['https://x.test', 'HTTP://x.test', 'mailto:a@b.test', '/x', '#y', 'a/b:c', 'x.md'].map(isSafeUrl), [true, true, true, true, true, true, true])
  assert.deepEqual(['javascript:1', ' java\tscript:1', 'java&#x9;script:1', 'data:text/html,x', 'ftp://x.test', 'tel:1'].map(isSafeUrl), [false, false, false, false, false, false])
})

test('an unsafe link keeps its formatted text, and text that only looks like a link stays text', () => {
  const html = renderMarkdown('[**bold** `code`](javascript:alert(1))')
  assert.match(html, /<strong>bold<\/strong> <code>code<\/code>/)
  assert.ok(!html.includes('<a '))
  assert.match(renderMarkdown('javascript:alert(1)'), /<p>javascript:alert\(1\)<\/p>/)
})
