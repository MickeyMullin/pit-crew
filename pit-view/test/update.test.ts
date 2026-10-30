// test/update.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createUpdateWatch } from '../src/actions.ts'
import type { Run } from '../src/cache.ts'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import type { RawOpenPr } from '../src/github.ts'
import { agentCell, claudeOnly, doneText, judge, parseResult, reportPath, updateMismatch, updateRequest } from '../src/launcher.ts'
import type { RunResultJson, UpdateResult } from '../src/launcher.ts'
import { scenario } from './fixtures/scenario.ts'
import { openPage1, updateHead, updatePushedHead, updateResult, updateUpstream } from './helpers.ts'

// the Update session's server half (section 9 of DESIGN.md, Direct actions): its result schema, how a run settles from it, the cell it gives, and the refresh once it ends. Nothing here runs git or gh

const config = (): Config => ({ ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit' })

const pr101 = async (sha: string): Promise<RawOpenPr> => {
  const pr = (await openPage1()).data.repository!.pullRequests.nodes.find((node) => node.number === 101)
  assert.ok(pr !== undefined)
  return { ...pr, headRefOid: sha }
}

const updateRun = (result: Record<string, unknown> | null, patch: Partial<Run> = {}): Run => ({
  id: 9, repo: scenario.repo, number: 101, command: 'update-pr', args: ['101', `--head=${updateHead}`], label: 'Update branch', runner: 'claude',
  cwd: '~/dev/orbit', dir: '~/.local/state/pit-view/runs/9', sessionId: 'sess-9', pid: 4009, pidStartedAt: 'start-4009',
  startedAt: '2026-10-28T14:00:00Z', lastStepAt: null, step: null, stepState: null, steps: null, finishedAt: '2026-10-28T14:05:00Z',
  status: (result?.status as Run['status'] | undefined) ?? 'done', result: result as unknown as RunResultJson | null, note: null, costUsd: null,
  resume: 'cd ~/dev/orbit && claude --resume sess-9', ...patch,
})

const parsedUpdate = (patch: Record<string, unknown> = {}): UpdateResult => {
  const parsed = parseResult(JSON.stringify(updateResult(patch)))
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error)
  return (parsed as { ok: true, value: UpdateResult }).value
}

const settle = { stopped: false, restarted: false, exit: { code: 0, signal: null, error: null }, denials: [], lastEvent: null }

test('the Update session is update-pr with Claude, carrying the head the confirmation showed, which the command takes as its lease', () => {
  assert.deepEqual(updateRequest(scenario.repo, 101, updateHead), {
    repo: scenario.repo, number: 101, command: 'update-pr', args: ['101', `--head=${updateHead}`], label: 'Update branch', runner: 'claude',
  })
  assert.equal(claudeOnly('update-pr', ['101']), true)
})

test('an update result is checked against pit-crew/update-result@1: a rebase, a merge, already up to date, a stop to ask, a refused push, an early failure', () => {
  parsedUpdate()
  parsedUpdate({ method: 'merge', methodReason: 'sam-tran has commits on the branch', pushed: { branch: 'fix/webhook-retry', head: updatePushedHead, forced: false } })
  parsedUpdate({ method: null, methodReason: null, conflicts: [], checks: [], pushed: null, notPushedReason: 'upToDate' })
  parsedUpdate({ status: 'needsInput', pushed: null, notPushedReason: 'awaitingAnswer', question: 'Both sides rewrote parseRetry: keep which?' })
  parsedUpdate({ status: 'failed', pushed: null, notPushedReason: 'pushFailed', error: '! [rejected] HEAD -> fix/webhook-retry (stale info)' })
  parsedUpdate({ status: 'failed', target: null, head: null, upstream: null, method: null, methodReason: null, conflicts: [], checks: [], pushed: null, error: 'this PR is not yours' })
  const refusals: [Record<string, unknown>, RegExp][] = [
    [(({ upstream: _upstream, ...rest }) => rest)(updateResult()), /upstream is missing/],
    [updateResult({ command: 'fix-pr' }), /command must be update-pr/],
    [updateResult({ method: 'squash' }), /method must be rebase, merge or null/],
    [updateResult({ head: { sha: updateHead.slice(0, 7) } }), /head must be null or \{ sha \}/],
    [updateResult({ target: { repo: scenario.repo, pr: 101, branch: 'fix/webhook-retry' } }), /target must be null or \{ repo, pr, branch, base \}/],
    [updateResult({ pushed: { branch: 'fix/webhook-retry', head: updatePushedHead } }), /pushed must be null or \{ branch, head, forced \}/],
    [updateResult({ notPushedReason: 'upToDate' }), /notPushedReason must be null when pushed/],
    [updateResult({ notPushedReason: 'nothingToFix', pushed: null }), /notPushedReason must be upToDate/],
    [updateResult({ conflicts: [{ path: '', resolution: 'x' }] }), /conflicts must be a list of \{ path, resolution \}/],
  ]
  for (const [value, message] of refusals) {
    const parsed = parseResult(JSON.stringify(value))
    assert.equal(parsed.ok, false)
    assert.match(parsed.ok ? '' : parsed.error, message)
  }
})

test('an update writes no report, so a done result settles done without one; a stop asks, a refused push fails with git\'s error', () => {
  assert.equal(reportPath(parsedUpdate()), null)
  const done = judge({ ...settle, reportExists: null, parsed: { ok: true, value: parsedUpdate() } })
  assert.deepEqual([done.status, done.note], ['done', null])
  const waiting = judge({ ...settle, reportExists: null, parsed: { ok: true, value: parsedUpdate({ status: 'needsInput', pushed: null, notPushedReason: 'awaitingAnswer', question: 'Keep which?' }) } })
  assert.deepEqual([waiting.status, waiting.result?.question], ['needsInput', 'Keep which?'])
  const refused = judge({ ...settle, reportExists: null, parsed: { ok: true, value: parsedUpdate({ status: 'failed', pushed: null, notPushedReason: 'pushFailed', error: '! [rejected] (stale info)' }) } })
  assert.deepEqual([refused.status, refused.note], ['failed', '! [rejected] (stale info)'])
})

test('a well-formed update result that contradicts itself fails as badResult and keeps the result: force on a merge, none on a rebase, another branch, the primary branch itself', () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ pushed: { branch: 'fix/webhook-retry', head: updatePushedHead, forced: false } }, 'a rebase was pushed without force'],
    [{ method: 'merge', pushed: { branch: 'fix/webhook-retry', head: updatePushedHead, forced: true } }, 'a merge was pushed with force'],
    [{ pushed: { branch: 'main', head: updatePushedHead, forced: true } }, 'pushed.branch main is not the target branch fix/webhook-retry'],
    [{ target: { repo: scenario.repo, pr: 101, branch: 'main', base: 'main' }, pushed: { branch: 'main', head: updatePushedHead, forced: true } }, 'the PR\'s branch main is the primary branch it updates from'],
    [{ method: null, methodReason: null }, 'pushed carries no method'],
    [{ pushed: null, notPushedReason: null }, 'a done update result carries neither pushed nor notPushedReason'],
  ]
  for (const [patch, why] of cases) {
    const value = parsedUpdate(patch)
    assert.equal(updateMismatch(value), why)
    const judged = judge({ ...settle, reportExists: null, parsed: { ok: true, value } })
    assert.deepEqual([judged.status, judged.note, judged.result?.schema], ['failed', `badResult: ${why}`, 'pit-crew/update-result@1'])
  }
  assert.equal(updateMismatch(parsedUpdate()), null)
})

