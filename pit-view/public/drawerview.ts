// public/drawerview.ts
// the Agent drawer's words and shapes, as pure functions of the open row, the runs and reports
// fetched for it, and the drawer's own confirmation state; drawer.ts turns the model into
// elements. Nothing here reads the DOM or the clock: every time is passed in
import type { OpenRow } from '../src/derive.ts'
import type { ReportListing } from '../src/reports.ts'
import { actionConfirmModel, actionOffers } from './actionsview.ts'
import type { ActionConfirm, ActionConfirmModel, ActionOffer, PersonChoice } from './actionsview.ts'
import { commandLine, doneTone, runnerLabels, sentence, stepTitle } from './agent.ts'
import type { AgentCell, AgentResult, DoneTone, PostForm, RunnerName, RunView, StartKind, StartOption, StepSlot } from './agent.ts'
import { shortSha } from './format.ts'
import { safeHref } from './safeurl.ts'

export type Loadable<T> = { state: 'loading' } | { state: 'error', message: string } | { state: 'ready', items: T[] }

// what the drawer is asking about: a start waiting for its Start, a stop waiting for its Stop, or a direct action on the PR waiting for its confirmation
export type Confirm =
  // checkComments is the Self-review's box: it lives here, so it lasts as long as this confirmation and no longer
  | { type: 'start', kind: StartKind, runner: RunnerName, checkComments?: boolean }
  | { type: 'stop', andOpen: boolean, runId: number }
  // a re-read of the latest run's result, with everything its confirmation showed
  | { type: 'reread', runId: number, repo: string, viewer: string, headSha: string, baseRef: string }
  // Post it's confirmation, with everything it showed
  | { type: 'post', runId: number, repo: string, viewer: string, headSha: string, form: PostForm }
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

export const headerModel = (row: OpenRow): HeaderModel => ({
  number: row.number,
  url: row.url,
  heading: `Agent for #${row.number}`,
  author: `${row.author.alias} · @${row.author.login}`,
  title: row.title,
  refs: `${row.headRef} → ${row.baseRef} · head ${shortSha(row.headOid)}`,
})

export const goneText = (number: number): string => `#${number} is no longer open`

// the Start section: one button per offered start, default first. A start that cannot run says
// why in the drawer's own text; when every button gives the same reason it is said once
export type StartButton = { kind: StartKind, text: string, disabled: boolean, reason: string | null }
export type StartsModel = { buttons: StartButton[], shared: string | null }

export const startsModel = (cell: AgentCell, open: boolean, number: number): StartsModel => {
  const closed = open ? null : `Starting is off: ${goneText(number)}.`
  const buttons = cell.starts.map((option): StartButton => {
    const reason = closed ?? (option.unavailable === null ? null : sentence(option.unavailable))
    return { kind: option.kind, text: option.button, disabled: reason !== null, reason }
  })
  const first = buttons[0]?.reason ?? null
  if (first !== null && buttons.every((button) => button.reason === first)) {
    return { buttons: buttons.map((button) => ({ ...button, reason: null })), shared: first }
  }
  return { buttons, shared: null }
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
  // the Self-review's box; null for a start that does not offer it
  commentsCheck: { label: string, detail: string, checked: boolean } | null
  effect: string
  effectKind: StartOption['posts']['kind']
  // a start that pushes to the PR's branch is confirmed with a caution treatment and this plain
  // line about the push; null for a review
  caution: string | null
  confirm: string
  busy: string
}

// null when the PR no longer offers that start. A Fix session pushes commits, so its confirmation
// names the branch in its heading, says plainly what the push does, and has a Start of its own
export const startConfirmModel = (row: Pick<OpenRow, 'number' | 'title' | 'headRef'>, cell: AgentCell, kind: StartKind, runner: RunnerName, checkComments = false): StartConfirmModel | null => {
  const option = optionOf(cell, kind)
  if (option === undefined) return null
  const chosen = option.runners.includes(runner) ? runner : defaultRunner(option, cell.action.runner)
  const push = option.posts.kind === 'push'
  const checked = commentsCheckOn({ checkComments }, option)
  return {
    kind,
    heading: push ? `Push fixes to ${row.headRef}?` : `${option.label} #${row.number}?`,
    title: row.title,
    command: commandLine({ command: option.command, args: checked ? option.checkCommentsArgs ?? option.args : option.args }, chosen),
    runners: option.runners.map((name) => ({ name, label: runnerLabels[name] })),
    runner: chosen,
    runnerLabel: runnerLabels[chosen],
    commentsCheck: option.checkCommentsArgs === undefined ? null : {
      label: 'Also check the latest comments',
      detail: 'Reads the PR\'s latest comments from anyone and reports which points the branch has not addressed. It changes nothing.',
      checked,
    },
    effect: option.posts.text,
    effectKind: option.posts.kind,
    caution: push ? `It pushes new commits to ${row.headRef} on GitHub under your account, and never force-pushes.` : null,
    confirm: push ? 'Start fix session' : 'Start',
    busy: push ? 'Starting fix session…' : 'Starting…',
  }
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
  }
}

