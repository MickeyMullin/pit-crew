// src/poller.ts
import type { Cache, CachedView, Cycle, CycleErrorKind, FinishResult, SectionFreshness, SnapshotKind, Trigger } from './cache.ts'
import { expandHome } from './config.ts'
import type { Clock, Config } from './config.ts'
import { deriveView, isMine } from './derive.ts'
import type { ClosedView, Counts, DerivedView, Freshness, MineSection, OpenRow, OthersSection, PersonView, RowRefresh, Tiles } from './derive.ts'
import { fetchClosedPrs, fetchOpenPrs, fetchPr, GhError } from './github.ts'
import type { Gh, RawOpenPr } from './github.ts'
import { agentCell, stackRunCover } from './launcher.ts'
import type { Queueing } from './launcher.ts'
import { baselineOf, compareRows, runEvent } from './notify.ts'
import type { NotifyEvent, RowBaseline } from './notify.ts'
import { scanReports } from './reports.ts'
import type { ReportInfo, ReportTarget } from './reports.ts'
import { createSweepMemory, sweepsView } from './sweeps.ts'
import type { SweepMemory, SweepsView } from './sweeps.ts'
import { closedSearchWindow, iso } from './time.ts'

export type { Trigger } from './cache.ts'

// setTimeout and clearTimeout, injected so tests can drive them with a fake clock
export type Timers = { set: (run: () => void, ms: number) => unknown, clear: (handle: unknown) => void }

export const systemTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

// the API shapes in section 3 of DESIGN.md that the server adds around the derived view

export type CycleView = Pick<Cycle, 'id' | 'trigger' | 'state' | 'startedAt' | 'finishedAt' | 'error' | 'errorKind' | 'prsUpdated' | 'prsTotal'>

export type UiSync = { activeClients: number, nextCycleAt: string | null }

export type Sync = {
  refreshSeconds: number
  lastSuccessAt: string | null
  ui: UiSync
  cycle: CycleView | null
  sections: { open: SectionFreshness, closed: SectionFreshness }
}

export type View = {
  version: number
  repo: string
  viewer: PersonView
  sync: Sync
  now: string
  // phase 4
  autoReview: null
  tiles: Tiles
  counts: Counts
  mine: MineSection
  others: OthersSection
  closed: ClosedView
  // Dependabot sweeps are their own concept, held beside the rows and not in their Agent cells
  sweeps: SweepsView
}

// rows and removed are keyed by PR number, and closed, when not null, replaces the Closed
// section; tiles, counts and sync are merged into the view; repo and viewer appear only when
// a saved config changed them
export type Patch = {
  version: number
  now: string
  rows: OpenRow[]
  removed: number[]
  closed: ClosedView | null
  tiles?: Tiles
  counts?: Counts
  sync?: Sync
  // the sweeps as they now stand, replacing the page's: sent whole whenever a sweep, the repository, or the start text's config changed
  sweeps?: SweepsView
  repo?: string
  viewer?: PersonView
}

export type PatchBody = Partial<Omit<Patch, 'version' | 'now'>>

export type RefreshResult = { started: boolean, cycle: number | null }

// a one-PR refresh: still open, found closed or merged (and removed from the open rows), or
// failed with GitHub's reason; joined when it rode along with a refresh already in flight
export type PrRefreshResult = {
  number: number
  outcome: 'open' | 'closed' | 'failed'
  joined: boolean
  error: string | null
  errorKind: Extract<RowRefresh, { state: 'failed' }>['errorKind'] | null
}

