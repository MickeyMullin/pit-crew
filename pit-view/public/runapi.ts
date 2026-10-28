// public/runapi.ts
// the page's requests to Pit View's own API: the per-start token it was served with, the two run
// writes, and the reads the drawer makes; a refusal comes back as a status and the server's
// message, and status 0 means Pit View did not answer
import type { RunRequest } from './agent.ts'

// the meta tag the server inserts into each page it serves; empty when missing, which the
// server then refuses with 403, read as "reload the page"
export const readToken = (doc: Document): string =>
  doc.querySelector('meta[name="pit-view-token"]')?.getAttribute('content') ?? ''

export type Answer<T> = { ok: true, status: number, value: T } | { ok: false, status: number, error: string | null }

const answerOf = async <T>(response: Response): Promise<Answer<T>> => {
  if (response.ok) return { ok: true, status: response.status, value: await response.json().catch(() => null) as T }
  const body = await response.json().catch(() => null) as { error?: unknown } | null
  return { ok: false, status: response.status, error: typeof body?.error === 'string' ? body.error : null }
}

// sends a request and reads the JSON answer; never throws
export const call = async <T>(url: string, init?: RequestInit): Promise<Answer<T>> => {
  try {
    return await answerOf<T>(await fetch(url, init))
  } catch {
    return { ok: false, status: 0, error: null }
  }
}

export const sendRun = (request: RunRequest): Promise<Answer<unknown>> => call(request.url, request.init)

export const getJson = <T>(url: string): Promise<Answer<T>> => call<T>(url, { cache: 'no-store' })
