// test/ui-agent.test.ts
// the Agent cell's words and requests (public/agent.ts): each state's text, the running timer, the
// confirmation per action, the requests with the per-start token, refusals, and announcements
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  announcements, cellModel, commandLine, doneTone, formatDuration, githubEffect, refusalText, runningLine, startConfirm,
  startRequest, stepText, stopConfirm, stopRequest, tokenHeader,
} from '../public/agent.ts'
import type { AgentCell } from '../public/agent.ts'
import { tokenHeader as serverTokenHeader, tokenMeta } from '../src/server.ts'

const now = Date.parse('2026-10-28T15:00:00Z')
const ago = (ms: number): string => new Date(now - ms).toISOString()
const s = 1000
const m = 60 * s
const h = 60 * m
const d = 24 * h

const idle = (patch: Partial<AgentCell> = {}): AgentCell => ({
  state: 'idle',
  label: 'Review',
  action: { kind: 'review', label: 'Review', command: 'review-pr', args: ['101'], runner: 'claude' },
  lastReviewAt: null,
  runId: null, runner: null, command: null, args: null, status: null, startedAt: null, lastStepAt: null, step: null,
  finishedAt: null, text: null, result: null, question: null, note: null, resume: null, costUsd: null,
  ...patch,
})

const running = (patch: Partial<AgentCell> = {}): AgentCell => idle({
  state: 'running', runId: 7, runner: 'claude', command: 'review-pr', args: ['101'], status: 'running',
  startedAt: ago(3 * m + 5 * s), lastStepAt: ago(20 * s), step: { name: 'review', state: 'started' }, ...patch,
})

const done = (patch: Partial<AgentCell> = {}): AgentCell => running({
  state: 'done', status: 'done', finishedAt: ago(17 * h), text: 'Changes requested', step: { name: 'post', state: 'done' }, ...patch,
})

test('an idle cell offers its action, named with the PR, with the last review under it when there is one', () => {
  assert.deepEqual(cellModel(idle(), 101, now), { state: 'idle', button: 'Review', name: 'Review #101', under: null })
  const again = idle({ label: 'Re-review', action: { kind: 'reReview', label: 'Re-review', command: 'review-pr', args: ['101'], runner: 'claude' }, lastReviewAt: ago(7 * d + h) })
  assert.deepEqual(cellModel(again, 101, now), { state: 'idle', button: 'Re-review', name: 'Re-review #101', under: 'last review 7d ago' })
  const self = idle({ action: { kind: 'selfReview', label: 'Self-review', command: 'review-pr', args: ['102', '--no-post'], runner: 'claude' }, lastReviewAt: ago(5 * s) })
  assert.deepEqual(cellModel(self, 102, now), { state: 'idle', button: 'Self-review', name: 'Self-review #102', under: 'last review just now' })
})

test('the running line counts the run and the newest step, in seconds, minutes, then hours', () => {
  assert.equal(runningLine(running(), now), 'running 3m · last step 20s ago')
  assert.equal(runningLine(running({ startedAt: ago(12 * s), lastStepAt: null }), now), 'running 12s · starting')
  assert.equal(runningLine(running({ startedAt: ago(h + 4 * m), lastStepAt: ago(3 * s) }), now), 'running 1h 4m · last step just now')
  assert.equal(runningLine(running({ lastStepAt: ago(2 * m + 10 * s) }), now + 60 * s), 'running 4m · last step 3m ago')
  assert.equal(formatDuration(ago(2 * h), now), '2h')
  // a clock a little behind the server's never reads negative
  assert.equal(formatDuration(ago(-5 * s), now), '0s')
})

test('a running cell names its label, its step for screen readers and tooltips, and Stop with the PR', () => {
  assert.deepEqual(cellModel(running(), 101, now), {
    state: 'running', label: 'Review', line: 'running 3m · last step 20s ago', step: 'Step: review, started', stop: 'Stop run on #101',
  })
  assert.equal(stepText({ name: 'writeReport', state: 'done' }), 'Step: write report, done')
  assert.equal(stepText({ name: 'consolidate', state: 'skipped' }), 'Step: consolidate, skipped')
  assert.equal(stepText(null), 'Starting: no step recorded yet')
})

