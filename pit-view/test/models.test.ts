// test/models.test.ts
// the model registry and the per-command slots (section 1 of DESIGN.md, Configuration, the models key)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConfigError, defaultConfig, validateConfig } from '../src/config.ts'
import { builtInFallbackId, builtInRegistry, modelsSaveProblem, nameInText, resolveModels, resolveSlot, slotNames } from '../src/models.ts'

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
      { id: 'sonnet', runner: 'claude', provider: 'anthropic', model: 'haiku' },
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

test('nameInText finds a full id or slug and never a bare word', () => {
  const resolved = resolveModels(undefined)
  assert.equal(nameInText(resolved, 'Reviewed with gpt-6.1-terra today.'), 'gpt-6.1-terra')
  assert.equal(nameInText(resolved, 'run on MOONSHOTAI/KIMI-K2.7-CODE'), 'moonshotai/kimi-k2.7-code')
  assert.equal(nameInText(resolved, 'via ~deepseek/deepseek-flash-latest'), '~deepseek/deepseek-flash-latest')
  assert.equal(nameInText(resolved, 'via deepseek/deepseek-flash-latest'), 'deepseek/deepseek-flash-latest')
  assert.equal(nameInText(resolved, 'the qwen-coder-flash pass'), 'qwen-coder-flash')
  assert.equal(nameInText(resolved, 'a deepseek-flash note'), 'deepseek-flash')
  assert.equal(nameInText(resolved, 'kimi-code said so'), 'kimi-code')
  // bare words are ordinary prose
  assert.equal(nameInText(resolved, 'A magnum opus of a sonnet, nothing else.'), null)
  assert.equal(nameInText(resolved, 'The code is clean and the flash of insight is mine.'), null)
  assert.equal(nameInText(resolved, ''), null)
})

test('nameInText scans a custom registry and the built-in table both', () => {
  const resolved = resolveModels({ registry: [{ id: 'house-model', runner: 'hermes', provider: 'openrouter', model: 'vendor/house-x1' }] })
  assert.equal(nameInText(resolved, 'by house-model'), 'house-model')
  assert.equal(nameInText(resolved, 'by vendor/house-x1'), 'vendor/house-x1')
  // a name the owner removed from the registry is still a name Pit View knows, so it is never posted
  assert.equal(nameInText(resolved, 'by gpt-6.1-sol'), 'gpt-6.1-sol')
})
