// src/models.ts
// the model registry and the per-command slots (section 1 of DESIGN.md, Configuration, the models key). Pure functions of the owner's setting: nothing here reads a file, a key, or a spend figure, and an entry never carries one

// the agents a registry entry can run under; hermes entries are stored and shown, but no launch uses one until the Hermes runner exists
export type ModelRunner = 'claude' | 'codex' | 'hermes'
export const modelRunners: readonly ModelRunner[] = ['claude', 'codex', 'hermes']

// id is what a slot names; provider and model are what the runner is told (a Claude alias, a Codex -m name, or an OpenRouter slug)
export type ModelEntry = { id: string, runner: ModelRunner, provider: string, model: string }

// the table used when the owner's setting is missing or misconfigured. There is no Codex default entry: each Codex entry names its model, which is passed as -m
export const builtInRegistry: readonly ModelEntry[] = [
  { id: 'sonnet', runner: 'claude', provider: 'anthropic', model: 'sonnet' },
  { id: 'opus', runner: 'claude', provider: 'anthropic', model: 'opus' },
  { id: 'gpt-6.1-terra', runner: 'codex', provider: 'openai', model: 'gpt-6.1-terra' },
  { id: 'gpt-6.1-sol', runner: 'codex', provider: 'openai', model: 'gpt-6.1-sol' },
  { id: 'deepseek-flash', runner: 'hermes', provider: 'openrouter', model: '~deepseek/deepseek-flash-latest' },
  { id: 'kimi-code', runner: 'hermes', provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code' },
  { id: 'qwen-coder-flash', runner: 'hermes', provider: 'openrouter', model: 'qwen/qwen3-coder-flash' },
]

// the pinned fallback: a reviewer that fails is retried once on it, and its cost is bounded by the quotas that gate unattended auto-reviews
export const builtInFallbackId = 'kimi-code'

export const slotNames = ['review', 'stack', 'sweep', 'autoReviewHuman', 'autoReviewBot'] as const
export type SlotName = typeof slotNames[number]

// review and autoReviewHuman hold a pair (primary, then secondary); the others hold one model
export const pairSlotNames = ['review', 'autoReviewHuman'] as const
export type PairSlotName = typeof pairSlotNames[number]
const isPairSlot = (slot: SlotName): slot is PairSlotName => (pairSlotNames as readonly string[]).includes(slot)

export type SlotValue<S extends SlotName> = S extends PairSlotName ? [ModelEntry, ModelEntry] : ModelEntry

const defaultPair: readonly [string, string] = ['sonnet', 'gpt-6.1-terra']
const defaultOne = 'sonnet'

export type ResolvedModels = {
  registry: ModelEntry[]
  fallback: ModelEntry
  slots: { [S in SlotName]: SlotValue<S> }
  // what Settings shows: one line for each part of the setting that was set aside
  warnings: string[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// a model name as a runner is handed it: never empty, never with whitespace or a control character, and never starting with a dash that a command line would read as a flag
export const slugProblem = (model: unknown): string | null => {
  if (typeof model !== 'string' || model === '') return 'model must be a name such as sonnet or vendor/model-name, and not empty'
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(model)) return 'model must have no spaces or control characters'
  if (model.startsWith('-')) return 'model must not start with a dash'
  return model.length > 200 ? 'model must be at most 200 characters' : null
}

const labelPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

// the fields an entry and the models setting hold; anything else is dropped on a read and on a save
const entryFields = ['id', 'runner', 'provider', 'model'] as const
const modelsKeys = ['registry', 'fallback', 'slots'] as const

// a key that looks like a credential: matched after lowercasing it and removing every character that is not a letter or a digit, so apiKey, api_key, API-KEY, x-api-key, client_secret, accessToken, and pass_word are all caught. A save that carries one anywhere in the models value is refused by path and key, so the owner learns why, and it is never stored
const credentialName = /key|secret|token|password|passwd|authorization|bearer|credential|cookie|session/
const looksLikeCredential = (key: string): boolean => credentialName.test(key.toLowerCase().replace(/[^a-z0-9]/g, ''))
const pollutionKeys: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

// the longest a stored id, provider, model, or slot value may be
const maxText = 200
const isText = (value: unknown): value is string => typeof value === 'string' && value.length <= maxText

// why one registry entry is unusable, or null when it is fine
const entryProblem = (value: unknown): string | null => {
  if (!isObject(value)) return 'an entry must be an object with id, runner, provider, and model'
  if (typeof value.id !== 'string' || !labelPattern.test(value.id)) return 'id must be letters, digits, dots, underscores, and dashes, starting with a letter or digit'
  if (!modelRunners.includes(value.runner as ModelRunner)) return `runner must be one of ${modelRunners.join(', ')}`
  if (typeof value.provider !== 'string' || !labelPattern.test(value.provider)) return 'provider must be letters, digits, dots, underscores, and dashes, such as anthropic'
  const slug = slugProblem(value.model)
  if (slug !== null) return slug
  // a built-in id means the built-in entry: restating it exactly is harmless, and anything else would change what the built-in fallback runs
  const builtIn = builtInRegistry.find((entry) => entry.id === value.id)
  if (builtIn !== undefined && (builtIn.runner !== value.runner || builtIn.provider !== value.provider || builtIn.model !== value.model)) return `id ${builtIn.id} is a built-in model id (${builtIn.runner}, ${builtIn.provider}, ${builtIn.model}), so an entry may use it only to restate that entry exactly; choose another id`
  return null
}

// the setting reduced to the shapes it holds, a strict allowlist that builds a new value and copies nothing it was not told to: `registry` is a list of entries that are objects, each with only the four entry fields, each a string of at most 200 characters; `fallback` is a string; `slots` is an object with only the five slot names, each a string id or, for a pair slot, a pair of two string ids. A value of any other shape is dropped. Applied on every read and every save, so nothing else the file or a request carries is ever stored or served
export const projectModels = (raw: unknown): Record<string, unknown> | unknown => {
  if (!isObject(raw)) return raw
  const projected: Record<string, unknown> = {}
  const own = (value: Record<string, unknown>, key: string): unknown => Object.hasOwn(value, key) ? value[key] : undefined
  const registry = own(raw, 'registry')
  if (Array.isArray(registry)) {
    projected.registry = registry.filter(isObject).map((value) => {
      const entry: Record<string, unknown> = {}
      for (const field of entryFields) {
        const given = own(value, field)
        if (isText(given)) entry[field] = given
      }
      return entry
    }).filter((entry) => Object.keys(entry).length > 0)
  }
  const fallback = own(raw, 'fallback')
  if (isText(fallback)) projected.fallback = fallback
  const slots = own(raw, 'slots')
  if (isObject(slots)) {
    const kept: Record<string, unknown> = {}
    for (const slot of slotNames) {
      const value = own(slots, slot)
      if (isText(value)) kept[slot] = value
      else if (isPairSlot(slot) && Array.isArray(value) && value.length === 2 && value.every(isText)) kept[slot] = [value[0], value[1]]
    }
    projected.slots = kept
  }
  return projected
}

// the first key anywhere in the raw value, at any depth and through arrays, that looks like a credential or is a prototype-pollution key, as the path and key a save names. Walked without recursion, so a deeply nested value cannot overflow the stack; the value is never part of the message
const credentialProblem = (raw: unknown): string | null => {
  const pending: { value: unknown, path: string }[] = [{ value: raw, path: 'models' }]
  while (pending.length > 0) {
    const { value, path } = pending.pop() as { value: unknown, path: string }
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) pending.push({ value: value[index], path: `${path}[${index}]` })
    } else if (isObject(value)) {
      const keys = Object.keys(value)
      for (const key of keys) {
        const shown = key.length > 60 ? `${key.slice(0, 59)}…` : key
        if (pollutionKeys.has(key)) return `${path}.${shown}: the key ${shown} is not allowed in the models setting; remove it`
        if (looksLikeCredential(key)) return `${path}.${shown}: a field named ${shown} looks like a credential, and the models setting never holds a key, a key reference, a token, or a secret; remove it`
      }
      for (let index = keys.length - 1; index >= 0; index--) pending.push({ value: value[keys[index] as string], path: `${path}.${keys[index]}` })
    }
  }
  return null
}

