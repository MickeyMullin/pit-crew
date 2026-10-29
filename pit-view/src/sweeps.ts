// src/sweeps.ts
import type { Cache, Sweep } from './cache.ts'
import type { Config, RunnerName } from './config.ts'
import { doneText, stepsOf } from './launcher.ts'
import type { CiState, PostForm, Priority, Recommendation, StartRequest, StepSlot, SweepResult } from './launcher.ts'

// the Dependabot sweep as a concept of its own (section 8 of DESIGN.md, Sweeps): the command line it launches, what the confirmation says, the view the page draws from a sweep record, and the sweeps held in memory beside the runs. Launching is the launcher's: createSweepLauncher

export const sweepCommand = 'review-dependabot-sweep'
export const sweepLabel = 'Dependabot sweep'

// the sweep's arguments, without --emit-json, which the launcher adds: the repository and one reviewer at a time. Never --no-post: approving and requesting at one stroke is what a sweep is for
export const sweepArgs = (repo: string): string[] => [repo, '--parallel', '1']

// a sweep has no PR; the number is ignored by the sweeps store and never written anywhere
export const sweepRequest = (repo: string, runner?: RunnerName): StartRequest => ({
  repo,
  number: 0,
  command: sweepCommand,
  args: sweepArgs(repo),
  label: sweepLabel,
  ...(runner === undefined ? {} : { runner }),
})

// what the confirmation tells the owner before a sweep starts: that it covers the repository, that it runs one reviewer at a time, and that the reviewers post on GitHub as the viewer. Pit View posts nothing itself
export type SweepStart = {
  heading: string
  repo: string
  // the viewer the reviewers post as, which the start request carries back so the server refuses it when that is no longer the viewer in effect
  viewer: string
  // the command as the runner receives it (Pit View adds --emit-json): a slash for Claude, a dollar sign for Codex
  command: string
  serial: string
  posts: string
  runners: RunnerName[]
  // the configured default, which the confirmation offers first
  runner: RunnerName
  // why it cannot start right now; null otherwise
  unavailable: string | null
}

export const sweepStartOf = (config: Config, busy: boolean): SweepStart => ({
  heading: `Sweep the open Dependabot PRs in ${config.repo}?`,
  repo: config.repo,
  viewer: config.viewer,
  command: [sweepCommand, ...sweepArgs(config.repo)].join(' '),
  serial: 'It reviews one PR at a time (--parallel 1), then writes one summary with a merge order.',
  posts: `Its reviewers post on GitHub as @${config.viewer}: each may approve a clean bump, request changes, or comment, one post per PR. It never merges or pushes.`,
  runners: ['claude', 'codex'],
  runner: config.agent.runner,
  unavailable: busy
    ? `a sweep for ${config.repo} is already in flight`
    : config.cloneDir === undefined ? `set cloneDir in the config to your local clone of ${config.repo} before starting a sweep` : null,
})

// the parsed sweep-result@1, as far as the page draws it. Rows come through the launcher's check only as a list, so each field is read defensively here; notPostedReason is not read at all
export type SweepFinding = { priority: Priority, summary: string }

export type SweepRow = {
  number: number
  url: string
  title: string
  // the full SHA and its first seven characters
  head: string
  headShort: string
  bump: string
  recommendation: Recommendation | null
  ci: CiState | null
  findings: SweepFinding[]
  escalation: string | null
  posted: { form: PostForm, url: string } | null
  reused: boolean
  report: string | null
  notes: string
}

export type SweepAction = { action: string, prs: number[] }

