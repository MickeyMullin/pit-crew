// public/openrouterkey.ts
// the Settings card for Pit View's OpenRouter key (section 8 of DESIGN.md, The OpenRouter key): whether a key is set, and Replace and Clear. The key is typed into a field that is never filled in, goes to its own route, and is never shown, stored by the page, or sent anywhere else
import { tokenHeader } from './agent.ts'

export type KeyView = { set: boolean, problem: string | null }
export type KeyStatus = { text: string, tone: 'normal' | 'ok' | 'error' }

export const keyRoute = '/api/openrouter-key'

// what the card says: only the two fields the server answers with are read
export const keyStatus = (view: KeyView | null): KeyStatus => {
  if (view === null) return { text: 'Could not read whether a key is set.', tone: 'error' }
  if (view.problem !== null) return { text: `Not usable: ${view.problem}`, tone: 'error' }
  return view.set ? { text: 'Set.', tone: 'ok' } : { text: 'Not set. Hermes runs fail to start until a key is set.', tone: 'normal' }
}

// a problem with what was typed, or null; the message never repeats the key
export const keyInputProblem = (typed: string): string | null => {
  const key = typed.trim()
  if (key === '') return 'Enter the key.'
  return /\s/.test(key) ? 'A key has no spaces.' : null
}

export type KeyRequest = { url: string, init: RequestInit }

export const replaceRequest = (typed: string, token: string): KeyRequest => ({
  url: keyRoute,
  init: { method: 'PUT', headers: { 'Content-Type': 'application/json', [tokenHeader]: token }, body: JSON.stringify({ apiKey: typed.trim() }) },
})

export const clearRequest = (token: string): KeyRequest => ({ url: keyRoute, init: { method: 'DELETE', headers: { [tokenHeader]: token } } })