// the first value of the wrong shape in a known part of the setting, as its path, or null: fallback must be a string, slots an object, each slot a string id (or a pair of two string ids for review and autoReviewHuman), each of at most 200 characters. An unknown key is dropped by projectModels without a refusal
const shapeProblem = (raw: Record<string, unknown>): string | null => {
  if (raw.fallback !== undefined && !isText(raw.fallback)) return 'models.fallback must be a model id, a string of at most 200 characters'
  if (raw.slots === undefined) return null
  if (!isObject(raw.slots)) return 'models.slots must be an object with the slot names review, stack, sweep, autoReviewHuman, and autoReviewBot'
  for (const slot of slotNames) {
    const value = raw.slots[slot]
    if (value === undefined || isText(value)) continue
    if (isPairSlot(slot) && Array.isArray(value) && value.length === 2 && value.every(isText)) continue
    return `models.slots.${slot} must be ${isPairSlot(slot) ? 'a model id or a pair of two model ids' : 'one model id'}, strings of at most 200 characters`
  }
  return null
}

const entryOf = (value: Record<string, unknown>): ModelEntry =>
  ({ id: value.id as string, runner: value.runner as ModelRunner, provider: value.provider as string, model: value.model as string })

const idOf = (value: unknown, index: number): string => isObject(value) && typeof value.id === 'string' && value.id !== '' ? value.id : `#${index + 1}`

