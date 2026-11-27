// test/ui-relevancy.test.ts
// the Relevancy check in the page (section 8 of DESIGN.md, Drawer): the cell's words and tone for each verdict, the drawer's block for each verdict with the updates flag on and off, Close PR's confirmation and request, and the Fix session started with the check's prompt. The page has no DOM harness here, so the elements are pinned through the pure models and the wiring in public/drawer.ts is read from its source
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Run } from '../src/cache.ts'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import type { OpenRow } from '../src/derive.ts'
import type { RawOpenPr } from '../src/github.ts'
import { agentCell } from '../src/launcher.ts'
import type { AgentCell, RunResultJson } from '../src/launcher.ts'
import { actionConfirmModel, actionDoneText, actionHolds, actionOffers, actionRequest, closeAsk } from '../public/actionsview.ts'
import { cellModel, doneTone, startRequest, stepTitle } from '../public/agent.ts'
import { confirmHolds, extraLine, resultModel, runText, startConfirmModel, startsModel, summaryOf } from '../public/drawerview.ts'
import { scenario } from './fixtures/scenario.ts'
import { openPage1, openPage2, relevancyHead, relevancyResult } from './helpers.ts'

const config = (): Config => ({ ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit' })
const prompt = 'In src/retry.ts, call the renamed backoffDelay from src/timing.ts instead of computeDelay, which #88 removed.'
const reason = 'Addressed by #88, which added the same backoff to main.'
const irrelevant = { verdict: 'irrelevant', reason, needsUpdates: false, fixPrompt: null }
const updates = { verdict: 'relevant', reason: 'Still needed, but it calls computeDelay, which #88 renamed.', needsUpdates: true, fixPrompt: prompt }

const pr104 = async (sha = relevancyHead): Promise<RawOpenPr> => {
  const nodes = [...(await openPage1()).data.repository!.pullRequests.nodes, ...(await openPage2()).data.repository!.pullRequests.nodes]
  const pr = nodes.find((node) => node.number === 104)
  assert.ok(pr !== undefined)
  return { ...pr, headRefOid: sha }
}

const run = (result: Record<string, unknown>, patch: Partial<Run> = {}): Run => ({
  extraInstructions: null, models: null, jumped: false,
  id: 12, repo: scenario.repo, number: 104, command: 'relevancy-pr', args: ['104'], label: 'Relevancy check', runner: 'claude',
  cwd: '~/dev/orbit', dir: '~/.local/state/pit-view/runs/12', sessionId: 'sess-12', pid: 4012, pidStartedAt: 'start-4012',
  startedAt: '2026-11-20T14:00:00Z', lastStepAt: null, step: null, stepState: null, steps: null, finishedAt: '2026-11-20T14:03:00Z',
  status: 'done', result: result as unknown as RunResultJson, note: null, costUsd: null,
  resume: 'cd ~/dev/orbit && claude --resume sess-12', resolvedByHand: false, firstNote: null, reportHash: null, postAttemptedAt: null, origin: 'manual', tick: null, reason: null, queuedAt: null, posting: false, worktree: null, headOid: null, ...patch,
})

// the viewer's own #104 as the page has it, with the cell the server derives from its latest run
const rowWith = async (patch: Record<string, unknown> | null, sha = relevancyHead): Promise<OpenRow> => {
  const latest = patch === null ? undefined : run(relevancyResult(patch))
  const agent: AgentCell = agentCell(await pr104(sha), config(), latest, undefined, null, null, undefined, latest === undefined ? [] : [latest])
  return {
    number: 104, section: 'mine', url: 'https://example.test/octo-example/orbit/pull/104', title: 'feat(retry): back off between attempts',
    author: { login: scenario.viewer, alias: 'You' }, headRef: 'feat/backoff', baseRef: 'main', primaryBase: true, headOid: sha.slice(0, 7), headSha: sha,
    merge: { state: 'needsReview', label: 'needs review' }, issues: [], group: 'waitingOnUser', agent,
  } as unknown as OpenRow
}

test('the cell reads Relevant in green and Irrelevant in amber, and the step bar has the check\'s own names', async () => {
  for (const [patch, text, tone] of [[{}, 'Relevant', 'green'], [updates, 'Relevant', 'green'], [irrelevant, 'Irrelevant', 'amber']] as const) {
    const cell = (await rowWith(patch)).agent!
    assert.equal(cell.text, text)
    assert.equal(doneTone(cell), tone)
    const model = cellModel(cell, 104, Date.parse('2026-11-20T15:00:00Z'))
    assert.equal(model.state === 'done' ? `${model.text}:${model.tone}` : model.state, `${text}:${tone}`)
  }
  assert.deepEqual(['resolveBase', 'review', 'consolidate', 'writeReport', 'post'].map((step) => stepTitle('relevancy-pr', step)), ['Resolve', 'Judge', 'Write prompt', 'Write report', 'Post'])
})

test('the drawer\'s block, verdict by verdict: Close PR for Irrelevant, the prompt and its Fix session when updates are needed, and nothing more when Relevant with nothing to update', async () => {
  const relevant = await rowWith({})
  const plain = resultModel(relevant.agent!, 104, relevant.headOid, actionOffers(relevant, true), relevant.baseRef)
  assert.deepEqual(plain.relevancy, { verdict: 'Relevant', reason: 'The retry backoff the PR adds is still missing on main.', updates: 'No updates needed.', close: null, prompt: null })
  assert.deepEqual(actionOffers(relevant, true).map((offer) => offer.action), ['convertToDraft', 'requestReview', 'update'], 'the same actions any other PR gets')
  // the Start section is the one any own PR gets, with Check relevancy among the starts
  assert.ok(startsModel(relevant.agent!, true, 104).buttons.some((button) => button.kind === 'relevancy' && button.text === 'Check relevancy'))

  const gone = await rowWith(irrelevant)
  const closing = resultModel(gone.agent!, 104, gone.headOid, actionOffers(gone, true), gone.baseRef)
  assert.deepEqual(closing.relevancy, { verdict: 'Irrelevant', reason, updates: null, close: 'Close it from the Actions section above: Close PR.', prompt: null })
  assert.deepEqual(actionOffers(gone, true).at(-1), { action: 'close', text: 'Close PR' })

  const needed = await rowWith(updates)
  const fixing = resultModel(needed.agent!, 104, needed.headOid, actionOffers(needed, true), needed.baseRef)
  assert.deepEqual(fixing.relevancy, {
    verdict: 'Relevant', reason: updates.reason, updates: 'Updates needed: the check wrote a prompt for a Fix session.', close: null,
    prompt: { text: prompt, copyName: 'Copy prompt', fix: { text: 'Start fix session with this prompt', disabled: false, reason: null } },
  })
  assert.equal(actionOffers(needed, true).some((offer) => offer.action === 'close'), false)
  // the Fix session the prompt starts is not a Start button of its own: the PR has nothing else to fix
  assert.equal(startsModel(needed.agent!, true, 104).buttons.some((button) => button.kind === 'fix'), false)

  // once the head moves on, the check covers an earlier commit and offers neither
  for (const patch of [irrelevant, updates]) {
    const moved = await rowWith(patch, 'f'.repeat(40))
    assert.equal(actionOffers(moved, true).some((offer) => offer.action === 'close'), false)
    const model = resultModel(moved.agent!, 104, moved.headOid, actionOffers(moved, true), moved.baseRef)
    assert.equal(model.relevancy?.close ?? null, null)
    assert.equal(model.relevancy?.prompt?.fix.disabled ?? true, true)
  }
  // a PR that left the open tables offers neither
  assert.deepEqual(actionOffers(gone, false), [])
})

test('once the PR targets another base than the check judged, the drawer says so and offers neither Close PR nor the prompt\'s Fix session', async () => {
  const judged = { repo: scenario.repo, pr: 104, base: 'release/2.4' }
  for (const patch of [irrelevant, updates]) {
    const row = await rowWith({ ...patch, target: judged })
    assert.equal(row.agent!.state, 'idle')
    assert.equal(actionOffers(row, true).some((offer) => offer.action === 'close'), false)
    const model = resultModel(row.agent!, 104, row.headOid, actionOffers(row, true), row.baseRef)
    assert.equal(model.stale, 'The PR now targets main, not release/2.4, the base this check judged. Check relevancy again for the current one.')
    assert.equal(model.relevancy?.close ?? null, null)
  }
  const prompted = await rowWith({ ...updates, target: judged })
  assert.deepEqual(resultModel(prompted.agent!, 104, prompted.headOid, actionOffers(prompted, true), prompted.baseRef).relevancy?.prompt?.fix, {
    text: 'Start fix session with this prompt', disabled: true, reason: 'The PR now targets main, not release/2.4, the base this check judged, so its prompt was written for another base.',
  })
  // at the base it judged, the check stands
  const same = await rowWith(irrelevant)
  assert.equal(resultModel(same.agent!, 104, same.headOid, actionOffers(same, true), same.baseRef).stale, null)
  assert.deepEqual(actionOffers(same, true).at(-1), { action: 'close', text: 'Close PR' })
})

test('Close PR\'s confirmation names the PR, says it closes without merging, and opens with the reason in an editable box; its request sends what the box holds', async () => {
  const row = await rowWith(irrelevant)
  const ask = closeAsk(row, scenario.repo, scenario.viewer)
  assert.deepEqual(ask, { type: 'action', action: 'close', repo: scenario.repo, viewer: scenario.viewer, reviewer: '', headSha: relevancyHead, baseRef: 'main', runId: 12, comment: reason })
  const model = actionConfirmModel(row, ask!, [])
  assert.equal(model?.heading, 'Close #104 without merging?')
  assert.equal(model?.effect, 'Closes the PR on GitHub under your account without merging it, and posts what the box below holds as its closing comment. An empty box closes it with no comment. The branch is kept, and the PR can be reopened on GitHub.')
  assert.deepEqual(model?.comment, { label: 'Closing comment', text: reason, detail: 'Prefilled with the relevancy check\'s reason. What the box holds when you confirm is posted, at most 2,000 characters.' })
  assert.deepEqual([model?.confirm, model?.busy, model?.session], ['Close PR', 'Closing…', null])
  const edited = { ...ask!, comment: 'No longer needed.' }
  assert.deepEqual(JSON.parse(actionRequest(104, edited, 'tok').init.body!), { action: 'close', repo: scenario.repo, viewer: scenario.viewer, headSha: relevancyHead, runId: 12, comment: 'No longer needed.' })
  assert.deepEqual(JSON.parse(actionRequest(104, { ...ask!, comment: '' }, 'tok').init.body!).comment, '')
  assert.equal(actionDoneText(104, ask!, []), '#104: closed without merging. The row is refreshing.')
  // the other actions' confirmations have no box
  assert.equal(actionConfirmModel(row, { ...ask!, action: 'requestReview' }, [{ login: 'sam-tran', alias: 'Sam' }])?.comment, null)
  // the confirmation is dropped once the check is no longer the latest run, or the head moves
  assert.equal(actionHolds(ask!, row, true), true)
  assert.equal(actionHolds({ ...ask!, runId: 11 }, row, true), false)
  assert.equal(actionHolds(ask!, await rowWith(irrelevant, 'f'.repeat(40)), true), false)
  assert.equal(closeAsk(await rowWith({}), scenario.repo, scenario.viewer), null)
})

test('the prompt\'s Fix session opens the Fix confirmation with the prompt, shows the flag and never the text on the command, and sends the prompt it showed', async () => {
  const row = await rowWith(updates)
  const cell = row.agent!
  const fixPrompt = { runId: 12, text: prompt }
  const model = startConfirmModel(row, cell, 'fix', 'claude', false, undefined, false, fixPrompt)
  assert.equal(model?.command, '/fix-pr 104 --extra-instructions')
  assert.equal(model?.prompt, prompt)
  assert.equal(model?.sources, 'It addresses the relevancy check\'s prompt below; GitHub shows no request and this PR has no self-review report for its current head.')
  assert.equal(model?.heading, 'Push fixes to feat/backoff?')
  assert.equal(startConfirmModel(row, cell, 'fix', 'claude')?.prompt ?? null, null)
  assert.deepEqual(JSON.parse(startRequest(104, 'fix', 'claude', scenario.repo, scenario.viewer, 'tok', false, undefined, false, fixPrompt).init.body!), { kind: 'fix', repo: scenario.repo, viewer: scenario.viewer, fixPrompt })
  assert.deepEqual(JSON.parse(startRequest(104, 'fix', 'claude', scenario.repo, scenario.viewer, 'tok').init.body!), { kind: 'fix', repo: scenario.repo, viewer: scenario.viewer })
  assert.equal(confirmHolds({ type: 'start', kind: 'fix', runner: 'claude', fixPrompt }, cell, true), true)
  assert.equal(confirmHolds({ type: 'start', kind: 'fix', runner: 'claude', fixPrompt: { runId: 12, text: `${prompt} More.` } }, cell, true), false)
  assert.equal(confirmHolds({ type: 'start', kind: 'fix', runner: 'claude', fixPrompt }, (await rowWith(updates, 'f'.repeat(40))).agent!, true), false)
})

test('a run rebuilt from the runs list reads the same, and a fix run started with the prompt names where its text came from', async () => {
  const result = relevancyResult(irrelevant) as RunResultJson
  assert.deepEqual(summaryOf(result as never), { kind: 'relevancy', verdict: 'irrelevant', reason, needsUpdates: false, fixPrompt: null, base: 'main', upstream: '9999999' })
  assert.deepEqual(runText({ status: 'done', result: result as never, note: null }), { text: 'Irrelevant', tone: 'amber' })
  assert.deepEqual(runText({ status: 'done', result: relevancyResult() as never, note: null }), { text: 'Relevant', tone: 'green' })
  assert.deepEqual(extraLine({ text: prompt, source: 'relevancy' }), { term: 'Fix prompt', from: 'from the relevancy check', text: prompt })
})

test('drawer.ts draws the block from the model and wires its controls to the real helpers', async () => {
  const source = await readFile(join(import.meta.dirname, '..', 'public', 'drawer.ts'), 'utf8')
  // the copy control is the drawer's two-square glyph and puts the exact text on the clipboard through the one helper
  assert.match(source, /copyPromptButton\(relevancy\.prompt\.text, 'copy-relevancy-prompt', options\.say\)/)
  const copy = await readFile(join(import.meta.dirname, '..', 'public', 'copyreport.ts'), 'utf8')
  assert.match(copy, /export const copyPromptButton = [^\n]*\n[^\n]*'aria-label': 'Copy prompt'[^\n]*squares\(\)/)
  assert.match(copy, /await copyText\(text\)/)
  // the Fix session button asks the Fix confirmation with the prompt the block shows, and only its own Start sends anything
  assert.match(source, /askStart\('fix', \{ runId: cell\.runId, text: relevancy\.prompt\.text \}\)/)
  assert.match(source, /startRequest\(n, asked\.kind, asked\.runner, option\.repo, option\.viewer, options\.token, commentsCheckOn\(asked, option\), specialInstructionsSent\(asked, option\), jump && option\.jump !== undefined, asked\.fixPrompt\)/)
  // Close PR's box holds the comment, and what it holds is what is sent
  assert.match(source, /h\('textarea', \{ id: 'drawer-close-comment', name: 'drawer-close-comment'/)
  assert.match(source, /confirm = \{ \.\.\.confirm, comment: input\.value \}/)
  assert.match(source, /closeAsk\(row, options\.repo\(\), options\.viewer\(\)\)/)
})