export type Poller = {
  // the whole dashboard from the cache, never waiting on GitHub
  view: () => Promise<View>
  // manual, config and autoReview one-shots; joins a running cycle
  refresh: (trigger: Exclude<Trigger, 'active' | 'interval'>) => RefreshResult
  // fetches one PR and patches its row, outside any cycle; joins a refresh of that PR in flight
  refreshPr: (number: number, repo?: string) => Promise<PrRefreshResult>
  // the refresh that follows a GitHub write: starts after the write settled, so an earlier one in flight, which may have read before the write, is followed by exactly one more
  refreshPrAfterWrite: (repo: string, number: number) => Promise<PrRefreshResult>
  // the clients changed; returns the cycle started or joined under the active rule, or null
  setActive: (activeCount: number, becameActive: boolean) => number | null
  // whatever writes the effective repo or viewer calls this in the same synchronous step: if either differs from what the poller last saw, the notification baseline's generation moves on at once; calling it with no change does nothing
  identityChanged: () => void
  // a saved config replaced `before`; emits the recomputed rows and starts a config cycle when needed
  configChanged: (before: Config) => Promise<void>
  // the launcher created this run in this process, or adopted it as still running at startup; only such runs notify, and each at most once when it settles
  runWatched: (run: { id: number, repo: string, number: number }) => void
  // a run of this PR started, stepped or settled: one patch upserting its row
  runChanged: (repo: string, number: number) => void
  // something that can change a row's Agent cell or the launcher's answer to whether a new review would wait happened: every open row is derived again and sent, whether or not it differs from any earlier one
  queueingChanged: () => void
  // a sweep of this repo started, stepped, or settled: one patch carrying the sweeps whole
  sweepsChanged: (repo: string) => void
  // resolves once no cycle is running, including any follow-up cycle
  idle: () => Promise<void>
  // clears the timer and fails a running cycle; nothing starts afterward
  stop: () => void
  version: () => number
}

export type PollerOptions = {
  cache: Cache
  gh: Gh
  clock: Clock
  timers: Timers
  // the config in effect, read afresh at every step
  config: () => Config
  home: string
  // the machine's IANA zone
  timeZone: string
  // receives every patch, in version order
  emit: (patch: Patch) => void
  log?: (line: string) => void
  // runs before a cycle fetches anything; a throw fails the cycle
  beforeCycle?: () => Promise<void>
  pageSize?: number
  // the active trigger's floor: no cycle when the last one started this recently
  activeFloorMs?: number
  // the sweeps held in memory; none when left out
  sweeps?: SweepMemory
  // receives the notification events a transition produces (section 9); the notifier decides whether the config wants them
  notify?: (events: NotifyEvent[]) => void
  // whether a new review of each kind would wait in the queue now, read from the launcher that decides it; the review buttons in the Agent cells say so. None when left out
  queueing?: () => Queueing
  // reads the reports folder; the real scan when left out, and a test holds it open to pin the order of events around a config save
  scan?: typeof scanReports
}