test('a done cell shows the server\'s text and when it finished, colored by what comes next', () => {
  const model = cellModel(done(), 101, now)
  assert.deepEqual(model, { state: 'done', text: 'Changes requested', tone: 'red', line: 'finished 17h ago', tip: null, copy: null, again: null })
  const tones = (text: string, status: AgentCell['status'] = 'done') => doneTone({ status, text })
  assert.equal(tones('Approved'), 'green')
  assert.equal(tones('Clean'), 'green')
  assert.equal(tones('Clean · mark ready?'), 'green')
  assert.equal(tones('Clean · CI failed'), 'amber')
  assert.equal(tones('Approved · post failed'), 'amber')
  assert.equal(tones('Done'), 'gray')
  assert.equal(tones('Needs your answer', 'needsInput'), 'amber')
  assert.equal(tones('Stopped', 'stopped'), 'gray')
  assert.equal(tones('Failed · no result', 'failed'), 'red')
})

test('a run waiting for an answer shows its question and offers the resume command to copy', () => {
  const waiting = done({
    status: 'needsInput', text: 'Needs your answer', question: 'The tandem draft fails its checks; consolidate anyway?',
    resume: 'cd ~/dev/orbit && claude --resume 6f1c', finishedAt: ago(30 * s),
  })
  assert.deepEqual(cellModel(waiting, 104, now), {
    state: 'done', text: 'Needs your answer', tone: 'amber', line: 'finished 30s ago',
    tip: 'The tandem draft fails its checks; consolidate anyway?',
    copy: { name: 'Copy resume command for #104', command: 'cd ~/dev/orbit && claude --resume 6f1c' }, again: null,
  })
  // no session yet means nothing to copy
  assert.equal((cellModel(done({ status: 'needsInput', text: 'Needs your answer', question: 'Post?', resume: null }), 104, now) as { copy: unknown }).copy, null)
})

test('a failed or stopped run shows why in a tooltip and offers its action again', () => {
  const failed = cellModel(done({ status: 'failed', text: 'Failed · no result', note: 'noResult: exited with code 1' }), 101, now)
  assert.equal(failed.state === 'done' && failed.tip, 'noResult: exited with code 1')
  assert.deepEqual(failed.state === 'done' && failed.again, { name: 'Review #101 again' })
  const stopped = cellModel(done({ status: 'stopped', text: 'Stopped', note: null }), 101, now)
  assert.deepEqual(stopped.state === 'done' && [stopped.tip, stopped.again], [null, { name: 'Review #101 again' }])
  // a finished review's outcome stands until the head moves, so it offers nothing more here
  const finished = cellModel(done(), 101, now)
  assert.equal(finished.state === 'done' && finished.again, null)
})

test('the confirmation names the PR, the exact command, the runner and what happens on GitHub', () => {
  const row = { number: 101, title: 'fix(retry): back off between attempts' }
  assert.deepEqual(startConfirm(row, idle().action, 'claude', 'viewer'), {
    heading: 'Review #101?',
    title: 'fix(retry): back off between attempts',
    command: '/review-pr 101',
    runner: 'Claude Code',
    effect: 'Posts its report to the PR as @viewer: an approval, a request for changes, or a comment, per the findings.',
    confirm: 'Start review',
  })
  const self = { label: 'Self-review', command: 'review-pr', args: ['102', '--no-post'] }
  assert.deepEqual(startConfirm({ number: 102, title: 'feat: x' }, self, 'codex', 'viewer'), {
    heading: 'Self-review #102?', title: 'feat: x', command: '$review-pr 102 --no-post', runner: 'Codex',
    effect: 'Posts nothing; writes the report only.', confirm: 'Start self-review',
  })
  const bump = { label: 'Re-review', command: 'review-dependabot', args: ['110'] }
  assert.equal(startConfirm({ number: 110, title: 'chore(deps): bump x' }, bump, 'claude', 'viewer').command, '/review-dependabot 110')
  assert.equal(githubEffect(bump, 'viewer'), 'Posts its report to the PR as @viewer and may approve the PR automatically.')
  assert.equal(commandLine(bump, 'codex'), '$review-dependabot 110')
})

test('the stop confirmation names the run, its runner and what stopping leaves behind', () => {
  const confirm = stopConfirm({ number: 101, title: 'fix: x' }, running({ runner: 'codex' }), now)
  assert.equal(confirm.heading, 'Stop the run on #101?')
  assert.equal(confirm.detail, 'Review in Codex')
  assert.equal(confirm.line, 'running 3m · last step 20s ago')
  assert.match(confirm.effect, /already posted stays on GitHub/)
  assert.equal(confirm.confirm, 'Stop run')
})

