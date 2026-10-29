// test/ui-drawer.test.ts
// the Agent drawer's words and shapes (public/drawerview.ts): every state of the cards, the start
// buttons and their confirmation, the step bar, the lists, what is refetched and when, where focus
// goes and what Escape closes
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { OpenRow } from '../src/derive.ts'
import type { ReportListing } from '../src/reports.ts'
import type { AgentCell, RunView, StartOption, StepSlot } from '../public/agent.ts'
import {
  cardKind, cellFromRun, confirmHolds, defaultRunner, drawerModel, escapeApplies, escapeTarget, focusKeySelector, latestCell, formatCost, headerModel, loadErrorText, newestNote, mayMoveFocus, noteText, quoteAttr, refetchKeys,
  reportName, reportRows, resumeReadyText, returnSelector, runRows, runText, startConfirmModel, startsModel, stepModels, stepsName, stopModel, summaryOf,
} from '../public/drawerview.ts'
import type { DrawerInput, Loadable } from '../public/drawerview.ts'

const now = Date.parse('2026-10-28T15:00:00Z')
const ago = (ms: number): string => new Date(now - ms).toISOString()
const s = 1000
const m = 60 * s
const h = 60 * m

const options = (patch: Partial<Record<string, Partial<StartOption>>> = {}): StartOption[] => [
  {
    kind: 'default', label: 'Re-review', button: 'Re-review PR', command: 'review-pr', args: ['101'], runners: ['claude', 'codex'],
    posts: { kind: 'review', text: 'Posts its report to the PR as @viewer: an approval, a request for changes, or a comment, per the findings.' },
    unavailable: null, ...patch.default,
  },
  {
    kind: 'tandem', label: 'Tandem re-review', button: 'Re-review in tandem', command: 'review-pr', args: ['101', '--tandem'], runners: ['claude'],
    posts: { kind: 'review', text: 'Posts its report to the PR as @viewer: an approval, a request for changes, or a comment, per the findings.' },
    unavailable: null, ...patch.tandem,
  },
  {
    kind: 'stack', label: 'Review stack', button: 'Review stack', command: 'review-stack', args: ['101'], runners: ['claude', 'codex'],
    posts: { kind: 'offer', text: 'Posts nothing; writes the report only. It stops to offer posting it on the top PR, and you answer in the session.' },
    unavailable: null, ...patch.stack,
  },
]

const slots = (states: Partial<Record<StepSlot['step'], [StepSlot['state'], string | null, string | null]>> = {}): StepSlot[] =>
  (['resolveBase', 'review', 'consolidate', 'writeReport', 'post'] as const).map((step) => {
    const [state, at, note] = states[step] ?? ['pending', null, null]
    return { step, state, at, note }
  })

const idle = (patch: Partial<AgentCell> = {}): AgentCell => ({
  state: 'idle',
  label: 'Re-review',
  action: { kind: 'reReview', label: 'Re-review', command: 'review-pr', args: ['101'], runner: 'claude' },
  starts: options(),
  lastReviewAt: null,
  runId: null, runner: null, command: null, args: null, status: null, startedAt: null, lastStepAt: null, step: null,
  steps: slots(), tandem: false,
  finishedAt: null, text: null, result: null, question: null, note: null, resume: null, costUsd: null,
  ...patch,
})

const running = (patch: Partial<AgentCell> = {}): AgentCell => idle({
  state: 'running', runId: 7, runner: 'claude', command: 'review-pr', args: ['101'], status: 'running', label: 'Re-review',
  startedAt: ago(3 * m + 5 * s), lastStepAt: ago(20 * s), step: { name: 'review', state: 'started' },
  steps: slots({ resolveBase: ['done', ago(3 * m), null], review: ['started', ago(20 * s), 'reviewing the diff'] }),
  starts: options({ default: { unavailable: 'a run for #101 is already in flight' }, tandem: { unavailable: 'a run for #101 is already in flight' }, stack: { unavailable: 'a run for #101 is already in flight' } }),
  ...patch,
})

const finished = (patch: Partial<AgentCell> = {}): AgentCell => running({
  state: 'done', status: 'done', finishedAt: ago(17 * h), text: 'Changes requested', costUsd: 0.42, resume: 'cd ~/dev/orbit && claude --resume 6f1c',
  step: { name: 'post', state: 'done' },
  result: {
    kind: 'review', verdict: 'changesRequested', recommendation: null, findings: 3, ci: 'green',
    posted: { form: 'requestChanges', url: 'https://example.test/owner/name/pull/101#pullrequestreview-1' }, notPostedReason: null, report: '~/agents/output/PR-101.md',
  },
  ...patch,
})

const row = (agent: AgentCell | null): OpenRow => ({
  number: 101,
  url: 'https://example.test/owner/name/pull/101',
  title: 'fix(retry): back off between attempts',
  author: { login: 'alex-mendez', alias: 'Alex' },
  headRef: 'fix/retry', baseRef: 'main', headOid: '755b78b2c4e1f0a9d3b6e8c7a5f4d2e1b0c9a8f7',
  agent,
} as unknown as OpenRow)

const input = (agent: AgentCell | null, patch: Partial<DrawerInput> = {}): DrawerInput => ({
  row: row(agent), open: true, runs: { state: 'loading' }, reports: { state: 'loading' }, confirm: null, ...patch,
})

test('the header carries the PR as the row does: number, link, author, title, head to base and head SHA', () => {
  assert.deepEqual(headerModel(row(idle())), {
    number: 101,
    url: 'https://example.test/owner/name/pull/101',
    heading: 'Agent for #101',
    author: 'Alex · @alex-mendez',
    title: 'fix(retry): back off between attempts',
    refs: 'fix/retry → main · head 755b78b',
  })
})

test('an idle PR offers every start, default first, and shows no card', () => {
  const model = drawerModel(input(idle()))
  assert.deepEqual(model.starts.buttons.map((button) => [button.kind, button.text, button.disabled]), [
    ['default', 'Re-review PR', false], ['tandem', 'Re-review in tandem', false], ['stack', 'Review stack', false],
  ])
  assert.equal(model.starts.shared, null)
  assert.equal(model.card, 'none')
  assert.deepEqual([model.running, model.waiting, model.result, model.gone, model.confirm], [null, null, null, null, null])
})

