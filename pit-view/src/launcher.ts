// src/launcher.ts
import { spawn as spawnChild } from 'node:child_process'
import { closeSync, openSync, watch as watchDir } from 'node:fs'
import { mkdir, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { Cache, NewRun, NewSweep, Run, RunChanges, RunStatus, Session, Sweep } from './cache.ts'
import { expandHome, tildePath } from './config.ts'
import type { Clock, Config, RunnerName } from './config.ts'
import { isBotLogin, isMine, viewerReview } from './derive.ts'
import type { Stack } from './derive.ts'
import { fetchViewerLogin } from './github.ts'
import type { Gh, RawOpenPr, Runner } from './github.ts'
import type { Timers } from './poller.ts'
import { prReportName, reportHash } from './reports.ts'
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
export type NotPostedReason = 'noPost' | 'ownPr' | 'awaitingAnswer' | 'ghFailed' | 'postBlocked'
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
  // repo and counts are null only for a failed or needsInput sweep that stopped before it had them
  repo: string | null
  counts: { swept: number, fresh: number, reused: number, failed: number } | null
  // null when the sweep may post; noPost when it ran with --no-post. A result written before the field existed has none, and reads as null
  notPostedReason: 'noPost' | null
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

// update-pr's response, pinned with it as pit-crew/update-result@1 (section 8 of DESIGN.md): how the PR's branch was brought up to date with the primary branch
export type UpdateMethod = 'rebase' | 'merge'
export const updateMethods: readonly UpdateMethod[] = ['rebase', 'merge']
export type NotUpdatedReason = 'upToDate' | 'awaitingAnswer' | 'checksFailed' | 'checksNotRun' | 'pushFailed'
export const notUpdatedReasons: readonly NotUpdatedReason[] = ['upToDate', 'awaitingAnswer', 'checksFailed', 'checksNotRun', 'pushFailed']
export type UpdateConflict = { path: string, resolution: string }
// a rebase is pushed with --force-with-lease, a merge without force
export type UpdatePushed = { branch: string, head: string, forced: boolean }

export type UpdateResult = {
  schema: 'pit-crew/update-result@1'
  command: 'update-pr'
  status: ResultStatus
  // base is the primary branch the run updated from
  target: { repo: string, pr: number, branch: string, base: string } | null
  // the PR head the run read, which is also its lease
  head: { sha: string } | null
  // the primary branch's commit the run updated onto
  upstream: { sha: string } | null
  method: UpdateMethod | null
  methodReason: string | null
  conflicts: UpdateConflict[]
  checks: FixCheck[]
  pushed: UpdatePushed | null
  notPushedReason: NotUpdatedReason | null
  worktree: string | null
  question: string | null
  error: string | null
}

export type RunResultJson = ReviewResult | SweepResult | FixResult | UpdateResult

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

const updateFields = ['schema', 'command', 'status', 'target', 'head', 'upstream', 'method', 'methodReason', 'conflicts', 'checks', 'pushed', 'notPushedReason', 'worktree', 'question', 'error']
const fixFields = ['schema', 'command', 'status', 'target', 'head', 'requests', 'checks', 'pushed', 'notPushedReason', 'worktree', 'report', 'question', 'error']
const reviewFields = ['schema', 'command', 'status', 'target', 'reviewed', 'verdict', 'recommendation', 'findings', 'ci', 'fixAttempts', 'posted', 'notPostedReason', 'report', 'question', 'error']
// notPostedReason is absent from a sweep result written before the field existed, so it is not required here
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
  check(value.target === null || (isObject(value.target) && typeof value.target.repo === 'string' && (!('pr' in value.target) || value.target.pr === null || isPositiveInteger(value.target.pr)) && (!('stack' in value.target) || (Array.isArray(value.target.stack) && value.target.stack.every(isPositiveInteger) && value.target.stack.length > 0 && value.target.top === value.target.stack.at(-1)))), 'target must be null or an object with a repo, a pr that is null or a positive integer, and a stack of positive integers that ends with its top')
  check(value.reviewed === null || (isObject(value.reviewed) && value.reviewed.kind === 'commit' && typeof value.reviewed.sha === 'string'), 'reviewed must be null or { kind: commit, sha }')
  check(oneOfOrNull(value.verdict, ['changesRequested', 'clean']), 'verdict must be changesRequested, clean or null')
  check(oneOfOrNull(value.recommendation, ['approve', 'fixBeforeMerge', 'hold', 'doNotMerge']), 'recommendation must be one of the four or null')
  check(Array.isArray(value.findings) && value.findings.every((finding) =>
    isObject(finding) && ['P0', 'P1', 'P2', 'P3'].includes(finding.priority as string) && typeof finding.summary === 'string' && Array.isArray(finding.files)), 'findings must be a list of { priority, summary, files }')
  check(oneOfOrNull(value.ci, ['green', 'failed', 'pending', 'none']), 'ci must be green, failed, pending, none or null')
  check(Number.isInteger(value.fixAttempts) && (value.fixAttempts as number) >= 0, 'fixAttempts must be a whole number')
  checkPosted(value.posted)
  check(oneOfOrNull(value.notPostedReason, ['noPost', 'ownPr', 'awaitingAnswer', 'ghFailed', 'postBlocked']), 'notPostedReason must be one of the five or null')
  check(isStringOrNull(value.report), 'report must be a path or null')
}

