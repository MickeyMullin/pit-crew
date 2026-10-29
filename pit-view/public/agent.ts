// public/agent.ts
// the Agent cell's words and requests: what each state says, the running timer, the requests with
// the per-start token, how a refusal reads, and what changes are announced; pure, with every
// clock reading passed in. The drawer's own words are in drawerview.ts
import type { RunnerName } from '../src/config.ts'
import type { AgentCell, AgentResult, RunView, StartKind, StartOption, StepSlot } from '../src/launcher.ts'
import { formatSince } from './format.ts'

export type { AgentCell, AgentResult, RunnerName, RunView, StartKind, StartOption, StepSlot }

const second = 1000
const minute = 60 * second
const hour = 60 * minute

export const runnerNames: readonly RunnerName[] = ['claude', 'codex']

export const runnerLabels: Readonly<Record<RunnerName, string>> = { claude: 'Claude Code', codex: 'Codex' }

// the progress bar's labels, in the order the steps run. fix-pr records the same five slots with
// meanings of its own (section 8, the fix command); every other command's are a review's
const reviewTitles: Readonly<Record<string, string>> = {
  resolveBase: 'Resolve base',
  review: 'Review',
  consolidate: 'Consolidate',
  writeReport: 'Write report',
  post: 'Post',
}

const fixTitles: Readonly<Record<string, string>> = {
  resolveBase: 'Resolve',
  review: 'Triage',
  consolidate: 'Fix and check',
  writeReport: 'Write report',
  post: 'Push',
}

// the sweep records the same five slots too (section 8, the Dependabot sweep): it enumerates, reviews every PR, works out the merge order, writes its summary, and posts nothing itself
const sweepTitles: Readonly<Record<string, string>> = {
  resolveBase: 'Enumerate',
  review: 'Review PRs',
  consolidate: 'Merge order',
  writeReport: 'Write summary',
  post: 'Post',
}

// a step's label for a run of this command
export const stepTitle = (command: string | null, step: string): string =>
  (command === 'fix-pr' ? fixTitles : command === 'review-dependabot-sweep' ? sweepTitles : reviewTitles)[step] ?? step

// how long a run has gone: seconds under a minute, minutes under an hour, then hours and minutes
export const formatDuration = (fromIso: string, nowMs: number): string => {
  const elapsed = Math.max(0, nowMs - Date.parse(fromIso))
  if (elapsed < minute) return `${Math.floor(elapsed / second)}s`
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`
  const minutes = Math.floor((elapsed % hour) / minute)
  return minutes === 0 ? `${Math.floor(elapsed / hour)}h` : `${Math.floor(elapsed / hour)}h ${minutes}m`
}

// "running 3m · last step 20s ago", or "running 12s · starting" before the first step
export const runningLine = (cell: Pick<AgentCell, 'startedAt' | 'lastStepAt'>, nowMs: number): string => {
  const running = cell.startedAt === null ? 'running' : `running ${formatDuration(cell.startedAt, nowMs)}`
  return cell.lastStepAt === null ? `${running} · starting` : `${running} · last step ${formatSince(cell.lastStepAt, nowMs)}`
}

// the newest step in words, for the running cell's tooltip and screen readers
export const stepText = (step: AgentCell['step'], command: string | null = null): string => {
  if (step === null) return 'Starting: no step recorded yet'
  const title = stepTitle(command, step.name)
  return `Step: ${title.charAt(0).toLowerCase()}${title.slice(1)}, ${step.state}`
}

export type DoneTone = 'red' | 'amber' | 'green' | 'gray'

// the done text's color follows what the owner should do next; the words carry the meaning. A fix
// that left requests unpushed wants a look (amber); one with nothing to fix needs nothing (gray)
export const doneTone = (cell: Pick<AgentCell, 'status' | 'text'>): DoneTone => {
  const text = cell.text ?? ''
  if (cell.status === 'failed') return 'red'
  if (cell.status === 'needsInput' || text.endsWith('post failed') || text === 'Clean · CI failed' || text.startsWith('Not pushed')) return 'amber'
  if (cell.status === 'stopped' || text === 'Done' || text === 'Nothing to fix') return 'gray'
  return text === 'Changes requested' ? 'red' : 'green'
}

// what the cell shows, state by state. Every state has one button that opens the drawer, named
// with the PR number; starting, stopping and copying happen in the drawer
export type CellModel =
  | { state: 'idle', button: string, name: string, under: string | null }
  | { state: 'running', label: string, line: string, step: string, name: string }
  | {
      state: 'done'
      text: string
      tone: DoneTone
      line: string
      // the question while waiting for an answer, or why it failed, shown as a tooltip
      tip: string | null
      name: string
    }

const failureTip = (note: string | null): string | null => {
  if (note === null || note === '') return null
  return note
}

export const cellModel = (cell: AgentCell, number: number, nowMs: number): CellModel => {
  if (cell.state === 'running') {
    return {
      state: 'running',
      label: cell.label,
      line: runningLine(cell, nowMs),
      step: stepText(cell.step, cell.command),
      name: `Open agent for #${number}, ${cell.label} running`,
    }
  }
  if (cell.state === 'done') {
    const waiting = cell.status === 'needsInput'
    const text = cell.text ?? 'Done'
    return {
      state: 'done',
      text,
      tone: doneTone(cell),
      line: cell.finishedAt === null ? '' : `finished ${formatSince(cell.finishedAt, nowMs)}`,
      tip: waiting ? cell.question : cell.status === 'failed' ? failureTip(cell.note) : null,
      name: `Open agent for #${number}, ${text}`,
    }
  }
  return {
    state: 'idle',
    button: cell.action.label,
    name: `${cell.action.label} #${number}: open agent`,
    under: cell.lastReviewAt === null ? null : `last review ${formatSince(cell.lastReviewAt, nowMs)}`,
  }
}