export type SweepSummary = {
  status: SweepResult['status']
  repo: string | null
  // null when the sweep stopped before it had any: the page shows no counts then, not zeros
  counts: { swept: number, fresh: number, reused: number, failed: number } | null
  rows: SweepRow[]
  mergeOrder: SweepAction[]
  // the Markdown summary's path, written with ~; null when there was nothing to sweep
  summary: string | null
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const textOrNull = (value: unknown): string | null => typeof value === 'string' && value !== '' ? value : null
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | null => allowed.includes(value as T) ? value as T : null
const positive = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0

const recommendations: readonly Recommendation[] = ['approve', 'fixBeforeMerge', 'hold', 'doNotMerge']
const ciStates: readonly CiState[] = ['green', 'failed', 'pending', 'none']
const priorities: readonly Priority[] = ['P0', 'P1', 'P2', 'P3']
const postForms: readonly PostForm[] = ['approve', 'requestChanges', 'comment']

// a row that is not an object with a PR number is dropped: it cannot be drawn or linked
const sweepRow = (value: unknown): SweepRow | null => {
  if (!isObject(value) || !positive(value.number)) return null
  const head = text(value.head)
  const posted = isObject(value.posted) ? oneOf(value.posted.form, postForms) : null
  const notes = Array.isArray(value.notes) ? value.notes.filter((note) => typeof note === 'string').join('; ') : text(value.notes)
  return {
    number: value.number,
    url: text(value.url),
    title: text(value.title),
    head,
    headShort: head.slice(0, 7),
    bump: text(value.bump),
    recommendation: oneOf(value.recommendation, recommendations),
    ci: oneOf(value.ci, ciStates),
    findings: (Array.isArray(value.findings) ? value.findings : []).flatMap((finding): SweepFinding[] => {
      const priority = isObject(finding) ? oneOf(finding.priority, priorities) : null
      return priority === null || !isObject(finding) ? [] : [{ priority, summary: text(finding.summary) }]
    }),
    escalation: textOrNull(value.escalation),
    posted: posted === null || !isObject(value.posted) ? null : { form: posted, url: text(value.posted.url) },
    reused: value.reused === true,
    report: textOrNull(value.report),
    notes,
  }
}

const sweepAction = (value: unknown): SweepAction | null => {
  if (!isObject(value)) return null
  return { action: text(value.action), prs: (Array.isArray(value.prs) ? value.prs : []).filter(positive) }
}

export const sweepSummary = (result: SweepResult): SweepSummary => ({
  status: result.status,
  repo: result.repo,
  counts: result.counts,
  rows: result.rows.flatMap((row) => sweepRow(row) ?? []),
  mergeOrder: result.mergeOrder.flatMap((action) => sweepAction(action) ?? []),
  summary: result.summary,
})

const sweepResultOf = (sweep: Pick<Sweep, 'result'>): SweepResult | null =>
  sweep.result?.schema === 'pit-crew/sweep-result@1' ? sweep.result : null

// the sweep as the page and GET /api/sweeps see it: the record, its steps, the parsed result, and the words for how it ended
export type SweepView = Omit<Sweep, 'result' | 'steps'> & {
  steps: StepSlot[]
  // null while it runs
  text: string | null
  // the question while it waits for an answer
  question: string | null
  result: SweepSummary | null
}

// "Done · 7 swept, 1 failed", "Done · nothing to sweep": a sweep with nothing to sweep is done, never a failure
export const sweepText = (sweep: Pick<Sweep, 'status' | 'result' | 'note'>): string | null => {
  if (sweep.status === 'running') return null
  if (sweep.status !== 'done') return doneText(sweep, false)
  const counts = sweepResultOf(sweep)?.counts
  if (counts == null || counts.swept === 0) return 'Done · nothing to sweep'
  return `Done · ${counts.swept} swept${counts.failed > 0 ? `, ${counts.failed} failed` : ''}`
}

export const sweepView = (sweep: Sweep): SweepView => {
  const { result, steps: _steps, ...rest } = sweep
  const parsed = sweepResultOf(sweep)
  return {
    ...rest,
    steps: stepsOf(sweep),
    text: sweepText(sweep),
    question: sweep.status === 'needsInput' ? parsed?.question ?? null : null,
    result: parsed === null || result === null ? null : sweepSummary(parsed),
  }
}

// the sweeps in memory, beside the runs state: loaded from the cache, then kept current by the launcher's changes, so a read never waits on the database or on GitHub (section 8, Sweeps)
export type SweepMemory = {
  // the newest sweeps of a repo, newest first, with their parsed results
  list: (repo: string) => SweepView[]
  get: (id: number) => SweepView | undefined
  // a sweep started, stepped, or settled
  set: (sweep: Sweep) => void
  // reads a repo's recorded sweeps from the cache, replacing what memory holds for them
  load: (repo: string) => void
  // sweeps the cache pruned: memory drops the same ids, so it never holds what the table does not
  drop: (ids: readonly number[]) => void
}

export const createSweepMemory = (cache: Cache, keep = 20): SweepMemory => {
  const sweeps = new Map<number, Sweep>()
  const loaded = new Set<string>()
  const load = (repo: string): void => {
    loaded.add(repo)
    for (const sweep of cache.sweepsFor(repo, keep)) sweeps.set(sweep.id, sweep)
  }
  return {
    list: (repo) => {
      if (!loaded.has(repo)) load(repo)
      return [...sweeps.values()].filter((sweep) => sweep.repo === repo).sort((a, b) => b.id - a.id).slice(0, keep).map(sweepView)
    },
    get: (id) => {
      const sweep = sweeps.get(id)
      return sweep === undefined ? undefined : sweepView(sweep)
    },
    set: (sweep) => {
      sweeps.set(sweep.id, sweep)
    },
    drop: (ids) => {
      for (const id of ids) sweeps.delete(id)
    },
    load,
  }
}

// what the page holds about sweeps: how to start one now, and the repo's recent sweeps. Patches carry it whole whenever a sweep or the config behind the start text changes
export type SweepsView = { start: SweepStart, items: SweepView[] }

export const sweepsView = (config: Config, memory: SweepMemory): SweepsView => {
  const items = memory.list(config.repo)
  return { start: sweepStartOf(config, items.some((sweep) => sweep.status === 'running')), items }
}