// the problem a save refuses, or null: a key named like a credential or a prototype-pollution key at any depth (checked on the raw request, before projectModels drops the unknown fields), a fallback or slot of the wrong shape, a registry that is not a list, an entry with a bad id, runner, provider, or model, a built-in id used for another entry, or an id used twice. A read tolerates all of it (resolveModels sets it aside), and a slot naming an unknown id is a warning in Settings rather than a refusal
export const modelsSaveProblem = (raw: unknown): string | null => {
  if (raw === undefined) return null
  if (!isObject(raw)) return 'models must be an object with registry, fallback, and slots'
  const credential = credentialProblem(raw)
  if (credential !== null) return credential
  const shape = shapeProblem(raw)
  if (shape !== null) return shape
  if (raw.registry === undefined) return null
  if (!Array.isArray(raw.registry)) return 'models.registry must be a list of entries'
  const seen = new Set<string>()
  for (const [index, value] of raw.registry.entries()) {
    const problem = entryProblem(value)
    if (problem !== null) return `models.registry[${index}] (${idOf(value, index)}): ${problem}`
    const id = (value as { id: string }).id
    if (seen.has(id)) return `models.registry[${index}] (${id}): id appears twice`
    seen.add(id)
  }
  return null
}

// the effective models: the owner's setting where it is sound, the built-in table where it is missing or misconfigured. One bad entry drops only that entry, and a slot that cannot be read takes its own built-in default and says so
export const resolveModels = (raw: unknown): ResolvedModels => {
  const warnings: string[] = []
  let setting: Record<string, unknown> = {}
  if (raw !== undefined) {
    if (isObject(raw)) setting = raw
    else warnings.push('models must be an object with registry, fallback, and slots, so the built-in models are used')
  }
  let registry: ModelEntry[] = [...builtInRegistry]
  if (setting.registry !== undefined) {
    if (!Array.isArray(setting.registry)) warnings.push('models.registry must be a list of entries, so the built-in table is used')
    else {
      const kept: ModelEntry[] = []
      for (const [index, value] of setting.registry.entries()) {
        const problem = entryProblem(value)
        if (problem !== null) warnings.push(`Registry entry ${idOf(value, index)} is ignored: ${problem}.`)
        else if (kept.some((entry) => entry.id === (value as { id: string }).id)) warnings.push(`Registry entry ${(value as { id: string }).id} appears twice, so the first one stands.`)
        else kept.push(entryOf(value as Record<string, unknown>))
      }
      if (kept.length === 0) warnings.push('models.registry holds no usable entry, so the built-in table is used')
      else registry = kept
    }
  }
  const entryFor = (id: string): ModelEntry | null => registry.find((entry) => entry.id === id) ?? null
  // a built-in default is read from the built-in table alone, never from the owner's registry, so no custom entry can change what a default runs
  const builtIn = (id: string): ModelEntry => builtInRegistry.find((entry) => entry.id === id) as ModelEntry
  let fallback = builtIn(builtInFallbackId)
  if (setting.fallback !== undefined) {
    const named = typeof setting.fallback === 'string' ? entryFor(setting.fallback) : null
    if (named === null) warnings.push(`The pinned fallback ${typeof setting.fallback === 'string' ? setting.fallback : 'given'} is not in the registry, so ${builtInFallbackId} is used.`)
    else fallback = named
  }
  const given = setting.slots
  let slotSetting: Record<string, unknown> = {}
  if (given !== undefined) {
    if (isObject(given)) slotSetting = given
    else warnings.push('models.slots must be an object, so every slot takes its built-in default')
  }
  const take = (slot: SlotName, id: unknown, fallbackId: string): ModelEntry => {
    const found = typeof id === 'string' ? entryFor(id) : null
    if (found !== null) return found
    warnings.push(`Slot ${slot} names ${typeof id === 'string' ? id : 'something that is not a model id'}, which is not in the registry, so ${fallbackId} is used.`)
    return builtIn(fallbackId)
  }
  const pairs = {} as Record<PairSlotName, [ModelEntry, ModelEntry]>
  const ones = {} as Record<Exclude<SlotName, PairSlotName>, ModelEntry>
  for (const slot of slotNames) {
    const value = slotSetting[slot]
    if (isPairSlot(slot)) {
      if (value === undefined) pairs[slot] = [builtIn(defaultPair[0]), builtIn(defaultPair[1])]
      else if (!Array.isArray(value) || value.length !== 2) {
        warnings.push(`Slot ${slot} holds a pair of models, primary and secondary, so ${defaultPair.join(' and ')} are used.`)
        pairs[slot] = [builtIn(defaultPair[0]), builtIn(defaultPair[1])]
      } else pairs[slot] = [take(slot, value[0], defaultPair[0]), take(slot, value[1], defaultPair[1])]
    } else if (value === undefined) ones[slot] = builtIn(defaultOne)
    else if (typeof value !== 'string') {
      warnings.push(`Slot ${slot} holds one model, so ${defaultOne} is used.`)
      ones[slot] = builtIn(defaultOne)
    } else ones[slot] = take(slot, value, defaultOne)
  }
  return { registry, fallback, slots: { ...pairs, ...ones }, warnings }
}

