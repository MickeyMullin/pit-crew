// test/ui-sweep.test.ts
// the Dependabot sweep's page logic in public/, run under Node: the bot group header's control, the confirmation, the drawer's models, the broom link, and the PR drawer's link, against sweeps built the way the server builds them (src/sweeps.ts)
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Sweep } from '../src/cache.ts'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { parseResult } from '../src/launcher.ts'
import type { SweepResult } from '../src/launcher.ts'
import { sweepStartOf, sweepView } from '../src/sweeps.ts'
import type { SweepsView, SweepView } from '../src/sweeps.ts'
import { stepTitle } from '../public/agent.ts'
import { applyPatch } from '../public/state.ts'
import {
  defaultSweepRunner, shownSweep, sweepAnnounceKey, sweepAnnouncement, sweepCards, sweepConfirmModel, sweepConfirmSignature, sweepHeaderModel, sweepLinkFor, sweepList,
  sweepResultModel, sweepRowModel, sweepRunningModel, sweepStartRequest, sweepStopModel, sweepStopRequest, sweepTone, sweepWaitingModel,
} from '../public/sweepview.ts'
import { scenario } from './fixtures/scenario.ts'
import { emptySweepResult, sweepHead201, sweepHead202, sweepResult, sweepRow } from './helpers.ts'

const now = Date.parse('2026-10-26T18:00:00Z')

