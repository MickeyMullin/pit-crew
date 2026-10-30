// public/app.ts
// the page: opens the event stream, then fetches the view, applies patches in order and draws;
// reports visibility, pause and idle; keeps focus, the hover card and scroll across every update
import type { Config } from '../src/config.ts'
import type { Patch, View } from '../src/poller.ts'
import { announcements } from './agent.ts'
import { tickTimers, updateAgentCells } from './agentcell.ts'
import { byId, setText } from './dom.ts'
import { createDrawer } from './drawer.ts'
import { escapeApplies } from './drawerview.ts'
import { clearFilters, cycleSort, initialControls, pressTile, setClosedRange, setFilter, setGrouped, setPageSearch, toggleSection } from './filters.ts'
import type { ClosedRangeKey, Controls, Filters } from './filters.ts'
import { createHoverCard } from './hovercard.ts'
import { createIdleTracker } from './idle.ts'
import { loadInstance, showInstance } from './instance.ts'
import { createLive } from './live.ts'
import { shownCounts, slashApplies } from './pagesearch.ts'
import { createReportPanel } from './reportpanel.ts'
import { closedRangeOf, render } from './render.ts'
import type { Settings, UiState } from './render.ts'
import { readToken } from './runapi.ts'
import { emptyFeed, findOpenRow, openRows, receivePatch, receiveView, restartFeed } from './state.ts'
import type { FeedStep } from './state.ts'
import { lastUpdateOf, readLastUpdate, writeLastUpdate } from './schedule.ts'
import type { ScheduleStorage } from './schedule.ts'
import { configChannel } from './settings-form.ts'
import { syncStatus } from './status.ts'
import { createSweepDrawer, updateSweepAges } from './sweepdrawer.ts'
import { sweepAnnounceKey, sweepAnnouncement, sweepLinkFor } from './sweepview.ts'
import { mountStickyHeader } from './sticky.ts'
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
// the shipped defaults until the config loads
let settings: Settings = { density: 'comfortable', showAgentColumn: false, idleMinutes: 90 }
// filters, the page search, sort, grouping and the active tile are kept in memory only: a reload starts clean
const ui: UiState = {
  ...initialControls(),
  openGroups: new Set(),
  paused: readPaused(),
  // never kept: a reload starts active
  idle: false,
}

const nowMs = (): number => Date.now() + skewMs
const visible = (): boolean => document.visibilityState === 'visible'

// the start of the newest cycle seen, kept in localStorage so a reload keeps the refresh schedule;
// written only when it changes
const scheduleStorage = (): ScheduleStorage => window.localStorage
let seenUpdate = readLastUpdate(scheduleStorage)
const keepLastUpdate = (view: View): void => {
  const at = lastUpdateOf(view.sync)
  if (at === null || at === seenUpdate) return
  seenUpdate = at
  writeLastUpdate(scheduleStorage, at)
}

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

// an Agent cell changes its buttons with its state (Review becomes Stop, Stop goes away), so
// focus on one of them moves to the cell's new button, or to the PR link when it has none
const focusIn = (row: Element, part: string): HTMLElement | null =>
  row.querySelector<HTMLElement>(`[data-focus="${part}"]`)
    ?? (part.startsWith('agent') ? row.querySelector<HTMLElement>('[data-focus^="agent"]') ?? row.querySelector<HTMLElement>('[data-focus="pr"]') : null)

const restore = (kept: Kept): void => {
  const lost = document.activeElement === null || document.activeElement === document.body
  if (lost && kept.focus !== null) {
    const { table, pr, part } = kept.focus
    const row = document.querySelector(`tr[data-table="${table}"][data-pr="${pr}"]`)
    if (row !== null) focusIn(row, part)?.focus({ preventScroll: true })
  } else if (lost && kept.focusKey !== null) {
    document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(kept.focusKey)}"]`)?.focus({ preventScroll: true })
  }
  for (const [id, left] of kept.boxes) {
    const box = document.getElementById(id)
    if (box !== null && box.scrollLeft !== left) box.scrollLeft = left
  }
  if (window.scrollX !== kept.x || window.scrollY !== kept.y) window.scrollTo(kept.x, kept.y)
}

// the live region speaks once per cycle start and end, once per Pause or Resume, and once on
// entering or leaving idle
let announcedKey: string | null = null
const announce = (view: View): void => {
  const status = syncStatus(view.sync, { paused: ui.paused, idle: ui.idle, nowMs: nowMs() })
  if (status.key === announcedKey) return
  // the first reading is what the page already shows; nothing to announce
  if (announcedKey !== null) setText(byId('sync-live'), status.text)
  announcedKey = status.key
}

