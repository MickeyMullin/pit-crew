// src/launcher.ts
import { spawn as spawnChild } from 'node:child_process'
import { closeSync, openSync, watch as watchDir } from 'node:fs'
import { mkdir, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { Cache, Run, RunChanges, RunStatus } from './cache.ts'
import { expandHome, tildePath } from './config.ts'
import type { Clock, Config, RunnerName } from './config.ts'
import { isBotLogin, isMine, viewerReview } from './derive.ts'
import type { Stack } from './derive.ts'
import { fetchViewerLogin } from './github.ts'
import type { Gh, RawOpenPr, Runner } from './github.ts'
import type { Timers } from './poller.ts'
import type { ReportInfo } from './reports.ts'
import { iso } from './time.ts'

// starts, watches and stops review sessions (section 8 of DESIGN.md, Launching runs). It needs
// no page: phase 4's scheduler calls start the same way the HTTP endpoint does

// the emit-json contract, as pit-crew's prompts/review/emit-json.md pins it

export type StepName = 'resolveBase' | 'review' | 'consolidate' | 'writeReport' | 'post'
export const stepNames: readonly StepName[] = ['resolveBase', 'review', 'consolidate', 'writeReport', 'post']
export type StepState = 'started' | 'done' | 'skipped'
export const stepStates: readonly StepState[] = ['started', 'done', 'skipped']
export type StepEvent = { at: string, step: StepName, state: StepState, note: string | null }

export type ResultStatus = 'done' | 'failed' | 'needsInput'
export type Priority = 'P0' | 'P1' | 'P2' | 'P3'
export type Finding = { priority: Priority, summary: string, files: string[] }
export type PostForm = 'approve' | 'requestChanges' | 'comment'
export type Posted = { form: PostForm, url: string }
export type NotPostedReason = 'noPost' | 'ownPr' | 'awaitingAnswer' | 'ghFailed'
export type Verdict = 'changesRequested' | 'clean'
export type Recommendation = 'approve' | 'fixBeforeMerge' | 'hold' | 'doNotMerge'
export type CiState = 'green' | 'failed' | 'pending' | 'none'

export type ReviewResult = {
  schema: 'pit-crew/review-result@1'
  command: 'review-pr' | 'review-stack' | 'review-dependabot'
  status: ResultStatus
  target: { repo: string, pr: number | null } | { repo: string, stack: number[], top: number } | null
  reviewed: { kind: 'commit', sha: string } | null
  verdict: Verdict | null
  recommendation: Recommendation | null
  findings: Finding[]
  ci: CiState | null
  fixAttempts: number
  posted: Posted | null
  notPostedReason: NotPostedReason | null
  report: string | null
  question: string | null
  error: string | null
}

export type SweepResult = {
  schema: 'pit-crew/sweep-result@1'
  command: 'review-dependabot-sweep'
  status: ResultStatus
  repo: string
  counts: { swept: number, fresh: number, reused: number, failed: number }
  rows: unknown[]
  mergeOrder: unknown[]
  summary: string | null
  question: string | null
  error: string | null
}

// fix-pr's response, pinned with it as pit-crew/fix-result@1 (section 8 of DESIGN.md)
export type FixTriage = 'needsJudgment' | 'noChange' | 'disagree' | 'outOfScope' | 'clear'
export const fixTriages: readonly FixTriage[] = ['needsJudgment', 'noChange', 'disagree', 'outOfScope', 'clear']
export type FixOutcome = 'fixed' | 'notFixed' | 'awaitingAnswer'
export const fixOutcomes: readonly FixOutcome[] = ['fixed', 'notFixed', 'awaitingAnswer']
export type CheckResult = 'passed' | 'failed' | 'notRun'
export type NotPushedReason = 'nothingToFix' | 'awaitingAnswer' | 'checksFailed' | 'checksNotRun' | 'pushFailed'
export const notPushedReasons: readonly NotPushedReason[] = ['nothingToFix', 'awaitingAnswer', 'checksFailed', 'checksNotRun', 'pushFailed']

export type FixRequest = {
  // the review thread's or the review's node id
  id: string
  kind: 'thread' | 'review'
  author: string | null
  // null for a review
  path: string | null
  // the thread's line, or its original line when outdated; null for a review or a whole file
  line: number | null
  outdated: boolean
  url: string
  summary: string
  triage: FixTriage
  outcome: FixOutcome
  // full SHAs
  commits: string[]
}

export type FixCheck = { name: string, result: CheckResult }
export type FixCommit = { sha: string, subject: string }
export type Pushed = { branch: string, head: string, commits: FixCommit[] }

export type FixResult = {
  schema: 'pit-crew/fix-result@1'
  command: 'fix-pr'
  status: ResultStatus
  target: { repo: string, pr: number, branch: string } | null
  // the PR head the run read and triaged against
  head: { sha: string } | null
  requests: FixRequest[]
  checks: FixCheck[]
  pushed: Pushed | null
  notPushedReason: NotPushedReason | null
  worktree: string | null
  report: string | null
  question: string | null
  error: string | null
}

export type RunResultJson = ReviewResult | SweepResult | FixResult

export type Parsed<T> = { ok: true, value: T } | { ok: false, error: string }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string'

const oneOfOrNull = (value: unknown, allowed: readonly string[]): boolean => value === null || allowed.includes(value as string)

class Invalid extends Error {
  override name = 'Invalid'
}

const check = (ok: boolean, message: string): void => {
  if (!ok) throw new Invalid(message)
}

const fixFields = ['schema', 'command', 'status', 'target', 'head', 'requests', 'checks', 'pushed', 'notPushedReason', 'worktree', 'report', 'question', 'error']
const reviewFields = ['schema', 'command', 'status', 'target', 'reviewed', 'verdict', 'recommendation', 'findings', 'ci', 'fixAttempts', 'posted', 'notPostedReason', 'report', 'question', 'error']
const sweepFields = ['schema', 'command', 'status', 'repo', 'counts', 'rows', 'mergeOrder', 'summary', 'question', 'error']

// the status rules both schemas share: failed carries its error, needsInput its question
const checkStatus = (value: Record<string, unknown>): void => {
  check(['done', 'failed', 'needsInput'].includes(value.status as string), 'status must be done, failed or needsInput')
  check(isStringOrNull(value.question) && isStringOrNull(value.error), 'question and error must be strings or null')
  if (value.status === 'needsInput') check(typeof value.question === 'string' && value.question !== '', 'a needsInput result must carry its question')
  if (value.status === 'failed') check(typeof value.error === 'string' && value.error !== '', 'a failed result must carry its error')
}

// result.json is written by an agent that read other people's PR text, and the page links to
// posted.url, so the URL must be an absolute http or https one, with nothing a browser would
// strip or decode into another scheme: no whitespace or control characters, no relative form
export const isHttpUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value === '' || value !== value.trim() || /[\u0000-\u0020\u007f-\u009f]/.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

const checkPosted = (posted: unknown): void => {
  if (posted === null) return
  check(isObject(posted) && ['approve', 'requestChanges', 'comment'].includes(posted.form as string) && isHttpUrl(posted.url), 'posted must be null or { form, url } with an http or https url')
}

const checkReview = (value: Record<string, unknown>): void => {
  for (const field of reviewFields) check(field in value, `${field} is missing`)
  check(['review-pr', 'review-stack', 'review-dependabot'].includes(value.command as string), 'command must be review-pr, review-stack or review-dependabot')
  checkStatus(value)
  check(value.target === null || isObject(value.target), 'target must be an object or null')
  check(value.reviewed === null || (isObject(value.reviewed) && value.reviewed.kind === 'commit' && typeof value.reviewed.sha === 'string'), 'reviewed must be null or { kind: commit, sha }')
  check(oneOfOrNull(value.verdict, ['changesRequested', 'clean']), 'verdict must be changesRequested, clean or null')
  check(oneOfOrNull(value.recommendation, ['approve', 'fixBeforeMerge', 'hold', 'doNotMerge']), 'recommendation must be one of the four or null')
  check(Array.isArray(value.findings) && value.findings.every((finding) =>
    isObject(finding) && ['P0', 'P1', 'P2', 'P3'].includes(finding.priority as string) && typeof finding.summary === 'string' && Array.isArray(finding.files)), 'findings must be a list of { priority, summary, files }')
  check(oneOfOrNull(value.ci, ['green', 'failed', 'pending', 'none']), 'ci must be green, failed, pending, none or null')
  check(Number.isInteger(value.fixAttempts) && (value.fixAttempts as number) >= 0, 'fixAttempts must be a whole number')
  checkPosted(value.posted)
  check(oneOfOrNull(value.notPostedReason, ['noPost', 'ownPr', 'awaitingAnswer', 'ghFailed']), 'notPostedReason must be one of the four or null')
  check(isStringOrNull(value.report), 'report must be a path or null')
}

const checkSweep = (value: Record<string, unknown>): void => {
  for (const field of sweepFields) check(field in value, `${field} is missing`)
  check(value.command === 'review-dependabot-sweep', 'command must be review-dependabot-sweep')
  checkStatus(value)
  check(typeof value.repo === 'string', 'repo must be a string')
  const counts = value.counts
  check(isObject(counts) && ['swept', 'fresh', 'reused', 'failed'].every((key) => Number.isInteger(counts[key])), 'counts must hold swept, fresh, reused and failed')
  check(Array.isArray(value.rows) && Array.isArray(value.mergeOrder), 'rows and mergeOrder must be lists')
  check(isStringOrNull(value.summary), 'summary must be a path or null')
}

// git's full 40-character object name; a short one cannot be compared with a PR's head
export const isFullSha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)

const isPositiveInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0

const checkFixRequest = (request: unknown, index: number): void => {
  const at = `requests[${index}]`
  check(isObject(request), `${at} must be an object`)
  const value = request as Record<string, unknown>
  check(typeof value.id === 'string' && value.id !== '', `${at}.id must be a node id`)
  check(value.kind === 'thread' || value.kind === 'review', `${at}.kind must be thread or review`)
  check(isStringOrNull(value.author), `${at}.author must be a login or null`)
  check(isStringOrNull(value.path), `${at}.path must be a path or null`)
  check(value.line === null || isPositiveInteger(value.line), `${at}.line must be a line number or null`)
  check(typeof value.outdated === 'boolean', `${at}.outdated must be true or false`)
  // the page may link it, so it is held to the same rule as posted.url
  check(isHttpUrl(value.url), `${at}.url must be an absolute http or https url`)
  check(typeof value.summary === 'string', `${at}.summary must be a string`)
  check(fixTriages.includes(value.triage as FixTriage), `${at}.triage must be needsJudgment, noChange, disagree, outOfScope or clear`)
  check(fixOutcomes.includes(value.outcome as FixOutcome), `${at}.outcome must be fixed, notFixed or awaitingAnswer`)
  check(Array.isArray(value.commits) && value.commits.every(isFullSha), `${at}.commits must be a list of full SHAs`)
}

const checkPushed = (pushed: unknown): void => {
  if (pushed === null) return
  check(isObject(pushed) && typeof pushed.branch === 'string' && pushed.branch !== '' && isFullSha(pushed.head) && Array.isArray(pushed.commits) && pushed.commits.length > 0 &&
    pushed.commits.every((commit) => isObject(commit) && isFullSha(commit.sha) && typeof commit.subject === 'string'),
  'pushed must be null or { branch, head, commits: [{ sha, subject }] } with full SHAs and at least one commit')
}

const checkFix = (value: Record<string, unknown>): void => {
  for (const field of fixFields) check(field in value, `${field} is missing`)
  check(value.command === 'fix-pr', 'command must be fix-pr')
  checkStatus(value)
  const target = value.target
  check(target === null || (isObject(target) && typeof target.repo === 'string' && isPositiveInteger(target.pr) && typeof target.branch === 'string' && target.branch !== ''),
    'target must be null or { repo, pr, branch }')
  const head = value.head
  check(head === null || (isObject(head) && isFullSha(head.sha)), 'head must be null or { sha } with a full 40-character SHA')
  check(Array.isArray(value.requests), 'requests must be a list')
  ;(value.requests as unknown[]).forEach(checkFixRequest)
  check(Array.isArray(value.checks) && value.checks.every((entry) =>
    isObject(entry) && typeof entry.name === 'string' && ['passed', 'failed', 'notRun'].includes(entry.result as string)), 'checks must be a list of { name, result: passed, failed or notRun }')
  checkPushed(value.pushed)
  check(oneOfOrNull(value.notPushedReason, notPushedReasons), 'notPushedReason must be nothingToFix, awaitingAnswer, checksFailed, checksNotRun, pushFailed or null')
  check(value.pushed === null || value.notPushedReason === null, 'notPushedReason must be null when pushed')
  check(isStringOrNull(value.worktree), 'worktree must be a path or null')
  check(isStringOrNull(value.report), 'report must be a path or null')
}

// the file name a fix's report must have: FIX-<the PR's number>.md
const fixReportFile = (result: FixResult): string | null => result.target === null ? null : `FIX-${result.target.pr}.md`

const baseName = (path: string): string => path.split('/').at(-1) ?? ''

// a well-formed fix result whose fields contradict each other: the run fails, keeping the result
// for the drawer. Null when they agree
export const fixMismatch = (result: FixResult): string | null => {
  const file = fixReportFile(result)
  if (result.report !== null && (file === null || baseName(result.report) !== file)) {
    return `report ${result.report} is not ${file ?? 'FIX-<n>.md'} for the run's target`
  }
  if (result.pushed !== null && result.pushed.branch !== result.target?.branch) {
    return `pushed.branch ${result.pushed.branch} is not the target branch ${result.target?.branch ?? '(none)'}`
  }
  // a done fix says what it pushed or why it did not (its report is checked as every run's is)
  if (result.status === 'done' && result.pushed === null && result.notPushedReason === null) {
    return 'a done fix result carries neither pushed nor notPushedReason'
  }
  return null
}

// result.json checked against its schema; anything else is no result at all
export const parseResult = (text: string): Parsed<RunResultJson> => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, error: 'result.json is not valid JSON' }
  }
  try {
    check(isObject(value), 'result.json must hold one JSON object')
    const result = value as Record<string, unknown>
    if (result.schema === 'pit-crew/review-result@1') {
      checkReview(result)
    } else if (result.schema === 'pit-crew/sweep-result@1') {
      checkSweep(result)
    } else if (result.schema === 'pit-crew/fix-result@1') {
      checkFix(result)
    } else {
      throw new Invalid(`unknown schema ${String(result.schema)}`)
    }
    return { ok: true, value: result as RunResultJson }
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, error: `result.json: ${error.message}` }
    throw error
  }
}

// one events.jsonl line, or null when it is not one
export const parseStepEvent = (line: string): StepEvent | null => {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObject(value) || typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) return null
  if (!stepNames.includes(value.step as StepName) || !stepStates.includes(value.state as StepState)) return null
  return { at: value.at, step: value.step as StepName, state: value.state as StepState, note: typeof value.note === 'string' ? value.note : null }
}

// the five fixed step slots of a run, in order; the latest event per step wins, so a step the
// command records again replaces its earlier line
export type StepSlotState = 'pending' | StepState
export type StepSlot = { step: StepName, state: StepSlotState, at: string | null, note: string | null }

export const emptySteps = (): StepSlot[] => stepNames.map((step) => ({ step, state: 'pending', at: null, note: null }))

export const foldSteps = (steps: readonly StepSlot[], events: readonly StepEvent[]): StepSlot[] => {
  const next = steps.map((slot) => ({ ...slot }))
  for (const event of events) {
    const slot = next.find((candidate) => candidate.step === event.step)
    if (slot !== undefined) Object.assign(slot, { state: event.state, at: event.at, note: event.note })
  }
  return next
}

// a run never recorded as having stepped reads as five pending slots, never as an error
export const stepsOf = (run: Pick<Run, 'steps'>): StepSlot[] => run.steps ?? emptySteps()

// the report a done result names: the review's or the fix's report, or the sweep's summary
export const reportPath = (result: RunResultJson): string | null =>
  result.schema === 'pit-crew/sweep-result@1' ? result.summary : result.report

// command lines, one table entry per runner

export type LaunchSpec = {
  command: string
  args: readonly string[]
  // absolute paths
  cwd: string
  runDir: string
  home: string
  // Claude's, chosen by Pit View before the start
  sessionId: string | null
  codexModel?: string
  // Codex only: ~/agents/output and ~/agents/worktrees resolved through their symlinks
  reportsDir: string
  worktreesDir: string
}

