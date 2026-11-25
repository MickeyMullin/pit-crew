// test/relevancy.test.ts
// the Relevancy check's server half (section 8 of DESIGN.md, Relevancy command): its result schema, how a run settles from it, the cell and the done text it gives, the start the drawer offers on the viewer's own PRs alone, and the Fix session's offer of the prompt it wrote. Nothing here runs git or gh
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Run } from '../src/cache.ts'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import type { RawOpenPr } from '../src/github.ts'
import { agentCell, claudeOnly, doneText, fixOfferOf, judge, notOffered, parseResult, relevancyMismatch, reportPath, startKinds, startOptions } from '../src/launcher.ts'
import type { RelevancyResult, RunResultJson } from '../src/launcher.ts'
import { scenario } from './fixtures/scenario.ts'
import { fixRequest, fixResult, openPage1, openPage2, relevancyHead, relevancyResult, relevancyUpstream } from './helpers.ts'

const config = (): Config => ({ ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit' })

const prOf = async (number: number, sha = relevancyHead): Promise<RawOpenPr> => {
  const nodes = [...(await openPage1()).data.repository!.pullRequests.nodes, ...(await openPage2()).data.repository!.pullRequests.nodes]
  const pr = nodes.find((node) => node.number === number)
  assert.ok(pr !== undefined, `#${number} is in the fixtures`)
  return { ...pr, headRefOid: sha }
}

const relevancyRun = (result: Record<string, unknown> | null, patch: Partial<Run> = {}): Run => ({
  extraInstructions: null, models: null, jumped: false,
  id: 12, repo: scenario.repo, number: 104, command: 'relevancy-pr', args: ['104'], label: 'Relevancy check', runner: 'claude',
  cwd: '~/dev/orbit', dir: '~/.local/state/pit-view/runs/12', sessionId: 'sess-12', pid: 4012, pidStartedAt: 'start-4012',
  startedAt: '2026-11-20T14:00:00Z', lastStepAt: null, step: null, stepState: null, steps: null, finishedAt: '2026-11-20T14:03:00Z',
  status: (result?.status as Run['status'] | undefined) ?? 'done', result: result as unknown as RunResultJson | null, note: null, costUsd: null,
  resume: 'cd ~/dev/orbit && claude --resume sess-12', resolvedByHand: false, firstNote: null, reportHash: null, postAttemptedAt: null, origin: 'manual', tick: null, reason: null, queuedAt: null, posting: false, worktree: null, headOid: null, ...patch,
})

const parsed = (patch: Record<string, unknown> = {}): RelevancyResult => {
  const read = parseResult(JSON.stringify(relevancyResult(patch)))
  assert.equal(read.ok, true, read.ok ? '' : read.error)
  return (read as { ok: true, value: RelevancyResult }).value
}

const settle = { stopped: false, restarted: false, exit: { code: 0, signal: null, error: null }, denials: [], lastEvent: null }

const prompt = 'In src/retry.ts, call the renamed backoffDelay from src/timing.ts instead of computeDelay, which #88 removed, and update the test in test/retry.test.ts to match.'
const irrelevant = { verdict: 'irrelevant', reason: 'Addressed by #88, which added the same backoff to main.', needsUpdates: false, fixPrompt: null }
const needsUpdates = { verdict: 'relevant', reason: 'Still needed, but it calls computeDelay, which #88 renamed.', needsUpdates: true, fixPrompt: prompt }

test('a relevancy result is checked against pit-crew/relevancy-result@1: relevant, irrelevant, relevant needing updates, a stop to ask, and an early failure', () => {
  parsed()
  parsed(irrelevant)
  parsed(needsUpdates)
  parsed({ status: 'needsInput', verdict: null, reason: null, needsUpdates: null, question: 'The PR body names two features: judge which?' })
  parsed({ status: 'failed', target: null, head: null, upstream: null, verdict: null, reason: null, needsUpdates: null, error: 'this PR is not yours' })
  const refusals: [Record<string, unknown>, RegExp][] = [
    [(({ upstream: _upstream, ...rest }) => rest)(relevancyResult()), /upstream is missing/],
    [(({ fixPrompt: _prompt, ...rest }) => rest)(relevancyResult()), /fixPrompt is missing/],
    [relevancyResult({ command: 'fix-pr' }), /command must be relevancy-pr/],
    [relevancyResult({ verdict: 'stale' }), /verdict must be relevant, irrelevant or null/],
    [relevancyResult({ needsUpdates: 'yes' }), /needsUpdates must be true, false or null/],
    [relevancyResult({ reason: 7 }), /reason must be a string or null/],
    [relevancyResult({ fixPrompt: ['change it'] }), /fixPrompt must be a string or null/],
    [relevancyResult({ head: { sha: relevancyHead.slice(0, 7) } }), /head must be null or \{ sha \}/],
    [relevancyResult({ upstream: { sha: 'main' } }), /upstream must be null or \{ sha \}/],
    [relevancyResult({ target: { repo: scenario.repo, pr: 104 } }), /target must be null or \{ repo, pr, base \}/],
    [relevancyResult({ target: { repo: scenario.repo, pr: 0, base: 'main' } }), /target must be null or \{ repo, pr, base \}/],
  ]
  for (const [value, message] of refusals) {
    const read = parseResult(JSON.stringify(value))
    assert.equal(read.ok, false, String(message))
    assert.match(read.ok ? '' : read.error, message)
  }
})

test('a relevancy result that contradicts itself is a bad result, kept for the drawer', () => {
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ verdict: null, reason: null, needsUpdates: null }, /a done relevancy result carries no verdict/],
    [{ reason: null }, /reason is null while verdict is relevant/],
    [{ needsUpdates: null }, /needsUpdates is null while verdict is relevant/],
    [{ verdict: null }, /verdict is null while reason is set/],
    [{ ...irrelevant, needsUpdates: true, fixPrompt: prompt }, /an irrelevant PR needs no updates/],
    [{ needsUpdates: true, fixPrompt: null }, /needsUpdates is true but fixPrompt is null/],
    [{ needsUpdates: false, fixPrompt: prompt }, /fixPrompt is set but needsUpdates is not true/],
    [{ ...needsUpdates, fixPrompt: '   ' }, /fixPrompt is empty/],
    [{ ...needsUpdates, fixPrompt: 'x'.repeat(2001) }, /fixPrompt must be at most 2,000 characters; it has 2,001/],
    [{ ...needsUpdates, fixPrompt: 'fix it\u0007' }, /fixPrompt must be plain text/],
    [{ reason: 'x'.repeat(501) }, /reason must be at most 500 characters; it has 501/],
    [{ reason: 'two\nlines' }, /reason must be one line of plain text/],
    [{ reason: '' }, /reason is empty/],
  ]
  for (const [patch, message] of bad) {
    const value = parsed(patch)
    assert.match(relevancyMismatch(value) ?? '', message, String(message))
    const judged = judge({ ...settle, reportExists: null, parsed: { ok: true, value } })
    assert.equal(judged.status, 'failed', String(message))
    assert.match(judged.note ?? '', /^badResult: /)
    assert.equal(judged.result, value, 'the result is kept')
  }
  for (const good of [{}, irrelevant, needsUpdates, { reason: 'x'.repeat(500) }, { ...needsUpdates, fixPrompt: `${'y'.repeat(1990)}\n\tz` }]) assert.equal(relevancyMismatch(parsed(good)), null)
  // a stop to ask or a failure before judging carries no verdict and that is no contradiction
  assert.equal(relevancyMismatch(parsed({ status: 'failed', verdict: null, reason: null, needsUpdates: null, error: 'no clone here' })), null)
})