// a slot's models under the resolution order: a per-run override, then the slot's default. The override names registry ids; one that is not in the registry is ignored, and a pair given one id overrides only its primary. The built-in default is what the slot already holds when the setting could not be read
export const resolveSlot = <S extends SlotName>(resolved: ResolvedModels, slot: S, override?: string | readonly string[]): SlotValue<S> => {
  const named = (typeof override === 'string' ? [override] : override ?? []).map((id) => resolved.registry.find((entry) => entry.id === id) ?? null)
  const base = resolved.slots[slot]
  if (Array.isArray(base)) return [named[0] ?? base[0], named[1] ?? base[1]] as SlotValue<S>
  return (named[0] ?? base) as SlotValue<S>
}

// every term a posted report must not contain, in one place so the owner can extend it. A term matches case-insensitively and as whole words, in the text as written and in its normalized form (nameInText), so claudette, okimi, and said are never hits; spaces in a phrase match any run of whitespace. versioned lets a version follow the word, as in GPT-5.2 or GPT4. Copilot and agent are left out on purpose: Copilot is a GitHub reviewer that may be named in a review of someone else's PR, and agent is ordinary code-review vocabulary. The registry ids and full slugs are looked for as well (nameInText), from the owner's registry and the built-in table both
export type PostedTextTerm = { term: string, kind: 'vendor' | 'aiTerm' | 'credit' | 'reviewMode', versioned?: true }
export const postedTextTerms: readonly PostedTextTerm[] = [
  ...['claude', 'anthropic', 'codex', 'openai', 'chatgpt', 'gemini', 'grok', 'deepseek', 'kimi', 'qwen', 'moonshot', 'moonshotai', 'openrouter', 'hermes', 'sonnet', 'opus'].map((term): PostedTextTerm => ({ term, kind: 'vendor' })),
  { term: 'gpt', kind: 'vendor', versioned: true },
  ...['ai', 'a.i.', 'llm', 'llms', 'language model', 'language models', 'artificial intelligence'].map((term): PostedTextTerm => ({ term, kind: 'aiTerm' })),
  ...['ai-generated', 'ai generated', 'generated by', 'written by', 'authored by an', 'co-authored', 'reviewed by an', 'assistant', 'autonomous', 'bot-written'].map((term): PostedTextTerm => ({ term, kind: 'credit' })),
  ...['tandem', 'degraded', 'consolidator'].map((term): PostedTextTerm => ({ term, kind: 'reviewMode' })),
]

// provider labels that are ordinary words, so a registry entry that uses one never blocks a report that uses the word
const genericProviders: ReadonlySet<string> = new Set(['local', 'custom', 'default', 'other', 'none', 'self', 'own', 'test', 'dev', 'cloud', 'api', 'host', 'hosted', 'internal', 'external', 'private', 'public', 'main', 'model', 'models'])

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const edge = { before: '(?<![\\p{L}\\p{N}_])', after: '(?![\\p{L}\\p{N}_])' }
const termSource = (term: string, versioned = false): string => `${escapeRegex(term).replace(/ /g, '\\s+')}${versioned ? '(?:[-\\s]?\\d[\\d.]*)?' : ''}`

