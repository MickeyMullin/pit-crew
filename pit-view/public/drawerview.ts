// public/drawerview.ts
// the Agent drawer's words and shapes, as pure functions of the open row, the runs and reports
// fetched for it, and the drawer's own confirmation state; drawer.ts turns the model into
// elements. Nothing here reads the DOM or the clock: every time is passed in
import type { ClosedRow, LastReadings, OpenRow, ReviewerState } from '../src/derive.ts'
import type { RunModels } from '../src/models.ts'
import type { ReportListing } from '../src/reports.ts'
import { actionConfirmModel, actionOffers } from './actionsview.ts'
import type { ActionConfirm, ActionConfirmModel, ActionOffer, PersonChoice } from './actionsview.ts'
import { commandLine, doneTone, runnerLabels, sentence, stepTitle } from './agent.ts'
import type { AgentCell, AgentResult, DoneTone, FixPromptAsk, PostForm, RunnerModels, RunnerName, RunView, StartKind, StartOption, StepSlot, StoredOffer } from './agent.ts'
import { formatCached, shortSha } from './format.ts'
import { safeHref } from './safeurl.ts'

export type Loadable<T> = { state: 'loading' } | { state: 'error', message: string } | { state: 'ready', items: T[] }

// what the drawer is asking about: a start waiting for its Start, a stop waiting for its Stop, or a direct action on the PR waiting for its confirmation
export type Confirm =
  // checkComments is the Self-review's box, extraOn the checkbox of a review's Special instructions box (unchecked until clicked), and extraText what was typed in that box, undefined until then: all three live here, so they last as long as this confirmation and no longer. fixPrompt is set only on a Fix session asked for from the relevancy check's prompt, which it hands over
  | { type: 'start', kind: StartKind, runner: RunnerName, checkComments?: boolean, extraOn?: boolean, extraText?: string, fixPrompt?: FixPromptAsk }
  | { type: 'stop', andOpen: boolean, runId: number }
  // a re-read of the latest run's result, with everything its confirmation showed
  | { type: 'reread', runId: number, repo: string, viewer: string, headSha: string, baseRef: string }
  // Post it's confirmation, with everything it showed
  | { type: 'post', runId: number, repo: string, viewer: string, headSha: string, form: PostForm }
  // the post button's confirmation for a stored report: the form asked for, the commit the report reviewed, the head now, and the CI state it showed
  | { type: 'storedPost', runId: number, repo: string, viewer: string, headSha: string, reviewedSha: string, form: PostForm, ci: StoredOffer['ci'] }
  | ActionConfirm

// the control that opened the drawer, named by its data-focus-key, so focus can go back to it
export type Opener = { key: string, number: number }

export type Tone = DoneTone | 'blue'

// the header: the PR as the row carries it
export type HeaderModel = {
  number: number
  url: string
  heading: string
  author: string
  title: string
  // head → base · head 755b78b
  refs: string
}

// a Closed row alone knows its head branch and neither its base nor its head
const refsText = (row: Pick<OpenRow, 'headRef' | 'baseRef' | 'headOid'>): string => {
  if (row.headRef === '' || row.baseRef === '') return row.headRef
  return `${row.headRef} → ${row.baseRef} · head ${shortSha(row.headOid)}`
}

export const headerModel = (row: OpenRow): HeaderModel => ({
  number: row.number,
  url: row.url,
  heading: `Agent for #${row.number}`,
  // a PR the auto-review log opened after it closed has neither an author nor refs to show
  author: row.author.login === '' ? '' : `${row.author.alias} · @${row.author.login}`,
  title: row.title,
  refs: refsText(row),
})

// the row of a PR that is no longer open, for a run the auto-review log names: the title the log kept and the PR's address, and an idle cell with no start to offer, so the drawer has the run's own card, its previous runs, and its reports, and nothing it could start or change
export const goneRow = (number: number, title: string | null, url: string): OpenRow => ({
  number,
  url,
  title: title ?? '',
  author: { login: '', alias: '' },
  headRef: '', baseRef: '', headOid: '', headSha: '',
  section: 'others',
  agent: {
    state: 'idle', label: 'Review', action: { kind: 'review', label: 'Review', command: 'review-pr', args: [String(number)], runner: 'claude' }, starts: [],
    models: { claude: '', codex: '' }, lastReviewAt: null,
    runId: null, runner: null, command: null, args: null, status: null, startedAt: null, lastStepAt: null, step: null,
    steps: [], tandem: false, commit: null, finishedAt: null, text: null, result: null, question: null, note: null, jumped: false, resolvedByHand: false, firstNote: null, resume: null, costUsd: null,
    extraInstructions: null, recorded: null, origin: null, queuedAt: null, posted: null, postOffer: null, storedOffer: null, stackRun: null,
  },
} as unknown as OpenRow)

// the row the read-only drawer draws a Closed PR from: what the closed search says of it and, when the cache still holds them, the base and head it last had, with goneRow's idle cell, which offers no start
export const closedDrawerRow = (row: ClosedRow, last: LastReadings | null): OpenRow => ({
  ...goneRow(row.number, row.title, row.url),
  author: row.author,
  headRef: row.headRef,
  ...last === null ? {} : { baseRef: last.baseRef, headOid: shortSha(last.headSha), headSha: last.headSha },
})

export const goneText = (number: number): string => `#${number} is no longer open`

// the Start section: one button per offered start, in the order the server offers them (the tandem review first where one is offered, then the plain review). A start that cannot run says why in the drawer's own text; when every button gives the same reason it is said once. A Fix session offered only for the relevancy check's prompt has no button here: it is started from the prompt, since without it there is nothing to fix
export type StartButton = { kind: StartKind, text: string, disabled: boolean, reason: string | null }
export type StartsModel = { buttons: StartButton[], shared: string | null }

export const startsModel = (cell: AgentCell, open: boolean, number: number): StartsModel => {
  const closed = open ? null : `Starting is off: ${goneText(number)}.`
  const buttons = cell.starts.filter((option) => !promptOnly(option)).map((option): StartButton => {
    const reason = closed ?? (option.unavailable === null ? null : sentence(option.unavailable))
    return { kind: option.kind, text: option.button, disabled: reason !== null, reason }
  })
  const first = buttons[0]?.reason ?? null
  if (first !== null && buttons.every((button) => button.reason === first)) {
    return { buttons: buttons.map((button) => ({ ...button, reason: null })), shared: first }
  }
  return { buttons, shared: null }
}

// a Fix session the PR offers for the relevancy check's prompt alone: GitHub shows no request and no self-review of its head has findings
const promptOnly = (option: StartOption): boolean =>
  option.kind === 'fix' && option.fix !== undefined && !option.fix.remote && option.fix.selfReview === null && option.fix.relevancy !== null

// the relevancy check's prompt a Fix session can take now: the latest run's, while it is a done check of the current head that found updates needed and the PR offers a Fix session for it; null otherwise
export const cellPrompt = (cell: AgentCell): FixPromptAsk | null => {
  const result = cell.result
  if (cell.state !== 'done' || cell.status !== 'done' || cell.runId === null || result?.kind !== 'relevancy' || result.needsUpdates !== true || result.fixPrompt === null) return null
  const offered = optionOf(cell, 'fix')?.fix?.relevancy?.runId
  return offered === cell.runId ? { runId: cell.runId, text: result.fixPrompt } : null
}

export const optionOf = (cell: AgentCell, kind: StartKind): StartOption | undefined =>
  cell.starts.find((option) => option.kind === kind)

// the runner a start opens with: the configured one, but Claude for tandem, and never one the
// start does not work with
export const defaultRunner = (option: Pick<StartOption, 'kind' | 'runners'>, configured: RunnerName): RunnerName => {
  if (option.kind === 'tandem') return 'claude'
  return option.runners.includes(configured) ? configured : option.runners[0] ?? 'claude'
}

// whether a start asks for the comments check: the box is checked and this start offers it
export const commentsCheckOn = (asked: { checkComments?: boolean }, option: Pick<StartOption, 'checkCommentsArgs'>): boolean =>
  asked.checkComments === true && option.checkCommentsArgs !== undefined

// the special instructions a start sends: the box's text, only when this start offers the box, its checkbox is checked, and the text is not empty once space is trimmed; otherwise undefined, which sends no field
export const specialInstructionsSent = (asked: { extraOn?: boolean, extraText?: string }, option: Pick<StartOption, 'extraInstructions'>): string | undefined => {
  if (option.extraInstructions === undefined || asked.extraOn !== true) return undefined
  const text = asked.extraText ?? ''
  return text.trim() === '' ? undefined : text
}
export type StartConfirmModel = {
  kind: StartKind
  heading: string
  title: string
  // the command as the runner receives it
  command: string
  // the runners to choose between; one means no choice is shown
  runners: { name: RunnerName, label: string }[]
  runner: RunnerName
  runnerLabel: string
  // the model the chosen runner will start with, and every runner's, which the launcher named from the configuration the command is built from
  model: string
  models: RunnerModels
  // the Self-review's box; null for a start that does not offer it
  commentsCheck: { label: string, detail: string, checked: boolean } | null
  // a review's Special instructions box, behind a checkbox; null for a start that does not offer it. The text is kept while the box is unchecked and hidden
  extraBox: { label: string, toggle: string, detail: string, checked: boolean, text: string } | null
  effect: string
  effectKind: StartOption['posts']['kind']
  // a Fix session's line about what it acts on; null for every other start, and for an entry from before the field
  sources: string | null
  // the relevancy check's prompt a Fix session hands over, shown whole under the command; null for every other start
  prompt: string | null
  // a start that pushes to the PR's branch is confirmed with a caution treatment and this plain
  // line about the push; null for a review
  caution: string | null
  confirm: string
  busy: string
  // a review start that would wait also offers Start immediately (jump queue): the button and the line that says what it does; null otherwise
  jump: { button: string, text: string } | null
  // a start on a PR whose auto-review run is only queued says the start replaces that run; null otherwise
  replaces: string | null
}