test('a start sends JSON with the runner and the token; a stop sends the token and no body', () => {
  assert.deepEqual(startRequest(101, 'codex', 'tok-123'), {
    url: '/api/prs/101/runs',
    init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pit-View-Token': 'tok-123' }, body: '{"runner":"codex"}' },
  })
  assert.deepEqual(stopRequest(42, 'tok-123'), { url: '/api/runs/42/stop', init: { method: 'POST', headers: { 'X-Pit-View-Token': 'tok-123' } } })
  // the page sends the header the server reads (Node lowercases incoming header names)
  assert.equal(tokenHeader.toLowerCase(), serverTokenHeader)
  assert.equal(tokenMeta, 'pit-view-token')
})

test('a refusal reads as the server said it, except a token refusal, which asks for a reload', () => {
  assert.equal(refusalText('start', 403, 'missing or wrong Pit View token; reload the page'), 'Reload the page to start runs: Pit View has restarted since this page loaded.')
  assert.equal(refusalText('stop', 403, null), 'Reload the page to stop runs: Pit View has restarted since this page loaded.')
  assert.equal(refusalText('start', 409, 'a run for #101 is already in flight'), 'A run for #101 is already in flight.')
  assert.equal(refusalText('start', 422, 'set cloneDir in the config to your local clone of octo-example/orbit before starting a run'),
    'Set cloneDir in the config to your local clone of octo-example/orbit before starting a run.')
  assert.equal(refusalText('start', 422, 'gh is signed in as other, but the viewer is viewer; switch with gh auth switch before starting a run.'),
    'gh is signed in as other, but the viewer is viewer; switch with gh auth switch before starting a run.')
  assert.equal(refusalText('start', 422, 'cloneDir ~/dev/orbit has no remote for octo-example/orbit'), 'cloneDir ~/dev/orbit has no remote for octo-example/orbit.')
  assert.equal(refusalText('start', 500, null), 'Pit View refused with status 500.')
  assert.equal(refusalText('start', 0, null), 'Pit View did not answer. Check that it is running, then try again.')
})

test('a run starting or finishing is announced once, never per tick, and not on the first reading', () => {
  const first = announcements(null, [{ number: 101, agent: running() }, { number: 102, agent: idle() }])
  assert.deepEqual(first.messages, [])
  // the same state again, a minute later: nothing to say
  const same = announcements(first.next, [{ number: 101, agent: running({ lastStepAt: ago(1 * s) }) }, { number: 102, agent: idle() }])
  assert.deepEqual(same.messages, [])
  const changed = announcements(same.next, [
    { number: 101, agent: done({ text: 'Approved' }) },
    { number: 102, agent: running({ runId: 8, label: 'Self-review' }) },
  ])
  assert.deepEqual(changed.messages, ['#101: Review finished: Approved', '#102: Self-review started'])
  // a done cell going back to idle once the head moved says nothing; a new row says nothing
  const quiet = announcements(changed.next, [{ number: 101, agent: idle({ runId: 7, status: 'done' }) }, { number: 102, agent: running({ runId: 8 }) }, { number: 103, agent: running({ runId: 9 }) }])
  assert.deepEqual(quiet.messages, [])
})

test('a cell rebuilds when its state changes, never because the clock moved or a running step changed', async () => {
  const { agentCellSig } = await import('../public/agentcell.ts')
  const sig = (cell: AgentCell, at: number): string => JSON.stringify(agentCellSig(cell, 101, at))
  const later = now + 3 * m
  assert.equal(sig(idle({ lastReviewAt: ago(d) }), now), sig(idle({ lastReviewAt: ago(d) }), later))
  assert.notEqual(sig(idle({ lastReviewAt: ago(d) }), now), sig(idle(), now))
  assert.equal(sig(running(), now), sig(running({ lastStepAt: ago(1 * s), step: { name: 'writeReport', state: 'started' } }), later))
  assert.equal(sig(done(), now), sig(done(), later))
  assert.notEqual(sig(running(), now), sig(done(), now))
  assert.notEqual(sig(done(), now), sig(done({ text: 'Approved' }), now))
  assert.equal(agentCellSig(null, 101, now), null)
})