const config = (patch: Partial<Config> = {}): Config => ({ ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit', ...patch })

const record = (patch: Partial<Sweep> = {}): Sweep => ({
  id: 1, repo: scenario.repo, command: 'review-dependabot-sweep', args: [scenario.repo, '--parallel', '1'], label: 'Dependabot sweep', runner: 'claude',
  cwd: '~/dev/orbit', dir: '~/.local/state/pit-view/sweeps/1', sessionId: 's-1', pid: 4001, pidStartedAt: 'start-4001', startedAt: '2026-10-26T17:40:00Z',
  lastStepAt: null, step: null, stepState: null, steps: null, finishedAt: null, status: 'running', result: null, note: null, costUsd: null,
  resume: 'cd ~/dev/orbit && claude --resume s-1', ...patch,
})

const settled = (value: Record<string, unknown>, patch: Partial<Sweep> = {}): SweepView => {
  const parsed = parseResult(JSON.stringify(value))
  if (!parsed.ok) throw new Error(parsed.error)
  return sweepView(record({ status: 'done', finishedAt: '2026-10-26T17:55:00Z', result: parsed.value, ...patch }))
}

// a failed or waiting sweep may carry a null repo and null counts once the launcher's validation allows them; the view tolerates them whether or not it does yet, so these skip the parse
const settledLoose = (value: Record<string, unknown>, patch: Partial<Sweep> = {}): SweepView =>
  sweepView(record({ status: 'done', finishedAt: '2026-10-26T17:55:00Z', result: value as unknown as SweepResult, ...patch }))

const viewOf = (items: SweepView[], cfg: Config = config()): SweepsView => ({ start: sweepStartOf(cfg, items.some((sweep) => sweep.status === 'running')), items })

// the group header's control

test('the bot group header offers Run sweep, named for the repository, and no status before any sweep', () => {
  const model = sweepHeaderModel(viewOf([]), now)
  assert.deepEqual(model.start, { label: 'Run sweep', name: `Run a Dependabot sweep of ${scenario.repo}`, disabled: false, reason: null })
  assert.equal(model.status, null)
})

test('Run sweep says why it cannot start: a sweep in flight, or no clone configured', () => {
  const running = sweepView(record())
  const busy = sweepHeaderModel(viewOf([running]), now)
  assert.equal(busy.start.disabled, true)
  assert.match(busy.start.reason ?? '', /already in flight/)
  const noClone = config()
  delete noClone.cloneDir
  assert.match(sweepHeaderModel(viewOf([], noClone), now).start.reason ?? '', /set cloneDir/)
})

test('the status shows a running sweep, counts when done, the failure text, and the question, and its label holds nothing that moves with the clock', () => {
  const running = sweepView(record({ lastStepAt: '2026-10-26T17:59:40Z' }))
  const live = sweepHeaderModel(viewOf([running]), now).status
  assert.deepEqual([live?.running, live?.label, live?.tone, live?.text], [true, 'Sweep', 'blue', 'Sweep running 20m · last step 20s ago'])
  assert.equal(live?.name, 'Open the running Dependabot sweep')
  // two readings of the clock give the same label, so the button is not rebuilt for a tick
  assert.equal(sweepHeaderModel(viewOf([running]), now + 60_000).status?.label, live?.label)

  const done = sweepHeaderModel(viewOf([settled(sweepResult())]), now).status
  assert.deepEqual([done?.label, done?.tone, done?.text, done?.running], ['Sweep: Done · 2 swept', 'green', 'Sweep: Done · 2 swept · 5m ago', false])
  assert.match(done?.name ?? '', /^Open the Dependabot sweep of .*: Done · 2 swept$/)

  const failed = sweepHeaderModel(viewOf([sweepView(record({ status: 'failed', note: 'noResult: no result.json; exit code 1; last event: none', finishedAt: '2026-10-26T17:50:00Z' }))]), now).status
  assert.deepEqual([failed?.label, failed?.tone], ['Sweep: Failed · no result', 'red'])
  assert.match(failed?.tip ?? '', /ended without a valid result file/)

  const waiting = settledLoose(sweepResult({ status: 'needsInput', question: 'Close #202 first? (yes / no)', counts: null, rows: [], mergeOrder: [], summary: null }), { status: 'needsInput' })
  const asked = sweepHeaderModel(viewOf([waiting]), now).status
  assert.deepEqual([asked?.label, asked?.tone, asked?.tip], ['Sweep: Needs your answer', 'amber', 'Close #202 first? (yes / no)'])
})

test('the status follows the newest sweep, and a sweep with nothing to sweep is gray and done, never red', () => {
  const empty = settled(emptySweepResult(), { id: 3 })
  const older = settled(sweepResult(), { id: 2 })
  const model = sweepHeaderModel(viewOf([empty, older]), now)
  assert.equal(model.status?.sweepId, 3)
  assert.deepEqual([model.status?.label, model.status?.tone], ['Sweep: Done · nothing to sweep', 'gray'])
  assert.equal(sweepTone(settled(sweepResult({ counts: { swept: 3, fresh: 2, reused: 0, failed: 1 } }))), 'amber')
  assert.equal(sweepTone(sweepView(record({ status: 'stopped', finishedAt: '2026-10-26T17:50:00Z' }))), 'gray')
})

// the confirmation

test('the confirmation names the repository, says it runs one PR at a time, and that the reviewers may post as the viewer', () => {
  const start = sweepStartOf(config(), false)
  const model = sweepConfirmModel(start, 'claude')
  assert.match(model.heading, new RegExp(scenario.repo))
  assert.equal(model.repo, scenario.repo)
  assert.equal(model.command, `/review-dependabot-sweep ${scenario.repo} --parallel 1`)
  assert.match(model.serial, /one PR at a time/)
  assert.match(model.effect, /reviewers post on GitHub as @vera-quill/)
  assert.match(model.effect, /approve a clean bump/)
  assert.doesNotMatch(model.command, /--no-post/)
  assert.deepEqual(model.runners.map((runner) => runner.name), ['claude', 'codex'])
  assert.equal(model.confirm, 'Start sweep')
  // Codex gets a dollar sign, and the configured runner is offered first
  assert.equal(sweepConfirmModel(start, 'codex').command, `$review-dependabot-sweep ${scenario.repo} --parallel 1`)
  const codexStart = sweepStartOf(config({ agent: { runner: 'codex' } }), false)
  assert.equal(defaultSweepRunner(codexStart, codexStart.runner), 'codex')
  assert.equal(defaultSweepRunner(codexStart, 'claude'), 'claude')
  assert.equal(sweepStartOf(config({ agent: { runner: 'codex' } }), false).runner, 'codex')
})

test('a sweep is started and stopped with the token, a runner, the repository, and the viewer, the last two as the confirmation showed them, and nothing else', () => {
  const start = sweepStartRequest('codex', scenario.repo, scenario.viewer, 'tok-1')
  assert.equal(start.url, '/api/sweeps')
  assert.deepEqual(start.init.headers, { 'Content-Type': 'application/json', 'X-Pit-View-Token': 'tok-1' })
  assert.deepEqual(JSON.parse(start.init.body ?? ''), { runner: 'codex', repo: scenario.repo, viewer: scenario.viewer })
  const stop = sweepStopRequest(7, 'tok-1')
  assert.equal(stop.url, '/api/sweeps/7/stop')
  assert.deepEqual(stop.init.headers, { 'X-Pit-View-Token': 'tok-1' })
  assert.equal(stop.init.body, undefined)
  assert.match(sweepStopModel(sweepView(record())).heading, new RegExp(scenario.repo))
})

// the drawer

test('the drawer shows the whole result: counts, a card per PR, the merge order, and the summary path', () => {
  const sweep = settled(sweepResult())
  const model = sweepResultModel(sweep)
  assert.deepEqual([model.text, model.tone, model.empty], ['Done · 2 swept', 'green', false])
  assert.deepEqual(model.counts?.map((count) => [count.label, count.value]), [['Swept', 2], ['Fresh', 1], ['Reused', 1], ['Failed', 0]])
  assert.equal(model.rows.length, 2)
  const [first, second] = model.rows
  assert.deepEqual([first?.number, first?.url, first?.head, first?.bump, first?.recommendation, first?.ci, first?.posted, first?.reused, first?.escalation], [
    201, 'https://github.com/octo-example/orbit/pull/201', '2010000', 'left-pad 1.2.0 → 1.2.1 (patch)', { text: 'Approve', tone: 'green' }, { text: 'CI green', tone: 'green' },
    { text: 'Approved', url: 'https://github.com/octo-example/orbit/pull/201#pullrequestreview-9' }, false, null,
  ])
  assert.deepEqual([second?.title, second?.recommendation, second?.ci, second?.posted, second?.reused, second?.escalation, second?.findings, second?.notes], [
    'build(deps): bump right-pad from 2.0.0 to 3.0.0', { text: 'Hold', tone: 'amber' }, { text: 'CI failed', tone: 'red' }, { text: 'Not posted', url: null }, true,
    'a major version of a runtime dependency', [{ priority: 'P1', summary: 'Drops the callback form the importer still uses', tone: 'red' }], 'CI failed in the importer tests; unchanged since Oct 25',
  ])
  // the report opens in the panel when it is a PR report, and always keeps its path
  assert.deepEqual(first?.report, { name: 'PR-201.md', path: '~/agents/output/PR-201.md' })
  assert.deepEqual(model.order, [{ index: 1, action: 'Merge #201', prs: [201] }, { index: 2, action: 'Hold #202 until the importer moves off the callback form', prs: [202] }])
  assert.equal(model.summaryPath, '~/agents/output/dependabot-sweep-octo-example-orbit-2026-10-26.md')
})

test('a report that is not a PR report is shown as a path and never offered to the report panel', () => {
  const other = sweepRowModel({ ...settled(sweepResult()).result!.rows[0]!, report: '~/agents/output/dependabot-sweep-octo-example-orbit-2026-10-26.md' })
  assert.deepEqual(other.report, { name: null, path: '~/agents/output/dependabot-sweep-octo-example-orbit-2026-10-26.md' })
  assert.equal(sweepRowModel({ ...settled(sweepResult()).result!.rows[0]!, report: null }).report, null)
  assert.equal(sweepRowModel({ ...settled(sweepResult()).result!.rows[0]!, report: '~/agents/output/../../x/PR-1.md' }).report?.name, 'PR-1.md')
})

test('a sweep with nothing to sweep renders as done with zero counts, no rows, and no summary, and says so', () => {
  const model = sweepResultModel(settled(emptySweepResult()))
  assert.deepEqual([model.text, model.tone, model.empty, model.note], ['Done · nothing to sweep', 'gray', true, null])
  assert.deepEqual(model.counts?.map((count) => count.value), [0, 0, 0, 0])
  assert.deepEqual([model.rows, model.order, model.summaryPath], [[], [], null])
  assert.deepEqual(sweepCards(settled(emptySweepResult())), ['result'])
})

test('a failed sweep shows its note as a sentence, a stopped one says so, and a waiting one shows its question and the resume command', () => {
  const failed = settledLoose(sweepResult({ status: 'failed', error: 'the working directory is not a clone of the repository', repo: null, counts: null, rows: [], mergeOrder: [], summary: null }), { status: 'failed', note: 'the working directory is not a clone of the repository' })
  const model = sweepResultModel(failed)
  assert.deepEqual([model.text, model.tone, model.note, model.empty], ['Failed', 'red', 'the working directory is not a clone of the repository', false])
  const lost = sweepResultModel(sweepView(record({ status: 'failed', note: 'serverRestarted', finishedAt: '2026-10-26T17:50:00Z' })))
  assert.deepEqual([lost.text, lost.note], ['Failed · server restarted', 'Pit View restarted while the run was going and could not tell how it ended.'])
  assert.equal(sweepResultModel(sweepView(record({ status: 'stopped', finishedAt: '2026-10-26T17:50:00Z' }))).text, 'Stopped')
  const waiting = settledLoose(sweepResult({ status: 'needsInput', question: 'Close #202 first? (yes / no)', counts: null, rows: [], mergeOrder: [], summary: null }), { status: 'needsInput' })
  assert.deepEqual(sweepCards(waiting), ['waiting'])
  assert.deepEqual(sweepWaitingModel(waiting), { question: 'Close #202 first? (yes / no)', resume: 'cd ~/dev/orbit && claude --resume s-1' })
})

test('a running sweep shows the sweep\'s five steps under its own names, and the newest note', () => {
  const steps = [
    { step: 'resolveBase', state: 'done', at: '2026-10-26T17:41:00Z', note: null },
    { step: 'review', state: 'started', at: '2026-10-26T17:42:00Z', note: '3 of 7 reviewed' },
    { step: 'consolidate', state: 'pending', at: null, note: null },
    { step: 'writeReport', state: 'pending', at: null, note: null },
    { step: 'post', state: 'pending', at: null, note: null },
  ] as const
  const running = sweepView(record({ steps: [...steps] }))
  const model = sweepRunningModel(running)
  assert.deepEqual(model.steps.map((step) => [step.label, step.state]), [['Enumerate', 'done'], ['Review PRs', 'started'], ['Merge order', 'pending'], ['Write summary', 'pending'], ['Post', 'pending']])
  assert.deepEqual(model.note, { label: 'Review PRs', note: '3 of 7 reviewed' })
  assert.deepEqual(sweepCards(running), ['running'])
  // a review run's steps keep their own names
  assert.equal(stepTitle('review-pr', 'resolveBase'), 'Resolve base')
})

test('the drawer shows the sweep asked for, otherwise the newest, and lists the earlier ones', () => {
  const newest = settled(sweepResult(), { id: 3 })
  const older = settled(emptySweepResult(), { id: 2 })
  assert.equal(shownSweep([newest, older], null)?.id, 3)
  assert.equal(shownSweep([newest, older], 2)?.id, 2)
  assert.equal(shownSweep([newest, older], 99)?.id, 3)
  assert.equal(shownSweep([], null), null)
  assert.deepEqual(sweepList([newest, older], 2).map((row) => [row.id, row.text, row.selected]), [[3, 'Done · 2 swept', false], [2, 'Done · nothing to sweep', true]])
})

// the links from a PR to its sweep

test('a Dependabot PR in a settled sweep at its current head links to that sweep, named with its date; one in no sweep has no link', () => {
  const sweep = settled(sweepResult())
  const link = sweepLinkFor([sweep], 201, sweepHead201.slice(0, 7), 'UTC')
  assert.deepEqual(link, {
    sweepId: 1, number: 201, when: 'Mon Oct 26 5:55 PM',
    name: 'Open #201 in the Dependabot sweep of Mon Oct 26 5:55 PM', tip: 'Dependabot sweep of Mon Oct 26 5:55 PM',
  })
  assert.equal(sweepLinkFor([sweep], 202, sweepHead202, 'UTC')?.number, 202)
  // in no sweep, or not at the head the sweep read, or an unknown head: no broom
  assert.equal(sweepLinkFor([sweep], 203, 'abcdef0'), null)
  assert.equal(sweepLinkFor([sweep], 201, 'abcdef0'), null)
  assert.equal(sweepLinkFor([sweep], 201, ''), null)
  assert.equal(sweepLinkFor([], 201, sweepHead201), null)
})

test('only a settled sweep links, and the newest sweep that read the PR at this head wins', () => {
  const running = sweepView(record({ id: 5 }))
  const failedWithRows = settled(sweepResult(), { id: 4, status: 'failed', note: 'noReport: x' })
  const waiting = settled(sweepResult({ status: 'needsInput', question: 'q' }), { id: 6, status: 'needsInput' })
  const old = settled(sweepResult(), { id: 2 })
  const newer = settled(sweepResult({ rows: [sweepRow()] }), { id: 3 })
  assert.equal(sweepLinkFor([running, failedWithRows, waiting], 201, sweepHead201), null)
  assert.equal(sweepLinkFor([old, newer], 201, sweepHead201)?.sweepId, 3)
  // a newer sweep that saw the PR at another head does not take it from an older one at this head
  const moved = settled(sweepResult({ rows: [sweepRow({ head: '9990000000000000000000000000000000000999' })] }), { id: 7 })
  assert.equal(sweepLinkFor([moved, old], 201, sweepHead201)?.sweepId, 2)
  assert.equal(sweepLinkFor([moved, old], 201, '9990000')?.sweepId, 7)
})

test('the sweeps arrive in a patch whole, and a patch without them leaves them alone', () => {
  const sweep = settled(sweepResult())
  const view = { version: 1, now: '', repo: scenario.repo, sweeps: viewOf([]), mine: { groups: [] }, others: { groups: [] } } as unknown as Parameters<typeof applyPatch>[0]
  const next = applyPatch(view, { version: 2, now: '', rows: [], removed: [], closed: null, sweeps: viewOf([sweep]) })
  assert.deepEqual(next.sweeps.items.map((item) => item.id), [1])
  const same = applyPatch(next, { version: 3, now: '', rows: [], removed: [], closed: null })
  assert.deepEqual(same.sweeps.items.map((item) => item.id), [1])
})

test('a change of the newest sweep\'s status is announced once, and the first reading says nothing about what was already there', () => {
  const running = sweepView(record())
  const done = settled(sweepResult())
  assert.equal(sweepAnnounceKey([]), 'none')
  assert.notEqual(sweepAnnounceKey([running]), sweepAnnounceKey([done]))
  assert.equal(sweepAnnouncement([]), null)
  assert.equal(sweepAnnouncement([running]), `Dependabot sweep of ${scenario.repo} started`)
  assert.equal(sweepAnnouncement([done]), `Dependabot sweep of ${scenario.repo} finished: Done · 2 swept`)
})

// the DOM modules are not run under Node; their wiring is checked as source

test('the bot group header, the broom, and the PR drawer are wired to the sweep models, with the group\'s collapse button kept', async () => {
  const dir = join(import.meta.dirname, '..', 'public')
  const tables = await readFile(join(dir, 'tables.ts'), 'utf8')
  assert.match(tables, /sweepControls\(sweep\)/)
  assert.match(tables, /model\.table === 'others' && group\.key === 'bots'/)
  // the collapse toggle is still the last child of the group bar
  assert.match(tables, /sweep === null \? null : sweepControls\(sweep\),\s+toggle\)/)
  assert.match(tables, /sweepLinkFor\(view\.sweeps\.items, row\.number, row\.headOid\)/)
  assert.match(tables, /'aria-label': link\.name,\s+title: link\.tip,/)
  const drawer = await readFile(join(dir, 'drawer.ts'), 'utf8')
  assert.match(drawer, /options\.sweepLink\(number\)/)
  const app = await readFile(join(dir, 'app.ts'), 'utf8')
  assert.match(app, /sweepLink: \(number\) =>/)
  // the Agent cell never carries sweep state
  assert.doesNotMatch(await readFile(join(dir, 'agent.ts'), 'utf8'), /sweeps?\./)
})

// the confirmation re-renders whenever anything it displays changes

test('the start confirmation\'s signature changes with the repository, the viewer, the effect text, the command, and the availability, and with nothing else', () => {
  const base = config()
  const sig = (cfg: Config, runner: 'claude' | 'codex' = 'claude', busy = false) => sweepConfirmSignature(sweepStartOf(cfg, busy), runner)
  const reference = sig(base)
  assert.equal(sig(config()), reference)
  assert.notEqual(sig(config({ repo: 'octo-example/other' })), reference)
  assert.notEqual(sig(config({ viewer: 'someone-else' })), reference)
  assert.notEqual(sig(base, 'codex'), reference)
  assert.notEqual(sig(config({ cloneDir: undefined })), reference)
  assert.notEqual(sig(base, 'claude', true), reference)
  // a setting the confirmation does not show leaves it alone
  assert.equal(sig(config({ refreshSeconds: 120 })), reference)
})

test('the confirmation\'s heading, repository, and effect text follow the configuration they are built from', () => {
  const other = sweepConfirmModel(sweepStartOf(config({ repo: 'octo-example/other', viewer: 'someone-else' }), false), 'claude')
  assert.match(other.heading, /octo-example\/other/)
  assert.equal(other.repo, 'octo-example/other')
  assert.equal(other.viewer, 'someone-else')
  assert.match(other.effect, /@someone-else/)
  assert.match(other.command, /octo-example\/other/)
})

test('the drawer\'s start part keys its rebuild on that signature, and the request carries the repository and viewer on screen', async () => {
  const source = await readFile(join(import.meta.dirname, '..', 'public', 'sweepdrawer.ts'), 'utf8')
  assert.match(source, /sweepConfirmSignature\(view\.start, confirm\.runner\)/)
  assert.match(source, /sweepStartRequest\(asked\.runner, confirmedRepo, confirmedViewer, options\.token\)/)
})

test('a confirmation built before a viewer change keeps naming the old viewer, and its request carries that viewer, not the new one', () => {
  const shown = sweepConfirmModel(sweepStartOf(config(), false), 'claude')
  const switched = sweepConfirmModel(sweepStartOf(config({ viewer: 'someone-else' }), false), 'claude')
  assert.equal(shown.viewer, scenario.viewer)
  assert.match(shown.effect, new RegExp(`@${scenario.viewer}`))
  assert.deepEqual(JSON.parse(sweepStartRequest('claude', shown.repo, shown.viewer, 't').init.body ?? ''), { runner: 'claude', repo: scenario.repo, viewer: scenario.viewer })
  assert.equal(JSON.parse(sweepStartRequest('claude', switched.repo, switched.viewer, 't').init.body ?? '').viewer, 'someone-else')
})

test('every report path in a sweep row has a Copy control named for its PR, the same copyButton the summary path uses', async () => {
  const source = await readFile(join(import.meta.dirname, '..', 'public', 'sweepdrawer.ts'), 'utf8')
  assert.match(source, /copyButton\(`Copy the report path for #\$\{row\.number\}`, row\.report\.path, `Report path for #\$\{row\.number\} copied`, `copy-report-\$\{row\.number\}`\)/)
  // the path is shown in both forms (a PR report with its button, any other as text), and the Copy follows it in both
  const report = source.slice(source.indexOf("class: 'sweep-row-report'"), source.indexOf('const resultCard'))
  assert.equal(report.match(/copyButton\(/g)?.length, 1)
  assert.match(report, /h\('code', \{ class: 'mono' \}, row\.report\.path\)/)
  assert.match(report, /sweep-report-path/)
})

// a settled sweep shows the whole result it carries

test('a failed sweep with counts shows them with its rows, merge order, and the error, and a failed one with null counts shows none and no zeros', () => {
  const withCounts = settled(sweepResult({ status: 'failed', error: 'the summary could not be written', summary: null }), { status: 'failed', note: 'the summary could not be written' })
  const model = sweepResultModel(withCounts)
  assert.deepEqual(model.counts?.map((count) => [count.label, count.value]), [['Swept', 2], ['Fresh', 1], ['Reused', 1], ['Failed', 0]])
  assert.deepEqual(model.rows.map((row) => row.number), [201, 202])
  assert.equal(model.order.length > 0, true)
  assert.match(model.note ?? '', /summary could not be written/)
  assert.deepEqual(sweepCards(withCounts), ['result'])
  const bare = settledLoose(sweepResult({ status: 'failed', error: 'no clone', repo: null, counts: null, rows: [], mergeOrder: [], summary: null }), { status: 'failed', note: 'no clone' })
  const empty = sweepResultModel(bare)
  assert.equal(empty.counts, null)
  assert.equal(empty.empty, false)
  assert.deepEqual(sweepCards(bare), ['result'])
})

test('a waiting sweep shows its question and the result it has so far, and only its question when it has none', () => {
  const partial = settledLoose(sweepResult({ status: 'needsInput', question: 'Close #202 first? (yes / no)', summary: null }), { status: 'needsInput' })
  assert.deepEqual(sweepCards(partial), ['waiting', 'result'])
  const model = sweepResultModel(partial)
  assert.deepEqual(model.counts?.map((count) => count.value), [2, 1, 1, 0])
  assert.equal(model.question, 'Close #202 first? (yes / no)')
  const bare = settledLoose(sweepResult({ status: 'needsInput', question: 'Close #202 first? (yes / no)', counts: null, rows: [], mergeOrder: [], summary: null }), { status: 'needsInput' })
  assert.deepEqual(sweepCards(bare), ['waiting'])
  assert.equal(sweepResultModel(bare).counts, null)
})
