// public/agent.ts
// the Agent cell's words and requests: what each state says, the running timer, the requests with
// the per-start token, how a refusal reads, and what changes are announced; pure, with every
// clock reading passed in. The drawer's own words are in drawerview.ts
import type { RunnerName } from '../src/config.ts'
import type { AgentCell, AgentResult, PostForm, RunnerModels, RunView, StartKind, StartOption, StepSlot } from '../src/launcher.ts'
import type { OpenRow } from '../src/derive.ts'
import { mergeOffered } from './mergeoffer.ts'
import { formatDuration, formatSince } from './format.ts'

export type { AgentCell, AgentResult, PostForm, RunnerModels, RunnerName, RunView, StartKind, StartOption, StepSlot }

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

// the Update session records them too (section 8, the update command): it resolves the PR and the primary branch, chooses rebase or merge, makes the update with its conflicts and checks, writes no report, and pushes
const updateTitles: Readonly<Record<string, string>> = {
  resolveBase: 'Resolve',
  review: 'Choose method',
  consolidate: 'Update and check',
  writeReport: 'Write report',
  post: 'Push',
}

const titlesByCommand: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'fix-pr': fixTitles,
  'update-pr': updateTitles,
  'review-dependabot-sweep': sweepTitles,
}

// a step's label for a run of this command
export const stepTitle = (command: string | null, step: string): string =>
  (titlesByCommand[command ?? ''] ?? reviewTitles)[step] ?? step

// "running 3m · last step 20s ago", or "running 12s · starting" before the first step
export const runningLine = (cell: Pick<AgentCell, 'startedAt' | 'lastStepAt'>, nowMs: number): string => {
  const running = cell.startedAt === null ? 'running' : `running ${formatDuration(cell.startedAt, nowMs)}`
  return cell.lastStepAt === null ? `${running} · starting` : `${running} · last step ${formatSince(cell.lastStepAt, nowMs)}`
}

// "queued 4m": how long a review has waited for a slot under the cap, since it was queued; an auto-review run reads "queued · auto 4m", counted from when the scheduler queued it
export const queuedLine = (cell: Pick<AgentCell, 'startedAt'> & Partial<Pick<AgentCell, 'origin' | 'queuedAt'>>, nowMs: number): string => {
  const since = cell.origin === 'auto' ? cell.queuedAt ?? cell.startedAt : cell.startedAt
  const word = cell.origin === 'auto' ? 'queued · auto' : 'queued'
  return since === null ? word : `${word} ${formatDuration(since, nowMs)}`
}

// an auto-review run's label leads with "auto"
const labelOf = (cell: Pick<AgentCell, 'label' | 'origin'>): string => cell.origin === 'auto' ? `auto · ${cell.label}` : cell.label

// the newest step in words, for the running cell's tooltip and screen readers
export const stepText = (step: AgentCell['step'], command: string | null = null): string => {
  if (step === null) return 'Starting: no step recorded yet'
  const title = stepTitle(command, step.name)
  return `Step: ${title.charAt(0).toLowerCase()}${title.slice(1)}, ${step.state}`
}

export type DoneTone = 'red' | 'amber' | 'green' | 'gray'

// the done text's color follows what the owner should do next; the words carry the meaning. A fix or an update that left something unpushed wants a look (amber), and so does a review whose post was not made; one with nothing to fix, or a branch already up to date, needs nothing (gray)
export const doneTone = (cell: Pick<AgentCell, 'status' | 'text'>): DoneTone => {
  const text = cell.text ?? ''
  if (cell.status === 'failed') return 'red'
  if (cell.status === 'needsInput' || text.endsWith('post failed') || text.includes('· post not made') || text === 'Clean · CI failed' || text.startsWith('Not pushed')) return 'amber'
  if (cell.status === 'stopped' || cell.status === 'skipped' || text === 'Done' || text === 'Nothing to fix' || text === 'Already up to date') return 'gray'
  return text === 'Changes requested' || text === 'Changes requested · not posted' ? 'red' : 'green'
}

// what the cell shows, state by state. Every state has one button that opens the drawer, named
// with the PR number; starting, stopping and copying happen in the drawer
export type CellModel =
  // ask is present only on the Merge button: the drawer opens with that confirmation already asked
  | { state: 'idle', button: string, name: string, under: string | null, ask?: 'merge' }
  | { state: 'queued', label: string, line: string, name: string }
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

// the idle cell reads Merge instead of the row's default run on the viewer's own PR that the offer rule admits (approved, with the primary branch as its base, no chip that withholds it, and a merge status of CLEAN, HAS_HOOKS, or UNKNOWN): the same condition under which the drawer offers Squash and merge, and the one the server's guard applies (mergeOffered in ./mergeoffer.ts, the single rule). The page derives it from the row it already has; the server sends no field for it, and the button starts nothing
export const showsMerge = (row: Pick<OpenRow, 'section' | 'merge' | 'primaryBase' | 'group' | 'issues'>): boolean =>
  row.section === 'mine' && mergeOffered(row)