test('a start that cannot run is disabled and says why, once when every start has the same reason', () => {
  const same = startsModel(running(), true, 101)
  assert.ok(same.buttons.every((button) => button.disabled && button.reason === null))
  assert.equal(same.shared, 'A run for #101 is already in flight.')
  const noClone = 'set cloneDir in the config to your local clone of owner/name before starting a run'
  const mixed = startsModel(idle({ starts: options({ tandem: { unavailable: noClone } }) }), true, 101)
  assert.deepEqual(mixed.buttons.map((button) => [button.disabled, button.reason]), [
    [false, null], [true, 'Set cloneDir in the config to your local clone of owner/name before starting a run.'], [false, null],
  ])
  assert.equal(mixed.shared, null)
})

test('the start confirmation names the PR title, the command, the runner choice and what it does on GitHub', () => {
  const ask = startConfirmModel(row(idle()), idle(), 'default', 'claude')
  assert.ok(ask !== null)
  assert.equal(ask.heading, 'Re-review #101?')
  assert.equal(ask.title, 'fix(retry): back off between attempts')
  assert.equal(ask.command, '/review-pr 101')
  assert.deepEqual(ask.runners, [{ name: 'claude', label: 'Claude Code' }, { name: 'codex', label: 'Codex' }])
  assert.equal(ask.effect, 'Posts its report to the PR as @viewer: an approval, a request for changes, or a comment, per the findings.')
  assert.equal(ask.confirm, 'Start')
  // choosing Codex rewrites the command with a dollar sign
  assert.equal(startConfirmModel(row(idle()), idle(), 'default', 'codex')?.command, '$review-pr 101')
  assert.equal(startConfirmModel(row(idle()), idle(), 'stack', 'claude')?.command, '/review-stack 101')
  // no choice is shown for a start that works with one runner only
  const tandem = startConfirmModel(row(idle()), idle(), 'tandem', 'codex')
  assert.equal(tandem?.runner, 'claude')
  assert.equal(tandem?.runners.length, 1)
  assert.equal(tandem?.command, '/review-pr 101 --tandem')
  // a start the PR does not offer has no confirmation
  assert.equal(startConfirmModel(row(idle()), idle({ starts: options().slice(0, 1) }), 'stack', 'claude'), null)
})

test('the runner a start opens with: the configured one, Claude for tandem, never one it does not work with', () => {
  const [def, tandem, stack] = options() as [StartOption, StartOption, StartOption]
  assert.equal(defaultRunner(def, 'codex'), 'codex')
  assert.equal(defaultRunner(tandem, 'codex'), 'claude')
  assert.equal(defaultRunner(stack, 'claude'), 'claude')
  assert.equal(defaultRunner({ kind: 'default', runners: ['claude'] }, 'codex'), 'claude')
})

test('the step bar always has five steps in order, each with a mark and a word that differ by state', () => {
  const steps = stepModels(slots({
    resolveBase: ['done', ago(3 * m), null], review: ['started', ago(s), null], consolidate: ['skipped', ago(2 * s), 'no tandem review'],
  }))
  assert.deepEqual(steps.map((step) => [step.label, step.state, step.glyph, step.text]), [
    ['Resolve base', 'done', '✓', 'done'],
    ['Review', 'started', '◐', 'started'],
    ['Consolidate', 'skipped', '–', 'skipped'],
    ['Write report', 'pending', '○', 'pending'],
    ['Post', 'pending', '○', 'pending'],
  ])
  assert.equal(new Set(steps.map((step) => step.glyph)).size, 4, 'each state has its own mark')
  assert.equal(stepsName(steps), 'Progress. Resolve base: done. Review: started. Consolidate: skipped. Write report: pending. Post: pending')
  // a cell with no steps still draws five pending ones
  assert.deepEqual(stepModels([]).map((step) => step.state), ['pending', 'pending', 'pending', 'pending', 'pending'])
})

test('the newest step\'s note is shown, and an older note is not', () => {
  assert.deepEqual(newestNote(slots({ review: ['started', ago(s), 'reviewing the diff'] })), { label: 'Review', note: 'reviewing the diff' })
  assert.equal(newestNote(slots({ consolidate: ['skipped', ago(5 * m), 'no tandem review'], review: ['started', ago(s), null] })), null)
  assert.equal(newestNote(slots()), null)
})

test('a running PR shows the card with its label, tandem tag, line with the head SHA, steps and note', () => {
  const model = drawerModel(input(running()))
  assert.equal(model.card, 'running')
  assert.equal(model.running?.label, 'Re-review')
  assert.equal(model.running?.tandem, false)
  assert.equal(model.running?.sha, '755b78b')
  assert.equal(model.running?.runnerLabel, 'Claude Code')
  assert.deepEqual(model.running?.note, { label: 'Review', note: 'reviewing the diff' })
  assert.equal(model.running?.steps.length, 5)
  assert.equal(model.stop?.confirm, 'Stop run')
  const tandem = drawerModel(input(running({ tandem: true, args: ['101', '--tandem'] })))
  assert.equal(tandem.running?.tandem, true)
  // every start is disabled while it runs, with one reason
  assert.equal(model.starts.shared, 'A run for #101 is already in flight.')
})

test('the stop confirmation names the run, its runner and what stopping leaves behind; Stop and open says what follows', () => {
  const plain = stopModel(101, { label: 'Re-review', runner: 'codex' }, false)
  assert.equal(plain.heading, 'Stop the run on #101?')
  assert.equal(plain.detail, 'Re-review in Codex')
  assert.match(plain.effect, /already posted stays on GitHub/)
  assert.match(plain.effect, /~\/agents\/worktrees may remain/)
  assert.equal(plain.confirm, 'Stop run')
  assert.equal(plain.after, null)
  const open = stopModel(101, { label: 'Re-review', runner: 'claude' }, true)
  assert.equal(open.confirm, 'Stop and open')
  assert.match(open.after ?? '', /resume/)
  // the card's model carries the confirm the drawer asked for
  assert.equal(drawerModel(input(running(), { confirm: { type: 'stop', andOpen: true, runId: 7 } })).stop?.confirm, 'Stop and open')
})

