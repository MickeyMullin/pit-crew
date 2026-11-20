// src/sweeps.ts
import type { Cache, Run, Sweep } from './cache.ts'
import type { Config, RunnerName, RunRunner } from './config.ts'
import { ciStateOf, isMine, viewerReview } from './derive.ts'
import type { RawOpenPr } from './github.ts'
import { doneText, isFullSha, modelLabels, postArgs, recommendedFormOf, stepsOf } from './launcher.ts'
import type { CiState, PostForm, Priority, Queueing, Recommendation, RunnerModels, StartRequest, StepSlot, SweepOffer, SweepResult } from './launcher.ts'
import { prReportName } from './reports.ts'

// the Dependabot sweep as a concept of its own (section 8 of DESIGN.md, Sweeps): the command line it launches, what the confirmation says, the view the page draws from a sweep record, and the sweeps held in memory beside the runs. The launcher launches it (createSweepLauncher in launcher.ts).

export const sweepCommand = 'review-dependabot-sweep'
export const sweepLabel = 'Dependabot sweep'

// the sweep's arguments, without --emit-json, which the launcher adds: the repository and one reviewer at a time. Never --no-post: approving and requesting at one stroke is what a sweep is for
export const sweepArgs = (repo: string): string[] => [repo, '--parallel', '1']

