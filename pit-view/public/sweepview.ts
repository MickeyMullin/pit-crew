// public/sweepview.ts
// the Dependabot sweep's words and shapes, as pure functions of the sweeps the view carries: the bot group header's control, the confirmation, the group-level sweep drawer, the broom link on a PR's row and the link in that PR's own drawer. Sweeps are their own concept (section 8 of DESIGN.md, Sweeps), so nothing here reads a row's Agent cell; sweepdrawer.ts turns the models into elements. Nothing here reads the DOM or the clock: every time is passed in
import type { SweepRow, SweepStart, SweepView, SweepsView } from '../src/sweeps.ts'
import { formatDuration, runnerLabels, sentence, tokenHeader } from './agent.ts'
import type { DoneTone, RunnerName, RunRequest } from './agent.ts'
import { noteText, formatCost, newestNote, reportName, stepModels, stepsName } from './drawerview.ts'
import type { StepModel } from './drawerview.ts'
import { formatClock, formatDay, formatSince } from './format.ts'

export type { SweepRow, SweepStart, SweepView, SweepsView }

export type Tone = DoneTone | 'blue'

// the requests carry the per-start token, like a run's. A start also names the repository and the viewer the confirmation showed, so the server refuses it when either is no longer the one in effect
export const sweepStartRequest = (runner: RunnerName, repo: string, viewer: string, token: string): RunRequest => ({
  url: '/api/sweeps',
  init: {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [tokenHeader]: token },
    body: JSON.stringify({ runner, repo, viewer }),
  },
})

export const sweepStopRequest = (id: number, token: string): RunRequest => ({
  url: `/api/sweeps/${id}/stop`,
  init: { method: 'POST', headers: { [tokenHeader]: token } },
})

// the color of a sweep's outcome follows what the owner does next; the words carry the meaning. A sweep with nothing to sweep is done, never a failure, so it is gray rather than red
export const sweepTone = (sweep: Pick<SweepView, 'status' | 'result'>): Tone => {
  if (sweep.status === 'running') return 'blue'
  if (sweep.status === 'failed') return 'red'
  if (sweep.status === 'needsInput') return 'amber'
  if (sweep.status === 'stopped') return 'gray'
  const counts = sweep.result?.counts
  if (counts === undefined || counts === null || counts.swept === 0) return 'gray'
  return counts.failed > 0 ? 'amber' : 'green'
}

// when a sweep happened, for names and tooltips: "Mon Oct 26 5:53 PM"
export const sweepWhen = (sweep: Pick<SweepView, 'startedAt' | 'finishedAt'>, timeZone?: string): string => {
  const at = sweep.finishedAt ?? sweep.startedAt
  return `${formatDay(at, timeZone)} ${formatClock(at, false, timeZone)}`
}

// the bot group header's two controls: Run sweep, and the current or latest sweep's state, which opens the drawer. The group's own collapse button is not part of this. The status keeps what moves with the clock (the running timer, the finish age) out of its label, so the button is not rebuilt under the pointer while the sweep's state holds: the page sets those in place
export type SweepHeaderModel = {
  start: { label: string, name: string, disabled: boolean, reason: string | null }
  status: null | {
    sweepId: number
    // "Sweep: Done · 2 swept", "Sweep" while it runs
    label: string
    tone: Tone
    running: boolean
    startedAt: string
    lastStepAt: string | null
    finishedAt: string | null
    // label with the moving part, as the sweep reads right now
    text: string
    name: string
    tip: string | null
  }
}

export const sweepHeaderModel = (sweeps: SweepsView, nowMs: number, timeZone?: string): SweepHeaderModel => {
  const { start } = sweeps
  const latest = sweeps.items[0]
  let status: SweepHeaderModel['status'] = null
  if (latest !== undefined) {
    const running = latest.status === 'running'
    const label = running ? 'Sweep' : `Sweep: ${latest.text ?? 'Done'}`
    status = {
      sweepId: latest.id,
      label,
      tone: sweepTone(latest),
      running,
      startedAt: latest.startedAt,
      lastStepAt: latest.lastStepAt,
      finishedAt: latest.finishedAt,
      text: running ? `${label} ${runningText(latest, nowMs)}` : `${label}${latest.finishedAt === null ? '' : ` · ${formatSince(latest.finishedAt, nowMs)}`}`,
      name: running ? 'Open the running Dependabot sweep' : `Open the Dependabot sweep of ${sweepWhen(latest, timeZone)}: ${latest.text ?? 'done'}`,
      tip: latest.status === 'needsInput' ? latest.question : latest.status === 'failed' ? noteText(latest.note) : null,
    }
  }
  return {
    start: { label: 'Run sweep', name: `Run a Dependabot sweep of ${start.repo}`, disabled: start.unavailable !== null, reason: start.unavailable },
    status,
  }
}