test('a run waiting for an answer shows the question and the resume command to copy', () => {
  const waiting = finished({ status: 'needsInput', text: 'Needs your answer', question: 'The tandem draft fails its checks; consolidate anyway?', result: null })
  const model = drawerModel(input(waiting))
  assert.equal(model.card, 'waiting')
  assert.deepEqual(model.waiting, {
    question: 'The tandem draft fails its checks; consolidate anyway?',
    resume: 'cd ~/dev/orbit && claude --resume 6f1c',
    copyName: 'Copy resume command for #101',
  })
  assert.equal(model.result, null)
  assert.match(drawerModel(input(finished({ status: 'needsInput', question: null }))).waiting?.question ?? '', /did not record/)
})

test('a finished run shows the server\'s text, when it finished, the cost, what it found and the resume command', () => {
  const model = drawerModel(input(finished()))
  assert.equal(model.card, 'result')
  assert.equal(model.result?.text, 'Changes requested')
  assert.equal(model.result?.tone, 'red')
  assert.equal(model.result?.finishedAt, ago(17 * h))
  assert.equal(model.result?.cost, '$0.42')
  assert.equal(model.result?.resume, 'cd ~/dev/orbit && claude --resume 6f1c')
  assert.equal(model.result?.stale, null)
  assert.deepEqual(model.result?.facts, [
    { label: 'Findings', value: '3 findings', href: null },
    { label: 'CI', value: 'green', href: null },
    { label: 'Posted', value: 'a request for changes', href: 'https://example.test/owner/name/pull/101#pullrequestreview-1' },
    { label: 'Report', value: '~/agents/output/PR-101.md', href: null },
  ])
  const clean = drawerModel(input(finished({
    text: 'Clean', result: { kind: 'review', verdict: 'clean', recommendation: null, findings: 1, ci: 'none', posted: null, notPostedReason: 'noPost', report: null }, costUsd: null,
  })))
  assert.equal(clean.result?.tone, 'green')
  assert.equal(clean.result?.cost, null)
  assert.deepEqual(clean.result?.facts.map((fact) => fact.value), ['1 finding', 'none', 'nothing: the run was told not to post'])
})

test('a posted review links only when its URL is http or https; anything else is shown as plain text', () => {
  const posted = (url: string) => drawerModel(input(finished({
    result: { kind: 'review', verdict: 'changesRequested', recommendation: null, findings: 1, ci: 'green', posted: { form: 'comment', url }, notPostedReason: null, report: null },
  }))).result?.facts.find((fact) => fact.label === 'Posted')
  assert.equal(posted('https://example.test/owner/name/pull/101#pullrequestreview-1')?.href, 'https://example.test/owner/name/pull/101#pullrequestreview-1')
  for (const url of ['javascript:alert(1)', 'java\tscript:alert(1)', 'java&#115;cript:alert(1)', 'data:text/html,x', '/pull/101', ' https://example.test']) {
    const fact = posted(url)
    assert.equal(fact?.href, null, url)
    assert.equal(fact?.value, 'a comment')
  }
})

test('a failed run shows why in words, with the detail kept, and a stopped run shows Stopped', () => {
  const failed = drawerModel(input(finished({ status: 'failed', text: 'Failed · no result', note: 'noResult: exited with code 1', result: null, costUsd: null })))
  assert.equal(failed.result?.tone, 'red')
  assert.equal(failed.result?.note, 'The run ended without a valid result file: exited with code 1')
  assert.equal(noteText('noReport'), 'The run said it was done, but its report file is missing.')
  // the command's own error is shown as it came
  assert.equal(noteText('gh could not read the PR'), 'gh could not read the PR')
  assert.equal(noteText(null), null)
  assert.equal(noteText('  '), null)
  const stopped = drawerModel(input(finished({ status: 'stopped', text: 'Stopped', note: null, result: null })))
  assert.equal(stopped.result?.text, 'Stopped')
  assert.equal(stopped.result?.tone, 'gray')
  assert.equal(stopped.result?.note, null)
  assert.equal(stopped.result?.resume, 'cd ~/dev/orbit && claude --resume 6f1c')
})

test('an idle cell after a run still shows that run, and says the head has moved', () => {
  const model = drawerModel(input(finished({ state: 'idle' })))
  assert.equal(model.card, 'result')
  assert.match(model.result?.stale ?? '', /head has moved/)
  assert.equal(cardKind(idle()), 'none')
})

test('a PR that left the open tables keeps its last content, says so, and cannot be started', () => {
  const model = drawerModel(input(finished(), { open: false }))
  assert.equal(model.gone, '#101 is no longer open')
  assert.equal(model.header.title, 'fix(retry): back off between attempts')
  assert.equal(model.card, 'result')
  assert.ok(model.starts.buttons.every((button) => button.disabled))
  assert.equal(model.starts.shared, 'Starting is off: #101 is no longer open.')
})

test('a start confirmation is in the model only while asked for and while the PR still offers it', () => {
  assert.equal(drawerModel(input(idle())).confirm, null)
  const asked = drawerModel(input(idle(), { confirm: { type: 'start', kind: 'tandem', runner: 'claude' } }))
  assert.equal(asked.confirm?.kind, 'tandem')
  assert.equal(asked.confirm?.command, '/review-pr 101 --tandem')
  assert.equal(drawerModel(input(null)).starts.buttons.length, 0)
})