// what to run, and the one stdin line to write (null when stdin is closed from the start)
export type Invocation = { command: string, args: string[], stdin: string | null }

// a skill or slash command invocation with the run directory appended, as the prompts expect it
export const requestText = (prefix: '/' | '$', command: string, args: readonly string[], runDir: string): string =>
  `${prefix}${[command, ...args].join(' ')} --emit-json=${runDir}`

// Codex's file patches are refused through the reports symlink, so the request names the real folder
export const codexNote = (reportsDir: string): string =>
  `Note: ~/agents/output resolves to ${reportsDir}. Write report files at that resolved path; file patches through the symlink are refused.`

export const claudeInvocation = (spec: LaunchSpec): Invocation => ({
  command: 'claude',
  args: [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--session-id', spec.sessionId ?? '', '--permission-mode', 'auto', '--add-dir', join(spec.home, 'agents'),
  ],
  // one user message; stdin then stays open until the result arrives with nothing in the background
  stdin: `${JSON.stringify({ type: 'user', message: { role: 'user', content: requestText('/', spec.command, spec.args, spec.runDir) } })}\n`,
})

// the model and sandbox flags a Codex run starts with, which a resumed session needs again
export const codexModelArgs = (spec: Pick<LaunchSpec, 'codexModel'>): string[] =>
  spec.codexModel === undefined ? [] : ['-m', spec.codexModel]

export const codexSandboxArgs = (spec: Pick<LaunchSpec, 'cwd' | 'reportsDir' | 'worktreesDir'>): string[] => [
  '-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true',
  '--add-dir', join(spec.cwd, '.git'), '--add-dir', spec.reportsDir, '--add-dir', spec.worktreesDir,
]

export const codexInvocation = (spec: LaunchSpec): Invocation => ({
  command: 'codex',
  args: [
    'exec', '--json', ...codexModelArgs(spec), '-C', spec.cwd, ...codexSandboxArgs(spec),
    // the note goes after a blank line, so the skill never reads it as part of its target
    `${requestText('$', spec.command, spec.args, spec.runDir)}\n\n${codexNote(spec.reportsDir)}`,
  ],
  stdin: null,
})

// a word the shell reads back as itself: bare when safe, single-quoted otherwise
export const shellWord = (word: string): string =>
  /^[A-Za-z0-9_.,:/=@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`

// a path for a copied command: ~ stays bare so the shell expands it
export const shellPath = (path: string): string => {
  if (path === '~') return '~'
  if (path.startsWith('~/')) return `~/${shellWord(path.slice(2))}`
  return shellWord(path)
}

export type RunnerEntry = {
  invocation: (spec: LaunchSpec) => Invocation
  // the command that resumes the session from its working directory (written with ~)
  resume: (cwd: string, sessionId: string, spec: LaunchSpec, home: string) => string
}

export const runners: Readonly<Record<RunnerName, RunnerEntry>> = {
  claude: {
    invocation: claudeInvocation,
    resume: (cwd, sessionId) => `cd ${shellPath(cwd)} && claude --resume ${shellWord(sessionId)}`,
  },
  codex: {
    invocation: codexInvocation,
    // a resumed Codex session keeps neither its model nor its sandbox, so both come along
    resume: (cwd, sessionId, spec, home) =>
      `cd ${shellPath(cwd)} && codex resume ${shellWord(sessionId)} ${[...codexModelArgs(spec), ...codexSandboxArgs(spec)].map((arg) => arg.startsWith('/') ? shellPath(tildePath(arg, home)) : shellWord(arg)).join(' ')}`,
  },
}

// the child's environment, built from scratch: a server started inside an agent session must
// not pass on that session's variables
export const childEnvKeys = ['USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'PATH'] as const

export const childEnv = (source: Readonly<Record<string, string | undefined>>, home: string): Record<string, string> => {
  const env: Record<string, string> = { HOME: home }
  for (const key of childEnvKeys) {
    const value = source[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  return env
}

// the run a row starts: never review-local, and --no-post on every review of the viewer's own PR

export type RunKind = 'review' | 'reReview' | 'selfReview'
export type DefaultRun = { kind: RunKind, label: string, command: 'review-pr' | 'review-dependabot', args: string[] }

// review-dependabot refuses a branch that is not Dependabot's, so other bots get review-pr
export const isDependabot = (pr: RawOpenPr): boolean => (pr.author?.login ?? '').toLowerCase().includes('dependabot')

export const defaultRun = (pr: RawOpenPr, config: Config): DefaultRun => {
  const number = String(pr.number)
  // unanswered changes requested still offers Self-review here: Fix session is never the default
  if (isMine(pr, config)) return { kind: 'selfReview', label: 'Self-review', command: 'review-pr', args: [number, '--no-post'] }
  const again = viewerReview(pr, config) !== undefined
  return {
    kind: again ? 'reReview' : 'review',
    label: again ? 'Re-review' : 'Review',
    command: isDependabot(pr) ? 'review-dependabot' : 'review-pr',
    args: [number],
  }
}

// the starts the drawer offers (section 8 of DESIGN.md, Drawer): the row's default run, the same
// review in tandem (Claude only), a review of the whole stack, and on the viewer's own PRs a fix
// session (Claude only), which acts on the changes reviewers requested and pushes its fixes

export type StartKind = 'default' | 'tandem' | 'stack' | 'fix'
export const startKinds: readonly StartKind[] = ['default', 'tandem', 'stack', 'fix']

// what a start does on GitHub, for the confirmation: the kind says how to style it, the text is
// ready to show
export type PostsKind = 'review' | 'nothing' | 'autoApprove' | 'offer' | 'push'
export type StartPosts = { kind: PostsKind, text: string }

export type StartOption = {
  kind: StartKind
  // the run's own label, as the Agent cell shows it while it runs: Re-review, Tandem review, Review stack
  label: string
  // the drawer's Start button
  button: string
  command: string
  // without --emit-json, which the launcher adds
  args: string[]
  // the runners this start works with; tandem and fix are Claude only
  runners: RunnerName[]
  posts: StartPosts
  // why it cannot start right now, from what the server knows without asking GitHub; null otherwise
  unavailable: string | null
}

export const isTandemRun = (args: readonly string[]): boolean => args.includes('--tandem')

// fix-pr pushes to the PR's branch, so it is offered only on the viewer's own PRs, never a bot's
export const offersFix = (pr: RawOpenPr, config: Config): boolean =>
  isMine(pr, config) && pr.author?.__typename !== 'Bot' && !isBotLogin(pr.author?.login, config)

// the commands that only Claude can run: a tandem primary, and the fix session
export const claudeOnly = (command: string, args: readonly string[]): boolean => isTandemRun(args) || command === 'fix-pr'

// null when the kind is offered for this PR, otherwise why it is not
export const notOffered = (kind: StartKind, pr: RawOpenPr, config: Config, stack: Stack | null): string | null => {
  if (kind === 'tandem' && defaultRun(pr, config).command !== 'review-pr') return `Review in tandem is not offered for #${pr.number}: review-dependabot has no tandem mode`
  if (kind === 'stack' && stack === null) return `Review stack is not offered for #${pr.number}: it is not part of a stack`
  if (kind === 'fix' && !offersFix(pr, config)) return `Fix session is offered only on your own PRs, and #${pr.number} is not yours`
  return null
}

const postsFor = (command: string, args: readonly string[], viewer: string): StartPosts => {
  if (command === 'review-stack') {
    return { kind: 'offer', text: 'Posts nothing; writes the report only. It stops to offer posting it on the top PR, and you answer in the session.' }
  }
  if (command === 'review-dependabot') {
    return { kind: 'autoApprove', text: `Posts its report to the PR as @${viewer} and may approve the PR automatically.` }
  }
  if (args.includes('--no-post')) return { kind: 'nothing', text: 'Posts nothing; writes the report only.' }
  return { kind: 'review', text: `Posts its report to the PR as @${viewer}: an approval, a request for changes, or a comment, per the findings.` }
}

const buttons: Readonly<Record<RunKind, string>> = { review: 'Review PR', reReview: 'Re-review PR', selfReview: 'Self-review' }