// null when the PR no longer offers that start. A Fix session pushes commits, so its confirmation
// names the branch in its heading, says plainly what the push does, and has a Start of its own
// what a Fix session says it addresses: the command's default, the more recent of GitHub's requested changes and the latest self-review report, which it names at its short SHA when the PR has one for its current head
// a Fix session started from the relevancy check's prompt addresses that prompt, and the default sources besides when the PR has any
export const fixPromptSourcesLine = (fix: StartOption['fix']): string => {
  if (fix === undefined || (!fix.remote && fix.selfReview === null)) return 'It addresses the relevancy check\'s prompt below; GitHub shows no request and this PR has no self-review report for its current head.'
  return (fixSourcesLine(fix) ?? '').replace(/^It addresses /, 'It addresses the relevancy check\'s prompt below, as well as ')
}

export const fixSourcesLine = (fix: StartOption['fix']): string | null => {
  if (fix === undefined) return null
  const base = 'It addresses the more recent of GitHub\'s requested changes and your self-review report'
  if (fix.selfReview === null) return `${base}; this PR has no self-review report for its current head, so it addresses GitHub's requests.`
  const named = `${base} at ${fix.selfReview.sha}`
  return fix.remote ? `${named}.` : `${named}; GitHub shows no request, so it addresses that report.`
}

export const startConfirmModel = (row: Pick<OpenRow, 'number' | 'title' | 'headRef'>, cell: AgentCell, kind: StartKind, runner: RunnerName, checkComments = false, extraText?: string, extraOn = false, fixPrompt?: FixPromptAsk): StartConfirmModel | null => {
  const option = optionOf(cell, kind)
  if (option === undefined) return null
  // the prompt rides on a Fix session alone, as the file the flag names; the command shows the flag, never the text
  const handed = kind === 'fix' ? fixPrompt ?? null : null
  const chosen = option.runners.includes(runner) ? runner : defaultRunner(option, cell.action.runner)
  const push = option.posts.kind === 'push'
  const checked = commentsCheckOn({ checkComments }, option)
  const args = checked ? option.checkCommentsArgs ?? option.args : option.args
  const sent = specialInstructionsSent({ extraOn, ...(extraText === undefined ? {} : { extraText }) }, option)
  // the command shows the flag, and never the text, when special instructions are sent or, with none sent, a standing default is set, which a start without the field runs under
  const flagged = handed !== null
    ? [...args, '--extra-instructions']
    : option.extraInstructions !== undefined && (sent !== undefined || option.extraInstructions.standing.trim() !== '') ? [...args, option.extraInstructions.flag] : args
  return {
    kind,
    heading: push ? `Push fixes to ${row.headRef}?` : `${option.label} #${row.number}?`,
    title: row.title,
    command: commandLine({ command: option.command, args: flagged }, chosen),
    runners: option.runners.map((name) => ({ name, label: runnerLabels[name] })),
    runner: chosen,
    runnerLabel: runnerLabels[chosen],
    model: cell.models[chosen],
    models: cell.models,
    commentsCheck: option.checkCommentsArgs === undefined ? null : {
      label: 'Also check the latest comments',
      detail: 'Reads the PR\'s latest comments from anyone and reports which points the branch has not addressed. It changes nothing.',
      checked,
    },
    extraBox: option.extraInstructions === undefined ? null : {
      label: 'Special instructions',
      toggle: 'Add special instructions for this review',
      detail: 'For this review only. The reviewer reads them from a file, and the report does not show them unless they ask for that. Nothing is sent unless this is checked and the box has text. Unchecking hides the box and keeps what it holds. At most 2,000 characters.',
      checked: extraOn,
      text: extraText ?? '',
    },
    effect: option.posts.text,
    effectKind: option.posts.kind,
    sources: option.kind !== 'fix' ? null : handed === null ? fixSourcesLine(option.fix) : fixPromptSourcesLine(option.fix),
    prompt: handed?.text ?? null,
    caution: push ? `It pushes new commits to ${row.headRef} on GitHub under your account, and never force-pushes.` : null,
    confirm: push ? 'Start fix session' : 'Start',
    busy: push ? 'Starting fix session…' : 'Starting…',
    jump: option.jump ?? null,
    replaces: option.replaces ?? null,
  }
}

// what the run details say of a run the owner started ahead of the queue; null for every other run, and for a run from before it was recorded
export const jumpedLine = (jumped: boolean | undefined): string | null => jumped === true ? 'Started ahead of the queue with Start immediately (jump queue).' : null

// the extra review instructions a run used, for its card and its line in the previous runs; a run without any shows nothing
export type ExtraLine = { term: string, from: string, text: string }

// a Fix session started from the relevancy check's prompt ran under that prompt, which its line names
export const extraLine = (extra: AgentCell['extraInstructions']): ExtraLine | null => {
  if (extra === null) return null
  if (extra.source === 'relevancy') return { term: 'Fix prompt', from: 'from the relevancy check', text: extra.text }
  return { term: 'Extra instructions', from: extra.source === 'default' ? 'from Settings' : 'typed for this run', text: extra.text }
}

// the roles and models a run recorded (section 8 of DESIGN.md, Launching runs, Recording the models): one line, with a flag for a role the pinned fallback replaced and for a review that ended degraded; a run from before they were recorded reads as not recorded
export type ModelsLine = { term: string, text: string, flags: string[] }

const modelRunnerLabels: Readonly<Record<string, string>> = { ...runnerLabels, hermes: 'Hermes' }

const capitalized = (word: string): string => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`

// a response from before the field existed lacks it entirely, which reads the same as null
export const modelsLine = (models: RunModels | null | undefined): ModelsLine => {
  if (models == null) return { term: 'Models', text: 'not recorded', flags: [] }
  const text = models.roles.map((role) => {
    const name = role.id ?? role.model ?? 'Codex default'
    return `${capitalized(role.role)}: ${name} (${modelRunnerLabels[role.runner] ?? role.runner})${role.outcome === null ? '' : `, ${role.outcome}`}`
  }).join(' · ')
  const flags = [
    ...models.roles.filter((role) => role.fallback).map((role) => `The pinned fallback replaced the ${role.role}.`),
    ...(models.degraded ? ['Degraded: the review ended on one surviving draft, so it was not posted.'] : []),
  ]
  return { term: 'Models', text, flags }
}

// the five-step bar
const stepOrder = ['resolveBase', 'review', 'consolidate', 'writeReport', 'post'] as const

export type StepModel = {
  step: string
  label: string
  state: StepSlot['state']
  // a mark for each state, so the four read apart without color
  glyph: string
  // the state in words, shown under the label and read by screen readers
  text: string
  at: string | null
}

const glyphs: Readonly<Record<StepSlot['state'], string>> = { pending: '○', started: '◐', done: '✓', skipped: '–' }

const stateWords: Readonly<Record<StepSlot['state'], string>> = { pending: 'pending', started: 'started', done: 'done', skipped: 'skipped' }

// always the five steps in order, whatever the cell carries, named for the run's command
export const stepModels = (steps: readonly StepSlot[], command: string | null = null): StepModel[] =>
  stepOrder.map((name) => {
    const slot = steps.find((candidate) => candidate.step === name)
    const state = slot?.state ?? 'pending'
    return { step: name, label: stepTitle(command, name), state, glyph: glyphs[state], text: stateWords[state], at: slot?.at ?? null }
  })

// "Resolve base: done. Review: started. ..." for the list's accessible name
export const stepsName = (models: readonly StepModel[]): string =>
  `Progress. ${models.map((model) => `${model.label}: ${model.text}`).join('. ')}`

// the newest step's note, with the step it belongs to; a step with no note has nothing to say
export const newestNote = (steps: readonly StepSlot[], command: string | null = null): { label: string, note: string } | null => {
  let newest: StepSlot | null = null
  for (const slot of steps) {
    if (slot.at === null) continue
    if (newest === null || Date.parse(slot.at) >= Date.parse(newest.at ?? '')) newest = slot
  }
  if (newest === null || newest.note === null || newest.note === '') return null
  return { label: stepTitle(command, newest.step), note: newest.note }
}

export type RunningModel = {
  extra: ExtraLine | null
  models: ModelsLine
  // whether the run was started ahead of the queue, in words; null when it was not
  jumped: string | null
  label: string
  tandem: boolean
  runnerLabel: string
  sha: string
  steps: StepModel[]
  stepsName: string
  note: { label: string, note: string } | null
}

export const runningModel = (row: Pick<OpenRow, 'headOid'>, cell: AgentCell): RunningModel => {
  const steps = stepModels(cell.steps, cell.command)
  const sha = shortSha(row.headOid)
  return {
    label: cell.label,
    tandem: cell.tandem,
    runnerLabel: cell.runner === null ? 'its runner' : runnerLabels[cell.runner],
    sha,
    steps,
    stepsName: stepsName(steps),
    note: newestNote(cell.steps, cell.command),
    extra: extraLine(cell.extraInstructions),
    models: modelsLine(cell.recorded),
    jumped: jumpedLine(cell.jumped),
  }
}

// a review waiting for a slot under the cap on concurrent reviews: what waits and why, with no steps or timer, since nothing runs yet
export type QueuedModel = { label: string, tandem: boolean, runnerLabel: string, note: string, extra: ExtraLine | null }

export const queuedModel = (cell: AgentCell): QueuedModel => ({
  label: cell.label,
  tandem: cell.tandem,
  runnerLabel: cell.runner === null ? 'its runner' : runnerLabels[cell.runner],
  note: 'Waiting for a review slot: it starts by itself when an earlier review or sweep ends, in the order it was queued.',
  extra: extraLine(cell.extraInstructions),
})

// the stop confirmation: what stops and what stays behind
export type StopModel = {
  heading: string
  detail: string
  effect: string
  after: string | null
  confirm: string
  busy: string
}

export const stopModel = (number: number, cell: Pick<AgentCell, 'label' | 'runner'>, andOpen: boolean): StopModel => ({
  heading: `Stop the run on #${number}?`,
  detail: `${cell.label} in ${cell.runner === null ? 'its runner' : runnerLabels[cell.runner]}`,
  effect: 'Stops the session and everything it started. Anything it already posted stays on GitHub, and a throwaway worktree under ~/agents/worktrees may remain.',
  after: andOpen ? 'Then the command to resume the session appears here.' : null,
  confirm: andOpen ? 'Stop and open' : 'Stop run',
  busy: 'Stopping…',
})