test('previous runs list every run but the one the card shows: label, runner, outcome, age and cost', () => {
  const run = (id: number, patch: Partial<RunView> = {}): RunView => ({
    id, repo: 'owner/name', number: 101, command: 'review-pr', args: ['101'], label: 'Review', runner: 'claude', cwd: '~/dev/orbit', dir: `~/state/runs/${id}`,
    sessionId: null, pid: null, pidStartedAt: null, startedAt: ago(id * h), lastStepAt: null, step: null, stepState: null, steps: slots(),
    finishedAt: null, status: 'done', result: null, note: null, costUsd: null, resume: null, tandem: false, ...patch,
  } as RunView)
  const rows = runRows([
    run(7),
    run(6, { status: 'failed', note: 'noResult: exited with code 1', costUsd: 0.2 }),
    run(5, { status: 'stopped', runner: 'codex' }),
    run(4, { status: 'needsInput' }),
  ], 7)
  assert.deepEqual(rows.map((entry) => [entry.id, entry.runner, entry.text, entry.tone, entry.cost]), [
    [6, 'Claude Code', 'Failed · no result', 'red', '$0.20'],
    [5, 'Codex', 'Stopped', 'gray', null],
    [4, 'Claude Code', 'Needs your answer', 'amber', null],
  ])
  assert.deepEqual(runText({ status: 'running', result: null, note: null }), { text: 'Running', tone: 'blue' })
  assert.deepEqual(runText({ status: 'done', result: null, note: null }), { text: 'Done', tone: 'gray' })
  const reviewed = (verdict: 'clean' | 'changesRequested', posted: 'approve' | 'comment' | null) => ({
    status: 'done' as const, note: null,
    result: { schema: 'pit-crew/review-result@1', verdict, posted: posted === null ? null : { form: posted, url: 'https://example.test/x' }, notPostedReason: null } as unknown as RunView['result'],
  })
  assert.equal(runText(reviewed('changesRequested', null)).text, 'Changes requested')
  assert.equal(runText(reviewed('clean', 'approve')).text, 'Approved')
  assert.equal(runText(reviewed('clean', 'comment')).text, 'Clean · CI failed')
  assert.equal(runText(reviewed('clean', null)).text, 'Clean')
  assert.equal(formatCost(0.5), '$0.50')
})

test('reports on disk list the name, the short SHA, a verdict chip and a tandem tag, with an Open button named for the file', () => {
  const listing = (patch: Partial<ReportListing>): ReportListing => ({ name: 'PR-101.md', kind: 'review', modifiedAt: ago(h), sha: null, verdict: null, tandem: false, ...patch })
  const rows = reportRows([
    listing({ sha: '755b78b2c4e1', verdict: 'changesRequested', tandem: true }),
    listing({ name: 'PR-101-secondary.md', verdict: 'clean' }),
    listing({ name: 'PR-101-notes.md' }),
  ])
  assert.deepEqual(rows[0], {
    name: 'PR-101.md', modifiedAt: ago(h), sha: '755b78b', fix: false, verdict: { text: 'Changes requested', tone: 'red' }, tandem: true, openName: 'Open report PR-101.md',
  })
  assert.deepEqual(rows[1]?.verdict, { text: 'Clean', tone: 'green' })
  assert.equal(rows[2]?.verdict, null)
  assert.equal(rows[2]?.sha, null)
})

test('the lists say when they are loading, empty or failed, and the model carries each state', () => {
  const model = (runs: Loadable<RunView>, reports: Loadable<ReportListing>) => drawerModel(input(idle(), { runs, reports }))
  const loading = model({ state: 'loading' }, { state: 'loading' })
  assert.deepEqual([loading.runs.state, loading.reports.state], ['loading', 'loading'])
  const failed = model({ state: 'error', message: 'Could not load runs: Pit View did not answer.' }, { state: 'ready', items: [] })
  assert.equal(failed.runs.message, 'Could not load runs: Pit View did not answer.')
  assert.deepEqual([failed.reports.state, failed.reports.rows.length], ['ready', 0])
  assert.equal(loadErrorText('runs', 0, null), 'Could not load runs: Pit View did not answer.')
  assert.equal(loadErrorText('reports', 400, 'bad report name'), 'Could not load reports. Bad report name.')
  assert.equal(loadErrorText('runs', 500, null), 'Could not load runs: Pit View answered 500.')
})

test('runs refetch when the row\'s run, status, step or state changes, never for a timer or a step\'s time; reports when a run starts or ends', () => {
  const base = refetchKeys(running())
  assert.deepEqual(refetchKeys(running({ lastStepAt: ago(s), startedAt: ago(h) })), base)
  assert.notDeepEqual(refetchKeys(running({ step: { name: 'consolidate', state: 'started' } })).runs, base.runs)
  assert.notDeepEqual(refetchKeys(running({ step: { name: 'review', state: 'done' } })).runs, base.runs)
  assert.notDeepEqual(refetchKeys(running({ runId: 8 })).runs, base.runs)
  const settled = refetchKeys(finished())
  assert.notEqual(settled.runs, base.runs)
  // a step moving does not touch the reports; the run ending does
  assert.equal(refetchKeys(running({ step: { name: 'post', state: 'started' } })).reports, base.reports)
  assert.notEqual(settled.reports, base.reports)
  assert.deepEqual(refetchKeys(null), { runs: 'none', reports: 'none' })
})

test('focus goes back to the control that opened the drawer, else the PR link, else nowhere', () => {
  const present = (...selectors: string[]) => (selector: string): boolean => selectors.includes(selector)
  const opener = { key: 'agent-open:101', number: 101 }
  assert.equal(returnSelector(opener, 101, present('[data-focus-key="agent-open:101"]', 'tr[data-pr="101"] [data-focus="pr"]')), '[data-focus-key="agent-open:101"]')
  // the opener is gone (the column was turned off, the cell rebuilt away): the PR link
  assert.equal(returnSelector(opener, 101, present('tr[data-pr="101"] [data-focus="pr"]')), 'tr[data-pr="101"] [data-focus="pr"]')
  assert.equal(returnSelector({ key: 'banner-open:101', number: 101 }, 101, present('[data-focus-key="banner-open:101"]')), '[data-focus-key="banner-open:101"]')
  assert.equal(returnSelector(opener, 101, present()), null)
  assert.equal(returnSelector(null, 101, present('tr[data-pr="101"] [data-focus="pr"]')), 'tr[data-pr="101"] [data-focus="pr"]')
})