// "running 3m · last step 20s ago", or "running 12s · starting" before the first step
const runningText = (sweep: Pick<SweepView, 'startedAt' | 'lastStepAt'>, nowMs: number): string => {
  const running = `running ${formatDuration(sweep.startedAt, nowMs)}`
  return sweep.lastStepAt === null ? `${running} · starting` : `${running} · last step ${formatSince(sweep.lastStepAt, nowMs)}`
}

export const sweepRunningText = runningText

// the confirmation before a sweep starts: the repository, serial, and that the reviewers post
export type SweepConfirmModel = {
  heading: string
  repo: string
  viewer: string
  command: string
  serial: string
  effect: string
  runners: { name: RunnerName, label: string }[]
  runner: RunnerName
  runnerLabel: string
  confirm: string
  busy: string
}

export const defaultSweepRunner = (start: Pick<SweepStart, 'runners'>, configured: RunnerName): RunnerName =>
  start.runners.includes(configured) ? configured : start.runners[0] ?? 'claude'

// the command as the runner receives it (Pit View adds --emit-json): a slash for Claude, a dollar sign for Codex
export const sweepConfirmModel = (start: SweepStart, runner: RunnerName): SweepConfirmModel => ({
  heading: start.heading,
  repo: start.repo,
  viewer: start.viewer,
  command: `${runner === 'codex' ? '$' : '/'}${start.command}`,
  serial: start.serial,
  effect: start.posts,
  runners: start.runners.map((name) => ({ name, label: runnerLabels[name] })),
  runner,
  runnerLabel: runnerLabels[runner],
  confirm: 'Start sweep',
  busy: 'Starting sweep…',
})

// everything the confirmation displays, as one string: the confirmation is rebuilt whenever it changes, so a change of repository, viewer, effect text, command or availability never leaves the old text on screen
export const sweepConfirmSignature = (start: SweepStart, runner: RunnerName): string => {
  const model = sweepConfirmModel(start, runner)
  return JSON.stringify([model.heading, model.repo, model.viewer, model.command, model.serial, model.effect, model.runners.map((choice) => choice.name), start.unavailable])
}

export const sweepStopModel = (sweep: Pick<SweepView, 'repo' | 'runner'>) => ({
  heading: `Stop the sweep of ${sweep.repo}?`,
  detail: `Dependabot sweep in ${runnerLabels[sweep.runner]}`,
  effect: 'Stops the session and everything it started. Reviews it already posted stay on GitHub, and a throwaway worktree under ~/agents/worktrees may remain.',
  confirm: 'Stop sweep',
  busy: 'Stopping…',
})

// ---- the drawer ----

export type CountModel = { key: 'swept' | 'fresh' | 'reused' | 'failed', label: string, value: number }

const countLabels: readonly [CountModel['key'], string][] = [['swept', 'Swept'], ['fresh', 'Fresh'], ['reused', 'Reused'], ['failed', 'Failed']]

const recommendations: Readonly<Record<string, { text: string, tone: Tone }>> = {
  approve: { text: 'Approve', tone: 'green' },
  fixBeforeMerge: { text: 'Fix before merge', tone: 'amber' },
  hold: { text: 'Hold', tone: 'amber' },
  doNotMerge: { text: 'Do not merge', tone: 'red' },
}

const ciStates: Readonly<Record<string, { text: string, tone: Tone }>> = {
  green: { text: 'CI green', tone: 'green' },
  failed: { text: 'CI failed', tone: 'red' },
  pending: { text: 'CI pending', tone: 'amber' },
  none: { text: 'No CI', tone: 'gray' },
}