// the Agent column says politely when a run starts or finishes, once per change: never per
// timer tick, and nothing for what the page already showed when it loaded
let agentKeys: Map<number, string> | null = null
const announceRuns = (view: View): void => {
  // the drawer starts and stops runs whether or not the column is shown
  if (!settings.showAgentColumn && !drawer.isOpen()) {
    agentKeys = null
    return
  }
  const { next, messages } = announcements(agentKeys, openRows(view))
  agentKeys = next
  if (messages.length > 0) setText(byId('agent-live'), messages.join('. '))
}

// the first reading of the runs is what the page already shows. With the column off nothing has
// read them yet when the drawer opens from the banner, so a run started in its first seconds would
// be taken for the baseline and never announced: read it now
const seedRuns = (): void => {
  if (agentKeys === null && feed.view !== null) agentKeys = announcements(null, openRows(feed.view)).next
}

// the bot group's sweep status, and the drawer's sweeps, say politely when the newest sweep starts or finishes: once per change of its status, never per timer tick, and nothing for what the page showed when it loaded
let sweepKey: string | null = null
const announceSweeps = (view: View): void => {
  const key = sweepAnnounceKey(view.sweeps.items)
  if (key === sweepKey) return
  const first = sweepKey === null
  sweepKey = key
  const message = sweepAnnouncement(view.sweeps.items)
  if (!first && message !== null) setText(byId('agent-live'), message)
}

const draw = (): void => {
  const view = feed.view
  if (view === null) return
  const kept = keep()
  render({ view, ui, settings, nowMs: nowMs() }, actions)
  if (settings.showAgentColumn) updateAgentCells(document, openRows(view), nowMs())
  // the bot group header's sweep status: its running line and finish age move in place
  tickTimers(document, nowMs())
  updateSweepAges(document, nowMs())
  // one part failing must not stop the rest of the page drawing
  try {
    drawer.update()
    sweepDrawer.update()
    reportPanel.refresh()
  } catch (error) {
    console.error('pit-view: the agent drawer could not update', error)
  }
  restore(kept)
  hover.refresh()
  announce(view)
  announceRuns(view)
  announceSweeps(view)
  keepLastUpdate(view)
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
  // the page search follows the view it was typed against, so sections open for what it finds now
  setPageSearch: (query: string): void => {
    const view = feed.view
    const counts = view === null ? { mine: 0, others: 0, closed: 0 } : shownCounts(view, closedRangeOf(view, ui), ui.filters, query)
    update(setPageSearch(ui, query, counts))
  },
  toggleSection: (table: TableKey): void => update(toggleSection(ui, table)),
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
      idleMinutes: typeof config.idleMinutes === 'number' ? config.idleMinutes : 90,
    }
    idleTracker.setMinutes(settings.idleMinutes)
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
  state: () => ({ visible: visible(), paused: ui.paused, idle: ui.idle }),
  // read from storage each time, since another tab may have seen a newer cycle
  lastUpdate: () => readLastUpdate(scheduleStorage),
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

// idle after idleMinutes with no activity; only entering and leaving it is reported, so pointer
// moves cost a clock read and nothing more
const idleTracker = createIdleTracker({
  minutes: settings.idleMinutes,
  now: () => Date.now(),
  timers: { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
  onChange: (idle) => {
    ui.idle = idle
    void live.report()
    draw()
  },
})

// capturing on the window also catches focus and scroll on elements, which do not bubble
for (const name of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll', 'touchstart', 'focus']) {
  window.addEventListener(name, idleTracker.activity, { capture: true, passive: true })
}

// the header's page search: typing filters at once; Escape or the clear button empties it, and "/" brings the cursor there from anywhere no field has focus
const pageSearch = byId<HTMLInputElement>('page-search')
pageSearch.addEventListener('input', () => actions.setPageSearch(pageSearch.value))
pageSearch.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || pageSearch.value === '') return
  actions.setPageSearch('')
  event.preventDefault()
})
byId('page-search-clear').addEventListener('click', () => {
  actions.setPageSearch('')
  // the button hides itself, so focus goes back to the field
  pageSearch.focus()
})
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return
  const target = event.target instanceof Element ? event.target : null
  const applies = slashApplies({
    key: event.key,
    tag: target?.tagName ?? '',
    editable: target instanceof HTMLElement && target.isContentEditable,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    alt: event.altKey,
  })
  if (!applies) return
  event.preventDefault()
  pageSearch.focus()
  pageSearch.select()
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

const say = (text: string): void => {
  const live = byId('agent-live')
  // the same words twice in a row are still said again
  live.textContent = live.textContent === text ? `${text}\u00a0` : text
}

// the drawer opens from an Agent cell or the changes-requested banner, never starts anything by
// itself, and sends runs with this start's token. The report panel sits beside it
const reportPanel = createReportPanel({
  root: byId('report-panel'),
  nowMs,
  // back to the Open button that showed the report or the heading of the drawer it was opened from
  onClosed: (key) => (sweepDrawer.isOpen() ? sweepDrawer : drawer).focusKey(key, true),
  say,
})