test('Escape closes the report panel first, then a confirmation, then the drawer, and never a confirmation mid-request', () => {
  assert.equal(escapeTarget({ report: true, confirm: true, busy: false, drawer: true }), 'report')
  assert.equal(escapeTarget({ report: false, confirm: true, busy: false, drawer: true }), 'confirm')
  assert.equal(escapeTarget({ report: false, confirm: false, busy: false, drawer: true }), 'drawer')
  assert.equal(escapeTarget({ report: false, confirm: true, busy: true, drawer: true }), null)
  assert.equal(escapeTarget({ report: false, confirm: false, busy: false, drawer: false }), null)
})

test('Stop and open says when the resume command is ready, or that there is no session', () => {
  assert.equal(resumeReadyText(101, true), '#101: run stopped. The resume command is ready to copy.')
  assert.equal(resumeReadyText(101, false), '#101: run stopped. It has no session to resume.')
})

// a PR that left the open tables

const runView = (patch: Partial<RunView> = {}): RunView => ({
  id: 7, repo: 'owner/name', number: 101, command: 'review-pr', args: ['101'], label: 'Re-review', runner: 'claude', cwd: '~/dev/orbit', dir: '~/state/runs/7',
  sessionId: null, pid: null, pidStartedAt: null, startedAt: ago(5 * m), lastStepAt: ago(s), step: 'review', stepState: 'started', steps: slots(),
  finishedAt: null, status: 'running', result: null, note: null, costUsd: null, resume: 'cd ~/dev/orbit && claude --resume 6f1c', tandem: false, ...patch,
} as RunView)

test('for a PR that left the open tables the card follows the newest run read from the server, not the stale row', () => {
  const stale = running()
  // still running: the card stays, with the run's own steps
  const still = latestCell(stale, { state: 'ready', items: [runView({ steps: slots({ resolveBase: ['done', ago(m), null] }) })] })
  assert.equal(still?.state, 'running')
  assert.equal(still?.steps[0]?.state, 'done')
  // it ended while nobody was watching: the card settles to the run's outcome
  const ended = latestCell(stale, { state: 'ready', items: [runView({
    status: 'done', finishedAt: ago(s), costUsd: 0.5,
    result: { schema: 'pit-crew/review-result@1', command: 'review-pr', status: 'done', target: null, reviewed: null, verdict: 'changesRequested', recommendation: null, findings: [{ priority: 'P1', summary: 'x', files: [] }], ci: 'green', fixAttempts: 0, posted: null, notPostedReason: 'noPost', report: null, question: null, error: null },
  })] })
  assert.equal(ended?.state, 'done')
  assert.equal(ended?.text, 'Changes requested')
  assert.equal(ended?.result?.kind === 'review' ? ended.result.findings : null, 1)
  assert.equal(ended?.costUsd, 0.5)
  assert.equal(cardKind(ended as AgentCell), 'result')
  assert.equal(cellFromRun(stale, runView({ status: 'needsInput', result: { schema: 'pit-crew/review-result@1', question: 'Post it?', findings: [], verdict: null, recommendation: null, ci: null, posted: null, notPostedReason: null, report: null } as unknown as RunView['result'] })).question, 'Post it?')
  assert.equal(cellFromRun(stale, runView({ status: 'stopped' })).text, 'Stopped')
  // nothing read yet, a failed read or an older run leaves the row's cell alone
  assert.equal(latestCell(stale, { state: 'loading' }), stale)
  assert.equal(latestCell(stale, { state: 'error', message: 'x' }), stale)
  assert.equal(latestCell(stale, { state: 'ready', items: [runView({ id: 3, status: 'done' })] }), stale)
  assert.equal(latestCell(null, { state: 'ready', items: [runView()] }), null)
})

test('Stop is not offered on a guess: a PR that left the open tables enables it only once its runs are read', () => {
  const model = (open: boolean, runs: Loadable<RunView>) => drawerModel(input(running(), { open, runs }))
  assert.equal(model(true, { state: 'loading' }).stopsEnabled, true)
  assert.equal(model(false, { state: 'loading' }).stopsEnabled, false)
  assert.equal(model(false, { state: 'error', message: 'x' }).stopsEnabled, false)
  assert.equal(model(false, { state: 'ready', items: [runView()] }).stopsEnabled, true)
})

test('a confirmation is dropped as soon as it cannot be built: its run ended, its start vanished, or the PR left', () => {
  const stop = { type: 'stop', andOpen: false, runId: 7 } as const
  assert.equal(confirmHolds(stop, running(), true), true)
  assert.equal(confirmHolds(stop, finished(), true), false, 'the run ended')
  assert.equal(confirmHolds(stop, running({ runId: 8 }), true), false, 'another run now')
  assert.equal(confirmHolds(stop, null, true), false)
  const start = { type: 'start', kind: 'tandem', runner: 'claude' } as const
  assert.equal(confirmHolds(start, idle(), true), true)
  assert.equal(confirmHolds(start, idle(), false), false, 'the PR left the open tables')
  assert.equal(confirmHolds(start, running(), true), false, 'a run started meanwhile makes every start unavailable')
  assert.equal(confirmHolds(start, idle({ starts: options().slice(0, 1) }), true), false, 'the start is no longer offered')
  assert.equal(confirmHolds({ ...start, kind: 'stack' }, idle(), true), true)
})

test('focus is moved only from inside the drawer or from nothing, never out of a field in use elsewhere', () => {
  assert.equal(mayMoveFocus({ insideDrawer: true, onBody: false }), true)
  assert.equal(mayMoveFocus({ insideDrawer: false, onBody: true }), true)
  assert.equal(mayMoveFocus({ insideDrawer: false, onBody: false }), false)
})

test('Escape acts inside the panels and anywhere that is not a text field, and leaves a field of the page behind its own Escape', () => {
  const at = (tag: string, patch: Partial<{ editable: boolean, inPanel: boolean }> = {}) => escapeApplies({ tag, editable: false, inPanel: false, ...patch })
  assert.equal(at('BUTTON'), true)
  assert.equal(at('BODY'), true)
  assert.equal(at('A'), true)
  assert.equal(at('INPUT'), false, 'a search box clears itself')
  assert.equal(at('textarea'), false)
  assert.equal(at('SELECT'), false)
  assert.equal(at('DIV', { editable: true }), false)
  assert.equal(at('INPUT', { inPanel: true }), true, 'a runner radio in the confirmation')
})