test('a relevancy run writes no report, so a done result settles done without one', () => {
  for (const value of [parsed(), parsed(irrelevant), parsed(needsUpdates)]) {
    assert.equal(reportPath(value), null)
    const done = judge({ ...settle, reportExists: null, parsed: { ok: true, value } })
    assert.deepEqual([done.status, done.note], ['done', null])
  }
})

test('the cell says Relevant or Irrelevant, and only those two, for a done run, whether or not updates are needed', () => {
  assert.equal(doneText(relevancyRun(relevancyResult()), false), 'Relevant')
  assert.equal(doneText(relevancyRun(relevancyResult(needsUpdates)), false), 'Relevant')
  assert.equal(doneText(relevancyRun(relevancyResult(irrelevant)), false), 'Irrelevant')
  assert.equal(doneText(relevancyRun(relevancyResult(irrelevant)), true), 'Irrelevant', 'an own draft changes nothing')
  assert.equal(doneText({ ...relevancyRun(relevancyResult(irrelevant)), resolvedByHand: true }, false), 'Irrelevant · finished by hand')
  assert.equal(doneText(relevancyRun(relevancyResult({ status: 'needsInput', verdict: null, reason: null, needsUpdates: null, question: 'Which?' })), false), 'Needs your answer')
  assert.equal(doneText(relevancyRun(relevancyResult({ status: 'failed', verdict: null, reason: null, needsUpdates: null, error: 'no clone here' })), false), 'Failed')
})