const postForms: Readonly<Record<string, string>> = { approve: 'Approved', requestChanges: 'Requested changes', comment: 'Commented' }

const findingTones: Readonly<Record<string, Tone>> = { P0: 'red', P1: 'red', P2: 'amber', P3: 'gray' }

export type SweepRowModel = {
  number: number
  url: string
  title: string
  head: string
  bump: string
  recommendation: { text: string, tone: Tone } | null
  ci: { text: string, tone: Tone } | null
  // what the reviewer posted on GitHub, with the post's link; "Not posted" when it posted nothing
  posted: { text: string, url: string | null }
  reused: boolean
  escalation: string | null
  findings: { priority: string, summary: string, tone: Tone }[]
  // the report's file name when the report panel can open it, and its path as written
  report: { name: string | null, path: string } | null
  notes: string
}

export const sweepRowModel = (row: SweepRow): SweepRowModel => ({
  number: row.number,
  url: row.url,
  title: row.title,
  head: row.headShort,
  bump: row.bump,
  recommendation: row.recommendation === null ? null : recommendations[row.recommendation] ?? null,
  ci: row.ci === null ? null : ciStates[row.ci] ?? null,
  posted: row.posted === null ? { text: 'Not posted', url: null } : { text: postForms[row.posted.form] ?? row.posted.form, url: row.posted.url === '' ? null : row.posted.url },
  reused: row.reused,
  escalation: row.escalation,
  findings: row.findings.map((finding) => ({ priority: finding.priority, summary: finding.summary, tone: findingTones[finding.priority] ?? 'gray' })),
  // only a PR report's Markdown file name opens in the report panel (GET /api/reports/<name>)
  report: row.report === null ? null : { name: openableReport(row.report), path: row.report },
  notes: row.notes,
})

// the server serves PR-<n>*.md, FIX-<n>.md and no other file, so anything else is shown as a path
const openableReport = (path: string): string | null => {
  const name = reportName(path)
  return name !== null && /^(PR-\d+[A-Za-z0-9._-]*|FIX-\d+)\.md$/.test(name) ? name : null
}

export type MergeStepModel = { index: number, action: string, prs: number[] }

export type SweepResultModel = {
  text: string
  tone: Tone
  finishedAt: string | null
  runnerLabel: string
  cost: string | null
  note: string | null
  // a sweep with nothing to sweep: done, every count zero, no rows and no summary
  empty: boolean
  // null when the result has none (no result, or a failed or waiting sweep that stopped before it had them): no counts are shown, never zeros
  counts: CountModel[] | null
  // the question of a waiting sweep, which its own card shows
  question: string | null
  rows: SweepRowModel[]
  order: MergeStepModel[]
  // the Markdown summary's path as written, for the owner to copy; null when there is none
  summaryPath: string | null
}

export const sweepResultModel = (sweep: SweepView): SweepResultModel => {
  const result = sweep.result
  const counts = result?.counts ?? null
  return {
    text: sweep.text ?? 'Done',
    tone: sweepTone(sweep),
    finishedAt: sweep.finishedAt,
    runnerLabel: runnerLabels[sweep.runner],
    cost: formatCost(sweep.costUsd),
    note: noteText(sweep.note),
    empty: sweep.status === 'done' && (counts?.swept ?? 0) === 0 && (result?.rows.length ?? 0) === 0,
    counts: counts === null ? null : countLabels.map(([key, label]) => ({ key, label, value: counts[key] })),
    question: sweep.question,
    rows: (result?.rows ?? []).map(sweepRowModel),
    order: (result?.mergeOrder ?? []).map((step, index) => ({ index: index + 1, action: step.action, prs: step.prs })),
    summaryPath: result?.summary ?? null,
  }
}

export type SweepRunningModel = { runnerLabel: string, steps: StepModel[], stepsName: string, note: { label: string, note: string } | null }

export const sweepRunningModel = (sweep: SweepView): SweepRunningModel => {
  const steps = stepModels(sweep.steps, sweep.command)
  return { runnerLabel: runnerLabels[sweep.runner], steps, stepsName: stepsName(steps), note: newestNote(sweep.steps, sweep.command) }
}