// where a refusal is: the text around the match, at most 60 characters, whitespace collapsed, and never the whole report
const contextAround = (text: string, index: number, length: number): string => {
  // a match that alone fills the bound is cut with an ellipsis, so the whole context is still 60 characters
  if (length >= 60) return `${text.slice(index, index + 59).replace(/\s+/g, ' ')}…`
  const room = Math.max(0, 60 - length)
  const start = Math.max(0, index - Math.floor(room / 2))
  const end = Math.min(text.length, index + length + (room - (index - start)))
  const slice = text.slice(start, end).replace(/\s+/g, ' ')
  return `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}`
}

// the HTML entities a renderer decodes in Markdown text that could spell or hide a letter: the numeric forms, decimal and hex, and a short table of named ones. A numeric one decodes with or without its semicolon (its digits end where the first non-digit begins, so it is never ambiguous), and a named one without a semicolon only for the legacy few and only when no letter, digit, or equals sign follows. An entity that is not a code point, or is not in the table, is left alone
const namedEntities: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '', zwj: '', zwnj: '', lrm: '', rlm: '', ZeroWidthSpace: '', NoBreak: '', hyphen: '-', dash: '-', ndash: '-', mdash: '-', lowbar: '_', ast: '*', grave: '`', lsqb: '[', rsqb: ']', lpar: '(', rpar: ')', num: '#', period: '.', sol: '/', colon: ':', commat: '@',
}
const bareEntities: ReadonlySet<string> = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp', 'shy'])
const entityPattern = /&(?:#([0-9]{1,8})|#[xX]([0-9a-fA-F]{1,8})|([A-Za-z][A-Za-z0-9]{1,31}))(;?)/g
const decodeEntities = (text: string): string =>
  text.replace(entityPattern, (whole, decimal: string | undefined, hex: string | undefined, name: string | undefined, semicolon: string, offset: number) => {
    if (name === undefined) {
      const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex as string, 16)
      return code >= 1 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole
    }
    const decoded = namedEntities[name]
    if (decoded === undefined || !Object.hasOwn(namedEntities, name)) return whole
    if (semicolon === ';') return decoded
    return bareEntities.has(name) && !/[A-Za-z0-9=]/.test(text.charAt(offset + whole.length)) ? decoded : whole
  })

// format characters that draw nothing (zero-width, bidi controls, soft hyphen, word joiner, byte-order mark, and the like), a combining grapheme joiner, and variation selectors
const invisible = /[\p{Cf}\u034f\u180e\ufe00-\ufe0f]/gu

// inline link syntax down to its text, and each destination kept to be scanned beside it. One pass from left to right with indexOf, so it is linear: a closing parenthesis that is missing once is missing for every later link
const unlink = (text: string): { text: string, destinations: string[] } => {
  const destinations: string[] = []
  let out = ''
  let at = 0
  let open = text.indexOf('](')
  let missing = false
  while (open >= 0 && !missing) {
    const close = text.indexOf(')', open + 2)
    if (close < 0) {
      missing = true
      break
    }
    out += text.slice(at, open)
    destinations.push(text.slice(open + 2, close))
    at = close + 1
    open = text.indexOf('](', at)
  }
  return { text: out + text.slice(at), destinations }
}

