// public/live.ts
// the page's link to the server: one event stream per page load under one client id, and the
// visibility and pause reports; the page never polls, it only says whether it is looking
import type { Patch } from '../src/poller.ts'

export type ClientState = { visible: boolean, paused: boolean }

export type LiveOptions = {
  clientId: string
  // read afresh at every (re)connect and report, so a reconnect restores the client exactly
  state: () => ClientState
  // the stream opened, the first time or after a reconnect: refetch the view
  onOpen: () => void
  onPatch: (patch: Patch) => void
  // the stream dropped; it reopens on its own
  onDown: () => void
}

export type Live = {
  start: () => void
  // sends the current state; an unknown client (stream not open) reopens the stream instead
  report: () => Promise<void>
}

const backoffMs = [1_000, 2_000, 5_000, 10_000, 30_000]

export const createLive = (options: LiveOptions): Live => {
  let source: EventSource | null = null
  let retries = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const url = (): string => {
    const { visible, paused } = options.state()
    const query = new URLSearchParams({ client: options.clientId, visible: String(visible), paused: String(paused) })
    return `/api/events?${query.toString()}`
  }

  const open = (): void => {
    clearTimeout(retryTimer)
    source?.close()
    const stream = new EventSource(url())
    source = stream
    stream.addEventListener('open', () => {
      retries = 0
      options.onOpen()
    })
    stream.addEventListener('patch', (event) => {
      let patch: Patch
      try {
        patch = JSON.parse((event as MessageEvent<string>).data) as Patch
      } catch {
        return
      }
      options.onPatch(patch)
    })
    // EventSource would retry with the query it was opened with; reopen with the current state instead
    stream.addEventListener('error', () => {
      if (source !== stream) return
      stream.close()
      source = null
      options.onDown()
      const delay = backoffMs[Math.min(retries, backoffMs.length - 1)] ?? 30_000
      retries += 1
      retryTimer = setTimeout(open, delay)
    })
  }

  const report = async (): Promise<void> => {
    if (source === null) return
    try {
      const response = await fetch(`/api/clients/${encodeURIComponent(options.clientId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options.state()),
      })
      if (response.status === 404) open()
    } catch {
      // the stream's own error handling reconnects, carrying the state
    }
  }

  return { start: open, report }
}