test('a focus key goes into a quoted attribute selector with its quote and backslash escaped', () => {
  assert.equal(focusKeySelector('agent-open:101'), '[data-focus-key="agent-open:101"]')
  assert.equal(focusKeySelector('report:PR-101-r2.v1.md'), '[data-focus-key="report:PR-101-r2.v1.md"]')
  assert.equal(quoteAttr('a"b\\c'), 'a\\"b\\\\c')
  assert.equal(focusKeySelector('x"] , body [a="'), '[data-focus-key="x\\"] , body [a=\\""]')
  assert.equal(quoteAttr('a\nb'), 'a\\a b')
  // the return selector uses it too, and the PR number is always a number
  assert.equal(returnSelector({ key: 'k"x', number: 1 }, 1, (selector) => selector === '[data-focus-key="k\\"x"]'), '[data-focus-key="k\\"x"]')
  assert.equal(returnSelector(null, Number('101"]'), () => true), 'tr[data-pr="NaN"] [data-focus="pr"]')
})

// the Fix session (P2.6)

const fixOption: StartOption = {
  kind: 'fix', label: 'Fix session', button: 'Fix requested changes', command: 'fix-pr', args: ['101'], runners: ['claude'],
  posts: { kind: 'push', text: 'Pushes new commits to fix/retry on GitHub. It posts no replies or reviews, and stops to ask when a request needs judgment.' },
  unavailable: null,
}

const own = (patch: Partial<AgentCell> = {}): AgentCell => idle({
  label: 'Self-review',
  action: { kind: 'selfReview', label: 'Self-review', command: 'review-pr', args: ['101', '--no-post'], runner: 'codex' },
  starts: [
    { kind: 'default', label: 'Self-review', button: 'Self-review', command: 'review-pr', args: ['101', '--no-post'], runners: ['claude', 'codex'], posts: { kind: 'nothing', text: 'Posts nothing.' }, unavailable: null },
    fixOption,
  ],
  ...patch,
})

type FixSummary = Extract<NonNullable<AgentCell['result']>, { kind: 'fix' }>

const fixSummary = (patch: Partial<FixSummary> = {}): FixSummary => ({
  kind: 'fix',
  requests: 3,
  triage: { needsJudgment: 0, noChange: 0, disagree: 0, outOfScope: 1, clear: 2 },
  outcomes: { fixed: 2, notFixed: 1, awaitingAnswer: 0 },
  pushed: {
    branch: 'fix/retry', head: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432', count: 2,
    commits: [{ sha: '1a2b3c4', subject: 'Back off between retries' }, { sha: '9f8e7d6', subject: 'Log the attempt number' }],
  },
  notPushedReason: null,
  checks: [{ name: 'pnpm test', result: 'passed' }],
  worktree: null,
  report: '~/agents/output/FIX-101.md',
  ...patch,
})

const fixed = (patch: Partial<AgentCell> = {}, summary: Partial<FixSummary> = {}): AgentCell => own({
  state: 'done', runId: 9, runner: 'claude', command: 'fix-pr', args: ['101'], status: 'done', label: 'Fix session',
  startedAt: ago(10 * m), lastStepAt: ago(m), step: { name: 'post', state: 'done' }, finishedAt: ago(m),
  text: 'Fixed · pushed 2 commits', result: fixSummary(summary), costUsd: 1.1, resume: 'cd ~/dev/orbit && claude --resume 9a8b',
  ...patch,
})

test('a Fix session\'s confirmation names the push: the branch in its heading, the command, what it does, and a Start of its own', () => {
  const ask = startConfirmModel(row(own()), own(), 'fix', 'codex')
  assert.ok(ask !== null)
  assert.equal(ask.heading, 'Push fixes to fix/retry?')
  assert.equal(ask.title, 'fix(retry): back off between attempts')
  assert.equal(ask.command, '/fix-pr 101')
  // Claude only, whatever the configured runner: no choice is offered
  assert.equal(ask.runner, 'claude')
  assert.deepEqual(ask.runners, [{ name: 'claude', label: 'Claude Code' }])
  assert.equal(ask.effect, fixOption.posts.text)
  assert.equal(ask.effectKind, 'push')
  assert.equal(ask.caution, 'It pushes new commits to fix/retry on GitHub under your account, and never force-pushes.')
  assert.equal(ask.confirm, 'Start fix session')
  assert.equal(ask.busy, 'Starting fix session…')
  // a review's confirmation keeps its own words and no caution
  const review = startConfirmModel(row(own()), own(), 'default', 'claude')
  assert.equal(review?.caution, null)
  assert.equal(review?.confirm, 'Start')
  assert.equal(review?.heading, 'Self-review #101?')
  // the drawer's model carries it while asked, and drops it once a run makes the start unavailable
  assert.equal(drawerModel(input(own(), { confirm: { type: 'start', kind: 'fix', runner: 'claude' } })).confirm?.heading, 'Push fixes to fix/retry?')
  assert.equal(confirmHolds({ type: 'start', kind: 'fix', runner: 'claude' }, own({ starts: [{ ...fixOption, unavailable: 'a run for #101 is already in flight' }] }), true), false)
  assert.deepEqual(drawerModel(input(own())).starts.buttons.map((button) => button.text), ['Self-review', 'Fix requested changes'])
})