// a sweep has no PR; the number is ignored by the sweeps store and never written anywhere
export const sweepRequest = (repo: string, runner?: RunRunner): StartRequest => ({
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
  // the model each runner will start with, named from the same configuration as the command line
  models: RunnerModels
  // the configured default, which the confirmation offers first
  runner: RunnerName
  // why it cannot start right now; null otherwise
  unavailable: string | null
  // the button's text and its accessible name, which say queue while a sweep would wait; the page re-derives no part of the rule
  button: string
  name: string
}

// busy is whether a sweep of the repository is in flight or queued; waits is the launcher's one answer, the review flag of its queueing()
export const sweepStartOf = (config: Config, busy: boolean, waits = false): SweepStart => ({
  heading: `Sweep the open Dependabot PRs in ${config.repo}?`,
  repo: config.repo,
  viewer: config.viewer,
  command: [sweepCommand, ...sweepArgs(config.repo)].join(' '),
  serial: 'It reviews one PR at a time (--parallel 1), then writes one summary with a merge order.',
  posts: `Its reviewers post on GitHub as @${config.viewer}: each may approve a clean bump, request changes, or comment, one post per PR. It never merges or pushes.`,
  runners: ['claude', 'codex'],
  models: modelLabels(config.agent),
  runner: config.agent.runner,
  unavailable: busy
    ? `a sweep for ${config.repo} is already in flight`
    : config.cloneDir === undefined ? `set cloneDir in the config to your local clone of ${config.repo} before starting a sweep` : null,
  button: waits ? 'Queue sweep' : 'Run sweep',
  name: `${waits ? 'Queue' : 'Run'} a Dependabot sweep of ${config.repo}`,
})

// the parsed sweep-result@1, as far as the page draws it. Rows come through the launcher's check only as a list, so each field is read defensively here; notPostedReason is read only by sweepOfferOf, which decides whether a row offers its stored report
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
  // set when the row's post button began a post and none is on record, so the post may or may not have landed; absent otherwise
  postUnknown?: true
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
export type SweepView = Omit<Sweep, 'result' | 'steps' | 'rowReports' | 'postAttempts'> & {
  steps: StepSlot[]
  // null while it waits in the queue or runs
  text: string | null
  // the question while it waits for an answer
  question: string | null
  result: SweepSummary | null
}

// "Done · 7 swept, 1 failed", "Done · nothing to sweep": a sweep with nothing to sweep is done, never a failure
export const sweepText = (sweep: Pick<Sweep, 'status' | 'result' | 'note'>): string | null => {
  if (sweep.status === 'running' || sweep.status === 'queued') return null
  if (sweep.status !== 'done') return doneText(sweep, false)
  const counts = sweepResultOf(sweep)?.counts
  if (counts == null || counts.swept === 0) return 'Done · nothing to sweep'
  return `Done · ${counts.swept} swept${counts.failed > 0 ? `, ${counts.failed} failed` : ''}`
}

// the row reports' hashes and the post marks stay on the server: the page reads a mark only as a row whose post may have landed. A record built without them, as a sweep that has none, shows no mark
export const sweepView = (sweep: Omit<Sweep, 'rowReports' | 'postAttempts'> & Partial<Pick<Sweep, 'rowReports' | 'postAttempts'>>): SweepView => {
  const { result, steps: _steps, rowReports: _reports, postAttempts = {}, ...rest } = sweep
  const parsed = sweepResultOf(sweep)
  const summary = parsed === null || result === null ? null : sweepSummary(parsed)
  return {
    ...rest,
    steps: stepsOf(sweep),
    text: sweepText(sweep),
    question: sweep.status === 'needsInput' ? parsed?.question ?? null : null,
    result: summary === null ? null : { ...summary, rows: summary.rows.map((row) => row.posted === null && postAttempts[row.number] !== undefined ? { ...row, postUnknown: true } : row) },
  }
}

const inFlight = (status: Sweep['status']): boolean => status === 'queued' || status === 'running' || status === 'needsInput'

// whether a review of the PR may have written its report file after the sweep's reviewer did: one in flight, or one that spawned and had not ended before the sweep started. A run that never spawned wrote nothing, and fix-pr and update-pr write no report
const rewroteReport = (run: Run, sweep: Sweep, pr: RawOpenPr, config: Config): boolean => {
  if (run.repo !== config.repo || run.number !== pr.number || !['review-pr', 'review-dependabot'].includes(run.command)) return false
  if (inFlight(run.status)) return true
  if (run.pid === null) return false
  const started = sweep.startedAt === null ? Number.NaN : Date.parse(sweep.startedAt)
  return run.finishedAt === null || !(Date.parse(run.finishedAt) <= started)
}

// the stored report a sweep row offers to post, and the sweep that has the say over the PR (section 10 of DESIGN.md, Posting). sweeps holds the repo's sweeps newest first; runs holds the PR's own runs. A sweep queued, running, or waiting for an answer has the say and offers nothing, since its reviewer may write the PR's report again; otherwise the newest settled sweep with a row for the PR has it, and every older sweep is passed over. That sweep offers the row only when the scheduler started it with --no-post and it finished done saying so, on someone else's open PR, for a row that posted nothing, whose report is the PR's own file and was recorded with its hash and verdict when the sweep settled, with no post begun from it, no post begun on the PR whose outcome is not known (marked), no decided review of the head by the viewer, and no review of the PR that may have written the report since. Like a single run's stored report it stays on offer after the head has moved, and the confirmation says so. A hermes sweep offers nothing, since its reports are never cleared of keys. The drawer's buttons and the server's check at click time both come from this one function
export const sweepOfferOf = (pr: RawOpenPr, config: Config, sweeps: readonly Sweep[], runs: readonly Run[] = [], marked = false): { sweepId: number | null, offer: SweepOffer | null } => {
  for (const sweep of sweeps) {
    if (sweep.repo !== config.repo) continue
    if (inFlight(sweep.status)) return { sweepId: null, offer: null }
    const parsed = sweepResultOf(sweep)
    const row = parsed === null ? undefined : sweepSummary(parsed).rows.find((entry) => entry.number === pr.number)
    if (parsed === null || row === undefined) continue
    // a post begun on the PR from any sweep, run, or Post it whose outcome is not known may have landed, so no row of it is offered
    return { sweepId: sweep.id, offer: marked ? null : rowOffer(pr, config, sweep, parsed, row, runs) }
  }
  return { sweepId: null, offer: null }
}

const rowOffer = (pr: RawOpenPr, config: Config, sweep: Sweep, result: SweepResult, row: SweepRow, runs: readonly Run[]): SweepOffer | null => {
  if (sweep.status !== 'done' || sweep.origin !== 'auto' || !sweep.args.includes('--no-post') || result.notPostedReason !== 'noPost' || sweep.runner === 'hermes' || isMine(pr, config)) return null
  if (result.repo === null || result.repo.toLowerCase() !== config.repo.toLowerCase()) return null
  // only the file the prompts write for this PR, in the folder they write it to: the name comes from the PR's number, never from the row
  const report = prReportName(pr.number)
  const reportPath = `${config.reportsDir.replace(/\/$/, '')}/${report}`
  if (row.posted !== null || row.report !== reportPath || !isFullSha(row.head)) return null
  const recorded = sweep.rowReports?.[pr.number]
  if (recorded === undefined || recorded.verdict === null || sweep.postAttempts[pr.number] !== undefined) return null
  const head = pr.headRefOid
  const review = viewerReview(pr, config)
  if (review?.commit?.oid === head && (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED')) return null
  if (runs.some((run) => rewroteReport(run, sweep, pr, config))) return null
  const recommended = recommendedFormOf({ verdict: recorded.verdict, command: 'review-dependabot', recommendation: row.recommendation }, pr, config)
  const forms: PostForm[] = recommended === 'comment' ? ['comment'] : [recommended, 'comment']
  return {
    sweepId: sweep.id,
    number: pr.number,
    forms,
    report,
    reportPath,
    reviewedSha: row.head.toLowerCase(),
    headSha: head.toLowerCase(),
    repo: config.repo,
    viewer: config.viewer,
    ci: ciStateOf(pr),
    commands: Object.fromEntries(forms.map((form) => [form, `gh ${postArgs(config.repo, pr.number, form, reportPath).join(' ')}`])),
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

// what the page holds about sweeps: how to start one now, and the repo's recent sweeps. Patches carry it whole whenever a sweep, the queue answer, or the config behind the start text changes
export type SweepsView = { start: SweepStart, items: SweepView[] }

// queueing is the launcher's answer now, which the button says; left out, nothing waits
export const sweepsView = (config: Config, memory: SweepMemory, queueing: Queueing | null = null): SweepsView => {
  const items = memory.list(config.repo)
  return { start: sweepStartOf(config, items.some((sweep) => sweep.status === 'running' || sweep.status === 'queued'), queueing?.review ?? false), items }
}
