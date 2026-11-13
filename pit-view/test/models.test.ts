// test/models.test.ts
// the model registry and the per-command slots (section 1 of DESIGN.md, Configuration, the models key)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConfigError, defaultConfig, validateConfig } from '../src/config.ts'
import { builtInFallbackId, builtInRegistry, projectModels, modelsSaveProblem, modelsView, nameInText, postedTextTerms, resolveModels, resolveSlot, slotNames, slugProblem } from '../src/models.ts'

const ids = (entries: readonly { id: string }[]): string[] => entries.map((entry) => entry.id)

test('a missing models setting resolves to the built-in table, with no warning', () => {
  const resolved = resolveModels(undefined)
  assert.deepEqual(ids(resolved.registry), ['sonnet', 'opus', 'gpt-6.1-terra', 'gpt-6.1-sol', 'deepseek-flash', 'kimi-code', 'qwen-coder-flash'])
  assert.deepEqual(resolved.warnings, [])
  assert.equal(resolved.fallback.id, 'kimi-code')
  assert.equal(builtInFallbackId, 'kimi-code')
  assert.deepEqual(builtInRegistry.find((entry) => entry.id === 'gpt-6.1-sol'), { id: 'gpt-6.1-sol', runner: 'codex', provider: 'openai', model: 'gpt-6.1-sol' })
  assert.deepEqual(builtInRegistry.find((entry) => entry.id === 'kimi-code'), { id: 'kimi-code', runner: 'hermes', provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code' })
  assert.deepEqual(builtInRegistry.find((entry) => entry.id === 'deepseek-flash')?.model, '~deepseek/deepseek-flash-latest')
  assert.deepEqual(builtInRegistry.find((entry) => entry.id === 'qwen-coder-flash')?.model, 'qwen/qwen3-coder-flash')
  // there is no Codex default entry: every Codex entry names its model, passed as -m
  assert.ok(builtInRegistry.filter((entry) => entry.runner === 'codex').every((entry) => entry.model !== ''))
})

test('a misconfigured registry falls back to the built-in table and says so', () => {
  for (const bad of [{ registry: 'sonnet' }, { registry: {} }, { registry: [] }, { registry: [{ id: 'x' }] }, 'nonsense', [], 7]) {
    const resolved = resolveModels(bad)
    assert.deepEqual(ids(resolved.registry), ids(builtInRegistry), JSON.stringify(bad))
    assert.ok(resolved.warnings.length > 0, JSON.stringify(bad))
  }
})

test('one bad entry drops only that entry', () => {
  const resolved = resolveModels({
    registry: [
      { id: 'sonnet', runner: 'claude', provider: 'anthropic', model: 'sonnet' },
      { id: 'bad-space', runner: 'claude', provider: 'anthropic', model: 'two words' },
      { id: 'bad-dash', runner: 'codex', provider: 'openai', model: '-m' },
      { id: 'bad-runner', runner: 'gemini', provider: 'google', model: 'gemini-x' },
      { id: 'gpt-6.1-terra', runner: 'codex', provider: 'openai', model: 'gpt-6.1-terra' },
      { id: 'gpt-6.1-terra', runner: 'codex', provider: 'openai', model: 'gpt-6.1-terra' },
    ],
  })
  assert.deepEqual(ids(resolved.registry), ['sonnet', 'gpt-6.1-terra'])
  assert.equal(resolved.warnings.length, 4)
  assert.ok(resolved.warnings.some((warning) => warning.includes('bad-space')))
  assert.ok(resolved.warnings.some((warning) => warning.includes('bad-dash')))
  assert.ok(resolved.warnings.some((warning) => warning.includes('bad-runner')))
  assert.ok(resolved.warnings.some((warning) => warning.includes('twice')))
})

test('every slot defaults to sonnet, and a pair to sonnet then gpt-6.1-terra', () => {
  const { slots } = resolveModels(undefined)
  assert.deepEqual([...slotNames], ['review', 'stack', 'sweep', 'autoReviewHuman', 'autoReviewBot'])
  assert.deepEqual(slots.review.map((entry) => entry.id), ['sonnet', 'gpt-6.1-terra'])
  assert.deepEqual(slots.autoReviewHuman.map((entry) => entry.id), ['sonnet', 'gpt-6.1-terra'])
  assert.equal(slots.stack.id, 'sonnet')
  assert.equal(slots.sweep.id, 'sonnet')
  assert.equal(slots.autoReviewBot.id, 'sonnet')
})

test('review and autoReviewHuman hold a pair; stack, sweep, and autoReviewBot hold one model; the two auto slots are separate', () => {
  const resolved = resolveModels({ slots: { review: ['opus', 'gpt-6.1-sol'], stack: 'opus', sweep: 'deepseek-flash', autoReviewHuman: ['kimi-code', 'sonnet'], autoReviewBot: 'sonnet' } })
  assert.deepEqual(resolved.warnings, [])
  assert.deepEqual(resolved.slots.review.map((entry) => entry.id), ['opus', 'gpt-6.1-sol'])
  assert.equal(resolved.slots.stack.id, 'opus')
  assert.equal(resolved.slots.sweep.id, 'deepseek-flash')
  assert.deepEqual(resolved.slots.autoReviewHuman.map((entry) => entry.id), ['kimi-code', 'sonnet'])
  assert.equal(resolved.slots.autoReviewBot.id, 'sonnet')
  // a pair slot given one model, or a single slot given a pair, is misconfigured: the default stands and a warning says which slot
  const wrong = resolveModels({ slots: { review: 'opus', stack: ['opus', 'sonnet'] } })
  assert.deepEqual(wrong.slots.review.map((entry) => entry.id), ['sonnet', 'gpt-6.1-terra'])
  assert.equal(wrong.slots.stack.id, 'sonnet')
  assert.equal(wrong.warnings.length, 2)
  assert.ok(wrong.warnings[0]?.includes('review'))
  assert.ok(wrong.warnings[1]?.includes('stack'))
})

test('a slot naming an unknown id uses its built-in default and warns; the other slots are untouched', () => {
  const resolved = resolveModels({ slots: { review: ['opus', 'no-such-model'], sweep: 'ghost', stack: 'opus' } })
  assert.deepEqual(resolved.slots.review.map((entry) => entry.id), ['opus', 'gpt-6.1-terra'])
  assert.equal(resolved.slots.sweep.id, 'sonnet')
  assert.equal(resolved.slots.stack.id, 'opus')
  assert.equal(resolved.warnings.length, 2)
  assert.ok(resolved.warnings.some((warning) => warning.includes('review') && warning.includes('no-such-model')))
  assert.ok(resolved.warnings.some((warning) => warning.includes('sweep') && warning.includes('ghost')))
})

test('a slot that names an id the owner removed from a custom registry falls back, and the pinned fallback is read from the registry or the built-in entry', () => {
  const resolved = resolveModels({ registry: [{ id: 'opus', runner: 'claude', provider: 'anthropic', model: 'opus' }], slots: { stack: 'sonnet' } })
  // sonnet is no longer in the registry, so the built-in default for the slot cannot be resolved from it: the built-in entry stands in
  assert.equal(resolved.slots.stack.id, 'sonnet')
  assert.equal(resolved.fallback.id, 'kimi-code')
  assert.equal(resolved.fallback.model, 'moonshotai/kimi-k2.7-code')
  assert.ok(resolved.warnings.length >= 1)
  const pinned = resolveModels({ registry: [{ id: 'opus', runner: 'claude', provider: 'anthropic', model: 'opus' }, { id: 'mine', runner: 'hermes', provider: 'openrouter', model: 'vendor/model-x' }], fallback: 'mine' })
  assert.equal(pinned.fallback.id, 'mine')
})

test('resolution order is the per-run override, then the slot, then the built-in default', () => {
  const resolved = resolveModels({ slots: { stack: 'opus', review: ['opus', 'gpt-6.1-sol'] } })
  assert.equal(resolveSlot(resolved, 'stack').id, 'opus')
  assert.equal(resolveSlot(resolved, 'stack', 'deepseek-flash').id, 'deepseek-flash')
  // an override that is not in the registry is ignored: the slot stands
  assert.equal(resolveSlot(resolved, 'stack', 'ghost').id, 'opus')
  assert.equal(resolveSlot(resolved, 'sweep').id, 'sonnet')
  const pair = resolveSlot(resolved, 'review', ['gpt-6.1-terra'])
  assert.deepEqual(pair.map((entry) => entry.id), ['gpt-6.1-terra', 'gpt-6.1-sol'])
})

test('a slug is refused on save with a space or a leading dash, and an id too', () => {
  const entry = (patch: Record<string, string>) => ({ models: { registry: [{ id: 'x', runner: 'hermes', provider: 'openrouter', model: 'vendor/model', ...patch }] } })
  assert.equal(modelsSaveProblem(entry({}).models), null)
  assert.match(modelsSaveProblem(entry({ model: 'vendor/model x' }).models) ?? '', /no spaces/)
  assert.match(modelsSaveProblem(entry({ model: '-m' }).models) ?? '', /dash/)
  assert.match(modelsSaveProblem(entry({ model: '' }).models) ?? '', /model/)
  assert.match(modelsSaveProblem(entry({ id: 'two words' }).models) ?? '', /id/)
  assert.match(modelsSaveProblem(entry({ runner: 'gemini' }).models) ?? '', /runner/)
  assert.match(modelsSaveProblem({ registry: 'sonnet' }) ?? '', /list/)
  assert.equal(modelsSaveProblem(undefined), null)
  // an unknown slot id is a warning in Settings, never a refusal
  assert.equal(modelsSaveProblem({ slots: { stack: 'ghost' } }), null)
})

test('the models key is carried through validateConfig whole, and a bad one never stops the config from loading', () => {
  const base = defaultConfig()
  assert.equal(validateConfig(base).models, undefined)
  const models = { registry: [{ id: 'mine', runner: 'hermes', provider: 'openrouter', model: 'vendor/model-x' }], slots: { stack: 'mine' } }
  assert.deepEqual(validateConfig({ ...base, models }).models, models)
  // a read tolerates what a save refuses
  assert.doesNotThrow(() => validateConfig({ ...base, models: { registry: [{ id: 'x', runner: 'claude', provider: 'anthropic', model: 'a b' }] } }))
  assert.throws(() => validateConfig({ ...base, notAKey: 1 }), ConfigError)
})

test('nameInText finds a full id or slug and the plain model words, and where it is', () => {
  const resolved = resolveModels(undefined)
  const found = (text: string): string | null => nameInText(resolved, text)?.term ?? null
  assert.equal(found('Reviewed with gpt-6.1-terra today.'), 'gpt-6.1-terra')
  assert.equal(found('run on MOONSHOTAI/KIMI-K2.7-CODE'), 'moonshotai/kimi-k2.7-code')
  // the leading ~ of a slug is optional, and a tilde is also Markdown's strikethrough marker, so the name is found without it
  assert.equal(found('via ~deepseek/deepseek-flash-latest'), 'deepseek/deepseek-flash-latest')
  assert.equal(found('via deepseek/deepseek-flash-latest'), 'deepseek/deepseek-flash-latest')
  assert.equal(found('the qwen-coder-flash pass'), 'qwen-coder-flash')
  assert.equal(found('a deepseek-flash note'), 'deepseek-flash')
  assert.equal(found('kimi-code said so'), 'kimi-code')
  // the plain words are model names too
  assert.equal(found('A magnum opus of a pass.'), 'opus')
  assert.equal(found('Sonnet agreed.'), 'sonnet')
  assert.equal(found('The code is clean and the flash of insight is mine.'), null)
  assert.equal(found(''), null)
  // the first match in the text wins, and the context is the text around it, at most 60 characters
  const long = `${'x '.repeat(100)}then Claude said ${'y '.repeat(100)}`
  const hit = nameInText(resolved, long)
  assert.equal(hit?.term, 'claude')
  assert.ok(hit !== null && hit.context.includes('Claude') && hit.context.replace(/…/g, '').length <= 60)
  assert.equal(nameInText(resolved, 'opus then claude')?.term, 'opus')
})

test('every entry of the exported term list is matched, and every near miss passes', () => {
  const resolved = resolveModels(undefined)
  assert.ok(postedTextTerms.length > 30)
  for (const entry of postedTextTerms) {
    const hit = nameInText(resolved, `Some prose, then ${entry.term}, then more prose.`)
    assert.equal(hit?.term, entry.term, entry.term)
    // case and surrounding punctuation do not matter
    assert.equal(nameInText(resolved, `(${entry.term.toUpperCase()}).`)?.term, entry.term, entry.term)
  }
  for (const text of ['claudette', 'okimi', 'opusculum', 'AIM', 'said', 'paid', 'again', 'hermeslike', 'the agent retried', 'a GitHub Copilot review of the other PR', 'Copilot suggests a rename', 'maintain', 'geminis', 'grokking', 'degrade', 'consolidated', 'reassistant', 'autonomy']) {
    assert.equal(nameInText(resolved, text), null, text)
  }
  for (const [text, term] of [['written by hand', 'written by'], ['GPT-5.2 wrote it', 'gpt'], ['gpt4 did', 'gpt'], ['an A.I. tool', 'a.i.'], ['the LLMs', 'llms'], ['a language model', 'language model'], ['Language   Model', 'language model']] as const) {
    assert.equal(nameInText(resolved, text)?.term, term, text)
  }
})

test('nameInText scans a custom registry and the built-in table both', () => {
  const resolved = resolveModels({ registry: [{ id: 'house-model', runner: 'hermes', provider: 'openrouter', model: 'vendor/house-x1' }] })
  assert.equal(nameInText(resolved, 'by house-model')?.term, 'house-model')
  assert.equal(nameInText(resolved, 'by vendor/house-x1')?.term, 'vendor/house-x1')
  // a name the owner removed from the registry is still a name Pit View knows, so it is never posted
  assert.equal(nameInText(resolved, 'by gpt-6.1-sol')?.term, 'gpt-6.1-sol')
})

// what a rendered or obfuscated report still says: the scan reads the literal text and a normalized form of it
test('nameInText reads past entities, invisible characters, Markdown markers, link syntax, and width forms', () => {
  const resolved = resolveModels(undefined)
  const cases: [string, string][] = [
    ['Cla&#117;de agreed', 'claude'],
    ['Cla&#x75;de agreed', 'claude'],
    ['Cla&#X75;de agreed', 'claude'],
    ['Cla&#117de agreed', 'claude'],
    ['C&#108;&#97;ude agreed', 'claude'],
    ['Clau&amp;#100;e agreed', 'claude'],
    ['Clau&zwj;de agreed', 'claude'],
    ['Clau**de** agreed', 'claude'],
    ['Cl_au_de agreed', 'claude'],
    ['Clau~~d~~e agreed', 'claude'],
    ['Clau\u200bde agreed', 'claude'],
    ['Clau\u200c\u200d\u200e\u200fde agreed', 'claude'],
    ['Clau\u2060de agreed', 'claude'],
    ['Clau\ufeffde agreed', 'claude'],
    ['Clau\u00adde agreed', 'claude'],
    ['Clau\u202ede agreed', 'claude'],
    ['Clau\u2066de agreed', 'claude'],
    ['`claude` agreed', 'claude'],
    ['``claude`` agreed', 'claude'],
    ['[claude](http://x.example) agreed', 'claude'],
    ['![claude](http://x.example/a.png) agreed', 'claude'],
    ['[Clau](http://a.example)[de](http://b.example) agreed', 'claude'],
    ['see [this](https://claude.example/page)', 'claude'],
    ['\uff23\uff4c\uff41\uff55\uff44\uff45 agreed', 'claude'],
    ['a tandem pass', 'tandem'],
    ['Tandem mode found nothing', 'tandem'],
    ['a  language\u200b   model', 'language model'],
    ['&#71;PT-5 wrote this', 'gpt'],
  ]
  for (const [text, term] of cases) assert.equal(nameInText(resolved, text)?.term, term, text)
  // the context comes from the normalized text, so it shows the name as it renders
  const hit = nameInText(resolved, 'Some words, then Cla&#117;de and **more**.')
  assert.ok(hit?.context.includes('Claude'), String(hit?.context))
  // an entity that is not a letter of a name, and plain punctuation, do not make a hit
  for (const text of ['Fish &amp; chips &lt;b&gt; &quot;x&quot;', 'Clau&#32;de is two words', 'a [link](http://x.example/docs) and **bold** and `code`', 'snake_case_name and ~~struck~~', '&#99999999999; and &#0;', 'AIM &amp;said']) {
    assert.equal(nameInText(resolved, text), null, text)
  }
  // the near misses still pass in their normalized form
  for (const text of ['**claudette**', '`okimi`', '[hermeslike](http://x.example)', '&#65;IM', 'the agent said', 'Copilot']) assert.equal(nameInText(resolved, text), null, text)
})

test('the review-mode word tandem is refused as a whole word anywhere, and nothing near it is', () => {
  const resolved = resolveModels(undefined)
  for (const text of ['tandem', 'In tandem.', '(Tandem)', 'a tandem pass', 'tandem-mode']) assert.equal(nameInText(resolved, text)?.term, 'tandem', text)
  for (const text of ['tandems', 'tandemly', 'autotandem']) assert.equal(nameInText(resolved, text), null, text)
  assert.ok(postedTextTerms.some((entry) => entry.term === 'tandem' && entry.kind === 'reviewMode'))
})

test('the scan of a 1 MB report is linear: hostile runs of markers, brackets, entities, spaces, and digits finish quickly', () => {
  const resolved = resolveModels(undefined)
  const mb = 1024 * 1024
  const hostile = ['[', '](', '*', '_', '&#', '&', ' ', '\u200b', 'language ', 'gpt1', '(', ')\n[', '&amp', 'x'].map((unit) => unit.repeat(Math.ceil(mb / unit.length)).slice(0, mb))
  hostile.push(`${'language'}${' '.repeat(mb)}x`, `gpt${'1'.repeat(mb)}x`, `[${'a'.repeat(mb)}`, `${'[a]('.repeat(mb / 4)}`, `${'ab cd '.repeat(mb / 6)}`)
  for (const text of hostile) {
    const started = performance.now()
    nameInText(resolved, text)
    assert.ok(performance.now() - started < 3000, `${text.slice(0, 20)} took ${Math.round(performance.now() - started)} ms`)
  }
  // a hit at the very end of a large clean report is still found
  const started = performance.now()
  assert.equal(nameInText(resolved, `${'Plain review prose. '.repeat(mb / 20)}Cla&#117;de`)?.term, 'claude')
  assert.ok(performance.now() - started < 3000)
})

// a custom entry never changes what a built-in id means, so the built-in fallback is read from the built-in table only
test('an unknown slot id takes the built-in default even when a custom entry reuses the built-in id with another runner', () => {
  const custom = { id: 'sonnet', runner: 'codex', provider: 'openai', model: 'gpt-x' }
  const resolved = resolveModels({ registry: [custom, { id: 'house', runner: 'claude', provider: 'anthropic', model: 'house-1' }], slots: { stack: 'ghost', sweep: 'house' } })
  assert.deepEqual(resolved.slots.stack, builtInRegistry.find((entry) => entry.id === 'sonnet'))
  assert.equal(resolved.slots.stack.runner, 'claude')
  assert.equal(resolved.slots.sweep.id, 'house')
  assert.ok(resolved.warnings.some((line) => /sonnet.*built-in/.test(line)), resolved.warnings.join(' | '))
  assert.ok(resolved.warnings.some((line) => /stack.*ghost/.test(line)))
  assert.ok(!resolved.registry.some((entry) => entry.id === 'sonnet'))
  // a slot that names the built-in id the registry no longer lists reads the built-in entry, never the custom one
  assert.deepEqual(resolved.slots.autoReviewBot, builtInRegistry[0])
  assert.deepEqual(resolved.slots.review[1], builtInRegistry[2])
  // alone in the registry, the custom entry is set aside and the built-in table stands
  const alone = resolveModels({ registry: [custom], slots: { stack: 'ghost' } })
  assert.deepEqual(alone.slots.stack, builtInRegistry[0])
  assert.deepEqual(alone.registry, [...builtInRegistry])
  // the pinned fallback is the built-in one when a custom entry reuses its id
  const fallback = resolveModels({ registry: [{ id: 'kimi-code', runner: 'claude', provider: 'anthropic', model: 'other' }, { id: 'house', runner: 'claude', provider: 'anthropic', model: 'house-1' }] })
  assert.deepEqual(fallback.fallback, builtInRegistry.find((entry) => entry.id === 'kimi-code'))
  assert.deepEqual(modelsView({ registry: [custom], slots: { stack: 'ghost' } }).slots.stack, 'sonnet')
})

test('a custom entry may restate a built-in entry exactly, and may not reuse a built-in id with anything else; a save refuses it by name', () => {
  const restated = builtInRegistry.find((entry) => entry.id === 'opus')
  const resolved = resolveModels({ registry: [restated, { id: 'house', runner: 'claude', provider: 'anthropic', model: 'house-1' }] })
  assert.deepEqual(ids(resolved.registry), ['opus', 'house'])
  assert.deepEqual(resolved.warnings, [])
  for (const changed of [{ ...restated, runner: 'codex' }, { ...restated, model: 'other' }, { ...restated, provider: 'elsewhere' }]) {
    const problem = modelsSaveProblem({ registry: [changed] })
    assert.match(problem ?? '', /models\.registry\[0\] \(opus\).*built-in/)
  }
  assert.equal(modelsSaveProblem({ registry: [restated] }), null)
})

test('a registry entry is projected to its known fields on read and in the effective view, and a save names a credential-like field', () => {
  const entry = { id: 'house', runner: 'claude', provider: 'anthropic', model: 'house-1' }
  const resolved = resolveModels({ registry: [{ ...entry, apiKey: 'sk-live', note: 'x' }] })
  assert.deepEqual(resolved.registry, [entry])
  // the stored config drops every unknown field, on a read and on a save
  const base = defaultConfig()
  const projected = validateConfig({ ...base, models: { registry: [{ ...entry, apiKey: 'sk-live', extra: 1, token: 't' }], slots: { stack: 'house' }, secret: 'x' } }).models
  assert.deepEqual(projected, { registry: [entry], slots: { stack: 'house' } })
  assert.doesNotMatch(JSON.stringify(projected), /sk-live|apiKey|token|secret/)
  // an entry that is not an object is dropped on a read, and a bad field value of an object is left for the check to name
  assert.deepEqual(validateConfig({ ...base, models: { registry: ['x', { ...entry, model: 'a b', junk: 1 }] } }).models, { registry: [{ ...entry, model: 'a b' }] })
  for (const name of ['key', 'apiKey', 'api_key', 'API_KEY', 'secret', 'clientSecret', 'token', 'accessToken', 'password', 'Authorization', 'bearer', 'credential', 'credentials']) {
    const problem = modelsSaveProblem({ registry: [{ ...entry, [name]: 'x' }] })
    assert.match(problem ?? '', new RegExp(`models\\.registry\\[0\\]\\.${name}`), name)
    assert.match(problem ?? '', /credential/i)
  }
  // an ordinary unknown field is dropped without a refusal
  assert.equal(modelsSaveProblem({ registry: [{ ...entry, note: 'x' }] }), null)
  assert.match(modelsSaveProblem({ registry: [entry], apiKey: 'x' }) ?? '', /models\.apiKey/)
})

test('projectModels is a strict allowlist of shapes: nested credential data in a slot, the fallback, or an entry never survives a read', () => {
  const entry = { id: 'house', runner: 'claude', provider: 'anthropic', model: 'house-1' }
  const base = defaultConfig()
  const projectedOf = (models: unknown): unknown => validateConfig({ ...base, models }).models
  // the review's probe
  assert.deepEqual(projectedOf({ slots: { stack: { apiKey: 'example-secret' } } }), { slots: {} })
  assert.deepEqual(projectedOf({ slots: { review: { apiKey: 'x' }, sweep: 5, autoReviewBot: ['a'], autoReviewHuman: ['a', 'b', 'c'], stack: ['a', 'b'], extra: 'x' } }), { slots: {} })
  assert.deepEqual(projectedOf({ slots: { review: ['opus', { token: 'x' }], sweep: 'opus' } }), { slots: { sweep: 'opus' } })
  assert.deepEqual(projectedOf({ slots: { review: ['opus', 'sonnet'], stack: 'opus', autoReviewHuman: 'opus' } }), { slots: { review: ['opus', 'sonnet'], stack: 'opus', autoReviewHuman: 'opus' } })
  assert.deepEqual(projectedOf({ fallback: { secret: 'x' } }), {})
  assert.deepEqual(projectedOf({ fallback: 'opus' }), { fallback: 'opus' })
  assert.deepEqual(projectedOf({ slots: ['x'] }), {})
  assert.deepEqual(projectedOf({ registry: { apiKey: 'x' } }), {})
  assert.deepEqual(projectedOf({ registry: [entry, 'x', ['y'], null, { ...entry, id: { nested: { apiKey: 'x' } }, model: 7, provider: 'x'.repeat(500) }] }), { registry: [entry, { runner: 'claude' }] })
  assert.doesNotMatch(JSON.stringify(projectModels({ slots: { stack: { apiKey: 'example-secret' } }, fallback: { token: 'z' }, registry: [{ ...entry, id: { client_secret: 'q' } }] })), /example-secret|apiKey|token|client_secret/)
})

test('a save refuses a credential-like key at any depth, in any spelling, and a prototype-pollution key, naming the path and the key and never the value', () => {
  const names = ['apiKey', 'api_key', 'API-KEY', 'x-api-key', 'Authorization', 'client_secret', 'accessToken', 'pass_word', 'passwd', 'Bearer', 'my credentials', 'Cookie', 'sessionId']
  for (const name of names) {
    for (const value of [
      { slots: { stack: { [name]: 'leak-value' } } },
      { registry: [{ id: 'a', runner: 'claude', provider: 'x', model: 'm', [name]: 'leak-value' }] },
      { fallback: { deep: [{ more: { [name]: 'leak-value' } }] } },
      { slots: { review: ['a', { [name]: 'leak-value' }] } },
      { [name]: { nested: 1 } },
    ]) {
      const problem = modelsSaveProblem(value)
      assert.ok(problem !== null, `${name} ${JSON.stringify(value)}`)
      assert.ok(problem.includes(name), problem)
      assert.match(problem, /^models/)
      assert.doesNotMatch(problem, /leak-value/)
    }
  }
  assert.match(modelsSaveProblem({ slots: { stack: { apiKey: 'x' } } }) ?? '', /models\.slots\.stack\.apiKey/)
  assert.match(modelsSaveProblem({ registry: [{ id: 'a', deep: [{ x: { token: 1 } }] }] }) ?? '', /models\.registry\[0\]\.deep\[0\]\.x\.token/)
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const problem = modelsSaveProblem(JSON.parse(`{"slots":{"stack":{"${key}":{"x":1}}}}`))
    assert.ok(problem?.includes(key), String(problem))
    assert.match(modelsSaveProblem(JSON.parse(`{"${key}":1}`)) ?? '', new RegExp(key))
  }
  // ordinary keys and the real fields pass
  assert.equal(modelsSaveProblem({ registry: [{ id: 'a', runner: 'claude', provider: 'x', model: 'm', note: 'n' }], fallback: 'a', slots: { review: ['a', 'a'], stack: 'a' } }), null)
})

test('a save refuses a value of the wrong shape, naming the path and never the value', () => {
  const cases: [unknown, RegExp][] = [
    [{ slots: { stack: { harmless: 'v' } } }, /models\.slots\.stack/],
    [{ slots: { stack: 5 } }, /models\.slots\.stack/],
    [{ slots: { sweep: ['a', 'b'] } }, /models\.slots\.sweep/],
    [{ slots: { review: ['a'] } }, /models\.slots\.review/],
    [{ slots: { review: ['a', 3] } }, /models\.slots\.review/],
    [{ slots: { autoReviewHuman: { a: 1 } } }, /models\.slots\.autoReviewHuman/],
    [{ slots: [] }, /models\.slots/],
    [{ slots: 'x' }, /models\.slots/],
    [{ fallback: { a: 1 } }, /models\.fallback/],
    [{ fallback: 4 }, /models\.fallback/],
    [{ slots: { stack: 'x'.repeat(300) } }, /models\.slots\.stack/],
  ]
  for (const [value, path] of cases) {
    const problem = modelsSaveProblem(value)
    assert.match(problem ?? '', path, JSON.stringify(value))
    assert.doesNotMatch(problem ?? '', /xxxxxxxxxx/)
  }
})

test('the scan refuses a provider named in the registry or the built-in table, and a runner, but not a short or generic one', () => {
  const entry = { id: 'house', runner: 'hermes', provider: 'newvendor', model: 'vendor/model-x' }
  const resolved = resolveModels({ registry: [entry, { id: 'loc', runner: 'claude', provider: 'local', model: 'loc-1' }, { id: 'short-one', runner: 'claude', provider: 'ab', model: 'short-1' }] })
  assert.equal(nameInText(resolved, 'review by NewVendor')?.term, 'newvendor')
  assert.equal(nameInText(resolved, 'review by NEWVENDOR.')?.term, 'newvendor')
  for (const provider of ['openrouter', 'moonshotai', 'qwen', 'deepseek', 'anthropic', 'openai']) assert.equal(nameInText(resolveModels(undefined), `served by ${provider}`)?.term, provider)
  assert.equal(nameInText(resolved, 'a local fix and ab test, newvendors too, a new vendor'), null)
  // a provider the owner removed from the registry is still refused, from the built-in table
  assert.equal(nameInText(resolveModels({ registry: [{ id: 'z', runner: 'claude', provider: 'zeta', model: 'z-1' }] }), 'moonshotai route')?.term, 'moonshotai')
})

test('the refusal context is at most 60 characters even when the match alone is longer', () => {
  const slug = `vendor/${'a'.repeat(193)}`
  assert.equal(slugProblem(slug), null)
  const resolved = resolveModels({ registry: [{ id: 'house', runner: 'hermes', provider: 'openrouter', model: slug }] })
  const hit = nameInText(resolved, `before ${slug} after`)
  assert.equal(hit?.term, slug)
  assert.ok(hit !== null && hit.context.length <= 60, String(hit?.context.length))
  assert.match(hit?.context ?? '', /…/)
  const sized = nameInText(resolved, `${'x '.repeat(100)}${slug}${' y'.repeat(100)}`)
  assert.ok(sized !== null && sized.context.length <= 60)
})
