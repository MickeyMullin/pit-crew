// test/ui-model.test.ts
// the model line in every confirmation that starts an agent from a click (#826): the drawer's Start for each run kind, Update branch, Resolve conflicts, and the sweep Start. The page cannot be run here, so each dialog is checked through the model its real caller builds (drawerModel, sweepConfirmModel) and its wiring in the DOM files is pinned in the source
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { sweepStartOf } from '../src/sweeps.ts'
import type { OpenRow } from '../src/derive.ts'
import type { AgentCell, RunnerModels } from '../public/agent.ts'
import type { ActionConfirm, PersonChoice } from '../public/actionsview.ts'
import { drawerModel } from '../public/drawerview.ts'
import type { DrawerInput } from '../public/drawerview.ts'
import { sweepConfirmModel, sweepConfirmSignature } from '../public/sweepview.ts'
import { scenario } from './fixtures/scenario.ts'

const publicFile = (name: string): Promise<string> => readFile(join(import.meta.dirname, '..', 'public', name), 'utf8')

const people: PersonChoice[] = [{ login: 'vera-quill', alias: 'You' }]

const config = (agent: Config['agent'] = { runner: 'claude', claudeModel: 'sonnet' }): Config => ({ ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit', agent })

// the cell the server builds, so the starts and the labels are the real ones
const cellOf = (models: RunnerModels): AgentCell => {
  const start = (kind: 'default' | 'tandem' | 'stack' | 'fix', command: string, args: string[], runners: ('claude' | 'codex')[], push = false): AgentCell['starts'][number] => ({
    kind, label: kind, button: kind, command, args, runners,
    posts: { kind: push ? 'push' : 'review', text: 'Posts.' }, repo: scenario.repo, viewer: scenario.viewer, unavailable: null,
  })
  return {
    state: 'idle', label: 'Review', action: { kind: 'review', label: 'Review', command: 'review-pr', args: ['101'], runner: 'claude' },
    starts: [
      start('default', 'review-pr', ['101'], ['claude', 'codex']),
      start('tandem', 'review-pr', ['101', '--tandem'], ['claude']),
      start('stack', 'review-stack', ['101'], ['claude', 'codex']),
      start('fix', 'fix-pr', ['101'], ['claude'], true),
    ],
    models, lastReviewAt: null, runId: null, runner: null, command: null, args: null, status: null, startedAt: null, lastStepAt: null, step: null,
    steps: [], tandem: false, commit: null, finishedAt: null, text: null, result: null, question: null, note: null, resolvedByHand: false, firstNote: null,
    resume: null, costUsd: null, postOffer: null, stackRun: null,
  } as AgentCell
}

const rowOf = (agent: AgentCell | null, patch: Record<string, unknown> = {}): OpenRow => ({
  number: 101, section: 'mine', url: 'https://example.test/owner/name/pull/101', title: 'fix(retry): back off between attempts',
  author: { login: 'vera-quill', alias: 'You' }, headRef: 'fix/retry', baseRef: 'main', primaryBase: true, headOid: '755b78b',
  headSha: '755b78b2c4e1f0a9d3b6e8c7a5f4d2e1b0c9a8f7', merge: { state: 'needsReview', label: 'Needs review' }, issues: [], agent, ...patch,
} as unknown as OpenRow)

const input = (row: OpenRow, patch: Partial<DrawerInput> = {}): DrawerInput => ({ row, open: true, runs: { state: 'loading' }, reports: { state: 'loading' }, confirm: null, people, ...patch })

const startAsk = (models: RunnerModels, kind: 'default' | 'tandem' | 'stack' | 'fix', runner: 'claude' | 'codex') =>
  drawerModel(input(rowOf(cellOf(models)), { confirm: { type: 'start', kind, runner } })).confirm

const sonnet: RunnerModels = { claude: 'Sonnet', codex: 'Codex default' }

test('each drawer Start confirmation shows the model of the runner it will use: review, tandem, stack review, and the fix session', () => {
  assert.equal(startAsk(sonnet, 'default', 'claude')?.model, 'Sonnet')
  assert.equal(startAsk(sonnet, 'tandem', 'claude')?.model, 'Sonnet')
  assert.equal(startAsk(sonnet, 'stack', 'claude')?.model, 'Sonnet')
  const fix = startAsk(sonnet, 'fix', 'claude')
  assert.equal(fix?.model, 'Sonnet')
  assert.equal(fix?.confirm, 'Start fix session')
})

test('choosing the other runner in the dialog changes the model shown with it, and a changed configured model changes the line', () => {
  assert.equal(startAsk(sonnet, 'default', 'codex')?.model, 'Codex default')
  assert.equal(startAsk(sonnet, 'stack', 'codex')?.model, 'Codex default')
  const configured: RunnerModels = { claude: 'Opus', codex: 'gpt-6.1-terra' }
  assert.equal(startAsk(configured, 'default', 'claude')?.model, 'Opus')
  assert.equal(startAsk(configured, 'default', 'codex')?.model, 'gpt-6.1-terra')
  // a start offered to Claude only keeps Claude's model whatever runner the dialog last held
  assert.equal(startAsk(configured, 'tandem', 'codex')?.model, 'Opus')
})

// Update branch and Resolve conflicts start a Claude session; the others do not start an agent
const actionAsk = (models: RunnerModels | null, action: ActionConfirm['action'], patch: Record<string, unknown> = {}) => {
  const ask: ActionConfirm = { type: 'action', action, repo: scenario.repo, viewer: 'vera-quill', reviewer: 'vera-quill', headSha: '755b78b2c4e1f0a9d3b6e8c7a5f4d2e1b0c9a8f7', baseRef: 'main' }
  return drawerModel(input(rowOf(models === null ? null : cellOf(models), patch), { confirm: ask })).actionAsk
}

test('Update branch and Resolve conflicts show the runner and the model of the session they start', () => {
  const conflicts = { issues: [{ kind: 'conflicts' }] }
  assert.deepEqual(actionAsk({ claude: 'Opus', codex: 'Codex default' }, 'update')?.session, { runner: 'Claude Code', model: 'Opus' })
  assert.deepEqual(actionAsk({ claude: 'Opus', codex: 'Codex default' }, 'resolveConflicts', conflicts)?.session, { runner: 'Claude Code', model: 'Opus' })
  assert.deepEqual(actionAsk(sonnet, 'update')?.session, { runner: 'Claude Code', model: 'Sonnet' })
})

test('the direct actions that start no agent show no model: Mark ready, Convert to draft, Merge, and Request review', () => {
  for (const action of ['markReady', 'convertToDraft', 'requestReview'] as const) assert.equal(actionAsk(sonnet, action, { merge: { state: action === 'markReady' ? 'draft' : 'needsReview' } })?.session ?? null, null, action)
  assert.equal(actionAsk(sonnet, 'merge', { merge: { state: 'ready', label: 'Ready' } })?.session ?? null, null)
})

test('a row without an Agent cell shows no model rather than a guessed one', () => {
  assert.equal(actionAsk(null, 'update')?.session, null)
})

test('the sweep confirmation shows the model of the chosen runner, and the line follows the runner and the configured model', () => {
  const start = sweepStartOf(config(), false)
  assert.equal(sweepConfirmModel(start, 'claude').model, 'Sonnet')
  assert.equal(sweepConfirmModel(start, 'codex').model, 'Codex default')
  const configured = sweepStartOf(config({ runner: 'codex', claudeModel: 'opus', codexModel: 'gpt-6.1-terra' }), false)
  assert.equal(sweepConfirmModel(configured, 'claude').model, 'Opus')
  assert.equal(sweepConfirmModel(configured, 'codex').model, 'gpt-6.1-terra')
  // the confirmation is rebuilt when the configured model changes
  assert.notEqual(sweepConfirmSignature(start, 'claude'), sweepConfirmSignature(configured, 'claude'))
})

// the DOM files cannot run here, so the wiring is pinned in the source
test('drawer.ts draws a Model fact in the start and the action confirmations, and repaints it when the runner choice changes', async () => {
  const source = await publicFile('drawer.ts')
  assert.match(source, /\['Runner', runner\], \['Model', h\('span', \{ 'data-confirm': 'model' \}, ask\.model\)\]/)
  assert.match(source, /\.\.\.\(ask\.session === null \? \[\] : \[\['Runner', ask\.session\.runner\] as \[string, string\], \['Model', ask\.session\.model\] as \[string, string\]\]\)/)
  assert.match(source, /querySelector<HTMLElement>\('\[data-confirm="model"\]'\)/)
  assert.match(source, /setText\(modelLine, model\.confirm\.model\)/)
  // the runner choice repaints the line and rebuilds nothing, so the chosen model is blanked from the signature while every runner's stays in it
  assert.match(source, /\.\.\.model\.confirm, runner: '', command: '', model: '', commentsCheck/)
})

test('sweepdrawer.ts draws a Model fact in the sweep confirmation, and repaints it when the runner choice changes', async () => {
  const source = await publicFile('sweepdrawer.ts')
  assert.match(source, /\['Runner', runner\], \['Model', h\('span', \{ 'data-confirm': 'model' \}, model\.model\)\]/)
  assert.match(source, /setText\(modelLine, sweepConfirmModel\(view\.start, confirm\.runner\)\.model\)/)
})
