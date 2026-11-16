// src/openrouter.ts
// Pit View's dedicated OpenRouter key (section 8 of DESIGN.md, The OpenRouter key): one file in the instance's config folder, beside config.json and never in it, read and written the way oauth.json is. Nothing here returns the key to a page, and no message names it
import { constants } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { configDir } from './config.ts'
import { readGuarded } from './signin.ts'

export const openRouterFileName = 'openrouter.json'

export const openRouterKeyPath = (home: string, instance = ''): string => join(configDir(home, instance), openRouterFileName)

// what a read finds: the key, no usable key (no file, or an empty one), or a problem with the file that names it and never its contents
export type KeyRead = { key: string } | { missing: true } | { problem: string }

const maxKey = 500

// why a key is refused, or null; the reason never repeats the key
export const keyProblem = (key: unknown): string | null => {
  if (typeof key !== 'string') return 'the key must be text'
  if (key.trim() === '') return 'the key must not be empty'
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(key)) return 'the key must have no spaces or control characters'
  return key.length > maxKey ? `the key must be at most ${maxKey} characters` : null
}

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

// a new key written to a fresh file of mode 0600 and moved into place, so a reader sees the old key or the new one and never a part. Only this file is written
export const writeOpenRouterKey = async (path: string, key: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomBytes(6).toString('hex')}`
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    await handle.writeFile(`${JSON.stringify({ apiKey: key })}\n`)
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

export const clearOpenRouterKey = async (path: string): Promise<void> => {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}
