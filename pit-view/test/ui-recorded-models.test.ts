// test/ui-recorded-models.test.ts
// the roles and models a run recorded, as the drawer words them (section 8 of DESIGN.md, Drawer): on the running, waiting, and finished cards and on each earlier run, with a fallback or a degraded review flagged, and a run from before they were recorded read as not recorded
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { RunModels } from '../src/models.ts'
import type { AgentCell, RunView } from '../public/agent.ts'
import { modelsLine, resultModel, runningModel, runRows, waitingModel } from '../public/drawerview.ts'

const role = (patch: Partial<RunModels['roles'][number]> = {}): RunModels['roles'][number] =>
  ({ role: 'reviewer', id: 'sonnet', runner: 'claude', provider: 'anthropic', model: 'sonnet', fallback: false, outcome: null, ...patch })

const single: RunModels = { roles: [role()], degraded: false }
const pair: RunModels = { roles: [role(), role({ role: 'secondary', id: 'gpt-6.1-terra', runner: 'codex', provider: 'openai', model: 'gpt-6.1-terra' })], degraded: false }

test('a run with no record reads as not recorded', () => {
  assert.deepEqual(modelsLine(null), { term: 'Models', text: 'not recorded', flags: [] })
})

test('one role reads as its name, model, and runner; a pair reads as both, primary first', () => {
  assert.deepEqual(modelsLine(single), { term: 'Models', text: 'Reviewer: sonnet (Claude Code)', flags: [] })
  assert.equal(modelsLine(pair).text, 'Reviewer: sonnet (Claude Code) · Secondary: gpt-6.1-terra (Codex)')
})

test('a model in no registry entry reads as its slug, Codex\'s own default as such, a Hermes entry by its id, and an outcome follows its role', () => {
  assert.equal(modelsLine({ roles: [role({ id: null, model: 'claude-x-9' })], degraded: false }).text, 'Reviewer: claude-x-9 (Claude Code)')
  assert.equal(modelsLine({ roles: [role({ id: null, runner: 'codex', provider: 'openai', model: null })], degraded: false }).text, 'Reviewer: Codex default (Codex)')
  assert.equal(modelsLine({ roles: [role({ id: 'kimi-code', runner: 'hermes', provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code', outcome: 'done' })], degraded: false }).text, 'Reviewer: kimi-code (Hermes), done')
})

test('a role the pinned fallback replaced, and a review that ended degraded, are flagged', () => {
  const flagged = modelsLine({ roles: [role(), role({ role: 'secondary', id: 'kimi-code', runner: 'hermes', provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code', fallback: true })], degraded: true })
  assert.deepEqual(flagged.flags, ['The pinned fallback replaced the secondary.', 'Degraded: the review ended on one surviving draft, so it was not posted.'])
  assert.deepEqual(modelsLine(single).flags, [])
})

const cell = (patch: Partial<AgentCell> = {}): AgentCell => ({
  state: 'done', label: 'Review', runner: 'claude', command: 'review-pr', status: 'done', text: 'Clean', finishedAt: '2026-10-28T13:04:00Z', commit: null, steps: [], starts: [],
  result: null, note: null, resolvedByHand: false, firstNote: null, costUsd: null, resume: null, extraInstructions: null, recorded: null, tandem: false, question: null, runId: 7,
  ...patch,
} as unknown as AgentCell)

test('the running card, the waiting card, and the finished card each carry the line, and not-recorded for a run from before', () => {
  const row = { headOid: '755b78b2c4e1f0a9d3b6e8c7a5f4d2e1b0c9a8f7' }
  assert.equal(runningModel(row, cell({ recorded: pair })).models.text, modelsLine(pair).text)
  assert.equal(runningModel(row, cell()).models.text, 'not recorded')
  assert.equal(waitingModel(cell({ recorded: single }), 101).models.text, 'Reviewer: sonnet (Claude Code)')
  assert.equal(resultModel(cell({ recorded: pair }), 101, row.headOid, []).models.text, modelsLine(pair).text)
  assert.equal(resultModel(cell(), 101, row.headOid, []).models.text, 'not recorded')
})

test('each earlier run carries its own line', () => {
  const run = (id: number, models: RunModels | null): RunView => ({
    id, label: 'Review', runner: 'claude', status: 'done', result: null, note: null, resolvedByHand: false, startedAt: '2026-10-28T13:00:00Z', costUsd: null, extraInstructions: null, origin: 'manual', models,
  } as unknown as RunView)
  const rows = runRows([run(3, pair), run(2, null)], null)
  assert.deepEqual(rows.map((row) => row.models.text), [modelsLine(pair).text, 'not recorded'])
})

test('drawer.ts draws the line on those cards, in the same place as the extra instructions', async () => {
  const source = await readFile(join(import.meta.dirname, '..', 'public', 'drawer.ts'), 'utf8')
  for (const use of ['modelsParts(running.models)', 'modelsDetail(waiting.models)', 'modelsDetail(result.models)', 'modelsDetail(row.models)']) assert.ok(source.includes(use), use)
  assert.ok(source.includes('data-models'))
})