// the starts a PR offers now; busy is whether a run for it is in flight
export const startOptions = (pr: RawOpenPr, config: Config, stack: Stack | null, busy: boolean): StartOption[] => {
  const plan = defaultRun(pr, config)
  const viewer = config.viewer
  const unavailable = busy
    ? `a run for #${pr.number} is already in flight`
    : config.cloneDir === undefined ? `set cloneDir in the config to your local clone of ${config.repo} before starting a run` : null
  const options: StartOption[] = [{
    kind: 'default', label: plan.label, button: buttons[plan.kind], command: plan.command, args: plan.args,
    runners: ['claude', 'codex'], posts: postsFor(plan.command, plan.args, viewer), unavailable,
  }]
  if (notOffered('tandem', pr, config, stack) === null) {
    // --tandem goes before --no-post; the review-pr prompt reads either flag wherever it stands
    const args = [String(pr.number), '--tandem', ...plan.args.slice(1)]
    const label = plan.kind === 'selfReview' ? 'Tandem self-review' : plan.kind === 'reReview' ? 'Tandem re-review' : 'Tandem review'
    options.push({
      kind: 'tandem', label, button: `${buttons[plan.kind].replace(/ PR$/, '')} in tandem`, command: 'review-pr', args,
      runners: ['claude'], posts: postsFor('review-pr', args, viewer), unavailable,
    })
  }
  if (notOffered('stack', pr, config, stack) === null) {
    options.push({
      kind: 'stack', label: 'Review stack', button: 'Review stack', command: 'review-stack', args: [String(pr.number)],
      runners: ['claude', 'codex'], posts: postsFor('review-stack', [], viewer), unavailable,
    })
  }
  // never --no-post: the push is what it is for
  if (notOffered('fix', pr, config, stack) === null) {
    options.push({
      kind: 'fix', label: 'Fix session', button: 'Fix requested changes', command: 'fix-pr', args: [String(pr.number)], runners: ['claude'],
      posts: {
        kind: 'push',
        text: `Pushes new commits to ${pr.headRefName} on GitHub. It posts no replies or reviews, and stops to ask when a request needs judgment.`,
      },
      unavailable,
    })
  }
  return options
}

// the Agent cell on a row (section 8 of DESIGN.md)

export type AgentAction = { kind: RunKind, label: string, command: string, args: string[], runner: RunnerName }

// the cell's summary of a review's result.json
export type ReviewSummary = {
  kind: 'review'
  verdict: Verdict | null
  recommendation: Recommendation | null
  findings: number
  ci: CiState | null
  posted: Posted | null
  notPostedReason: NotPostedReason | null
  report: string | null
}

// the cell's summary of a fix's result.json: what the drawer shows without reading the file
export type FixSummary = {
  kind: 'fix'
  // how many requests, then how many of each triage and each outcome (every key present)
  requests: number
  triage: Record<FixTriage, number>
  outcomes: Record<FixOutcome, number>
  // the head as a full SHA; each commit's SHA short, as the report writes it
  pushed: { branch: string, head: string, count: number, commits: FixCommit[] } | null
  notPushedReason: NotPushedReason | null
  checks: FixCheck[]
  worktree: string | null
  report: string | null
}

// null for a sweep, whose rows the bot group's drawer renders (P2.7)
export type AgentResult = ReviewSummary | FixSummary

export type AgentCell = {
  // running while a run is in flight; done while its latest run's outcome still stands; idle
  // with no run, or once the PR's head has moved past the commit the latest run reviewed
  state: 'idle' | 'running' | 'done'
  // the run's label, or the idle action's
  label: string
  // what Start does now: the row's default run with the configured runner
  action: AgentAction
  // what the drawer's Start buttons can start now; the default is the first
  starts: StartOption[]
  // own PRs: the self-review report's time; others': the viewer's latest review
  lastReviewAt: string | null
  // the latest run, null fields when there is none
  runId: number | null
  runner: RunnerName | null
  command: string | null
  args: string[] | null
  status: RunStatus | null
  startedAt: string | null
  lastStepAt: string | null
  step: { name: string, state: string } | null
  // the latest run's five step slots in order; all pending with no run, or one that never stepped
  steps: StepSlot[]
  // whether the latest run was a tandem review
  tandem: boolean
  finishedAt: string | null
  // the done text: Changes requested, Approved, Clean · mark ready?, Failed · no result, and so on
  text: string | null
  result: AgentResult | null
  question: string | null
  // why it failed: a kind such as noResult, optionally followed by ': ' and detail
  note: string | null
  resume: string | null
  costUsd: number | null
}

export type FailureKind = 'noResult' | 'noReport' | 'badResult' | 'permissionDenied' | 'serverRestarted' | 'spawnFailed'

const failureTexts: Readonly<Record<FailureKind, string>> = {
  noResult: 'no result',
  noReport: 'no report',
  badResult: 'bad result',
  permissionDenied: 'permission denied',
  serverRestarted: 'server restarted',
  spawnFailed: 'could not start',
}