const checkSweep = (value: Record<string, unknown>): void => {
  for (const field of sweepFields) check(field in value, `${field} is missing`)
  check(value.command === 'review-dependabot-sweep', 'command must be review-dependabot-sweep')
  checkStatus(value)
  // a sweep that stops early may not have resolved the repository or written the summary; only a done one always has both
  const stoppedEarly = value.status !== 'done'
  check(typeof value.repo === 'string' || (stoppedEarly && value.repo === null), 'repo must be a string')
  const counts = value.counts
  check((stoppedEarly && counts === null) || (isObject(counts) && ['swept', 'fresh', 'reused', 'failed'].every((key) => Number.isInteger(counts[key]))), 'counts must hold swept, fresh, reused and failed')
  check(Array.isArray(value.rows) && Array.isArray(value.mergeOrder), 'rows and mergeOrder must be lists')
  check(isStringOrNull(value.summary), 'summary must be a path or null')
  if (!('notPostedReason' in value)) value.notPostedReason = null
  check(oneOfOrNull(value.notPostedReason, ['noPost']), 'notPostedReason must be noPost or null')
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

const checkUpdate = (value: Record<string, unknown>): void => {
  for (const field of updateFields) check(field in value, `${field} is missing`)
  check(value.command === 'update-pr', 'command must be update-pr')
  checkStatus(value)
  const target = value.target
  check(target === null || (isObject(target) && typeof target.repo === 'string' && isPositiveInteger(target.pr) && typeof target.branch === 'string' && target.branch !== '' &&
    typeof target.base === 'string' && target.base !== ''), 'target must be null or { repo, pr, branch, base }')
  for (const field of ['head', 'upstream']) {
    const sha = value[field]
    check(sha === null || (isObject(sha) && isFullSha(sha.sha)), `${field} must be null or { sha } with a full 40-character SHA`)
  }
  check(oneOfOrNull(value.method, updateMethods), 'method must be rebase, merge or null')
  check(isStringOrNull(value.methodReason), 'methodReason must be a string or null')
  check(Array.isArray(value.conflicts) && value.conflicts.every((entry) =>
    isObject(entry) && typeof entry.path === 'string' && entry.path !== '' && typeof entry.resolution === 'string'), 'conflicts must be a list of { path, resolution }')
  check(Array.isArray(value.checks) && value.checks.every((entry) =>
    isObject(entry) && typeof entry.name === 'string' && ['passed', 'failed', 'notRun'].includes(entry.result as string)), 'checks must be a list of { name, result: passed, failed or notRun }')
  const pushed = value.pushed
  check(pushed === null || (isObject(pushed) && typeof pushed.branch === 'string' && pushed.branch !== '' && isFullSha(pushed.head) && typeof pushed.forced === 'boolean'),
    'pushed must be null or { branch, head, forced } with a full SHA')
  check(oneOfOrNull(value.notPushedReason, notUpdatedReasons), 'notPushedReason must be upToDate, awaitingAnswer, checksFailed, checksNotRun, pushFailed or null')
  check(value.pushed === null || value.notPushedReason === null, 'notPushedReason must be null when pushed')
  check(isStringOrNull(value.worktree), 'worktree must be a path or null')
}

// a well-formed update result whose fields contradict each other: the run fails, keeping the result for the drawer. Null when they agree
export const updateMismatch = (result: UpdateResult): string | null => {
  const target = result.target
  if (target !== null && target.branch === target.base) return `the PR's branch ${target.branch} is the primary branch it updates from`
  const pushed = result.pushed
  if (pushed !== null) {
    if (pushed.branch !== target?.branch) return `pushed.branch ${pushed.branch} is not the target branch ${target?.branch ?? '(none)'}`
    if (result.method === null) return 'pushed carries no method'
    // a rebase rewrites the PR's own commits, so it is pushed with --force-with-lease; a merge adds a commit and needs no force
    if (pushed.forced !== (result.method === 'rebase')) return `a ${result.method} was pushed ${pushed.forced ? 'with' : 'without'} force`
  }
  if (result.status === 'done' && pushed === null && result.notPushedReason === null) return 'a done update result carries neither pushed nor notPushedReason'
  return null
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
    } else if (result.schema === 'pit-crew/update-result@1') {
      checkUpdate(result)
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
export const stepsOf = (run: Pick<Session, 'steps'>): StepSlot[] => run.steps ?? emptySteps()

// the report a done result names: the review's or the fix's report, or the sweep's summary; an update writes none
export const reportPath = (result: RunResultJson): string | null => {
  if (result.schema === 'pit-crew/update-result@1') return null
  return result.schema === 'pit-crew/sweep-result@1' ? result.summary : result.report
}

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
  // every Claude run's --model
  claudeModel: string
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

// whether a run may post at all, from its own command and flags and nothing else: never from anything in its result, which an agent wrote after reading other people's PR text. A stack review stops to offer its post, a fix pushes, and an update pushes, so none of them posts by itself
const mayPost = (command: string, args: readonly string[]): boolean =>
  ['review-pr', 'review-dependabot', 'review-dependabot-sweep'].includes(command) && !args.includes('--no-post')

export const claudeInvocation = (spec: LaunchSpec): Invocation => ({
  command: 'claude',
  args: [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', spec.claudeModel, '--session-id', spec.sessionId ?? '', '--permission-mode', 'auto', '--add-dir', join(spec.home, 'agents'),
  ],
  // one user message; stdin then stays open until the result arrives with nothing in the background
  stdin: `${JSON.stringify({ type: 'user', message: { role: 'user', content: requestText('/', spec.command, spec.args, spec.runDir) } })}\n`,
})

// the model and sandbox flags a Codex run starts with, which a resumed session needs again
export const codexModelArgs = (spec: Pick<LaunchSpec, 'codexModel'>): string[] =>
  spec.codexModel === undefined ? [] : ['-m', spec.codexModel]

// every folder a Codex run may write: the workspace itself, the checkout's .git, the run directory
// the request's --emit-json names, and the resolved reports and worktrees folders. A folder left out
// of this list is a folder the command cannot write, whatever the prompt it runs says to write there
export const codexSandboxArgs = (spec: Pick<LaunchSpec, 'cwd' | 'runDir' | 'reportsDir' | 'worktreesDir'>): string[] => [
  '-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true',
  '--add-dir', join(spec.cwd, '.git'), '--add-dir', spec.runDir, '--add-dir', spec.reportsDir, '--add-dir', spec.worktreesDir,
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

// a run's git traffic, and the credentials it carries: the command's own fetch runs inside the runner's sandbox, where an ssh identity cannot be unlocked (Codex refuses /dev/tty) and where depending on an agent's socket would make the run's success a property of what is listening outside it. Redirecting an SSH remote to HTTPS and letting gh's helper answer means no key, no socket, and no prompt is involved: the run authenticates with the same gh login the launcher already requires for its API reads, and the helper is asked for the token rather than given it
export const gitConfigEnv = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf',
  GIT_CONFIG_VALUE_0: 'git@github.com:',
  GIT_CONFIG_KEY_1: 'credential.helper',
  GIT_CONFIG_VALUE_1: '!gh auth git-credential',
} as const

export const childEnv = (source: Readonly<Record<string, string | undefined>>, home: string): Record<string, string> => {
  const env: Record<string, string> = { HOME: home, ...gitConfigEnv }
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
  // the repository and viewer the confirmation names, which the start request carries back so the server refuses it when either is no longer the one in effect
  repo: string
  viewer: string
  // why it cannot start right now, from what the server knows without asking GitHub; null otherwise
  unavailable: string | null
}

export const isTandemRun = (args: readonly string[]): boolean => args.includes('--tandem')

// fix-pr pushes to the PR's branch, so it is offered only on the viewer's own PRs, never a bot's
export const offersFix = (pr: RawOpenPr, config: Config): boolean =>
  isMine(pr, config) && pr.author?.__typename !== 'Bot' && !isBotLogin(pr.author?.login, config)

// the commands that only Claude can run: a tandem primary, the fix session, and the update session
export const claudeOnly = (command: string, args: readonly string[]): boolean => isTandemRun(args) || command === 'fix-pr' || command === 'update-pr'

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

// the slot a review of this PR takes under the cap: a self-review for the viewer's own PR, otherwise a review
export const slotOf = (pr: RawOpenPr, config: Config): ReviewSlot => isMine(pr, config) ? 'selfReview' : 'review'

// what a button that starts a review says when the review would wait in the queue
export const queueText = (text: string): string => `Queue ${text.charAt(0).toLowerCase()}${text.slice(1)}`

const buttons: Readonly<Record<RunKind, string>> = { review: 'Review PR', reReview: 'Re-review PR', selfReview: 'Self-review' }

// the starts a PR offers now; busy is whether a run for it is in flight
export const startOptions = (pr: RawOpenPr, config: Config, stack: Stack | null, busy: boolean, queueing: Queueing | null = null): StartOption[] => {
  const plan = defaultRun(pr, config)
  // a review's button says queue when a review of this PR would wait; a fix session is not a review and keeps its text
  const waits = queueing !== null && queueing[slotOf(pr, config)]
  const reviewButton = (text: string): string => waits ? queueText(text) : text
  const { repo, viewer } = config
  const unavailable = busy
    ? `a run for #${pr.number} is already in flight`
    : config.cloneDir === undefined ? `set cloneDir in the config to your local clone of ${config.repo} before starting a run` : null
  const options: StartOption[] = [{
    kind: 'default', label: plan.label, button: reviewButton(buttons[plan.kind]), command: plan.command, args: plan.args,
    runners: ['claude', 'codex'], posts: postsFor(plan.command, plan.args, viewer), repo, viewer, unavailable,
  }]
  if (notOffered('tandem', pr, config, stack) === null) {
    // --tandem goes before --no-post; the review-pr prompt reads either flag wherever it stands
    const args = [String(pr.number), '--tandem', ...plan.args.slice(1)]
    const label = plan.kind === 'selfReview' ? 'Tandem self-review' : plan.kind === 'reReview' ? 'Tandem re-review' : 'Tandem review'
    options.push({
      kind: 'tandem', label, button: reviewButton(`${buttons[plan.kind].replace(/ PR$/, '')} in tandem`), command: 'review-pr', args,
      runners: ['claude'], posts: postsFor('review-pr', args, viewer), repo, viewer, unavailable,
    })
  }
  if (notOffered('stack', pr, config, stack) === null) {
    options.push({
      kind: 'stack', label: 'Review stack', button: reviewButton('Review stack'), command: 'review-stack', args: [String(pr.number)],
      runners: ['claude', 'codex'], posts: postsFor('review-stack', [], viewer), repo, viewer, unavailable,
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
      repo,
      viewer,
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

// the cell's summary of an update's result.json
export type UpdateSummary = {
  kind: 'update'
  // the primary branch it updated from, and its commit, short
  base: string | null
  upstream: string | null
  method: UpdateMethod | null
  methodReason: string | null
  conflicts: UpdateConflict[]
  checks: FixCheck[]
  // the head as a full SHA
  pushed: UpdatePushed | null
  notPushedReason: NotUpdatedReason | null
  worktree: string | null
}

// null for a sweep, whose rows the bot group's drawer renders (P2.7)
export type AgentResult = ReviewSummary | FixSummary | UpdateSummary

export type AgentCell = {
  // queued while a review waits for a slot under the cap; running while a run is in flight; done while its latest run's outcome still stands; idle with no run, or once the PR's head has moved past the commit the latest run reviewed
  state: 'idle' | 'queued' | 'running' | 'done'
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
  // the commit the latest run's record says it read, as the run wrote it: a review's reviewed commit, a fix's or an update's head; null with no run or no commit recorded
  commit: string | null
  finishedAt: string | null
  // the done text: Changes requested, Approved, Clean · mark ready?, Failed · no result, and so on
  text: string | null
  result: AgentResult | null
  question: string | null
  // why it failed: a kind such as noResult, optionally followed by ': ' and detail
  note: string | null
  // the owner's re-read replaced the outcome recorded at exit; the note is then the original one unless the run failed again
  resolvedByHand: boolean
  // the note recorded at exit, kept once a failed re-read replaced it; null while the note is still the original
  firstNote: string | null
  resume: string | null
  costUsd: number | null
  // the post a blocked run's report may still get from the drawer's Post it; null for anything else
  postOffer: PostOffer | null
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

// a finished update that pushed nothing: already up to date, or the owner discarded the update at a stop
const notUpdatedTexts: Readonly<Record<NotUpdatedReason, string>> = {
  upToDate: 'Already up to date',
  awaitingAnswer: 'Not pushed',
  checksFailed: 'Not pushed · checks failed',
  checksNotRun: 'Not pushed · checks not run',
  pushFailed: 'Not pushed · push refused',
}

const updateText = (result: UpdateResult): string => {
  const base = result.target?.base ?? 'the primary branch'
  if (result.pushed !== null) return result.method === 'rebase' ? `Rebased onto ${base}` : `Merged ${base} in`
  return result.notPushedReason === null ? 'Done' : notUpdatedTexts[result.notPushedReason]
}

const pushRefused = (result: RunResultJson | null): boolean =>
  (result?.schema === 'pit-crew/fix-result@1' || result?.schema === 'pit-crew/update-result@1') && result.notPushedReason === 'pushFailed'

const postNotes: Partial<Readonly<Record<NotPostedReason, string>>> = { ghFailed: ' · post failed', postBlocked: ' · post not made' }

// the cell's text for a finished run, from section 8's mappings: a review's verdict and posted, a fix's push, an update's method
export const doneText = (run: Pick<Run, 'status' | 'result' | 'note'> & { resolvedByHand?: boolean }, ownDraft: boolean): string => {
  if (run.status === 'stopped') return 'Stopped'
  if (run.status === 'needsInput') return 'Needs your answer'
  if (run.status === 'failed') {
    const kind = noteKind(run.note)
    if (kind !== null) return `Failed · ${failureTexts[kind]}`
    return pushRefused(run.result) ? 'Failed · push refused' : 'Failed'
  }
  const result = run.result
  const byHand = run.resolvedByHand === true ? ' · finished by hand' : ''
  if (result?.schema === 'pit-crew/fix-result@1') return `${fixText(result)}${byHand}`
  if (result?.schema === 'pit-crew/update-result@1') return `${updateText(result)}${byHand}`
  if (result === null || result.schema !== 'pit-crew/review-result@1' || result.verdict === null) return `Done${byHand}`
  let text = 'Clean'
  if (result.verdict === 'changesRequested') text = 'Changes requested'
  else if (ownDraft) text = 'Clean · mark ready?'
  else if (result.posted?.form === 'approve') text = 'Approved'
  else if (result.posted?.form === 'comment') text = 'Clean · CI failed'
  return `${text}${result.notPostedReason === null ? '' : postNotes[result.notPostedReason] ?? ''}${byHand}`
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

const updateSummary = (result: UpdateResult): UpdateSummary => ({
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
})

const agentResult = (result: RunResultJson | null): AgentResult | null => {
  if (result?.schema === 'pit-crew/fix-result@1') return fixSummary(result)
  if (result?.schema === 'pit-crew/update-result@1') return updateSummary(result)
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

// the heads a finished run's outcome is about: the commit a review read; the head a fix or an update pushed, and the head it read, since the cached row keeps that one until the PR is next fetched. Empty when the run stopped first, so its outcome stands
const standingShas = (run: Run): string[] => {
  const result = run.result
  if (result?.schema === 'pit-crew/review-result@1') return result.reviewed === null ? [] : [result.reviewed.sha]
  if (result?.schema === 'pit-crew/fix-result@1' || result?.schema === 'pit-crew/update-result@1') {
    return [result.pushed?.head, result.head?.sha].filter((sha) => sha !== undefined)
  }
  return []
}

// the commit the run record names as the one it read, never the PR's current head
const recordedCommit = (run: Run): string | null => {
  const result = run.result
  if (result?.schema === 'pit-crew/review-result@1') return result.reviewed?.sha ?? null
  if (result?.schema === 'pit-crew/fix-result@1' || result?.schema === 'pit-crew/update-result@1') return result.head?.sha ?? null
  return null
}

// the form a blocked run's post takes, by the rules the review prompts post under: the findings, then CI, and for Dependabot the recommendation too, as far as the cached PR and the result can tell
export const postFormOf = (result: ReviewResult, pr: RawOpenPr, config: Config): PostForm => {
  if (result.verdict === 'changesRequested') return 'requestChanges'
  const green = result.ci === 'green' || result.ci === 'none'
  if (result.command !== 'review-dependabot') return green ? 'approve' : 'comment'
  if (result.recommendation === 'approve') return green && !pr.isDraft && pr.mergeable !== 'CONFLICTING' ? 'approve' : 'comment'
  // a plain comment does not supersede an earlier approval, which would go on vouching for a version this review says not to merge
  return result.recommendation !== null && viewerReview(pr, config)?.state === 'APPROVED' ? 'requestChanges' : 'comment'
}

// gh's arguments for that post: the command the worker would have run, with the repository named, since Pit View's own gh runs in no clone
export const postArgs = (repo: string, number: number, form: PostForm, bodyFile: string): string[] => {
  if (form === 'comment') return ['pr', 'comment', String(number), '--repo', repo, '--body-file', bodyFile]
  return ['pr', 'review', String(number), '--repo', repo, form === 'approve' ? '--approve' : '--request-changes', '--body-file', bodyFile]
}

// what Post it would do, for the confirmation; the server judges a click by this same function, against the cache as it is then
export type PostOffer = {
  runId: number
  form: PostForm
  // the saved report's file name and its path written with ~
  report: string
  reportPath: string
  // the full head the review read, which is the PR's head
  headSha: string
  repo: string
  viewer: string
  // the command as the confirmation shows it
  command: string
}

// a blocked post stays open to Post it only for the run's own PR, at the head it reviewed, while the viewer has not reviewed that head some other way, with the report it finished with on record and no post begun. The run's own command and flags decide whether it may post at all; its result only names what there is to post, and each thing it names is checked against the run and the config
export const postOffer = (pr: RawOpenPr, config: Config, run: Run | undefined): PostOffer | null => {
  if (run === undefined || run.status !== 'done' || run.command === 'review-dependabot-sweep' || !mayPost(run.command, run.args) || isMine(pr, config)) return null
  if (run.reportHash === null || run.postAttemptedAt !== null) return null
  const result = run.result
  if (result?.schema !== 'pit-crew/review-result@1' || result.notPostedReason !== 'postBlocked' || result.posted !== null || result.verdict === null) return null
  const target = result.target
  if (run.repo !== config.repo || run.number !== pr.number || target === null || !('pr' in target) || target.pr !== run.number || target.repo.toLowerCase() !== config.repo.toLowerCase()) return null
  // only the file the prompts write for this PR, in the folder they write it to: the name comes from the run's number, never from the result
  const report = prReportName(run.number)
  const reportPath = `${config.reportsDir.replace(/\/$/, '')}/${report}`
  if (result.report !== reportPath) return null
  const sha = result.reviewed?.sha
  const head = pr.headRefOid
  if (!isFullSha(sha) || sha.toLowerCase() !== head.toLowerCase()) return null
  const review = viewerReview(pr, config)
  if (review?.commit?.oid === head && (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED')) return null
  const form = postFormOf(result, pr, config)
  return { runId: run.id, form, report, reportPath, headSha: head.toLowerCase(), repo: config.repo, viewer: config.viewer, command: `gh ${postArgs(config.repo, run.number, form, reportPath).join(' ')}` }
}

// a blocked post that was begun and is not on record may or may not have landed, which is what ghFailed says, so the run reads that way; the row keeps what its result said
const withPostFate = (run: Run): Run => {
  const result = run.result
  return run.postAttemptedAt !== null && result?.schema === 'pit-crew/review-result@1' && result.notPostedReason === 'postBlocked' ? { ...run, result: { ...result, notPostedReason: 'ghFailed' } } : run
}

export const agentCell = (pr: RawOpenPr, config: Config, run: Run | undefined, report: ReportInfo | undefined, stack: Stack | null = null, queueing: Queueing | null = null): AgentCell => {
  const mine = isMine(pr, config)
  const plan = defaultRun(pr, config)
  // the button's text; the run's own label is unchanged
  const action: AgentAction = { ...plan, label: queueing !== null && reviewCommands.includes(plan.command) && queueing[slotOf(pr, config)] ? queueText(plan.label) : plan.label, runner: config.agent.runner }
  const lastReviewAt = mine ? report?.at ?? null : viewerReview(pr, config)?.submittedAt ?? null
  const idle: AgentCell = {
    state: 'idle', label: plan.label, action, starts: startOptions(pr, config, stack, run?.status === 'running' || run?.status === 'queued', queueing), lastReviewAt,
    runId: null, runner: null, command: null, args: null, status: null, startedAt: null, lastStepAt: null, step: null,
    steps: emptySteps(), tandem: false, commit: null,
    finishedAt: null, text: null, result: null, question: null, note: null, resolvedByHand: false, firstNote: null, resume: null, costUsd: null, postOffer: null,
  }
  if (run === undefined) return idle
  const shas = standingShas(run)
  const head = pr.headRefOid.toLowerCase()
  let state: AgentCell['state'] = 'done'
  if (run.status === 'running' || run.status === 'queued') state = run.status
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
    commit: recordedCommit(run),
    finishedAt: run.finishedAt,
    text: run.status === 'running' || run.status === 'queued' ? null : doneText(withPostFate(run), mine && pr.isDraft),
    result: agentResult(withPostFate(run).result),
    question: run.status === 'needsInput' ? run.result?.question ?? null : null,
    note: run.note,
    resolvedByHand: run.resolvedByHand,
    firstNote: run.firstNote,
    resume: run.resume,
    costUsd: run.costUsd,
    postOffer: postOffer(pr, config, run),
  }
}

// a run as the API serves it: the row, with its five step slots always present and whether it was a tandem review
export type RunView = Omit<Run, 'steps'> & { steps: StepSlot[], tandem: boolean }

export const runView = (run: Run): RunView => ({ ...withPostFate(run), steps: stepsOf(run), tandem: isTandemRun(run.args) })

// the runner's stream: read by event type, never by position, and never for progress or results

export type StreamState = {
  // background tasks the latest background_tasks_changed event lists as not finished
  outstanding: number
  // tools named in the latest result event's permission_denials
  denials: string[]
  // the PRs those denials would have posted on, when every one of them is a Bash call that is one post with nothing around it; otherwise null. Claude Code's own record of what it refused, which the worker does not write
  deniedPosts: number[] | null
  costUsd: number | null
  sessionId: string | null
  // the newest line, for a noResult note
  lastEvent: string | null
}

export const emptyStream = (): StreamState => ({ outstanding: 0, denials: [], deniedPosts: null, costUsd: null, sessionId: null, lastEvent: null })

const finishedTaskStates = new Set(['completed', 'complete', 'done', 'failed', 'error', 'killed', 'stopped', 'cancelled', 'canceled'])

// the tasks an event lists, wherever its shape keeps them; a bare entry counts as running
export const outstandingTasks = (event: Record<string, unknown>): number => {
  const data = isObject(event.data) ? event.data : {}
  const list = [event.tasks, event.background_tasks, event.backgroundTasks, data.tasks].find(Array.isArray) as unknown[] | undefined
  if (list === undefined) return 0
  return list.filter((task) => !(isObject(task) && finishedTaskStates.has(String(task.status ?? task.state ?? '').toLowerCase()))).length
}

// the one command this text runs, as its words with the quotes taken off; null when a separator at its top level (&&, ||, ;, |, &, or a new line) puts anything around that command, however harmless, or when it holds anything this reader cannot follow (a quote left open, a substitution, an expansion in braces, an ANSI-C quote, a here-document, or a subshell), so that a mention inside one of those is never read as a command
const loneCommand = (command: string): string[] | null => {
  const text = command.trim()
  const words: string[] = []
  let word: string | null = null
  const endWord = (): void => {
    if (word !== null) words.push(word)
    word = null
  }
  const expands = (at: number): boolean => text[at] === '`' || (text[at] === '$' && ['(', '{', '\'', '"'].includes(text[at + 1] ?? ''))
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] as string
    if (expands(at) || char === '(' || char === ')' || (char === '<' && text[at + 1] === '<')) return null
    if (char === '\\') {
      at += 1
      if (at === text.length) return null
      // a backslash at the end of a line continues the command
      if (text[at] !== '\n') word = `${word ?? ''}${text[at]}`
    } else if (char === '\'') {
      const close = text.indexOf('\'', at + 1)
      if (close === -1) return null
      word = `${word ?? ''}${text.slice(at + 1, close)}`
      at = close
    } else if (char === '"') {
      let held = ''
      at += 1
      for (; at < text.length && text[at] !== '"'; at += 1) {
        if (expands(at)) return null
        if (text[at] === '\\') at += 1
        held += text[at] ?? ''
      }
      if (at >= text.length) return null
      word = `${word ?? ''}${held}`
    } else if (char === '#' && word === null) {
      // a note runs to the end of the line, and a line after it is another command
      const end = text.indexOf('\n', at)
      if (end !== -1) return null
      break
    } else if (char === '&' && (text[at - 1] === '>' || text[at - 1] === '<' || text[at + 1] === '>')) {
      // a redirect such as 2>&1 or &>file, not a separator
      word = `${word ?? ''}${char}`
    } else if (char === ';' || char === '|' || char === '&' || char === '\n') {
      return null
    } else if (/\s/.test(char)) {
      endWord()
    } else {
      word = `${word ?? ''}${char}`
    }
  }
  endWord()
  return words
}

// the PR one command posts on: gh pr review <n> or gh pr comment <n>, the form the prompts write, after any variables set for it; null for anything else
const postedPr = (words: readonly string[]): number | null => {
  const [gh, pr, verb, number] = words.slice(words.findIndex((word) => !/^[A-Za-z_]\w*=/.test(word)))
  return gh === 'gh' && pr === 'pr' && (verb === 'review' || verb === 'comment') && /^[1-9]\d*$/.test(number ?? '') ? Number(number) : null
}

// the PR a denied call would have posted on, from its own command; null for another tool, a call with no command on record, or a command that is anything but one post, since the rest of a compound call was refused too and is not this reader's to wave through
const deniedPostOf = (denial: unknown): number | null => {
  if (!isObject(denial) || !isObject(denial.tool_input) || (denial.tool_name ?? denial.toolName) !== 'Bash') return null
  const command = denial.tool_input.command
  if (typeof command !== 'string') return null
  const words = loneCommand(command)
  return words === null ? null : postedPr(words)
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
  const posts = denials.map(deniedPostOf)
  next.deniedPosts = posts.length > 0 && posts.every((pr) => pr !== null) ? posts as number[] : null
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
  // every denial was this run's own post, from the stream
  postDenied?: boolean
  // the run's own command and flags allow a post
  mayPost?: boolean
  lastEvent: string | null
}

export type Judgement = { status: Exclude<RunStatus, 'running'>, note: string | null, result: RunResultJson | null }

const exitText = (exit: Exit | null): string => {
  if (exit === null || (exit.code === null && exit.signal === null)) return 'exit code unknown'
  return exit.signal === null ? `exit code ${exit.code}` : `killed by ${exit.signal}`
}

// a review that finished, with only its post refused: done, whatever the worker made of the refusal, since nothing waits on an answer and nothing failed. Null when any part of the review is missing, when the result says it was never going to post, or when it says a post ran and failed, since that post may have landed whatever was refused after it
const blockedPost = (value: RunResultJson, reportExists: boolean | null): ReviewResult | null => {
  if (value.schema !== 'pit-crew/review-result@1' || value.verdict === null || value.reviewed === null || value.report === null || value.posted !== null || reportExists !== true) return null
  if (value.notPostedReason === 'noPost' || value.notPostedReason === 'ownPr' || value.notPostedReason === 'ghFailed') return null
  return { ...value, status: 'done', notPostedReason: 'postBlocked', question: null }
}

export const judge = (input: JudgeInput): Judgement => {
  const result = input.parsed?.ok === true ? input.parsed.value : null
  if (input.stopped) return { status: 'stopped', note: null, result }
  if (input.exit?.error != null) return { status: 'failed', note: `spawnFailed: ${input.exit.error}`, result }
  // a denied post leaves a finished review standing, but only on a run allowed to post, and only when the post is all that was denied
  if (input.denials.length > 0 && input.postDenied === true && input.mayPost === true && input.parsed?.ok === true) {
    const blocked = blockedPost(input.parsed.value, input.reportExists)
    if (blocked !== null) return { status: 'done', note: null, result: blocked }
  }
  // a denied tool call never passes silently, whatever result.json says
  if (input.denials.length > 0) return { status: 'failed', note: `permissionDenied: ${[...new Set(input.denials)].join(', ')}`, result }
  if (input.parsed === null && input.restarted) return { status: 'failed', note: 'serverRestarted', result: null }
  if (input.parsed === null || !input.parsed.ok) {
    const why = input.parsed === null ? 'no result.json' : input.parsed.error
    return { status: 'failed', note: `noResult: ${why}; ${exitText(input.exit)}; last event: ${input.lastEvent ?? 'none'}`, result: null }
  }
  const value = input.parsed.value
  const mismatch = value.schema === 'pit-crew/fix-result@1' ? fixMismatch(value) : value.schema === 'pit-crew/update-result@1' ? updateMismatch(value) : null
  if (mismatch !== null) return { status: 'failed', note: `badResult: ${mismatch}`, result: value }
  if (value.status === 'failed') return { status: 'failed', note: value.error, result: value }
  // a worker that recorded the refusal itself and stopped to ask about it is read the same way
  if (value.status === 'needsInput' && value.schema === 'pit-crew/review-result@1' && value.notPostedReason === 'postBlocked' && input.mayPost === true) {
    const blocked = blockedPost(value, input.reportExists)
    if (blocked !== null) return { status: 'done', note: null, result: blocked }
  }
  if (value.status === 'needsInput') return { status: 'needsInput', note: null, result: value }
  const path = reportPath(value)
  // a sweep with nothing to sweep writes no summary and is still done, and an update writes no report at all
  const reportless = value.schema === 'pit-crew/update-result@1' || (value.schema === 'pit-crew/sweep-result@1' && value.counts !== null && value.counts.swept === 0)
  if (path === null && !reportless) {
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

// the part of a child process the system spawn uses
export type ChildHandle = {
  pid?: number | undefined
  stdin: { write: (text: string) => unknown, end: () => unknown, on: (event: 'error', listener: (error: Error) => void) => unknown } | null
  once: ((event: 'error', listener: (error: Error) => void) => unknown) & ((event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void) => unknown)
  unref: () => unknown
}

// what the system spawn calls on the operating system: opening and closing a run's output files, and starting the process
export type SpawnPrimitives = {
  open: (path: string) => number
  close: (fd: number) => void
  spawn: (command: string, args: string[], options: { cwd: string, env: Record<string, string>, detached: true, stdio: ['pipe' | 'ignore', number, number] }) => ChildHandle
}

// detached in its own process group, its output in files: restarting the server does not end it. Once the process has started, nothing here throws, so it is always handed back to be watched: a descriptor that refuses to close is only a leaked descriptor
export const spawnWith = (primitives: SpawnPrimitives): Spawn => (request) => {
  const closeAll = (fds: number[]): void => {
    for (const fd of fds) {
      try {
        primitives.close(fd)
      } catch {
        // the process, if one started, matters more than the descriptor
      }
    }
  }
  const out = primitives.open(request.stdoutPath)
  let err: number
  try {
    err = primitives.open(request.stderrPath)
  } catch (error) {
    closeAll([out])
    throw error
  }
  let child: ChildHandle
  try {
    child = primitives.spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      detached: true,
      stdio: [request.stdin, out, err],
    })
  } finally {
    closeAll([out, err])
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

export const systemSpawn: Spawn = spawnWith({
  open: (path) => openSync(path, 'a'),
  close: closeSync,
  spawn: (command, args, options) => spawnChild(command, args, options),
})

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

// the cap on concurrent reviews (section 8 of DESIGN.md, Launching runs, Review cap)

// the review commands: only their runs count against the cap and wait in its queue; a fix or update session and a sweep do neither
export const reviewCommands: readonly string[] = ['review-pr', 'review-dependabot', 'review-stack']

// a review of the viewer's own PR is a self-review; a tandem review is one run, so it takes one slot like any review
export type ReviewSlot = 'review' | 'selfReview'

// whether a new review of each kind would wait in the queue now: the one answer the launcher's start acts on, and the Agent cell's and the drawer's buttons say
export type Queueing = Record<ReviewSlot, boolean>

// whether one more review may start beside those in flight: the reviews in flight, not counting one self-review while the setting lets one go over the cap, never number more than the cap
export const reviewFits = (inFlight: readonly ReviewSlot[], next: ReviewSlot, cap: number, selfReviewOverCap: boolean): boolean => {
  const after = [...inFlight, next]
  const over = selfReviewOverCap && after.includes('selfReview') ? 1 : 0
  return after.length - over <= cap
}

// the launcher

export type LaunchErrorCode =
  | 'noClone' | 'notAClone' | 'identityMismatch' | 'identityUnknown' | 'busy' | 'unknownRun' | 'notRunning' | 'tandemRunner' | 'fixRunner' | 'updateRunner' | 'notRereadable' | 'rereadRefused'

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

// the actions that start the Update session, and the label each run carries: Resolve conflicts is the same session, asked for on a conflicting PR
export type UpdateAction = 'update' | 'resolveConflicts'
const updateLabels: Readonly<Record<UpdateAction, string>> = { update: 'Update branch', resolveConflicts: 'Resolve conflicts' }

// the Update session (section 9 of DESIGN.md, Direct actions): update-pr with Claude, given the full head SHA the confirmation showed, which the command takes as its lease, so a push made since the confirmation is never overwritten
export const updateRequest = (repo: string, number: number, headSha: string, action: UpdateAction = 'update'): StartRequest => ({
  repo, number, command: 'update-pr', args: [String(number), `--head=${headSha}`], label: updateLabels[action], runner: 'claude',
})

// a map of what holds a slot that tells whoever owns it each time an entry is taken or released, so no path can change the cap's accounting silently
class Moving<V> extends Map<number, V> {
  readonly #moved: () => void

  constructor(moved: () => void) {
    super()
    this.#moved = moved
  }

  override set(key: number, value: V): this {
    super.set(key, value)
    this.#moved()
    return this
  }

  override delete(key: number): boolean {
    const had = super.delete(key)
    if (had) this.#moved()
    return had
  }
}

export type Launcher<T extends Session = Run> = {
  // identity, clone and one-per-PR checks, then the run directory, request.json and the spawn
  start: (request: StartRequest) => Promise<T>
  // SIGTERM to the run's group now, SIGKILL to every descendant's group after the grace period
  stop: (id: number) => T
  // the owner's re-read of a failed or waiting run's folder (section 8, Re-reading a result): the new result.json replaces the recorded outcome when it passes every guard, and a refusal changes nothing
  reread: (id: number) => Promise<T>
  // marks a run as having begun its post, or takes the mark off
  markPost: (id: number, posting: boolean) => void
  // records the post Post it made for a blocked run; a sweep has none
  recordPost: (id: number, posted: Posted) => T
  // at server start: re-watch live runs, settle the rest, and fail what was still queued, since a start of the server starts nothing
  recover: () => Promise<void>
  // reads the queue again, earliest first, as far as the first review that does not fit; the server calls it after a saved config, which may have raised the cap
  drain: () => void
  // reads every watched run's files now
  check: () => Promise<void>
  // resolves once the run has settled
  settled: (id: number) => Promise<T>
  // whether a new review of each kind would wait in the queue now, by the rule a start acts on
  queueing: () => Queueing
  // resolves once the pending announcement of the queue answer, if any, has been made; a test awaits it instead of sleeping
  flushed: () => Promise<void>
  // stops watching; runs keep going
  close: () => void
}

// a run directory Pit View cannot write is refused before the runner starts, so a folder the
//  filesystem forbids names its own failure instead of settling later as an unreadable noResult:
//  the probe is the same write the command makes to events.jsonl, and it leaves nothing behind
export const probeRunDir = async (dir: string, fs: Pick<LauncherFs, 'writeFile' | 'rm'>): Promise<void> => {
  const probe = join(dir, '.write-probe')
  await fs.writeFile(probe, '')
  await fs.rm(probe)
}

// raised by the probe, and by nothing else on the start path, so the failure keeps its own note
export class UnwritableRunDir extends Error {
  readonly dir: string
  readonly reason: unknown
  constructor(dir: string, reason: unknown) {
    super(`cannot write ${dir}`)
    this.dir = dir
    this.reason = reason
  }
}

export type LauncherOptions<T extends Session = Run> = {
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
  // runs live in <stateDir>/runs/<id>, sweeps in <stateDir>/sweeps/<id>
  stateDir: string
  // the environment the child's few variables are picked from
  env: Readonly<Record<string, string | undefined>>
  newSessionId: () => string
  // a run is now this process's to watch: created here (even one whose start fails at once) or adopted at startup because it was still running; called before its first onChange
  onWatch: (run: T) => void
  // a run's row changed: started, stepped, or settled
  onChange: (run: T) => void
  // the launcher's answer to whether a new review would wait changed, for any run in any repository: sent once per change of the answer, after the change that moved it
  onQueueing?: () => void
  // rows the cache pruned, called as soon as they are gone from the table and before their folders are removed, so what holds the rows in memory can drop them too
  onPruned?: (gone: T[]) => void
  log?: (line: string) => void
  // how often a run's files are read when the folder cannot be watched, and the safety
  // net when it can; a recovered run's liveness is checked as often
  pollMs?: number
  watchedPollMs?: number
  stopGraceMs?: number
}

// where a launcher keeps what it launches. Review runs live in the runs table, one in flight per PR; sweeps in the sweeps table, one in flight per repository. Everything else about launching is shared
export type SessionStore<T extends Session> = {
  // the folder under the state folder and the word the logs and messages use
  folder: 'runs' | 'sweeps'
  noun: 'run' | 'sweep'
  create: (request: StartRequest, fields: NewSweep, dirOf: (id: number) => string) => T
  get: (id: number) => T | null
  update: (id: number, changes: RunChanges) => T
  running: () => T[]
  prune: () => T[]
  // what holds a start to one in flight: the PR for a run and the repository for a sweep
  key: (target: { repo: string, number?: number }) => string
  inFlight: (request: StartRequest) => boolean
  busyText: (request: StartRequest) => string
  // the schema result.json must carry, when the kind of launch fixes it
  schema: SweepResult['schema'] | null
  // the slot a launch takes under the cap on concurrent reviews, or null for one the cap does not cover
  slot: (target: { repo: string, number?: number, command: string }, config: Config) => ReviewSlot | null
  // rows still waiting in the queue, which a restart fails
  queued: () => T[]
}

// one run being watched
type Live = {
  id: number
  // its row as it was watched, which a settle whose read of the row is refused judges it by
  row: Session
  // the slot it holds under the cap, if any
  slot: ReviewSlot | null
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

// the runs table's store: one run in flight per PR
export const runStore = (cache: Cache): SessionStore<Run> => ({
  folder: 'runs',
  noun: 'run',
  create: (request, fields, dirOf) => cache.createRun({ ...fields, number: request.number } satisfies NewRun, dirOf),
  get: cache.getRun,
  update: cache.updateRun,
  running: cache.runningRuns,
  prune: cache.pruneRuns,
  key: (request) => `${request.repo}#${request.number}`,
  // a queued review holds its PR as a running one does
  inFlight: (request) => ['running', 'queued'].includes(cache.runsFor(request.repo, request.number, 1)[0]?.status ?? ''),
  busyText: (request) => `a run for #${request.number} is already in flight`,
  schema: null,
  // a self-review is a review of a PR the cache holds as the viewer's own open PR
  slot: (target, config) => {
    if (!reviewCommands.includes(target.command)) return null
    const pr = cache.readView(target.repo).open.find((entry) => entry.number === target.number)?.pr
    return pr !== undefined ? slotOf(pr, config) : 'review'
  },
  queued: cache.queuedRuns,
})

// the sweeps table's store: one sweep in flight per repository and a result.json that must carry the sweep result schema
export const sweepStore = (cache: Cache): SessionStore<Sweep> => ({
  folder: 'sweeps',
  noun: 'sweep',
  create: (_request, fields, dirOf) => cache.createSweep(fields, dirOf),
  get: cache.getSweep,
  update: cache.updateSweep,
  running: cache.runningSweeps,
  prune: cache.pruneSweeps,
  key: (request) => request.repo,
  inFlight: (request) => cache.sweepsFor(request.repo, 1)[0]?.status === 'running',
  busyText: (request) => `a sweep for ${request.repo} is already in flight`,
  schema: 'pit-crew/sweep-result@1',
  // a sweep is not a review run: one per repository is its only limit
  slot: () => null,
  queued: () => [],
})

// the review runs' launcher and the sweeps' launcher are the one engine over two stores
// the delays before each retry of a queue announcement the listener failed, so a flush is tried at most one more time than there are delays
const QUEUE_RETRY_MS = [50, 200, 800]

export const createLauncher = (options: LauncherOptions): Launcher => createEngine(options, runStore(options.cache))

export const createSweepLauncher = (options: LauncherOptions<Sweep>): Launcher<Sweep> => createEngine(options, sweepStore(options.cache))

const createEngine = <T extends Session>(options: LauncherOptions<T>, store: SessionStore<T>): Launcher<T> => {
  const { gh, git, spawn, fs, kill, procs, clock, timers, home, onChange, onWatch } = options
  const noun = store.noun
  // a log line that cannot be written is dropped: logging sits on the paths that keep a process watched and a slot released, so it must never throw there
  const log = (line: string): void => {
    try {
      options.log?.(line)
    } catch {
      // nowhere left to tell it
    }
  }
  const pollMs = options.pollMs ?? 1000
  const watchedPollMs = options.watchedPollMs ?? 10_000
  const stopGraceMs = options.stopGraceMs ?? 10_000
  const runsDir = resolve(options.stateDir, store.folder)
  // every place the cap's accounting moves is one of these three, so no path can take or release a slot without marking: the watched runs, the slots held for launches in progress, and (through lineAdd, lineRemove, and opened below) the queue and the count of launches in progress
  const live = new Moving<Live>(() => mark())
  const waiters = new Map<number, ((run: T) => void)[]>()
  // runs between their running row and their watch, each with whether a stop was asked meanwhile; the stop is carried out once the process is watched
  const launching = new Map<number, boolean>()
  // starts between their checks and their row
  const starting = new Set<string>()
  // reviews waiting for a slot under the cap, in the order they were queued, each with its row as it was queued, the viewer its start was confirmed for, the attempt that holds a slot for it while its checks run, and the clone folder those checks confirmed once they pass; it stays here until it is launched, so a save and a Stop still find it
  type Queued = { id: number, run: T, request: StartRequest, viewer: string, attempt: number | null, checked: string | null }
  const queue: Queued[] = []
  // slots given to reviews whose process is not watched here yet, each held by an attempt of its own, so two quick starts never both take the last slot and an attempt that ends releases only its own
  const admitting = new Moving<ReviewSlot>(() => mark())
  let attempts = 0
  // reviews being launched, new or from the queue, whose launch has not returned yet; none that arrived behind them starts until it has, so reviews spawn in the order they arrived
  let opening = 0
  // the turn of the review that arrived last, ended once it and every review ahead of it have had their fit decided or been refused
  let arrivals: Promise<unknown> = Promise.resolve()
  // runs that ended here whose ending could not be written, each as it ended, for whoever awaits it; the row still reads queued or running until a Stop records it or the next server start settles it
  const unrecorded = new Map<number, T>()
  let closed = false

  const now = (): string => iso(clock.now())
  // the page is told of a change; a listener that throws is logged and never keeps a run from being watched, ended, or woken, or its slot from being released
  const changed = (run: T): void => {
    if (closed) return
    try {
      onChange(run)
    } catch (error) {
      log(`${noun} ${run.id}: cannot announce its change: ${messageOf(error)}`)
    }
    mark()
  }

  // the queue answer may have changed: the running count, the queue, or the launches in progress moved, or a run changed. It only marks; one flush on a later turn of the event loop tells the listener, however many marks came before it, and the listener reads the answer itself, so nothing here remembers what any page received
  let flushHandle: ReturnType<typeof setImmediate> | null = null
  let flushWaiters: (() => void)[] = []
  // a flush whose listener threw is marked again after one of these delays, so a transient failure does not leave open pages on the old label; a new mark in the meantime takes the retry's place, and the run of failures ends at the first success or the last delay
  let retryHandle: unknown = null
  let failures = 0
  const flush = (): void => {
    flushHandle = null
    if (!closed && options.onQueueing !== undefined) {
      try {
        options.onQueueing()
        failures = 0
      } catch (error) {
        failures += 1
        log(`${noun}: cannot announce the queue answer (attempt ${failures} of ${QUEUE_RETRY_MS.length + 1}): ${messageOf(error)}`)
        const delay = QUEUE_RETRY_MS[failures - 1]
        if (delay === undefined) {
          log(`${noun}: giving up on announcing the queue answer; labels may stay stale until the next event`)
          failures = 0
        } else {
          retryHandle = timers.set(() => {
            retryHandle = null
            mark()
          }, delay)
        }
      }
    }
    const waiting = flushWaiters
    flushWaiters = []
    for (const resume of waiting) resume()
  }
  const mark = (): void => {
    if (closed || options.onQueueing === undefined || flushHandle !== null) return
    if (retryHandle !== null) {
      timers.clear(retryHandle)
      retryHandle = null
    }
    flushHandle = setImmediate(flush)
  }
  // resolves once the flush that is pending, if any, has run
  const flushed = (): Promise<void> => flushHandle === null ? Promise.resolve() : new Promise((resumeFlush) => flushWaiters.push(resumeFlush))

  // the queue and the count of launches in progress change only through these, so each marks
  const lineAdd = (item: Queued): void => {
    queue.push(item)
    mark()
  }
  const lineRemove = (item: Queued): void => {
    const at = queue.indexOf(item)
    if (at < 0) return
    queue.splice(at, 1)
    mark()
  }
  const opened = (by: number): void => {
    opening += by
    mark()
  }

  // the page is told a run is watched here; as for a change, a listener that throws is only logged
  const watching = (run: T): void => {
    if (closed) return
    try {
      onWatch(run)
    } catch (error) {
      log(`${noun} ${run.id}: cannot announce that it is watched: ${messageOf(error)}`)
    }
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
    let run = store.get(entry.id)
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
    run = store.update(entry.id, changes)
    changed(run)
  }

  const pumpOf = (entry: Live): Promise<void> => {
    entry.pump = entry.pump.then(() => readNew(entry)).catch((error: unknown) => log(`${noun} ${entry.id}: cannot read its files: ${messageOf(error)}`))
    return entry.pump
  }

  const specFor = async (run: Pick<Session, 'command' | 'args' | 'cwd' | 'sessionId'>, dir: string): Promise<LaunchSpec> => {
    const config = options.config()
    return {
      command: run.command,
      args: run.args,
      cwd: expandHome(run.cwd, home),
      runDir: dir,
      home,
      sessionId: run.sessionId,
      claudeModel: config.agent.claudeModel,
      ...(config.agent.codexModel === undefined ? {} : { codexModel: config.agent.codexModel }),
      reportsDir: await resolved(join(home, 'agents', 'output')),
      worktreesDir: await resolved(join(home, 'agents', 'worktrees')),
    }
  }

  const resumeFor = (run: Pick<Session, 'runner' | 'cwd'>, sessionId: string, spec: LaunchSpec): string =>
    runners[run.runner].resume(run.cwd, sessionId, spec, home)

  const clear = (entry: Live): void => {
    entry.watcher?.close()
    entry.watcher = null
    if (entry.timer !== null) timers.clear(entry.timer)
    entry.timer = null
    if (entry.killTimer !== null) timers.clear(entry.killTimer)
    entry.killTimer = null
  }

  // the slots the reviews in flight hold: those watched here and those given a slot that no watched process holds yet, each counted once, since a launch releases its attempt's slot as it is watched
  const reviewsInFlight = (): ReviewSlot[] => [...admitting.values(), ...[...live.values()].flatMap((entry) => entry.slot === null ? [] : [entry.slot])]

  const fits = (slot: ReviewSlot, config: Config): boolean => reviewFits(reviewsInFlight(), slot, config.maxConcurrentReviews, config.selfReviewOverCap)

  // whether a new review of this kind waits: with a review ahead of it in the queue or still being launched, or without room under the cap. A start acts on this and nothing else, and the page's buttons say it
  const waits = (slot: ReviewSlot, config: Config): boolean => queue.length > 0 || opening > 0 || !fits(slot, config)

  const queueing = (): Queueing => {
    const config = options.config()
    return { review: waits('review', config), selfReview: waits('selfReview', config) }
  }

  // a queued review's fit counts every review in flight and the slots held for reviews ahead of it in line, never its own or one behind it, so when a lowered cap leaves too many slots held it is always a later review that gives its slot back
  const fitsInLine = (item: Queued, slot: ReviewSlot, config: Config): boolean => {
    const behind = new Set(queue.slice(queue.indexOf(item)).flatMap((entry) => entry.attempt === null ? [] : [entry.attempt]))
    const counted = [...admitting].flatMap(([attempt, held]) => behind.has(attempt) ? [] : [held])
    const watched = [...live.values()].flatMap((entry) => entry.slot === null ? [] : [entry.slot])
    return reviewFits([...counted, ...watched], slot, config.maxConcurrentReviews, config.selfReviewOverCap)
  }

  // holds a slot for one attempt to start a review; a caller tests the fit with nothing awaited between that and this
  const reserve = (slot: ReviewSlot): number => {
    attempts += 1
    admitting.set(attempts, slot)
    return attempts
  }

  // why a review confirmed for one repository and viewer may not start under this config, or null when both still hold: it would act where, or as whom, the confirmation did not say
  const unbound = (repo: string, viewer: string, config: Config): string | null => {
    if (repo !== config.repo) return `the repository is now ${config.repo}, not ${repo}`
    return viewer.toLowerCase() !== config.viewer.toLowerCase() ? `the viewer is now ${config.viewer}, not ${viewer}` : null
  }

  const wake = (id: number, run: T): void => {
    for (const resolveWaiter of waiters.get(id) ?? []) resolveWaiter(run)
    waiters.delete(id)
  }

  // a run's ending written to its row, the write tried twice since the database may refuse it, and whoever awaits the run given the ending either way. When both tries fail the run still ends here: it is given as ended to whoever awaits it, its caller releases its slot and its place in the queue, and its row keeps reading as it did (queued or running) until a Stop records it or the next server start settles it
  const end = (run: T, changes: RunChanges, what: string): T => {
    const write = (): T | null => {
      try {
        return store.update(run.id, changes)
      } catch (failure) {
        log(`${noun} ${run.id}: cannot record that it ${what}: ${messageOf(failure)}`)
        return null
      }
    }
    const recorded = write() ?? write()
    if (recorded === null) {
      const ended = { ...run, ...changes } as T
      unrecorded.set(run.id, ended)
      log(`${noun} ${run.id}: ${what}, but its row stays ${run.status} until a Stop records it or the server restarts`)
      wake(run.id, ended)
      return ended
    }
    unrecorded.delete(run.id)
    changed(recorded)
    wake(run.id, recorded)
    return recorded
  }

  // a queued review that will never start is recorded as failed to start, with the reason
  const failQueued = (run: T, note: string): void => {
    log(`${noun} ${run.id}: queued, not started: ${note}`)
    end(run, { status: 'failed', finishedAt: now(), note }, 'failed in the queue')
  }

  // ends the attempt to start a queued review, with the slot it held and the checks it passed, so it makes them again when it is next given a slot
  const giveBack = (item: Queued): void => {
    if (item.attempt !== null) admitting.delete(item.attempt)
    item.attempt = null
    item.checked = null
  }

  // takes a review out of the queue, and releases the slot an attempt to start it held
  const dequeue = (item: Queued): void => {
    lineRemove(item)
    giveBack(item)
  }

  // a review that does not fit holds the line, however long that lasts, so none behind it keeps a slot or waits on checks passed long ago
  const holdLine = (item: Queued): void => {
    for (const behind of queue.slice(queue.indexOf(item) + 1)) giveBack(behind)
  }

  // a queued review that will never start, never to be tried again: its row is recorded as failed before it leaves the queue and its slot is released, so the row, the queue, the slot, and its waiters change together. A record that fails twice, the database unwritable, leaves the row queued for the next server start to fail as serverRestarted, while the review still leaves the queue here and whoever awaits it is given it as failed
  const failInQueue = (item: Queued, note: string): void => {
    failQueued(item.run, note)
    dequeue(item)
  }

  // reads the queue earliest first: gives a slot to each review that fits now, which then makes its checks in the background, still in the queue, and launches each whose checks have passed once no review ahead of it is still making its checks or being launched. The first that does not fit ends the reading and holds the line, the over-cap allowance included, so reviews start in the order they arrived
  const admit = (): void => {
    if (closed) return
    const config = options.config()
    for (const item of [...queue]) {
      const why = unbound(item.request.repo, item.viewer, config)
      if (why !== null) failInQueue(item, `spawnFailed: not started: ${why}`)
    }
    let heldBack = opening > 0
    for (const item of [...queue]) {
      // one taken out of the queue since this pass began is skipped
      if (!queue.includes(item)) continue
      if (item.attempt !== null) {
        // one whose checks are running holds its slot, and holds back every one behind it
        if (item.checked === null || heldBack) {
          heldBack = true
          continue
        }
        proceed(item, item.attempt, item.checked)
        // one that gave its slot back no longer fits, and still holds its place ahead of every one behind it
        if (queue.includes(item)) {
          holdLine(item)
          return
        }
        heldBack ||= opening > 0
        continue
      }
      let slot: ReviewSlot | null
      try {
        // whether it is a self-review is read from the cache now, as it is about to start
        slot = store.slot(item.request, config)
      } catch (error) {
        // an unexpected failure, such as a cache read that throws, fails the queued review with the error rather than leaving it in line to fail again
        failInQueue(item, `spawnFailed: ${messageOf(error)}`)
        continue
      }
      if (slot === null || !fitsInLine(item, slot, config)) {
        holdLine(item)
        return
      }
      const attempt = reserve(slot)
      item.attempt = attempt
      heldBack = true
      void begin(item, attempt).catch((error: unknown) => log(`${noun} ${item.id}: cannot start from the queue: ${messageOf(error)}`))
    }
  }

  // a queued review's checks, the ones every start makes, while it stays in the queue; once they pass it keeps its slot and waits for the reviews ahead of it, which the queue's next reading launches it after
  const begin = async (item: Queued, attempt: number): Promise<void> => {
    // false once a Stop or a failure ended this attempt
    const ours = (): boolean => !closed && item.attempt === attempt && queue.includes(item)
    try {
      const checked = options.config()
      await checkIdentity(checked)
      const cloneDir = await checkClone(checked)
      if (ours()) item.checked = cloneDir
    } catch (error) {
      if (ours()) failInQueue(item, `spawnFailed: ${messageOf(error)}`)
    }
    // the queue is read again however the checks went: this one may be next to start, and one that failed hands its slot on
    admit()
  }

  // a queued review whose checks passed and that nothing ahead of it holds back: the fit test again under the config and the cache as they are now, with nothing awaited between the reading and the slot held or given back, then the same launch, on the row it already has
  const proceed = (item: Queued, attempt: number, cloneDir: string): void => {
    let config: Config
    let slot: ReviewSlot | null
    try {
      if (store.get(item.id) === null) throw new Error('its row is gone')
      config = options.config()
      const why = unbound(item.request.repo, item.viewer, config)
      if (why !== null) {
        failInQueue(item, `spawnFailed: not started: ${why}`)
        return
      }
      slot = store.slot(item.request, config)
    } catch (error) {
      // an unexpected failure, such as a cache read that throws, fails the review, so it is never left in line holding an attempt nothing will finish, nor retried to fail again
      failInQueue(item, `spawnFailed: ${messageOf(error)}`)
      return
    }
    if (slot === null || !fitsInLine(item, slot, config)) {
      // it no longer fits: it gives its slot back and waits again, in its place in line
      giveBack(item)
      return
    }
    admitting.set(attempt, slot)
    const cwd = item.request.cwd ?? cloneDir
    let run: T
    try {
      // its row says running before it leaves the queue, so a write that fails leaves the two as they were, for it to fail in the queue
      run = store.update(item.id, { status: 'running', startedAt: now(), cwd: tildePath(cwd, home) })
    } catch (error) {
      failInQueue(item, `spawnFailed: ${messageOf(error)}`)
      return
    }
    lineRemove(item)
    opened(1)
    void launchQueued(item, run, config, cwd, { slot, attempt, viewer: item.viewer })
  }

  // a queued review's launch, after which the queue is read again
  const launchQueued = async (item: Queued, run: T, config: Config, cwd: string, admitted: Admitted): Promise<void> => {
    try {
      await launch(item.request, config, cwd, run, admitted)
    } catch (error) {
      log(`${noun} ${item.id}: cannot start from the queue: ${messageOf(error)}`)
    } finally {
      opened(-1)
      admitting.delete(admitted.attempt)
      // the queue is read again however the start went: the next in line may start now, one that ended at once hands its slot on, and a run that settled before its start returned was still counted here when it settled
      admit()
    }
  }

  // the report a review finished with, recorded by its hash, so Post it can tell it from what a later run wrote to the same name. Only a run has the column, and only a review posts
  const finishedReport = async (value: RunResultJson): Promise<RunChanges> => {
    if (store.schema !== null || value.schema !== 'pit-crew/review-result@1') return {}
    const path = reportPath(value)
    const text = path === null ? null : await fs.readFile(expandHome(path, home)).catch(() => null)
    return { reportHash: text === null ? null : reportHash(text) }
  }

  const settle = async (entry: Live, exit: Exit | null, restarted: boolean): Promise<T | null> => {
    if (entry.settling || closed) return null
    entry.settling = true
    clear(entry)
    await pumpOf(entry)
    // a server shutting down leaves the run recorded as running, for recovery to find
    if (closed) return null
    const text = await fs.readFile(join(entry.dir, 'result.json')).catch(() => null)
    let parsed = text === null ? null : parseResult(text)
    // a launch of one kind takes only its own kind of result: a review's result in a sweep's folder is no result
    if (parsed?.ok === true && store.schema !== null && parsed.value.schema !== store.schema) {
      parsed = { ok: false, error: `result.json: expected ${store.schema}, found ${parsed.value.schema}` }
    }
    // a run takes only the result of its own command and of its own PR: an update's result in a review's folder, or one about another PR, is no result
    let started: Partial<Run> | null
    try {
      started = store.get(entry.id) as Partial<Run> | null
    } catch (error) {
      // a read the database refuses never keeps the run from ending: it is judged on its row as it was watched
      log(`${noun} ${entry.id}: cannot read its row to settle it, so it settles on the row it was watched with: ${messageOf(error)}`)
      started = entry.row as Partial<Run>
    }
    if (parsed?.ok === true && store.schema === null && started?.command !== undefined) {
      const found = parsed.value
      const wrong = found.schema === 'pit-crew/sweep-result@1' ? 'result.json is a sweep result, not the result of a run' : found.command !== started.command ? `result.json is for command ${found.command}, not ${started.command}` : found.target === null ? null : targetMismatch(started as T, null, found)
      if (wrong !== null) parsed = { ok: false, error: wrong }
    }
    let reportExists: boolean | null = null
    let finished: RunChanges = {}
    // any status: a blocked post leaves a finished review whose worker may have stopped to ask or failed over it
    if (parsed?.ok === true) {
      const path = reportPath(parsed.value)
      if (path !== null) reportExists = await fs.exists(expandHome(path, home)).catch(() => false)
      finished = await finishedReport(parsed.value)
    }
    const judgement = judge({
      stopped: entry.stopping,
      restarted,
      exit,
      parsed,
      reportExists,
      denials: entry.stream.denials,
      postDenied: entry.stream.deniedPosts?.every((pr) => pr === (started as Partial<Run> | undefined)?.number) ?? false,
      mayPost: started?.command !== undefined && started.args !== undefined && mayPost(started.command, started.args),
      lastEvent: entry.stream.lastEvent,
    })
    live.delete(entry.id)
    if (entry.stdinOpen && entry.child?.stdin != null) entry.child.stdin.end()
    entry.stdinOpen = false
    // the process has ended, so the run ends here even when the database refuses the write: whoever awaits it is woken and its slot is freed
    const run = end((started ?? { id: entry.id }) as unknown as T, { ...judgement, ...finished, finishedAt: now() }, `settled as ${judgement.status}`)
    log(`${noun} ${run.id} (${run.command} ${run.args.join(' ')}) ${run.status}${run.note === null ? '' : `: ${run.note}`}`)
    // a review that ended, however it ended, frees its slot for the next in line
    if (entry.slot !== null) admit()
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

  // a launched review holds the slot it was admitted with; a recovered one's is read from the cache
  const watchRun = (run: T, dir: string, child: SpawnedProcess | null, stdinOpen: boolean, spec: LaunchSpec | null, slot: ReviewSlot | null): Live => {
    const entry: Live = {
      id: run.id,
      row: run,
      slot,
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
    // counted, within Stop's reach, and settled by its exit before anything else is set up
    live.set(run.id, entry)
    if (child !== null) {
      void child.exited.then((exit) => settle(entry, exit, false)).catch((error: unknown) => log(`${noun} ${run.id}: cannot settle: ${messageOf(error)}`))
    }
    try {
      entry.watcher = fs.watch(dir, () => {
        if (!entry.settling) void pumpOf(entry)
      })
    } catch (error) {
      log(`${noun} ${run.id}: cannot watch ${tildePath(dir, home)}, polling instead: ${messageOf(error)}`)
    }
    poll(entry, entry.watcher === null ? pollMs : watchedPollMs)
    void pumpOf(entry)
    return entry
  }

  // a pruned run's folder goes with its row, and nothing outside the runs folder is ever removed
  const prune = async (): Promise<void> => {
    let pruned: T[]
    try {
      pruned = store.prune()
    } catch (error) {
      // a prune the database refuses is tried again after the next start; the start itself stands
      log(`cannot prune old ${store.folder}: ${messageOf(error)}`)
      return
    }
    if (pruned.length > 0 && !closed) options.onPruned?.(pruned)
    for (const gone of pruned) {
      const dir = resolve(expandHome(gone.dir, home))
      if (!dir.startsWith(`${runsDir}${sep}`)) {
        log(`${noun} ${gone.id}: not removing ${gone.dir}, which is outside the ${store.folder} folder`)
        continue
      }
      await fs.rm(dir).catch((error: unknown) => log(`${noun} ${gone.id}: cannot remove ${gone.dir}: ${messageOf(error)}`))
    }
  }

  const newRow = (request: StartRequest, config: Config, cwd: string, status: 'running' | 'queued'): T => {
    const runner = request.runner ?? config.agent.runner
    const sessionId = runner === 'claude' ? options.newSessionId() : null
    return store.create(request, {
      repo: request.repo,
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
      status,
      result: null,
      note: null,
      costUsd: null,
      resume: null,
    }, (id) => tildePath(join(runsDir, String(id)), home))
  }

  // request.json written whole once its process exists: a write refused, at once or later, is logged and answered with false rather than thrown, since nothing may throw while a process is not yet watched
  const writeRequest = (id: number, dir: string, contents: Record<string, unknown>): Promise<boolean> => {
    const refused = (error: unknown): boolean => {
      log(`${noun} ${id}: cannot update request.json: ${messageOf(error)}`)
      return false
    }
    try {
      return fs.writeFile(join(dir, 'request.json'), `${JSON.stringify(contents, null, 2)}\n`).then(() => true, refused)
    } catch (error) {
      return Promise.resolve(refused(error))
    }
  }

  // how a review was admitted: the slot it was given, the attempt holding that slot until its process is watched, and the viewer its start was confirmed for
  type Admitted = { slot: ReviewSlot, attempt: number, viewer: string }

  // a queued review's row already exists, was announced when it was queued, and was marked running as it left the queue; it starts now, in the folder the checks just confirmed
  const launch = async (request: StartRequest, config: Config, cwd: string, queued: T | null = null, admitted: Admitted | null = null): Promise<T> => {
    let run = queued ?? newRow(request, config, cwd, 'running')
    const runner = run.runner
    const sessionId = run.sessionId
    if (queued === null) watching(run)
    launching.set(run.id, false)
    const dir = join(runsDir, String(run.id))
    let child: SpawnedProcess
    let spec: LaunchSpec
    let record: Record<string, unknown>
    let stdin: string | null
    let resume: string | null
    try {
      await fs.mkdir(dir)
      await probeRunDir(dir, fs).catch((reason: unknown) => {
        throw new UnwritableRunDir(dir, reason)
      })
      spec = await specFor(run, dir)
      const invocation = runners[runner].invocation(spec)
      stdin = invocation.stdin
      // made before the spawn, so nothing that builds it can throw once a process exists; Codex's is written once its session id is read from the stream, so it is left out here
      resume = sessionId === null ? null : resumeFor(run, sessionId, spec)
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
      // the last thing before the spawn: a review starts only for the repository and the viewer its start was confirmed for, under the config in effect now
      const why = admitted === null ? null : unbound(request.repo, admitted.viewer, options.config())
      if (why !== null) throw new Error(`not started: ${why}`)
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
      const note = error instanceof UnwritableRunDir
        ? `permissionDenied: ${tildePath(error.dir, home)} cannot be written: ${messageOf(error.reason)}`
        : `spawnFailed: ${messageOf(error)}`
      launching.delete(run.id)
      log(`${noun} ${run.id}: cannot start: ${note}`)
      // a queued review someone awaits ends here, and so does a start whose failure the database refuses to record
      run = end(run, { status: 'failed', finishedAt: now(), note }, 'failed to start')
      await prune()
      return run
    }
    // from here the process exists: nothing is awaited and nothing may throw until it is watched, so it is never left running unwatched, uncounted, or out of Stop's reach
    const pid = child.pid
    // the pid goes to request.json first and then to the row, each write on its own, so one refused write never leaves a restart without it; the file's write is begun here and awaited only after the watch
    const pidInFile = writeRequest(run.id, dir, { ...record, pid, pidStartedAt: null })
    if (stdin !== null) {
      try {
        child.stdin?.write(stdin)
      } catch (error) {
        log(`${noun} ${run.id}: cannot write its request to stdin: ${messageOf(error)}`)
      }
    }
    let pidInRow = true
    try {
      run = store.update(run.id, { pid, ...(resume === null ? {} : { resume }) })
    } catch (error) {
      // the row keeps no pid, but the watch below has it, so Stop still signals the process and its end still settles it; the write is made again with the start time
      pidInRow = false
      log(`${noun} ${run.id}: cannot record its pid ${pid ?? 'unknown'}: ${messageOf(error)}`)
      run = { ...run, pid, resume } as T
    }
    const entry = watchRun(run, dir, child, stdin !== null && child.stdin !== null, spec, admitted?.slot ?? null)
    // the watched run holds its slot from here, so the attempt's is released at once and the slot never counts twice
    if (admitted !== null) admitting.delete(admitted.attempt)
    const stopAsked = launching.get(run.id) === true
    launching.delete(run.id)
    // carried out on the watched process itself, with no read of the row that could throw before the start time is recorded
    if (stopAsked) stopLive(entry)
    // the start time, which a restart needs to tell this process from one that reused its pid, comes after the watch, since reading it is awaited
    const pidStartedAt = pid === null ? null : await procs.startTime(pid).catch(() => null)
    try {
      // the second try at a pid and resume command the row refused at once after the spawn
      run = store.update(run.id, { ...(pidInRow ? {} : { pid, ...(resume === null ? {} : { resume }) }), pidStartedAt })
    } catch (error) {
      log(`${noun} ${run.id}: cannot record its ${pidInRow ? '' : 'pid and its '}start time: ${messageOf(error)}`)
    }
    // the second write of request.json, with the start time, made once the first has ended so the two never interleave; it is also the second try at a pid the first write did not keep
    await pidInFile
    await writeRequest(run.id, dir, { ...record, pid, pidStartedAt })
    log(`${noun} ${run.id} started: ${run.runner} ${run.command} ${run.args.join(' ')} in ${run.cwd}`)
    // a run that settled while its start time was read was announced by its settle, which this older row must not follow
    if (live.has(run.id)) changed(run)
    await prune()
    return store.get(run.id) ?? run
  }

  // a review's place in line, taken as it arrives: the wait for every review ahead of it to have its fit decided or be refused, and the end of its own turn, which the next waits for
  const takeTurn = (): { ahead: Promise<unknown>, decided: () => void } => {
    const ahead = arrivals
    let decided = (): void => {}
    const own = new Promise<void>((resolveTurn) => {
      decided = resolveTurn
    })
    // a review refused ahead of an earlier one that still makes its checks moves nothing behind it forward
    arrivals = Promise.all([ahead, own])
    return { ahead, decided }
  }

  const start = async (request: StartRequest): Promise<T> => {
    const config = options.config()
    // a tandem primary launches its secondary in the background, and the fix and update sessions are pinned to Claude; the runner is the one asked for or the configured default, so no caller gets around this
    if (claudeOnly(request.command, request.args) && (request.runner ?? config.agent.runner) !== 'claude') {
      if (isTandemRun(request.args)) throw new LaunchError('tandemRunner', 'Review in tandem runs with Claude only; send runner claude or leave it out')
      if (request.command === 'update-pr') throw new LaunchError('updateRunner', 'Update session runs with Claude only')
      throw new LaunchError('fixRunner', 'Fix session runs with Claude only; send runner claude or leave it out')
    }
    const key = store.key(request)
    // one run per PR (one sweep per repository) in flight, counting a start still between its checks and its row
    if (starting.has(key) || store.inFlight(request)) {
      throw new LaunchError('busy', store.busyText(request))
    }
    starting.add(key)
    // only reviews stand in line; a fix or update session and a sweep wait for nothing
    const turn = reviewCommands.includes(request.command) ? takeTurn() : null
    try {
      await checkIdentity(config)
      const cloneDir = await checkClone(config)
      // the checks may race, and a refusal above never waits, but a review's fit is decided in the order they arrived
      await turn?.ahead
      // a config saved during the checks is the one admission reads, and whether it is a self-review is read from the cache now, with nothing awaited before the slot is held
      const current = options.config()
      const slot = store.slot(request, current)
      if (slot === null) return await launch(request, config, request.cwd ?? cloneDir)
      // whatever already waits and fits goes first
      admit()
      // a new review starts at once only as the sole eligible start: with room, and with no review ahead of it waiting in the queue or still being launched
      if (waits(slot, current)) {
        const queued = enqueue(request, config, request.cwd ?? cloneDir)
        // a save during the checks may have left it confirmed for a repository or a viewer no longer in effect
        admit()
        return store.get(queued.id) ?? queued
      }
      const attempt = reserve(slot)
      opened(1)
      turn?.decided()
      try {
        return await launch(request, config, request.cwd ?? cloneDir, null, { slot, attempt, viewer: config.viewer })
      } finally {
        opened(-1)
        admitting.delete(attempt)
        // as for a queued start: the slot is never left counted for a run that is no longer in flight
        admit()
      }
    } finally {
      turn?.decided()
      starting.delete(key)
    }
  }

  // at the cap, or behind a review that arrived before it: the review gets its row, queued, and starts when its turn comes and a slot is free
  const enqueue = (request: StartRequest, config: Config, cwd: string): T => {
    const run = newRow(request, config, cwd, 'queued')
    lineAdd({ id: run.id, run, request, viewer: config.viewer, attempt: null, checked: null })
    watching(run)
    log(`${noun} ${run.id} queued: ${run.command} ${run.args.join(' ')}, ${reviewsInFlight().length} reviews in flight with a cap of ${config.maxConcurrentReviews}`)
    changed(run)
    return run
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
      log(`${noun} ${entry.id}: cannot list its processes: ${messageOf(error)}`)
    }
    for (const group of groups) signalGroup(group, 'SIGKILL')
  }

  const stop = (id: number): T => {
    const run = store.get(id)
    if (run === null) throw new LaunchError('unknownRun', `${noun} ${id} does not exist`)
    // a queued review leaves the queue at once: nothing has started, so there is nothing to signal
    if (run.status === 'queued') {
      // recorded before it leaves the queue, so a write the database refuses throws with the review still queued in its place, as if the Stop had not been asked
      const stopped = store.update(id, { status: 'stopped', finishedAt: now() })
      const item = queue.find((entry) => entry.id === id)
      // an attempt to start it whose checks still run ends here, and the slot it held goes to the next in line
      if (item !== undefined) dequeue(item)
      unrecorded.delete(id)
      log(`${noun} ${id}: taken out of the queue`)
      changed(stopped)
      wake(id, stopped)
      admit()
      return stopped
    }
    if (run.status !== 'running') throw new LaunchError('notRunning', `${noun} ${id} is not running (${run.status})`)
    // a run still being launched is stopped as soon as its process is watched, so its process is never left running unwatched
    if (launching.has(id)) {
      launching.set(id, true)
      return run
    }
    const entry = live.get(id)
    if (entry === undefined) {
      // nothing watches it: a run recorded as running with no process behind it, or one that ended here without its ending recorded
      const stopped = store.update(id, { status: 'stopped', finishedAt: now() })
      unrecorded.delete(id)
      changed(stopped)
      return stopped
    }
    stopLive(entry)
    return run
  }

  // a watched run is signaled from the pid it holds in memory, so stopping it reads nothing that could throw; a spawn that failed has no process to signal, and its exit settles it as stopped
  const stopLive = (entry: Live): void => {
    if (entry.pid === null) {
      entry.stopping = true
      return
    }
    if (entry.stopping) return
    entry.stopping = true
    signalGroup(entry.pid, 'SIGTERM')
    entry.killTimer = timers.set(() => {
      void escalate(entry)
    }, stopGraceMs)
  }

  type RequestFile = { pid?: unknown, pidStartedAt?: unknown }

  // a run watched again after a restart holds the slot the cache gives it now, since the one it was admitted with went with the server
  const recoveredSlot = (run: T): ReviewSlot | null => {
    try {
      return store.slot(run as unknown as { repo: string, number?: number, command: string }, options.config())
    } catch (error) {
      // a cache that cannot be read never keeps a live run from being watched again: a review is then counted as one of the cap's own, which can only hold another back, never let one start over the cap
      log(`${noun} ${run.id}: cannot read whether it is a self-review, so it counts as a review: ${messageOf(error)}`)
      return reviewCommands.includes(run.command) ? 'review' : null
    }
  }

  const recover = async (): Promise<void> => {
    // a start of the server makes no GitHub call and starts no process, so a review still queued when it stopped is not started now
    for (const run of store.queued()) {
      if (queue.some((item) => item.id === run.id)) continue
      // a failure the database refuses to record never keeps the live runs below from being watched again
      failQueued(run, 'serverRestarted: it was still queued, so it never started')
    }
    for (const run of store.running()) {
      if (live.has(run.id)) continue
      const dir = expandHome(run.dir, home)
      let request: RequestFile = {}
      try {
        request = JSON.parse(await fs.readFile(join(dir, 'request.json')) ?? '{}') as RequestFile
      } catch {
        request = {}
      }
      // the pid and its start time are each written to both request.json and the row from the same values, and either write may have been refused, so each is taken from whichever record kept it; two records that kept different values cannot both describe the run's process, and neither is trusted
      const pids = new Set([request.pid, run.pid].filter((value) => typeof value === 'number'))
      const startTimes = new Set([request.pidStartedAt, run.pidStartedAt].filter((value) => typeof value === 'string'))
      const pid = pids.size === 1 ? [...pids][0]! : null
      const startedAt = startTimes.size === 1 ? [...startTimes][0]! : null
      // a pid alone could have been reused; its start time must match too, so a pid with no start time recorded anywhere is never watched again
      const same = pid !== null && startedAt !== null && alive(pid) && await procs.startTime(pid).catch(() => null) === startedAt
      if (same) {
        log(`${noun} ${run.id}: still running after the restart (pid ${pid}); watching it again`)
        watching(run)
        watchRun({ ...run, pid }, dir, null, false, null, recoveredSlot(run))
      } else {
        const entry = watchRun({ ...run, pid: null }, dir, null, false, null, recoveredSlot(run))
        await settle(entry, null, true)
      }
    }
  }

  const rereading = new Set<number>()

  // the same target whatever order its keys were written in
  const sameTarget = (a: { repo: string, pr?: number | null, stack?: number[], top?: number, branch?: string, base?: string }, b: { repo: string, pr?: number | null, stack?: number[], top?: number, branch?: string, base?: string }): boolean => {
    if (a.repo.toLowerCase() !== b.repo.toLowerCase()) return false
    if ('stack' in a || 'stack' in b) return 'stack' in a && 'stack' in b && a.top === b.top && a.stack?.length === b.stack?.length && (a.stack ?? []).every((n, k) => n === b.stack?.[k])
    if (a.branch !== undefined && b.branch !== undefined && a.branch !== b.branch) return false
    if (a.base !== undefined && b.base !== undefined && a.base !== b.base) return false
    // a PR the first result had not worked out yet may be named by a later one
    return a.pr === null || a.pr === undefined || a.pr === b.pr
  }

  // what a new result must keep of the run: its repository and PR, and the target it first named
  const targetMismatch = (run: T, was: RunResultJson | null, value: RunResultJson): string | null => {
    if (value.schema === 'pit-crew/sweep-result@1') return value.repo !== null && value.repo.toLowerCase() !== run.repo.toLowerCase() ? `result.json is about ${value.repo}, not ${run.repo}` : null
    const first = was === null || was.schema === 'pit-crew/sweep-result@1' ? null : was.target
    const target = value.target
    if (target === null) return first !== null ? 'result.json no longer names its target' : value.status === 'done' ? 'result.json names no target, so it cannot show which PR it finished' : null
    if (target.repo.toLowerCase() !== run.repo.toLowerCase()) return `result.json targets ${target.repo}, not ${run.repo}`
    const number = (run as Partial<Run>).number
    if ('pr' in target && target.pr !== null && number !== undefined && target.pr !== number) return `result.json targets #${target.pr}, not #${number}`
    if ('stack' in target && number !== undefined && !target.stack.includes(number)) return `result.json targets a stack without #${number}`
    if ('stack' in target !== (value.command === 'review-stack')) return `result.json target does not fit ${value.command}`
    if (value.status === 'done' && number !== undefined && !('stack' in target) && target.pr !== number) return `result.json does not name #${number} as its target`
    if (first !== null && !sameTarget(first, target)) return 'result.json names another target than the run first did'
    return null
  }

  const reviewedMismatch = (was: RunResultJson | null, value: RunResultJson): string | null => {
    if (was?.schema !== 'pit-crew/review-result@1' || value.schema !== 'pit-crew/review-result@1' || was.reviewed === null) return null
    if (value.reviewed?.sha.toLowerCase() === was.reviewed.sha.toLowerCase()) return null
    return `the reviewed commit changed from ${was.reviewed.sha.slice(0, 7)} to ${value.reviewed?.sha.slice(0, 7) ?? 'none'}; start a new review instead`
  }

  const reread = async (id: number): Promise<T> => {
    const run = store.get(id)
    if (run === null) throw new LaunchError('unknownRun', `${noun} ${id} does not exist`)
    if (store.schema !== null) throw new LaunchError('notRereadable', `a ${noun} cannot be read again`)
    if (run.status !== 'failed' && run.status !== 'needsInput') throw new LaunchError('notRereadable', `${noun} ${id} is ${run.status}; only a failed ${noun} or one waiting for an answer can be read again`)
    if (run.resume === null) throw new LaunchError('notRereadable', `${noun} ${id} has no session to resume, so nothing could have finished it by hand`)
    if (rereading.has(id) || live.has(id)) throw new LaunchError('busy', `${noun} ${id} is being read already`)
    rereading.add(id)
    try {
      const refuse = (why: string): never => {
        throw new LaunchError('rereadRefused', `${why}; the ${noun} is unchanged`)
      }
      const dir = expandHome(run.dir, home)
      const text = await fs.readFile(join(dir, 'result.json')).catch(() => null)
      if (text === null) return refuse(`result.json is missing from ${tildePath(dir, home)}`)
      const parsed = parseResult(text)
      if (!parsed.ok) return refuse(parsed.error)
      const value = parsed.value
      const expected = run.command === 'fix-pr' ? 'pit-crew/fix-result@1' : run.command === 'update-pr' ? 'pit-crew/update-result@1' : 'pit-crew/review-result@1'
      if (value.schema !== expected) return refuse(`result.json has schema ${value.schema}, but this run's result has schema ${expected}`)
      if (value.command !== run.command) return refuse(`result.json is for command ${value.command}, not ${run.command}`)
      const moved = targetMismatch(run, run.result, value) ?? reviewedMismatch(run.result, value)
      if (moved !== null) return refuse(moved)
      let reportExists: boolean | null = null
      const path = reportPath(value)
      if (path !== null) reportExists = await fs.exists(expandHome(path, home)).catch(() => false)
      // judged on its own: the stream's denials belong to the original attempt, and the owner has resolved them
      const judgement = judge({ stopped: false, restarted: false, exit: null, parsed, reportExists, denials: [], mayPost: mayPost(run.command, run.args), lastEvent: null })
      // a guard failure is the launcher's own verdict; a valid failed result carries its own error, whatever words that starts with
      const ownFailure = value.status === 'failed' && judgement.note === value.error && (value.schema !== 'pit-crew/fix-result@1' || fixMismatch(value) === null) && (value.schema !== 'pit-crew/update-result@1' || updateMismatch(value) === null)
      if (judgement.status === 'failed' && !ownFailure && noteKind(judgement.note) !== null) return refuse(judgement.note ?? 'the result is not valid')
      const note = judgement.status === 'failed' ? judgement.note : run.note
      if (judgement.status === run.status && note === run.note && JSON.stringify(judgement.result) === JSON.stringify(run.result)) {
        return refuse('result.json has not changed since the run settled')
      }
      const changes: RunChanges = { status: judgement.status, note, result: judgement.result, resolvedByHand: true, ...await finishedReport(value) }
      // the first time a failed re-read replaces the note, the note recorded at exit moves to its own field, so a later finish by hand can still tell why the run first stopped; an original with no note is kept as an empty string, so firstNote stays set and a later failure cannot be copied in as the original
      if (note !== run.note && (run as Partial<Run>).firstNote === null) changes.firstNote = run.note ?? ''
      // the later steps too: every line of events.jsonl, folded from the start
      const eventsText = await fs.readFile(join(dir, 'events.jsonl')).catch(() => null)
      const events = (eventsText ?? '').split('\n').map(parseStepEvent).filter((event) => event !== null)
      const latest = events.at(-1)
      if (latest !== undefined) {
        Object.assign(changes, { steps: foldSteps(emptySteps(), events), lastStepAt: latest.at, step: latest.step, stepState: latest.state })
      }
      const updated = store.update(id, changes)
      log(`${noun} ${id} read again by hand: ${updated.status}${updated.note === null ? '' : ` (${updated.note})`}`)
      changed(updated)
      return updated
    } finally {
      rereading.delete(id)
    }
  }

  // Post it's mark (section 8, Launching runs, Blocked post): on the record before gh runs, and off it only when GitHub refused the post. Nothing is announced: the row changes when the post is recorded or when the refresh after a failure arrives
  const markPost = (id: number, posting: boolean): void => {
    store.update(id, { postAttemptedAt: posting ? now() : null })
  }

  // the post Post it made for a blocked run (section 8, Launching runs, Blocked post): the run now reads as posted, and its step bar with it. Its folder is left as the worker wrote it, and a done run is never read from it again
  const recordPost = (id: number, posted: Posted): T => {
    const run = store.get(id)
    if (run === null) throw new LaunchError('unknownRun', `${noun} ${id} does not exist`)
    const result = run.result
    if (store.schema !== null || result?.schema !== 'pit-crew/review-result@1') throw new LaunchError('notRunning', `${noun} ${id} has no review to record a post on`)
    const at = now()
    const updated = store.update(id, {
      result: { ...result, posted, notPostedReason: null },
      steps: foldSteps(stepsOf(run), [{ at, step: 'post', state: 'done', note: 'posted from Pit View' }]),
      lastStepAt: at,
      step: 'post',
      stepState: 'done',
    })
    log(`${noun} ${id}: post recorded (${posted.form})`)
    changed(updated)
    return updated
  }

  const checkAll = async (): Promise<void> => {
    await Promise.all([...live.values()].map((entry) => pumpOf(entry)))
  }

  const settled = (id: number): Promise<T> => {
    const failed = unrecorded.get(id)
    if (failed !== undefined) return Promise.resolve(failed)
    const run = store.get(id)
    if (run === null) return Promise.reject(new LaunchError('unknownRun', `${noun} ${id} does not exist`))
    if (!live.has(id) && !launching.has(id) && run.status !== 'queued') return Promise.resolve(run)
    return new Promise((resolveRun) => waiters.set(id, [...(waiters.get(id) ?? []), resolveRun]))
  }

  const close = (): void => {
    closed = true
    if (flushHandle !== null) clearImmediate(flushHandle)
    flushHandle = null
    if (retryHandle !== null) timers.clear(retryHandle)
    retryHandle = null
    flush()
    for (const entry of live.values()) clear(entry)
  }

  return { start, stop, reread, markPost, recordPost, recover, drain: admit, check: checkAll, settled, queueing, flushed, close }
}
