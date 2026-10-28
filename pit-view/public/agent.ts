// public/agent.ts
// the Agent cell's words and requests: what each state says, the running timer, the confirmation
// before a start or a stop, the requests with the per-start token, and what changes are announced;
// pure, with every clock reading passed in
import type { RunnerName } from '../src/config.ts'
import type { AgentCell } from '../src/launcher.ts'
import { formatSince } from './format.ts'

export type { AgentCell, RunnerName }

const second = 1000
const minute = 60 * second
const hour = 60 * minute

export const runnerNames: readonly RunnerName[] = ['claude', 'codex']

export const runnerLabels: Readonly<Record<RunnerName, string>> = { claude: 'Claude Code', codex: 'Codex' }

const stepLabels: Readonly<Record<string, string>> = {
  resolveBase: 'resolve base',
  review: 'review',
  consolidate: 'consolidate',
  writeReport: 'write report',
  post: 'post',
}

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
export const stepText = (step: AgentCell['step']): string => {
  if (step === null) return 'Starting: no step recorded yet'
  const name = stepLabels[step.name] ?? step.name
  return `Step: ${name}, ${step.state}`
}

export type DoneTone = 'red' | 'amber' | 'green' | 'gray'

// the done text's color follows what the owner should do next; the words carry the meaning
export const doneTone = (cell: Pick<AgentCell, 'status' | 'text'>): DoneTone => {
  const text = cell.text ?? ''
  if (cell.status === 'failed') return 'red'
  if (cell.status === 'needsInput' || text.endsWith('post failed') || text === 'Clean · CI failed') return 'amber'
  if (cell.status === 'stopped' || text === 'Done') return 'gray'
  return text === 'Changes requested' ? 'red' : 'green'
}

// what the cell shows, state by state; accessible names carry the PR number
export type CellModel =
  | { state: 'idle', button: string, name: string, under: string | null }
  | { state: 'running', label: string, line: string, step: string, stop: string }
  | {
      state: 'done'
      text: string
      tone: DoneTone
      line: string
      // the question while waiting for an answer, or why it failed, shown as a tooltip
      tip: string | null
      // copies the resume command, while the run waits for an answer
      copy: { name: string, command: string } | null
      // starts the row's action again after a run that failed or was stopped
      again: { name: string } | null
    }

const failureTip = (note: string | null): string | null => {
  if (note === null || note === '') return null
  return note
}

export const cellModel = (cell: AgentCell, number: number, nowMs: number): CellModel => {
  if (cell.state === 'running') {
    return { state: 'running', label: cell.label, line: runningLine(cell, nowMs), step: stepText(cell.step), stop: `Stop run on #${number}` }
  }
  if (cell.state === 'done') {
    const waiting = cell.status === 'needsInput'
    const retry = cell.status === 'failed' || cell.status === 'stopped'
    return {
      state: 'done',
      text: cell.text ?? 'Done',
      tone: doneTone(cell),
      line: cell.finishedAt === null ? '' : `finished ${formatSince(cell.finishedAt, nowMs)}`,
      tip: waiting ? cell.question : cell.status === 'failed' ? failureTip(cell.note) : null,
      copy: waiting && cell.resume !== null ? { name: `Copy resume command for #${number}`, command: cell.resume } : null,
      again: retry ? { name: `${cell.action.label} #${number} again` } : null,
    }
  }
  return {
    state: 'idle',
    button: cell.action.label,
    name: `${cell.action.label} #${number}`,
    under: cell.lastReviewAt === null ? null : `last review ${formatSince(cell.lastReviewAt, nowMs)}`,
  }
}

// the confirmation before a start: the command as the runner receives it (Pit View adds
// --emit-json), the runner, and what it will do on GitHub
export type StartConfirm = { heading: string, title: string, command: string, runner: string, effect: string, confirm: string }

export const commandLine = (action: Pick<AgentCell['action'], 'command' | 'args'>, runner: RunnerName): string =>
  `${runner === 'codex' ? '$' : '/'}${[action.command, ...action.args].join(' ')}`

export const githubEffect = (action: Pick<AgentCell['action'], 'command' | 'args'>, viewer: string): string => {
  if (action.command === 'review-dependabot') return `Posts its report to the PR as @${viewer} and may approve the PR automatically.`
  if (action.args.includes('--no-post')) return 'Posts nothing; writes the report only.'
  return `Posts its report to the PR as @${viewer}: an approval, a request for changes, or a comment, per the findings.`
}

export const startConfirm = (
  row: { number: number, title: string },
  action: Pick<AgentCell['action'], 'label' | 'command' | 'args'>,
  runner: RunnerName,
  viewer: string,
): StartConfirm => ({
  heading: `${action.label} #${row.number}?`,
  title: row.title,
  command: commandLine(action, runner),
  runner: runnerLabels[runner],
  effect: githubEffect(action, viewer),
  confirm: `Start ${action.label.toLowerCase()}`,
})

// the run's line is the running cell's own, so the page's timer keeps it moving in the dialog too
export type StopConfirm = { heading: string, title: string, detail: string, line: string, effect: string, confirm: string }

export const stopConfirm = (row: { number: number, title: string }, cell: AgentCell, nowMs: number): StopConfirm => ({
  heading: `Stop the run on #${row.number}?`,
  title: row.title,
  detail: `${cell.label} in ${cell.runner === null ? 'its runner' : runnerLabels[cell.runner]}`,
  line: runningLine(cell, nowMs),
  effect: 'Stops the session and everything it started. Anything it already posted stays on GitHub, and its throwaway worktree under ~/agents/worktrees may remain.',
  confirm: 'Stop run',
})

// the requests: both carry the token this page was served with
export const tokenHeader = 'X-Pit-View-Token'

export type RunRequest = { url: string, init: { method: 'POST', headers: Record<string, string>, body?: string } }

export const startRequest = (number: number, runner: RunnerName, token: string): RunRequest => ({
  url: `/api/prs/${number}/runs`,
  init: { method: 'POST', headers: { 'Content-Type': 'application/json', [tokenHeader]: token }, body: JSON.stringify({ runner }) },
})

export const stopRequest = (runId: number, token: string): RunRequest => ({
  url: `/api/runs/${runId}/stop`,
  init: { method: 'POST', headers: { [tokenHeader]: token } },
})

// a refusal in the owner's words: the server's own message, except for the token, where the fix
// is a reload; status 0 means Pit View did not answer at all
export const refusalText = (kind: 'start' | 'stop', status: number, error: string | null): string => {
  if (status === 403) return `Reload the page to ${kind} runs: Pit View has restarted since this page loaded.`
  if (status === 0) return 'Pit View did not answer. Check that it is running, then try again.'
  const message = (error ?? '').trim().replace(/\.$/, '')
  if (message === '') return `Pit View refused with status ${status}.`
  // a sentence starts with a capital, but never a name such as gh or cloneDir
  const first = message.split(/[\s:;,]/)[0] ?? ''
  const plainWord = /^[a-z]+$/.test(first) && first !== 'gh'
  return `${plainWord ? message.charAt(0).toUpperCase() : message.charAt(0)}${message.slice(1)}.`
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