export const noteKind = (note: string | null): FailureKind | null => {
  const kind = note?.split(':')[0] ?? ''
  return kind in failureTexts ? kind as FailureKind : null
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

// a finished fix that pushed nothing: nothing to fix, or the owner discarded the commits at a stop
const notPushedTexts: Readonly<Record<NotPushedReason, string>> = {
  nothingToFix: 'Nothing to fix',
  awaitingAnswer: 'Not pushed',
  checksFailed: 'Not pushed · checks failed',
  checksNotRun: 'Not pushed · checks not run',
  pushFailed: 'Not pushed · push refused',
}

const fixText = (result: FixResult): string => {
  if (result.pushed !== null) return `Fixed · pushed ${plural(result.pushed.commits.length, 'commit')}`
  return result.notPushedReason === null ? 'Done' : notPushedTexts[result.notPushedReason]
}

// the cell's text for a finished run, from section 8's mappings: a review's verdict and posted, a
// fix's push
export const doneText = (run: Pick<Run, 'status' | 'result' | 'note'>, ownDraft: boolean): string => {
  if (run.status === 'stopped') return 'Stopped'
  if (run.status === 'needsInput') return 'Needs your answer'
  if (run.status === 'failed') {
    const kind = noteKind(run.note)
    if (kind !== null) return `Failed · ${failureTexts[kind]}`
    return run.result?.schema === 'pit-crew/fix-result@1' && run.result.notPushedReason === 'pushFailed' ? 'Failed · push refused' : 'Failed'
  }
  const result = run.result
  if (result?.schema === 'pit-crew/fix-result@1') return fixText(result)
  if (result === null || result.schema !== 'pit-crew/review-result@1' || result.verdict === null) return 'Done'
  let text = 'Clean'
  if (result.verdict === 'changesRequested') text = 'Changes requested'
  else if (ownDraft) text = 'Clean · mark ready?'
  else if (result.posted?.form === 'approve') text = 'Approved'
  else if (result.posted?.form === 'comment') text = 'Clean · CI failed'
  return result.notPostedReason === 'ghFailed' ? `${text} · post failed` : text
}

const countBy = <K extends string>(keys: readonly K[], values: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((key) => [key, values.filter((value) => value === key).length])) as Record<K, number>

const fixSummary = (result: FixResult): FixSummary => ({
  kind: 'fix',
  requests: result.requests.length,
  triage: countBy(fixTriages, result.requests.map((request) => request.triage)),
  outcomes: countBy(fixOutcomes, result.requests.map((request) => request.outcome)),
  pushed: result.pushed === null ? null : {
    branch: result.pushed.branch,
    head: result.pushed.head,
    count: result.pushed.commits.length,
    commits: result.pushed.commits.map((commit) => ({ sha: commit.sha.slice(0, 7), subject: commit.subject })),
  },
  notPushedReason: result.notPushedReason,
  checks: result.checks,
  worktree: result.worktree,
  // only FIX-<n>.md, so the drawer never opens another report from a fix run
  report: result.report !== null && baseName(result.report) === fixReportFile(result) ? result.report : null,
})

const agentResult = (result: RunResultJson | null): AgentResult | null => {
  if (result?.schema === 'pit-crew/fix-result@1') return fixSummary(result)
  if (result === null || result.schema !== 'pit-crew/review-result@1') return null
  return {
    kind: 'review',
    verdict: result.verdict,
    recommendation: result.recommendation,
    findings: result.findings.length,
    ci: result.ci,
    posted: result.posted,
    notPostedReason: result.notPostedReason,
    report: result.report,
  }
}

// the heads a finished run's outcome is about: the commit a review read; the head a fix pushed,
// and the head it read, since the cached row keeps that one until the PR is next fetched. Empty
// when the run stopped first, so its outcome stands
const standingShas = (run: Run): string[] => {
  const result = run.result
  if (result?.schema === 'pit-crew/review-result@1') return result.reviewed === null ? [] : [result.reviewed.sha]
  if (result?.schema === 'pit-crew/fix-result@1') return [result.pushed?.head, result.head?.sha].filter((sha) => sha !== undefined)
  return []
}

export const agentCell = (pr: RawOpenPr, config: Config, run: Run | undefined, report: ReportInfo | undefined, stack: Stack | null = null): AgentCell => {
  const mine = isMine(pr, config)
  const plan = defaultRun(pr, config)
  const action: AgentAction = { ...plan, runner: config.agent.runner }
  const lastReviewAt = mine ? report?.at ?? null : viewerReview(pr, config)?.submittedAt ?? null
  const idle: AgentCell = {
    state: 'idle', label: plan.label, action, starts: startOptions(pr, config, stack, run?.status === 'running'), lastReviewAt,
    runId: null, runner: null, command: null, args: null, status: null, startedAt: null, lastStepAt: null, step: null,
    steps: emptySteps(), tandem: false,
    finishedAt: null, text: null, result: null, question: null, note: null, resume: null, costUsd: null,
  }
  if (run === undefined) return idle
  const shas = standingShas(run)
  const head = pr.headRefOid.toLowerCase()
  let state: AgentCell['state'] = 'done'
  if (run.status === 'running') state = 'running'
  // a stack review reads the top layer, whose commit is not this PR's head
  else if (run.command !== 'review-stack' && shas.length > 0 && !shas.some((sha) => head.startsWith(sha.toLowerCase()))) state = 'idle'
  return {
    ...idle,
    state,
    label: state === 'idle' ? plan.label : run.label,
    runId: run.id,
    runner: run.runner,
    command: run.command,
    args: run.args,
    status: run.status,
    startedAt: run.startedAt,
    lastStepAt: run.lastStepAt,
    step: run.step === null ? null : { name: run.step, state: run.stepState ?? 'started' },
    steps: stepsOf(run),
    tandem: isTandemRun(run.args),
    finishedAt: run.finishedAt,
    text: run.status === 'running' ? null : doneText(run, mine && pr.isDraft),
    result: agentResult(run.result),
    question: run.status === 'needsInput' ? run.result?.question ?? null : null,
    note: run.note,
    resume: run.resume,
    costUsd: run.costUsd,
  }
}

// a run as the API serves it: the row, with its five step slots always present and whether it was a tandem review
export type RunView = Omit<Run, 'steps'> & { steps: StepSlot[], tandem: boolean }

export const runView = (run: Run): RunView => ({ ...run, steps: stepsOf(run), tandem: isTandemRun(run.args) })

// the runner's stream: read by event type, never by position, and never for progress or results

export type StreamState = {
  // background tasks the latest background_tasks_changed event lists as not finished
  outstanding: number
  // tools named in the latest result event's permission_denials
  denials: string[]
  costUsd: number | null
  sessionId: string | null
  // the newest line, for a noResult note
  lastEvent: string | null
}

export const emptyStream = (): StreamState => ({ outstanding: 0, denials: [], costUsd: null, sessionId: null, lastEvent: null })

const finishedTaskStates = new Set(['completed', 'complete', 'done', 'failed', 'error', 'killed', 'stopped', 'cancelled', 'canceled'])

// the tasks an event lists, wherever its shape keeps them; a bare entry counts as running
export const outstandingTasks = (event: Record<string, unknown>): number => {
  const data = isObject(event.data) ? event.data : {}
  const list = [event.tasks, event.background_tasks, event.backgroundTasks, data.tasks].find(Array.isArray) as unknown[] | undefined
  if (list === undefined) return 0
  return list.filter((task) => !(isObject(task) && finishedTaskStates.has(String(task.status ?? task.state ?? '').toLowerCase()))).length
}

const clip = (text: string, length = 300): string => text.length > length ? `${text.slice(0, length)}…` : text

// one stream line folded into the state; closeStdin is true when a result arrived while nothing
// runs in the background, which is when a Claude run's stdin may close
export const foldStream = (state: StreamState, line: string): { state: StreamState, closeStdin: boolean } => {
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return { state, closeStdin: false }
  }
  if (!isObject(event)) return { state, closeStdin: false }
  const next: StreamState = { ...state, lastEvent: clip(line) }
  const kind = event.type
  if (kind === 'background_tasks_changed' || (kind === 'system' && event.subtype === 'background_tasks_changed')) {
    next.outstanding = outstandingTasks(event)
  }
  if (kind === 'thread.started' && typeof event.thread_id === 'string' && next.sessionId === null) next.sessionId = event.thread_id
  if (kind !== 'result') return { state: next, closeStdin: false }
  if (typeof event.total_cost_usd === 'number') next.costUsd = event.total_cost_usd
  const denials = Array.isArray(event.permission_denials) ? event.permission_denials : []
  next.denials = denials.map((denial) => isObject(denial) ? String(denial.tool_name ?? denial.toolName ?? 'unknown tool') : String(denial))
  return { state: next, closeStdin: next.outstanding === 0 }
}

// settling: result.json alone decides, apart from a stop and a denied permission

export type JudgeInput = {
  stopped: boolean
  // the process was already gone when the server came back, so nobody saw it exit
  restarted: boolean
  exit: Exit | null
  // null when result.json does not exist
  parsed: Parsed<RunResultJson> | null
  // whether the report a done result names exists; null when not checked
  reportExists: boolean | null
  denials: readonly string[]
  lastEvent: string | null
}

export type Judgement = { status: Exclude<RunStatus, 'running'>, note: string | null, result: RunResultJson | null }

const exitText = (exit: Exit | null): string => {
  if (exit === null || (exit.code === null && exit.signal === null)) return 'exit code unknown'
  return exit.signal === null ? `exit code ${exit.code}` : `killed by ${exit.signal}`
}

export const judge = (input: JudgeInput): Judgement => {
  const result = input.parsed?.ok === true ? input.parsed.value : null
  if (input.stopped) return { status: 'stopped', note: null, result }
  if (input.exit?.error != null) return { status: 'failed', note: `spawnFailed: ${input.exit.error}`, result }
  // a denied tool call never passes silently, whatever result.json says
  if (input.denials.length > 0) return { status: 'failed', note: `permissionDenied: ${[...new Set(input.denials)].join(', ')}`, result }
  if (input.parsed === null && input.restarted) return { status: 'failed', note: 'serverRestarted', result: null }
  if (input.parsed === null || !input.parsed.ok) {
    const why = input.parsed === null ? 'no result.json' : input.parsed.error
    return { status: 'failed', note: `noResult: ${why}; ${exitText(input.exit)}; last event: ${input.lastEvent ?? 'none'}`, result: null }
  }
  const value = input.parsed.value
  if (value.schema === 'pit-crew/fix-result@1') {
    const mismatch = fixMismatch(value)
    if (mismatch !== null) return { status: 'failed', note: `badResult: ${mismatch}`, result: value }
  }
  if (value.status === 'failed') return { status: 'failed', note: value.error, result: value }
  if (value.status === 'needsInput') return { status: 'needsInput', note: null, result: value }
  const path = reportPath(value)
  // a sweep with nothing to sweep writes no summary and is still done
  if (path === null && !(value.schema === 'pit-crew/sweep-result@1' && value.counts.swept === 0)) {
    return { status: 'failed', note: 'noReport: result.json names no report', result: value }
  }
  if (path !== null && input.reportExists === false) return { status: 'failed', note: `noReport: ${path} does not exist`, result: value }
  return { status: 'done', note: null, result: value }
}

// processes

export type ProcessEntry = { pid: number, ppid: number, pgid: number }

// ps -A -o pid=,ppid=,pgid=
export const parsePs = (text: string): ProcessEntry[] =>
  text.split('\n').map((line) => line.trim().split(/\s+/).map(Number)).filter((fields) => fields.length === 3 && fields.every(Number.isInteger))
    .map(([pid, ppid, pgid]) => ({ pid: pid as number, ppid: ppid as number, pgid: pgid as number }))