// the text as it renders and as a person reads it: entities decoded, invisible characters gone, compatibility forms (fullwidth letters and the like) folded by NFKC, links reduced to their text with their destinations kept beside it, emphasis, code, and strikethrough markers and the brackets of a link removed, and whitespace collapsed. Every step is a single pass, so the cost is linear in the report
export const normalizeForScan = (text: string): string => {
  let decoded = text
  for (let pass = 0; pass < 3; pass++) {
    const next = decodeEntities(decoded)
    if (next === decoded) break
    decoded = next
  }
  const folded = decoded.replace(invisible, '').normalize('NFKC').replace(invisible, '')
  const { text: linked, destinations } = unlink(folded)
  return [linked, ...destinations].join(' ').replace(/[*_`~[\]]/g, '').replace(/\s+/g, ' ').trim()
}

export type PostedTextHit = { term: string, context: string }

// the first term in the text, the one that starts earliest and the longer on a tie, or null, looked for in the normalized text (normalizeForScan) and then in the literal text, since removing markers can also join what was apart. The terms are postedTextTerms plus every registry id, full slug, provider, and runner Pit View knows, the owner's registry and the built-in table both, so a name the owner removed is still never posted. A leading ~ on a slug is optional in the text. The term returned is the list's entry, lowercase, and the context is from the text it was found in. One regular expression of whole-word alternatives, with no nested repetition, runs once over each text
export const nameInText = (resolved: Pick<ResolvedModels, 'registry'>, text: string): PostedTextHit | null => {
  const sources = new Map<string, string>()
  for (const entry of [...resolved.registry, ...builtInRegistry]) {
    for (const name of [entry.id, entry.model, entry.model.replace(/^~/, '')]) {
      if (name !== '') sources.set(name.toLowerCase(), termSource(name))
    }
  }
  // each entry's provider and runner too, from both tables; a value shorter than three characters or a generic word would block ordinary reports and is left out
  for (const entry of [...resolved.registry, ...builtInRegistry]) {
    for (const name of [entry.provider, entry.runner]) {
      if (name.length >= 3 && !genericProviders.has(name.toLowerCase())) sources.set(name.toLowerCase(), termSource(name))
    }
  }
  for (const { term, versioned } of postedTextTerms) sources.set(term, termSource(term, versioned === true))
  // the longest term first, so one that starts where a shorter one does is the one found
  const ordered = [...sources].sort(([a], [b]) => b.length - a.length)
  const matcher = new RegExp(`${edge.before}(?:${ordered.map(([, source]) => source).join('|')})${edge.after}`, 'iu')
  const find = (haystack: string): PostedTextHit | null => {
    const found = matcher.exec(haystack)
    if (found === null) return null
    const term = ordered.find(([, source]) => startsWith(source, haystack, found.index))?.[0] ?? found[0].toLowerCase()
    return { term, context: contextAround(haystack, found.index, found[0].length) }
  }
  const normalized = normalizeForScan(text)
  return find(normalized) ?? (normalized === text ? null : find(text))
}

// whether the term's pattern matches at exactly this index
const startsWith = (source: string, haystack: string, index: number): boolean => {
  const pattern = new RegExp(`${edge.before}(?:${source})${edge.after}`, 'iuy')
  pattern.lastIndex = index
  return pattern.test(haystack)
}

// what a run records for each model it used (request.json and the run row's models column, section 8 of DESIGN.md, Launching runs, Recording the models). id is the registry id, null when the model passed to the runner is in no registry entry or the runner's own default was used; model is what the runner was told, null for Codex's own default; fallback is whether the pinned fallback replaced the role's model; outcome is how the role ended, null when none is recorded. Never a key, a key reference, or a spend figure
export type ModelRole = { role: string, id: string | null, runner: ModelRunner, provider: string, model: string | null, fallback: boolean }
export type RecordedRole = ModelRole & { outcome: string | null }

// request.json carries the roles as they started; the row adds each role's outcome. degraded is whether the review ended on one surviving draft, which never posts
export type RequestModels = { roles: ModelRole[], degraded: boolean }
export type RunModels = { roles: RecordedRole[], degraded: boolean }

// the role a launch records for the model it was started with. A Claude or Codex launch passes one model on its command line (Codex's own default when none is given, which is no model), and the registry id is the entry that lists that runner and model, or null when none does. The launcher passes the models it built the command line from, so the record cannot disagree with the run
export const roleFor = (resolved: Pick<ResolvedModels, 'registry'>, role: string, runner: ModelRunner, model: string | null): ModelRole => {
  const entry = model === null ? undefined : [...resolved.registry, ...builtInRegistry].find((candidate) => candidate.runner === runner && candidate.model === model)
  return { role, id: entry?.id ?? null, runner, provider: entry?.provider ?? (runner === 'claude' ? 'anthropic' : runner === 'codex' ? 'openai' : 'openrouter'), model, fallback: false }
}

// what GET /api/models serves for the Settings page: the effective registry and pinned fallback, each slot by registry id, and the warnings. Only what is configured above: never a key, a key reference, or a spend figure
export type ModelsView = {
  registry: ModelEntry[]
  fallback: ModelEntry
  slots: { [S in SlotName]: S extends PairSlotName ? [string, string] : string }
  warnings: string[]
}

export const modelsView = (raw: unknown): ModelsView => {
  const resolved = resolveModels(raw)
  const slots = Object.fromEntries(slotNames.map((slot) => {
    const value = resolved.slots[slot]
    return [slot, Array.isArray(value) ? value.map((entry) => entry.id) : value.id]
  })) as ModelsView['slots']
  return { registry: resolved.registry, fallback: resolved.fallback, slots, warnings: resolved.warnings }
}
