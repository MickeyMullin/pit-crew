// public/app.ts
// the page: opens the event stream, then fetches the view, applies patches in order and draws;
// reports visibility and pause; keeps focus, the hover card and scroll across every update
import type { Config } from '../src/config.ts'
import type { Patch, View } from '../src/poller.ts'
import { byId, setText } from './dom.ts'
import { clearFilters, cycleSort, initialControls, pressTile, setClosedRange, setFilter, setGrouped } from './filters.ts'
import type { ClosedRangeKey, Controls, Filters } from './filters.ts'
import { createHoverCard } from './hovercard.ts'
import { loadInstance, showInstance } from './instance.ts'
import { createLive } from './live.ts'
import { render } from './render.ts'
import type { Settings, UiState } from './render.ts'
import { emptyFeed, receivePatch, receiveView, restartFeed } from './state.ts'
import type { FeedStep } from './state.ts'
import { configChannel } from './settings-form.ts'
import { syncStatus } from './status.ts'
import type { TableKey } from './tables.ts'
import { mountThemeToggle } from './theme.ts'

const pausedKey = 'pit-view.paused'

// sessionStorage keeps a reload paused while a new tab starts unpaused; unavailable means unpaused
const readPaused = (): boolean => {
  try {
    return window.sessionStorage.getItem(pausedKey) === '1'
  } catch {
    return false
  }
}

const writePaused = (paused: boolean): void => {
  try {
    if (paused) window.sessionStorage.setItem(pausedKey, '1')
    else window.sessionStorage.removeItem(pausedKey)
  } catch {
    // the page still pauses; only a reload forgets it
  }
}

const clientId = crypto.randomUUID()
let feed = emptyFeed()
// the server's clock minus ours, from the latest view or patch, so ages agree with the server
let skewMs = 0
let settings: Settings = { density: 'comfortable', showAgentColumn: false }
// filters, sort, grouping and the active tile are kept in memory only: a reload starts clean
const ui: UiState = {
  ...initialControls(),
  openGroups: new Set(),
  paused: readPaused(),
}

const nowMs = (): number => Date.now() + skewMs
const visible = (): boolean => document.visibilityState === 'visible'

const hover = createHoverCard(byId('hovercard'), () => feed.view === null ? null : { view: feed.view, nowMs: nowMs() })

// focus and scroll stay with their PR and their place across a redraw; a rebuilt tile, sort
// header or group toggle gets focus back by its data-focus-key
type Kept = {
  focus: { table: string, pr: string, part: string } | null
  focusKey: string | null
  x: number
  y: number
  boxes: Map<string, number>
}

const keep = (): Kept => {
  const active = document.activeElement
  const row = active?.closest<HTMLElement>('tr[data-pr][data-table]')
  const part = active instanceof HTMLElement ? active.dataset.focus : undefined
  const boxes = new Map<string, number>()
  for (const box of document.querySelectorAll<HTMLElement>('.table-box')) boxes.set(box.id, box.scrollLeft)
  return {
    focus: row != null && part !== undefined ? { table: row.dataset.table ?? '', pr: row.dataset.pr ?? '', part } : null,
    focusKey: active instanceof HTMLElement ? active.dataset.focusKey ?? null : null,
    x: window.scrollX,
    y: window.scrollY,
    boxes,
  }
}

const restore = (kept: Kept): void => {
  const lost = document.activeElement === null || document.activeElement === document.body
  if (lost && kept.focus !== null) {
    const { table, pr, part } = kept.focus
    document.querySelector<HTMLElement>(`tr[data-table="${table}"][data-pr="${pr}"] [data-focus="${part}"]`)?.focus({ preventScroll: true })
  } else if (lost && kept.focusKey !== null) {
    document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(kept.focusKey)}"]`)?.focus({ preventScroll: true })
  }
  for (const [id, left] of kept.boxes) {
    const box = document.getElementById(id)
    if (box !== null && box.scrollLeft !== left) box.scrollLeft = left
  }
  if (window.scrollX !== kept.x || window.scrollY !== kept.y) window.scrollTo(kept.x, kept.y)
}

// the live region speaks once per cycle start and end, and once per Pause or Resume
let announcedKey: string | null = null
const announce = (view: View): void => {
  const status = syncStatus(view.sync, { paused: ui.paused, nowMs: nowMs() })
  if (status.key === announcedKey) return
  // the first reading is what the page already shows; nothing to announce
  if (announcedKey !== null) setText(byId('sync-live'), status.text)
  announcedKey = status.key
}

const draw = (): void => {
  const view = feed.view
  if (view === null) return
  const kept = keep()
  render({ view, ui, settings, nowMs: nowMs() }, actions)
  restore(kept)
  hover.refresh()
  announce(view)
}