// the process groups of a runner's descendants, in the order found, and the runner's own last
export const descendantGroups = (entries: readonly ProcessEntry[], pid: number): number[] => {
  const own = entries.find((entry) => entry.pid === pid)?.pgid ?? pid
  const groups: number[] = []
  const queue = [pid]
  const seen = new Set(queue)
  while (queue.length > 0) {
    const parent = queue.shift() as number
    for (const child of entries.filter((entry) => entry.ppid === parent && !seen.has(entry.pid))) {
      seen.add(child.pid)
      queue.push(child.pid)
      if (child.pgid !== own && !groups.includes(child.pgid)) groups.push(child.pgid)
    }
  }
  return [...groups, own]
}

export type Procs = {
  list: () => Promise<ProcessEntry[]>
  // the start time ps prints for a pid, or null when there is no such process
  startTime: (pid: number) => Promise<string | null>
}

export const procsFrom = (ps: Runner): Procs => ({
  list: async () => {
    const result = await ps(['-A', '-o', 'pid=,ppid=,pgid='])
    if (result.code !== 0) throw new Error(`ps failed: ${result.stderr.trim()}`)
    return parsePs(result.stdout)
  },
  startTime: async (pid) => {
    const result = await ps(['-o', 'lstart=', '-p', String(pid)])
    const text = result.stdout.trim()
    return result.code === 0 && text !== '' ? text : null
  },
})

export type Kill = (pid: number, signal: NodeJS.Signals | 0) => void

export type Exit = { code: number | null, signal: string | null, error: string | null }

export type SpawnRequest = {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  // the runner's stdout and stderr go straight to these files, so they outlive the server
  stdoutPath: string
  stderrPath: string
  stdin: 'pipe' | 'ignore'
}

export type SpawnedProcess = {
  pid: number | null
  stdin: { write: (text: string) => void, end: () => void } | null
  exited: Promise<Exit>
}

export type Spawn = (request: SpawnRequest) => SpawnedProcess

// detached in its own process group, its output in files: restarting the server does not end it
export const systemSpawn: Spawn = (request) => {
  const out = openSync(request.stdoutPath, 'a')
  const err = openSync(request.stderrPath, 'a')
  let child: ReturnType<typeof spawnChild>
  try {
    child = spawnChild(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      detached: true,
      stdio: [request.stdin, out, err],
    })
  } finally {
    closeSync(out)
    closeSync(err)
  }
  const exited = new Promise<Exit>((resolveExit) => {
    child.once('error', (error) => resolveExit({ code: null, signal: null, error: error.message }))
    child.once('exit', (code, signal) => resolveExit({ code, signal, error: null }))
  })
  child.unref()
  const stdin = child.stdin
  // the runner may exit before its stdin closes
  stdin?.on('error', () => {})
  return {
    pid: child.pid ?? null,
    stdin: stdin === null ? null : { write: (text) => { stdin.write(text) }, end: () => { stdin.end() } },
    exited,
  }
}

export type LauncherFs = {
  mkdir: (path: string) => Promise<void>
  writeFile: (path: string, text: string) => Promise<void>
  // null when the file does not exist
  readFile: (path: string) => Promise<string | null>
  // the bytes from offset to the end; empty when the file does not exist yet
  readFrom: (path: string, offset: number) => Promise<Buffer>
  exists: (path: string) => Promise<boolean>
  realpath: (path: string) => Promise<string>
  rm: (path: string) => Promise<void>
  // calls onChange whenever something in the folder changes; may throw where watching is not supported
  watch: (dir: string, onChange: () => void) => { close: () => void }
}

const missing = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')

export const systemFs: LauncherFs = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true })
  },
  writeFile: (path, text) => writeFile(path, text, 'utf8'),
  readFile: async (path) => {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (missing(error)) return null
      throw error
    }
  },
  readFrom: async (path, offset) => {
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(path, 'r')
    } catch (error) {
      if (missing(error)) return Buffer.alloc(0)
      throw error
    }
    try {
      const { size } = await handle.stat()
      if (size <= offset) return Buffer.alloc(0)
      const buffer = Buffer.alloc(size - offset)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  },
  exists: async (path) => {
    try {
      await stat(path)
      return true
    } catch (error) {
      if (missing(error)) return false
      throw error
    }
  },
  realpath: (path) => realpath(path),
  rm: (path) => rm(path, { recursive: true, force: true }),
  watch: (dir, onChange) => {
    const watcher = watchDir(dir, () => onChange())
    watcher.on('error', () => {})
    return { close: () => watcher.close() }
  },
}

// the launcher

export type LaunchErrorCode =
  | 'noClone' | 'notAClone' | 'identityMismatch' | 'identityUnknown' | 'busy' | 'unknownRun' | 'notRunning' | 'tandemRunner' | 'fixRunner'