test('the cell carries the verdict, the reason, the flag, and the prompt, and goes idle once the head moves on', async () => {
  const pr = await prOf(104)
  for (const [patch, summary] of [
    [{}, { kind: 'relevancy', verdict: 'relevant', reason: 'The retry backoff the PR adds is still missing on main.', needsUpdates: false, fixPrompt: null, base: 'main', upstream: relevancyUpstream.slice(0, 7) }],
    [irrelevant, { kind: 'relevancy', verdict: 'irrelevant', reason: irrelevant.reason, needsUpdates: false, fixPrompt: null, base: 'main', upstream: relevancyUpstream.slice(0, 7) }],
    [needsUpdates, { kind: 'relevancy', verdict: 'relevant', reason: needsUpdates.reason, needsUpdates: true, fixPrompt: prompt, base: 'main', upstream: relevancyUpstream.slice(0, 7) }],
  ] as const) {
    const cell = agentCell(pr, config(), relevancyRun(relevancyResult(patch)), undefined)
    assert.equal(cell.state, 'done')
    assert.deepEqual(cell.result, summary)
    assert.equal(cell.commit, relevancyHead)
  }
  const moved = agentCell(await prOf(104, 'f'.repeat(40)), config(), relevancyRun(relevancyResult(irrelevant)), undefined)
  assert.equal(moved.state, 'idle')
  assert.equal(moved.runId, 12, 'the run is still attached')
})

test('Check relevancy is a start of the viewer\'s own PRs alone, on Claude or Codex, read-only, and never the default', async () => {
  assert.ok(startKinds.includes('relevancy'))
  const mine = await prOf(104)
  const entry = startOptions(mine, config(), null, false).find((option) => option.kind === 'relevancy')
  assert.deepEqual(entry, {
    kind: 'relevancy', label: 'Relevancy check', button: 'Check relevancy', command: 'relevancy-pr', args: ['104'], runners: ['claude', 'codex'],
    posts: { kind: 'nothing', text: 'Posts nothing and changes nothing: it reads the PR and its base branch and says whether the PR is still needed and whether it needs updates.' },
    repo: scenario.repo, viewer: scenario.viewer, unavailable: null,
  })
  assert.notEqual(startOptions(mine, config(), null, false)[0]?.kind, 'relevancy')
  assert.equal(notOffered('relevancy', mine, config(), null), null)
  assert.equal(claudeOnly('relevancy-pr', ['104']), false)
  for (const number of [113, 114]) {
    const theirs = await prOf(number)
    assert.equal(startOptions(theirs, config(), null, false).some((option) => option.kind === 'relevancy'), false, `#${number}`)
    assert.equal(notOffered('relevancy', theirs, config(), null), `Relevancy check is offered only on your own PRs, and #${number} is not yours`)
  }
})

