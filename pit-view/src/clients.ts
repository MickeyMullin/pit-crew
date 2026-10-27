// src/clients.ts

// what a page reports about itself: the Page Visibility API's state, its Pause control, and
// whether its user has been inactive for idleMinutes
export type ClientState = { visible: boolean, paused: boolean, idle: boolean }

export type Change = {
  // whether this client counts as active after the change
  active: boolean
  // it went from inactive (or absent) to active: the poller's active trigger
  becameActive: boolean
  // active clients across all pages after the change
  activeCount: number
}

export type Clients = {
  // registers a stream for the client id; returns the connection to pass to disconnect
  connect: (id: string, state: ClientState) => { connection: number, change: Change }
  // null when no stream is open for the id
  update: (id: string, state: ClientState) => Change | null
  // drops the connection; the client goes when its last stream closes
  disconnect: (id: string, connection: number) => Change | null
  get: (id: string) => ClientState | null
  size: () => number
  activeCount: () => number
}

// an idle page counts as paused: visible but not looking
export const isActive = (state: ClientState): boolean => state.visible && !state.paused && !state.idle

// in memory only: a client exists while its event stream is open
export const createClients = (): Clients => {
  // a reconnect can open the new stream before the old one closes, so a client may hold more than one
  const clients = new Map<string, { state: ClientState, connections: Set<number> }>()
  let nextConnection = 1

  const activeCount = (): number => [...clients.values()].filter((client) => isActive(client.state)).length

  const changeOf = (before: ClientState | null, after: ClientState | null): Change => {
    const wasActive = before !== null && isActive(before)
    const active = after !== null && isActive(after)
    return { active, becameActive: active && !wasActive, activeCount: activeCount() }
  }

  const connect = (id: string, state: ClientState): { connection: number, change: Change } => {
    const connection = nextConnection
    nextConnection += 1
    const existing = clients.get(id)
    const before = existing?.state ?? null
    const next = { visible: state.visible, paused: state.paused, idle: state.idle }
    if (existing === undefined) {
      clients.set(id, { state: next, connections: new Set([connection]) })
    } else {
      existing.state = next
      existing.connections.add(connection)
    }
    return { connection, change: changeOf(before, next) }
  }

  const update = (id: string, state: ClientState): Change | null => {
    const existing = clients.get(id)
    if (existing === undefined) return null
    const before = existing.state
    existing.state = { visible: state.visible, paused: state.paused, idle: state.idle }
    return changeOf(before, existing.state)
  }

  const disconnect = (id: string, connection: number): Change | null => {
    const existing = clients.get(id)
    if (existing === undefined || !existing.connections.delete(connection)) return null
    if (existing.connections.size > 0) return changeOf(existing.state, existing.state)
    clients.delete(id)
    return changeOf(existing.state, null)
  }

  return {
    connect,
    update,
    disconnect,
    get: (id) => clients.get(id)?.state ?? null,
    size: () => clients.size,
    activeCount,
  }
}