export class LaunchError extends Error {
  override name = 'LaunchError'
  code: LaunchErrorCode
  constructor (code: LaunchErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export type StartRequest = {
  repo: string
  number: number
  command: string
  // without --emit-json, which the launcher adds
  args: string[]
  label: string
  // the configured default when left out
  runner?: RunnerName
  // cloneDir when left out; phase 4 passes its worktree
  cwd?: string
}

export type Launcher = {
  // identity, clone and one-per-PR checks, then the run directory, request.json and the spawn
  start: (request: StartRequest) => Promise<Run>
  // SIGTERM to the run's group now, SIGKILL to every descendant's group after the grace period
  stop: (id: number) => Run
  // at server start: re-watch live runs, settle the rest
  recover: () => Promise<void>
  // reads every watched run's files now
  check: () => Promise<void>
  // resolves once the run has settled
  settled: (id: number) => Promise<Run>
  // stops watching; runs keep going
  close: () => void
}

export type LauncherOptions = {
  cache: Cache
  gh: Gh
  // git, for the clone check
  git: Runner
  spawn: Spawn
  fs: LauncherFs
  kill: Kill
  procs: Procs
  clock: Clock
  timers: Timers
  // the config in effect, viewer resolved
  config: () => Config
  home: string
  // runs live in <stateDir>/runs/<id>
  stateDir: string
  // the environment the child's few variables are picked from
  env: Readonly<Record<string, string | undefined>>
  newSessionId: () => string
  // a run is now this process's to watch: created here (even one whose start fails at once) or
  // adopted at startup because it was still running; called before its first onChange
  onWatch: (run: Run) => void
  // a run's row changed: started, stepped, or settled
  onChange: (run: Run) => void
  log?: (line: string) => void
  // how often a run's files are read when the folder cannot be watched, and the safety
  // net when it can; a recovered run's liveness is checked as often
  pollMs?: number
  watchedPollMs?: number
  stopGraceMs?: number
}

// one run being watched
type Live = {
  id: number
  dir: string
  // what the run was started with; a recovered run's comes from the config in effect
  spec: LaunchSpec | null
  child: SpawnedProcess | null
  pid: number | null
  offsets: { events: number, stream: number }
  // the step slots folded from every events.jsonl line read so far
  steps: StepSlot[]
  stream: StreamState
  stdinOpen: boolean
  watcher: { close: () => void } | null
  timer: unknown
  killTimer: unknown
  // file reads, one at a time
  pump: Promise<void>
  stopping: boolean
  settling: boolean
}

// a git remote names the repo: https or ssh, with or without .git
export const remoteNamesRepo = (remotes: string, repo: string): boolean => {
  const wanted = repo.toLowerCase()
  return remotes.split('\n').some((line) => {
    const url = (line.trim().split(/\s+/)[1] ?? '').toLowerCase().replace(/\/$/, '').replace(/\.git$/, '')
    return url.endsWith(`/${wanted}`) || url.endsWith(`:${wanted}`)
  })
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

export const createLauncher = (options: LauncherOptions): Launcher => {
  const { cache, gh, git, spawn, fs, kill, procs, clock, timers, home, onChange, onWatch } = options
  const log = options.log ?? (() => {})
  const pollMs = options.pollMs ?? 1000
  const watchedPollMs = options.watchedPollMs ?? 10_000
  const stopGraceMs = options.stopGraceMs ?? 10_000
  const runsDir = resolve(options.stateDir, 'runs')
  const live = new Map<number, Live>()
  const waiters = new Map<number, ((run: Run) => void)[]>()
  // PRs whose start is between its checks and its row
  const starting = new Set<string>()
  let closed = false

  const now = (): string => iso(clock.now())
  const changed = (run: Run): void => {
    if (!closed) onChange(run)
  }

  const alive = (pid: number): boolean => {
    try {
      kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  const signalGroup = (pgid: number, signal: NodeJS.Signals): void => {
    try {
      kill(-pgid, signal)
    } catch (error) {
      log(`cannot send ${signal} to process group ${pgid}: ${messageOf(error)}`)
    }
  }

  const inFlight = (repo: string, number: number): boolean => cache.runsFor(repo, number, 1)[0]?.status === 'running'

  // the commands post as whichever account gh uses, and this machine may hold more than one
  const checkIdentity = async (config: Config): Promise<void> => {
    let login: string
    try {
      login = await fetchViewerLogin(gh)
    } catch (error) {
      throw new LaunchError('identityUnknown', `cannot confirm which account gh uses: ${messageOf(error)}`)
    }
    if (login.toLowerCase() !== config.viewer.toLowerCase()) {
      throw new LaunchError('identityMismatch', `gh is signed in as ${login || 'nobody'}, but the viewer is ${config.viewer}; switch with gh auth switch before starting a run`)
    }
  }

  const checkClone = async (config: Config): Promise<string> => {
    if (config.cloneDir === undefined) {
      throw new LaunchError('noClone', `set cloneDir in the config to your local clone of ${config.repo} before starting a run`)
    }
    const dir = expandHome(config.cloneDir, home)
    let result: Awaited<ReturnType<Runner>>
    try {
      result = await git(['-C', dir, 'remote', '-v'])
    } catch (error) {
      throw new LaunchError('notAClone', `cannot run git to check cloneDir ${config.cloneDir}: ${messageOf(error)}`)
    }
    if (result.code !== 0) throw new LaunchError('notAClone', `cloneDir ${config.cloneDir} is not a git clone: ${result.stderr.trim().split('\n')[0] ?? ''}`)
    if (!remoteNamesRepo(result.stdout, config.repo)) throw new LaunchError('notAClone', `cloneDir ${config.cloneDir} has no remote for ${config.repo}`)
    return dir
  }

  // --add-dir refuses a path with a symlink in it
  const resolved = async (path: string): Promise<string> => {
    try {
      return await fs.realpath(path)
    } catch {
      return path
    }
  }

  const readNew = async (entry: Live): Promise<void> => {
    let run = cache.getRun(entry.id)
    if (run === null) return
    const changes: RunChanges = {}
    const eventsBytes = await fs.readFrom(join(entry.dir, 'events.jsonl'), entry.offsets.events)
    const eventsEnd = eventsBytes.lastIndexOf(0x0a)
    if (eventsEnd >= 0) {
      entry.offsets.events += eventsEnd + 1
      // the newest line for a step is its current state; the newest line is the run's last step
      const events = eventsBytes.subarray(0, eventsEnd).toString('utf8').split('\n').map(parseStepEvent).filter((event) => event !== null)
      const latest = events.at(-1)
      if (latest !== undefined) {
        Object.assign(changes, { lastStepAt: latest.at, step: latest.step, stepState: latest.state })
        entry.steps = foldSteps(entry.steps, events)
        // a note or time that moved on an unchanged step still changes the row
        if (JSON.stringify(entry.steps) !== JSON.stringify(run.steps)) changes.steps = entry.steps
      }
    }
    const streamBytes = await fs.readFrom(join(entry.dir, 'stream.jsonl'), entry.offsets.stream)
    const streamEnd = streamBytes.lastIndexOf(0x0a)
    if (streamEnd >= 0) {
      entry.offsets.stream += streamEnd + 1
      let closeStdin = false
      for (const line of streamBytes.subarray(0, streamEnd).toString('utf8').split('\n')) {
        if (line.trim() === '') continue
        const folded = foldStream(entry.stream, line)
        entry.stream = folded.state
        if (folded.closeStdin) closeStdin = true
      }
      if (closeStdin && entry.stdinOpen && entry.child?.stdin != null) {
        entry.stdinOpen = false
        entry.child.stdin.end()
      }
      if (entry.stream.costUsd !== run.costUsd) changes.costUsd = entry.stream.costUsd
      if (run.sessionId === null && entry.stream.sessionId !== null) {
        changes.sessionId = entry.stream.sessionId
        entry.spec ??= await specFor(run, entry.dir)
        changes.resume = resumeFor(run, entry.stream.sessionId, entry.spec)
      }
    }
    if (Object.keys(changes).length === 0) return
    run = cache.updateRun(entry.id, changes)
    changed(run)
  }

  const pumpOf = (entry: Live): Promise<void> => {
    entry.pump = entry.pump.then(() => readNew(entry)).catch((error: unknown) => log(`run ${entry.id}: cannot read its files: ${messageOf(error)}`))
    return entry.pump
  }

  const specFor = async (run: Pick<Run, 'command' | 'args' | 'cwd' | 'sessionId'>, dir: string): Promise<LaunchSpec> => {
    const config = options.config()
    return {
      command: run.command,
      args: run.args,
      cwd: expandHome(run.cwd, home),
      runDir: dir,
      home,
      sessionId: run.sessionId,
      ...(config.agent.codexModel === undefined ? {} : { codexModel: config.agent.codexModel }),
      reportsDir: await resolved(join(home, 'agents', 'output')),
      worktreesDir: await resolved(join(home, 'agents', 'worktrees')),
    }
  }

  const resumeFor = (run: Pick<Run, 'runner' | 'cwd'>, sessionId: string, spec: LaunchSpec): string =>
    runners[run.runner].resume(run.cwd, sessionId, spec, home)

  const clear = (entry: Live): void => {
    entry.watcher?.close()
    entry.watcher = null
    if (entry.timer !== null) timers.clear(entry.timer)
    entry.timer = null
    if (entry.killTimer !== null) timers.clear(entry.killTimer)
    entry.killTimer = null
  }

  const settle = async (entry: Live, exit: Exit | null, restarted: boolean): Promise<Run | null> => {
    if (entry.settling || closed) return null
    entry.settling = true
    clear(entry)
    await pumpOf(entry)
    // a server shutting down leaves the run recorded as running, for recovery to find
    if (closed) return null
    const text = await fs.readFile(join(entry.dir, 'result.json')).catch(() => null)
    const parsed = text === null ? null : parseResult(text)
    let reportExists: boolean | null = null
    if (parsed?.ok === true && parsed.value.status === 'done') {
      const path = reportPath(parsed.value)
      if (path !== null) reportExists = await fs.exists(expandHome(path, home)).catch(() => false)
    }
    const judgement = judge({
      stopped: entry.stopping,
      restarted,
      exit,
      parsed,
      reportExists,
      denials: entry.stream.denials,
      lastEvent: entry.stream.lastEvent,
    })
    live.delete(entry.id)
    if (entry.stdinOpen && entry.child?.stdin != null) entry.child.stdin.end()
    entry.stdinOpen = false
    const run = cache.updateRun(entry.id, { ...judgement, finishedAt: now() })
    log(`run ${run.id} (${run.command} ${run.args.join(' ')}) ${run.status}${run.note === null ? '' : `: ${run.note}`}`)
    changed(run)
    for (const resolveWaiter of waiters.get(run.id) ?? []) resolveWaiter(run)
    waiters.delete(run.id)
    return run
  }

  // a run is read on every change in its folder and on a timer; one without a child handle (a
  // recovered run) is also checked for life on that timer
  const poll = (entry: Live, ms: number): void => {
    entry.timer = timers.set(() => {
      entry.timer = null
      if (entry.settling || closed) return
      void pumpOf(entry).then(() => {
        if (entry.settling || closed) return
        if (entry.child === null && (entry.pid === null || !alive(entry.pid))) {
          void settle(entry, null, false)
        } else {
          poll(entry, ms)
        }
      })
    }, ms)
  }

  const watchRun = (run: Run, dir: string, child: SpawnedProcess | null, stdinOpen: boolean, spec: LaunchSpec | null): Live => {
    const entry: Live = {
      id: run.id,
      dir,
      spec,
      child,
      pid: run.pid,
      offsets: { events: 0, stream: 0 },
      steps: emptySteps(),
      stream: emptyStream(),
      stdinOpen,
      watcher: null,
      timer: null,
      killTimer: null,
      pump: Promise.resolve(),
      stopping: false,
      settling: false,
    }
    live.set(run.id, entry)
    try {
      entry.watcher = fs.watch(dir, () => {
        if (!entry.settling) void pumpOf(entry)
      })
    } catch (error) {
      log(`run ${run.id}: cannot watch ${tildePath(dir, home)}, polling instead: ${messageOf(error)}`)
    }
    poll(entry, entry.watcher === null ? pollMs : watchedPollMs)
    if (child !== null) {
      void child.exited.then((exit) => settle(entry, exit, false)).catch((error: unknown) => log(`run ${run.id}: cannot settle: ${messageOf(error)}`))
    }
    void pumpOf(entry)
    return entry
  }

  // a pruned run's folder goes with its row, and nothing outside the runs folder is ever removed
  const prune = async (): Promise<void> => {
    for (const gone of cache.pruneRuns()) {
      const dir = resolve(expandHome(gone.dir, home))
      if (!dir.startsWith(`${runsDir}${sep}`)) {
        log(`run ${gone.id}: not removing ${gone.dir}, which is outside the runs folder`)
        continue
      }
      await fs.rm(dir).catch((error: unknown) => log(`run ${gone.id}: cannot remove ${gone.dir}: ${messageOf(error)}`))
    }
  }

  const launch = async (request: StartRequest, config: Config, cwd: string): Promise<Run> => {
    const runner = request.runner ?? config.agent.runner
    const sessionId = runner === 'claude' ? options.newSessionId() : null
    let run = cache.createRun({
      repo: request.repo,
      number: request.number,
      command: request.command,
      args: request.args,
      label: request.label,
      runner,
      cwd: tildePath(cwd, home),
      sessionId,
      pid: null,
      pidStartedAt: null,
      startedAt: now(),
      lastStepAt: null,
      step: null,
      stepState: null,
      finishedAt: null,
      status: 'running',
      result: null,
      note: null,
      costUsd: null,
      resume: null,
    }, (id) => tildePath(join(runsDir, String(id)), home))
    if (!closed) onWatch(run)
    const dir = join(runsDir, String(run.id))
    let child: SpawnedProcess
    let spec: LaunchSpec
    let record: Record<string, unknown>
    let stdin: string | null
    try {
      await fs.mkdir(dir)
      spec = await specFor(run, dir)
      const invocation = runners[runner].invocation(spec)
      stdin = invocation.stdin
      record = {
        runner,
        command: run.command,
        args: run.args,
        cwd: run.cwd,
        sessionId,
        argv: [invocation.command, ...invocation.args],
        startedAt: run.startedAt,
      }
      await fs.writeFile(join(dir, 'request.json'), `${JSON.stringify({ ...record, pid: null, pidStartedAt: null }, null, 2)}\n`)
      child = spawn({
        command: invocation.command,
        args: invocation.args,
        cwd,
        env: childEnv(options.env, home),
        stdoutPath: join(dir, 'stream.jsonl'),
        stderrPath: join(dir, 'stderr.log'),
        stdin: stdin === null ? 'ignore' : 'pipe',
      })
    } catch (error) {
      run = cache.updateRun(run.id, { status: 'failed', finishedAt: now(), note: `spawnFailed: ${messageOf(error)}` })
      log(`run ${run.id}: cannot start: ${messageOf(error)}`)
      changed(run)
      await prune()
      return run
    }
    // from here the process exists, so nothing below may fail the run
    if (stdin !== null) child.stdin?.write(stdin)
    const pidStartedAt = child.pid === null ? null : await procs.startTime(child.pid).catch(() => null)
    run = cache.updateRun(run.id, {
      pid: child.pid,
      pidStartedAt,
      resume: sessionId === null ? null : resumeFor(run, sessionId, spec),
    })
    await fs.writeFile(join(dir, 'request.json'), `${JSON.stringify({ ...record, pid: child.pid, pidStartedAt }, null, 2)}\n`)
      .catch((error: unknown) => log(`run ${run.id}: cannot update request.json: ${messageOf(error)}`))
    watchRun(run, dir, child, stdin !== null && child.stdin !== null, spec)
    log(`run ${run.id} started: ${run.runner} ${run.command} ${run.args.join(' ')} in ${run.cwd}`)
    changed(run)
    await prune()
    return cache.getRun(run.id) ?? run
  }

  const start = async (request: StartRequest): Promise<Run> => {
    const config = options.config()
    // a tandem primary launches its secondary in the background, and the fix session is pinned to
    // Claude; the runner is the one asked for or the configured default, so no caller gets around this
    if (claudeOnly(request.command, request.args) && (request.runner ?? config.agent.runner) !== 'claude') {
      if (isTandemRun(request.args)) throw new LaunchError('tandemRunner', 'Review in tandem runs with Claude only; send runner claude or leave it out')
      throw new LaunchError('fixRunner', 'Fix session runs with Claude only; send runner claude or leave it out')
    }
    const key = `${request.repo}#${request.number}`
    // one run per PR in flight, counting a start still between its checks and its row
    if (starting.has(key) || inFlight(request.repo, request.number)) {
      throw new LaunchError('busy', `a run for #${request.number} is already in flight`)
    }
    starting.add(key)
    try {
      await checkIdentity(config)
      const cloneDir = await checkClone(config)
      return await launch(request, config, request.cwd ?? cloneDir)
    } finally {
      starting.delete(key)
    }
  }

  // after the grace period, every group under a runner that is still alive, its own last: Claude
  // runs each background command in a group of its own, which a kill of the runner would orphan
  const escalate = async (entry: Live): Promise<void> => {
    entry.killTimer = null
    if (entry.settling || entry.pid === null || !alive(entry.pid)) return
    let groups = [entry.pid]
    try {
      groups = descendantGroups(await procs.list(), entry.pid)
    } catch (error) {
      log(`run ${entry.id}: cannot list its processes: ${messageOf(error)}`)
    }
    for (const group of groups) signalGroup(group, 'SIGKILL')
  }

  const stop = (id: number): Run => {
    const run = cache.getRun(id)
    if (run === null) throw new LaunchError('unknownRun', `run ${id} does not exist`)
    if (run.status !== 'running') throw new LaunchError('notRunning', `run ${id} is not running (${run.status})`)
    const entry = live.get(id)
    if (entry === undefined) {
      // nothing watches it: a run recorded as running with no process behind it
      const stopped = cache.updateRun(id, { status: 'stopped', finishedAt: now() })
      changed(stopped)
      return stopped
    }
    // a spawn that failed has no process to signal; its exit settles it as stopped
    if (entry.pid === null) {
      entry.stopping = true
      return run
    }
    if (!entry.stopping) {
      entry.stopping = true
      signalGroup(entry.pid, 'SIGTERM')
      entry.killTimer = timers.set(() => {
        void escalate(entry)
      }, stopGraceMs)
    }
    return run
  }

  type RequestFile = { pid?: unknown, pidStartedAt?: unknown }

  const recover = async (): Promise<void> => {
    for (const run of cache.runningRuns()) {
      if (live.has(run.id)) continue
      const dir = expandHome(run.dir, home)
      let request: RequestFile = {}
      try {
        request = JSON.parse(await fs.readFile(join(dir, 'request.json')) ?? '{}') as RequestFile
      } catch {
        request = {}
      }
      const pid = typeof request.pid === 'number' ? request.pid : run.pid
      const startedAt = typeof request.pidStartedAt === 'string' ? request.pidStartedAt : run.pidStartedAt
      // a pid alone could have been reused; its start time must match too
      const same = pid !== null && startedAt !== null && alive(pid) && await procs.startTime(pid).catch(() => null) === startedAt
      if (same) {
        log(`run ${run.id}: still running after the restart (pid ${pid}); watching it again`)
        if (!closed) onWatch(run)
        watchRun({ ...run, pid }, dir, null, false, null)
      } else {
        const entry = watchRun({ ...run, pid: null }, dir, null, false, null)
        await settle(entry, null, true)
      }
    }
  }

  const checkAll = async (): Promise<void> => {
    await Promise.all([...live.values()].map((entry) => pumpOf(entry)))
  }

  const settled = (id: number): Promise<Run> => {
    const run = cache.getRun(id)
    if (run === null) return Promise.reject(new LaunchError('unknownRun', `run ${id} does not exist`))
    if (!live.has(id)) return Promise.resolve(run)
    return new Promise((resolveRun) => waiters.set(id, [...(waiters.get(id) ?? []), resolveRun]))
  }

  const close = (): void => {
    closed = true
    for (const entry of live.values()) clear(entry)
  }

  return { start, stop, recover, check: checkAll, settled, close }
}