const drawer = createDrawer({
  root: byId('drawer'),
  token: readToken(document),
  nowMs,
  rowOf: (number) => feed.view === null ? undefined : findOpenRow(feed.view, number),
  repo: () => feed.view?.repo ?? '',
  say,
  reports: reportPanel,
  // a PR in a settled sweep at its current head links to it; one in none shows nothing
  sweepLink: (number) => {
    const row = feed.view === null ? undefined : findOpenRow(feed.view, number)
    return feed.view === null || row === undefined ? null : sweepLinkFor(feed.view.sweeps.items, number, row.headOid)
  },
  openSweep: (link) => {
    drawer.close()
    sweepDrawer.open({ key: `sweep-link:${link.number}` }, { sweepId: link.sweepId, pr: link.number })
  },
})

// the sweep drawer is the repository's, not one PR's: the bot group's Run sweep and status open it, and so does the broom beside a Dependabot PR's agent button. It and the PR drawer never show together
const sweepDrawer = createSweepDrawer({
  root: byId('sweep-drawer'),
  token: readToken(document),
  nowMs,
  sweeps: () => feed.view === null ? null : feed.view.sweeps,
  say,
  reports: reportPanel,
})

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null
  const sweep = target?.closest<HTMLButtonElement>('button[data-sweep]') ?? null
  if (sweep === null) return
  const pr = sweep.dataset.sweepPr
  const id = sweep.dataset.sweepId
  drawer.close()
  if (sweep.dataset.sweep === 'start') {
    // a start that cannot run now still opens the drawer, which says why
    sweepDrawer.open({ key: 'sweep-start' }, { ask: sweep.getAttribute('aria-disabled') !== 'true' })
  } else {
    sweepDrawer.open({ key: pr === undefined ? 'sweep-status' : `sweep-link:${pr}` }, {
      ...(id === undefined ? {} : { sweepId: Number(id) }),
      ...(pr === undefined ? {} : { pr: Number(pr) }),
    })
  }
})

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null
  const cell = target?.closest<HTMLButtonElement>('button[data-agent="open"][data-pr]') ?? null
  const banner = target?.closest<HTMLButtonElement>('button[data-open-agent]') ?? null
  // the banner's Fix session opens the drawer with that start's confirmation already asked
  const fix = target?.closest<HTMLButtonElement>('button[data-fix-session]') ?? null
  if (cell !== null || banner !== null || fix !== null) {
    seedRuns()
    // the PR drawer and the sweep drawer never show together
    sweepDrawer.close()
  }
  if (cell !== null) drawer.open(Number(cell.dataset.pr), { key: `agent-open:${cell.dataset.pr}`, number: Number(cell.dataset.pr) })
  else if (banner !== null) drawer.open(Number(banner.dataset.openAgent), { key: `banner-open:${banner.dataset.openAgent}`, number: Number(banner.dataset.openAgent) })
  else if (fix !== null) drawer.open(Number(fix.dataset.fixSession), { key: `banner-fix:${fix.dataset.fixSession}`, number: Number(fix.dataset.fixSession) }, 'fix')
})

// Escape closes what is topmost: the report panel, a confirmation in the drawer, then the drawer
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  const target = event.target instanceof Element ? event.target : null
  // a text field of the page behind keeps its own Escape (a search box clears itself)
  const applies = escapeApplies({
    tag: target?.tagName ?? '',
    editable: target instanceof HTMLElement && target.isContentEditable,
    inPanel: target?.closest('#drawer, #sweep-drawer, #report-panel') != null,
  })
  if (applies && (drawer.escape() || sweepDrawer.escape())) event.preventDefault()
})

byId('pause').addEventListener('click', () => {
  ui.paused = !ui.paused
  writePaused(ui.paused)
  void live.report()
  draw()
})

document.addEventListener('visibilitychange', () => {
  // becoming visible is activity; when it ends idle, onChange has already reported the change
  const wasIdle = ui.idle
  if (visible()) idleTracker.activity()
  if (ui.idle === wasIdle) void live.report()
  // a returning page shows what it holds at once, with ages brought up to date
  if (visible()) draw()
})

// ages and "updated 38s ago" move with the clock; a local redraw, never a request
setInterval(() => {
  if (visible()) draw()
}, 15_000)

// a running cell's "running 3m · last step 20s ago" moves every second on its own, without a
// redraw; with no run in flight there is nothing to tick
setInterval(() => {
  if (visible()) tickTimers(document, nowMs())
}, 1_000)

// the Settings page says when it saved, so density and the agent column follow at once
try {
  new BroadcastChannel(configChannel).addEventListener('message', () => void loadSettings())
} catch {
  // without the channel the settings apply on the next stream open
}

mountStickyHeader(byId('site-header'))
mountThemeToggle(byId<HTMLButtonElement>('theme'))
void loadInstance().then((info) => {
  if (info !== null) showInstance(info)
})

// the stream first, so no patch is missed; the view follows once it opens
live.start()