test('a Fix session is offered with the relevancy prompt when the latest run is a done relevancy check of the current head that needs updates', async () => {
  const pr = await prOf(104)
  const latest = relevancyRun(relevancyResult(needsUpdates), { id: 30 })
  assert.deepEqual(fixOfferOf(pr, [latest]), { remote: false, selfReview: null, relevancy: { runId: 30 } })
  assert.equal(notOffered('fix', pr, config(), null, [latest]), null)
  assert.equal(startOptions(pr, config(), null, false, null, [latest]).find((option) => option.kind === 'fix')?.fix?.relevancy?.runId, 30)
  // none for a check with nothing to update, an irrelevant one, one of an older head, one that is not the latest run, or one that did not finish done
  const none: Run[][] = [
    [relevancyRun(relevancyResult(), { id: 30 })],
    [relevancyRun(relevancyResult(irrelevant), { id: 30 })],
    [relevancyRun(relevancyResult({ ...needsUpdates, head: { sha: 'f'.repeat(40) } }), { id: 30 })],
    [{ ...latest, id: 29 }, relevancyRun(null, { id: 31, command: 'review-pr', args: ['104', '--no-post'], status: 'stopped' })],
    [relevancyRun(relevancyResult(needsUpdates), { id: 30, status: 'failed', note: 'badResult: x' })],
  ]
  for (const runs of none) {
    assert.equal(fixOfferOf(pr, runs).relevancy, null)
    assert.match(notOffered('fix', pr, config(), null, runs) ?? '', /^Fix requested changes is not offered for #104/)
  }
})

test('a Fix session handed the relevancy prompt reports its requests as kind and source prompt, with no URL, and nothing else may claim either', () => {
  const prompt = fixRequest({ id: 'prompt-1', kind: 'prompt', source: 'prompt', priority: null, author: null, url: null, summary: 'Call createLogger instead of makeLogger' })
  const read = parseResult(JSON.stringify(fixResult({ requests: [fixRequest({ source: 'remote' }), prompt] })))
  assert.equal(read.ok, true, read.ok ? '' : read.error)
  const bad = (request: Record<string, unknown>, message: RegExp): void => {
    const result = parseResult(JSON.stringify(fixResult({ requests: [request] })))
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, message)
  }
  bad({ ...prompt, url: 'https://github.com/octo-example/orbit/pull/101#discussion_r1' }, /requests\[0\]\.url must be null for a prompt request/)
  bad({ ...prompt, kind: 'comment' }, /requests\[0\]\.kind must be thread, review, finding or prompt/)
  bad({ ...prompt, source: 'relevancy' }, /requests\[0\]\.source must be remote, local or prompt/)
  // a finding keeps its own rule
  bad(fixRequest({ kind: 'finding' }), /requests\[0\]\.url must be null for a finding/)
})

test('DESIGN.md pins pit-crew/relevancy-result@1 with exactly the fields the check reads, and emit-json.md names the same schema', async () => {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const design = await readFile(join(import.meta.dirname, '..', 'DESIGN.md'), 'utf8')
  const start = design.indexOf('`pit-crew/relevancy-result@1`, pinned with `relevancy-pr`')
  assert.ok(start >= 0, 'the table is pinned')
  const table = design.slice(start, design.indexOf('\n\n', design.indexOf('| Field |', start)))
  const fields = [...table.matchAll(/^\| (`[^|]+`) \|/gm)].flatMap((match) => [...match[1]!.matchAll(/`(\w+)`/g)].map((field) => field[1]!))
  assert.deepEqual(fields.filter((field) => field !== 'Field').sort(), Object.keys(relevancyResult()).sort())
  const emit = await readFile(join(import.meta.dirname, '..', '..', 'prompts', 'review', 'emit-json.md'), 'utf8')
  assert.match(emit, /"schema": "pit-crew\/relevancy-result@1"/)
  for (const field of Object.keys(relevancyResult())) assert.match(emit, new RegExp(`"${field}":`), field)
})