test('a running Fix session shows its label, no Tandem tag, and the steps by its own names, in the bar and for screen readers', () => {
  const cell = own({
    state: 'running', runId: 9, runner: 'claude', command: 'fix-pr', args: ['101'], status: 'running', label: 'Fix session',
    startedAt: ago(2 * m), lastStepAt: ago(5 * s), step: { name: 'consolidate', state: 'started' },
    steps: slots({ resolveBase: ['done', ago(2 * m), null], review: ['done', ago(m), '3 requests, 2 clear'], consolidate: ['started', ago(5 * s), 'running pnpm test'] }),
  })
  const model = drawerModel(input(cell))
  assert.equal(model.running?.label, 'Fix session')
  assert.equal(model.running?.tandem, false)
  assert.deepEqual(model.running?.steps.map((step) => step.label), ['Resolve', 'Triage', 'Fix and check', 'Write report', 'Push'])
  assert.equal(model.running?.stepsName, 'Progress. Resolve: done. Triage: done. Fix and check: started. Write report: pending. Push: pending')
  assert.deepEqual(model.running?.note, { label: 'Fix and check', note: 'running pnpm test' })
  assert.deepEqual(stepModels([], 'fix-pr').map((step) => step.label), ['Resolve', 'Triage', 'Fix and check', 'Write report', 'Push'])
  assert.deepEqual(newestNote(slots({ review: ['started', ago(s), 'triaging'] }), 'fix-pr'), { label: 'Triage', note: 'triaging' })
})

test('a Fix session that pushed shows its text, the commits with the branch, the counts in words, the checks and its report', () => {
  const model = drawerModel(input(fixed()))
  assert.equal(model.card, 'result')
  assert.equal(model.result?.text, 'Fixed · pushed 2 commits')
  assert.equal(model.result?.tone, 'green')
  assert.deepEqual(model.result?.facts, [], 'a review\'s facts are not shown for a fix')
  assert.deepEqual(model.result?.fix, {
    pushed: { branch: 'fix/retry', commits: [{ sha: '1a2b3c4', subject: 'Back off between retries' }, { sha: '9f8e7d6', subject: 'Log the attempt number' }] },
    requests: '3 requests: 2 clear, 1 out of scope',
    outcomes: '2 fixed, 1 not fixed',
    checks: [{ name: 'pnpm test', text: 'passed', tone: 'green' }],
    worktree: null,
    report: { name: 'FIX-101.md', openName: 'Open report FIX-101.md' },
  })
  // a review's result has no fix block
  assert.equal(drawerModel(input(finished())).result?.fix, null)
})

test('a Fix session with nothing to fix says so, with no commits, no checks and no zero counts', () => {
  const model = drawerModel(input(fixed({ text: 'Nothing to fix' }, {
    requests: 2, triage: { needsJudgment: 0, noChange: 1, disagree: 0, outOfScope: 1, clear: 0 }, outcomes: { fixed: 0, notFixed: 2, awaitingAnswer: 0 },
    pushed: null, notPushedReason: 'nothingToFix', checks: [],
  })))
  assert.equal(model.result?.text, 'Nothing to fix')
  assert.equal(model.result?.tone, 'gray')
  assert.equal(model.result?.fix?.pushed, null)
  assert.equal(model.result?.fix?.requests, '2 requests: 1 needing no change, 1 out of scope')
  assert.equal(model.result?.fix?.outcomes, '2 not fixed')
  assert.deepEqual(model.result?.fix?.checks, [])
  const none = drawerModel(input(fixed({ text: 'Nothing to fix' }, {
    requests: 0, triage: { needsJudgment: 0, noChange: 0, disagree: 0, outOfScope: 0, clear: 0 }, outcomes: { fixed: 0, notFixed: 0, awaitingAnswer: 0 },
    pushed: null, notPushedReason: 'nothingToFix', checks: [],
  })))
  assert.equal(none.result?.fix?.requests, 'No requests to act on')
  assert.equal(none.result?.fix?.outcomes, null)
})

test('a Fix session that did not push names the worktree holding its commits, and each check\'s result', () => {
  const model = drawerModel(input(fixed({ text: 'Not pushed · checks failed' }, {
    requests: 1, triage: { needsJudgment: 0, noChange: 0, disagree: 0, outOfScope: 0, clear: 1 }, outcomes: { fixed: 1, notFixed: 0, awaitingAnswer: 0 },
    pushed: null, notPushedReason: 'checksFailed', worktree: '~/agents/worktrees/orbit-fix-101',
    checks: [{ name: 'pnpm test', result: 'failed' }, { name: 'pnpm lint', result: 'notRun' }, { name: 'pnpm check', result: 'passed' }],
  })))
  assert.equal(model.result?.tone, 'amber')
  assert.equal(model.result?.fix?.requests, '1 request: 1 clear')
  assert.equal(model.result?.fix?.worktree, 'Commits not pushed are in ~/agents/worktrees/orbit-fix-101')
  assert.deepEqual(model.result?.fix?.checks.map((check) => [check.name, check.text, check.tone]), [
    ['pnpm test', 'failed', 'red'], ['pnpm lint', 'not run', 'amber'], ['pnpm check', 'passed', 'green'],
  ])
  // a push that landed but left its worktree behind does not say commits are unpushed
  assert.equal(drawerModel(input(fixed({}, { worktree: '~/agents/worktrees/orbit-fix-101' }))).result?.fix?.worktree, 'Its worktree was left behind in ~/agents/worktrees/orbit-fix-101')
  // a refused push fails the run, in red, with git's error as the note
  const refused = drawerModel(input(fixed({ status: 'failed', text: 'Failed · push refused', note: 'git push was rejected' }, { pushed: null, notPushedReason: 'pushFailed', report: null })))
  assert.equal(refused.result?.tone, 'red')
  assert.equal(refused.result?.note, 'git push was rejected')
  assert.equal(refused.result?.fix?.report, null)
  // once the head moves on, the run shows as the last one without telling the owner to review
  assert.equal(drawerModel(input(fixed({ state: 'idle' }))).result?.stale, 'The head has moved since this run, so it covers an earlier commit.')
})

test('a Fix session waiting for an answer shows the question and the resume command, as a review does', () => {
  const model = drawerModel(input(fixed({ status: 'needsInput', text: 'Needs your answer', question: 'Reviewer asks to rename the module; do it?' }, { pushed: null, notPushedReason: 'awaitingAnswer', report: null })))
  assert.equal(model.card, 'waiting')
  assert.equal(model.waiting?.question, 'Reviewer asks to rename the module; do it?')
  assert.equal(model.waiting?.resume, 'cd ~/dev/orbit && claude --resume 9a8b')
})

