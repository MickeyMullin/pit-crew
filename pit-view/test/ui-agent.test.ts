// test/ui-agent.test.ts
// the Agent cell's words and requests (public/agent.ts): each state's text, the running timer, the
// one button that opens the drawer, the requests with the per-start token, refusals, and announcements
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  announcements, cellModel, commandLine, doneTone, fixStart, formatDuration, refusalText, runningLine, sentence,
  startRequest, stepText, stepTitle, stopRequest, tokenHeader,
} from '../public/agent.ts'
import type { AgentCell, StartOption } from '../public/agent.ts'
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
  starts: [],
  lastReviewAt: null,
  runId: null, runner: null, command: null, args: null, status: null, startedAt: null, lastStepAt: null, step: null,
  steps: [], tandem: false,
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

test('an idle cell shows its action\'s label on a button that opens the drawer, with the last review under it when there is one', () => {
  assert.deepEqual(cellModel(idle(), 101, now), { state: 'idle', button: 'Review', name: 'Review #101: open agent', under: null })
  const again = idle({ label: 'Re-review', action: { kind: 'reReview', label: 'Re-review', command: 'review-pr', args: ['101'], runner: 'claude' }, lastReviewAt: ago(7 * d + h) })
  assert.deepEqual(cellModel(again, 101, now), { state: 'idle', button: 'Re-review', name: 'Re-review #101: open agent', under: 'last review 7d ago' })
  const self = idle({ action: { kind: 'selfReview', label: 'Self-review', command: 'review-pr', args: ['102', '--no-post'], runner: 'claude' }, lastReviewAt: ago(5 * s) })
  assert.deepEqual(cellModel(self, 102, now), { state: 'idle', button: 'Self-review', name: 'Self-review #102: open agent', under: 'last review just now' })
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

test('a running cell names its label and its step for screen readers and tooltips, on a button that opens the drawer', () => {
  assert.deepEqual(cellModel(running(), 101, now), {
    state: 'running', label: 'Review', line: 'running 3m · last step 20s ago', step: 'Step: review, started', name: 'Open agent for #101, Review running',
  })
  assert.equal(stepText({ name: 'writeReport', state: 'done' }), 'Step: write report, done')
  assert.equal(stepText({ name: 'consolidate', state: 'skipped' }), 'Step: consolidate, skipped')
  assert.equal(stepText(null), 'Starting: no step recorded yet')
})

test('a Fix session\'s steps read by its own meanings: resolve, triage, fix and check, write report, push', () => {
  assert.deepEqual(['resolveBase', 'review', 'consolidate', 'writeReport', 'post'].map((step) => stepTitle('fix-pr', step)), [
    'Resolve', 'Triage', 'Fix and check', 'Write report', 'Push',
  ])
  // every other command keeps a review's
  for (const command of ['review-pr', 'review-stack', 'review-dependabot', null]) {
    assert.deepEqual(['resolveBase', 'review', 'consolidate', 'writeReport', 'post'].map((step) => stepTitle(command, step)), [
      'Resolve base', 'Review', 'Consolidate', 'Write report', 'Post',
    ])
  }
  assert.equal(stepText({ name: 'consolidate', state: 'started' }, 'fix-pr'), 'Step: fix and check, started')
  assert.equal(stepText({ name: 'post', state: 'done' }, 'fix-pr'), 'Step: push, done')
  assert.equal(stepText({ name: 'review', state: 'started' }, 'review-pr'), 'Step: review, started')
  const fixing = running({ command: 'fix-pr', label: 'Fix session', step: { name: 'review', state: 'started' } })
  assert.equal((cellModel(fixing, 101, now) as { step: string }).step, 'Step: triage, started')
})

test('a done cell shows the server\'s text and when it finished, colored by what comes next', () => {
  const model = cellModel(done(), 101, now)
  assert.deepEqual(model, {
    state: 'done', text: 'Changes requested', tone: 'red', line: 'finished 17h ago', tip: null, name: 'Open agent for #101, Changes requested',
  })
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
  // a Fix session: pushed is good news, nothing to fix needs nothing, not pushed wants a look
  assert.equal(tones('Fixed · pushed 2 commits'), 'green')
  assert.equal(tones('Fixed · pushed 1 commit'), 'green')
  assert.equal(tones('Nothing to fix'), 'gray')
  for (const text of ['Not pushed', 'Not pushed · checks failed', 'Not pushed · checks not run', 'Not pushed · push refused']) assert.equal(tones(text), 'amber', text)
  assert.equal(tones('Failed · push refused', 'failed'), 'red')
})

test('the banner offers a Fix session while the row offers one, available or not, and never without one', () => {
  const fix: StartOption = {
    kind: 'fix', label: 'Fix session', button: 'Fix requested changes', command: 'fix-pr', args: ['101'], runners: ['claude'],
    posts: { kind: 'push', text: 'Pushes new commits to fix/retry on GitHub. It posts no replies or reviews, and stops to ask when a request needs judgment.' },
    repo: 'octo-example/orbit',
    viewer: 'viewer',
    unavailable: null,
  }
  const review: StartOption = { ...fix, kind: 'default', label: 'Self-review', button: 'Self-review', command: 'review-pr', args: ['101', '--no-post'], runners: ['claude', 'codex'], posts: { kind: 'nothing', text: 'Posts nothing.' } }
  assert.equal(fixStart(idle({ starts: [review, fix] })), fix)
  const busy = { ...fix, unavailable: 'a run for #101 is already in flight' }
  assert.equal(fixStart(idle({ starts: [review, busy] })), busy, 'an unavailable fix still shows; the drawer says why')
  assert.equal(fixStart(idle({ starts: [review] })), null, 'a PR that is not yours, or a bot\'s, has no fix start')
  assert.equal(fixStart(null), null)
})

test('a run waiting for an answer keeps its question as the cell\'s tooltip; the drawer offers the resume command', () => {
  const waiting = done({
    status: 'needsInput', text: 'Needs your answer', question: 'The tandem draft fails its checks; consolidate anyway?',
    resume: 'cd ~/dev/orbit && claude --resume 6f1c', finishedAt: ago(30 * s),
  })
  assert.deepEqual(cellModel(waiting, 104, now), {
    state: 'done', text: 'Needs your answer', tone: 'amber', line: 'finished 30s ago',
    tip: 'The tandem draft fails its checks; consolidate anyway?', name: 'Open agent for #104, Needs your answer',
  })
})

test('a failed run keeps its note as the tooltip; a stopped or finished one has none', () => {
  const failed = cellModel(done({ status: 'failed', text: 'Failed · no result', note: 'noResult: exited with code 1' }), 101, now)
  assert.equal(failed.state === 'done' && failed.tip, 'noResult: exited with code 1')
  const stopped = cellModel(done({ status: 'stopped', text: 'Stopped', note: null }), 101, now)
  assert.equal(stopped.state === 'done' && stopped.tip, null)
  assert.equal((cellModel(done(), 101, now) as { tip: unknown }).tip, null)
  // no cell offers Stop, Copy or Run again any more: they live in the drawer
  for (const cell of [idle(), running(), done(), done({ status: 'failed', text: 'Failed' })]) {
    const keys = Object.keys(cellModel(cell, 101, now))
    assert.ok(!keys.includes('stop') && !keys.includes('copy') && !keys.includes('again'), keys.join())
  }
})

test('the command line is what the runner receives: a slash for Claude, a dollar sign for Codex', () => {
  assert.equal(commandLine({ command: 'review-pr', args: ['101'] }, 'claude'), '/review-pr 101')
  assert.equal(commandLine({ command: 'review-pr', args: ['102', '--no-post'] }, 'codex'), '$review-pr 102 --no-post')
  assert.equal(commandLine({ command: 'review-pr', args: ['101', '--tandem'] }, 'claude'), '/review-pr 101 --tandem')
  assert.equal(commandLine({ command: 'review-stack', args: ['111'] }, 'claude'), '/review-stack 111')
})

test('a start sends JSON with the kind, the runner, the repository, the viewer, and the token; a stop sends the token and no body', () => {
  assert.deepEqual(startRequest(101, 'default', 'codex', 'octo-example/orbit', 'vera-quill', 'tok-123'), {
    url: '/api/prs/101/runs',
    init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pit-View-Token': 'tok-123' }, body: '{"kind":"default","runner":"codex","repo":"octo-example/orbit","viewer":"vera-quill"}' },
  })
  assert.equal(startRequest(111, 'stack', 'claude', 'octo-example/orbit', 'vera-quill', 't').init.body, '{"kind":"stack","runner":"claude","repo":"octo-example/orbit","viewer":"vera-quill"}')
  // a Fix session names no runner: the server runs it with Claude; it still names the repository and viewer the confirmation showed
  assert.equal(startRequest(101, 'fix', 'codex', 'octo-example/orbit', 'vera-quill', 't').init.body, '{"kind":"fix","repo":"octo-example/orbit","viewer":"vera-quill"}')
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
  assert.equal(refusalText('start', 400, 'Review in tandem runs with Claude only; send runner claude or leave it out'),
    'Review in tandem runs with Claude only; send runner claude or leave it out.')
  assert.equal(sentence('a run for #101 is already in flight'), 'A run for #101 is already in flight.')
  assert.equal(sentence('  '), '')
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

test('an Update session\'s steps read as its own, and a branch already up to date needs nothing', () => {
  assert.deepEqual(['resolveBase', 'review', 'consolidate', 'writeReport', 'post'].map((step) => stepTitle('update-pr', step)), [
    'Resolve', 'Choose method', 'Update and check', 'Write report', 'Push',
  ])
  assert.equal(stepText({ name: 'consolidate', state: 'started' }, 'update-pr'), 'Step: update and check, started')
  assert.equal(doneTone({ status: 'done', text: 'Already up to date' }), 'gray')
  assert.equal(doneTone({ status: 'done', text: 'Rebased onto main' }), 'green')
  assert.equal(doneTone({ status: 'done', text: 'Merged main in' }), 'green')
  assert.equal(doneTone({ status: 'done', text: 'Not pushed · checks failed' }), 'amber')
})