// a review waiting for a slot under the cap on concurrent reviews: what waits and why, with no steps or timer, since nothing runs yet
export type QueuedModel = { label: string, tandem: boolean, runnerLabel: string, note: string }

export const queuedModel = (cell: AgentCell): QueuedModel => ({
  label: cell.label,
  tandem: cell.tandem,
  runnerLabel: cell.runner === null ? 'its runner' : runnerLabels[cell.runner],
  note: 'Waiting for a review slot: it starts by itself when an earlier review ends, in the order it was queued.',
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

export type WaitingModel = { question: string, resume: string | null, copyName: string }

export const waitingModel = (cell: AgentCell, number: number): WaitingModel => ({
  question: cell.question ?? 'The run stopped to ask a question but did not record it. Open its session to see it.',
  resume: cell.resume,
  copyName: `Copy resume command for #${number}`,
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

const postedWords: Readonly<Record<string, string>> = { approve: 'an approval', requestChanges: 'a request for changes', comment: 'a comment' }

const notPostedWords: Readonly<Record<string, string>> = {
  noPost: 'nothing: the run was told not to post',
  ownPr: 'nothing: it is your own PR',
  awaitingAnswer: 'nothing yet: it waits for your answer',
  ghFailed: 'unknown: the post failed and may have landed',
  postBlocked: 'nothing: a permission check refused the post',
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
  // set when the PR's head moved past the commit this run reviewed
  stale: string | null
  // set when the owner's re-read replaced this run's recorded outcome, and why it had one
  byHand: string | null
  // set when the run's ask is "Clean · mark ready?" and the drawer offers Mark ready for review: says where the action is, and does nothing itself
  ready: string | null
  // set when the review finished and its post was refused: says so and says that nothing reached GitHub
  notPosted: string | null
  // that run's saved report, for the report panel
  report: { name: string, openName: string } | null
}

// the quiet line that points the "Clean · mark ready?" ask at the Actions section; null unless the done text is that ask and Mark ready for review is offered now, which already means the viewer's own open draft
export const readyPointer = (text: string | null, offers: readonly ActionOffer[]): string | null =>
  text !== null && text.startsWith('Clean · mark ready?') && offers.some((offer) => offer.action === 'markReady')
    ? 'Mark it ready from the Actions section above: Mark ready for review.'
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

export const resultModel = (cell: AgentCell, number: number, headOid: string, offers: readonly ActionOffer[]): ResultModel => ({
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
  stale: cell.state !== 'idle' ? null : cell.command === 'fix-pr' || cell.command === 'update-pr'
    ? 'The head has moved since this run, so it covers an earlier commit.'
    : 'The head has moved since this run, so it covers an earlier commit. Start a new review for the current one.',
  byHand: cell.resolvedByHand && cell.status === 'done' ? byHandText(cell.firstNote ?? cell.note) : null,
  ready: readyPointer(cell.text, offers),
  notPosted: isBlockedPost(cell.result) ? 'Review done, post not made: a permission check refused the post before it ran, so nothing reached GitHub.' : null,
  report: blockedReport(cell.result),
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
export type RunRow = { id: number, label: string, runner: string, text: string, tone: Tone, startedAt: string, cost: string | null }

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
  if (result === null || result.schema !== 'pit-crew/review-result@1' || result.verdict === null) return { text: 'Done', tone: 'gray' }
  if (result.notPostedReason === 'postBlocked' && result.posted === null) return { text: `${result.verdict === 'changesRequested' ? 'Changes requested' : 'Clean'} · post not made`, tone: 'amber' }
  const failedPost = result.notPostedReason === 'ghFailed' ? ' · post failed' : ''
  if (result.verdict === 'changesRequested') return { text: `Changes requested${failedPost}`, tone: 'red' }
  if (result.posted?.form === 'approve') return { text: `Approved${failedPost}`, tone: 'green' }
  if (result.posted?.form === 'comment') return { text: `Clean · CI failed${failedPost}`, tone: 'amber' }
  return { text: `Clean${failedPost}`, tone: failedPost === '' ? 'green' : 'amber' }
}

// every run but the one the card above already shows
export const runRows = (runs: readonly RunView[], shownId: number | null): RunRow[] =>
  runs.filter((run) => run.id !== shownId).map((run) => ({
    id: run.id,
    label: run.label,
    runner: runnerLabels[run.runner],
    ...runText(run),
    startedAt: run.startedAt,
    cost: formatCost(run.costUsd),
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

export type DrawerInput = {
  row: OpenRow
  // false once the PR has left the open tables; the last row stays shown
  open: boolean
  runs: Loadable<RunView>
  reports: Loadable<ReportListing>
  confirm: Confirm | null
  // the people the config lists, for a review request's choice; read when that is asked
  people?: readonly PersonChoice[]
}

export type DrawerModel = {
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
  // false for a PR that left the open tables until its latest run has been read again: a
  // running card there may be stale, and Stop must not be offered on a guess
  stopsEnabled: boolean
  waiting: WaitingModel | null
  result: ResultModel | null
  runs: { state: Loadable<RunView>['state'], message: string | null, rows: RunRow[] }
  reports: { state: Loadable<ReportListing>['state'], message: string | null, rows: ReportRow[] }
}

export const drawerModel = (input: DrawerInput): DrawerModel => {
  const { row, confirm } = input
  const cell = row.agent
  const card = cell === null ? 'none' : cardKind(cell)
  const startAsk = confirm?.type === 'start' && cell !== null ? startConfirmModel(row, cell, confirm.kind, confirm.runner, confirm.checkComments) : null
  const runs = input.runs
  const reports = input.reports
  return {
    header: headerModel(row),
    gone: input.open ? null : goneText(row.number),
    starts: cell === null ? { buttons: [], shared: null } : startsModel(cell, input.open, row.number),
    confirm: startAsk,
    actions: actionOffers(row, input.open),
    actionAsk: confirm?.type === 'action' ? actionConfirmModel(row, confirm, input.people ?? []) : null,
    card,
    queued: cell !== null && card === 'queued' ? queuedModel(cell) : null,
    running: cell !== null && card === 'running' ? runningModel(row, cell) : null,
    stop: cell === null ? null : card === 'running' ? stopModel(row.number, cell, confirm?.type === 'stop' && confirm.andOpen) : card === 'queued' ? queuedStopModel(row.number, cell) : null,
    reread: cell !== null && (card === 'result' || card === 'waiting') ? rereadOffer(cell, input.open, row.number) : null,
    rereadAsk: cell !== null && confirm?.type === 'reread' && (card === 'result' || card === 'waiting') && rereadOffer(cell, input.open, row.number)?.disabled === false ? rereadAskModel(row, cell, confirm) : null,
    postIt: cell !== null && card === 'result' ? postItOffer(cell, input.open, row.number) : null,
    postAsk: cell !== null && card === 'result' && confirm?.type === 'post' && input.open && cell.postOffer !== null ? postAskModel(row, cell.postOffer) : null,
    stopsEnabled: input.open || input.runs.state === 'ready',
    waiting: cell !== null && card === 'waiting' ? waitingModel(cell, row.number) : null,
    result: cell !== null && card === 'result' ? resultModel(cell, row.number, row.headOid, actionOffers(row, input.open)) : null,
    runs: {
      state: runs.state,
      message: runs.state === 'error' ? runs.message : null,
      rows: runs.state === 'ready' ? runRows(runs.items, cell?.runId ?? null) : [],
    },
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
  if (result?.schema !== 'pit-crew/review-result@1') return null
  return {
    kind: 'review', verdict: result.verdict, recommendation: result.recommendation, findings: result.findings.length, ci: result.ci,
    posted: result.posted, notPostedReason: result.notPostedReason, report: result.report,
  }
}

// the commit a run's record names as the one it read, a client copy of the server's
const recordedCommit = (result: RunView['result']): string | null => {
  if (result?.schema === 'pit-crew/review-result@1') return result.reviewed?.sha ?? null
  if (result?.schema === 'pit-crew/fix-result@1' || result?.schema === 'pit-crew/update-result@1') return result.head?.sha ?? null
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
    // the server's offer is about one run, and a newer run on the list is not it
    postOffer: cell.runId === run.id ? cell.postOffer : null,
  }
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
  if (!open) return false
  const option = optionOf(cell, confirm.kind)
  return option !== undefined && option.unavailable === null
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

export const drawerPanelSelector = '#drawer, #sweep-drawer, #report-panel'

export const closeOnOutsidePress = (drawers: readonly OutsideDrawer[], target: PressTarget | null): boolean => {
  const where = {
    inPanel: target !== null && target.closest(drawerPanelSelector) !== null,
    opener: target !== null && target.closest(drawerOpenerSelector) !== null,
  }
  let closed = false
  for (const open of drawers) if (open.isOpen() && open.outside(where)) closed = true
  return closed
}

// the page's controls whose click opens a drawer: another row's Agent cell, the changes-requested banner's Open agent and Fix session buttons, and a sweep's broom or status
export const drawerOpenerSelector = 'button[data-agent="open"][data-pr], button[data-open-agent], button[data-fix-session], button[data-sweep]'