test('an update run\'s done text names the method and the primary branch, or why nothing was pushed, beside the failure texts every run shares', () => {
  const text = (result: Record<string, unknown> | null, patch: Partial<Run> = {}): string => doneText(updateRun(result, patch), false)
  assert.equal(text(updateResult()), 'Rebased onto main')
  assert.equal(text(updateResult({ method: 'merge', pushed: { branch: 'fix/webhook-retry', head: updatePushedHead, forced: false } })), 'Merged main in')
  assert.equal(text(updateResult({ method: null, pushed: null, notPushedReason: 'upToDate' })), 'Already up to date')
  assert.equal(text(updateResult({ pushed: null, notPushedReason: 'checksFailed' })), 'Not pushed · checks failed')
  assert.equal(text(updateResult({ pushed: null, notPushedReason: 'awaitingAnswer' })), 'Not pushed')
  assert.equal(text(updateResult({ status: 'needsInput', pushed: null, notPushedReason: 'awaitingAnswer', question: 'Keep which?' })), 'Needs your answer')
  assert.equal(text(updateResult({ status: 'failed', pushed: null, notPushedReason: 'pushFailed', error: 'rejected' }), { note: 'rejected' }), 'Failed · push refused')
  assert.equal(text(updateResult({ status: 'failed', pushed: null, error: 'the head moved' }), { note: 'the head moved' }), 'Failed')
  assert.equal(text(null, { status: 'stopped' }), 'Stopped')
})

test('a finished update stays done while the PR\'s head is the one it pushed or the one it read, carries the summary the drawer shows, then goes idle', async () => {
  const run = updateRun(updateResult())
  const pushed = agentCell(await pr101(updatePushedHead), config(), run, undefined)
  assert.deepEqual([pushed.state, pushed.label, pushed.command, pushed.text], ['done', 'Update branch', 'update-pr', 'Rebased onto main'])
  assert.deepEqual(pushed.result, {
    kind: 'update',
    base: 'main',
    upstream: updateUpstream.slice(0, 7),
    method: 'rebase',
    methodReason: 'only your commits are on the branch, and no open PR is based on it',
    conflicts: [{ path: 'src/retry.ts', resolution: 'kept the backoff from the PR and the renamed logger from main' }],
    checks: [{ name: 'pnpm test', result: 'passed' }],
    pushed: { branch: 'fix/webhook-retry', head: updatePushedHead, forced: true },
    notPushedReason: null,
    worktree: null,
  })
  // the cached row keeps the head the run read until the PR is fetched again
  assert.equal(agentCell(await pr101(updateHead), config(), run, undefined).state, 'done')
  const moved = agentCell(await pr101('0123456789abcdef0123456789abcdef01234567'), config(), run, undefined)
  assert.deepEqual([moved.state, moved.runId, moved.text], ['idle', 9, 'Rebased onto main'])
})

test('an Update session\'s PR is read again once, when a session this server watched settles, however it ended; nothing else refreshes', async () => {
  const asked: string[] = []
  const watch = createUpdateWatch(async (repo, number) => {
    asked.push(`${repo}#${number}`)
  }, () => {})
  const base = updateRun(null, { status: 'running', finishedAt: null })
  watch.watch(base)
  watch.change(base)
  assert.deepEqual(asked, [])
  watch.change({ ...base, status: 'stopped' })
  watch.change({ ...base, status: 'done' })
  assert.deepEqual(asked, [`${scenario.repo}#101`])
  // a review run, and an update run this server never watched (recovery settled it at startup), refresh nothing
  const review = { ...base, id: 10, command: 'review-pr' }
  watch.watch(review)
  watch.change({ ...review, status: 'done' })
  watch.change({ ...base, id: 11, status: 'failed' })
  assert.deepEqual(asked, [`${scenario.repo}#101`])
})