// the same confirmation for a queued review, which leaves the queue: nothing has run, so nothing stays behind
export const queuedStopModel = (number: number, cell: Pick<AgentCell, 'label' | 'runner'>): StopModel => ({
  heading: `Remove #${number} from the queue?`,
  detail: `${cell.label} in ${cell.runner === null ? 'its runner' : runnerLabels[cell.runner]}`,
  effect: 'It has not started, so nothing ran and nothing was posted. It stays in the list of runs as stopped.',
  after: null,
  confirm: 'Remove from queue',
  busy: 'Removing…',
})

// the Re-read result action on the latest-run card: for a failed run or one waiting for an answer that has a session to resume, since only a session someone resumed can have changed its result.json
export type RereadOffer = { button: string, disabled: boolean, reason: string | null, runId: number }

export const rereadOffer = (cell: AgentCell, open: boolean, number: number): RereadOffer | null => {
  if (cell.runId === null || cell.resume === null || (cell.status !== 'failed' && cell.status !== 'needsInput') || cell.starts.length === 0) return null
  return { button: 'Re-read result', disabled: !open, reason: open ? null : `Re-reading is off: ${goneText(number)}.`, runId: cell.runId }
}

// the confirmation: what is read, what it can replace, and the commit and base it is bound to
export type RereadAskModel = {
  heading: string
  title: string
  detail: string
  reads: string
  effect: string
  bound: string
  confirm: string
  busy: string
}

export const rereadAskModel = (row: Pick<OpenRow, 'number' | 'title'>, cell: Pick<AgentCell, 'label' | 'runner' | 'text'>, ask: Extract<Confirm, { type: 'reread' }>): RereadAskModel => ({
  heading: `Read the result of #${row.number} again?`,
  title: row.title,
  detail: `${cell.label} in ${cell.runner === null ? 'its runner' : runnerLabels[cell.runner]}, recorded as ${cell.text ?? 'finished'}`,
  reads: 'The run\'s result.json and events.jsonl, as your resumed session left them. Nothing is posted to GitHub.',
  effect: 'Replaces the recorded outcome when the new result passes the same checks (same PR, command, and reviewed commit, and its report exists). The run keeps the note of what first went wrong and is marked finished by hand. If a check fails, the run stays as it is and this says why.',
  bound: `For the head ${shortSha(ask.headSha)} on ${ask.baseRef} in ${ask.repo}, as ${ask.viewer}.`,
  confirm: 'Re-read result',
  busy: 'Reading…',
})

// Post it, on the latest-run card: only what the server offers, since only the server can tell a run allowed to post
export type PostOfferModel = { button: string, disabled: boolean, reason: string | null, runId: number }

export const postItOffer = (cell: AgentCell, open: boolean, number: number): PostOfferModel | null => {
  if (cell.postOffer === null) return null
  return { button: 'Post it', disabled: !open, reason: open ? null : `Posting is off: ${goneText(number)}.`, runId: cell.postOffer.runId }
}

// the confirmation: the PR, the form, the saved report, the command, and whose account it posts under
export type PostAskModel = {
  heading: string
  title: string
  report: string
  command: string
  effect: string
  bound: string
  confirm: string
  busy: string
}

export const postAskModel = (row: Pick<OpenRow, 'number' | 'title'>, offer: NonNullable<AgentCell['postOffer']>): PostAskModel => {
  const words = postedWords[offer.form] ?? offer.form
  return {
    heading: `Post the report on #${row.number} as ${words}?`,
    title: row.title,
    report: offer.report,
    command: offer.command,
    effect: `Posts the saved report ${offer.reportPath} to #${row.number} as ${words}, under your account (@${offer.viewer}), once. Pit View cannot undo it.`,
    bound: `For the head ${shortSha(offer.headSha)} in ${offer.repo}, as ${offer.viewer}.`,
    confirm: 'Post it',
    busy: 'Posting…',
  }
}

// the post button on an auto-review run that did not post (section 10, Posting): one button per form the server offers, in its order, attached to the run in the Auto-review list that the offer is about
export const storedButtonText: Readonly<Record<PostForm, string>> = { approve: 'Approve', requestChanges: 'Request Changes', comment: 'Comment' }

export type StoredButtonsModel = { runId: number, buttons: { form: PostForm, text: string }[], disabled: boolean, reason: string | null }

export const storedButtonsModel = (cell: AgentCell | null, open: boolean, number: number): StoredButtonsModel | null => {
  const offer = cell?.storedOffer
  if (offer == null) return null
  return {
    runId: offer.runId,
    buttons: offer.forms.map((form) => ({ form, text: storedButtonText[form] })),
    disabled: !open,
    reason: open ? null : `Posting is off: ${goneText(number)}.`,
  }
}

export const ciWords: Readonly<Record<StoredOffer['ci'], string>> = {
  green: 'green',
  pending: 'pending. Checks are still running. It does not block the post.',
  failed: 'failed. It does not block the post.',
  none: 'none. No checks have run. It does not block the post.',
}

// the confirmation: the form and the report, the login it posts as, the CI state read when the button was clicked, and, when the head has moved, the plain sentence naming both heads. A moved head offers Post anyway and a third button that starts a review instead
export type StoredAskModel = {
  runId: number
  heading: string
  title: string
  report: string
  command: string
  effect: string
  ci: string
  // null while the head has not moved
  headMoved: string | null
  bound: string
  confirm: string
  busy: string
  // the existing review start the third button opens, null when the head has not moved or nothing can start
  fresh: { kind: StartKind, text: string, disabled: boolean, reason: string | null } | null
}

export const storedAskModel = (row: Pick<OpenRow, 'number' | 'title'>, cell: AgentCell, ask: Extract<Confirm, { type: 'storedPost' }>, open: boolean): StoredAskModel | null => {
  const offer = cell.storedOffer
  if (offer == null || !open || !confirmHolds(ask, cell, open)) return null
  const words = postedWords[ask.form] ?? ask.form
  const moved = offer.reviewedSha !== offer.headSha
  const starts = startsModel(cell, open, row.number)
  const start = starts.buttons[0]
  return {
    runId: offer.runId,
    heading: `Post the stored report on #${row.number} as ${words}?`,
    title: row.title,
    report: offer.report,
    command: offer.commands[ask.form] ?? '',
    effect: `Posts the saved report ${offer.reportPath} to #${row.number} as ${words}, under your account (@${offer.viewer}), once. Pit View cannot undo it.`,
    ci: `CI now: ${ciWords[ask.ci]}`,
    headMoved: moved ? `New commits since this review: reviewed ${shortSha(offer.reviewedSha)}, now ${shortSha(offer.headSha)}. Post this report as @${offer.viewer} anyway?` : null,
    bound: `For the head ${shortSha(offer.headSha)} in ${offer.repo}, as ${offer.viewer}, the report from run ${offer.runId} reviewing ${shortSha(offer.reviewedSha)}.`,
    confirm: moved ? 'Post anyway' : 'Post',
    busy: 'Posting…',
    fresh: !moved || start === undefined ? null : { kind: start.kind, text: 'Start a new review', disabled: start.disabled, reason: start.reason ?? starts.shared },
  }
}

export type WaitingModel = { question: string, resume: string | null, copyName: string, extra: ExtraLine | null, models: ModelsLine, jumped: string | null }

export const waitingModel = (cell: AgentCell, number: number): WaitingModel => ({
  question: cell.question ?? 'The run stopped to ask a question but did not record it. Open its session to see it.',
  resume: cell.resume,
  copyName: `Copy resume command for #${number}`,
  extra: extraLine(cell.extraInstructions),
  models: modelsLine(cell.recorded),
  jumped: jumpedLine(cell.jumped),
})

// why a run failed, in words; the kinds are Pit View's own, and a detail after the colon is kept
const failureWords: Readonly<Record<string, string>> = {
  badResult: 'The run\'s result file contradicts itself or names the wrong report or branch',
  noResult: 'The run ended without a valid result file',
  noReport: 'The run said it was done, but its report file is missing',
  permissionDenied: 'A tool call was denied, so the run was failed rather than left half done',
  serverRestarted: 'Pit View restarted while the run was going and could not tell how it ended',
  spawnFailed: 'The runner could not be started',
}