// thrown from the page callback to stop pagination once the cycle has failed
class CycleStopped extends Error {
  override name = 'CycleStopped'
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

const cycleView = (cycle: Cycle | null): CycleView | null => cycle === null ? null : {
  id: cycle.id,
  trigger: cycle.trigger,
  state: cycle.state,
  startedAt: cycle.startedAt,
  finishedAt: cycle.finishedAt,
  error: cycle.error,
  errorKind: cycle.errorKind,
  prsUpdated: cycle.prsUpdated,
  prsTotal: cycle.prsTotal,
}

// the cache read once and derived once: what every view and patch is cut from
type Snapshot = { cached: CachedView, view: DerivedView, rows: Map<number, OpenRow> }

// configs whose change needs GitHub again, since they change which rows exist or what they say
export const cycleKeys = ['repo', 'viewer', 'people', 'tickets', 'bots'] as const
const reportKeys = ['repo', 'viewer', 'reportsDir'] as const
const capKeys = ['maxConcurrentReviews', 'selfReviewOverCap'] as const

export const createPoller = (options: PollerOptions): Poller => {
  const { cache, gh, clock, timers, home, timeZone, emit } = options
  const scan = options.scan ?? scanReports
  const config = options.config
  const log = options.log ?? (() => {})
  const activeFloorMs = options.activeFloorMs ?? 30_000
  const pageSize = options.pageSize ?? 100

  let version = 0
  let activeCount = 0
  let timer: unknown = null
  let current: { cycle: Cycle, done: Promise<void> } | null = null
  // a repo change that arrived while a cycle for the old repo ran
  let followUp = false
  let stopped = false
  // the ui part of sync as pages last received it; every view starts with no active client
  let lastUi = JSON.stringify({ activeClients: 0, nextCycleAt: null })
  // the start of the last cycle of any trigger, which both the active and interval rules count from
  let lastStart: number | null = (() => {
    const latest = cache.latestCycle(config().repo)
    return latest === null ? null : Date.parse(latest.startedAt)
  })()

  const notify = options.notify ?? (() => {})
  const sweeps = options.sweeps ?? createSweepMemory(cache)
  // notifications (section 9): the rows as last compared, and the runs this process is responsible for watching, by run id, until each settles
  // the baseline carries the identity it was built for: its repo and viewer, and the generation, which identityChanged bumps at the moment either changes, since work begun before a change away and back cannot be told apart from work of the identity in effect by repo and viewer alone
  let baseline: RowBaseline | null = null
  let generation = 0
  let baselineGeneration = 0
  let identity = { repo: config().repo, viewer: config().viewer }
  const watched = new Map<number, { repo: string, number: number }>()

  // self-review reports for the viewer's PRs, and the head branch each was looked up for
  let reports = new Map<number, ReportInfo>()
  let scanned: Map<number, string> | null = null

  const reportsDir = (settings: Config): string => expandHome(settings.reportsDir, home)

  const ownTargets = (prs: readonly RawOpenPr[], settings: Config): ReportTarget[] =>
    prs.filter((pr) => isMine(pr, settings)).map((pr) => ({ number: pr.number, headRefName: pr.headRefName }))

  // every cached own PR, at the start of each cycle and whenever the config moves the folder
  const rescan = async (settings: Config): Promise<void> => {
    const targets = ownTargets(cache.readView(settings.repo).open.map((row) => row.pr), settings)
    try {
      reports = await scan(reportsDir(settings), targets)
      scanned = new Map(targets.map((target) => [target.number, target.headRefName]))
    } catch (error) {
      log(`reports: cannot scan ${settings.reportsDir}: ${messageOf(error)}`)
      scanned ??= new Map()
    }
  }

  // own PRs a page brings that the cycle's scan did not cover (new, or on a new branch), or with
  // force every own PR given, since a one-PR refresh may be after a new report
  const scanNew = async (prs: readonly RawOpenPr[], settings: Config, force = false): Promise<void> => {
    const known = scanned ?? new Map<number, string>()
    const targets = ownTargets(prs, settings).filter((target) => force || known.get(target.number) !== target.headRefName)
    if (targets.length === 0) return
    try {
      const found = await scan(reportsDir(settings), targets)
      for (const target of targets) {
        known.set(target.number, target.headRefName)
        const report = found.get(target.number)
        if (report === undefined) {
          reports.delete(target.number)
        } else {
          reports.set(target.number, report)
        }
      }
      scanned = known
    } catch (error) {
      log(`reports: cannot scan ${settings.reportsDir}: ${messageOf(error)}`)
    }
  }

  // one-PR refreshes by repo and number: running, or failed until the row is next fetched
  const rowRefreshes = new Map<string, RowRefresh>()
  const prJobs = new Map<string, Promise<PrRefreshResult>>()
  const prKey = (repo: string, number: number): string => `${repo}#${number}`

  // the launcher's answer to whether a new review would wait; nothing remembers what any page received, since one remembered value cannot describe pages that loaded at different moments
  const noQueueing: Queueing = { review: false, selfReview: false }
  const queueingNow = (): Queueing => options.queueing?.() ?? noQueueing

  const snapshot = (settings: Config, reportMap: ReadonlyMap<number, ReportInfo>, queueing: Queueing = queueingNow()): Snapshot => {
    const cached = cache.readView(settings.repo)
    const runs = cache.latestRuns(settings.repo)
    // derived on every read from the runs and the PRs as they are now, so nothing remembers which layers a stack run covered
    const cover = stackRunCover(runs.values(), cached.open.map((row) => row.pr))
    const freshness = new Map<number, Freshness>(cached.open.map((row) => [row.number, { state: row.freshness.state, fetchedAt: row.freshness.fetchedAt }]))
    const view = deriveView({
      open: cached.open.map((row) => row.pr),
      defaultBranch: cached.defaultBranch,
      closed: cached.closed?.result.prs ?? [],
    }, {
      config: settings,
      clock,
      timeZone,
      reports: reportMap,
      freshness: (number) => freshness.get(number) ?? { state: 'current', fetchedAt: iso(clock.now()) },
      refresh: (number) => rowRefreshes.get(prKey(settings.repo, number)) ?? null,
      agent: (pr, stack) => agentCell(pr, settings, runs.get(pr.number), reportMap.get(pr.number), stack, queueing, cover.get(pr.number)),
    })
    const rows = new Map<number, OpenRow>()
    for (const group of [...view.mine.groups, ...view.others.groups]) {
      for (const row of group.rows) rows.set(row.number, row)
    }
    return { cached, view, rows }
  }

  // the previous state transitions are compared against, taken from the cache before a fetch changes it; the first load (nothing ever fetched, or no rows) fires nothing. It is kept for one repo and viewer: a change of either rebuilds it silently, and while the viewer is still unresolved (empty) there is none, so nothing compares.
  const ensureBaseline = (settings: Config): void => {
    if (settings.viewer === '') {
      baseline = null
    } else if (baselineFor(settings) === null) {
      const snap = snapshot(settings, reports)
      baseline = baselineOf(settings.repo, settings.viewer, [...snap.rows.values()], snap.cached.lastSuccessAt !== null)
      baselineGeneration = generation
    }
  }

  const identityChanged = (): void => {
    const { repo, viewer } = config()
    if (repo === identity.repo && viewer === identity.viewer) return
    identity = { repo, viewer }
    generation += 1
  }

  // the baseline, if it is for the repo, viewer, and generation in effect
  const baselineFor = (settings: Config): RowBaseline | null =>
    baseline !== null && baseline.repo === settings.repo && baseline.viewer === settings.viewer && baselineGeneration === generation ? baseline : null

  // a cycle or a one-PR refresh that began under an older generation compares nothing; when it succeeds, the baseline for the settings in effect is an empty one unless a newer path has already built one, so the next comparison records the rows and fires nothing
  const installEmptyBaseline = (settings: Config): void => {
    if (settings.viewer === '' || baselineFor(settings) !== null) return
    baseline = baselineOf(settings.repo, settings.viewer, [], false)
    baselineGeneration = generation
  }

  // the next interval cycle: refreshSeconds after the last start of any trigger, only while a client is active
  const nextDue = (): number | null => {
    if (activeCount === 0) return null
    return lastStart === null ? clock.now() : lastStart + config().refreshSeconds * 1000
  }

  const uiSync = (): UiSync => {
    const due = nextDue()
    return { activeClients: activeCount, nextCycleAt: due === null ? null : iso(due) }
  }

  const syncOf = (cached: CachedView, settings: Config): Sync => ({
    refreshSeconds: settings.refreshSeconds,
    lastSuccessAt: cached.lastSuccessAt,
    ui: uiSync(),
    cycle: cycleView(cached.cycle),
    sections: cached.sections,
  })

  const syncNow = (): Sync => syncOf(cache.readView(config().repo), config())

  // the one place versions are assigned: exactly one more per patch
  const patch = (body: PatchBody): void => {
    version += 1
    const full: Patch = { version, now: iso(clock.now()), rows: [], removed: [], closed: null, ...body }
    if (full.sync !== undefined) lastUi = JSON.stringify(full.sync.ui)
    emit(full)
  }

  const emitUiIfChanged = (): void => {
    if (JSON.stringify(uiSync()) !== lastUi) patch({ sync: syncNow() })
  }

  const schedule = (): void => {
    if (timer !== null) {
      timers.clear(timer)
      timer = null
    }
    // no timer while nothing is active, and none while a cycle runs: its end reschedules
    if (stopped || activeCount === 0 || current !== null) return
    const due = nextDue()
    if (due === null) return
    timer = timers.set(() => {
      timer = null
      if (activeCount === 0 || current !== null || start('interval') === null) schedule()
    }, Math.max(0, due - clock.now()))
  }

  // one patch per arrived open-PR page: its rows (or their removal when now hidden), tiles, counts, sync
  const applyPage = (numbers: readonly number[], sent: Map<number, string>): void => {
    const settings = config()
    const snap = snapshot(settings, reports)
    const rows: OpenRow[] = []
    const removed: number[] = []
    for (const number of numbers) {
      const row = snap.rows.get(number)
      if (row === undefined) {
        removed.push(number)
      } else {
        rows.push(row)
        sent.set(number, JSON.stringify(row))
      }
    }
    patch({ rows, removed, tiles: snap.view.tiles, counts: snap.view.counts, sync: syncOf(snap.cached, settings) })
  }

  const applyClosed = (): void => {
    const settings = config()
    const snap = snapshot(settings, reports)
    patch({ closed: snap.view.closed, tiles: snap.view.tiles, sync: syncOf(snap.cached, settings) })
  }

  // the end of a cycle: removals, every row that changed since its page patch (based-on indications span
  // pages) or that the cycle never reached (now stale), and the final sync
  const applyFinish = (finished: FinishResult, sent: ReadonlyMap<number, string>): void => {
    const settings = config()
    const snap = snapshot(settings, reports)
    const rows = [...snap.rows.values()].filter((row) => sent.get(row.number) !== JSON.stringify(row))
    patch({ rows, removed: finished.removed, tiles: snap.view.tiles, counts: snap.view.counts, sync: syncOf(snap.cached, settings) })
  }

  const run = async (cycle: Cycle): Promise<void> => {
    const { repo } = cycle
    let failure: string | null = null
    let failureKind: CycleErrorKind | null = null
    let pagesDone = 0
    const sent = new Map<number, string>()
    let startedGeneration = generation
    const startedUnresolved = config().viewer === ''
    if (!stopped && config().repo === repo) ensureBaseline(config())
    const live = (): boolean => !stopped && failure === null
    // a cycle for a repo the config has since left still fills the cache but patches nothing
    const shown = (): boolean => config().repo === repo

    const fail = (kind: SnapshotKind, page: number | null, error: unknown): void => {
      if (stopped) return
      const message = messageOf(error)
      if (failure === null) {
        failure = message
        failureKind = error instanceof GhError ? error.kind : 'internal'
      }
      try {
        cache.recordError(cycle.id, kind, page, message)
      } catch (recordError) {
        log(`cycle ${cycle.id}: cannot record the error: ${messageOf(recordError)}`)
      }
      log(`cycle ${cycle.id}: ${kind}${page === null ? '' : ` ${page}`} failed: ${message}`)
    }

    try {
      await options.beforeCycle?.()
    } catch (error) {
      fail('open-page', 1, error)
    }
    // a cycle that began with the viewer unresolved has no baseline and has fetched nothing yet, and it may be the one whose beforeCycle just resolved the viewer, so its generation starts here
    if (startedUnresolved) startedGeneration = generation
    // a viewer that was unresolved at the start is known now: its first comparison is a baseline. A cycle the generation has left installs nothing here, so that it installs nothing if it goes on to fail
    if (live() && startedGeneration === generation && config().repo === repo && baselineFor(config()) === null && config().viewer !== '') {
      baseline = baselineOf(repo, config().viewer, [], false)
      baselineGeneration = generation
    }
    if (live()) await rescan(config())

    if (live()) {
      const window = closedSearchWindow(clock, { todayStartsAt: config().todayStartsAt, timeZone })
      // the two fetch units run concurrently; the first failure stops both
      const openUnit = fetchOpenPrs(gh, repo, async (page) => {
        if (!live()) throw new CycleStopped()
        await scanNew(page.prs, config())
        if (!live()) throw new CycleStopped()
        const written = cache.writeOpenPage(cycle.id, page)
        // a row the cycle fetched no longer carries its own failed refresh
        for (const row of written) {
          if (rowRefreshes.get(prKey(repo, row.number))?.state === 'failed') rowRefreshes.delete(prKey(repo, row.number))
        }
        pagesDone = page.page
        if (shown()) applyPage(written.map((row) => row.number), sent)
      }, { pageSize }).then(() => {}, (error: unknown) => {
        if (!(error instanceof CycleStopped)) fail('open-page', pagesDone + 1, error)
      })
      const closedUnit = fetchClosedPrs(gh, repo, window.from, window.to, { pageSize }).then((result) => {
        if (!live()) return
        cache.writeClosed(cycle.id, result)
        if (shown()) applyClosed()
      }).catch((error: unknown) => fail('closed', null, error))
      await Promise.all([openUnit, closedUnit])
    }

    if (stopped) return
    const finished = cache.finishCycle(cycle.id, failure, failureKind)
    log(`cycle ${cycle.id} (${cycle.trigger}) ${failure === null ? `finished: ${finished.cycle.prsUpdated} PRs, ${finished.removed.length} removed` : `failed: ${failure}`}`)
    if (shown()) applyFinish(finished, sent)
    // only a finished cycle compares; after a failed one the next success compares against the same baseline, so a transition is neither lost nor fired from stale rows, and a failed one the generation has left installs nothing, so the next cycle or refresh rebuilds from the cache
    if (failure === null && shown()) {
      const current = config()
      if (startedGeneration !== generation) {
        installEmptyBaseline(current)
        return
      }
      const known = baselineFor(current)
      if (known !== null) notify(compareRows(known, snapshot(current, reports).rows))
    }
  }

  const settle = (cycle: Cycle): void => {
    if (current?.cycle.id === cycle.id) current = null
    if (stopped) return
    if (followUp) {
      followUp = false
      if (start('config') !== null) return
    }
    schedule()
  }

  const start = (trigger: Trigger): Cycle | null => {
    if (stopped || current !== null) return null
    let cycle: Cycle
    try {
      cycle = cache.startCycle(config().repo, trigger)
    } catch (error) {
      log(`cannot start a ${trigger} cycle: ${messageOf(error)}`)
      // counted as a start, so a broken cache retries at the interval rather than at once
      lastStart = clock.now()
      schedule()
      return null
    }
    lastStart = clock.now()
    const entry = { cycle, done: Promise.resolve() }
    current = entry
    schedule()
    log(`cycle ${cycle.id} (${trigger}) started`)
    patch({ sync: syncNow() })
    entry.done = run(cycle)
      .catch((error: unknown) => {
        log(`cycle ${cycle.id} crashed: ${messageOf(error)}`)
        if (cache.cycle(cycle.id)?.state === 'running') cache.finishCycle(cycle.id, `internal error: ${messageOf(error)}`, 'internal')
      })
      .finally(() => settle(cycle))
    return cycle
  }

  const refresh = (trigger: Exclude<Trigger, 'active' | 'interval'>): RefreshResult => {
    if (current !== null) return { started: false, cycle: current.cycle.id }
    const cycle = start(trigger)
    return { started: cycle !== null, cycle: cycle?.id ?? null }
  }

  // one PR on its own: a patch marking its row refreshing, the fetch, then one patch with that row and any other its change moved (based-on indications), or its removal once closed; a failure stays on the row and never touches the cycles, so the board does not read offline. repo is the repository the caller meant (a write's), not whatever the configuration says now: while it is not the one in effect, the cache of that repository is still refreshed, but nothing of it reaches the board, the baseline, or a notification
  const runPrRefresh = async (number: number, repo: string): Promise<PrRefreshResult> => {
    const settings = config()
    const key = prKey(repo, number)
    const startedGeneration = generation
    const shown = (): boolean => !stopped && config().repo === repo
    const before = shown() ? snapshot(settings, reports) : null
    if (shown()) ensureBaseline(settings)
    rowRefreshes.set(key, { state: 'running', startedAt: iso(clock.now()) })
    const started = shown() ? snapshot(settings, reports).rows.get(number) : undefined
    if (started !== undefined) patch({ rows: [started] })
    let outcome: PrRefreshResult['outcome'] = 'failed'
    let failure: Extract<RowRefresh, { state: 'failed' }> | null = null
    try {
      // numbered before the read begins, so a newer read that lands first is not overwritten by this older one
      const ticket = cache.beginRefresh()
      const found = await fetchPr(gh, repo, number)
      if (!stopped) {
        if (found.state === 'OPEN') {
          if (shown()) await scanNew([found.pr], config(), true)
          cache.writePr(repo, found.pr, found.defaultBranch, ticket)
        } else {
          // the next cycle's closed search shows it in Closed
          cache.closePr(repo, number, ticket)
        }
        // what the cache holds now, which is the newer read's answer when one got there first
        outcome = cache.readView(repo).open.some((row) => row.number === number) ? 'open' : 'closed'
      }
      rowRefreshes.delete(key)
    } catch (error) {
      failure = { state: 'failed', at: iso(clock.now()), error: messageOf(error), errorKind: error instanceof GhError ? error.kind : 'internal' }
      rowRefreshes.set(key, failure)
      log(`PR #${number}: refresh failed: ${failure.error}`)
    }
    // what happens now is decided by what is on show now: a refresh that began off the board has no earlier rows to tell a change by, so it sends them all, and its own is the only one it can have removed
    if (shown()) {
      const next = snapshot(config(), reports)
      const rows = [...next.rows.values()].filter((row) => row.number === number || !same(row, before?.rows.get(row.number)))
      const removed = before === null ? [number].filter((known) => !next.rows.has(known)) : [...before.rows.keys()].filter((known) => !next.rows.has(known))
      patch({ rows, removed, tiles: next.view.tiles, counts: next.view.counts })
      if (failure === null) {
        if (startedGeneration !== generation) {
          installEmptyBaseline(config())
        } else {
          const known = baselineFor(config())
          if (known !== null) notify(compareRows(known, next.rows, number))
        }
      }
    }
    return { number, outcome, joined: false, error: failure?.error ?? null, errorKind: failure?.errorKind ?? null }
  }

  const refreshPr = (number: number, repo: string = config().repo): Promise<PrRefreshResult> => {
    const key = prKey(repo, number)
    const running = prJobs.get(key)
    if (running !== undefined) return running.then((result) => ({ ...result, joined: true }))
    const job = runPrRefresh(number, repo).finally(() => prJobs.delete(key))
    prJobs.set(key, job)
    return job
  }

  // a refresh in flight may have read GitHub before the write, so joining it could show the old state; one more starts when it ends, and any number of asks meanwhile share that one
  const afterWrite = new Map<string, Promise<PrRefreshResult>>()
  const refreshPrAfterWrite = (repo: string, number: number): Promise<PrRefreshResult> => {
    const key = prKey(repo, number)
    const running = prJobs.get(key)
    if (running === undefined) return refreshPr(number, repo)
    const queued = afterWrite.get(key)
    if (queued !== undefined) return queued
    const next = running.catch(() => undefined).then(() => {
      afterWrite.delete(key)
      return refreshPr(number, repo)
    })
    afterWrite.set(key, next)
    return next
  }

  const setActive = (count: number, becameActive: boolean): number | null => {
    activeCount = count
    let joined: number | null = null
    if (becameActive && !stopped) {
      if (current !== null) joined = current.cycle.id
      else if (lastStart === null || clock.now() - lastStart > activeFloorMs) joined = start('active')?.id ?? null
    }
    schedule()
    emitUiIfChanged()
    return joined
  }

  const configChanged = async (before: Config): Promise<void> => {
    // synchronously, before any await: a change made in the caller's own synchronous step, such as the login a save just looked up, is noted here
    identityChanged()
    const previousReports = reports
    if (reportKeys.some((key) => !same(before[key], config()[key]))) await rescan(config())
    // read after the rescan, so the new config is the one in effect now and not one taken before the await
    const after = config()
    const changed = (key: keyof Config): boolean => !same(before[key], after[key])
    // both sides come from the cache as it is now, so the difference is the config's alone
    const queueing = queueingNow()
    const previous = snapshot(before, previousReports, queueing)
    const next = snapshot(after, reports, queueing)
    // a cap or overage setting that moved can change the review buttons of every row, which the launcher cannot announce since it reads the config as it is
    const everyRow = capKeys.some(changed)
    const body: PatchBody = {
      rows: [...next.rows.values()].filter((row) => everyRow || !same(row, previous.rows.get(row.number))),
      removed: [...previous.rows.keys()].filter((number) => !next.rows.has(number)),
      closed: same(previous.view.closed, next.view.closed) ? null : next.view.closed,
      tiles: next.view.tiles,
      counts: next.view.counts,
      sync: syncOf(next.cached, after),
    }
    // the repository, the viewer, and cloneDir all show in the sweep's start text, and the cap can change what Run sweep says, as it can a row's buttons
    const sweepsBefore = sweepsView(before, sweeps, queueing)
    const sweepsAfter = sweepsView(after, sweeps, queueing)
    if (everyRow || !same(sweepsBefore, sweepsAfter)) body.sweeps = sweepsAfter
    if (changed('repo')) body.repo = after.repo
    if (!same(previous.view.viewer, next.view.viewer)) body.viewer = next.view.viewer
    patch(body)
    if (changed('refreshSeconds')) schedule()
    if (!cycleKeys.some(changed)) return
    // a running cycle for the same repo is joined; one for the old repo is followed by a fresh one
    if (current !== null && current.cycle.repo !== after.repo) {
      followUp = true
    } else {
      refresh('config')
    }
  }

  const runWatched = (run: { id: number, repo: string, number: number }): void => {
    watched.set(run.id, { repo: run.repo, number: run.number })
  }

  // something that can change the queue answer happened: every open row of the repository on show, and Run sweep, go with the answer now, whether or not it differs from any earlier one
  const queueingChanged = (): void => {
    if (stopped) return
    const settings = config()
    const queueing = queueingNow()
    patch({ rows: [...snapshot(settings, reports, queueing).rows.values()], sweeps: sweepsView(settings, sweeps, queueing) })
  }

  const runChanged = (repo: string, number: number): void => {
    if (stopped) return
    // the rows go out with the launcher's one coalesced announcement (queueingChanged), which every run change marks, so this sends none and derives only for a notification
    // a watched run is looked up by id, so it counts even when its PR has left the open rows; once settled it is forgotten, which is what makes it fire at most once
    for (const [id, found] of watched) {
      if (found.repo !== repo || found.number !== number) continue
      const run = cache.getRun(id)
      // a review waiting in the queue has not settled either
      if (run?.status === 'running' || run?.status === 'queued') continue
      watched.delete(id)
      // the repository in effect is the run's own, decided here and not by any scan in flight
      if (run === null || config().repo !== repo) continue
      const row = snapshot(config(), reports, queueingNow()).rows.get(number)
      const event = runEvent(repo, { number, title: row?.title ?? null }, run.status)
      if (event !== null) notify([event])
    }
  }

  const sweepsChanged = (repo: string): void => {
    if (stopped) return
    const settings = config()
    if (settings.repo === repo) patch({ sweeps: sweepsView(settings, sweeps, queueingNow()) })
  }

  const view = async (): Promise<View> => {
    if (scanned === null) await rescan(config())
    // read and derive in one synchronous step, so version matches what the view holds
    const settings = config()
    const snap = snapshot(settings, reports)
    return {
      version,
      repo: settings.repo,
      viewer: snap.view.viewer,
      sync: syncOf(snap.cached, settings),
      now: snap.view.now,
      autoReview: null,
      tiles: snap.view.tiles,
      counts: snap.view.counts,
      mine: snap.view.mine,
      others: snap.view.others,
      closed: snap.view.closed,
      sweeps: sweepsView(settings, sweeps, queueingNow()),
    }
  }

  const idle = async (): Promise<void> => {
    while (current !== null) await current.done
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (timer !== null) timers.clear(timer)
    timer = null
    if (current !== null) {
      try {
        cache.finishCycle(current.cycle.id, 'stopped: Pit View shut down before the cycle finished', 'interrupted')
      } catch (error) {
        log(`cannot close cycle ${current.cycle.id}: ${messageOf(error)}`)
      }
      current = null
    }
  }

  return { view, refresh, refreshPr, refreshPrAfterWrite, setActive, identityChanged, configChanged, runWatched, runChanged, queueingChanged, sweepsChanged, idle, stop, version: () => version }
}