// a reducer from filters.ts applied to this page's controls, then a redraw
const update = (next: Controls): void => {
  Object.assign(ui, next)
  draw()
}

const actions = {
  pressTile: (tile: Parameters<typeof pressTile>[1]): void => update(pressTile(ui, tile)),
  // switches locally between the two cached ranges; releases a tile only when the range changes
  setRange: (range: ClosedRangeKey): void => update(setClosedRange(ui, range)),
  setQuery: (table: TableKey, query: string): void => update(setFilter(ui, table, { query })),
  // the select's options come from filters.ts, so its value is one of that field's own
  setSelect: (table: TableKey, field: string, value: string): void => update(setFilter(ui, table, { [field]: value } as Partial<Filters[TableKey]>)),
  setGrouped: (table: TableKey, grouped: boolean): void => {
    if (table !== 'closed') update(setGrouped(ui, table, grouped))
  },
  clear: (table: TableKey): void => update(clearFilters(ui, table)),
  sortBy: (table: TableKey, key: string): void => update(cycleSort(ui, table, key)),
  toggleSection: (table: TableKey): void => {
    ui.expanded[table] = !ui.expanded[table]
    draw()
  },
  toggleGroup: (table: TableKey, key: string): void => {
    const id = `${table}:${key}`
    if (ui.openGroups.has(id)) ui.openGroups.delete(id)
    else ui.openGroups.add(id)
    draw()
  },
}

const loadSettings = async (): Promise<void> => {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' })
    if (!response.ok) return
    const config = await response.json() as Partial<Config>
    settings = {
      density: config.density === 'compact' ? 'compact' : 'comfortable',
      showAgentColumn: config.showAgentColumn === true,
    }
    draw()
  } catch {
    // the defaults stand until the next view load
  }
}

// only the newest view request counts; an older answer arriving late is dropped
let viewRequest = 0
let viewRetry: ReturnType<typeof setTimeout> | undefined

const take = (step: FeedStep): void => {
  feed = step.feed
  if (step.render) draw()
  if (step.refetch) void loadView()
}

const loadView = async (): Promise<void> => {
  viewRequest += 1
  const request = viewRequest
  clearTimeout(viewRetry)
  try {
    const response = await fetch('/api/view', { cache: 'no-store' })
    if (!response.ok) throw new Error(`GET /api/view answered ${response.status}`)
    const view = await response.json() as View
    if (request !== viewRequest) return
    skewMs = Date.parse(view.now) - Date.now()
    take(receiveView(feed, view))
  } catch {
    if (request === viewRequest) viewRetry = setTimeout(() => void loadView(), 2_000)
  }
}

const onPatch = (patch: Patch): void => {
  skewMs = Date.parse(patch.now) - Date.now()
  if (patch.repo !== undefined || patch.viewer !== undefined) void loadSettings()
  take(receivePatch(feed, patch))
}

const live = createLive({
  clientId,
  state: () => ({ visible: visible(), paused: ui.paused }),
  onOpen: () => {
    // a first open and a reconnect alike start again from a fresh view
    feed = restartFeed(feed)
    void loadView()
    void loadSettings()
  },
  onPatch,
  onDown: () => {
    feed = restartFeed(feed)
  },
})

byId('refresh').addEventListener('click', () => {
  void fetch('/api/refresh', { method: 'POST' }).catch(() => {})
})

// a row's own refresh: one PR, paused or not; its patches redraw the row, so the answer is unused
document.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button.row-refresh[data-refresh]') : null
  if (button === null) return
  void fetch(`/api/prs/${encodeURIComponent(button.dataset.refresh ?? '')}/refresh`, { method: 'POST' }).catch(() => {})
})

byId('pause').addEventListener('click', () => {
  ui.paused = !ui.paused
  writePaused(ui.paused)
  void live.report()
  draw()
})

document.addEventListener('visibilitychange', () => {
  void live.report()
  // a returning page shows what it holds at once, with ages brought up to date
  if (visible()) draw()
})

// ages and "updated 38s ago" move with the clock; a local redraw, never a request
setInterval(() => {
  if (visible()) draw()
}, 15_000)

// the Settings page says when it saved, so density and the agent column follow at once
try {
  new BroadcastChannel(configChannel).addEventListener('message', () => void loadSettings())
} catch {
  // without the channel the settings apply on the next stream open
}

mountThemeToggle(byId<HTMLButtonElement>('theme'))
void loadInstance().then((info) => {
  if (info !== null) showInstance(info)
})

// the stream first, so no patch is missed; the view follows once it opens
live.start()