export const noteText = (note: string | null): string | null => {
  if (note === null || note.trim() === '') return null
  const at = note.indexOf(':')
  const kind = at < 0 ? note : note.slice(0, at)
  const words = failureWords[kind]
  if (words === undefined) return note
  const detail = at < 0 ? '' : note.slice(at + 1).trim()
  return detail === '' ? `${words}.` : `${words}: ${detail}`
}

export const postedWords: Readonly<Record<string, string>> = { approve: 'an approval', requestChanges: 'a request for changes', comment: 'a comment' }

const notPostedWords: Readonly<Record<string, string>> = {
  noPost: 'nothing: the run was told not to post',
  ownPr: 'nothing: it is your own PR',
  awaitingAnswer: 'nothing yet: it waits for your answer',
  ghFailed: 'unknown: the post failed and may have landed',
  postBlocked: 'nothing: a permission check refused the post',
  ciPending: 'nothing: CI had not finished',
  headMoved: 'nothing: the head moved since the review',
}

export type Fact = { label: string, value: string, href: string | null }

type UpdateSummary = Extract<AgentResult, { kind: 'update' }>

const checkFact = (checks: UpdateSummary['checks']): string =>
  checks.length === 0 ? 'none run: no conflict needed resolving' : checks.map((check) => `${check.name} ${checkWords[check.result]?.text ?? check.result}`).join(', ')

// a finished Update session: the method and why, the push, the conflicts it resolved, the checks, and a worktree it left behind
const updateFacts = (result: UpdateSummary): Fact[] => {
  const base = result.base ?? 'the primary branch'
  const facts: Fact[] = []
  if (result.method !== null) {
    const what = result.method === 'rebase' ? `rebase onto ${base}` : `merge of ${base}`
    facts.push({ label: 'Method', value: `${what}${result.upstream === null ? '' : ` at ${result.upstream}`}${result.methodReason === null ? '' : `: ${result.methodReason}`}`, href: null })
  }
  if (result.pushed !== null) {
    facts.push({ label: 'Pushed', value: `${result.pushed.branch} at ${shortSha(result.pushed.head)}${result.pushed.forced ? ', with --force-with-lease' : ''}`, href: null })
  }
  if (result.method !== null) {
    const count = result.conflicts.length
    facts.push({ label: 'Conflicts', value: count === 0 ? 'none' : `${count} resolved: ${result.conflicts.map((conflict) => `${conflict.path} (${conflict.resolution})`).join('; ')}`, href: null })
    facts.push({ label: 'Checks', value: checkFact(result.checks), href: null })
  }
  if (result.worktree !== null) facts.push({ label: 'Worktree', value: result.pushed === null ? `The update not pushed is in ${result.worktree}` : `Its worktree was left behind in ${result.worktree}`, href: null })
  return facts
}

const resultFacts = (cell: AgentCell): Fact[] => {
  const result = cell.result
  if (result?.kind === 'update') return updateFacts(result)
  // a relevancy check's verdict has a block of its own; its facts say what it judged against
  if (result?.kind === 'relevancy') return result.base === null ? [] : [{ label: 'Base', value: result.upstream === null ? result.base : `${result.base} at ${result.upstream}`, href: null }]
  // a fix's summary has a block of its own
  if (result === null || result.kind !== 'review') return []
  const facts: Fact[] = []
  if (result.verdict !== null) facts.push({ label: 'Findings', value: `${result.findings} ${result.findings === 1 ? 'finding' : 'findings'}`, href: null })
  if (result.ci !== null) facts.push({ label: 'CI', value: result.ci, href: null })
  if (result.posted !== null) facts.push({ label: 'Posted', value: postedWords[result.posted.form] ?? result.posted.form, href: safeHref(result.posted.url) })
  else if (result.notPostedReason !== null) facts.push({ label: 'Posted', value: notPostedWords[result.notPostedReason] ?? 'nothing', href: null })
  if (result.report !== null) facts.push({ label: 'Report', value: result.report, href: null })
  return facts
}

export const formatCost = (costUsd: number | null): string | null => costUsd === null ? null : `$${costUsd.toFixed(2)}`

// a finished Fix session: what it pushed, how it triaged the requests and how they ended, the
// checks, a worktree it left behind, and its report
type FixSummary = Extract<AgentResult, { kind: 'fix' }>

export type FixCheckModel = { name: string, text: string, tone: Tone }

export type FixModel = {
  pushed: { branch: string, commits: { sha: string, subject: string }[] } | null
  // "3 requests: 2 clear, 1 out of scope"
  requests: string
  // "2 fixed, 1 not fixed"; null when there were no requests
  outcomes: string | null
  checks: FixCheckModel[]
  // the worktree the run left behind, in words
  worktree: string | null
  // the report's file name, which the report panel opens
  report: { name: string, openName: string } | null
}

const triageWords: readonly [keyof FixSummary['triage'], string][] = [
  ['clear', 'clear'],
  ['needsJudgment', 'needing judgment'],
  ['noChange', 'needing no change'],
  ['disagree', 'disagreed with'],
  ['outOfScope', 'out of scope'],
]

const outcomeWords: readonly [keyof FixSummary['outcomes'], string][] = [
  ['fixed', 'fixed'],
  ['notFixed', 'not fixed'],
  ['awaitingAnswer', 'awaiting your answer'],
]

const checkWords: Readonly<Record<string, { text: string, tone: Tone }>> = {
  passed: { text: 'passed', tone: 'green' },
  failed: { text: 'failed', tone: 'red' },
  notRun: { text: 'not run', tone: 'amber' },
}

// the counts that are not zero, in words: "2 clear, 1 out of scope"
const counted = <K extends string>(counts: Readonly<Record<K, number>>, words: readonly [K, string][]): string =>
  words.filter(([key]) => counts[key] > 0).map(([key, word]) => `${counts[key]} ${word}`).join(', ')

// a report path's file name, as the report panel asks for it; only a Markdown file name will do
export const reportName = (path: string | null): string | null => {
  const name = path?.split('/').pop() ?? ''
  return /^[A-Za-z0-9._-]+\.md$/.test(name) ? name : null
}

export const fixModel = (result: FixSummary): FixModel => {
  const kinds = counted(result.triage, triageWords)
  const name = reportName(result.report)
  return {
    pushed: result.pushed === null ? null : { branch: result.pushed.branch, commits: result.pushed.commits.map((commit) => ({ ...commit })) },
    requests: result.requests === 0 ? 'No requests to act on' : `${result.requests} ${result.requests === 1 ? 'request' : 'requests'}${kinds === '' ? '' : `: ${kinds}`}`,
    outcomes: result.requests === 0 ? null : counted(result.outcomes, outcomeWords) || null,
    checks: result.checks.map((check) => ({ name: check.name, ...(checkWords[check.result] ?? { text: check.result, tone: 'gray' }) })),
    worktree: result.worktree === null ? null : result.pushed === null
      ? `Commits not pushed are in ${result.worktree}`
      : `Its worktree was left behind in ${result.worktree}`,
    report: name === null ? null : { name, openName: `Open report ${name}` },
  }
}

// the reviewed commit on the latest-run card: its short SHA, a link to it on GitHub (null when the repository is not a plausible owner/name), and whether the PR's head has moved past it
export type CommitModel = { short: string, href: string | null, moved: boolean }

// only 7 to 40 hex characters become a SHA and only owner/name a repository, so nothing else reaches the URL; a stack review reads its top layer, whose commit is not this PR's head, so it never counts as moved
export const commitModel = (commit: string | null, repo: string | undefined, headOid: string, command: string | null): CommitModel | null => {
  if (commit === null || !/^[0-9a-f]{7,40}$/i.test(commit)) return null
  const sha = commit.toLowerCase()
  const head = headOid.toLowerCase()
  const moved = command !== 'review-stack' && head !== '' && !head.startsWith(sha) && !sha.startsWith(head)
  const href = repo !== undefined && /^[\w.-]+\/[\w.-]+$/.test(repo) && !repo.split('/').some((part) => /^\.+$/.test(part)) ? `https://github.com/${repo}/commit/${sha}` : null
  return { short: shortSha(sha), href, moved }
}

export type ResultModel = {
  extra: ExtraLine | null
  models: ModelsLine
  // whether the run was started ahead of the queue, in words; null when it was not
  jumped: string | null
  text: string
  tone: DoneTone
  runnerLabel: string
  // the finish time; drawer.ts writes "finished 17h ago" and keeps it current
  finishedAt: string | null
  // the commit the run read, from its record; null when the record has none
  commit: CommitModel | null
  note: string | null
  cost: string | null
  resume: string | null
  copyName: string
  facts: Fact[]
  // a Fix session's own block; null for a review
  fix: FixModel | null
  // a relevancy check's own block; null for every other run
  relevancy: RelevancyModel | null
  // set when the PR's head moved past the commit this run reviewed
  stale: string | null
  // set when the owner's re-read replaced this run's recorded outcome, and why it had one
  byHand: string | null
  // set when the run's ask is "Clean · mark ready?" and the drawer offers Mark ready: says where the action is, and does nothing itself
  ready: string | null
  // set when the review finished and its post was refused: says so and says that nothing reached GitHub
  notPosted: string | null
  // that run's saved report, for the report panel
  report: { name: string, openName: string } | null
}