export const cellModel = (cell: AgentCell, number: number, nowMs: number, merge = false): CellModel => {
  if (cell.state === 'queued') {
    const label = labelOf(cell)
    return { state: 'queued', label, line: queuedLine(cell, nowMs), name: `Open agent for #${number}, ${label} queued` }
  }
  if (cell.state === 'running') {
    const label = labelOf(cell)
    return {
      state: 'running',
      label,
      line: runningLine(cell, nowMs),
      step: stepText(cell.step, cell.command),
      name: `Open agent for #${number}, ${label} running`,
    }
  }
  if (cell.state === 'done') {
    const waiting = cell.status === 'needsInput'
    const auto = cell.origin === 'auto'
    // an auto-review run that failed or was skipped reads "auto · failed" or "auto · skipped"; any other keeps the server's words, and its line leads with "auto"
    const ranOut = cell.status === 'failed' || cell.status === 'skipped'
    const text = auto && ranOut ? `auto · ${cell.status}` : cell.text ?? 'Done'
    const finished = cell.finishedAt === null ? '' : `finished ${formatSince(cell.finishedAt, nowMs)}`
    return {
      state: 'done',
      text,
      tone: doneTone(cell),
      line: auto && !ranOut && finished !== '' ? `auto · ${finished}` : finished,
      tip: waiting ? cell.question : cell.status === 'failed' || (auto && cell.status === 'skipped') ? failureTip(cell.note) : null,
      name: `Open agent for #${number}, ${text}`,
    }
  }
  const button = merge ? 'Merge' : cell.action.label
  return {
    state: 'idle',
    button,
    name: `${button} #${number}: open agent`,
    under: cell.lastReviewAt === null ? null : `last review ${formatSince(cell.lastReviewAt, nowMs)}`,
    ...merge ? { ask: 'merge' as const } : {},
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

// a Fix session names no runner: it runs with Claude only, which the server picks. A start also names the repository and viewer the confirmation showed, so the server refuses it when either is no longer the one in effect. The comments check is named only when it is on, so every other start's body stays as it was
export const startRequest = (number: number, kind: StartKind, runner: RunnerName, repo: string, viewer: string, token: string, checkComments = false, extraInstructions?: string): RunRequest => ({
  url: `/api/prs/${number}/runs`,
  init: {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [tokenHeader]: token },
    body: JSON.stringify(kind === 'fix' ? { kind, repo, viewer } : { kind, runner, repo, viewer, ...(checkComments ? { checkComments } : {}), ...(extraInstructions === undefined ? {} : { extraInstructions }) }),
  },
})

export const stopRequest = (runId: number, token: string): RunRequest => ({
  url: `/api/runs/${runId}/stop`,
  init: { method: 'POST', headers: { [tokenHeader]: token } },
})

// what a re-read's confirmation showed, which the request carries back whole: the server refuses with 409 and reads nothing when any of it differs from what is in effect now
export type RereadAsk = { repo: string, viewer: string, number: number, headSha: string, base: string }

export const rereadRequest = (runId: number, ask: RereadAsk, token: string): RunRequest => ({
  url: `/api/runs/${runId}/reread`,
  init: {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [tokenHeader]: token },
    body: JSON.stringify(ask),
  },
})

// what Post it's confirmation showed, which the request carries back whole: the server refuses with 409 and posts nothing when any of it differs from what is in effect now
export type PostAsk = { repo: string, viewer: string, number: number, headSha: string, form: PostForm }

export const postRequest = (runId: number, ask: PostAsk, token: string): RunRequest => ({
  url: `/api/runs/${runId}/post`,
  init: {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [tokenHeader]: token },
    body: JSON.stringify(ask),
  },
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
export const refusalText = (kind: 'start' | 'stop' | 'reread' | 'post', status: number, error: string | null): string => {
  if (status === 403) return `Reload the page to ${kind === 'post' ? 'post reports' : `${kind === 'reread' ? 're-read' : kind} runs`}: Pit View has restarted since this page loaded.`
  if (status === 0) return 'Pit View did not answer. Check that it is running, then try again.'
  return sentence(error ?? '') || `Pit View refused with status ${status}.`
}

// one key per row's run state; a change of key is announced once, never a timer tick
// marks a key read while a stack run started from another PR was on show, so its end is not told as the end of whatever the cell goes back to
const coveredKey = ':stack'

export const announceKey = (cell: AgentCell | null): string =>
  cell === null ? 'none' : `${cell.runId ?? 'none'}:${cell.state}:${cell.status ?? 'none'}${cell.stackRun == null ? '' : coveredKey}`

export const announcement = (number: number, cell: AgentCell): string | null => {
  if (cell.state === 'queued') return `#${number}: ${cell.label} queued`
  if (cell.state === 'running') return `#${number}: ${cell.label} started`
  // a stack run's text already says whose run it is
  if (cell.state === 'done') return cell.stackRun == null ? `#${number}: ${cell.label} finished: ${cell.text ?? 'Done'}` : `#${number}: ${cell.text ?? 'Done'}`
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
    // the cell went back to an older run the stack run had covered, which did not just start or finish; each key starts with its run id
    if (before.endsWith(coveredKey) && Number.parseInt(key, 10) < Number.parseInt(before, 10)) continue
    const message = announcement(row.number, row.agent)
    if (message !== null) messages.push(message)
  }
  return { next, messages }
}
