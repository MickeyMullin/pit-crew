// src/openrouter.ts
// Pit View's dedicated OpenRouter key (section 8 of DESIGN.md, The OpenRouter key): one file in the instance's config folder, beside config.json and never in it, and the copy of it in the Hermes profile's .env. Both are only read here, the way oauth.json is, and nothing in Pit View writes either. Nothing here returns a key to a page, and no message names one
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { configDir } from './config.ts'
import { readGuarded } from './signin.ts'

export const openRouterFileName = 'openrouter.json'

export const openRouterKeyPath = (home: string, instance = ''): string => join(configDir(home, instance), openRouterFileName)

// what a read finds: the key, no usable key (no file, or an empty one), or a problem with the file that names it and never its contents
export type KeyRead = { key: string } | { missing: true } | { problem: string }

export const readOpenRouterKey = async (path: string, shown = path): Promise<KeyRead> => {
  const read = await readGuarded(path, shown)
  if ('missing' in read || 'problem' in read) return read
  let value: unknown
  try {
    value = JSON.parse(read.text)
  } catch {
    return { problem: `${shown} is not valid JSON` }
  }
  const usage = `${shown} must be { "apiKey": "..." } and nothing else`
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { problem: usage }
  const { apiKey, ...rest } = value as Record<string, unknown>
  if (Object.keys(rest).length > 0 || typeof apiKey !== 'string') return { problem: usage }
  return apiKey.trim() === '' ? { missing: true } : { key: apiKey }
}

export const profileEnvName = 'OPENROUTER_API_KEY'

// the Hermes profile's own .env, which is where a gateway-run Hermes reads the key from
export const profileEnvPath = (home: string, profile: string): string => join(home, '.hermes', 'profiles', profile, '.env')

// the value of the last OPENROUTER_API_KEY assignment in a .env text, and nothing else of it: no other line is kept
const profileEnvValue = (text: string): string => {
  let value = ''
  for (const line of text.split(/\r?\n/)) {
    const found = /^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*)$/.exec(line)
    if (found === null) continue
    const raw = (found[1] ?? '').trim()
    const quote = raw[0]
    if (quote === '"' || quote === "'") {
      const end = raw.indexOf(quote, 1)
      value = end === -1 ? raw.slice(1) : raw.slice(1, end)
    } else {
      value = raw.replace(/\s+#.*$/, '').trim()
    }
  }
  return value
}

export const readProfileEnvKey = async (path: string, shown = path): Promise<KeyRead> => {
  const read = await readGuarded(path, shown)
  if ('missing' in read || 'problem' in read) return read
  const value = profileEnvValue(read.text)
  return value === '' ? { missing: true } : { key: value }
}

export type Presence = 'set' | 'missing' | 'problem'
export type KeySync = 'in sync' | 'differs' | 'unknown'

// what the Settings card and GET /api/openrouter-key say: never a key, only whether each file holds one, whether the two agree, and (only when they differ) the first 8 hex characters of each key's SHA-256, so the owner can see which side is stale
export type OpenRouterStatus = {
  keyFile: Presence
  profileEnv: Presence
  sync: KeySync
  prefixes: { keyFile: string, profileEnv: string } | null
  problems: { keyFile: string | null, profileEnv: string | null }
}

const hashOf = (key: string): string => createHash('sha256').update(key).digest('hex')

export const keyPrefix = (key: string): string => hashOf(key).slice(0, 8)

const presence = (read: KeyRead): Presence => 'key' in read ? 'set' : 'problem' in read ? 'problem' : 'missing'

export const keyStatus = (file: KeyRead, env: KeyRead): OpenRouterStatus => {
  const problems = { keyFile: 'problem' in file ? file.problem : null, profileEnv: 'problem' in env ? env.problem : null }
  if (!('key' in file) || !('key' in env)) return { keyFile: presence(file), profileEnv: presence(env), sync: 'unknown', prefixes: null, problems }
  const same = hashOf(file.key) === hashOf(env.key)
  return { keyFile: 'set', profileEnv: 'set', sync: same ? 'in sync' : 'differs', prefixes: same ? null : { keyFile: keyPrefix(file.key), profileEnv: keyPrefix(env.key) }, problems }
}