// the quiet line that points the "Clean · mark ready?" ask at the Actions section; null unless the done text is that ask and Mark ready is offered now, which already means the viewer's own open draft
export const readyPointer = (text: string | null, offers: readonly ActionOffer[]): string | null =>
  text !== null && text.startsWith('Clean · mark ready?') && offers.some((offer) => offer.action === 'markReady')
    ? 'Mark it ready from the Actions section above: Mark ready.'
    : null

// how the original failure reads beside a result the owner finished by hand
const byHandText = (note: string | null): string => {
  const was = noteText(note)
  const reread = 'Pit View read the result again at your request.'
  if (note === null || was === null) return `Finished by hand: ${reread}`
  return note.startsWith('permissionDenied') ? `Finished by hand after a denied tool call (${note.slice(note.indexOf(':') + 1).trim() || 'unnamed'}): ${reread}` : `Finished by hand after an earlier failure (${was.replace(/\.$/, '')}): ${reread}`
}

const isBlockedPost = (result: AgentResult | null): result is Extract<AgentResult, { kind: 'review' }> =>
  result?.kind === 'review' && result.notPostedReason === 'postBlocked' && result.posted === null

const blockedReport = (result: AgentResult | null): ResultModel['report'] => {
  const name = isBlockedPost(result) ? reportName(result.report) : null
  return name === null ? null : { name, openName: `Open report ${name}` }
}

// a relevancy check's verdict, its reason, and the next step it points at: Close PR in the Actions section for an irrelevant PR, the prompt with its copy control and its Fix session when updates are needed, and nothing more for a relevant PR with nothing to update, which gets the actions any PR gets
export type RelevancyModel = {
  verdict: 'Relevant' | 'Irrelevant'
  reason: string
  // whether updates are needed, in words; null for an irrelevant PR
  updates: string | null
  // says where Close PR is, and does nothing itself; null unless the Actions section offers it now
  close: string | null
  // the prompt, its copy control's name, and the button that asks the Fix session's confirmation with it; null when the check wrote none
  prompt: { text: string, copyName: string, fix: { text: string, disabled: boolean, reason: string | null } } | null
}

// the base a relevancy check judged, when the PR now targets another one; null otherwise
const judgedBaseIfRetargeted = (cell: AgentCell, baseRef: string): string | null =>
  cell.result?.kind === 'relevancy' && cell.result.base !== null && cell.result.base !== baseRef ? cell.result.base : null

export const relevancyModel = (cell: AgentCell, number: number, offers: readonly ActionOffer[], baseRef: string): RelevancyModel | null => {
  const result = cell.result
  if (result?.kind !== 'relevancy' || cell.status !== 'done' || result.verdict === null) return null
  const irrelevant = result.verdict === 'irrelevant'
  const option = optionOf(cell, 'fix')
  const ready = cellPrompt(cell) !== null && option !== undefined && option.unavailable === null
  const judged = judgedBaseIfRetargeted(cell, baseRef)
  const why = ready
    ? null
    : judged !== null
      ? `The PR now targets ${baseRef}, not ${judged}, the base this check judged, so its prompt was written for another base.`
    : cell.state === 'idle'
      ? 'The head has moved since this check, so its prompt covers an earlier commit.'
      : option?.unavailable != null ? sentence(option.unavailable) : `A Fix session is not offered for #${number} now.`
  return {
    verdict: irrelevant ? 'Irrelevant' : 'Relevant',
    reason: result.reason ?? '',
    updates: irrelevant ? null : result.needsUpdates === true ? 'Updates needed: the check wrote a prompt for a Fix session.' : 'No updates needed.',
    close: irrelevant && offers.some((offer) => offer.action === 'close') ? 'Close it from the Actions section above: Close PR.' : null,
    prompt: irrelevant || result.needsUpdates !== true || result.fixPrompt === null ? null : {
      text: result.fixPrompt,
      copyName: 'Copy prompt',
      fix: { text: 'Start fix session with this prompt', disabled: !ready, reason: why },
    },
  }
}

// why an idle cell's run no longer stands: a relevancy check's PR was retargeted, or the head moved on; null while it stands
const staleText = (cell: AgentCell, baseRef: string): string | null => {
  if (cell.state !== 'idle') return null
  const judged = judgedBaseIfRetargeted(cell, baseRef)
  if (cell.command === 'relevancy-pr' && judged !== null) return `The PR now targets ${baseRef}, not ${judged}, the base this check judged. Check relevancy again for the current one.`
  if (cell.command === 'relevancy-pr') return 'The head has moved since this check, so it covers an earlier commit. Check relevancy again for the current one.'
  if (cell.command === 'fix-pr' || cell.command === 'update-pr') return 'The head has moved since this run, so it covers an earlier commit.'
  return 'The head has moved since this run, so it covers an earlier commit. Start a new review for the current one.'
}

export const resultModel = (cell: AgentCell, number: number, headOid: string, offers: readonly ActionOffer[], baseRef: string): ResultModel => ({
  text: cell.text ?? 'Done',
  tone: doneTone({ status: cell.status, text: cell.text }),
  runnerLabel: cell.runner === null ? 'its runner' : runnerLabels[cell.runner],
  finishedAt: cell.finishedAt,
  commit: commitModel(cell.commit, cell.starts[0]?.repo, headOid, cell.command),
  // a run finished by hand keeps the note of its first failure, which byHand tells instead
  note: cell.resolvedByHand && cell.status !== 'failed' ? null : noteText(cell.note),
  cost: formatCost(cell.costUsd),
  resume: cell.resume,
  copyName: `Copy resume command for #${number}`,
  facts: resultFacts(cell),
  fix: cell.result?.kind === 'fix' ? fixModel(cell.result) : null,
  relevancy: relevancyModel(cell, number, offers, baseRef),
  stale: staleText(cell, baseRef),
  byHand: cell.resolvedByHand && cell.status === 'done' ? byHandText(cell.firstNote ?? cell.note) : null,
  ready: readyPointer(cell.text, offers),
  notPosted: isBlockedPost(cell.result) ? 'Review done, post not made: a permission check refused the post before it ran, so nothing reached GitHub.' : null,
  report: blockedReport(cell.result),
  extra: extraLine(cell.extraInstructions),
  models: modelsLine(cell.recorded),
  jumped: jumpedLine(cell.jumped),
})

// which card the latest run gets
export type CardKind = 'none' | 'queued' | 'running' | 'waiting' | 'result'

export const cardKind = (cell: AgentCell): CardKind => {
  if (cell.state === 'queued') return 'queued'
  if (cell.state === 'running') return 'running'
  if (cell.state === 'done' && cell.status === 'needsInput') return 'waiting'
  // an idle cell after a run still carries it, so the drawer can show what it found
  if (cell.runId !== null) return 'result'
  return 'none'
}

// previous runs: a compact line each
export type RunRow = { id: number, label: string, runner: string, text: string, tone: Tone, startedAt: string, cost: string | null, extra: ExtraLine | null, models: ModelsLine, jumped: string | null }

const failureShort: Readonly<Record<string, string>> = {
  badResult: 'bad result',
  noResult: 'no result',
  noReport: 'no report',
  permissionDenied: 'permission denied',
  serverRestarted: 'server restarted',
  spawnFailed: 'could not start',
}

// a finished fix's text, a client copy of the server's (section 8, the fix-result@1 table)
const notPushedTexts: Readonly<Record<string, string>> = {
  nothingToFix: 'Nothing to fix',
  awaitingAnswer: 'Not pushed',
  checksFailed: 'Not pushed · checks failed',
  checksNotRun: 'Not pushed · checks not run',
  pushFailed: 'Not pushed · push refused',
}

type FixResultJson = Extract<NonNullable<RunView['result']>, { schema: 'pit-crew/fix-result@1' }>
type UpdateResultJson = Extract<NonNullable<RunView['result']>, { schema: 'pit-crew/update-result@1' }>

// a finished update's text, a client copy of the server's (section 8, the update-result@1 reading)
const updateDoneText = (result: Pick<UpdateResultJson, 'pushed' | 'notPushedReason' | 'method' | 'target'>): string => {
  const base = result.target?.base ?? 'the primary branch'
  if (result.pushed !== null) return result.method === 'rebase' ? `Rebased onto ${base}` : `Merged ${base} in`
  if (result.notPushedReason === 'upToDate') return 'Already up to date'
  return result.notPushedReason === null ? 'Done' : notPushedTexts[result.notPushedReason] ?? 'Not pushed'
}

const fixDoneText = (result: Pick<FixResultJson, 'pushed' | 'notPushedReason'>): string => {
  if (result.pushed !== null) {
    const count = result.pushed.commits.length
    return `Fixed · pushed ${count} ${count === 1 ? 'commit' : 'commits'}`
  }
  return result.notPushedReason === null ? 'Done' : notPushedTexts[result.notPushedReason] ?? 'Not pushed'
}

export const runText = (run: Pick<RunView, 'status' | 'result' | 'note'> & { resolvedByHand?: boolean }): { text: string, tone: Tone } => {
  const outcome = outcomeText(run)
  return run.status === 'done' && run.resolvedByHand === true ? { ...outcome, text: `${outcome.text} · finished by hand` } : outcome
}