// the command as the runner receives it (Pit View adds --emit-json): a slash for Claude, a
// dollar sign for Codex
export const commandLine = (option: Pick<StartOption, 'command' | 'args'>, runner: RunnerName): string =>
  `${runner === 'codex' ? '$' : '/'}${[option.command, ...option.args].join(' ')}`

// the start the changes-requested banner offers beside Open agent: the Fix session, while the row
// offers one at all (an unavailable one still opens the drawer, which says why)
export const fixStart = (cell: Pick<AgentCell, 'starts'> | null): StartOption | null =>
  cell?.starts.find((option) => option.kind === 'fix') ?? null

// the requests: both carry the token this page was served with
export const tokenHeader = 'X-Pit-View-Token'

export type RunRequest = { url: string, init: { method: 'POST', headers: Record<string, string>, body?: string } }

// a Fix session names no runner: it runs with Claude only, which the server picks. A start also names the viewer the confirmation showed, so the server refuses it when that is no longer the viewer in effect
export const startRequest = (number: number, kind: StartKind, runner: RunnerName, viewer: string, token: string): RunRequest => ({
  url: `/api/prs/${number}/runs`,
  init: {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [tokenHeader]: token },
    body: JSON.stringify(kind === 'fix' ? { kind, viewer } : { kind, runner, viewer }),
  },
})

export const stopRequest = (runId: number, token: string): RunRequest => ({
  url: `/api/runs/${runId}/stop`,
  init: { method: 'POST', headers: { [tokenHeader]: token } },
})

// a server message as a sentence: a capital and a full stop, but never a capital on a name such
// as gh or cloneDir
export const sentence = (text: string): string => {
  const message = text.trim().replace(/\.$/, '')
  if (message === '') return ''
  const first = message.split(/[\s:;,]/)[0] ?? ''
  const plainWord = /^[a-z]+$/.test(first) && first !== 'gh'
  return `${plainWord ? message.charAt(0).toUpperCase() : message.charAt(0)}${message.slice(1)}.`
}

// a refusal in the owner's words: the server's own message, except for the token, where the fix
// is a reload; status 0 means Pit View did not answer at all
export const refusalText = (kind: 'start' | 'stop', status: number, error: string | null): string => {
  if (status === 403) return `Reload the page to ${kind} runs: Pit View has restarted since this page loaded.`
  if (status === 0) return 'Pit View did not answer. Check that it is running, then try again.'
  return sentence(error ?? '') || `Pit View refused with status ${status}.`
}

// one key per row's run state; a change of key is announced once, never a timer tick
export const announceKey = (cell: AgentCell | null): string =>
  cell === null ? 'none' : `${cell.runId ?? 'none'}:${cell.state}:${cell.status ?? 'none'}`

export const announcement = (number: number, cell: AgentCell): string | null => {
  if (cell.state === 'running') return `#${number}: ${cell.label} started`
  if (cell.state === 'done') return `#${number}: ${cell.label} finished: ${cell.text ?? 'Done'}`
  return null
}

// what changed since the last draw; the first reading (an empty map) announces nothing
export const announcements = (
  previous: ReadonlyMap<number, string> | null,
  rows: readonly { number: number, agent: AgentCell | null }[],
): { next: Map<number, string>, messages: string[] } => {
  const next = new Map<number, string>()
  const messages: string[] = []
  for (const row of rows) {
    const key = announceKey(row.agent)
    next.set(row.number, key)
    if (previous === null || row.agent === null) continue
    const before = previous.get(row.number)
    if (before === undefined || before === key) continue
    const message = announcement(row.number, row.agent)
    if (message !== null) messages.push(message)
  }
  return { next, messages }
}