test('a report is opened by its file name only, and only a Markdown file name will do', () => {
  assert.equal(reportName('~/agents/output/FIX-101.md'), 'FIX-101.md')
  assert.equal(reportName('FIX-101.md'), 'FIX-101.md')
  assert.equal(reportName(null), null)
  assert.equal(reportName('~/agents/output/'), null)
  assert.equal(reportName('~/agents/output/FIX-101.txt'), null)
  assert.equal(reportName('~/agents/output/a b.md'), null)
})

const fixResult = (patch: Record<string, unknown> = {}): RunView['result'] => ({
  schema: 'pit-crew/fix-result@1', command: 'fix-pr', status: 'done',
  target: { repo: 'owner/name', pr: 101, branch: 'fix/retry' }, head: { sha: '755b78b2c4e1f0a9d3b6e8c7a5f4d2e1b0c9a8f7' },
  requests: [
    { id: 'T1', kind: 'thread', author: 'sam', path: 'src/retry.ts', line: 4, outdated: false, url: 'https://example.test/t1', summary: 'Back off', triage: 'clear', outcome: 'fixed', commits: ['1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d'] },
    { id: 'R1', kind: 'review', author: 'sam', path: null, line: null, outdated: false, url: 'https://example.test/r1', summary: 'Rename', triage: 'outOfScope', outcome: 'notFixed', commits: [] },
  ],
  checks: [{ name: 'pnpm test', result: 'passed' }],
  pushed: { branch: 'fix/retry', head: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d', commits: [{ sha: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d', subject: 'Back off between retries' }] },
  notPushedReason: null, worktree: null, report: '~/agents/output/FIX-101.md', question: null, error: null,
  ...patch,
} as unknown as RunView['result'])

test('previous Fix sessions read as the server says: pushed, nothing to fix, not pushed and why, push refused', () => {
  const done = (patch: Record<string, unknown>) => runText({ status: 'done', note: null, result: fixResult(patch) })
  assert.deepEqual(done({}), { text: 'Fixed · pushed 1 commit', tone: 'green' })
  assert.equal(done({ pushed: { branch: 'fix/retry', head: 'a'.repeat(40), commits: [{ sha: 'a'.repeat(40), subject: 'x' }, { sha: 'b'.repeat(40), subject: 'y' }] } }).text, 'Fixed · pushed 2 commits')
  assert.deepEqual(done({ pushed: null, notPushedReason: 'nothingToFix' }), { text: 'Nothing to fix', tone: 'gray' })
  assert.deepEqual(done({ pushed: null, notPushedReason: 'checksFailed' }), { text: 'Not pushed · checks failed', tone: 'amber' })
  assert.deepEqual(done({ pushed: null, notPushedReason: 'checksNotRun' }), { text: 'Not pushed · checks not run', tone: 'amber' })
  assert.deepEqual(done({ pushed: null, notPushedReason: 'awaitingAnswer' }), { text: 'Not pushed', tone: 'amber' })
  assert.deepEqual(done({ pushed: null, notPushedReason: 'pushFailed' }), { text: 'Not pushed · push refused', tone: 'amber' })
  assert.deepEqual(runText({ status: 'failed', note: 'git push was rejected', result: fixResult({ status: 'failed', pushed: null, notPushedReason: 'pushFailed' }) }), { text: 'Failed · push refused', tone: 'red' })
  // Pit View's own failure kinds come first, as on the server
  assert.equal(runText({ status: 'failed', note: 'noReport', result: fixResult({ pushed: null, notPushedReason: 'pushFailed' }) }).text, 'Failed · no report')
  assert.equal(runText({ status: 'failed', note: 'badResult: pushed.branch other is not the target branch', result: fixResult() }).text, 'Failed · bad result')
  assert.equal(runText({ status: 'needsInput', note: null, result: fixResult({ status: 'needsInput', pushed: null, notPushedReason: 'awaitingAnswer' }) }).text, 'Needs your answer')
})

test('a Fix session read from the runs list gets the same summary and text the server would send', () => {
  const run = runView({ id: 9, command: 'fix-pr', label: 'Fix session', status: 'done', finishedAt: ago(s), result: fixResult() })
  const cell = cellFromRun(own(), run)
  assert.equal(cell.text, 'Fixed · pushed 1 commit')
  assert.deepEqual(cell.result, {
    kind: 'fix', requests: 2,
    triage: { needsJudgment: 0, noChange: 0, disagree: 0, outOfScope: 1, clear: 1 },
    outcomes: { fixed: 1, notFixed: 1, awaitingAnswer: 0 },
    pushed: { branch: 'fix/retry', head: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d', count: 1, commits: [{ sha: '1a2b3c4', subject: 'Back off between retries' }] },
    notPushedReason: null, checks: [{ name: 'pnpm test', result: 'passed' }], worktree: null, report: '~/agents/output/FIX-101.md',
  })
  assert.equal(summaryOf(null), null)
  assert.equal(summaryOf({ schema: 'pit-crew/review-result@1', verdict: 'clean', recommendation: null, findings: [], ci: 'green', posted: null, notPostedReason: 'ownPr', report: null } as unknown as RunView['result'])?.kind, 'review')
})

test('a Fix session\'s report on disk carries a Fix tag and no verdict chip or Tandem tag', () => {
  const rows = reportRows([
    { name: 'FIX-101.md', kind: 'fix', modifiedAt: ago(m), sha: 'aaaaaaa', verdict: null, tandem: false },
    { name: 'PR-101.md', kind: 'review', modifiedAt: ago(h), sha: null, verdict: 'clean', tandem: false },
  ])
  assert.deepEqual(rows[0], { name: 'FIX-101.md', modifiedAt: ago(m), sha: 'aaaaaaa', fix: true, verdict: null, tandem: false, openName: 'Open report FIX-101.md' })
  assert.equal(rows[1]?.fix, false)
  assert.deepEqual(rows[1]?.verdict, { text: 'Clean', tone: 'green' })
  // a fix listing never shows a verdict, whatever it carries
  assert.equal(reportRows([{ name: 'FIX-101.md', kind: 'fix', modifiedAt: ago(m), sha: null, verdict: 'clean', tandem: true }])[0]?.verdict, null)
})