const outcomeText = (run: Pick<RunView, 'status' | 'result' | 'note'>): { text: string, tone: Tone } => {
  if (run.status === 'queued') return { text: 'Queued', tone: 'blue' }
  if (run.status === 'running') return { text: 'Running', tone: 'blue' }
  if (run.status === 'needsInput') return { text: 'Needs your answer', tone: 'amber' }
  if (run.status === 'stopped') return { text: 'Stopped', tone: 'gray' }
  if (run.status === 'skipped') return { text: 'Skipped', tone: 'gray' }
  if (run.status === 'failed') {
    const short = failureShort[(run.note ?? '').split(':')[0] ?? '']
    if (short !== undefined) return { text: `Failed · ${short}`, tone: 'red' }
    const pushRefused = (run.result?.schema === 'pit-crew/fix-result@1' || run.result?.schema === 'pit-crew/update-result@1') && run.result.notPushedReason === 'pushFailed'
    return { text: pushRefused ? 'Failed · push refused' : 'Failed', tone: 'red' }
  }
  const result = run.result
  if (result?.schema === 'pit-crew/fix-result@1' || result?.schema === 'pit-crew/update-result@1') {
    const text = result.schema === 'pit-crew/fix-result@1' ? fixDoneText(result) : updateDoneText(result)
    return { text, tone: doneTone({ status: 'done', text }) }
  }
  // a relevancy check reads as its verdict, a client copy of the server's
  if (result?.schema === 'pit-crew/relevancy-result@1') {
    const text = result.verdict === 'irrelevant' ? 'Irrelevant' : result.verdict === 'relevant' ? 'Relevant' : 'Done'
    return { text, tone: text === 'Done' ? 'gray' : doneTone({ status: 'done', text }) }
  }
  if (result === null || result.schema !== 'pit-crew/review-result@1' || result.verdict === null) return { text: 'Done', tone: 'gray' }
  if (result.notPostedReason === 'postBlocked' && result.posted === null) return { text: `${result.verdict === 'changesRequested' ? 'Changes requested' : 'Clean'} · post not made`, tone: 'amber' }
  const failed = result.notPostedReason === 'ghFailed'
  // a review that posted nothing because CI had not finished or the head moved says so, as the cell does
  const unposted = result.notPostedReason === 'ciPending' || result.notPostedReason === 'headMoved'
  const suffix = failed ? ' · post failed' : unposted ? ' · not posted' : ''
  if (result.verdict === 'changesRequested') return { text: `Changes requested${suffix}`, tone: 'red' }
  if (result.posted?.form === 'approve') return { text: `Approved${suffix}`, tone: 'green' }
  if (result.posted?.form === 'comment') return { text: `Clean · CI failed${suffix}`, tone: 'amber' }
  return { text: `Clean${suffix}`, tone: failed ? 'amber' : 'green' }
}

// every run but the one the card above already shows, and the auto-review runs, which have their own list
export const runRows = (runs: readonly RunView[], shownId: number | null): RunRow[] =>
  runs.filter((run) => run.id !== shownId && run.origin !== 'auto').map((run) => ({
    id: run.id,
    label: run.label,
    runner: runnerLabels[run.runner],
    ...runText(run),
    startedAt: run.startedAt,
    cost: formatCost(run.costUsd),
    extra: extraLine(run.extraInstructions),
    models: modelsLine(run.models),
    jumped: jumpedLine(run.jumped),
  }))

// the Auto-review list: each auto run of the PR (section 10, In the UI). startedAt is null until the run really started: a queued run, or one that failed or was skipped before its process, holds only the time it was queued
export type AutoRunRow = {
  id: number
  reason: string
  sha: string | null
  text: string
  tone: Tone
  posted: string
  // the post button, on the run it is about
  stored: StoredButtonsModel | null
  note: string | null
  // why a run that ended without running ended, in plain words; null for any other run
  why: string | null
  queuedAt: string | null
  startedAt: string | null
  finishedAt: string | null
}

// a run that never ran, and the plain reason its note names
const skippedWhy: Readonly<Record<string, string>> = { superseded: 'Replaced by a review you started by hand.' }

const autoReasons: Readonly<Record<string, string>> = {
  requested: 'Review requested',
  new: 'New PR',
  pushed: 'Pushed since the last review',
  selfReview: 'Self-review',
  dependabot: 'Dependabot',
}

const postedForms: Readonly<Record<PostForm, string>> = {
  approve: 'Posted as an approval',
  requestChanges: 'Posted as a change request',
  comment: 'Posted as a comment',
}

const unpostedWords: Readonly<Record<string, string>> = {
  noPost: 'Not posted: set to not post',
  postBlocked: 'Not posted: a permission check refused the post',
  ghFailed: 'Post failed',
  ownPr: 'Not posted: your own PR',
  awaitingAnswer: 'Not posted: waiting for your answer',
  ciPending: 'Not posted: CI had not finished',
  headMoved: 'Not posted: the head moved',
}

const autoPostedWords = (run: RunView): string => {
  if (run.status === 'queued' || run.status === 'running' || run.status === 'needsInput') return 'Not yet'
  const result = run.result
  if (result?.schema !== 'pit-crew/review-result@1') return 'No'
  if (result.posted !== null) return postedForms[result.posted.form]
  return result.notPostedReason === null ? 'No' : unpostedWords[result.notPostedReason] ?? 'No'
}

export const autoRunRows = (runs: readonly RunView[], stored: StoredButtonsModel | null = null): AutoRunRow[] =>
  runs.filter((run) => run.origin === 'auto').map((run) => ({
    id: run.id,
    stored: stored !== null && stored.runId === run.id ? stored : null,
    reason: autoReasons[run.reason ?? ''] ?? 'Auto-review',
    sha: run.headOid === null ? null : shortSha(run.headOid),
    ...runText(run),
    posted: autoPostedWords(run),
    note: run.note,
    why: run.status === 'skipped' ? skippedWhy[run.note ?? ''] ?? null : null,
    queuedAt: run.queuedAt,
    // started_at holds the queue time until the run really starts (section 10, Recording)
    startedAt: run.status === 'queued' || (run.status !== 'running' && run.pid === null) ? null : run.startedAt,
    finishedAt: run.finishedAt,
  }))

// reports on disk: a review's carries its verdict and a Tandem tag; a Fix session's a Fix tag and
// no verdict
export type ReportRow = {
  name: string
  modifiedAt: string
  sha: string | null
  fix: boolean
  verdict: { text: string, tone: Tone } | null
  tandem: boolean
  openName: string
}

export const reportRows = (reports: readonly ReportListing[]): ReportRow[] =>
  reports.map((report) => {
    const fix = report.kind === 'fix'
    return {
      name: report.name,
      modifiedAt: report.modifiedAt,
      sha: report.sha === null ? null : shortSha(report.sha),
      fix,
      verdict: fix ? null : report.verdict === 'changesRequested'
        ? { text: 'Changes requested', tone: 'red' }
        : report.verdict === 'clean' ? { text: 'Clean', tone: 'green' } : null,
      tandem: !fix && report.tandem,
      openName: `Open report ${report.name}`,
    }
  })

// a failed read in words, for the runs and reports lists
export const loadErrorText = (what: string, status: number, error: string | null): string => {
  if (status === 0) return `Could not load ${what}: Pit View did not answer.`
  const reason = sentence(error ?? '')
  return reason === '' ? `Could not load ${what}: Pit View answered ${status}.` : `Could not load ${what}. ${reason}`
}

// what the cache last held of a closed PR, as the drawer read it; null when it holds nothing of it
export type LastState = { state: 'loading' } | { state: 'error', message: string } | { state: 'ready', value: LastReadings | null }

// the read-only form of the drawer, on a Closed row (section 8 of DESIGN.md, Drawer, Closed PRs)
export type ClosedInput = { row: ClosedRow, last: LastState, nowMs: number }

export type ClosedModel = {
  note: string
  facts: [string, string][]
  last: { state: LastState['state'], message: string | null }
  // in place of the last readings, when the cache holds none
  lastNote: string | null
  // in place of both lists, once both have been read and neither has anything
  empty: string | null
  // in place of the runs list's own empty line, while no run is shown above it either
  noRuns: string | null
}

const reviewWords: Readonly<Record<ReviewerState, string>> = { approved: 'approved', changes: 'changes requested', commented: 'commented', requested: 'review requested' }
const lastCiWords: Readonly<Record<LastReadings['ci'], string>> = { green: 'green', pending: 'pending', failed: 'failed', none: 'no checks had run' }

const lastFacts = (last: LastReadings, nowMs: number): [string, string][] => [
  ['Review', last.reviewers.length === 0 ? 'no reviews' : last.reviewers.map((reviewer) => `${reviewer.alias}: ${reviewWords[reviewer.state]}`).join(', ')],
  ['CI', lastCiWords[last.ci]],
  ['Merge', last.merge.label],
  ['Last read', formatCached(last.asOf, nowMs)],
]

const closedModel = ({ row, last, nowMs }: ClosedInput, runs: Loadable<RunView>, reports: Loadable<ReportListing>): ClosedModel => {
  const held = last.state === 'ready' ? last.value : null
  const noRuns = runs.state === 'ready' && runs.items.length === 0
  return {
    note: `#${row.number} is closed, so this drawer is read-only.`,
    facts: [
      ['State', row.outcome === 'merged' ? 'Merged' : 'Closed unmerged'],
      ['By', row.closedBy.text],
      ['When', formatCached(row.closedAt, nowMs)],
      ...held === null ? [] : lastFacts(held, nowMs),
    ],
    last: { state: last.state, message: last.state === 'error' ? last.message : null },
    lastNote: last.state === 'ready' && last.value === null ? 'The cache no longer holds this PR\'s last review, CI, and merge readings.' : null,
    empty: noRuns && reports.state === 'ready' && reports.items.length === 0 ? 'This PR has no reports on disk and no run history.' : null,
    noRuns: noRuns ? 'No run history for this PR.' : null,
  }
}