export const sweepWaitingModel = (sweep: SweepView): { question: string, resume: string | null } => ({
  question: sweep.question ?? 'The sweep stopped to ask a question but did not record it. Open its session to see it.',
  resume: sweep.resume,
})

export type SweepCard = 'running' | 'waiting' | 'result'

// a settled sweep shows the whole result it carries, whatever its status: counts, rows, merge order and summary. A waiting sweep shows its question first and the result it has so far below it
export const sweepHasResult = (sweep: Pick<SweepView, 'result'>): boolean => {
  const result = sweep.result
  return result !== null && (result.counts !== null || result.rows.length > 0 || result.mergeOrder.length > 0 || result.summary !== null)
}

export const sweepCards = (sweep: Pick<SweepView, 'status' | 'result'>): SweepCard[] => {
  if (sweep.status === 'running') return ['running']
  if (sweep.status === 'needsInput') return sweepHasResult(sweep) ? ['waiting', 'result'] : ['waiting']
  return ['result']
}

// the earlier sweeps of the repository, newest first, for choosing which one the drawer shows
export type SweepListRow = { id: number, label: string, text: string, tone: Tone, startedAt: string, cost: string | null, selected: boolean }

export const sweepList = (items: readonly SweepView[], shownId: number | null): SweepListRow[] =>
  items.map((sweep) => ({
    id: sweep.id,
    label: `Sweep of ${sweepWhen(sweep)}`,
    text: sweep.text ?? 'Running',
    tone: sweepTone(sweep),
    startedAt: sweep.startedAt,
    cost: formatCost(sweep.costUsd),
    selected: sweep.id === shownId,
  }))

// the sweep the drawer shows: the one asked for, otherwise the newest; null when there are none
export const shownSweep = (items: readonly SweepView[], id: number | null): SweepView | null =>
  (id === null ? undefined : items.find((sweep) => sweep.id === id)) ?? items[0] ?? null

// ---- the links from a PR to its sweep ----

// the sweep a PR belongs to, derived from the sweeps' rows and not stored: the newest done sweep of the repository whose rows name this PR at this head. A PR that moved on since belongs to none. The row's head is a full SHA and the PR row's a short one (or the same): either may prefix the other
export type SweepLink = { sweepId: number, number: number, when: string, name: string, tip: string }

export const sweepLinkFor = (items: readonly SweepView[], number: number, headOid: string, timeZone?: string): SweepLink | null => {
  if (headOid === '') return null
  for (const sweep of [...items].sort((a, b) => b.id - a.id)) {
    if (sweep.status !== 'done' || sweep.result === null) continue
    const row = sweep.result.rows.find((candidate) => candidate.number === number)
    if (row === undefined || row.head === '') continue
    if (!row.head.startsWith(headOid) && !headOid.startsWith(row.head)) continue
    const when = sweepWhen(sweep, timeZone)
    return {
      sweepId: sweep.id,
      number,
      when,
      name: `Open #${number} in the Dependabot sweep of ${when}`,
      tip: `Dependabot sweep of ${when}`,
    }
  }
  return null
}

// one key per change of the newest sweep's status, announced once; never a timer tick
export const sweepAnnounceKey = (items: readonly SweepView[]): string => {
  const latest = items[0]
  return latest === undefined ? 'none' : `${latest.id}:${latest.status}`
}

export const sweepAnnouncement = (items: readonly SweepView[]): string | null => {
  const latest = items[0]
  if (latest === undefined) return null
  if (latest.status === 'running') return `Dependabot sweep of ${latest.repo} started`
  return `Dependabot sweep of ${latest.repo} finished: ${latest.text ?? 'Done'}`
}

export const sweepRefusal = (status: number, error: string | null): string =>
  status === 403 ? 'Reload the page to start a sweep: Pit View has restarted since this page loaded.'
    : status === 0 ? 'Pit View did not answer. Check that it is running, then try again.'
      : sentence(error ?? '') || `Pit View refused with status ${status}.`

export const sweepStopRefusal = (status: number, error: string | null): string =>
  status === 403 ? 'Reload the page to stop a sweep: Pit View has restarted since this page loaded.'
    : status === 0 ? 'Pit View did not answer. Check that it is running, then try again.'
      : sentence(error ?? '') || `Pit View refused with status ${status}.`
