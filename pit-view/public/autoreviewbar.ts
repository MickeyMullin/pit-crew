// public/autoreviewbar.ts
// the header's auto-review indicator and its popover, from the view's autoReview (section 10 of DESIGN.md, In the UI): the words for each state, the last ticks, the PRs it has running or queued, the worktrees left in place, and the Run now request; pure, with every clock reading passed in
import type { AutoReviewView } from '../src/autoreview.ts'
import type { Tick, TickSkip } from '../src/cache.ts'
import { formatCached } from './format.ts'
import { sentence, tokenHeader } from './agent.ts'
import type { RunRequest } from './agent.ts'

export type Reading = { nowMs: number, timeZone?: string }

export type Indicator = { text: string, tone: 'normal' | 'warn' }

// why a tick did not run, in the owner's words
export const skipWords: Readonly<Record<TickSkip, string>> = {
  identityMismatch: 'gh login differs from viewer',
  noClone: 'no usable clone folder',
  fetchFailed: 'GitHub fetch failed',
  dailyLimit: 'daily limit reached',
  interrupted: 'tick interrupted',
}

// "2:45 PM" today, "Mon 9:00 AM" on another day
const nextWords = (at: string, { nowMs, timeZone }: Reading): string => formatCached(at, nowMs, timeZone)

const counts = (auto: Pick<AutoReviewView, 'running' | 'queued'>): string =>
  [auto.running > 0 ? `${auto.running} running` : null, auto.queued > 0 ? `${auto.queued} queued` : null].filter((part) => part !== null).join(', ')

// the text beside the sync status; null until the config has the autoReview key. A skipped last tick shows in amber while the scheduler is on and inside its hours, whether the reason persists (blocked) or not
export const indicator = (auto: AutoReviewView | null, reading: Reading): Indicator | null => {
  if (auto === null) return null
  const next = auto.nextTickAt === null ? '' : ` · next ${nextWords(auto.nextTickAt, reading)}`
  if (auto.state === 'off') return { text: 'Auto-review · off', tone: 'normal' }
  if (auto.state === 'outsideHours') return { text: `Auto-review · outside hours${next}`, tone: 'normal' }
  const last = auto.lastTick
  if ((auto.state === 'blocked' || auto.state === 'idle') && last?.state === 'skipped' && last.skipReason !== null) {
    return { text: `Auto-review · skipped: ${skipWords[last.skipReason]}${auto.state === 'blocked' ? '' : next}`, tone: 'warn' }
  }
  if (auto.state === 'running') {
    const busy = counts(auto)
    return { text: `Auto-review · ${busy === '' ? 'checking PRs' : busy}${next}`, tone: 'normal' }
  }
  return { text: `Auto-review · next ${auto.nextTickAt === null ? 'tick not scheduled' : nextWords(auto.nextTickAt, reading)}`, tone: 'normal' }
}

export type TickLine = { id: number, text: string, tone: 'normal' | 'warn' }

// one tick: when it started, then what it queued or why it skipped; a tick without a state is still running
export const tickLine = (tick: Tick, reading: Reading): TickLine => {
  const when = formatCached(tick.startedAt, reading.nowMs, reading.timeZone)
  if (tick.state === null) return { id: tick.id, text: `${when} · running`, tone: 'normal' }
  if (tick.state === 'skipped') return { id: tick.id, text: `${when} · skipped: ${tick.skipReason === null ? 'no reason recorded' : skipWords[tick.skipReason]}`, tone: 'warn' }
  const queued = tick.queued === null || tick.queued === 0 ? 'queued nothing' : `queued ${tick.queued}`
  const seen = tick.qualified === null || tick.alreadyCurrent === null ? '' : ` · ${tick.qualified} qualified, ${tick.alreadyCurrent} already current`
  return { id: tick.id, text: `${when} · ${queued}${seen}`, tone: 'normal' }
}

export type RunLink = { number: number, state: 'running' | 'queued', title: string, url: string, text: string }

export type PopoverModel = {
  ticks: TickLine[]
  runs: RunLink[]
  sweeps: string[]
  worktrees: string[]
  hold: string | null
  runNow: { disabled: boolean, reason: string | null }
}

type RowLike = { number: number, url: string, title: string, agent: { state: string, origin: string | null } | null }
type SweepLike = { origin: string, status: string }

const holdWords: Readonly<Record<NonNullable<AutoReviewView['sweepHold']>, string>> = {
  needsInput: 'Scheduled sweeps are paused: one is waiting for your answer.',
  failedTwice: 'Scheduled sweeps are paused: two failed in a row.',
}

// ticks arrive newest first; the popover shows ten
export const popoverModel = (auto: AutoReviewView, ticks: readonly Tick[], rows: readonly RowLike[], sweeps: readonly SweepLike[], reading: Reading): PopoverModel => {
  const live = (state: 'running' | 'queued'): RunLink[] => rows
    .filter((row) => row.agent?.origin === 'auto' && row.agent.state === state)
    .sort((a, b) => a.number - b.number)
    .map((row) => ({ number: row.number, state, title: row.title, url: row.url, text: `#${row.number} · ${state}` }))
  const sweepLine = (status: 'running' | 'queued'): string[] => sweeps.filter((sweep) => sweep.origin === 'auto' && sweep.status === status).map(() => `Dependabot sweep · ${status}`)
  return {
    ticks: ticks.slice(0, 10).map((tick) => tickLine(tick, reading)),
    runs: [...live('running'), ...live('queued')],
    sweeps: [...sweepLine('running'), ...sweepLine('queued')],
    worktrees: [
      ...auto.worktrees.kept.map((path) => `Left in place: ${path}`),
      ...auto.worktrees.unlisted.map((name) => `Not listed by git: ${name}`),
    ],
    hold: auto.sweepHold === null ? null : holdWords[auto.sweepHold],
    runNow: auto.enabled ? { disabled: false, reason: null } : { disabled: true, reason: 'Auto-review is off; turn it on in Settings.' },
  }
}

// Run now takes no body, and the per-start token like every write
export const runNowRequest = (token: string): RunRequest => ({
  url: '/api/auto-review/run',
  init: { method: 'POST', headers: { [tokenHeader]: token } },
})

// what the answer says, in a sentence
export const runNowResult = (status: number, body: { started: boolean, tick: number } | null, error: string | null): string => {
  if (status === 200 && body !== null) return body.started ? `Checking for PRs to review (tick ${body.tick}).` : `A check is already running (tick ${body.tick}).`
  if (status === 403) return 'Reload the page to run auto-review: Pit View has restarted since this page loaded.'
  if (status === 0) return 'Pit View did not answer. Check that it is running, then try again.'
  // the server's 409 begins with the feature's name, which sentence() leaves lowercase
  const text = sentence(error ?? '')
  return text === '' ? `Pit View refused with status ${status}.` : `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}