export type DrawerInput = {
  row: OpenRow
  // false once the PR has left the open tables; the last row stays shown
  open: boolean
  runs: Loadable<RunView>
  reports: Loadable<ReportListing>
  confirm: Confirm | null
  // the people the config lists, for a review request's choice; read when that is asked
  people?: readonly PersonChoice[]
  // the run the log asked for when its card cannot be shown; the card is then none, so no other run's card stands for it
  asked?: AskedRun | null
  // set for the read-only form on a Closed row
  closed?: ClosedInput | null
}

export type DrawerModel = {
  asked: AskedRun | null
  // the read-only form; every action below is then absent
  closed: ClosedModel | null
  header: HeaderModel
  gone: string | null
  starts: StartsModel
  confirm: StartConfirmModel | null
  // direct actions: what the row offers (none for Others' rows and PRs that left the open tables), and the confirmation being asked
  actions: ActionOffer[]
  actionAsk: ActionConfirmModel | null
  card: CardKind
  queued: QueuedModel | null
  running: RunningModel | null
  stop: StopModel | null
  // the latest-run card's Re-read result, and its confirmation while asked
  reread: RereadOffer | null
  rereadAsk: RereadAskModel | null
  // the latest-run card's Post it, and its confirmation while asked
  postIt: PostOfferModel | null
  postAsk: PostAskModel | null
  // the post button's confirmation for a stored report, while asked
  storedAsk: StoredAskModel | null
  // false for a PR that left the open tables until its latest run has been read again: a
  // running card there may be stale, and Stop must not be offered on a guess
  stopsEnabled: boolean
  waiting: WaitingModel | null
  result: ResultModel | null
  runs: { state: Loadable<RunView>['state'], message: string | null, rows: RunRow[] }
  // the PR's auto-review runs, once the runs are read; empty with none
  autoRuns: AutoRunRow[]
  reports: { state: Loadable<ReportListing>['state'], message: string | null, rows: ReportRow[] }
}

export const drawerModel = (input: DrawerInput): DrawerModel => {
  const { row, confirm } = input
  const cell = row.agent
  const asked = input.asked ?? null
  const closed = input.closed ?? null
  const kind = cell === null || asked !== null ? 'none' : cardKind(cell)
  // the read-only form has no Stop, so a run still going there is a line of its history
  const card = closed !== null && (kind === 'queued' || kind === 'running') ? 'none' : kind
  const act = closed === null
  const startAsk = confirm?.type === 'start' && cell !== null ? startConfirmModel(row, cell, confirm.kind, confirm.runner, confirm.checkComments, confirm.extraText, confirm.extraOn, confirm.fixPrompt) : null
  const runs = input.runs
  const reports = input.reports
  return {
    asked,
    closed: closed === null ? null : closedModel(closed, input.runs, input.reports),
    header: headerModel(row),
    gone: input.open || !act ? null : goneText(row.number),
    starts: cell === null || !act ? { buttons: [], shared: null } : startsModel(cell, input.open, row.number),
    confirm: startAsk,
    actions: actionOffers(row, input.open),
    actionAsk: confirm?.type === 'action' ? actionConfirmModel(row, confirm, input.people ?? []) : null,
    card,
    queued: cell !== null && card === 'queued' ? queuedModel(cell) : null,
    running: cell !== null && card === 'running' ? runningModel(row, cell) : null,
    stop: cell === null ? null : card === 'running' ? stopModel(row.number, cell, confirm?.type === 'stop' && confirm.andOpen) : card === 'queued' ? queuedStopModel(row.number, cell) : null,
    reread: act && cell !== null && (card === 'result' || card === 'waiting') ? rereadOffer(cell, input.open, row.number) : null,
    rereadAsk: act && cell !== null && confirm?.type === 'reread' && (card === 'result' || card === 'waiting') && rereadOffer(cell, input.open, row.number)?.disabled === false ? rereadAskModel(row, cell, confirm) : null,
    postIt: act && cell !== null && card === 'result' ? postItOffer(cell, input.open, row.number) : null,
    postAsk: act && cell !== null && card === 'result' && confirm?.type === 'post' && input.open && cell.postOffer !== null ? postAskModel(row, cell.postOffer) : null,
    storedAsk: act && cell !== null && confirm?.type === 'storedPost' ? storedAskModel(row, cell, confirm, input.open) : null,
    stopsEnabled: act && (input.open || input.runs.state === 'ready'),
    waiting: cell !== null && card === 'waiting' ? waitingModel(cell, row.number) : null,
    result: cell !== null && card === 'result' ? resultModel(cell, row.number, row.headOid, actionOffers(row, input.open), row.baseRef) : null,
    runs: {
      state: runs.state,
      message: runs.state === 'error' ? runs.message : null,
      rows: runs.state === 'ready' ? runRows(runs.items, card === 'none' && !act ? null : cell?.runId ?? null) : [],
    },
    autoRuns: runs.state === 'ready' ? autoRunRows(runs.items, act ? storedButtonsModel(cell, input.open, row.number) : null) : [],
    reports: {
      state: reports.state,
      message: reports.state === 'error' ? reports.message : null,
      rows: reports.state === 'ready' ? reportRows(reports.items) : [],
    },
  }
}

// a PR that left the open tables sends no more row patches, so its run is read from the runs list:
// the card follows the newest run's own fields. The cell's words are rebuilt from it with the same
// outcome text the previous-runs list uses
// the cell's summary of a run's result, a client copy of the server's: a review's verdict and
// post, a fix's counts and push (each pushed commit's SHA short, as the server sends it)
const countBy = <K extends string>(keys: readonly K[], values: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((key) => [key, values.filter((value) => value === key).length])) as Record<K, number>

export const summaryOf = (result: RunView['result']): AgentResult | null => {
  if (result?.schema === 'pit-crew/fix-result@1') {
    return {
      kind: 'fix',
      requests: result.requests.length,
      triage: countBy(['needsJudgment', 'noChange', 'disagree', 'outOfScope', 'clear'], result.requests.map((request) => request.triage)),
      outcomes: countBy(['fixed', 'notFixed', 'awaitingAnswer'], result.requests.map((request) => request.outcome)),
      pushed: result.pushed === null ? null : {
        branch: result.pushed.branch,
        head: result.pushed.head,
        count: result.pushed.commits.length,
        commits: result.pushed.commits.map((commit) => ({ sha: commit.sha.slice(0, 7), subject: commit.subject })),
      },
      notPushedReason: result.notPushedReason,
      checks: result.checks,
      worktree: result.worktree,
      report: result.report,
    }
  }
  if (result?.schema === 'pit-crew/update-result@1') {
    return {
      kind: 'update',
      base: result.target?.base ?? null,
      upstream: result.upstream === null ? null : result.upstream.sha.slice(0, 7),
      method: result.method,
      methodReason: result.methodReason,
      conflicts: result.conflicts,
      checks: result.checks,
      pushed: result.pushed,
      notPushedReason: result.notPushedReason,
      worktree: result.worktree,
    }
  }
  if (result?.schema === 'pit-crew/relevancy-result@1') {
    return {
      kind: 'relevancy',
      verdict: result.verdict,
      reason: result.reason,
      needsUpdates: result.needsUpdates,
      fixPrompt: result.fixPrompt === null ? null : result.fixPrompt.replace(/\r\n?|[\u2028\u2029]/g, '\n').trim(),
      base: result.target?.base ?? null,
      upstream: result.upstream === null ? null : result.upstream.sha.slice(0, 7),
    }
  }
  if (result?.schema !== 'pit-crew/review-result@1') return null
  return {
    kind: 'review', verdict: result.verdict, recommendation: result.recommendation, findings: result.findings.length, ci: result.ci,
    posted: result.posted, notPostedReason: result.notPostedReason, report: result.report,
  }
}

// the commit a run's record names as the one it read, a client copy of the server's
const recordedCommit = (result: RunView['result']): string | null => {
  if (result?.schema === 'pit-crew/review-result@1') return result.reviewed?.sha ?? null
  if (result?.schema === 'pit-crew/fix-result@1' || result?.schema === 'pit-crew/update-result@1' || result?.schema === 'pit-crew/relevancy-result@1') return result.head?.sha ?? null
  return null
}

export const cellFromRun = (cell: AgentCell, run: RunView): AgentCell => {
  return {
    ...cell,
    state: run.status === 'running' || run.status === 'queued' ? run.status : 'done',
    label: run.label,
    runId: run.id,
    runner: run.runner,
    command: run.command,
    args: run.args,
    status: run.status,
    startedAt: run.startedAt,
    lastStepAt: run.lastStepAt,
    step: run.step === null ? null : { name: run.step, state: run.stepState ?? 'started' },
    steps: run.steps,
    tandem: run.tandem,
    commit: recordedCommit(run.result),
    finishedAt: run.finishedAt,
    text: run.status === 'running' || run.status === 'queued' ? null : runText(run).text,
    result: summaryOf(run.result),
    question: run.status === 'needsInput' ? run.result?.question ?? null : null,
    note: run.note,
    resolvedByHand: run.resolvedByHand,
    firstNote: run.firstNote,
    resume: run.resume,
    costUsd: run.costUsd,
    extraInstructions: run.extraInstructions,
    recorded: run.models,
    // the server's offer is about one run, and a newer run on the list is not it
    postOffer: cell.runId === run.id ? cell.postOffer : null,
    storedOffer: cell.runId === run.id ? cell.storedOffer : null,
  }
}

// what stands in place of the card when the log asked for one run and its card cannot be shown: the runs are still loading, they could not be loaded, or the run is no longer among them (finished runs are pruned apart from the log, so an old link can outlive its run). Never another run's card shown as this one's
export type AskedRun = { runId: number, state: 'loading' | 'error' | 'missing', text: string }

export const askedRun = (cell: AgentCell | null, runs: Loadable<RunView>, runId: number | null, number: number): AskedRun | null => {
  if (runId === null || cell?.runId === runId) return null
  if (runs.state === 'loading') return { runId, state: 'loading', text: `Loading run ${runId}…` }
  if (runs.state === 'error') return { runId, state: 'error', text: `Run ${runId} cannot be shown: the runs of #${number} could not be loaded.` }
  return runs.items.some((candidate) => candidate.id === runId) ? null : { runId, state: 'missing', text: `Run ${runId} is no longer listed for #${number}.` }
}

// the cell to show when the log asked for one run: that run's own card, built from the runs read for the PR, unless it is the run the cell already shows (the row's own cell knows more of it). While the runs load, when they could not be read, and when the run is no longer on the list there is no card of that run, and askedRun says so; the cell returned then is not shown as the run's
export const cellOfRun = (cell: AgentCell | null, runs: Loadable<RunView>, runId: number | null): AgentCell | null => {
  if (cell === null || runId === null || cell.runId === runId || runs.state !== 'ready') return cell
  const run = runs.items.find((candidate) => candidate.id === runId)
  return run === undefined ? cell : cellFromRun(cell, run)
}

// the newest run is the first of the list; a row's own run wins when it is newer
export const latestCell = (cell: AgentCell | null, runs: Loadable<RunView>): AgentCell | null => {
  if (cell === null || runs.state !== 'ready') return cell
  const newest = runs.items[0]
  if (newest === undefined || (cell.runId !== null && newest.id < cell.runId)) return cell
  return cellFromRun(cell, newest)
}

// a confirmation outlives nothing: a stop is about one run that must still be running, a start
// about a start the PR still offers and can run now; otherwise it is dropped
export const confirmHolds = (confirm: Confirm, cell: AgentCell | null, open: boolean): boolean => {
  // an action's confirmation is about the row, not the run: actionHolds judges it
  if (confirm.type === 'action') return true
  if (cell === null) return false
  // a queued run's removal still holds once it has started: the stop is for the same run
  if (confirm.type === 'stop') return (cell.state === 'running' || cell.state === 'queued') && cell.runId === confirm.runId
  // a re-read is about one finished run that still has the status it was asked for, on a PR still open; the head and base it is bound to are judged by rereadBound
  if (confirm.type === 'reread') return open && rereadOffer(cell, open, 0)?.runId === confirm.runId
  // a post is about what the confirmation showed: any change in the server's offer drops it
  if (confirm.type === 'post') {
    const offer = cell.postOffer
    return open && offer !== null && offer.runId === confirm.runId && offer.form === confirm.form && offer.headSha === confirm.headSha && offer.repo === confirm.repo && offer.viewer === confirm.viewer
  }
  // a stored post is about what the confirmation showed: any change in the server's offer drops it, the CI state included
  if (confirm.type === 'storedPost') {
    const offer = cell.storedOffer
    return open && offer != null && offer.runId === confirm.runId && offer.forms.includes(confirm.form) && offer.headSha === confirm.headSha && offer.reviewedSha === confirm.reviewedSha && offer.repo === confirm.repo && offer.viewer === confirm.viewer && offer.ci === confirm.ci
  }
  if (!open) return false
  const option = optionOf(cell, confirm.kind)
  if (option === undefined || option.unavailable !== null) return false
  // a Fix session asked for with the relevancy check's prompt is about that prompt: a newer run, a push, or another text drops it
  if (confirm.fixPrompt === undefined) return true
  const now = cellPrompt(cell)
  return confirm.kind === 'fix' && now !== null && now.runId === confirm.fixPrompt.runId && now.text === confirm.fixPrompt.text
}

// a re-read's confirmation is dropped when what it showed no longer holds: the head or base of the PR, the repository the page shows, or the viewer
export const rereadBound = (ask: Extract<Confirm, { type: 'reread' }>, row: Pick<OpenRow, 'headSha' | 'baseRef' | 'agent'>, repo: string): boolean =>
  ask.repo === repo && ask.headSha === row.headSha && ask.baseRef === row.baseRef && row.agent?.starts[0]?.viewer === ask.viewer

// when to ask the server again: the runs when the row's run changes in a way the list shows, the
// reports when a run starts or ends. A timer tick or a step's time moving changes neither key
export const refetchKeys = (cell: AgentCell | null): { runs: string, reports: string } => {
  if (cell === null) return { runs: 'none', reports: 'none' }
  return {
    runs: [cell.runId, cell.status, cell.step?.name, cell.step?.state, cell.state].join('|'),
    reports: [cell.runId, cell.status === 'running'].join('|'),
  }
}

// a run's start or end is announced once by the page's live region; this is the drawer's own
// line for a stop that finished while the owner asked to open the session
export const resumeReadyText = (number: number, hasResume: boolean): string =>
  hasResume ? `#${number}: run stopped. The resume command is ready to copy.` : `#${number}: run stopped. It has no session to resume.`

// where focus goes when the drawer closes: the control that opened it, if it is still on the
// page; otherwise the PR's link; otherwise nowhere in particular
export const returnSelector = (opener: Opener | null, number: number, exists: (selector: string) => boolean): string | null => {
  if (opener !== null) {
    const own = focusKeySelector(opener.key)
    if (exists(own)) return own
  }
  const link = `tr[data-pr="${Number(number)}"] [data-focus="pr"]`
  return exists(link) ? link : null
}

// a value inside a quoted attribute selector: the quote and the backslash are the only characters
// that can end it
export const quoteAttr = (value: string): string => value.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\a ')

export const focusKeySelector = (key: string): string => `[data-focus-key="${quoteAttr(key)}"]`

// focus is moved on the page's own account only while it is somewhere the move cannot hurt: inside
// the drawer, on nothing (the body), or already on the drawer's heading. A field the owner is typing
// in elsewhere keeps it
export const mayMoveFocus = (where: { insideDrawer: boolean, onBody: boolean }): boolean => where.insideDrawer || where.onBody

// whether the page's Escape handler acts on a key event: always inside the panels (a radio in the
// confirmation is still the drawer's), never in a text field of the page behind, whose Escape
// clears or reverts it
export const escapeApplies = (target: { tag: string, editable: boolean, inPanel: boolean }): boolean => {
  if (target.inPanel) return true
  const tag = target.tag.toLowerCase()
  return !(target.editable || tag === 'input' || tag === 'textarea' || tag === 'select')
}

// what Escape closes, topmost first: the report panel, then a confirmation waiting in the
// drawer (never while its request is on its way), then the drawer itself
export type EscapeState = { report: boolean, confirm: boolean, busy: boolean, drawer: boolean }

export const escapeTarget = (state: EscapeState): 'report' | 'confirm' | 'drawer' | null => {
  if (state.report) return 'report'
  if (state.busy) return null
  if (state.confirm) return 'confirm'
  return state.drawer ? 'drawer' : null
}

// a press outside the drawer closes it, as Escape's last step does. A press inside the drawer or its report panel is the drawer's own, and a press on a control that opens a drawer switches this one to that row instead of closing and reopening it. Nothing closes while a request is on its way, as for Escape, so a Start in progress keeps its confirmation on screen
export type OutsidePressState = { inPanel: boolean, opener: boolean, busy: boolean }

export const outsidePressCloses = (press: OutsidePressState): boolean => !press.inPanel && !press.opener && !press.busy

// the one page-level handler for a press outside a drawer, shared by the PR drawer and the sweep drawer: it asks whichever drawer is open and returns whether one closed. The panel selector names every surface whose press is a drawer's own, so a press in either drawer, a confirmation included, or in the report panel closes nothing
export type PressTarget = { closest: (selector: string) => unknown }
export type OutsideDrawer = { isOpen: () => boolean, outside: (where: { inPanel: boolean, opener: boolean }) => boolean }

// a PR's row in one of the tables, and what inside a row keeps its own click
export const prRowSelector = 'tr[data-pr][data-table]'
export const rowControlSelector = 'a[href], button, input, select, textarea, label, summary, [role="button"], [contenteditable]'

// the PR row a press or click landed on, when it landed on the row itself rather than on a link or control in it: such a click opens that PR's drawer, so such a press closes none
export const plainRowOf = <E = unknown>(target: PressTarget): E | null =>
  target.closest(rowControlSelector) === null ? target.closest(prRowSelector) as E | null : null

export const drawerPanelSelector = '#drawer, #sweep-drawer, #report-panel'

export const closeOnOutsidePress = (drawers: readonly OutsideDrawer[], target: PressTarget | null): boolean => {
  const where = {
    inPanel: target !== null && target.closest(drawerPanelSelector) !== null,
    opener: target !== null && (target.closest(drawerOpenerSelector) !== null || plainRowOf(target) !== null),
  }
  let closed = false
  for (const open of drawers) if (open.isOpen() && open.outside(where)) closed = true
  return closed
}

// the page's controls whose click opens a drawer: another row's Agent cell, the changes-requested banner's Open agent and Fix session buttons, a sweep's broom or status, a notification's button in the panel, and anything in a toast, so dismissing one leaves the drawer open
export const drawerOpenerSelector = 'button[data-agent="open"][data-pr], button[data-open-agent], button[data-fix-session], button[data-sweep], button[data-notice-open], #toasts'
