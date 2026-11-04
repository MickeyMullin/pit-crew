// test/launcher.test.ts
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { openCache } from '../src/cache.ts'
import type { Run, RunChanges } from '../src/cache.ts'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import type { OpenRow } from '../src/derive.ts'
import { createGh } from '../src/github.ts'
import type { RawOpenPr } from '../src/github.ts'
import {
  agentCell, childEnv, claudeInvocation, codexInvocation, codexNote, createLauncher, defaultRun, descendantGroups, doneText, emptyStream, gitConfigEnv,
  emptySteps, foldStream, foldSteps, isHttpUrl, isTandemRun, judge, LaunchError, notOffered, parsePs, parseResult, parseStepEvent, remoteNamesRepo,
  noteKind, requestText, reviewFits, runners, runView, shellPath, startOptions, stepsOf, updateRequest,
} from '../src/launcher.ts'
import type { LaunchSpec, RunResultJson, StartRequest, StepEvent } from '../src/launcher.ts'
import { createPoller } from '../src/poller.ts'
import { scanReports } from '../src/reports.ts'
import type { Patch } from '../src/poller.ts'
import { scenario } from './fixtures/scenario.ts'
import { fakeLaunch, fakeRemotes, fakeRunner, fakeTime, fixCommits, fixHead, fixPushedHead, fixRequest, fixResult, fixtureRunner, ok, openPage1, openPage2, reviewResult, tempDir, updateHead, updateResult } from './helpers.ts'
import type { FakeLaunch, FakeRunner } from './helpers.ts'

const second = 1000

const baseConfig = (): Config => ({ ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit' })

const fixturePrs = async (): Promise<Map<number, RawOpenPr>> => {
  const nodes = [...(await openPage1()).data.repository!.pullRequests.nodes, ...(await openPage2()).data.repository!.pullRequests.nodes]
  return new Map(nodes.map((pr) => [pr.number, pr]))
}

const prOf = async (number: number): Promise<RawOpenPr> => {
  const pr = (await fixturePrs()).get(number)
  assert.ok(pr !== undefined, `fixture PR #${number}`)
  return pr
}

// a run row as the cache would hold it, for the pure cell functions
const runRow = (patch: Partial<Run> = {}): Run => ({
  id: 7, repo: scenario.repo, number: 106, command: 'review-pr', args: ['106'], label: 'Re-review', runner: 'claude',
  cwd: '~/dev/orbit', dir: '~/.local/state/pit-view/runs/7', sessionId: 'sess-1', pid: 4001, pidStartedAt: 'start-4001',
  startedAt: '2026-10-26T14:00:00Z', lastStepAt: null, step: null, stepState: null, steps: null, finishedAt: null, status: 'running',
  result: null, note: null, costUsd: null, resume: 'cd ~/dev/orbit && claude --resume sess-1', resolvedByHand: false, firstNote: null, ...patch,
})

const spec = (patch: Partial<LaunchSpec> = {}): LaunchSpec => ({
  command: 'review-pr', args: ['106'], cwd: '/home/tester/dev/orbit', runDir: '/home/tester/.local/state/pit-view/runs/3', home: '/home/tester',
  sessionId: '6f1c1f9e-0000-4000-8000-000000000003', claudeModel: 'sonnet', reportsDir: '/Volumes/Data/agents/output', worktreesDir: '/Volumes/Data/agents/worktrees', ...patch,
})

// command lines

test('Claude starts exactly as Launching runs pins it, with the request as one stream-json user message', () => {
  const invocation = claudeInvocation(spec())
  assert.equal(invocation.command, 'claude')
  assert.deepEqual(invocation.args, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', 'sonnet', '--session-id', '6f1c1f9e-0000-4000-8000-000000000003', '--permission-mode', 'auto', '--add-dir', '/home/tester/agents',
  ])
  assert.ok(invocation.stdin?.endsWith('\n'))
  assert.deepEqual(JSON.parse(invocation.stdin ?? ''), {
    type: 'user',
    message: { role: 'user', content: '/review-pr 106 --emit-json=/home/tester/.local/state/pit-view/runs/3' },
  })
  // never --bare or --safe-mode, which drop the sign-in or the installed commands
  assert.ok(!invocation.args.some((arg) => arg === '--bare' || arg === '--safe-mode'))
})

test('every Claude run carries --model from the configured claudeModel, and the model is the one that was set', () => {
  const modelOf = (args: readonly string[]): string | undefined => args[args.indexOf('--model') + 1]
  for (const command of ['review-pr', 'review-dependabot', 'review-stack', 'fix-pr']) {
    assert.equal(modelOf(claudeInvocation(spec({ command })).args), 'sonnet', command)
  }
  const opus = claudeInvocation(spec({ claudeModel: 'opus' })).args
  assert.equal(modelOf(opus), 'opus')
  assert.equal(opus.filter((arg) => arg === '--model').length, 1)
  // the model never lands in the request, and Codex is not given it
  assert.ok(!(claudeInvocation(spec()).stdin ?? '').includes('sonnet'))
  assert.ok(!codexInvocation(spec({ claudeModel: 'opus' })).args.includes('opus'))
})

test('Codex starts exactly as Launching runs pins it: a $ skill, the sandbox, the resolved folders and the note', () => {
  const runDir = '/home/tester/.local/state/pit-view/runs/3'
  const base = [
    '-C', '/home/tester/dev/orbit', '-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true',
    '--add-dir', '/home/tester/dev/orbit/.git', '--add-dir', runDir, '--add-dir', '/Volumes/Data/agents/output', '--add-dir', '/Volumes/Data/agents/worktrees',
  ]
  const prompt = `$review-pr 106 --no-post --emit-json=${runDir}\n\n${codexNote('/Volumes/Data/agents/output')}`
  const without = codexInvocation(spec({ args: ['106', '--no-post'], sessionId: null }))
  assert.equal(without.command, 'codex')
  assert.deepEqual(without.args, ['exec', '--json', ...base, prompt])
  assert.equal(without.stdin, null)
  const withModel = codexInvocation(spec({ args: ['106', '--no-post'], sessionId: null, codexModel: 'gpt-6.1-terra' }))
  assert.deepEqual(withModel.args, ['exec', '--json', '-m', 'gpt-6.1-terra', ...base, prompt])
  assert.match(codexNote('/Volumes/Data/agents/output'), /\/Volumes\/Data\/agents\/output/)
})

test('the folder a run is told to write its JSON to is one of the Codex writable roots', () => {
  const invocation = codexInvocation(spec())
  const prompt = invocation.args.at(-1) ?? ''
  const runDir = /--emit-json=(\S+)/.exec(prompt)?.[1]
  assert.equal(runDir, spec().runDir)
  const roots = invocation.args.filter((arg, index) => invocation.args[index - 1] === '--add-dir')
  assert.ok(roots.includes(runDir ?? ''), `expected ${String(runDir)} among ${roots.join(', ')}`)
})

test('a request is the command, its arguments and --emit-json, with / for Claude and $ for Codex', () => {
  assert.equal(requestText('/', 'review-dependabot', ['114'], '/r/1'), '/review-dependabot 114 --emit-json=/r/1')
  assert.equal(requestText('$', 'review-pr', ['101', '--no-post'], '/r/2'), '$review-pr 101 --no-post --emit-json=/r/2')
})

test('the resume command starts in the run\'s folder; Codex\'s carries its model and sandbox again', () => {
  assert.equal(runners.claude.resume('~/dev/orbit', 'sess-1', spec(), '/home/tester'), 'cd ~/dev/orbit && claude --resume sess-1')
  // a resumed Claude session comes back on the model it ran with (checked against Claude Code 2.1.312), so the model is not repeated
  assert.equal(runners.claude.resume('~/dev/orbit', 'sess-1', spec({ claudeModel: 'opus' }), '/home/tester'), 'cd ~/dev/orbit && claude --resume sess-1')
  assert.equal(
    runners.codex.resume('~/dev/orbit', 'th-9', spec({ codexModel: 'gpt-6.1-terra', reportsDir: '/home/tester/agents/output', worktreesDir: '/home/tester/agents/worktrees' }), '/home/tester'),
    'cd ~/dev/orbit && codex resume th-9 -m gpt-6.1-terra -s workspace-write -c sandbox_workspace_write.network_access=true --add-dir ~/dev/orbit/.git --add-dir ~/.local/state/pit-view/runs/3 --add-dir ~/agents/output --add-dir ~/agents/worktrees',
  )
  // a folder with a space is quoted, ~ left bare
  assert.equal(shellPath('~/dev/my orbit'), `~/'dev/my orbit'`)
  assert.equal(shellPath(`/tmp/it's`), `'/tmp/it'\\''s'`)
})

test('the child environment is built from scratch: home, user, shell, language, temp, PATH, and the git credential config only', () => {
  const env = childEnv({
    PATH: '/opt/bin:/usr/bin', USER: 'tester', LOGNAME: 'tester', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', TMPDIR: '/tmp/x/',
    HOME: '/elsewhere', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'desktop', ANTHROPIC_API_KEY: 'sk-fake', GH_TOKEN: 'gho_fake', SSH_AUTH_SOCK: '/var/run/com.apple.launchd.abc/Listeners', GIT_CONFIG_COUNT: '9', EMPTY: '',
  }, '/home/tester')
  assert.deepEqual(env, {
    HOME: '/home/tester', USER: 'tester', LOGNAME: 'tester', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', TMPDIR: '/tmp/x/', PATH: '/opt/bin:/usr/bin',
    ...gitConfigEnv,
  })
  // no token, no agent socket: the run's git asks the helper for credentials instead of holding any
  assert.equal(Object.keys(env).includes('GH_TOKEN'), false)
  assert.equal(Object.keys(env).includes('SSH_AUTH_SOCK'), false)
  // the git config is the launcher's, never the server's own
  assert.equal(env.GIT_CONFIG_COUNT, '2')
  assert.deepEqual(childEnv({ LANG: '' }, '/home/tester'), { HOME: '/home/tester', ...gitConfigEnv })
})

// default runs

test('a row\'s default run: Review, Re-review, Self-review with --no-post, and review-dependabot for Dependabot', async () => {
  const config = baseConfig()
  const prs = await fixturePrs()
  // 113: never reviewed by the viewer; 106: the viewer commented earlier
  assert.deepEqual(defaultRun(prs.get(113)!, config), { kind: 'review', label: 'Review', command: 'review-pr', args: ['113'] })
  assert.deepEqual(defaultRun(prs.get(106)!, config), { kind: 'reReview', label: 'Re-review', command: 'review-pr', args: ['106'] })
  // own PRs never post and never fix: 104 awaiting review, 101 with changes requested still unanswered
  assert.deepEqual(defaultRun(prs.get(104)!, config), { kind: 'selfReview', label: 'Self-review', command: 'review-pr', args: ['104', '--no-post'] })
  assert.deepEqual(defaultRun(prs.get(101)!, config), { kind: 'selfReview', label: 'Self-review', command: 'review-pr', args: ['101', '--no-post'] })
  assert.deepEqual(defaultRun(prs.get(114)!, config), { kind: 'review', label: 'Review', command: 'review-dependabot', args: ['114'] })
  // review-dependabot refuses other bots' branches, so Renovate gets an ordinary review
  assert.deepEqual(defaultRun(prs.get(115)!, config), { kind: 'review', label: 'Review', command: 'review-pr', args: ['115'] })
  for (const pr of prs.values()) assert.notEqual(defaultRun(pr, config).command, 'review-local')
})

// the Agent cell

test('an idle cell offers the default run with the configured runner and says when the last review was', async () => {
  const config = { ...baseConfig(), agent: { runner: 'codex' as const, claudeModel: 'sonnet' } }
  const others = agentCell(await prOf(106), config, undefined, undefined)
  assert.equal(others.state, 'idle')
  assert.equal(others.label, 'Re-review')
  assert.deepEqual(others.action, { kind: 'reReview', label: 'Re-review', command: 'review-pr', args: ['106'], runner: 'codex' })
  // the viewer's latest review of an others' PR
  const pr106 = await prOf(106)
  const viewerReview = pr106.latestReviews.nodes.find((review) => review.author?.login === scenario.viewer)
  assert.equal(others.lastReviewAt, viewerReview?.submittedAt)
  // the self-review report's time on the viewer's own PR
  const report = { file: 'PR-104.md', reviewedSha: 'abc1234', at: '2026-10-20T10:00:00.000Z', tandem: false }
  assert.equal(agentCell(await prOf(104), config, undefined, report).lastReviewAt, '2026-10-20T10:00:00.000Z')
  assert.equal(agentCell(await prOf(104), config, undefined, undefined).lastReviewAt, null)
  assert.equal(agentCell(await prOf(113), config, undefined, undefined).lastReviewAt, null)
})

test('a running cell carries the run, its last step and the resume command', async () => {
  const cell = agentCell(await prOf(106), baseConfig(), runRow({ lastStepAt: '2026-10-26T14:01:00Z', step: 'review', stepState: 'started', costUsd: 0.21 }), undefined)
  assert.equal(cell.state, 'running')
  assert.equal(cell.runId, 7)
  assert.equal(cell.runner, 'claude')
  assert.equal(cell.command, 'review-pr')
  assert.equal(cell.label, 'Re-review')
  assert.deepEqual(cell.step, { name: 'review', state: 'started' })
  assert.equal(cell.lastStepAt, '2026-10-26T14:01:00Z')
  assert.equal(cell.text, null)
  assert.equal(cell.resume, 'cd ~/dev/orbit && claude --resume sess-1')
  assert.equal(cell.costUsd, 0.21)
})

test('the done text follows section 8\'s mapping of verdict and posted', () => {
  const done = (patch: Record<string, unknown>, ownDraft = false): string =>
    doneText({ status: 'done', note: null, result: reviewResult(patch) as unknown as RunResultJson }, ownDraft)
  assert.equal(done({ verdict: 'changesRequested' }), 'Changes requested')
  assert.equal(done({ verdict: 'clean', findings: [], posted: { form: 'approve', url: 'https://example.test/r/1' } }), 'Approved')
  assert.equal(done({ verdict: 'clean', findings: [], posted: { form: 'comment', url: 'https://example.test/r/1' } }), 'Clean · CI failed')
  assert.equal(done({ verdict: 'clean', findings: [], posted: null, notPostedReason: 'noPost' }, true), 'Clean · mark ready?')
  assert.equal(done({ verdict: 'clean', findings: [], posted: null, notPostedReason: 'noPost' }, false), 'Clean')
  assert.equal(done({ verdict: 'changesRequested', posted: null, notPostedReason: 'ghFailed', error: 'gh: HTTP 502' }), 'Changes requested · post failed')
  assert.equal(doneText({ status: 'needsInput', note: null, result: null }, false), 'Needs your answer')
  assert.equal(doneText({ status: 'stopped', note: null, result: null }, false), 'Stopped')
  assert.equal(doneText({ status: 'failed', note: 'noResult: no result.json; exit code 1; last event: none', result: null }, false), 'Failed · no result')
  assert.equal(doneText({ status: 'failed', note: 'noReport: ~/agents/output/PR-1.md does not exist', result: null }, false), 'Failed · no report')
  assert.equal(doneText({ status: 'failed', note: 'permissionDenied: Write', result: null }, false), 'Failed · permission denied')
  assert.equal(doneText({ status: 'failed', note: 'serverRestarted', result: null }, false), 'Failed · server restarted')
  assert.equal(doneText({ status: 'failed', note: 'the branch has no PR', result: null }, false), 'Failed')
})

test('Clean · mark ready? only on the viewer\'s own draft, and a moved head returns a finished cell to idle', async () => {
  const config = baseConfig()
  const draft = await prOf(103)
  const cleanAt = (sha: string): RunResultJson => reviewResult({ verdict: 'clean', findings: [], posted: null, notPostedReason: 'noPost', reviewed: { kind: 'commit', sha } }) as unknown as RunResultJson
  const clean = cleanAt(draft.headRefOid)
  const ownDraft = agentCell(draft, config, runRow({ number: 103, label: 'Self-review', status: 'done', result: clean, finishedAt: '2026-10-26T14:03:00Z' }), undefined)
  assert.equal(ownDraft.state, 'done')
  assert.equal(ownDraft.text, 'Clean · mark ready?')
  assert.equal(ownDraft.label, 'Self-review')
  assert.deepEqual(ownDraft.result, { kind: 'review', verdict: 'clean', recommendation: null, findings: 0, ci: 'green', posted: null, notPostedReason: 'noPost', report: '~/agents/output/PR-106.md' })
  const notDraft = agentCell(await prOf(104), config, runRow({ number: 104, status: 'done', result: cleanAt((await prOf(104)).headRefOid) }), undefined)
  assert.equal(notDraft.text, 'Clean')
  // the head moved past the reviewed commit: the next move is the idle action again
  const moved = agentCell(await prOf(106), config, runRow({ status: 'done', result: reviewResult({ reviewed: { kind: 'commit', sha: '0123456789abcdef0123456789abcdef01234567' } }) as unknown as RunResultJson }), undefined)
  assert.equal(moved.state, 'idle')
  assert.equal(moved.label, 'Re-review')
  assert.equal(moved.runId, 7)
  // the cell carries the commit the run record names, never the PR's current head
  assert.equal(moved.commit, '0123456789abcdef0123456789abcdef01234567')
  assert.equal(agentCell(await prOf(106), config, runRow({ status: 'needsInput', result: reviewResult({ status: 'needsInput', reviewed: null }) as unknown as RunResultJson }), undefined).commit, null)
  assert.equal(agentCell(await prOf(106), config, runRow({ status: 'stopped', result: null }), undefined).commit, null)
  assert.equal(agentCell(await prOf(106), config, undefined, undefined).commit, null)
  // a waiting run shows its question
  const waiting = agentCell(await prOf(106), config, runRow({ status: 'needsInput', result: reviewResult({ status: 'needsInput', reviewed: null, question: 'Fix now, or stop here?' }) as unknown as RunResultJson }), undefined)
  assert.equal(waiting.state, 'done')
  assert.equal(waiting.question, 'Fix now, or stop here?')
  assert.equal(waiting.text, 'Needs your answer')
})

// the starts the drawer offers

test('a PR offers its default run, the same review in tandem, and a stack review only when stacked', async () => {
  const config = baseConfig()
  const stacked = { position: 2, size: 3 }
  const options = async (number: number, stack: typeof stacked | null = null) => startOptions(await prOf(number), config, stack, false)
  const summary = (list: Awaited<ReturnType<typeof options>>) => list.map((option) => [option.kind, option.label, option.button, option.command, option.args])

  assert.deepEqual(summary(await options(113)), [
    ['default', 'Review', 'Review PR', 'review-pr', ['113']],
    ['tandem', 'Tandem review', 'Review in tandem', 'review-pr', ['113', '--tandem']],
  ])
  assert.deepEqual(summary(await options(106, stacked)), [
    ['default', 'Re-review', 'Re-review PR', 'review-pr', ['106']],
    ['tandem', 'Tandem re-review', 'Re-review in tandem', 'review-pr', ['106', '--tandem']],
    ['stack', 'Review stack', 'Review stack', 'review-stack', ['106']],
  ])
  // the viewer's own PR never posts a review, tandem or not; its fix session pushes, so it has no --no-post
  assert.deepEqual(summary(await options(104)), [
    ['default', 'Self-review', 'Self-review', 'review-pr', ['104', '--no-post']],
    ['tandem', 'Tandem self-review', 'Self-review in tandem', 'review-pr', ['104', '--tandem', '--no-post']],
    ['fix', 'Fix session', 'Fix requested changes', 'fix-pr', ['104']],
  ])
  // review-dependabot has no tandem mode; Renovate's PRs are ordinary reviews and do
  assert.deepEqual(summary(await options(114)), [['default', 'Review', 'Review PR', 'review-dependabot', ['114']]])
  assert.deepEqual((await options(115)).map((option) => option.kind), ['default', 'tandem'])
  // nothing offered is ever review-local, review-pr's fix mode, or an unflagged review of the viewer's own PR
  for (const number of [101, 103, 104, 120]) {
    for (const option of await options(number, stacked)) {
      assert.notEqual(option.command, 'review-local')
      if (option.command === 'review-pr') assert.ok(option.args.includes('--no-post'), `${option.kind} on #${number}`)
    }
  }
})

test('each start says which runners it works with and what it does on GitHub', async () => {
  const config = baseConfig()
  const stacked = { position: 1, size: 2 }
  const posts = async (number: number) => Object.fromEntries(startOptions(await prOf(number), config, stacked, false).map((option) => [option.kind, [option.runners, option.posts]]))
  const review = { kind: 'review', text: 'Posts its report to the PR as @vera-quill: an approval, a request for changes, or a comment, per the findings.' }
  const stack = { kind: 'offer', text: 'Posts nothing; writes the report only. It stops to offer posting it on the top PR, and you answer in the session.' }
  assert.deepEqual(await posts(113), { default: [['claude', 'codex'], review], tandem: [['claude'], review], stack: [['claude', 'codex'], stack] })
  const nothing = { kind: 'nothing', text: 'Posts nothing; writes the report only.' }
  const push = { kind: 'push', text: 'Pushes new commits to feat/sync-status-endpoint on GitHub. It posts no replies or reviews, and stops to ask when a request needs judgment.' }
  assert.deepEqual(await posts(104), { default: [['claude', 'codex'], nothing], tandem: [['claude'], nothing], stack: [['claude', 'codex'], stack], fix: [['claude'], push] })
  assert.deepEqual((await posts(114)).default, [['claude', 'codex'], { kind: 'autoApprove', text: 'Posts its report to the PR as @vera-quill and may approve the PR automatically.' }])
})

test('a start is marked unavailable with its reason while a run is in flight or cloneDir is unset', async () => {
  const pr = await prOf(113)
  assert.deepEqual(startOptions(pr, baseConfig(), null, false).map((option) => option.unavailable), [null, null])
  assert.deepEqual(startOptions(pr, baseConfig(), null, true).map((option) => option.unavailable), ['a run for #113 is already in flight', 'a run for #113 is already in flight'])
  const { cloneDir: _cloneDir, ...unset } = baseConfig()
  assert.match(startOptions(pr, unset as Config, null, false)[0]?.unavailable ?? '', /set cloneDir in the config to your local clone of octo-example\/orbit/)
  // a run in flight wins the reason, since fixing the clone would not help
  const cell = agentCell(pr, baseConfig(), runRow({ number: 113 }), undefined, null)
  assert.ok(cell.starts.every((option) => option.unavailable?.includes('in flight')))
  assert.ok(agentCell(pr, baseConfig(), runRow({ number: 113, status: 'done' }), undefined, null).starts.every((option) => option.unavailable === null))
})

test('why a kind is not offered is a sentence for the refusal', async () => {
  const config = baseConfig()
  assert.equal(notOffered('default', await prOf(114), config, null), null)
  assert.equal(notOffered('tandem', await prOf(113), config, null), null)
  assert.match(notOffered('tandem', await prOf(114), config, null) ?? '', /#114.*review-dependabot has no tandem mode/)
  assert.match(notOffered('stack', await prOf(113), config, null) ?? '', /#113.*not part of a stack/)
  assert.equal(notOffered('stack', await prOf(111), config, { position: 2, size: 3 }), null)
})

// step slots

const event = (step: StepEvent['step'], state: StepEvent['state'], at: string, note: string | null = null): StepEvent => ({ step, state, at, note })

test('five slots in fixed order, every one pending until its line arrives, and the latest line per step wins', () => {
  const empty = emptySteps()
  assert.deepEqual(empty.map((slot) => [slot.step, slot.state, slot.at, slot.note]), [
    ['resolveBase', 'pending', null, null], ['review', 'pending', null, null], ['consolidate', 'pending', null, null],
    ['writeReport', 'pending', null, null], ['post', 'pending', null, null],
  ])
  const folded = foldSteps(empty, [
    event('resolveBase', 'started', '2026-10-28T14:00:00Z'),
    event('resolveBase', 'done', '2026-10-28T14:00:05Z'),
    event('review', 'started', '2026-10-28T14:00:06Z', 'primary reviewing'),
    event('consolidate', 'skipped', '2026-10-28T14:00:07Z', 'no tandem review'),
  ])
  assert.deepEqual(folded.map((slot) => [slot.step, slot.state, slot.at, slot.note]), [
    ['resolveBase', 'done', '2026-10-28T14:00:05Z', null],
    ['review', 'started', '2026-10-28T14:00:06Z', 'primary reviewing'],
    ['consolidate', 'skipped', '2026-10-28T14:00:07Z', 'no tandem review'],
    ['writeReport', 'pending', null, null],
    ['post', 'pending', null, null],
  ])
  // a step appended again (a re-run after a fix) replaces its earlier line, and folding never mutates its input
  const again = foldSteps(folded, [event('review', 'started', '2026-10-28T14:09:00Z', 'second pass')])
  assert.deepEqual([again[1]?.state, again[1]?.at, again[1]?.note], ['started', '2026-10-28T14:09:00Z', 'second pass'])
  assert.equal(folded[1]?.note, 'primary reviewing')
  assert.equal(empty[0]?.state, 'pending')
})

test('a run that never stepped, or whose folder is gone, has five pending slots rather than an error', () => {
  assert.deepEqual(stepsOf(runRow()), emptySteps())
  const stepped = foldSteps(emptySteps(), [event('post', 'done', '2026-10-28T14:00:00Z')])
  assert.equal(stepsOf(runRow({ steps: stepped })), stepped)
  const view = runView(runRow({ args: ['106', '--tandem'] }))
  assert.deepEqual([view.steps.length, view.tandem, isTandemRun(['106']), isTandemRun(['106', '--tandem', '--no-post'])], [5, true, false, true])
})

test('the cell carries the latest run\'s steps and whether it was a tandem review, also once idle', async () => {
  const config = baseConfig()
  const steps = foldSteps(emptySteps(), [event('resolveBase', 'done', '2026-10-28T14:00:05Z'), event('review', 'started', '2026-10-28T14:00:06Z', 'secondary running')])
  const cell = agentCell(await prOf(106), config, runRow({ args: ['106', '--tandem'], label: 'Tandem re-review', steps }), undefined)
  assert.deepEqual(cell.steps, steps)
  assert.equal(cell.tandem, true)
  assert.deepEqual([agentCell(await prOf(106), config, undefined, undefined).tandem, agentCell(await prOf(106), config, undefined, undefined).steps], [false, emptySteps()])
  // the head moved on: idle again, still carrying the run for the drawer
  const moved = agentCell(await prOf(106), config, runRow({ args: ['106', '--tandem'], steps, status: 'done', result: reviewResult({ reviewed: { kind: 'commit', sha: '0123456789abcdef0123456789abcdef01234567' } }) as unknown as RunResultJson }), undefined)
  assert.deepEqual([moved.state, moved.tandem, moved.steps], ['idle', true, steps])
})

test('a finished stack review stays done: it read the top layer, whose commit is not this PR\'s head', async () => {
  const result = reviewResult({ command: 'review-stack', reviewed: { kind: 'commit', sha: '0123456789abcdef0123456789abcdef01234567' } }) as unknown as RunResultJson
  const cell = agentCell(await prOf(111), baseConfig(), runRow({ number: 111, command: 'review-stack', args: ['111'], label: 'Review stack', status: 'done', result }), undefined, { position: 2, size: 3 })
  assert.equal(cell.state, 'done')
  assert.equal(cell.label, 'Review stack')
})

// the emit-json files

test('result.json is checked against its schema; anything else is no result', () => {
  assert.equal(parseResult(JSON.stringify(reviewResult())).ok, true)
  const sweep = { schema: 'pit-crew/sweep-result@1', command: 'review-dependabot-sweep', status: 'done', repo: scenario.repo, counts: { swept: 0, fresh: 0, reused: 0, failed: 0 }, rows: [], mergeOrder: [], summary: null, question: null, error: null }
  assert.equal(parseResult(JSON.stringify(sweep)).ok, true)
  const refusals: [unknown, RegExp][] = [
    ['{not json', /not valid JSON/],
    [[], /one JSON object/],
    [{ ...reviewResult(), schema: 'pit-crew/review-result@2' }, /unknown schema/],
    [(({ ci: _ci, ...rest }) => rest)(reviewResult()), /ci is missing/],
    [reviewResult({ status: 'needsInput', question: null }), /must carry its question/],
    [reviewResult({ status: 'failed', error: null }), /must carry its error/],
    [reviewResult({ verdict: 'lgtm' }), /verdict/],
    [reviewResult({ posted: { form: 'merge', url: 'x' } }), /posted/],
    [reviewResult({ findings: [{ priority: 'P5', summary: 'x', files: [] }] }), /findings/],
    [{ ...sweep, counts: { swept: 1 } }, /counts/],
  ]
  for (const [value, pattern] of refusals) {
    const parsed = parseResult(typeof value === 'string' ? value : JSON.stringify(value))
    assert.equal(parsed.ok, false)
    assert.match(parsed.ok ? '' : parsed.error, pattern)
  }
})

test('a sweep result carries notPostedReason as null or noPost, and one written before the field reads as null', () => {
  const sweep = { schema: 'pit-crew/sweep-result@1', command: 'review-dependabot-sweep', status: 'done', repo: scenario.repo, counts: { swept: 0, fresh: 0, reused: 0, failed: 0 }, notPostedReason: null, rows: [], mergeOrder: [], summary: null, question: null, error: null }
  const reasonOf = (value: unknown): unknown => {
    const parsed = parseResult(JSON.stringify(value))
    assert.equal(parsed.ok, true)
    return parsed.ok ? (parsed.value as { notPostedReason?: unknown }).notPostedReason : undefined
  }
  assert.equal(reasonOf(sweep), null)
  assert.equal(reasonOf({ ...sweep, notPostedReason: 'noPost' }), 'noPost')
  // written before the field existed: accepted, and read as null
  const { notPostedReason: _reason, ...old } = sweep
  assert.equal(reasonOf(old), null)
  for (const bad of ['ownPr', 'ghFailed', 'awaitingAnswer', '', 7, false]) {
    const parsed = parseResult(JSON.stringify({ ...sweep, notPostedReason: bad }))
    assert.equal(parsed.ok, false)
    assert.match(parsed.ok ? '' : parsed.error, /notPostedReason must be noPost or null/)
  }
  // only the sweep schema may omit it
  const { notPostedReason: _missing, ...review } = reviewResult()
  const parsedReview = parseResult(JSON.stringify(review))
  assert.equal(parsedReview.ok, false)
  assert.match(parsedReview.ok ? '' : parsedReview.error, /notPostedReason is missing/)
})

test('a failed or needsInput sweep may carry a null repo and null counts, and a done one may not', () => {
  const done = { schema: 'pit-crew/sweep-result@1', command: 'review-dependabot-sweep', status: 'done', repo: scenario.repo, counts: { swept: 0, fresh: 0, reused: 0, failed: 0 }, notPostedReason: 'noPost', rows: [], mergeOrder: [], summary: null, question: null, error: null }
  const preflight = { ...done, status: 'failed', repo: null, counts: null, error: 'the repository is not reachable under this identity' }
  const parsed = parseResult(JSON.stringify(preflight))
  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    const value = parsed.value as { error?: unknown, notPostedReason?: unknown }
    assert.equal(value.error, preflight.error)
    assert.equal(value.notPostedReason, 'noPost')
  }
  const asking = { ...done, status: 'needsInput', repo: null, counts: null, question: 'Which clone should the sweep use?' }
  assert.equal(parseResult(JSON.stringify(asking)).ok, true)
  for (const [field, message] of [['repo', /repo must be a string/], ['counts', /counts must hold/]] as const) {
    const rejected = parseResult(JSON.stringify({ ...done, [field]: null }))
    assert.equal(rejected.ok, false)
    assert.match(rejected.ok ? '' : rejected.error, message)
  }
  // null is the only other value: a failed result still rejects a wrong type
  assert.equal(parseResult(JSON.stringify({ ...preflight, repo: 7 })).ok, false)
  assert.equal(parseResult(JSON.stringify({ ...preflight, counts: {} })).ok, false)
})

test('an events.jsonl line is read only when it has the four fields of the contract', () => {
  assert.deepEqual(parseStepEvent('{"at":"2026-10-28T14:03:12Z","step":"consolidate","state":"skipped","note":"no tandem review"}'),
    { at: '2026-10-28T14:03:12Z', step: 'consolidate', state: 'skipped', note: 'no tandem review' })
  assert.equal(parseStepEvent('{"at":"2026-10-28T14:03:12Z","step":"lint","state":"started","note":null}'), null)
  assert.equal(parseStepEvent('{"at":"yesterday","step":"review","state":"started","note":null}'), null)
  assert.equal(parseStepEvent('half a line'), null)
})

test('posted.url must be an absolute http or https URL, so a hostile result.json cannot plant a script link; such a run fails as noResult', () => {
  const good = ['https://github.com/octo-example/orbit/pull/101#pullrequestreview-1', 'http://example.test/x']
  for (const url of good) assert.equal(parseResult(JSON.stringify(reviewResult({ posted: { form: 'comment', url } }))).ok, true, url)
  const bad = [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', 'javascript&colon;alert(1)',
    'java&#115;cript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', '//example.test/x', '/pull/101', 'pull/101', 'mailto:a@example.test',
    'https://example.test/x y', 'https://example.test/\u0000', '', 'https://', 42, null, { href: 'https://example.test' },
  ]
  for (const url of bad) {
    const parsed = parseResult(JSON.stringify(reviewResult({ posted: { form: 'comment', url } })))
    assert.equal(parsed.ok, false, String(url))
    assert.match(parsed.ok ? '' : parsed.error, /posted must be null or .* http or https url/)
    assert.equal(isHttpUrl(url), false, String(url))
  }
  assert.equal(isHttpUrl('https://example.test/ok'), true)
  // the existing settle path: an invalid result is no result at all
  const settled = judge({
    stopped: false, restarted: false, exit: { code: 0, signal: null, error: null }, reportExists: true, denials: [], lastEvent: null,
    parsed: parseResult(JSON.stringify(reviewResult({ posted: { form: 'comment', url: 'javascript:alert(1)' } }))),
  })
  assert.equal(settled.status, 'failed')
  assert.equal(settled.result, null)
  assert.match(settled.note ?? '', /^noResult: result.json: posted must be/)
})

// settling

test('settling reads result.json alone: done, failed, needsInput, noResult, noReport, permissionDenied, stopped, serverRestarted', () => {
  const base = { stopped: false, restarted: false, exit: { code: 0, signal: null, error: null }, reportExists: true, denials: [], lastEvent: '{"type":"result"}' }
  const parsed = (patch: Record<string, unknown> = {}) => parseResult(JSON.stringify(reviewResult(patch)))
  assert.deepEqual(judge({ ...base, parsed: parsed() }).status, 'done')
  assert.deepEqual(judge({ ...base, parsed: parsed({ status: 'failed', error: 'no PR exists for this branch' }) }), {
    status: 'failed', note: 'no PR exists for this branch', result: reviewResult({ status: 'failed', error: 'no PR exists for this branch' }),
  })
  assert.equal(judge({ ...base, parsed: parsed({ status: 'needsInput', question: 'Post it?' }) }).status, 'needsInput')
  // the exit code never decides by itself: a done result with a non-zero exit is done
  assert.equal(judge({ ...base, exit: { code: 1, signal: null, error: null }, parsed: parsed() }).status, 'done')
  assert.deepEqual(judge({ ...base, exit: { code: 1, signal: null, error: null }, parsed: null }), {
    status: 'failed', note: 'noResult: no result.json; exit code 1; last event: {"type":"result"}', result: null,
  })
  assert.match(judge({ ...base, parsed: parseResult('{') }).note ?? '', /^noResult: result.json is not valid JSON; exit code 0/)
  assert.deepEqual(judge({ ...base, reportExists: false, parsed: parsed() }).note, 'noReport: ~/agents/output/PR-106.md does not exist')
  assert.deepEqual(judge({ ...base, reportExists: null, parsed: parsed({ report: null }) }).note, 'noReport: result.json names no report')
  // a denied tool call fails the run even when result.json says done
  assert.deepEqual(judge({ ...base, denials: ['Write', 'Bash', 'Write'], parsed: parsed() }).note, 'permissionDenied: Write, Bash')
  assert.equal(judge({ ...base, stopped: true, denials: ['Write'], parsed: null }).status, 'stopped')
  assert.deepEqual(judge({ ...base, exit: null, restarted: true, parsed: null }), { status: 'failed', note: 'serverRestarted', result: null })
  assert.equal(judge({ ...base, exit: null, restarted: true, parsed: parsed() }).status, 'done')
  assert.equal(judge({ ...base, exit: { code: null, signal: null, error: 'spawn claude ENOENT' }, parsed: null }).note, 'spawnFailed: spawn claude ENOENT')
  // a sweep with nothing to sweep names no summary and is still done
  const idleSweep = parseResult(JSON.stringify({ schema: 'pit-crew/sweep-result@1', command: 'review-dependabot-sweep', status: 'done', repo: scenario.repo, counts: { swept: 0, fresh: 0, reused: 0, failed: 0 }, rows: [], mergeOrder: [], summary: null, question: null, error: null }))
  assert.equal(judge({ ...base, reportExists: null, parsed: idleSweep }).status, 'done')
})

test('stdin closes once a result arrives while no background task is outstanding', () => {
  let state = emptyStream()
  const fold = (event: unknown): boolean => {
    const next = foldStream(state, JSON.stringify(event))
    state = next.state
    return next.closeStdin
  }
  // hook events come before init, and the order of event types is never relied on
  assert.equal(fold({ type: 'system', subtype: 'hook_response' }), false)
  assert.equal(fold({ type: 'system', subtype: 'init', session_id: 'sess-1' }), false)
  assert.equal(fold({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ id: 't1', status: 'running' }] }), false)
  // a tandem primary's turn ends while its secondary runs: stdin stays open
  assert.equal(fold({ type: 'result', subtype: 'success', total_cost_usd: 0.4, permission_denials: [] }), false)
  assert.equal(state.costUsd, 0.4)
  assert.equal(fold({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ id: 't1', status: 'completed' }] }), false)
  // the notification's turn ends with nothing in the background
  assert.equal(fold({ type: 'result', subtype: 'success', total_cost_usd: 0.9, permission_denials: [{ tool_name: 'Write', tool_use_id: 'x' }] }), true)
  assert.deepEqual(state.denials, ['Write'])
  assert.equal(state.costUsd, 0.9)
  assert.equal(foldStream(state, 'not json').closeStdin, false)
  // Codex names its session in its first event
  assert.equal(foldStream(emptyStream(), '{"type":"thread.started","thread_id":"th-1"}').state.sessionId, 'th-1')
})

test('ps output parses, and a stop kills every descendant\'s process group with the runner\'s last', () => {
  assert.deepEqual(parsePs('  4001     1  4001\n 4002  4001  4001\nbad line\n 5000  4002  5000\n'), [
    { pid: 4001, ppid: 1, pgid: 4001 }, { pid: 4002, ppid: 4001, pgid: 4001 }, { pid: 5000, ppid: 4002, pgid: 5000 },
  ])
  const tree = [
    { pid: 4001, ppid: 1, pgid: 4001 }, { pid: 4002, ppid: 4001, pgid: 4001 }, { pid: 5000, ppid: 4002, pgid: 5000 },
    { pid: 5001, ppid: 5000, pgid: 5001 }, { pid: 5002, ppid: 5000, pgid: 5000 }, { pid: 6000, ppid: 1, pgid: 6000 },
  ]
  assert.deepEqual(descendantGroups(tree, 4001), [5000, 5001, 4001])
})

test('a clone is recognized by any remote naming the repo, over https or ssh', () => {
  assert.equal(remoteNamesRepo(fakeRemotes('octo-example/orbit'), 'octo-example/orbit'), true)
  assert.equal(remoteNamesRepo('upstream\thttps://github.com/Octo-Example/Orbit (fetch)\n', 'octo-example/orbit'), true)
  assert.equal(remoteNamesRepo('origin\thttps://github.com/octo-example/orbit-docs.git (fetch)\n', 'octo-example/orbit'), false)
  assert.equal(remoteNamesRepo('', 'octo-example/orbit'), false)
})

// the launcher, with fake processes and a real temp folder

type HarnessOptions = { config?: Partial<Config>, launch?: FakeLaunch, gh?: FakeRunner, keepRuns?: number }

const harness = async ({ config = {}, launch = fakeLaunch(), gh = fixtureRunner(), keepRuns }: HarnessOptions = {}) => {
  const temp = await tempDir()
  // resolved, so the reports folder's real path is still under it on macOS
  const home = await realpath(temp.dir)
  await mkdir(join(home, 'agents', 'output'), { recursive: true })
  await mkdir(join(home, 'agents', 'worktrees'), { recursive: true })
  const time = fakeTime()
  const cache = openCache({ path: ':memory:', clock: time.clock, ...(keepRuns === undefined ? {} : { keepRuns }) })
  const changes: Run[] = []
  // the ids the launcher announced as its own to watch, in order
  const watched: number[] = []
  const settings = { current: { ...baseConfig(), ...config } }
  const stateDir = join(home, '.local', 'state', 'pit-view')
  const make = (onChange: (run: Run) => void = (run) => changes.push(run), onQueueing?: () => void) => createLauncher({
    cache,
    gh: createGh(gh.runner),
    git: launch.deps.git,
    spawn: launch.deps.spawn,
    fs: launch.deps.fs,
    kill: launch.deps.kill,
    procs: launch.deps.procs,
    clock: time.clock,
    timers: time.timers,
    config: () => settings.current,
    home,
    stateDir,
    env: launch.deps.env,
    newSessionId: launch.deps.newSessionId,
    onWatch: (run) => watched.push(run.id),
    onChange,
    ...(onQueueing === undefined ? {} : { onQueueing }),
  })
  const launcher = make()
  const report = (number: number): Promise<void> => writeFile(join(home, 'agents', 'output', `PR-${number}.md`), 'Reviewed commit: `x` @ `f00dfac`\n')
  const cleanup = async (): Promise<void> => {
    launcher.close()
    cache.close()
    await temp.cleanup()
  }
  return { home, time, cache, launcher, make, changes, watched, settings, stateDir, launch, gh, report, cleanup }
}

const request = (number = 106, patch: Partial<StartRequest> = {}): StartRequest =>
  ({ repo: scenario.repo, number, command: 'review-pr', args: [String(number)], label: 'Re-review', ...patch })

const step = (name: string, state: string, at = '2026-10-26T14:06:00Z', note: string | null = null) => ({ at, step: name, state, note })

test('a start checks gh\'s account, spawns Claude in cloneDir with a clean environment, and records request.json', async () => {
  const h = await harness()
  try {
    const run = await h.launcher.start(request())
    const runDir = join(h.stateDir, 'runs', String(run.id))
    const child = h.launch.children[0]!
    assert.equal(h.launch.children.length, 1)
    assert.equal(child.request.command, 'claude')
    assert.deepEqual(child.request.args, claudeInvocation(spec({ home: h.home, sessionId: '00000000-0000-4000-8000-000000000001' })).args)
    assert.equal(child.request.cwd, join(h.home, 'dev', 'orbit'))
    // the git credential config rides along with the clean environment, so the child's own fetch works
    assert.deepEqual(child.request.env, { HOME: h.home, ...gitConfigEnv, USER: 'tester', LANG: 'en_US.UTF-8', PATH: '/usr/bin:/bin' })
    assert.equal(child.request.stdoutPath, join(runDir, 'stream.jsonl'))
    assert.equal(child.request.stderrPath, join(runDir, 'stderr.log'))
    assert.equal(child.request.stdin, 'pipe')
    assert.deepEqual(child.writes.map((line) => JSON.parse(line)), [{ type: 'user', message: { role: 'user', content: `/review-pr 106 --emit-json=${runDir}` } }])
    assert.equal(child.stdinEnded, false)
    // one GitHub call per start: the identity check
    assert.deepEqual(h.gh.calls.filter((call) => call.args[0] === 'api').map((call) => call.args), [['api', 'user', '--jq', '.login']])
    assert.deepEqual(h.launch.gitCalls, [['-C', join(h.home, 'dev', 'orbit'), 'remote', '-v']])
    const recorded = JSON.parse(await readFile(join(runDir, 'request.json'), 'utf8'))
    assert.equal(recorded.runner, 'claude')
    assert.equal(recorded.command, 'review-pr')
    assert.deepEqual(recorded.args, ['106'])
    assert.equal(recorded.cwd, '~/dev/orbit')
    assert.equal(recorded.sessionId, '00000000-0000-4000-8000-000000000001')
    assert.equal(recorded.pid, child.pid)
    assert.equal(recorded.pidStartedAt, `start-${child.pid}`)
    assert.equal(run.status, 'running')
    assert.equal(run.cwd, '~/dev/orbit')
    assert.equal(run.dir, `~/.local/state/pit-view/runs/${run.id}`)
    assert.equal(run.pid, child.pid)
    assert.equal(run.resume, 'cd ~/dev/orbit && claude --resume 00000000-0000-4000-8000-000000000001')
    assert.deepEqual(h.changes.map((change) => change.status), ['running'])
  } finally {
    await h.cleanup()
  }
})

test('a tandem start is refused for Codex, asked for or configured, before anything runs', async () => {
  const h = await harness({ config: { agent: { runner: 'codex', claudeModel: 'sonnet' } } })
  try {
    const tandem = request(106, { args: ['106', '--tandem'], label: 'Tandem review' })
    const refused = (error: unknown): boolean => error instanceof LaunchError && error.code === 'tandemRunner' && /tandem runs with Claude only/.test(error.message)
    // the configured default is Codex, and no runner was asked for
    await assert.rejects(h.launcher.start(tandem), refused)
    await assert.rejects(h.launcher.start({ ...tandem, runner: 'codex' }), refused)
    assert.equal(h.launch.children.length, 0)
    assert.deepEqual(h.cache.runsFor(scenario.repo, 106), [])
    // Claude is fine, and a start that is not a tandem is unaffected
    const run = await h.launcher.start({ ...tandem, runner: 'claude' })
    assert.equal(run.runner, 'claude')
    assert.equal((await h.launcher.start(request(113, { label: 'Review' }))).runner, 'codex')
  } finally {
    await h.cleanup()
  }
})

test('a start is refused when gh is another account, when cloneDir is unset, and when it is not a clone of the repo', async () => {
  const other = fakeRunner((args) => args[0] === 'api' ? ok('someone-else\n') : ok('gho_fixture_token\n'))
  const mismatch = await harness({ gh: other })
  try {
    await assert.rejects(mismatch.launcher.start(request()), (error: unknown) =>
      error instanceof LaunchError && error.code === 'identityMismatch' && /someone-else/.test(error.message) && error.message.includes(scenario.viewer))
    assert.equal(mismatch.launch.children.length, 0)
    assert.deepEqual(mismatch.cache.runsFor(scenario.repo, 106), [])
  } finally {
    await mismatch.cleanup()
  }
  const unset = await harness({ config: { cloneDir: undefined } })
  try {
    delete unset.settings.current.cloneDir
    await assert.rejects(unset.launcher.start(request()), (error: unknown) => error instanceof LaunchError && error.code === 'noClone' && /cloneDir/.test(error.message))
    assert.equal(unset.launch.children.length, 0)
  } finally {
    await unset.cleanup()
  }
  for (const remotes of [null, fakeRemotes('octo-example/other')]) {
    const wrong = await harness({ launch: fakeLaunch({ remotes }) })
    try {
      await assert.rejects(wrong.launcher.start(request()), (error: unknown) => error instanceof LaunchError && error.code === 'notAClone')
      assert.equal(wrong.launch.children.length, 0)
    } finally {
      await wrong.cleanup()
    }
  }
})

test('one run per PR: a second start is refused while one is in flight, even before the first has its row', async () => {
  const h = await harness()
  try {
    const [first, second] = await Promise.allSettled([h.launcher.start(request()), h.launcher.start(request())])
    assert.equal(first.status, 'fulfilled')
    assert.ok(second.status === 'rejected' && second.reason instanceof LaunchError && second.reason.code === 'busy')
    await assert.rejects(h.launcher.start(request()), (error: unknown) => error instanceof LaunchError && error.code === 'busy')
    // another PR may start meanwhile, within the cap of two reviews at once
    await h.launcher.start(request(113, { label: 'Review' }))
    assert.equal(h.launch.children.length, 2)
    // once settled, the PR may start again
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(1)
    await h.launcher.start(request())
    assert.equal(h.launch.children.length, 3)
  } finally {
    await h.cleanup()
  }
})

test('steps come from events.jsonl, stdin closes on the right result, and the run settles done from result.json', async () => {
  const h = await harness()
  try {
    const run = await h.launcher.start(request())
    const child = h.launch.children[0]!
    await child.events(step('resolveBase', 'started', '2026-10-26T14:06:00Z'), step('resolveBase', 'done', '2026-10-26T14:06:10Z'), 'half a li')
    await child.stream({ type: 'system', subtype: 'init' }, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ id: 't1', status: 'running' }] }, { type: 'result', total_cost_usd: 0.31, permission_denials: [] })
    await h.launcher.check()
    let stored = h.cache.getRun(run.id)!
    assert.deepEqual([stored.lastStepAt, stored.step, stored.stepState, stored.costUsd], ['2026-10-26T14:06:10Z', 'resolveBase', 'done', 0.31])
    assert.equal(child.stdinEnded, false, 'a background task is outstanding')
    await child.stream({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
    await h.launcher.check()
    assert.equal(child.stdinEnded, false, 'no result since the tasks finished')
    await child.events(step('review', 'started', '2026-10-26T14:07:00Z'))
    await child.stream({ type: 'result', total_cost_usd: 0.74, permission_denials: [] })
    await h.launcher.check()
    assert.equal(child.stdinEnded, true)
    stored = h.cache.getRun(run.id)!
    assert.deepEqual([stored.step, stored.stepState, stored.costUsd], ['review', 'started', 0.74])
    await h.report(106)
    await child.result(reviewResult())
    const settled = h.launcher.settled(run.id)
    h.time.advance(5 * second)
    child.exit(0)
    const final = await settled
    assert.equal(final.status, 'done')
    assert.equal(final.finishedAt, '2026-10-26T14:05:43Z')
    assert.equal(final.note, null)
    assert.equal(final.result?.schema, 'pit-crew/review-result@1')
    assert.equal(final.costUsd, 0.74)
    // started, the two reads that changed the row (the background tasks alone change nothing), settled
    assert.deepEqual(h.changes.map((change) => change.status), ['running', 'running', 'running', 'done'])
  } finally {
    await h.cleanup()
  }
})

test('every events.jsonl line folds into the run\'s five step slots, and a change to only a step\'s note still changes the row', async () => {
  const h = await harness()
  try {
    const run = await h.launcher.start(request(106, { args: ['106', '--tandem'], label: 'Tandem re-review' }))
    assert.equal(run.steps, null)
    const child = h.launch.children[0]!
    await child.events(step('resolveBase', 'started', '2026-10-26T14:06:00Z'), step('resolveBase', 'done', '2026-10-26T14:06:10Z'), step('review', 'started', '2026-10-26T14:06:20Z', 'primary reviewing'))
    await h.launcher.check()
    let stored = h.cache.getRun(run.id)!
    assert.deepEqual(stored.steps?.map((slot) => [slot.step, slot.state, slot.at, slot.note]), [
      ['resolveBase', 'done', '2026-10-26T14:06:10Z', null],
      ['review', 'started', '2026-10-26T14:06:20Z', 'primary reviewing'],
      ['consolidate', 'pending', null, null],
      ['writeReport', 'pending', null, null],
      ['post', 'pending', null, null],
    ])
    const rowChanges = h.changes.length
    // the same step and state with a new note: the row still changes, so the page gets a patch
    await child.events(step('review', 'started', '2026-10-26T14:06:20Z', 'secondary finished'))
    await h.launcher.check()
    assert.equal(h.changes.length, rowChanges + 1)
    stored = h.cache.getRun(run.id)!
    assert.equal(stored.steps?.[1]?.note, 'secondary finished')
    // a step appended again wins, and unknown lines are skipped
    await child.events(step('review', 'done', '2026-10-26T14:07:00Z'), 'not json', step('review', 'started', '2026-10-26T14:08:00Z', 'second pass'), { at: 'x', step: 'merge', state: 'done' })
    await h.launcher.check()
    stored = h.cache.getRun(run.id)!
    assert.deepEqual([stored.steps?.[1]?.state, stored.steps?.[1]?.at, stored.steps?.[1]?.note], ['started', '2026-10-26T14:08:00Z', 'second pass'])
    assert.deepEqual([stored.step, stored.stepState], ['review', 'started'])
    // a read that brings nothing new changes nothing
    const before = h.changes.length
    await h.launcher.check()
    assert.equal(h.changes.length, before)
    // the cell and the API view carry them
    const cell = agentCell(await prOf(106), baseConfig(), stored, undefined)
    assert.deepEqual([cell.tandem, cell.steps[1]?.note], [true, 'second pass'])
    assert.deepEqual([runView(stored).tandem, runView(stored).steps.length], [true, 5])
  } finally {
    await h.cleanup()
  }
})

test('a recovered run rebuilds its steps from the whole of events.jsonl', async () => {
  const h = await harness()
  try {
    const run = await h.launcher.start(request())
    const child = h.launch.children[0]!
    await child.events(step('resolveBase', 'done', '2026-10-26T14:06:10Z'), step('review', 'started', '2026-10-26T14:06:20Z'))
    await h.launcher.check()
    // the server goes away and comes back with the run still alive
    h.launcher.close()
    h.cache.updateRun(run.id, { steps: null })
    const again = h.make()
    await again.recover()
    await again.check()
    assert.deepEqual(h.cache.getRun(run.id)!.steps?.map((slot) => slot.state), ['done', 'started', 'pending', 'pending', 'pending'])
    again.close()
  } finally {
    await h.cleanup()
  }
})

test('every outcome settles from the files: failed, needsInput, noResult, noReport and permissionDenied', async () => {
  const h = await harness()
  try {
    const outcome = async (write: (child: (typeof h.launch.children)[number]) => Promise<void>, code = 0): Promise<Run> => {
      const run = await h.launcher.start(request())
      const child = h.launch.children.at(-1)!
      await write(child)
      const settled = h.launcher.settled(run.id)
      child.exit(code)
      return settled
    }
    const failed = await outcome((child) => child.result(reviewResult({ status: 'failed', reviewed: null, verdict: null, findings: [], posted: null, report: null, error: 'no PR exists for this branch' })))
    assert.deepEqual([failed.status, failed.note], ['failed', 'no PR exists for this branch'])
    const waiting = await outcome((child) => child.result(reviewResult({ status: 'needsInput', question: 'Fix the P1 now? (yes / no)' })))
    assert.deepEqual([waiting.status, waiting.note, waiting.result?.question], ['needsInput', null, 'Fix the P1 now? (yes / no)'])
    const silent = await outcome((child) => child.stream({ type: 'result', subtype: 'error_during_execution', is_error: true }), 1)
    assert.equal(silent.status, 'failed')
    assert.equal(silent.note, 'noResult: no result.json; exit code 1; last event: {"type":"result","subtype":"error_during_execution","is_error":true}')
    const garbled = await outcome((child) => child.result('{"schema":'))
    assert.match(garbled.note ?? '', /^noResult: result.json is not valid JSON; exit code 0; last event: none$/)
    const unwritten = await outcome((child) => child.result(reviewResult({ report: '~/agents/output/PR-106.md' })))
    assert.deepEqual([unwritten.status, unwritten.note], ['failed', 'noReport: ~/agents/output/PR-106.md does not exist'])
    await h.report(106)
    const denied = await outcome(async (child) => {
      await child.stream({ type: 'result', total_cost_usd: 0.5, permission_denials: [{ tool_name: 'Write', tool_use_id: 'w1' }, { tool_name: 'Bash', tool_use_id: 'b1' }] })
      await child.result(reviewResult())
    })
    assert.deepEqual([denied.status, denied.note], ['failed', 'permissionDenied: Write, Bash'])
    // the result is still kept for the drawer
    assert.equal(denied.result?.status, 'done')
    const clean = await outcome((child) => child.result(reviewResult()), 3)
    assert.equal(clean.status, 'done')
  } finally {
    await h.cleanup()
  }
})

test('a Codex run takes its session from thread.started, has no stdin, and is judged by its files alone', async () => {
  const h = await harness({ config: { agent: { runner: 'codex', claudeModel: 'sonnet', codexModel: 'gpt-6.1-terra' } } })
  try {
    const run = await h.launcher.start(request(104, { args: ['104', '--no-post'], label: 'Self-review' }))
    const runDir = join(h.stateDir, 'runs', String(run.id))
    const child = h.launch.children[0]!
    const cwd = join(h.home, 'dev', 'orbit')
    assert.equal(child.request.command, 'codex')
    assert.deepEqual(child.request.args, codexInvocation({
      command: 'review-pr', args: ['104', '--no-post'], cwd, runDir, home: h.home, sessionId: null, claudeModel: 'sonnet', codexModel: 'gpt-6.1-terra',
      reportsDir: join(h.home, 'agents', 'output'), worktreesDir: join(h.home, 'agents', 'worktrees'),
    }).args)
    assert.equal(child.request.stdin, 'ignore')
    assert.deepEqual(child.writes, [])
    assert.equal(run.sessionId, null)
    assert.equal(run.resume, null)
    await child.stream({ type: 'thread.started', thread_id: 'th-104' }, { type: 'turn.started' })
    await h.launcher.check()
    const stored = h.cache.getRun(run.id)!
    assert.equal(stored.sessionId, 'th-104')
    assert.equal(stored.resume, `cd ~/dev/orbit && codex resume th-104 -m gpt-6.1-terra -s workspace-write -c sandbox_workspace_write.network_access=true --add-dir ~/dev/orbit/.git --add-dir ~/.local/state/pit-view/runs/${run.id} --add-dir ~/agents/output --add-dir ~/agents/worktrees`)
    await h.report(104)
    await child.result(reviewResult({ target: { repo: scenario.repo, pr: 104 }, verdict: 'clean', findings: [], posted: null, notPostedReason: 'noPost', report: '~/agents/output/PR-104.md' }))
    const settled = h.launcher.settled(run.id)
    child.exit(0)
    const final = await settled
    assert.deepEqual([final.status, final.costUsd, final.note], ['done', null, null])
    // the runner override wins over the configured default
    const claude = await h.launcher.start(request(113, { label: 'Review', runner: 'claude' }))
    assert.equal(claude.runner, 'claude')
    assert.equal(h.launch.children[1]!.request.command, 'claude')
  } finally {
    await h.cleanup()
  }
})

test('stop sends SIGTERM to the group, then after 10 seconds SIGKILLs every descendant\'s group, the runner\'s last', async () => {
  const h = await harness()
  try {
    const run = await h.launcher.start(request())
    const pid = h.launch.children[0]!.pid
    h.launch.ignoreTerm.add(pid)
    // a background command in a group of its own, a grandchild in another, and an unrelated process
    h.launch.processes.push({ pid: pid + 100, ppid: pid, pgid: pid }, { pid: 5000, ppid: pid + 100, pgid: 5000 }, { pid: 5001, ppid: 5000, pgid: 5001 }, { pid: 6000, ppid: 1, pgid: 6000 })
    for (const alive of [pid + 100, 5000, 5001, 6000]) h.launch.alive.add(alive)
    const stopping = h.launcher.stop(run.id)
    assert.equal(stopping.status, 'running')
    assert.deepEqual(h.launch.kills, [{ pid: -pid, signal: 'SIGTERM' }])
    // a second click sends nothing more
    h.launcher.stop(run.id)
    h.time.advance(9_999)
    assert.equal(h.launch.kills.length, 1)
    const settled = h.launcher.settled(run.id)
    h.time.advance(1)
    const final = await settled
    assert.deepEqual(h.launch.kills, [
      { pid: -pid, signal: 'SIGTERM' }, { pid: -5000, signal: 'SIGKILL' }, { pid: -5001, signal: 'SIGKILL' }, { pid: -pid, signal: 'SIGKILL' },
    ])
    assert.equal(final.status, 'stopped')
    assert.ok(h.launch.alive.has(6000), 'an unrelated process is never signaled')
    assert.throws(() => h.launcher.stop(run.id), (error: unknown) => error instanceof LaunchError && error.code === 'notRunning')
    assert.throws(() => h.launcher.stop(999), (error: unknown) => error instanceof LaunchError && error.code === 'unknownRun')
  } finally {
    await h.cleanup()
  }
})

test('a runner that exits on SIGTERM settles as stopped with no SIGKILL', async () => {
  const h = await harness()
  try {
    const run = await h.launcher.start(request())
    const settled = h.launcher.settled(run.id)
    h.launcher.stop(run.id)
    const final = await settled
    assert.equal(final.status, 'stopped')
    h.time.advance(30 * second)
    assert.deepEqual(h.launch.kills.map((kill) => kill.signal), ['SIGTERM'])
  } finally {
    await h.cleanup()
  }
})

test('after a restart, a live run is watched again and the rest settle from result.json or as serverRestarted', async () => {
  // room for all four reviews at once, so none waits in the queue
  const h = await harness({ config: { maxConcurrentReviews: 4 } })
  try {
    const live = await h.launcher.start(request(106))
    const finished = await h.launcher.start(request(113, { label: 'Review' }))
    const lost = await h.launcher.start(request(101, { args: ['101', '--no-post'], label: 'Self-review' }))
    const reused = await h.launcher.start(request(102, { args: ['102', '--no-post'], label: 'Self-review' }))
    const [liveChild, finishedChild, , reusedChild] = h.launch.children
    // the server goes away; the runs do not
    h.launcher.close()
    await h.report(113)
    await finishedChild!.result(reviewResult({ target: { repo: scenario.repo, pr: 113 }, report: '~/agents/output/PR-113.md' }))
    for (const child of h.launch.children.slice(1, 3)) h.launch.alive.delete(child.pid)
    // a pid reused by another process: alive, but its start time is not the run's
    const reusedRequest = join(h.stateDir, 'runs', String(reused.id), 'request.json')
    await writeFile(reusedRequest, JSON.stringify({ ...JSON.parse(await readFile(reusedRequest, 'utf8')), pidStartedAt: 'an earlier start' }))
    assert.ok(h.launch.alive.has(reusedChild!.pid))

    const changes: Run[] = []
    const again = h.make((run) => changes.push(run))
    h.watched.length = 0
    await again.recover()
    // only the run that was still running is adopted; those recovery settled are not watched
    assert.deepEqual(h.watched, [live.id])
    assert.equal(h.cache.getRun(finished.id)?.status, 'done')
    assert.deepEqual([h.cache.getRun(lost.id)?.status, h.cache.getRun(lost.id)?.note], ['failed', 'serverRestarted'])
    assert.deepEqual([h.cache.getRun(reused.id)?.status, h.cache.getRun(reused.id)?.note], ['failed', 'serverRestarted'])
    assert.equal(h.cache.getRun(live.id)?.status, 'running')
    assert.deepEqual(changes.map((run) => [run.id, run.status]).sort(), [[finished.id, 'done'], [lost.id, 'failed'], [reused.id, 'failed']])

    // the live run keeps stepping, then its process ends with nobody holding it
    await liveChild!.events(step('review', 'started', '2026-10-26T14:09:00Z'))
    await again.check()
    assert.equal(h.cache.getRun(live.id)?.step, 'review')
    await h.report(106)
    await liveChild!.result(reviewResult())
    h.launch.alive.delete(liveChild!.pid)
    const settled = again.settled(live.id)
    h.time.advance(10 * second)
    const final = await settled
    assert.equal(final.status, 'done')
    // the old launcher, closed, never settles anything
    assert.equal(h.changes.filter((run) => run.status !== 'running').length, 0)
    again.close()
  } finally {
    await h.cleanup()
  }
})

test('only the newest runs are kept, and a pruned run\'s folder is deleted with its row', async () => {
  const h = await harness({ keepRuns: 2 })
  try {
    const first = await h.launcher.start(request(106))
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(first.id)
    const second = await h.launcher.start(request(106))
    h.launch.children[1]!.exit(1)
    await h.launcher.settled(second.id)
    const firstDir = join(h.stateDir, 'runs', String(first.id))
    assert.ok((await stat(firstDir)).isDirectory())
    assert.deepEqual(h.launch.removed, [])
    const third = await h.launcher.start(request(106))
    assert.deepEqual(h.launch.removed, [firstDir])
    await assert.rejects(stat(firstDir), /ENOENT/)
    assert.equal(h.cache.getRun(first.id), null)
    assert.deepEqual(h.cache.runsFor(scenario.repo, 106).map((run) => run.id), [third.id, second.id])
  } finally {
    await h.cleanup()
  }
})

test('a run that cannot spawn fails as spawnFailed and frees its PR', async () => {
  const launch = fakeLaunch()
  launch.spawnError = new Error('spawn claude ENOENT')
  const h = await harness({ launch })
  try {
    const run = await h.launcher.start(request())
    assert.deepEqual([run.status, run.note], ['failed', 'spawnFailed: spawn claude ENOENT'])
    // announced as watched before it settled in the same call
    assert.deepEqual(h.watched, [run.id])
    launch.spawnError = null
    assert.equal((await h.launcher.start(request())).status, 'running')
  } finally {
    await h.cleanup()
  }
})

// the cap on concurrent reviews (section 8, Launching runs, Review cap)

// the queue starts its next review in the background; wait for what it does, a short while at most
const waitFor = async (done: () => boolean, ms = 2000): Promise<void> => {
  const until = Date.now() + ms
  while (!done()) {
    if (Date.now() > until) assert.fail('timed out waiting for the queue')
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
  }
}

test('a review fits while the reviews in flight, less one self-review when the setting allows it, stay within the cap', () => {
  const others = (count: number): ('review' | 'selfReview')[] => Array.from({ length: count }, () => 'review')
  assert.equal(reviewFits([], 'review', 1, false), true)
  assert.equal(reviewFits(others(1), 'review', 2, false), true)
  assert.equal(reviewFits(others(2), 'review', 2, false), false)
  assert.equal(reviewFits(others(2), 'selfReview', 2, false), false)
  // the setting lets one self-review go over the cap, and never a second
  assert.equal(reviewFits(others(2), 'selfReview', 2, true), true)
  assert.equal(reviewFits([...others(2), 'selfReview'], 'selfReview', 2, true), false)
  assert.equal(reviewFits([...others(2), 'selfReview'], 'review', 2, true), false)
  // the one over the cap is a self-review: with one in flight, the cap's own slots still take any review
  assert.equal(reviewFits(['review', 'selfReview'], 'review', 2, true), true)
  assert.equal(reviewFits(['review', 'selfReview'], 'review', 2, false), false)
})

test('at the cap a review is queued, not started, and the queue starts in arrival order as earlier reviews finish', async () => {
  const h = await harness()
  try {
    const first = await h.launcher.start(request(106))
    const second = await h.launcher.start(request(113, { label: 'Review' }))
    const third = await h.launcher.start(request(118, { label: 'Review' }))
    const fourth = await h.launcher.start(request(109, { label: 'Review' }))
    assert.deepEqual([first.status, second.status, third.status, fourth.status], ['running', 'running', 'queued', 'queued'])
    assert.equal(h.launch.children.length, 2)
    // a queued run has its row and is the PR's run in flight, with nothing behind it yet
    assert.deepEqual([third.pid, third.finishedAt, third.resume], [null, null, null])
    assert.deepEqual(h.watched, [first.id, second.id, third.id, fourth.id])
    await assert.rejects(h.launcher.start(request(118, { label: 'Review' })), (error: unknown) => error instanceof LaunchError && error.code === 'busy')
    // the identity and clone checks ran for every start, the queued ones too
    assert.equal(h.gh.calls.filter((call) => call.args[0] === 'api').length, 4)

    // the first finishes a minute on: the earliest queued review starts, in the clone, with a fresh identity check, and its start time is not the time it was queued
    h.time.advance(60_000)
    await h.report(106)
    await h.launch.children[0]!.result(reviewResult())
    h.launch.children[0]!.exit(0)
    await h.launcher.settled(first.id)
    await waitFor(() => h.changes.some((run) => run.id === third.id && run.status === 'running' && run.pid !== null))
    assert.equal(h.launch.children.length, 3)
    assert.equal(h.cache.getRun(third.id)?.status, 'running')
    assert.equal(h.cache.getRun(fourth.id)?.status, 'queued')
    assert.equal(h.launch.children[2]!.request.cwd, join(h.home, 'dev', 'orbit'))
    assert.match(h.launch.children[2]!.writes[0] ?? '', /\/review-pr 118 --emit-json=/)
    // its start time is when it started, not when it was queued
    assert.equal(h.cache.getRun(third.id)?.startedAt, '2026-10-26T14:06:38Z')
    assert.equal(h.gh.calls.filter((call) => call.args[0] === 'api').length, 5)
    assert.deepEqual(h.changes.filter((run) => run.id === third.id).map((run) => run.status).slice(0, 2), ['queued', 'running'])
  } finally {
    await h.cleanup()
  }
})

test('a slot is released however a review ends: failed, stopped, waiting for an answer, or a spawn that fails', async () => {
  const launch = fakeLaunch()
  // the spawn error below hits one start only
  const spawn = launch.deps.spawn
  launch.deps.spawn = (request) => {
    const error = launch.spawnError
    launch.spawnError = null
    if (error !== null) throw error
    return spawn(request)
  }
  const h = await harness({ launch, config: { maxConcurrentReviews: 1 } })
  try {
    const running = await h.launcher.start(request(106))
    const queued = [113, 118, 109, 107, 108].map((number) => h.launcher.start(request(number, { label: 'Review' })))
    const rows = await Promise.all(queued)
    assert.deepEqual(rows.map((run) => run.status), ['queued', 'queued', 'queued', 'queued', 'queued'])
    assert.equal(h.launch.children.length, 1)

    // a run that fails (no result.json) frees its slot for the next in line
    h.launch.children[0]!.exit(1)
    assert.equal((await h.launcher.settled(running.id)).status, 'failed')
    await waitFor(() => h.launch.children.length === 2)
    assert.equal(h.cache.getRun(rows[0]!.id)?.status, 'running')

    // a stopped run frees it too
    h.launcher.stop(rows[0]!.id)
    assert.equal((await h.launcher.settled(rows[0]!.id)).status, 'stopped')
    await waitFor(() => h.launch.children.length === 3)
    assert.equal(h.cache.getRun(rows[1]!.id)?.status, 'running')

    // a run that stops to ask is no longer in flight, so it frees its slot as well
    await h.launch.children[2]!.result(reviewResult({ status: 'needsInput', reviewed: null, question: 'Post it?', target: { repo: scenario.repo, pr: 118 } }))
    h.launch.children[2]!.exit(0)
    assert.equal((await h.launcher.settled(rows[1]!.id)).status, 'needsInput')
    await waitFor(() => h.launch.children.length === 4)
    assert.equal(h.cache.getRun(rows[2]!.id)?.status, 'running')

    // a queued review whose runner cannot spawn fails at once and hands the slot on, so the queue never wedges
    launch.spawnError = new Error('spawn claude ENOENT')
    h.launch.children[3]!.exit(1)
    await h.launcher.settled(rows[2]!.id)
    await waitFor(() => h.cache.getRun(rows[3]!.id)?.status === 'failed')
    assert.equal(h.cache.getRun(rows[3]!.id)?.note, 'spawnFailed: spawn claude ENOENT')
    await waitFor(() => h.launch.children.length === 5)
    assert.equal(h.cache.getRun(rows[4]!.id)?.status, 'running')
  } finally {
    await h.cleanup()
  }
})

test('a stop asked while a run is still being launched signals it once it is watched, so no process is left holding a slot', async () => {
  const launch = fakeLaunch()
  // the launch waits on its run folder until the test lets it go
  let release: () => void = () => {}
  const held = new Promise<void>((resolveHeld) => {
    release = resolveHeld
  })
  const mkdirRun = launch.deps.fs.mkdir
  launch.deps.fs = { ...launch.deps.fs, mkdir: async (path) => held.then(() => mkdirRun(path)) }
  const h = await harness({ launch, config: { maxConcurrentReviews: 1 } })
  try {
    const starting = h.launcher.start(request(106))
    await waitFor(() => h.watched.length === 1)
    const id = h.watched[0]!
    const queued = await h.launcher.start(request(113, { label: 'Review' }))
    assert.equal(queued.status, 'queued')
    // the run has its row, but no process yet, so nothing watches it
    assert.equal(h.launch.children.length, 0)
    assert.equal(h.launcher.stop(id).status, 'running')
    const settled = h.launcher.settled(id)
    release()
    await starting
    assert.equal((await settled).status, 'stopped')
    assert.deepEqual(h.launch.kills.map((kill) => kill.signal), ['SIGTERM'])
    // its slot went to the next in line
    await waitFor(() => h.launch.children.length === 2)
    assert.equal(h.cache.getRun(queued.id)?.status, 'running')
  } finally {
    await h.cleanup()
  }
})

test('a tandem review counts as one review, and fix and update sessions neither count nor queue', async () => {
  const h = await harness()
  try {
    h.cache.writePr(scenario.repo, await prOf(101), scenario.defaultBranch)
    h.cache.writePr(scenario.repo, await prOf(102), scenario.defaultBranch)
    const tandem = await h.launcher.start(request(106, { args: ['106', '--tandem'], label: 'Tandem re-review' }))
    const review = await h.launcher.start(request(113, { label: 'Review' }))
    assert.deepEqual([tandem.status, review.status], ['running', 'running'])
    // the cap of two is full with one tandem and one single review
    assert.equal((await h.launcher.start(request(118, { label: 'Review' }))).status, 'queued')
    // a fix session and an update session start beside them, whatever the cap
    const fix = await h.launcher.start(request(101, { command: 'fix-pr', args: ['101'], label: 'Fix session' }))
    const update = await h.launcher.start(updateRequest(scenario.repo, 102, 'a'.repeat(40)))
    assert.deepEqual([fix.status, update.status], ['running', 'running'])
    assert.equal(h.launch.children.length, 4)
    // and their ends free no review slot
    h.launch.children[2]!.exit(1)
    h.launch.children[3]!.exit(1)
    await h.launcher.settled(fix.id)
    await h.launcher.settled(update.id)
    await h.launcher.check()
    assert.equal(h.launch.children.length, 4)
    assert.equal(h.cache.runsFor(scenario.repo, 118)[0]?.status, 'queued')
  } finally {
    await h.cleanup()
  }
})

test('with the setting on, one self-review may run over the cap and never a second; with it off, a self-review queues like any review', async () => {
  const off = await harness()
  try {
    off.cache.writePr(scenario.repo, await prOf(101), scenario.defaultBranch)
    await off.launcher.start(request(106))
    await off.launcher.start(request(113, { label: 'Review' }))
    assert.equal((await off.launcher.start(request(101, { args: ['101', '--no-post'], label: 'Self-review' }))).status, 'queued')
    assert.equal(off.launch.children.length, 2)
  } finally {
    await off.cleanup()
  }
  const on = await harness({ config: { selfReviewOverCap: true } })
  try {
    for (const number of [101, 102]) on.cache.writePr(scenario.repo, await prOf(number), scenario.defaultBranch)
    const first = await on.launcher.start(request(106))
    await on.launcher.start(request(113, { label: 'Review' }))
    const over = await on.launcher.start(request(101, { args: ['101', '--no-post'], label: 'Self-review' }))
    assert.equal(over.status, 'running')
    // never more than one over: a second self-review and any other review wait
    const secondSelf = await on.launcher.start(request(102, { args: ['102', '--no-post'], label: 'Self-review' }))
    const other = await on.launcher.start(request(118, { label: 'Review' }))
    assert.deepEqual([secondSelf.status, other.status], ['queued', 'queued'])
    assert.equal(on.launch.children.length, 3)
    // an earlier review finishes: the next in line takes its slot, and the self-review stays the one over
    on.launch.children[0]!.exit(1)
    await on.launcher.settled(first.id)
    await waitFor(() => on.launch.children.length === 4)
    // the spawn count moves before the row is written, so wait for the row
    await waitFor(() => on.cache.getRun(secondSelf.id)?.status === 'running')
    assert.equal(on.cache.getRun(secondSelf.id)?.status, 'running')
    assert.equal(on.cache.getRun(other.id)?.status, 'queued')
  } finally {
    await on.cleanup()
  }
})

test('a queued review can be stopped: it leaves the queue as stopped, never spawns, and frees its PR', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  try {
    const running = await h.launcher.start(request(106))
    const queued = await h.launcher.start(request(113, { label: 'Review' }))
    const later = await h.launcher.start(request(118, { label: 'Review' }))
    const stopped = h.launcher.stop(queued.id)
    assert.equal(stopped.status, 'stopped')
    assert.notEqual(stopped.finishedAt, null)
    assert.equal(h.launch.kills.length, 0)
    assert.equal((await h.launcher.settled(queued.id)).status, 'stopped')
    assert.throws(() => h.launcher.stop(queued.id), (error: unknown) => error instanceof LaunchError && error.code === 'notRunning')
    // the next in line moves up; the stopped one never starts
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(running.id)
    await waitFor(() => h.launch.children.length === 2)
    assert.match(h.launch.children[1]!.writes[0] ?? '', /\/review-pr 118 /)
    assert.equal(h.cache.getRun(later.id)?.status, 'running')
    assert.equal(h.cache.getRun(queued.id)?.status, 'stopped')
    // the stopped PR may be started again: it queues behind the one now running
    assert.equal((await h.launcher.start(request(113, { label: 'Review' }))).status, 'queued')
  } finally {
    await h.cleanup()
  }
})

test('a queued review starts only for the repository and viewer it was confirmed for, and only after its identity check passes again', async () => {
  const gh = fakeRunner((args) => args[0] === 'api' ? ok(`${login.current}\n`) : ok('gho_fixture_token\n'))
  const login = { current: scenario.viewer as string }
  const h = await harness({ gh, config: { maxConcurrentReviews: 1 } })
  try {
    const running = await h.launcher.start(request(106))
    const otherViewer = await h.launcher.start(request(113, { label: 'Review' }))
    // the viewer changes in Settings while it waits: it fails and never starts
    h.settings.current = { ...h.settings.current, viewer: 'someone-else' }
    login.current = 'someone-else'
    h.launcher.drain()
    await waitFor(() => h.cache.getRun(otherViewer.id)?.status === 'failed')
    assert.match(h.cache.getRun(otherViewer.id)?.note ?? '', /^spawnFailed: not started: the viewer is now someone-else, not vera-quill/)
    h.settings.current = { ...h.settings.current, viewer: scenario.viewer }
    login.current = scenario.viewer
    const otherRepo = await h.launcher.start(request(118, { label: 'Review' }))
    h.settings.current = { ...h.settings.current, repo: 'octo-example/other' }
    h.launcher.drain()
    await waitFor(() => h.cache.getRun(otherRepo.id)?.status === 'failed')
    assert.match(h.cache.getRun(otherRepo.id)?.note ?? '', /^spawnFailed: not started: the repository is now octo-example\/other, not octo-example\/orbit/)
    h.settings.current = { ...h.settings.current, repo: scenario.repo }
    // gh switched accounts while it waited: the start is refused as any start is, and nothing spawns
    const mismatch = await h.launcher.start(request(109, { label: 'Review' }))
    login.current = 'someone-else'
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(running.id)
    await waitFor(() => h.cache.getRun(mismatch.id)?.status === 'failed')
    assert.match(h.cache.getRun(mismatch.id)?.note ?? '', /^spawnFailed: gh is signed in as someone-else, but the viewer is vera-quill/)
    assert.equal(h.launch.children.length, 1)
  } finally {
    await h.cleanup()
  }
})

// a gate a fake dependency waits at once the test arms it, each wait held until the test opens it
const gate = () => {
  const held: (() => void)[] = []
  let armed = 0
  return {
    arm: (count = 1): void => {
      armed += count
    },
    wait: async (): Promise<void> => {
      if (armed === 0) return
      armed -= 1
      await new Promise<void>((resolveHeld) => held.push(resolveHeld))
    },
    held: (): number => held.length,
    open: (index: number): void => held[index]!(),
  }
}

// a gh whose account lookups wait at the gate, answering with whoever login names
const gatedGh = (accounts: ReturnType<typeof gate>, login: { current: string }): FakeRunner => fakeRunner(async (args) => {
  if (args[0] !== 'api') return ok('gho_fixture_token\n')
  await accounts.wait()
  return ok(`${login.current}\n`)
})

// long enough for a start the queue let go to reach its spawn, had it been let go
const quiet = (): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, 50))

// what a promise settles to, failing the test if it has not settled within a short while
const within = <V>(promise: Promise<V>, ms = 2000): Promise<V> => Promise.race([
  promise,
  new Promise<never>((_resolveLate, rejectLate) => setTimeout(() => rejectLate(new Error('timed out waiting for the queue')), ms)),
])

test('a queued review whose viewer changes during its dequeue checks fails and never starts, since it stays in the queue a save reads', async () => {
  const accounts = gate()
  const login = { current: scenario.viewer as string }
  const h = await harness({ gh: gatedGh(accounts, login), config: { maxConcurrentReviews: 1 } })
  try {
    const running = await h.launcher.start(request(106))
    const queued = await h.launcher.start(request(113, { label: 'Review' }))
    // the running review ends, and the queued one's account check is held
    accounts.arm()
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(running.id)
    await waitFor(() => accounts.held() === 1)
    assert.equal(h.cache.getRun(queued.id)?.status, 'queued')
    // the viewer is saved as someone else while that check runs
    h.settings.current = { ...h.settings.current, viewer: 'someone-else' }
    h.launcher.drain()
    await waitFor(() => h.cache.getRun(queued.id)?.status === 'failed')
    assert.match(h.cache.getRun(queued.id)?.note ?? '', /^spawnFailed: not started: the viewer is now someone-else, not vera-quill/)
    accounts.open(0)
    await quiet()
    assert.equal(h.launch.children.length, 1)
    assert.equal(h.cache.getRun(queued.id)?.status, 'failed')
  } finally {
    await h.cleanup()
  }
})

test('a queued review whose repository changes after its checks, while it is being launched, is refused just before its spawn', async () => {
  const launch = fakeLaunch()
  const folders = gate()
  const mkdir = launch.deps.fs.mkdir
  launch.deps.fs = {
    ...launch.deps.fs,
    mkdir: async (path) => {
      await folders.wait()
      await mkdir(path)
    },
  }
  const h = await harness({ launch, config: { maxConcurrentReviews: 1 } })
  try {
    const running = await h.launcher.start(request(106))
    const queued = await h.launcher.start(request(113, { label: 'Review' }))
    // its checks pass, and its run folder is held
    folders.arm()
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(running.id)
    await waitFor(() => folders.held() === 1)
    assert.equal(h.cache.getRun(queued.id)?.status, 'running')
    h.settings.current = { ...h.settings.current, repo: 'octo-example/other' }
    h.launcher.drain()
    folders.open(0)
    await waitFor(() => h.cache.getRun(queued.id)?.status === 'failed')
    assert.match(h.cache.getRun(queued.id)?.note ?? '', /^spawnFailed: not started: the repository is now octo-example\/other, not octo-example\/orbit/)
    assert.equal(h.launch.children.length, 1)
  } finally {
    await h.cleanup()
  }
})

test('admission reads the cap as it is once the checks finish: a cap lowered during them queues a new start and puts back a queued one', async () => {
  const accounts = gate()
  const login = { current: scenario.viewer as string }
  const h = await harness({ gh: gatedGh(accounts, login) })
  try {
    const running = await h.launcher.start(request(106))
    // a new start's checks are held while the cap goes from two to one
    accounts.arm()
    const pending = h.launcher.start(request(113, { label: 'Review' }))
    await waitFor(() => accounts.held() === 1)
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 1 }
    h.launcher.drain()
    accounts.open(0)
    const queued = await pending
    assert.equal(queued.status, 'queued')
    assert.equal(h.launch.children.length, 1)

    // the cap goes back up and the queued review is let go, but goes down again while its checks run
    accounts.arm()
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 2 }
    h.launcher.drain()
    await waitFor(() => accounts.held() === 2)
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 1 }
    h.launcher.drain()
    accounts.open(1)
    await quiet()
    assert.equal(h.cache.getRun(queued.id)?.status, 'queued')
    assert.equal(h.launch.children.length, 1)
    // it is still first in line, and starts when the running review ends
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(running.id)
    await waitFor(() => h.launch.children.length === 2)
    assert.equal(h.cache.getRun(queued.id)?.status, 'running')
  } finally {
    await h.cleanup()
  }
})

test('a cap lowered while two queued reviews make their checks keeps queue order: the earlier starts first, and the later gives its slot back', async () => {
  const accounts = gate()
  const login = { current: scenario.viewer as string }
  const h = await harness({ gh: gatedGh(accounts, login), config: { maxConcurrentReviews: 1 } })
  try {
    const running = await h.launcher.start(request(106))
    const earlier = await h.launcher.start(request(113, { label: 'Review' }))
    const later = await h.launcher.start(request(118, { label: 'Review' }))
    // the cap goes up and both are let go, each holding a slot while its account check is held
    accounts.arm(2)
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 3 }
    h.launcher.drain()
    await waitFor(() => accounts.held() === 2)
    // the cap comes down to room for one beside the running review, and the earlier one's checks end first
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 2 }
    h.launcher.drain()
    accounts.open(0)
    await waitFor(() => h.launch.children.length === 2)
    assert.equal(h.cache.getRun(earlier.id)?.status, 'running')
    assert.match(h.launch.children[1]!.writes[0] ?? '', /\/review-pr 113 /)
    // the later one's checks end: it no longer fits, and waits in its place
    accounts.open(1)
    await quiet()
    assert.equal(h.cache.getRun(later.id)?.status, 'queued')
    assert.equal(h.launch.children.length, 2)
    // it starts when a slot is free
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(running.id)
    await waitFor(() => h.launch.children.length === 3)
    assert.equal(h.cache.getRun(later.id)?.status, 'running')
  } finally {
    await h.cleanup()
  }
})

test('a queued review sent back by a lowered cap keeps its place: a slot freed while a later one still makes its checks goes to it first', async () => {
  const accounts = gate()
  const login = { current: scenario.viewer as string }
  const h = await harness({ gh: gatedGh(accounts, login), config: { maxConcurrentReviews: 1 } })
  try {
    const running = await h.launcher.start(request(106))
    const earlier = await h.launcher.start(request(113, { label: 'Review' }))
    const later = await h.launcher.start(request(118, { label: 'Review' }))
    accounts.arm(2)
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 3 }
    h.launcher.drain()
    await waitFor(() => accounts.held() === 2)
    // the cap goes back to one: the earlier one's checks end and it waits again, while the later one's are still held
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 1 }
    h.launcher.drain()
    accounts.open(0)
    await quiet()
    assert.deepEqual([earlier, later].map((run) => h.cache.getRun(run.id)?.status), ['queued', 'queued'])
    // the running review ends: the slot is the earlier one's, though the later one still holds an attempt
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(running.id)
    await waitFor(() => h.launch.children.length === 2)
    assert.equal(h.cache.getRun(earlier.id)?.status, 'running')
    // the later one's checks end behind it, and it waits
    accounts.open(1)
    await quiet()
    assert.equal(h.cache.getRun(later.id)?.status, 'queued')
    assert.equal(h.launch.children.length, 2)
  } finally {
    await h.cleanup()
  }
})

// the PR each spawned runner was asked to review, in the order they were spawned
const startOrder = (h: Awaited<ReturnType<typeof harness>>): number[] => h.launch.children.map((child) => Number(/\/review-pr (\d+) /.exec(child.writes[0] ?? '')?.[1]))

test('a later queued review whose checks end first waits for the earlier one, so queued reviews start in the order they were queued', async () => {
  const accounts = gate()
  const login = { current: scenario.viewer as string }
  const h = await harness({ gh: gatedGh(accounts, login), config: { maxConcurrentReviews: 1 } })
  try {
    await h.launcher.start(request(106))
    const earlier = await h.launcher.start(request(113, { label: 'Review' }))
    const later = await h.launcher.start(request(118, { label: 'Review' }))
    accounts.arm(2)
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 3 }
    h.launcher.drain()
    await waitFor(() => accounts.held() === 2)
    // the later one's checks end first: both fit, but it waits while the earlier one still makes its checks
    accounts.open(1)
    await quiet()
    assert.equal(h.cache.getRun(later.id)?.status, 'queued')
    assert.equal(h.launch.children.length, 1)
    // the earlier one's checks end: it starts, then the later one
    accounts.open(0)
    await waitFor(() => h.launch.children.length === 3)
    assert.deepEqual(startOrder(h), [106, 113, 118])
    assert.deepEqual([earlier, later].map((run) => h.cache.getRun(run.id)?.status), ['running', 'running'])
  } finally {
    await h.cleanup()
  }
})

test('a later queued review whose checks end first never starts ahead of an earlier one that a lowered cap then leaves room for alone', async () => {
  const accounts = gate()
  const login = { current: scenario.viewer as string }
  const h = await harness({ gh: gatedGh(accounts, login), config: { maxConcurrentReviews: 1 } })
  try {
    const running = await h.launcher.start(request(106))
    const earlier = await h.launcher.start(request(113, { label: 'Review' }))
    const later = await h.launcher.start(request(118, { label: 'Review' }))
    accounts.arm(2)
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 3 }
    h.launcher.drain()
    await waitFor(() => accounts.held() === 2)
    // the later one's checks end first, while both still fit
    accounts.open(1)
    await quiet()
    assert.equal(h.launch.children.length, 1)
    // the cap comes down to room for one beside the running review, and the earlier one's checks end
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 2 }
    h.launcher.drain()
    accounts.open(0)
    await waitFor(() => h.launch.children.length === 2)
    await quiet()
    assert.deepEqual(startOrder(h), [106, 113])
    assert.deepEqual([earlier, later].map((run) => h.cache.getRun(run.id)?.status), ['running', 'queued'])
    // the later one starts when a slot is free
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(running.id)
    await waitFor(() => h.launch.children.length === 3)
    assert.deepEqual(startOrder(h), [106, 113, 118])
  } finally {
    await h.cleanup()
  }
})

// strict arrival order: reviews spawn in the order they arrived (section 8 of DESIGN.md, Review cap, Queueing)

// a fake launch that records the most runners alive at once, counted at each spawn, and whose launches wait at the gate on their run folder when the test arms it
const observedLaunch = () => {
  const launch = fakeLaunch()
  const folders = gate()
  const peak = { alive: 0 }
  const spawn = launch.deps.spawn
  launch.deps.spawn = (request) => {
    const child = spawn(request)
    peak.alive = Math.max(peak.alive, launch.alive.size)
    return child
  }
  const mkdirRun = launch.deps.fs.mkdir
  launch.deps.fs = { ...launch.deps.fs, mkdir: async (path) => folders.wait().then(() => mkdirRun(path)) }
  return { launch, folders, peak }
}

const selfRequest = (number: number): StartRequest => request(number, { args: [String(number), '--no-post'], label: 'Self-review' })

test('a new start with room waits behind a queued review still making its checks, and they spawn in the order they arrived', async () => {
  const accounts = gate()
  const login = { current: scenario.viewer as string }
  const { launch, peak } = observedLaunch()
  const h = await harness({ launch, gh: gatedGh(accounts, login), config: { maxConcurrentReviews: 1 } })
  try {
    await h.launcher.start(request(106))
    const earlier = await h.launcher.start(request(113, { label: 'Review' }))
    // the cap goes up and the queued review is given a slot, its account check held
    accounts.arm()
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 3 }
    h.launcher.drain()
    await waitFor(() => accounts.held() === 1)
    // a new start has room and its own checks pass, but it arrived second
    const later = await h.launcher.start(request(118, { label: 'Review' }))
    await quiet()
    assert.equal(later.status, 'queued')
    assert.deepEqual(startOrder(h), [106])
    accounts.open(0)
    await waitFor(() => h.launch.children.length === 3)
    assert.deepEqual(startOrder(h), [106, 113, 118])
    assert.deepEqual([earlier, later].map((run) => h.cache.getRun(run.id)?.status), ['running', 'running'])
    assert.ok(peak.alive <= 3, `${peak.alive} alive with a cap of 3`)
  } finally {
    await h.cleanup()
  }
})

test('a new start with room waits behind a queued review already out of the queue and still being launched', async () => {
  const { launch, folders, peak } = observedLaunch()
  const h = await harness({ launch, config: { maxConcurrentReviews: 1 } })
  try {
    await h.launcher.start(request(106))
    const earlier = await h.launcher.start(request(113, { label: 'Review' }))
    // the queued review's checks pass, it leaves the queue, and its launch waits on its folder
    folders.arm()
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 3 }
    h.launcher.drain()
    await waitFor(() => folders.held() === 1)
    assert.equal(h.cache.getRun(earlier.id)?.status, 'running')
    const later = await h.launcher.start(request(118, { label: 'Review' }))
    await quiet()
    assert.equal(later.status, 'queued')
    assert.deepEqual(startOrder(h), [106])
    folders.open(0)
    await waitFor(() => h.launch.children.length === 3)
    assert.deepEqual(startOrder(h), [106, 113, 118])
    assert.ok(peak.alive <= 3, `${peak.alive} alive with a cap of 3`)
  } finally {
    await h.cleanup()
  }
})

test('a self-review that the overage would let in waits behind an earlier queued review that does not fit', async () => {
  const { launch, peak } = observedLaunch()
  const h = await harness({ launch, config: { maxConcurrentReviews: 1, selfReviewOverCap: true } })
  try {
    h.cache.writePr(scenario.repo, await prOf(101), scenario.defaultBranch)
    const running = await h.launcher.start(request(106))
    const earlier = await h.launcher.start(request(113, { label: 'Review' }))
    const self = await h.launcher.start(selfRequest(101))
    await quiet()
    assert.deepEqual([earlier.status, self.status], ['queued', 'queued'])
    assert.deepEqual(startOrder(h), [106])
    // the running review ends: the earlier one takes the cap's slot, and the self-review goes over it, in that order
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(running.id)
    await waitFor(() => h.launch.children.length === 3)
    assert.deepEqual(startOrder(h), [106, 113, 101])
    assert.ok(peak.alive <= 2, `${peak.alive} alive with a cap of 1 and one self-review over it`)
  } finally {
    await h.cleanup()
  }
})

test('switching the overage on never lets a self-review already queued pass an earlier queued review that does not fit', async () => {
  const { launch, peak } = observedLaunch()
  const h = await harness({ launch, config: { maxConcurrentReviews: 1 } })
  try {
    h.cache.writePr(scenario.repo, await prOf(101), scenario.defaultBranch)
    const running = await h.launcher.start(request(106))
    const earlier = await h.launcher.start(request(113, { label: 'Review' }))
    const self = await h.launcher.start(selfRequest(101))
    assert.deepEqual([earlier.status, self.status], ['queued', 'queued'])
    h.settings.current = { ...h.settings.current, selfReviewOverCap: true }
    h.launcher.drain()
    await quiet()
    assert.deepEqual(startOrder(h), [106])
    assert.deepEqual([earlier, self].map((run) => h.cache.getRun(run.id)?.status), ['queued', 'queued'])
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(running.id)
    await waitFor(() => h.launch.children.length === 3)
    assert.deepEqual(startOrder(h), [106, 113, 101])
    assert.ok(peak.alive <= 2, `${peak.alive} alive with a cap of 1 and one self-review over it`)
  } finally {
    await h.cleanup()
  }
})

for (const [order, closing] of [['the earlier one\'s checks ending first', [0, 1]], ['the self-review\'s checks ending first', [1, 0]]] as const) {
  test(`a queued review that gives its slot back holds the line: no later self-review passes it, with ${order}`, async () => {
    const accounts = gate()
    const login = { current: scenario.viewer as string }
    const { launch, peak } = observedLaunch()
    const h = await harness({ launch, gh: gatedGh(accounts, login), config: { maxConcurrentReviews: 1 } })
    try {
      h.cache.writePr(scenario.repo, await prOf(101), scenario.defaultBranch)
      const running = await h.launcher.start(request(106))
      const earlier = await h.launcher.start(request(113, { label: 'Review' }))
      const self = await h.launcher.start(selfRequest(101))
      // both are given slots, their checks held
      accounts.arm(2)
      h.settings.current = { ...h.settings.current, maxConcurrentReviews: 3 }
      h.launcher.drain()
      await waitFor(() => accounts.held() === 2)
      // the cap comes back down with the overage on: the earlier one no longer fits, and the self-review alone would
      h.settings.current = { ...h.settings.current, maxConcurrentReviews: 1, selfReviewOverCap: true }
      h.launcher.drain()
      for (const index of closing) {
        accounts.open(index)
        await quiet()
      }
      assert.deepEqual(startOrder(h), [106])
      assert.deepEqual([earlier, self].map((run) => h.cache.getRun(run.id)?.status), ['queued', 'queued'])
      h.launch.children[0]!.exit(1)
      await h.launcher.settled(running.id)
      await waitFor(() => h.launch.children.length === 3)
      assert.deepEqual(startOrder(h), [106, 113, 101])
      assert.ok(peak.alive <= 2, `${peak.alive} alive with a cap of 1 and one self-review over it`)
    } finally {
      await h.cleanup()
    }
  })
}

test('a review held behind one that does not fit makes its checks again when its turn comes, so it never starts on checks passed long ago', async () => {
  const accounts = gate()
  const login = { current: scenario.viewer as string }
  const h = await harness({ gh: gatedGh(accounts, login), config: { maxConcurrentReviews: 1 } })
  try {
    h.cache.writePr(scenario.repo, await prOf(101), scenario.defaultBranch)
    const running = await h.launcher.start(request(106))
    const earlier = await h.launcher.start(request(113, { label: 'Review' }))
    const self = await h.launcher.start(selfRequest(101))
    accounts.arm(2)
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 3 }
    h.launcher.drain()
    await waitFor(() => accounts.held() === 2)
    // the self-review's checks pass, then the cap comes down and the earlier one gives its slot back
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 1, selfReviewOverCap: true }
    h.launcher.drain()
    accounts.open(1)
    await quiet()
    accounts.open(0)
    await quiet()
    // gh is switched to another account while they wait, and the earlier one fails its checks when its turn comes
    login.current = 'someone-else'
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(running.id)
    await waitFor(() => h.cache.getRun(earlier.id)?.status === 'failed')
    await waitFor(() => h.cache.getRun(self.id)?.status === 'failed')
    assert.equal(noteKind(h.cache.getRun(self.id)?.note ?? null), 'spawnFailed')
    assert.equal(h.launch.children.length, 1)
  } finally {
    await h.cleanup()
  }
})

test('a Stop of the queued review holding the line lets the one behind it go, within the cap', async () => {
  const { launch, peak } = observedLaunch()
  const h = await harness({ launch, config: { maxConcurrentReviews: 1, selfReviewOverCap: true } })
  try {
    h.cache.writePr(scenario.repo, await prOf(101), scenario.defaultBranch)
    await h.launcher.start(request(106))
    const earlier = await h.launcher.start(request(113, { label: 'Review' }))
    const self = await h.launcher.start(selfRequest(101))
    assert.equal(self.status, 'queued')
    h.launcher.stop(earlier.id)
    await waitFor(() => h.launch.children.length === 2)
    assert.deepEqual(startOrder(h), [106, 101])
    assert.ok(peak.alive <= 2, `${peak.alive} alive with a cap of 1 and one self-review over it`)
  } finally {
    await h.cleanup()
  }
})

test('a new start with room waits behind an earlier new start still being launched', async () => {
  const { launch, folders, peak } = observedLaunch()
  const h = await harness({ launch, config: { maxConcurrentReviews: 3 } })
  try {
    folders.arm()
    const earlier = h.launcher.start(request(106))
    await waitFor(() => folders.held() === 1)
    const later = await h.launcher.start(request(113, { label: 'Review' }))
    await quiet()
    assert.equal(later.status, 'queued')
    assert.equal(h.launch.children.length, 0)
    folders.open(0)
    assert.equal((await earlier).status, 'running')
    await waitFor(() => h.launch.children.length === 2)
    assert.deepEqual(startOrder(h), [106, 113])
    assert.ok(peak.alive <= 3, `${peak.alive} alive with a cap of 3`)
  } finally {
    await h.cleanup()
  }
})

test('a queued review waits behind an earlier new start still being launched, even once a slot is free for it', async () => {
  const { launch, folders, peak } = observedLaunch()
  const h = await harness({ launch })
  try {
    const running = await h.launcher.start(request(106))
    folders.arm()
    const earlier = h.launcher.start(request(113, { label: 'Review' }))
    await waitFor(() => folders.held() === 1)
    const later = await h.launcher.start(request(118, { label: 'Review' }))
    assert.equal(later.status, 'queued')
    // the running review ends: there is a slot for the queued one, but the start ahead of it has not spawned yet
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(running.id)
    await quiet()
    assert.deepEqual(startOrder(h), [106])
    folders.open(0)
    await earlier
    await waitFor(() => h.launch.children.length === 3)
    assert.deepEqual(startOrder(h), [106, 113, 118])
    assert.ok(peak.alive <= 2, `${peak.alive} alive with a cap of 2`)
  } finally {
    await h.cleanup()
  }
})

test('a new start whose spawn fails hands on to the one that arrived behind it', async () => {
  const { launch, folders } = observedLaunch()
  // the spawn error hits one start only
  const spawn = launch.deps.spawn
  launch.deps.spawn = (request) => {
    const error = launch.spawnError
    launch.spawnError = null
    if (error !== null) throw error
    return spawn(request)
  }
  const h = await harness({ launch, config: { maxConcurrentReviews: 3 } })
  try {
    folders.arm()
    const earlier = h.launcher.start(request(106))
    await waitFor(() => folders.held() === 1)
    const later = await h.launcher.start(request(113, { label: 'Review' }))
    assert.equal(later.status, 'queued')
    h.launch.spawnError = new Error('no such runner')
    folders.open(0)
    assert.equal((await earlier).status, 'failed')
    await waitFor(() => h.launch.children.length === 1)
    assert.deepEqual(startOrder(h), [113])
  } finally {
    await h.cleanup()
  }
})

test('starts decide in the order they arrived, however their checks race: a later one waits for an earlier one still in its checks', async () => {
  const accounts = gate()
  const login = { current: scenario.viewer as string }
  const { launch, peak } = observedLaunch()
  const h = await harness({ launch, gh: gatedGh(accounts, login), config: { maxConcurrentReviews: 3 } })
  try {
    accounts.arm()
    const earlier = h.launcher.start(request(106))
    await waitFor(() => accounts.held() === 1)
    // the later start's checks end first, and nothing spawns, though it has room
    const later = h.launcher.start(request(113, { label: 'Review' }))
    await quiet()
    assert.equal(h.launch.children.length, 0)
    accounts.open(0)
    assert.equal((await earlier).status, 'running')
    await within(later)
    await waitFor(() => h.launch.children.length === 2)
    assert.deepEqual(startOrder(h), [106, 113])
    assert.ok(peak.alive <= 3, `${peak.alive} alive with a cap of 3`)
  } finally {
    await h.cleanup()
  }
})

test('a start refused in its checks is refused at once, whatever is ahead of it, and one behind a start that is refused then starts at once', async () => {
  const accounts = gate()
  const login = { current: scenario.viewer as string }
  const h = await harness({ gh: gatedGh(accounts, login), config: { maxConcurrentReviews: 3 } })
  try {
    accounts.arm()
    const earlier = h.launcher.start(request(106))
    await waitFor(() => accounts.held() === 1)
    // the middle start is refused while the earlier one still makes its checks
    login.current = 'someone-else'
    await assert.rejects(within(h.launcher.start(request(118, { label: 'Review' }))), (error: unknown) => error instanceof LaunchError && error.code === 'identityMismatch')
    login.current = scenario.viewer
    // and one behind it still waits for the earlier one, the refusal having moved nothing ahead
    const later = h.launcher.start(request(113, { label: 'Review' }))
    await quiet()
    assert.equal(h.launch.children.length, 0)
    // the earlier one is refused too: the later one is then the sole start, which goes at once rather than queued
    login.current = 'someone-else'
    accounts.open(0)
    await assert.rejects(earlier, (error: unknown) => error instanceof LaunchError && error.code === 'identityMismatch')
    assert.equal((await within(later)).status, 'running')
    assert.deepEqual(startOrder(h), [113])
  } finally {
    await h.cleanup()
  }
})

test('a sole eligible start goes at once: never queued and no second checks, beside running reviews, over the cap, and once a queue has emptied', async () => {
  const { launch, peak } = observedLaunch()
  const h = await harness({ launch, config: { selfReviewOverCap: true } })
  const accountChecks = (): number => h.gh.calls.filter((call) => call.args[0] === 'api').length
  try {
    h.cache.writePr(scenario.repo, await prOf(101), scenario.defaultBranch)
    const first = await h.launcher.start(request(106))
    assert.deepEqual([first.status, h.launch.children.length, accountChecks()], ['running', 1, 1])
    const second = await h.launcher.start(request(113, { label: 'Review' }))
    assert.deepEqual([second.status, h.launch.children.length, accountChecks()], ['running', 2, 2])
    // the cap is reached and nothing waits, so a self-review goes over it at once
    const over = await h.launcher.start(selfRequest(101))
    assert.deepEqual([over.status, h.launch.children.length, accountChecks()], ['running', 3, 3])
    assert.equal(peak.alive, 3)
    assert.ok(!h.changes.some((run) => run.status === 'queued'))
    // a review that had to wait starts, and once its launch has returned the emptied queue holds no one back
    const waited = await h.launcher.start(request(118, { label: 'Review' }))
    assert.equal(waited.status, 'queued')
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(first.id)
    await waitFor(() => h.launch.children.length === 4)
    await quiet()
    h.launch.children[1]!.exit(1)
    await h.launcher.settled(second.id)
    await quiet()
    assert.equal((await h.launcher.start(request(109, { label: 'Review' }))).status, 'running')
    assert.equal(h.launch.children.length, 5)
    assert.equal(h.changes.filter((run) => run.number === 109 && run.status === 'queued').length, 0)
  } finally {
    await h.cleanup()
  }
})

test('a fix or update session is held by nothing in the line: not a queue, not a launch, and not an earlier start in its checks', async () => {
  const accounts = gate()
  const login = { current: scenario.viewer as string }
  const { launch, folders } = observedLaunch()
  const h = await harness({ launch, gh: gatedGh(accounts, login), config: { maxConcurrentReviews: 1 } })
  try {
    h.cache.writePr(scenario.repo, await prOf(101), scenario.defaultBranch)
    h.cache.writePr(scenario.repo, await prOf(102), scenario.defaultBranch)
    await h.launcher.start(request(106))
    await h.launcher.start(request(113, { label: 'Review' }))
    accounts.arm()
    const held = h.launcher.start(request(118, { label: 'Review' }))
    await waitFor(() => accounts.held() === 1)
    const fix = await within(h.launcher.start(request(101, { command: 'fix-pr', args: ['101'], label: 'Fix session' })))
    assert.equal(fix.status, 'running')
    // nor does a session's own launch hold a review back: its folder wait is its own, and it counts for nothing in the line
    folders.arm()
    const update = h.launcher.start(updateRequest(scenario.repo, 102, 'a'.repeat(40)))
    await waitFor(() => folders.held() === 1)
    accounts.open(0)
    assert.equal((await within(held)).status, 'queued')
    folders.open(0)
    assert.equal((await within(update)).status, 'running')
  } finally {
    await h.cleanup()
  }
})

test('an unexpected failure after a queued review\'s checks fails that review with the error, so it never stays queued, and the queue moves on', async () => {
  const accounts = gate()
  const login = { current: scenario.viewer as string }
  const h = await harness({ gh: gatedGh(accounts, login), config: { maxConcurrentReviews: 1 } })
  try {
    const running = await h.launcher.start(request(106))
    const broken = await h.launcher.start(request(113, { label: 'Review' }))
    const next = await h.launcher.start(request(118, { label: 'Review' }))
    // the running review ends and the first queued one's account check is held
    accounts.arm()
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(running.id)
    await waitFor(() => accounts.held() === 1)
    // the cache read that decides its fit throws once, after the checks
    const readView = h.cache.readView
    let failures = 1
    h.cache.readView = (repo) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('database is locked')
      }
      return readView(repo)
    }
    const settled = h.launcher.settled(broken.id)
    accounts.open(0)
    const failed = await within(settled)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.note, 'spawnFailed: database is locked')
    // the next in line takes the slot, and the failed one is never tried again
    await waitFor(() => h.launch.children.length === 2)
    assert.equal(h.cache.getRun(next.id)?.status, 'running')
    h.launcher.drain()
    await quiet()
    assert.equal(h.cache.getRun(broken.id)?.status, 'failed')
    assert.equal(h.launch.children.length, 2)
  } finally {
    await h.cleanup()
  }
})

test('an unexpected failure while the queue is read fails only the review it was reading, and the next in line still starts', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  try {
    const running = await h.launcher.start(request(106))
    const broken = await h.launcher.start(request(113, { label: 'Review' }))
    const next = await h.launcher.start(request(118, { label: 'Review' }))
    // the cache read that decides the first queued review's fit throws once, as the queue is read
    const readView = h.cache.readView
    let failures = 1
    h.cache.readView = (repo) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('database is locked')
      }
      return readView(repo)
    }
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(running.id)
    const failed = await within(h.launcher.settled(broken.id))
    assert.equal(failed.status, 'failed')
    assert.equal(failed.note, 'spawnFailed: database is locked')
    await waitFor(() => h.launch.children.length === 2)
    assert.equal(h.cache.getRun(next.id)?.status, 'running')
  } finally {
    await h.cleanup()
  }
})

// a launcher over a cache whose writes to the runs the test names throw, as an unwritable database's would; the store reads updateRun when the launcher is made
const failingWrites = (h: Awaited<ReturnType<typeof harness>>, fails: (id: number, changes: RunChanges) => boolean) => {
  const updateRun = h.cache.updateRun
  h.cache.updateRun = (id, changes) => {
    if (fails(id, changes)) throw new Error('attempt to write a readonly database')
    return updateRun(id, changes)
  }
  const launcher = h.make()
  h.cache.updateRun = updateRun
  return launcher
}

test('a queued review whose failure cannot be recorded still leaves the queue failed for whoever awaits it, its row left queued for a restart to fail', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  let unwritable = 0
  const launcher = failingWrites(h, (id, changes) => id === unwritable && changes.status === 'failed')
  try {
    const running = await launcher.start(request(106))
    const broken = await launcher.start(request(113, { label: 'Review' }))
    const next = await launcher.start(request(118, { label: 'Review' }))
    unwritable = broken.id
    const settled = launcher.settled(broken.id)
    // the cache read that decides its fit throws as the queue is read, and every write of its failure throws too
    const readView = h.cache.readView
    let failures = 1
    h.cache.readView = (repo) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('database is locked')
      }
      return readView(repo)
    }
    h.launch.children[0]!.exit(1)
    await launcher.settled(running.id)
    const failed = await within(settled)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.note, 'spawnFailed: database is locked')
    assert.equal((await within(launcher.settled(broken.id))).status, 'failed')
    // its row says queued, the next in line takes the slot, and it is never tried again
    assert.equal(h.cache.getRun(broken.id)?.status, 'queued')
    await waitFor(() => h.launch.children.length === 2)
    assert.equal(h.cache.getRun(next.id)?.status, 'running')
    launcher.drain()
    await quiet()
    assert.deepEqual(startOrder(h), [106, 118])
    // the next start of the server fails the row as it fails any review still queued
    launcher.close()
    const restarted = h.make()
    await restarted.recover()
    restarted.close()
    assert.equal(h.cache.getRun(broken.id)?.note, 'serverRestarted: it was still queued, so it never started')
  } finally {
    launcher.close()
    await h.cleanup()
  }
})

test('a queued review whose row cannot be marked running fails with the error and never spawns, and the queue moves on', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  let unwritable = 0
  // marking it running throws once, and so does the first record of the failure
  const throwsLeft = { running: 1, failed: 1 }
  const launcher = failingWrites(h, (id, changes) => {
    if (id !== unwritable || (changes.status !== 'running' && changes.status !== 'failed')) return false
    if (throwsLeft[changes.status] === 0) return false
    throwsLeft[changes.status] -= 1
    return true
  })
  try {
    const running = await launcher.start(request(106))
    const broken = await launcher.start(request(113, { label: 'Review' }))
    const next = await launcher.start(request(118, { label: 'Review' }))
    unwritable = broken.id
    const settled = launcher.settled(broken.id)
    h.launch.children[0]!.exit(1)
    await launcher.settled(running.id)
    const failed = await within(settled)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.note, 'spawnFailed: attempt to write a readonly database')
    assert.equal(h.cache.getRun(broken.id)?.status, 'failed')
    await waitFor(() => h.launch.children.length === 2)
    assert.equal(h.cache.getRun(next.id)?.status, 'running')
    launcher.drain()
    await quiet()
    assert.deepEqual(startOrder(h), [106, 118])
  } finally {
    launcher.close()
    await h.cleanup()
  }
})

// the writes a launch makes once its process exists: the pid, its start time, and the resume command
const pidWrite = (changes: RunChanges): boolean => 'pid' in changes || 'pidStartedAt' in changes

// a run's request.json as the launcher wrote it
const requestFile = async (h: Awaited<ReturnType<typeof harness>>, id: number): Promise<{ pid: unknown, pidStartedAt: unknown }> =>
  JSON.parse(await readFile(join(h.stateDir, 'runs', String(id), 'request.json'), 'utf8')) as { pid: unknown, pidStartedAt: unknown }

test('a start whose pid cannot be written after its spawn is still watched, counted under the cap, and stoppable, and its end settles it', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  let unwritable = true
  const launcher = failingWrites(h, (_id, changes) => unwritable && pidWrite(changes))
  try {
    const run = await within(launcher.start(request(106)))
    unwritable = false
    assert.equal(run.status, 'running')
    assert.equal(h.launch.children.length, 1)
    const pid = h.launch.children[0]!.pid
    // the row has no pid, while request.json has it for a restart to find
    assert.equal(h.cache.getRun(run.id)?.pid, null)
    assert.equal((await requestFile(h, run.id)).pid, pid)
    // it holds the one slot: the next review queues
    const next = await launcher.start(request(113, { label: 'Review' }))
    assert.equal(next.status, 'queued')
    assert.equal(h.launch.children.length, 1)
    // Stop signals its process group from memory, and its end settles it for whoever awaits it
    const settled = launcher.settled(run.id)
    launcher.stop(run.id)
    assert.deepEqual(h.launch.kills, [{ pid: -pid, signal: 'SIGTERM' }])
    assert.equal((await within(settled)).status, 'stopped')
    assert.equal(h.cache.getRun(run.id)?.status, 'stopped')
    // and its slot goes to the next in line
    await waitFor(() => h.launch.children.length === 2)
    assert.equal(h.cache.getRun(next.id)?.status, 'running')
  } finally {
    launcher.close()
    await h.cleanup()
  }
})

test('a queued review whose pid cannot be written after its spawn keeps its slot until its process ends, so no later review starts over the cap', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  let unwritable = 0
  const launcher = failingWrites(h, (id, changes) => id === unwritable && pidWrite(changes))
  try {
    const running = await launcher.start(request(106))
    const broken = await launcher.start(request(113, { label: 'Review' }))
    const next = await launcher.start(request(118, { label: 'Review' }))
    unwritable = broken.id
    h.launch.children[0]!.exit(1)
    await launcher.settled(running.id)
    await waitFor(() => h.launch.children.length >= 2)
    await quiet()
    // the one spawned is watched and counted, so the next in line waits
    assert.equal(h.cache.getRun(broken.id)?.status, 'running')
    assert.equal(h.cache.getRun(next.id)?.status, 'queued')
    assert.equal(h.launch.children.length, 2)
    // its end settles it from its files, wakes whoever awaits it, and hands the slot on
    const settled = launcher.settled(broken.id)
    h.launch.children[1]!.exit(1)
    const ended = await within(settled)
    assert.equal(ended.status, 'failed')
    assert.equal(noteKind(ended.note), 'noResult')
    await waitFor(() => h.launch.children.length === 3)
    assert.deepEqual(startOrder(h), [106, 113, 118])
  } finally {
    launcher.close()
    await h.cleanup()
  }
})

// a launch whose request.json writes that carry a pid throw, as a full disk's would, while the one made before the spawn, with no pid, succeeds; only the first `left.count` of them throw
const refusedPidFile = (left = { count: Number.POSITIVE_INFINITY }): FakeLaunch => {
  const launch = fakeLaunch()
  const writeRunFile = launch.deps.fs.writeFile
  launch.deps.fs = {
    ...launch.deps.fs,
    writeFile: async (path, text) => {
      if (path.endsWith('request.json') && typeof (JSON.parse(text) as { pid: unknown }).pid === 'number' && left.count > 0) {
        left.count -= 1
        throw new Error('ENOSPC: no space left on device, write')
      }
      return writeRunFile(path, text)
    },
  }
  return launch
}

// the server goes away and a new one starts over the same cache and folders, as a restart would
const restart = async (h: Awaited<ReturnType<typeof harness>>, old: ReturnType<typeof h.make>): Promise<ReturnType<typeof h.make>> => {
  old.close()
  const again = h.make()
  h.watched.length = 0
  await again.recover()
  return again
}

test('a start whose pid neither its row nor request.json will take is watched and counted while this server runs, and a restart, with no pid to find, settles it as serverRestarted', async () => {
  const h = await harness({ launch: refusedPidFile(), config: { maxConcurrentReviews: 1 } })
  const launcher = failingWrites(h, (_id, changes) => pidWrite(changes))
  let restarted: ReturnType<typeof h.make> | null = null
  try {
    const run = await within(launcher.start(request(106)))
    const pid = h.launch.children[0]!.pid
    assert.equal(h.cache.getRun(run.id)?.pid, null)
    assert.equal((await requestFile(h, run.id)).pid, null)
    // it holds the one slot while this server runs: the next review queues
    const next = await launcher.start(request(113, { label: 'Review' }))
    assert.equal(next.status, 'queued')
    assert.equal(h.launch.children.length, 1)
    // with no record of its pid, a restart cannot tell the process is the run's, so it settles the row though the process lives on
    restarted = await restart(h, launcher)
    assert.deepEqual(h.watched, [])
    assert.deepEqual([h.cache.getRun(run.id)?.status, h.cache.getRun(run.id)?.note], ['failed', 'serverRestarted'])
    assert.ok(h.launch.alive.has(pid))
  } finally {
    launcher.close()
    restarted?.close()
    await h.cleanup()
  }
})

test('a start whose row refuses its pid is found by a restart from request.json, holds its slot there, and its end settles it', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  const launcher = failingWrites(h, (_id, changes) => pidWrite(changes))
  let restarted: ReturnType<typeof h.make> | null = null
  try {
    const run = await within(launcher.start(request(106)))
    const child = h.launch.children[0]!
    assert.equal(h.cache.getRun(run.id)?.pid, null)
    assert.equal(h.cache.getRun(run.id)?.pidStartedAt, null)
    const file = await requestFile(h, run.id)
    assert.deepEqual([file.pid, file.pidStartedAt], [child.pid, `start-${child.pid}`])
    restarted = await restart(h, launcher)
    assert.deepEqual(h.watched, [run.id])
    assert.equal(h.cache.getRun(run.id)?.status, 'running')
    // its slot is counted after the restart: a new review queues rather than start over the cap
    const next = await restarted.start(request(113, { label: 'Review' }))
    assert.equal(next.status, 'queued')
    assert.equal(h.launch.children.length, 1)
    // its process ends with no handle on it; the liveness check settles it, and the slot goes to the next in line
    const settled = restarted.settled(run.id)
    child.exit(1)
    h.time.advance(10 * second)
    assert.equal((await within(settled)).status, 'failed')
    await waitFor(() => h.launch.children.length === 2)
    assert.equal(h.cache.getRun(next.id)?.status, 'running')
  } finally {
    launcher.close()
    restarted?.close()
    await h.cleanup()
  }
})

test('a start whose request.json refuses its pid is found by a restart from its row', async () => {
  const h = await harness({ launch: refusedPidFile(), config: { maxConcurrentReviews: 1 } })
  let restarted: ReturnType<typeof h.make> | null = null
  try {
    const run = await within(h.launcher.start(request(106)))
    const pid = h.launch.children[0]!.pid
    assert.equal((await requestFile(h, run.id)).pid, null)
    assert.deepEqual([h.cache.getRun(run.id)?.pid, h.cache.getRun(run.id)?.pidStartedAt], [pid, `start-${pid}`])
    restarted = await restart(h, h.launcher)
    assert.deepEqual(h.watched, [run.id])
    const next = await restarted.start(request(113, { label: 'Review' }))
    assert.equal(next.status, 'queued')
  } finally {
    restarted?.close()
    await h.cleanup()
  }
})

test('a restart whose cache read of a live review throws still watches it again and counts it against the cap', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  let restarted: ReturnType<typeof h.make> | null = null
  try {
    const run = await within(h.launcher.start(request(106)))
    h.launcher.close()
    const readView = h.cache.readView
    let failures = 1
    h.cache.readView = (repo) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('database is locked')
      }
      return readView(repo)
    }
    restarted = h.make()
    await within(restarted.recover())
    assert.equal(failures, 0)
    const next = await restarted.start(request(113, { label: 'Review' }))
    assert.equal(next.status, 'queued')
    assert.equal(h.launch.children.length, 1)
    // its end settles it after the restart, and the slot goes to the next in line
    const settled = restarted.settled(run.id)
    h.launch.children[0]!.exit(1)
    h.time.advance(10 * second)
    assert.equal((await within(settled)).status, 'failed')
    await waitFor(() => h.launch.children.length === 2)
  } finally {
    restarted?.close()
    await h.cleanup()
  }
})

test('a pid the row refuses once is written again with its start time, so a restart finds it though request.json refused it too', async () => {
  const h = await harness({ launch: refusedPidFile(), config: { maxConcurrentReviews: 1 } })
  let refusals = 1
  const launcher = failingWrites(h, (_id, changes) => {
    if (!('pid' in changes) || refusals === 0) return false
    refusals -= 1
    return true
  })
  let restarted: ReturnType<typeof h.make> | null = null
  try {
    const run = await within(launcher.start(request(106)))
    const pid = h.launch.children[0]!.pid
    // request.json refused it, and the row refused it at once after the spawn
    assert.equal((await requestFile(h, run.id)).pid, null)
    assert.equal(refusals, 0)
    assert.deepEqual([h.cache.getRun(run.id)?.pid, h.cache.getRun(run.id)?.pidStartedAt], [pid, `start-${pid}`])
    assert.match(h.cache.getRun(run.id)?.resume ?? '', /claude --resume /)
    restarted = await restart(h, launcher)
    assert.deepEqual(h.watched, [run.id])
  } finally {
    launcher.close()
    restarted?.close()
    await h.cleanup()
  }
})

test('request.json takes the pid as soon as the process exists, and a write of it refused once is made again with the start time, so a restart finds it though the row refused it', async () => {
  const left = { count: 1 }
  const launch = refusedPidFile(left)
  const written: unknown[] = []
  const writeRunFile = launch.deps.fs.writeFile
  launch.deps.fs = {
    ...launch.deps.fs,
    writeFile: async (path, text) => {
      if (path.endsWith('request.json')) written.push((JSON.parse(text) as { pid: unknown }).pid)
      return writeRunFile(path, text)
    },
  }
  const h = await harness({ launch, config: { maxConcurrentReviews: 1 } })
  const launcher = failingWrites(h, (_id, changes) => pidWrite(changes))
  let restarted: ReturnType<typeof h.make> | null = null
  try {
    const run = await within(launcher.start(request(106)))
    const pid = h.launch.children[0]!.pid
    // before the spawn with no pid, at once after it with the pid, and again with its start time
    assert.deepEqual(written, [null, pid, pid])
    assert.equal(left.count, 0)
    assert.deepEqual([(await requestFile(h, run.id)).pid, (await requestFile(h, run.id)).pidStartedAt], [pid, `start-${pid}`])
    restarted = await restart(h, launcher)
    assert.deepEqual(h.watched, [run.id])
  } finally {
    launcher.close()
    restarted?.close()
    await h.cleanup()
  }
})

test('a stop asked during a launch is carried out on the watched process even when its row cannot be read then, and the start still records its start time', async () => {
  const launch = fakeLaunch()
  let release: () => void = () => {}
  const held = new Promise<void>((resolveHeld) => {
    release = resolveHeld
  })
  const mkdirRun = launch.deps.fs.mkdir
  launch.deps.fs = { ...launch.deps.fs, mkdir: async (path) => held.then(() => mkdirRun(path)) }
  const h = await harness({ launch, config: { maxConcurrentReviews: 1 } })
  const getRun = h.cache.getRun
  let unreadable = false
  h.cache.getRun = (id) => {
    if (unreadable) {
      unreadable = false
      throw new Error('database is locked')
    }
    return getRun(id)
  }
  const launcher = h.make()
  h.cache.getRun = getRun
  try {
    const starting = launcher.start(request(106))
    await waitFor(() => h.watched.length === 1)
    const id = h.watched[0]!
    assert.equal(launcher.stop(id).status, 'running')
    // the next read of the row throws, once
    unreadable = true
    // the runner outlives its SIGTERM, so its start time can still be read
    h.launch.ignoreTerm.add(4001)
    release()
    const run = await within(starting)
    const pid = h.launch.children[0]!.pid
    assert.equal(pid, 4001)
    assert.deepEqual(h.launch.kills, [{ pid: -pid, signal: 'SIGTERM' }])
    assert.equal(run.id, id)
    assert.equal(h.cache.getRun(id)?.pidStartedAt, `start-${pid}`)
  } finally {
    launcher.close()
    await h.cleanup()
  }
})

test('a review whose row cannot be read as it settles still settles for whoever awaits it and frees its slot', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  const getRun = h.cache.getRun
  let unreadable = 0
  h.cache.getRun = (id) => {
    if (id === unreadable) throw new Error('database disk image is malformed')
    return getRun(id)
  }
  const launcher = h.make()
  h.cache.getRun = getRun
  try {
    const running = await launcher.start(request(106))
    const next = await launcher.start(request(113, { label: 'Review' }))
    const settled = launcher.settled(running.id)
    unreadable = running.id
    h.launch.children[0]!.exit(1)
    const ended = await within(settled)
    assert.equal(ended.status, 'failed')
    assert.equal(noteKind(ended.note), 'noResult')
    assert.equal(ended.command, 'review-pr')
    unreadable = 0
    assert.equal(h.cache.getRun(running.id)?.status, 'failed')
    await waitFor(() => h.launch.children.length === 2)
    assert.equal(h.cache.getRun(next.id)?.status, 'running')
  } finally {
    launcher.close()
    await h.cleanup()
  }
})

test('a review whose ending the page cannot be told of still settles for whoever awaits it and frees its slot', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  let failing = 0
  const launcher = h.make((run) => {
    if (run.id === failing && run.status !== 'running') throw new Error('the page went away')
  })
  try {
    const running = await launcher.start(request(106))
    const next = await launcher.start(request(113, { label: 'Review' }))
    failing = running.id
    const settled = launcher.settled(running.id)
    h.launch.children[0]!.exit(1)
    assert.equal((await within(settled)).status, 'failed')
    await waitFor(() => h.launch.children.length === 2)
    assert.equal(h.cache.getRun(next.id)?.status, 'running')
  } finally {
    launcher.close()
    await h.cleanup()
  }
})

test('a start that fails before its spawn and cannot record the failure is still given to whoever awaits it as failed, never as the running row', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  let unwritable = true
  const launcher = failingWrites(h, (_id, changes) => unwritable && changes.status === 'failed')
  try {
    h.launch.spawnError = new Error('spawn claude ENOENT')
    const run = await within(launcher.start(request(106)))
    h.launch.spawnError = null
    unwritable = false
    assert.equal(run.status, 'failed')
    assert.equal(run.note, 'spawnFailed: spawn claude ENOENT')
    // the row could not be written, so it still reads running, while every wait for the run is given its failure
    assert.equal(h.cache.getRun(run.id)?.status, 'running')
    const settled = await within(launcher.settled(run.id))
    assert.equal(settled.status, 'failed')
    assert.equal(settled.note, 'spawnFailed: spawn claude ENOENT')
    // it holds no slot: another review starts at once
    assert.equal((await launcher.start(request(113, { label: 'Review' }))).status, 'running')
    // the next server start settles the row, since no process stands behind it
    launcher.close()
    const restarted = h.make()
    await restarted.recover()
    restarted.close()
    assert.equal(noteKind(h.cache.getRun(run.id)?.note ?? null), 'serverRestarted')
  } finally {
    launcher.close()
    await h.cleanup()
  }
})

test('a queued review whose launch fails before its spawn and cannot record the failure still wakes whoever awaits it, and the queue moves on', async () => {
  // the run folder of the review the test names cannot be made
  let blocked = ''
  const launch = fakeLaunch({
    fs: {
      mkdir: async (path) => {
        if (blocked !== '' && path.endsWith(blocked)) throw new Error('EACCES: permission denied')
        await mkdir(path, { recursive: true })
      },
    },
  })
  const h = await harness({ launch, config: { maxConcurrentReviews: 1 } })
  let unwritable = 0
  const launcher = failingWrites(h, (id, changes) => id === unwritable && changes.status === 'failed')
  try {
    const running = await launcher.start(request(106))
    const broken = await launcher.start(request(113, { label: 'Review' }))
    const next = await launcher.start(request(118, { label: 'Review' }))
    unwritable = broken.id
    blocked = join('runs', String(broken.id))
    const settled = launcher.settled(broken.id)
    h.launch.children[0]!.exit(1)
    await launcher.settled(running.id)
    const failed = await within(settled)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.note, 'spawnFailed: EACCES: permission denied')
    assert.equal((await within(launcher.settled(broken.id))).status, 'failed')
    // its row was marked running as it left the queue and stays so; the next in line starts
    assert.equal(h.cache.getRun(broken.id)?.status, 'running')
    await waitFor(() => h.launch.children.length === 2)
    assert.equal(h.cache.getRun(next.id)?.status, 'running')
    assert.deepEqual(startOrder(h), [106, 118])
  } finally {
    launcher.close()
    await h.cleanup()
  }
})

test('a review whose end cannot be recorded still settles for whoever awaits it and frees its slot, its row left running for a restart to settle', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  let unwritable = 0
  const launcher = failingWrites(h, (id, changes) => id === unwritable && changes.finishedAt !== undefined)
  try {
    const running = await launcher.start(request(106))
    const next = await launcher.start(request(113, { label: 'Review' }))
    unwritable = running.id
    const settled = launcher.settled(running.id)
    h.launch.children[0]!.exit(1)
    const ended = await within(settled)
    assert.equal(ended.status, 'failed')
    assert.equal(noteKind(ended.note), 'noResult')
    assert.equal((await within(launcher.settled(running.id))).status, 'failed')
    // the row still reads running, and the slot is the next review's
    assert.equal(h.cache.getRun(running.id)?.status, 'running')
    await waitFor(() => h.launch.children.length === 2)
    assert.equal(h.cache.getRun(next.id)?.status, 'running')
    // a Stop records the row once the database takes the write
    unwritable = 0
    assert.equal(launcher.stop(running.id).status, 'stopped')
    assert.equal(h.cache.getRun(running.id)?.status, 'stopped')
    assert.equal((await within(launcher.settled(running.id))).status, 'stopped')
  } finally {
    launcher.close()
    await h.cleanup()
  }
})

test('a Stop of a queued review whose write is refused changes nothing: the review stays queued in its place and starts when a slot is free', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  let unwritable = 0
  const launcher = failingWrites(h, (id, changes) => id === unwritable && changes.status === 'stopped')
  try {
    const running = await launcher.start(request(106))
    const queued = await launcher.start(request(113, { label: 'Review' }))
    unwritable = queued.id
    assert.throws(() => launcher.stop(queued.id), /readonly database/)
    assert.equal(h.cache.getRun(queued.id)?.status, 'queued')
    h.launch.children[0]!.exit(1)
    await launcher.settled(running.id)
    await waitFor(() => h.launch.children.length === 2)
    assert.equal(h.cache.getRun(queued.id)?.status, 'running')
  } finally {
    launcher.close()
    await h.cleanup()
  }
})

test('a restart that cannot record a queued review\'s failure still watches every live run again, and gives the queued one as failed to whoever awaits it', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  try {
    const running = await h.launcher.start(request(106))
    const queued = await h.launcher.start(request(113, { label: 'Review' }))
    h.launcher.close()
    const restarted = failingWrites(h, (id, changes) => id === queued.id && changes.status === 'failed')
    try {
      await within(restarted.recover())
      const failed = await within(restarted.settled(queued.id))
      assert.equal(failed.status, 'failed')
      assert.equal(noteKind(failed.note), 'serverRestarted')
      assert.equal(h.cache.getRun(queued.id)?.status, 'queued')
      // the live run is watched again, so Stop signals it
      const settled = restarted.settled(running.id)
      restarted.stop(running.id)
      assert.deepEqual(h.launch.kills, [{ pid: -h.launch.children[0]!.pid, signal: 'SIGTERM' }])
      // a run watched again has no child handle, so its end is found on the timer
      h.time.advance(10 * second)
      assert.equal((await within(settled)).status, 'stopped')
    } finally {
      restarted.close()
    }
  } finally {
    await h.cleanup()
  }
})

test('a start whose pruning fails afterward still answers with its run', async () => {
  const h = await harness()
  const pruneRuns = h.cache.pruneRuns
  h.cache.pruneRuns = () => {
    throw new Error('attempt to write a readonly database')
  }
  const launcher = h.make()
  h.cache.pruneRuns = pruneRuns
  try {
    const run = await within(launcher.start(request(106)))
    assert.equal(run.status, 'running')
    assert.equal(h.launch.children.length, 1)
  } finally {
    launcher.close()
    await h.cleanup()
  }
})

test('a queued review is classed as a self-review when it starts, from the cache then, not when it was queued', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1, selfReviewOverCap: true } })
  try {
    for (const number of [101, 102]) h.cache.writePr(scenario.repo, await prOf(number), scenario.defaultBranch)
    await h.launcher.start(request(106))
    const over = await h.launcher.start(request(101, { args: ['101', '--no-post'], label: 'Self-review' }))
    const queued = await h.launcher.start(request(102, { args: ['102', '--no-post'], label: 'Self-review' }))
    assert.deepEqual([over.status, queued.status], ['running', 'queued'])
    // while it waits, the cache learns #102 is someone else's
    const theirs = await prOf(102)
    h.cache.writePr(scenario.repo, { ...theirs, author: { ...theirs.author!, login: 'someone-else' } }, scenario.defaultBranch)
    // the self-review over the cap ends: the place over it is a self-review's, and #102 is no longer one
    h.launch.children[1]!.exit(1)
    await h.launcher.settled(over.id)
    await quiet()
    assert.equal(h.cache.getRun(queued.id)?.status, 'queued')
    assert.equal(h.launch.children.length, 2)
    // it takes the cap's own slot once that is free
    h.launch.children[0]!.exit(1)
    await waitFor(() => h.launch.children.length === 3)
    assert.equal(h.cache.getRun(queued.id)?.status, 'running')
  } finally {
    await h.cleanup()
  }
})

test('a stop during a queued review\'s dequeue checks ends that attempt and frees its slot, and its late end never frees a newer run\'s', async () => {
  const accounts = gate()
  const login = { current: scenario.viewer as string }
  const launch = fakeLaunch()
  const starts = gate()
  const mkdirRun = launch.deps.fs.mkdir
  launch.deps.fs = {
    ...launch.deps.fs,
    mkdir: async (path) => {
      await starts.wait()
      await mkdirRun(path)
    },
  }
  const h = await harness({ gh: gatedGh(accounts, login), launch })
  try {
    const first = await h.launcher.start(request(106))
    const alongside = await h.launcher.start(request(107, { label: 'Review' }))
    const queued = await h.launcher.start(request(113, { label: 'Review' }))
    // the first ends and the queued review's account check is held; then the second ends too
    accounts.arm()
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(first.id)
    await waitFor(() => accounts.held() === 1)
    h.launch.children[1]!.exit(1)
    await h.launcher.settled(alongside.id)
    const stopped = h.launcher.stop(queued.id)
    assert.equal(stopped.status, 'stopped')
    assert.equal((await h.launcher.settled(queued.id)).status, 'stopped')
    // a new run of the same PR starts and is held before its spawn
    starts.arm()
    const again = h.launcher.start(request(113, { label: 'Review' }))
    await waitFor(() => starts.held() === 1)
    // the stopped attempt's checks end late: they release nothing of the new run's
    accounts.open(0)
    await quiet()
    assert.equal(h.launch.children.length, 2)
    // two more arrive behind it: the new run's slot still counts, so the first of them is given the last slot and makes its checks again, and the second is given none and makes none
    const accountChecks = (): number => h.gh.calls.filter((call) => call.args[0] === 'api').length
    const checksBefore = accountChecks()
    const other = await h.launcher.start(request(118, { label: 'Review' }))
    const beyond = await h.launcher.start(request(109, { label: 'Review' }))
    await quiet()
    assert.deepEqual([other.status, beyond.status], ['queued', 'queued'])
    assert.equal(accountChecks(), checksBefore + 3)
    assert.equal(h.launch.children.length, 2)
    starts.open(0)
    assert.equal((await again).status, 'running')
    await waitFor(() => h.launch.children.length === 4)
    assert.deepEqual(startOrder(h), [106, 107, 113, 118])
    assert.equal(h.cache.getRun(beyond.id)?.status, 'queued')
  } finally {
    await h.cleanup()
  }
})

test('raising the cap starts queued reviews at once, and a restart fails queued reviews as serverRestarted without starting anything', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  try {
    await h.launcher.start(request(106))
    const a = await h.launcher.start(request(113, { label: 'Review' }))
    const b = await h.launcher.start(request(118, { label: 'Review' }))
    const c = await h.launcher.start(request(109, { label: 'Review' }))
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 2 }
    h.launcher.drain()
    await waitFor(() => h.launch.children.length === 2)
    assert.deepEqual([a, b, c].map((run) => h.cache.getRun(run.id)?.status), ['running', 'queued', 'queued'])
    // the server goes away with two reviews still queued
    h.launcher.close()
    const callsBefore = h.gh.calls.length
    const again = h.make()
    await again.recover()
    assert.deepEqual([b, c].map((run) => [h.cache.getRun(run.id)?.status, noteKind(h.cache.getRun(run.id)?.note ?? null)]), [['failed', 'serverRestarted'], ['failed', 'serverRestarted']])
    // nothing started and nothing asked GitHub
    assert.equal(h.launch.children.length, 2)
    assert.equal(h.gh.calls.length, callsBefore)
    again.close()
  } finally {
    await h.cleanup()
  }
})

test('a queued run\'s cell is queued, carries the run, and offers no other start while it waits', async () => {
  const pr = await prOf(106)
  const cell = agentCell(pr, baseConfig(), runRow({ status: 'queued', pid: null, pidStartedAt: null, resume: null }), undefined)
  assert.equal(cell.state, 'queued')
  assert.equal(cell.label, 'Re-review')
  assert.equal(cell.status, 'queued')
  assert.equal(cell.text, null)
  assert.ok(cell.starts.every((option) => option.unavailable === 'a run for #106 is already in flight'))
})

test('a run directory Pit View cannot write is refused before the runner starts, as permissionDenied', async () => {
  let blocked = true
  const launch = fakeLaunch({
    fs: {
      writeFile: async (path, text) => {
        if (blocked && path.endsWith('.write-probe')) throw new Error('EACCES: permission denied')
        await writeFile(path, text)
      },
    },
  })
  const h = await harness({ launch })
  try {
    const run = await h.launcher.start(request())
    assert.equal(run.status, 'failed')
    assert.equal(run.note, `permissionDenied: ~/.local/state/pit-view/runs/${run.id} cannot be written: EACCES: permission denied`)
    // nothing was spawned, and the PR is free once the folder can be written again
    assert.deepEqual(launch.children, [])
    blocked = false
    assert.equal((await h.launcher.start(request())).status, 'running')
  } finally {
    await h.cleanup()
  }
})

test('a run\'s start, steps and settling each patch its row, with consecutive versions', async () => {
  const h = await harness()
  const patches: Patch[] = []
  const poller = createPoller({
    cache: h.cache,
    gh: createGh(h.gh.runner),
    clock: h.time.clock,
    timers: h.time.timers,
    config: () => h.settings.current,
    home: '/nonexistent/pit-view-test-home',
    timeZone: scenario.timeZone,
    emit: (patch) => patches.push(patch),
    pageSize: scenario.pageSize,
  })
  const launcher = h.make((run) => poller.runChanged(run.repo, run.number), () => poller.queueingChanged())
  try {
    poller.refresh('manual')
    await poller.idle()
    const before = (await poller.view()).others.groups.flatMap((group) => group.rows).find((row) => row.number === 106)!
    assert.equal(before.agent?.state, 'idle')
    assert.equal(before.agent?.label, 'Re-review')
    const from = patches.length
    const run = await launcher.start(request())
    await launcher.flushed()
    const child = h.launch.children[0]!
    await child.events(step('resolveBase', 'started', '2026-10-26T14:06:00Z'))
    await launcher.check()
    await launcher.flushed()
    await h.report(106)
    await child.result(reviewResult({ reviewed: { kind: 'commit', sha: (await prOf(106)).headRefOid } }))
    const settled = launcher.settled(run.id)
    child.exit(0)
    await settled
    await launcher.flushed()
    const runPatches = patches.slice(from)
    // the launcher's announcements coalesce per turn, so the number of patches is not the number of changes; the versions stay consecutive
    assert.deepEqual(runPatches.map((patch) => patch.version), runPatches.map((_, index) => from + 1 + index))
    const cells = runPatches.map((patch) => {
      // every run change sends every open row, since it may move the queue answer
      assert.equal(patch.rows.filter((row: OpenRow) => row.number === 106).length, 1)
      assert.equal(patch.tiles, undefined)
      return patch.rows.find((row: OpenRow) => row.number === 106)!.agent!
    })
    const states = cells.map((cell) => [cell.state, cell.step?.name ?? null, cell.text]).filter((cell, index, all) => index === 0 || JSON.stringify(cell) !== JSON.stringify(all[index - 1]))
    assert.deepEqual(states, [
      ['running', null, null], ['running', 'resolveBase', null], ['done', 'resolveBase', 'Changes requested'],
    ])
    assert.equal(cells[0]!.runId, run.id)
    assert.equal(cells.at(-1)!.finishedAt, '2026-10-26T14:05:38Z')
    // a run in another repo sends no rows of its own: the launcher's one announcement does, since it counts against the one cap
    poller.runChanged('octo-example/other', 106)
    assert.equal(patches.length, from + runPatches.length)
  } finally {
    launcher.close()
    poller.stop()
    await h.cleanup()
  }
})

// the fix session (P2.6)

const fixRun = (result: Record<string, unknown> | null, patch: Partial<Run> = {}): Run => runRow({
  number: 101, command: 'fix-pr', args: ['101'], label: 'Fix session', status: (result?.status as Run['status'] | undefined) ?? 'done',
  finishedAt: '2026-10-28T15:00:00Z', result: result as unknown as RunResultJson | null, ...patch,
})

test('a fix session is offered on every own open PR, drafts included, Claude only and without --no-post; never on others\' or bots\' PRs, and never the default', async () => {
  const config = baseConfig()
  const fixOf = async (number: number, viewer = config) => startOptions(await prOf(number), viewer, null, false).find((option) => option.kind === 'fix')
  // 101 has changes requested, 103 is a draft, 104 awaits review, 120 is approved
  for (const number of [101, 103, 104, 120]) {
    const fix = await fixOf(number)
    assert.ok(fix !== undefined, `#${number}`)
    assert.deepEqual([fix.label, fix.button, fix.command, fix.args, fix.runners, fix.posts.kind, fix.unavailable], ['Fix session', 'Fix requested changes', 'fix-pr', [String(number)], ['claude'], 'push', null])
    assert.ok(!fix.args.includes('--no-post'))
    assert.equal(notOffered('fix', await prOf(number), config, null), null)
  }
  assert.equal((await fixOf(101))?.posts.text, 'Pushes new commits to fix/webhook-retry on GitHub. It posts no replies or reviews, and stops to ask when a request needs judgment.')
  // others' PRs, Dependabot's and Renovate's
  for (const number of [113, 106, 111, 114, 115]) {
    assert.equal(await fixOf(number), undefined, `#${number}`)
    assert.match(notOffered('fix', await prOf(number), config, null) ?? '', new RegExp(`only on your own PRs, and #${number} is not yours`))
  }
  // a bot is never the owner, even when the configured viewer names one
  const botViewer = { ...config, viewer: (await prOf(114)).author!.login }
  assert.equal(await fixOf(114, botViewer), undefined)
  assert.notEqual(notOffered('fix', await prOf(114), botViewer, null), null)
  // the default stays Self-review, changes requested or not, and the fix comes last
  const cell = agentCell(await prOf(101), config, undefined, undefined)
  assert.deepEqual([cell.action.kind, cell.action.command, cell.action.args, cell.label], ['selfReview', 'review-pr', ['101', '--no-post'], 'Self-review'])
  assert.deepEqual(cell.starts.map((option) => option.kind), ['default', 'tandem', 'fix'])
  // while a run is in flight, the fix is as unavailable as the rest
  assert.ok(agentCell(await prOf(101), config, runRow({ number: 101 }), undefined).starts.every((option) => option.unavailable?.includes('in flight')))
})

const fixParsed = (patch: Record<string, unknown> = {}) => parseResult(JSON.stringify(fixResult(patch)))

const nothingToFix = (): Record<string, unknown> => fixResult({
  requests: [fixRequest({ triage: 'noChange', outcome: 'notFixed', commits: [] })], checks: [], pushed: null, notPushedReason: 'nothingToFix',
})

const askedFirst = (): Record<string, unknown> => fixResult({
  status: 'needsInput', requests: [fixRequest({ triage: 'needsJudgment', outcome: 'awaitingAnswer', commits: [] })], checks: [], pushed: null,
  notPushedReason: 'awaitingAnswer', report: null, question: 'Either retry with jitter or cap the attempts: which?',
})

const refusedPush = (): Record<string, unknown> => fixResult({
  status: 'failed', pushed: null, notPushedReason: 'pushFailed', worktree: '~/agents/worktrees/orbit-fix-101-20261028T150000',
  error: '! [rejected] HEAD -> fix/webhook-retry (non-fast-forward)',
})

test('a fix result is checked against pit-crew/fix-result@1: done with pushes, nothing to fix, a stop with no report, a refused push', () => {
  for (const [name, value] of [['pushed', fixResult()], ['nothing to fix', nothingToFix()], ['needsInput', askedFirst()], ['pushFailed', refusedPush()]] as const) {
    const parsed = parseResult(JSON.stringify(value))
    assert.equal(parsed.ok, true, `${name}: ${parsed.ok ? '' : parsed.error}`)
  }
  // a stop after the checks failed keeps its commits unpushed in a worktree; discarding them later ends done with that reason
  const checksFailed = { status: 'needsInput', pushed: null, notPushedReason: 'checksFailed', checks: [{ name: 'pnpm test', result: 'failed' }], worktree: '~/agents/worktrees/orbit-fix-101-x', question: 'Push anyway, hand off, or discard?' }
  assert.equal(fixParsed(checksFailed).ok, true)
  assert.equal(fixParsed({ ...checksFailed, status: 'done', question: null }).ok, true)
  // a run that failed before it read anything
  assert.equal(fixParsed({ status: 'failed', target: null, head: null, requests: [], checks: [], pushed: null, notPushedReason: null, report: null, error: 'this PR is not yours' }).ok, true)
  // uppercase hex is still a full SHA
  assert.equal(fixParsed({ head: { sha: fixHead.toUpperCase() } }).ok, true)
})

test('a fix result that breaks its schema is no result: a missing field, a bad enum, a short SHA, a URL that is not http or https', () => {
  const short = fixHead.slice(0, 7)
  const refusals: [Record<string, unknown>, RegExp][] = [
    [(({ worktree: _worktree, ...rest }) => rest)(fixResult()), /worktree is missing/],
    [(({ requests: _requests, ...rest }) => rest)(fixResult()), /requests is missing/],
    [fixResult({ command: 'review-pr' }), /command must be fix-pr/],
    [fixResult({ status: 'pushed' }), /status must be/],
    [fixResult({ status: 'needsInput', question: null }), /must carry its question/],
    [fixResult({ status: 'failed', error: '' }), /must carry its error/],
    [fixResult({ notPushedReason: 'tooBig', pushed: null }), /notPushedReason must be/],
    [fixResult({ requests: [fixRequest({ triage: 'easy' })] }), /requests\[0\]\.triage/],
    [fixResult({ requests: [fixRequest({ outcome: 'done' })] }), /requests\[0\]\.outcome/],
    [fixResult({ requests: [fixRequest({ kind: 'comment' })] }), /requests\[0\]\.kind/],
    [fixResult({ requests: [fixRequest(), fixRequest({ outdated: 'yes' })] }), /requests\[1\]\.outdated/],
    [fixResult({ requests: [fixRequest({ line: 0 })] }), /requests\[0\]\.line/],
    [fixResult({ checks: [{ name: 'pnpm test', result: 'skipped' }] }), /checks must be/],
    [fixResult({ target: { repo: 'octo-example/orbit', pr: '101', branch: 'fix/webhook-retry' } }), /target must be/],
    [fixResult({ head: { sha: short } }), /head must be null or \{ sha \} with a full 40-character SHA/],
    [fixResult({ head: { sha: `${fixHead}0` } }), /head must be/],
    [fixResult({ head: { sha: fixHead.replace(/a/g, 'g') } }), /head must be/],
    [fixResult({ requests: [fixRequest({ commits: [short] })] }), /requests\[0\]\.commits must be a list of full SHAs/],
    [fixResult({ pushed: { branch: 'fix/webhook-retry', head: short, commits: [{ sha: fixPushedHead, subject: 'x' }] } }), /pushed must be/],
    [fixResult({ pushed: { branch: 'fix/webhook-retry', head: fixPushedHead, commits: [{ sha: short, subject: 'x' }] } }), /pushed must be/],
    [fixResult({ pushed: { branch: 'fix/webhook-retry', head: fixPushedHead, commits: [] } }), /at least one commit/],
    [fixResult({ notPushedReason: 'checksFailed' }), /notPushedReason must be null when pushed/],
  ]
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' https://example.test/x', 'data:text/html,x', '/pull/101#discussion_r1', '', null]) {
    refusals.push([fixResult({ requests: [fixRequest({ url })] }), /requests\[0\]\.url must be an absolute http or https url/])
  }
  for (const [value, pattern] of refusals) {
    const parsed = parseResult(JSON.stringify(value))
    assert.equal(parsed.ok, false, String(pattern))
    assert.match(parsed.ok ? '' : parsed.error, pattern)
  }
  // through the settle path, an invalid fix result fails the run as noResult
  const settled = judge({ stopped: false, restarted: false, exit: { code: 0, signal: null, error: null }, reportExists: true, denials: [], lastEvent: null, parsed: fixParsed({ requests: [fixRequest({ url: 'javascript:alert(1)' })] }) })
  assert.deepEqual([settled.status, settled.result], ['failed', null])
  assert.match(settled.note ?? '', /^noResult: result.json: requests\[0\]\.url/)
})

test('a fix run settles from its result: done needs its report on disk, a stop before touching code needs none, a refused push fails with git\'s error', () => {
  const base = { stopped: false, restarted: false, exit: { code: 0, signal: null, error: null }, denials: [], lastEvent: null }
  assert.equal(judge({ ...base, reportExists: true, parsed: fixParsed() }).status, 'done')
  assert.deepEqual(judge({ ...base, reportExists: false, parsed: fixParsed() }).note, 'noReport: ~/agents/output/FIX-101.md does not exist')
  assert.deepEqual(judge({ ...base, reportExists: false, parsed: parseResult(JSON.stringify(nothingToFix())) }).note, 'noReport: ~/agents/output/FIX-101.md does not exist')
  const waiting = judge({ ...base, reportExists: null, parsed: parseResult(JSON.stringify(askedFirst())) })
  assert.deepEqual([waiting.status, waiting.note, waiting.result?.question], ['needsInput', null, 'Either retry with jitter or cap the attempts: which?'])
  const refused = judge({ ...base, reportExists: null, parsed: parseResult(JSON.stringify(refusedPush())) })
  assert.deepEqual([refused.status, refused.note], ['failed', '! [rejected] HEAD -> fix/webhook-retry (non-fast-forward)'])
})

test('a fix run starts as fix-pr with Claude only, settles from FIX-<n>.md, and Codex is refused before anything runs', async () => {
  const h = await harness({ config: { agent: { runner: 'codex', claudeModel: 'sonnet' } } })
  try {
    const fix = request(101, { command: 'fix-pr', args: ['101'], label: 'Fix session' })
    const refused = (error: unknown): boolean => error instanceof LaunchError && error.code === 'fixRunner' && /Fix session runs with Claude only/.test(error.message)
    await assert.rejects(h.launcher.start(fix), refused)
    await assert.rejects(h.launcher.start({ ...fix, runner: 'codex' }), refused)
    assert.equal(h.launch.children.length, 0)
    const run = await h.launcher.start({ ...fix, runner: 'claude' })
    const child = h.launch.children[0]!
    const runDir = join(h.stateDir, 'runs', String(run.id))
    assert.deepEqual(child.writes.map((line) => JSON.parse(line).message.content), [`/fix-pr 101 --emit-json=${runDir}`])
    // the identity check still runs before the start
    assert.deepEqual(h.gh.calls.filter((call) => call.args[0] === 'api').map((call) => call.args), [['api', 'user', '--jq', '.login']])
    await child.result(fixResult())
    let settled = h.launcher.settled(run.id)
    child.exit(0)
    assert.deepEqual([(await settled).status, (await settled).note], ['failed', 'noReport: ~/agents/output/FIX-101.md does not exist'])
    await writeFile(join(h.home, 'agents', 'output', 'FIX-101.md'), 'PR: #101 `fix/webhook-retry` @ `aaaaaaa`\n')
    const again = await h.launcher.start({ ...fix, runner: 'claude' })
    const second = h.launch.children[1]!
    await second.result(fixResult())
    settled = h.launcher.settled(again.id)
    second.exit(0)
    const done = await settled
    assert.deepEqual([done.status, done.note, done.result?.schema], ['done', null, 'pit-crew/fix-result@1'])
  } finally {
    await h.cleanup()
  }
})

test('a finished fix stays done while the PR\'s head is the one it pushed, or the one it read when it pushed nothing, then goes idle', async () => {
  const config = baseConfig()
  const pr = await prOf(101)
  const at = (sha: string): RawOpenPr => ({ ...pr, headRefOid: sha })
  const other = '0123456789abcdef0123456789abcdef01234567'
  const pushed = fixRun(fixResult())
  assert.equal(agentCell(at(fixPushedHead), config, pushed, undefined).state, 'done')
  // the cached row still has the head the run read until the PR is next fetched
  assert.equal(agentCell(at(fixHead), config, pushed, undefined).state, 'done')
  const moved = agentCell(at(other), config, pushed, undefined)
  assert.deepEqual([moved.state, moved.label, moved.runId, moved.text], ['idle', 'Self-review', 7, 'Fixed · pushed 2 commits'])
  // nothing pushed: the head it read
  const nothing = fixRun(nothingToFix())
  assert.equal(agentCell(at(fixHead), config, nothing, undefined).state, 'done')
  assert.equal(agentCell(at(other), config, nothing, undefined).state, 'idle')
  assert.equal(agentCell(at(fixHead), config, fixRun(askedFirst()), undefined).state, 'done')
  assert.equal(agentCell(at(other), config, fixRun(askedFirst()), undefined).state, 'idle')
  // a run that stopped before reading the head, or left no result, stays done
  const early = fixRun(fixResult({ status: 'failed', target: null, head: null, requests: [], checks: [], pushed: null, notPushedReason: null, report: null, error: 'not yours' }), { note: 'not yours' })
  assert.equal(agentCell(at(other), config, early, undefined).state, 'done')
  assert.equal(agentCell(at(other), config, fixRun(null, { status: 'failed', note: 'noResult: no result.json; exit code 1; last event: none' }), undefined).state, 'done')
})

test('a fix run\'s done text says what it pushed, or why not, beside the failure texts every run shares', () => {
  const text = (result: Record<string, unknown> | null, patch: Partial<Run> = {}): string => doneText(fixRun(result, patch), false)
  assert.equal(text(fixResult()), 'Fixed · pushed 2 commits')
  const one = fixResult({ pushed: { branch: 'fix/webhook-retry', head: fixPushedHead, commits: [{ sha: fixPushedHead, subject: 'Log the attempt number' }] } })
  assert.equal(text(one), 'Fixed · pushed 1 commit')
  assert.equal(text(nothingToFix()), 'Nothing to fix')
  // the owner discarded the commits at a stop: done, with the stop's reason
  assert.equal(text(fixResult({ pushed: null, notPushedReason: 'checksFailed' })), 'Not pushed · checks failed')
  assert.equal(text(fixResult({ pushed: null, notPushedReason: 'checksNotRun' })), 'Not pushed · checks not run')
  assert.equal(text(fixResult({ pushed: null, notPushedReason: 'awaitingAnswer' })), 'Not pushed')
  assert.equal(text(askedFirst()), 'Needs your answer')
  assert.equal(text(fixResult({ status: 'needsInput', pushed: null, notPushedReason: 'checksFailed', question: 'Push anyway?' })), 'Needs your answer')
  assert.equal(text(refusedPush(), { note: '! [rejected] HEAD -> fix/webhook-retry (non-fast-forward)' }), 'Failed · push refused')
  assert.equal(text(fixResult({ status: 'failed', pushed: null, notPushedReason: null, error: 'this PR is not yours' }), { note: 'this PR is not yours' }), 'Failed')
  // Pit View's own failures win over the command's, as for every run
  assert.equal(text(refusedPush(), { note: 'permissionDenied: Bash' }), 'Failed · permission denied')
  assert.equal(text(null, { status: 'failed', note: 'noResult: no result.json; exit code 1; last event: none' }), 'Failed · no result')
  assert.equal(text(fixResult(), { status: 'failed', note: 'noReport: ~/agents/output/FIX-101.md does not exist' }), 'Failed · no report')
  assert.equal(text(null, { status: 'failed', note: 'serverRestarted' }), 'Failed · server restarted')
  assert.equal(text(null, { status: 'failed', note: 'spawnFailed: spawn claude ENOENT' }), 'Failed · could not start')
  assert.equal(text(null, { status: 'stopped' }), 'Stopped')
})

test('a fix run\'s cell carries the summary the drawer needs: counts by triage and outcome, the push with short SHAs, checks, worktree and report', async () => {
  const pr = { ...(await prOf(101)), headRefOid: fixPushedHead }
  const cell = agentCell(pr, baseConfig(), fixRun(fixResult()), undefined)
  assert.deepEqual([cell.state, cell.label, cell.command, cell.args, cell.tandem, cell.text, cell.question], ['done', 'Fix session', 'fix-pr', ['101'], false, 'Fixed · pushed 2 commits', null])
  assert.deepEqual(cell.result, {
    kind: 'fix',
    requests: 3,
    triage: { needsJudgment: 0, noChange: 0, disagree: 0, outOfScope: 1, clear: 2 },
    outcomes: { fixed: 2, notFixed: 1, awaitingAnswer: 0 },
    pushed: { branch: 'fix/webhook-retry', head: fixPushedHead, count: 2, commits: [{ sha: fixCommits[0]!.slice(0, 7), subject: 'Back off between retries' }, { sha: 'bbbbbbb', subject: 'Log the attempt number' }] },
    notPushedReason: null,
    checks: [{ name: 'pnpm test', result: 'passed' }, { name: 'pnpm check', result: 'passed' }],
    worktree: null,
    report: '~/agents/output/FIX-101.md',
  })
  const waiting = agentCell({ ...pr, headRefOid: fixHead }, baseConfig(), fixRun(askedFirst()), undefined)
  assert.deepEqual([waiting.state, waiting.text, waiting.question], ['done', 'Needs your answer', 'Either retry with jitter or cap the attempts: which?'])
  assert.deepEqual(waiting.result, {
    kind: 'fix', requests: 1, triage: { needsJudgment: 1, noChange: 0, disagree: 0, outOfScope: 0, clear: 0 }, outcomes: { fixed: 0, notFixed: 0, awaitingAnswer: 1 },
    pushed: null, notPushedReason: 'awaitingAnswer', checks: [], worktree: null, report: null,
  })
  // a review's summary says it is one
  assert.equal(agentCell(await prOf(106), baseConfig(), runRow({ status: 'done', result: reviewResult({ reviewed: { kind: 'commit', sha: (await prOf(106)).headRefOid } }) as unknown as RunResultJson }), undefined).result?.kind, 'review')
})

test('a well-formed fix result that contradicts itself fails the run but keeps the result: no report, no push outcome, another report, another branch', async () => {
  const base = { stopped: false, restarted: false, exit: { code: 0, signal: null, error: null }, denials: [], lastEvent: null }
  const settle = (patch: Record<string, unknown>, reportExists: boolean | null = true) => {
    const parsed = fixParsed(patch)
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error)
    return judge({ ...base, reportExists, parsed })
  }
  // each keeps its result, so the drawer still has the commits
  const kept = (judgement: ReturnType<typeof judge>): void => {
    assert.equal(judgement.status, 'failed')
    assert.equal(judgement.result?.schema, 'pit-crew/fix-result@1')
  }
  const unnamed = settle({ report: null }, null)
  kept(unnamed)
  assert.equal(unnamed.note, 'noReport: result.json names no report')
  const neither = settle({ pushed: null, notPushedReason: null })
  kept(neither)
  assert.equal(neither.note, 'badResult: a done fix result carries neither pushed nor notPushedReason')
  const review = settle({ report: '~/agents/output/PR-101.md' })
  kept(review)
  assert.equal(review.note, 'badResult: report ~/agents/output/PR-101.md is not FIX-101.md for the run\'s target')
  for (const report of ['~/agents/output/FIX-1010.md', '~/agents/output/FIX-101.md.bak', 'FIX-102.md']) assert.match(settle({ report }).note ?? '', /^badResult: report /, report)
  kept(settle({ status: 'needsInput', question: 'Push anyway?', report: '~/agents/output/PR-101.md' }))
  assert.match(settle({ target: null, report: '~/agents/output/FIX-101.md' }).note ?? '', /^badResult: report .* is not FIX-<n>\.md/)
  const branch = settle({ pushed: { branch: 'main', head: fixPushedHead, commits: [{ sha: fixPushedHead, subject: 'x' }] } })
  kept(branch)
  assert.equal(branch.note, 'badResult: pushed.branch main is not the target branch fix/webhook-retry')
  // FIX-<n>.md anywhere is the basename the check reads; a stop with no report and a well-formed done pass
  assert.equal(settle({ report: '/elsewhere/FIX-101.md' }).status, 'done')
  assert.equal(settle({ status: 'needsInput', question: 'Which?', pushed: null, notPushedReason: 'awaitingAnswer', report: null }, null).status, 'needsInput')
  assert.equal(settle({}).status, 'done')
  assert.equal(doneText({ status: 'failed', note: neither.note, result: neither.result }, false), 'Failed · bad result')

  // a run that really pushed still reads as pushed in the drawer, and its head rule still works
  const config = baseConfig()
  const pr = { ...(await prOf(101)), headRefOid: fixPushedHead }
  const cell = agentCell(pr, config, fixRun(fixResult({ report: '~/agents/output/PR-101.md' }), { status: 'failed', note: review.note }), undefined)
  assert.deepEqual([cell.state, cell.text], ['done', 'Failed · bad result'])
  assert.deepEqual([cell.result?.kind === 'fix' ? cell.result.pushed?.count : null, cell.result?.kind === 'fix' ? cell.result.report : 'x'], [2, null])
  assert.equal(agentCell({ ...pr, headRefOid: '0123456789abcdef0123456789abcdef01234567' }, config, fixRun(fixResult({ report: null }), { status: 'failed', note: unnamed.note }), undefined).state, 'idle')
})

// reading a finished run again (section 8, Launching runs, Re-reading a result)

const eventsLines = (...lines: Record<string, unknown>[]): string => lines.map((line) => `${JSON.stringify(line)}\n`).join('')

// a review run that settles failed on a denied tool, with a result.json that would have passed
const deniedRun = async (h: Awaited<ReturnType<typeof harness>>, result: Record<string, unknown> = reviewResult({ verdict: 'clean', findings: [], posted: null, notPostedReason: 'ghFailed' })): Promise<Run> => {
  await h.report(106)
  const run = await h.launcher.start(request())
  const child = h.launch.children.at(-1)!
  await child.events(step('review', 'done'), step('post', 'started', '2026-10-26T14:07:00Z'), step('post', 'done', '2026-10-26T14:08:00Z', 'gh pr review was denied'))
  await child.stream({ type: 'result', total_cost_usd: 0.5, permission_denials: [{ tool_name: 'Bash', tool_use_id: 'b1' }] })
  await child.result(result)
  const settled = h.launcher.settled(run.id)
  child.exit(0)
  return settled
}

const approvedByHand = (patch: Record<string, unknown> = {}): Record<string, unknown> =>
  reviewResult({ verdict: 'clean', findings: [], notPostedReason: null, posted: { form: 'approve', url: 'https://github.com/octo-example/orbit/pull/106#pullrequestreview-9' }, ...patch })

test('a run denied a tool and finished by hand reads as Approved after a re-read, keeping the denial note and the later post step', async () => {
  const h = await harness()
  try {
    const denied = await deniedRun(h)
    assert.deepEqual([denied.status, denied.note, denied.resolvedByHand], ['failed', 'permissionDenied: Bash', false])
    const dir = join(h.home, '.local', 'state', 'pit-view', 'runs', String(denied.id))
    // the owner resumed the session, approved by hand, and the session rewrote result.json and appended a post event
    await writeFile(join(dir, 'result.json'), JSON.stringify(approvedByHand()))
    await writeFile(join(dir, 'events.jsonl'), `${await readFile(join(dir, 'events.jsonl'), 'utf8')}${eventsLines(step('post', 'done', '2026-10-26T15:00:00Z', 'approval posted manually'))}`)
    const before = h.changes.length
    const run = await h.launcher.reread(denied.id)
    assert.deepEqual([run.status, run.resolvedByHand, run.note], ['done', true, 'permissionDenied: Bash'])
    assert.equal(run.result?.schema === 'pit-crew/review-result@1' ? run.result.posted?.form : null, 'approve')
    assert.equal(run.finishedAt, denied.finishedAt)
    assert.equal(stepsOf(run).find((slot) => slot.step === 'post')?.note, 'approval posted manually')
    assert.equal(run.lastStepAt, '2026-10-26T15:00:00Z')
    // the row is stored, announced as a change, and the cell reads Approved with the note that it was finished by hand
    assert.equal(h.cache.getRun(denied.id)?.resolvedByHand, true)
    assert.equal(h.changes.length, before + 1)
    const cell = agentCell(await prOf(106), baseConfig(), run, undefined)
    assert.equal(cell.text, 'Approved · finished by hand')
    assert.equal(cell.resolvedByHand, true)
    assert.equal(cell.note, 'permissionDenied: Bash')
    // a settled run that is done cannot be read again
    await assert.rejects(h.launcher.reread(denied.id), (error: unknown) => error instanceof LaunchError && error.code === 'notRereadable')
  } finally {
    await h.cleanup()
  }
})

const failedByHand = (error: string): Record<string, unknown> => reviewResult({ status: 'failed', error, verdict: null, findings: [], posted: null })

test('a denied run that fails again and is then finished by hand keeps the original denial in firstNote, while note follows each new failure', async () => {
  const h = await harness()
  try {
    const denied = await deniedRun(h)
    assert.equal(denied.firstNote, null)
    const file = join(h.home, '.local', 'state', 'pit-view', 'runs', String(denied.id), 'result.json')
    await writeFile(file, JSON.stringify(failedByHand('could not reach GitHub')))
    const again = await h.launcher.reread(denied.id)
    assert.deepEqual([again.status, again.note, again.firstNote], ['failed', 'could not reach GitHub', 'permissionDenied: Bash'])
    const cell = agentCell(await prOf(106), baseConfig(), again, undefined)
    assert.deepEqual([cell.note, cell.firstNote], ['could not reach GitHub', 'permissionDenied: Bash'])
    // a third failure replaces the note again and leaves the original denial where it is
    await writeFile(file, JSON.stringify(failedByHand('gh pr review failed')))
    const third = await h.launcher.reread(denied.id)
    assert.deepEqual([third.note, third.firstNote], ['gh pr review failed', 'permissionDenied: Bash'])
    await writeFile(file, JSON.stringify(approvedByHand()))
    const done = await h.launcher.reread(denied.id)
    assert.deepEqual([done.status, done.resolvedByHand, done.note, done.firstNote], ['done', true, 'gh pr review failed', 'permissionDenied: Bash'])
    assert.equal(h.cache.getRun(denied.id)?.firstNote, 'permissionDenied: Bash')
    assert.equal(agentCell(await prOf(106), baseConfig(), done, undefined).firstNote, 'permissionDenied: Bash')
  } finally {
    await h.cleanup()
  }
})

test('a run that stopped to ask with no note, then failed twice and was finished by hand, does not tell its first failure as the original', async () => {
  const h = await harness()
  try {
    await h.report(106)
    const run = await h.launcher.start(request())
    const child = h.launch.children.at(-1)!
    await child.result(reviewResult({ status: 'needsInput', question: 'Fix the P1 now? (yes / no)' }))
    const asking = h.launcher.settled(run.id)
    child.exit(0)
    const waiting = await asking
    assert.deepEqual([waiting.status, waiting.note, waiting.firstNote], ['needsInput', null, null])
    const file = join(h.home, '.local', 'state', 'pit-view', 'runs', String(run.id), 'result.json')
    await writeFile(file, JSON.stringify(failedByHand('could not reach GitHub')))
    const first = await h.launcher.reread(run.id)
    // the replaced note was null, which firstNote records as an empty string so the next failure cannot take its place
    assert.deepEqual([first.status, first.note, first.firstNote], ['failed', 'could not reach GitHub', ''])
    await writeFile(file, JSON.stringify(failedByHand('gh pr review failed')))
    const second = await h.launcher.reread(run.id)
    assert.deepEqual([second.note, second.firstNote], ['gh pr review failed', ''])
    await writeFile(file, JSON.stringify(approvedByHand()))
    const done = await h.launcher.reread(run.id)
    assert.deepEqual([done.status, done.resolvedByHand, done.note, done.firstNote], ['done', true, 'gh pr review failed', ''])
    assert.equal(h.cache.getRun(run.id)?.firstNote, '')
    assert.equal(agentCell(await prOf(106), baseConfig(), done, undefined).firstNote, '')
  } finally {
    await h.cleanup()
  }
})

test('a re-read that finishes the run at once leaves firstNote empty, since its note is still the original', async () => {
  const h = await harness()
  try {
    const denied = await deniedRun(h)
    await writeFile(join(h.home, '.local', 'state', 'pit-view', 'runs', String(denied.id), 'result.json'), JSON.stringify(approvedByHand()))
    const done = await h.launcher.reread(denied.id)
    assert.deepEqual([done.note, done.firstNote], ['permissionDenied: Bash', null])
  } finally {
    await h.cleanup()
  }
})

test('a run that stopped to ask and was answered in Open session settles done after a re-read', async () => {
  const h = await harness()
  try {
    await h.report(106)
    const run = await h.launcher.start(request())
    const child = h.launch.children.at(-1)!
    await child.result(reviewResult({ status: 'needsInput', question: 'Post the approval? (yes / no)', posted: null, notPostedReason: 'awaitingAnswer' }))
    const settled = h.launcher.settled(run.id)
    child.exit(0)
    const waiting = await settled
    assert.deepEqual([waiting.status, waiting.note], ['needsInput', null])
    // nothing changed on disk: refused, row as it was
    await assert.rejects(h.launcher.reread(run.id), (error: unknown) => error instanceof LaunchError && error.code === 'rereadRefused' && /has not changed/.test(error.message))
    assert.deepEqual(h.cache.getRun(run.id), waiting)
    // the answered session finished and wrote a new result
    await writeFile(join(h.home, '.local', 'state', 'pit-view', 'runs', String(run.id), 'result.json'), JSON.stringify(approvedByHand()))
    const done = await h.launcher.reread(run.id)
    assert.deepEqual([done.status, done.note, done.resolvedByHand], ['done', null, true])
    assert.equal(agentCell(await prOf(106), baseConfig(), done, undefined).text, 'Approved · finished by hand')
    assert.equal(agentCell(await prOf(106), baseConfig(), done, undefined).question, null)
  } finally {
    await h.cleanup()
  }
})

test('a re-read accepts the same target written with its keys in another order', async () => {
  const h = await harness()
  try {
    const denied = await deniedRun(h)
    const file = join(h.home, '.local', 'state', 'pit-view', 'runs', String(denied.id), 'result.json')
    await writeFile(file, JSON.stringify(approvedByHand({ target: { pr: 106, repo: 'octo-example/orbit' } })))
    const run = await h.launcher.reread(denied.id)
    assert.deepEqual([run.status, run.resolvedByHand], ['done', true])
  } finally {
    await h.cleanup()
  }
})

test('a re-read keeps a valid failed result whose own error starts with a reserved failure word', async () => {
  const h = await harness()
  try {
    const denied = await deniedRun(h)
    const file = join(h.home, '.local', 'state', 'pit-view', 'runs', String(denied.id), 'result.json')
    await writeFile(file, JSON.stringify(reviewResult({ status: 'failed', error: 'noReport: the owner could not write the report', verdict: null, findings: [], posted: null })))
    const run = await h.launcher.reread(denied.id)
    assert.deepEqual([run.status, run.note, run.resolvedByHand], ['failed', 'noReport: the owner could not write the report', true])
  } finally {
    await h.cleanup()
  }
})

test('a re-read may name the PR that the original result had not worked out', async () => {
  const h = await harness()
  try {
    const denied = await deniedRun(h, reviewResult({ status: 'failed', error: 'could not find the PR', target: { repo: 'octo-example/orbit', pr: null }, verdict: null, findings: [], posted: null }))
    const file = join(h.home, '.local', 'state', 'pit-view', 'runs', String(denied.id), 'result.json')
    await writeFile(file, JSON.stringify(approvedByHand()))
    const run = await h.launcher.reread(denied.id)
    assert.deepEqual([run.status, run.resolvedByHand], ['done', true])
  } finally {
    await h.cleanup()
  }
})

test('a re-read that breaks a guard leaves the row as it was and says why: changed target, other command, other commit, missing report, bad file', async () => {
  const h = await harness()
  try {
    const denied = await deniedRun(h)
    const file = join(h.home, '.local', 'state', 'pit-view', 'runs', String(denied.id), 'result.json')
    const refused = async (text: string | null, message: RegExp): Promise<void> => {
      if (text === null) await rm(file)
      else await writeFile(file, text)
      await assert.rejects(h.launcher.reread(denied.id), (error: unknown) => error instanceof LaunchError && error.code === 'rereadRefused' && message.test(error.message), String(message))
      assert.deepEqual(h.cache.getRun(denied.id), denied)
    }
    await refused(null, /result\.json is missing/)
    await refused('{"schema":', /not valid JSON/)
    await refused(JSON.stringify(approvedByHand({ target: { repo: 'octo-example/orbit', pr: 107 } })), /targets #107, not #106/)
    await refused(JSON.stringify(approvedByHand({ target: { repo: 'octo-example/other', pr: 106 } })), /targets octo-example\/other/)
    await refused(JSON.stringify(approvedByHand({ target: null })), /no longer names its target/)
    await refused(JSON.stringify(approvedByHand({ target: {} })), /target must be null or an object with a repo/)
    await refused(JSON.stringify(approvedByHand({ target: { repo: 'octo-example/orbit', pr: null } })), /does not name #106/)
    await refused(JSON.stringify(approvedByHand({ target: { repo: 'octo-example/orbit' } })), /does not name #106/)
    await refused(JSON.stringify(approvedByHand({ target: { repo: 'octo-example/orbit', stack: [106], top: 106 } })), /target does not fit review-pr/)
    await refused(JSON.stringify(approvedByHand({ command: 'review-stack', target: { repo: 'octo-example/orbit', stack: null, top: 106 } })), /target must be null or an object with a repo/)
    await refused(JSON.stringify(approvedByHand({ target: { repo: 7, pr: 106 } })), /target must be null or an object with a repo/)
    await refused(JSON.stringify(approvedByHand({ command: 'review-stack', target: { repo: 'octo-example/orbit', stack: [106] } })), /ends with its top/)
    await refused(JSON.stringify(approvedByHand({ command: 'review-stack', target: { repo: 'octo-example/orbit', stack: [106], top: 107 } })), /ends with its top/)
    await refused(JSON.stringify(approvedByHand({ command: 'review-stack', target: { repo: 'octo-example/orbit', stack: [106, 107], top: 106 } })), /ends with its top/)
    await refused(JSON.stringify(approvedByHand({ command: 'review-stack', target: { repo: 'octo-example/orbit', stack: [106], top: 106 } })), /command review-stack, not review-pr/)
    await refused(JSON.stringify(approvedByHand({ reviewed: { kind: 'commit', sha: '0123456789abcdef0123456789abcdef01234567' } })), /reviewed commit/)
    await refused(JSON.stringify(approvedByHand({ reviewed: null })), /reviewed commit/)
    await refused(JSON.stringify({ ...fixResult(), target: { repo: 'octo-example/orbit', pr: 106, branch: 'x' } }), /schema pit-crew\/fix-result@1/)
    await refused(JSON.stringify(approvedByHand({ report: '~/agents/output/PR-999.md' })), /noReport: ~\/agents\/output\/PR-999\.md does not exist/)
    await refused(JSON.stringify(approvedByHand({ report: null })), /names no report/)
  } finally {
    await h.cleanup()
  }
})

test('a fix run is held to fixMismatch on a re-read, and a run that is running, has no session, or does not exist is not read', async () => {
  const h = await harness()
  try {
    const fix = request(101, { command: 'fix-pr', args: ['101'], label: 'Fix session' })
    const run = await h.launcher.start(fix)
    await assert.rejects(h.launcher.reread(run.id), (error: unknown) => error instanceof LaunchError && error.code === 'notRereadable' && /running/.test(error.message))
    const child = h.launch.children.at(-1)!
    await child.result(fixResult({ status: 'failed', error: 'push refused', pushed: null, notPushedReason: 'pushFailed', report: null }))
    const settled = h.launcher.settled(run.id)
    child.exit(0)
    const failed = await settled
    assert.equal(failed.status, 'failed')
    const file = join(h.home, '.local', 'state', 'pit-view', 'runs', String(run.id), 'result.json')
    await writeFile(file, JSON.stringify(fixResult({ report: '~/agents/output/PR-101.md' })))
    await assert.rejects(h.launcher.reread(run.id), (error: unknown) => error instanceof LaunchError && error.code === 'rereadRefused' && /badResult: report .* is not FIX-101\.md/.test(error.message))
    assert.deepEqual(h.cache.getRun(run.id), failed)
    await writeFile(join(h.home, 'agents', 'output', 'FIX-101.md'), 'Fix report\n')
    await writeFile(file, JSON.stringify(fixResult()))
    const resolved = await h.launcher.reread(run.id)
    assert.deepEqual([resolved.status, resolved.resolvedByHand], ['done', true])
    assert.equal(doneText(resolved, false), 'Fixed · pushed 2 commits · finished by hand')
    // a run with no resume command was never a session someone could have finished
    const bare = h.cache.updateRun((await h.launcher.start(request(110))).id, { status: 'failed', resume: null })
    await assert.rejects(h.launcher.reread(bare.id), (error: unknown) => error instanceof LaunchError && error.code === 'notRereadable' && /no session/.test(error.message))
    await assert.rejects(h.launcher.reread(9999), (error: unknown) => error instanceof LaunchError && error.code === 'unknownRun')
  } finally {
    await h.cleanup()
  }
})

test('a run settles only on the result of its own command and its own PR', async () => {
  const h = await harness()
  try {
    const wrongCommand = await h.launcher.start(request(101, { command: 'review-pr', args: ['101'], label: 'Re-review' }))
    const first = h.launch.children.at(-1)!
    await first.result(updateResult())
    const settledFirst = h.launcher.settled(wrongCommand.id)
    first.exit(0)
    const failedFirst = await settledFirst
    assert.equal(failedFirst.status, 'failed')
    assert.match(failedFirst.note ?? '', /result\.json is for command update-pr, not review-pr/)
    const otherPr = await h.launcher.start(request(102, { command: 'update-pr', args: ['102', `--head=${updateHead}`], label: 'Update branch' }))
    const second = h.launch.children.at(-1)!
    await second.result(updateResult())
    const settledSecond = h.launcher.settled(otherPr.id)
    second.exit(0)
    const failedSecond = await settledSecond
    assert.equal(failedSecond.status, 'failed')
    assert.match(failedSecond.note ?? '', /result\.json targets/)
  } finally {
    await h.cleanup()
  }
})

test('a review, fix, or update run does not settle on a sweep result left in its folder', async () => {
  const h = await harness()
  try {
    const run = await h.launcher.start(request(101, { command: 'review-pr', args: ['101'], label: 'Re-review' }))
    const child = h.launch.children.at(-1)!
    await child.result({ schema: 'pit-crew/sweep-result@1', command: 'review-dependabot-sweep', status: 'done', repo: 'octo-example/orbit', counts: { swept: 0, fresh: 0, reused: 0, failed: 0 }, notPostedReason: null, rows: [], mergeOrder: [], summary: null, question: null, error: null })
    const settled = h.launcher.settled(run.id)
    child.exit(0)
    const failed = await settled
    assert.equal(failed.status, 'failed')
    assert.match(failed.note ?? '', /sweep result, not the result of a run/)
  } finally {
    await h.cleanup()
  }
})

test('an update re-read keeps the base the run first named', async () => {
  const h = await harness()
  try {
    const run = await h.launcher.start(request(101, { command: 'update-pr', args: ['101', `--head=${updateHead}`], label: 'Update branch' }))
    const child = h.launch.children.at(-1)!
    await child.result(updateResult({ status: 'needsInput', question: 'Checks failed; push anyway? (yes / no)', pushed: null, notPushedReason: 'awaitingAnswer', worktree: '~/agents/worktrees/orbit-update-101-x' }))
    const settled = h.launcher.settled(run.id)
    child.exit(0)
    const waiting = await settled
    const file = join(h.home, '.local', 'state', 'pit-view', 'runs', String(run.id), 'result.json')
    await writeFile(file, JSON.stringify(updateResult({ target: { repo: 'octo-example/orbit', pr: 101, branch: 'fix/webhook-retry', base: 'develop' } })))
    await assert.rejects(h.launcher.reread(run.id), (error: unknown) => error instanceof LaunchError && error.code === 'rereadRefused')
    assert.deepEqual(h.cache.getRun(run.id), waiting)
  } finally {
    await h.cleanup()
  }
})

test('an Update session that stopped to ask is read again against the update schema and updateMismatch, and reads as its method finished by hand', async () => {
  const h = await harness()
  try {
    const run = await h.launcher.start(request(101, { command: 'update-pr', args: ['101', `--head=${updateHead}`], label: 'Update branch' }))
    const child = h.launch.children.at(-1)!
    await child.result(updateResult({ status: 'needsInput', question: 'Checks failed; push anyway? (yes / no)', pushed: null, notPushedReason: 'awaitingAnswer', worktree: '~/agents/worktrees/orbit-update-101-x' }))
    const settled = h.launcher.settled(run.id)
    child.exit(0)
    const waiting = await settled
    assert.equal(waiting.status, 'needsInput')
    const file = join(h.home, '.local', 'state', 'pit-view', 'runs', String(run.id), 'result.json')
    // a review result is not this run's kind, and an update that contradicts itself fails its guard: the row stays as it was
    await writeFile(file, JSON.stringify(reviewResult({ target: { repo: 'octo-example/orbit', pr: 101 } })))
    await assert.rejects(h.launcher.reread(run.id), (error: unknown) => error instanceof LaunchError && error.code === 'rereadRefused' && /schema pit-crew\/review-result@1, but this run's result has schema pit-crew\/update-result@1/.test(error.message))
    await writeFile(file, JSON.stringify(updateResult({ method: 'merge' })))
    await assert.rejects(h.launcher.reread(run.id), (error: unknown) => error instanceof LaunchError && error.code === 'rereadRefused' && /badResult/.test(error.message))
    assert.deepEqual(h.cache.getRun(run.id), waiting)
    // the owner answered in Open session and the session pushed the rebase
    await writeFile(file, JSON.stringify(updateResult()))
    const done = await h.launcher.reread(run.id)
    assert.deepEqual([done.status, done.resolvedByHand], ['done', true])
    assert.equal(doneText(done, false), 'Rebased onto main · finished by hand')
  } finally {
    await h.cleanup()
  }
})

test('the done text adds the finished-by-hand note only to a done run, and a run that failed again shows its new failure', () => {
  const clean = reviewResult({ verdict: 'clean', findings: [], posted: null, notPostedReason: 'noPost' }) as unknown as RunResultJson
  assert.equal(doneText({ status: 'done', result: clean, note: 'permissionDenied: Bash', resolvedByHand: true }, false), 'Clean · finished by hand')
  assert.equal(doneText({ status: 'done', result: clean, note: null, resolvedByHand: false }, false), 'Clean')
  assert.equal(doneText({ status: 'failed', result: clean, note: 'ghFailed', resolvedByHand: true }, false), 'Failed')
  assert.equal(doneText({ status: 'needsInput', result: clean, note: null, resolvedByHand: true }, false), 'Needs your answer')
})

// the review button says when the review would wait (section 8 of DESIGN.md, Agent cell)

const roomFor = { review: false, selfReview: false }
const noRoom = { review: true, selfReview: true }

test('the default button reads as before with room, and says queue at the cap; a self-review the overage admits keeps the plain label', async () => {
  const config = baseConfig()
  const labels = async (number: number, queueing: { review: boolean, selfReview: boolean } | null) => {
    const cell = agentCell(await prOf(number), config, undefined, undefined, null, queueing)
    return [cell.action.label, cell.label, cell.starts[0]!.button, cell.starts[0]!.label]
  }
  assert.deepEqual(await labels(106, roomFor), ['Re-review', 'Re-review', 'Re-review PR', 'Re-review'])
  assert.deepEqual(await labels(106, null), ['Re-review', 'Re-review', 'Re-review PR', 'Re-review'])
  // the run's own label does not change, only the text of the buttons that start it
  assert.deepEqual(await labels(106, noRoom), ['Queue re-review', 'Re-review', 'Queue re-review PR', 'Re-review'])
  assert.deepEqual(await labels(101, noRoom), ['Queue self-review', 'Self-review', 'Queue self-review', 'Self-review'])
  // a self-review the setting lets in starts at once, so its plain label stays while a review of another's PR queues
  assert.deepEqual(await labels(101, { review: true, selfReview: false }), ['Self-review', 'Self-review', 'Self-review', 'Self-review'])
  assert.deepEqual(await labels(106, { review: true, selfReview: false }), ['Queue re-review', 'Re-review', 'Queue re-review PR', 'Re-review'])
})

test('the tandem and stack buttons say queue at the cap, and the fix button never does', async () => {
  const config = baseConfig()
  const mine = agentCell(await prOf(101), config, undefined, undefined, null, noRoom)
  const buttons = (cell: ReturnType<typeof agentCell>) => Object.fromEntries(cell.starts.map((option) => [option.kind, option.button]))
  assert.equal(buttons(mine).tandem, 'Queue self-review in tandem')
  assert.equal(buttons(mine).fix, 'Fix requested changes')
  const stacked = agentCell(await prOf(106), config, undefined, undefined, { position: 2, size: 3 }, noRoom)
  assert.equal(buttons(stacked).stack, 'Queue review stack')
  assert.equal(buttons(stacked).tandem, 'Queue re-review in tandem')
})

test('the launcher answers what a new review would do the way a start does, with room, at the cap, and with the overage', async () => {
  for (const over of [false, true]) {
    const h = await harness({ config: { maxConcurrentReviews: 1, selfReviewOverCap: over } })
    try {
      h.cache.writePr(scenario.repo, await prOf(101), scenario.defaultBranch)
      assert.deepEqual(h.launcher.queueing(), roomFor)
      // at the cap: the answer is what the next start does
      const running = await h.launcher.start(request(106))
      assert.equal(running.status, 'running')
      assert.deepEqual(h.launcher.queueing(), { review: true, selfReview: !over })
      const self = await h.launcher.start(selfRequest(101))
      assert.equal(self.status, over ? 'running' : 'queued', `self-review with overage ${over}`)
      const other = await h.launcher.start(request(113, { label: 'Review' }))
      assert.equal(other.status, 'queued')
      // a review waiting in the queue holds everything behind it, whatever the count
      assert.deepEqual(h.launcher.queueing().review, true)
    } finally {
      await h.cleanup()
    }
  }
})

test('the launcher\'s answer follows a review finishing and a saved cap', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  try {
    const running = await h.launcher.start(request(106))
    assert.deepEqual(h.launcher.queueing(), noRoom)
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 2 }
    assert.deepEqual(h.launcher.queueing(), roomFor)
    h.settings.current = { ...h.settings.current, maxConcurrentReviews: 1 }
    assert.deepEqual(h.launcher.queueing(), noRoom)
    h.launch.children[0]!.exit(1)
    await h.launcher.settled(running.id)
    assert.deepEqual(h.launcher.queueing(), roomFor)
  } finally {
    await h.cleanup()
  }
})

test('every open row\'s buttons follow the cap as reviews start and finish and as the cap is saved, in the patches', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 2 } })
  const patches: Patch[] = []
  let launcher: ReturnType<typeof h.make> | null = null
  const poller = createPoller({
    cache: h.cache,
    gh: createGh(h.gh.runner),
    clock: h.time.clock,
    timers: h.time.timers,
    config: () => h.settings.current,
    home: '/nonexistent/pit-view-test-home',
    timeZone: scenario.timeZone,
    emit: (patch) => patches.push(patch),
    pageSize: scenario.pageSize,
    queueing: () => launcher!.queueing(),
  })
  launcher = h.make((run) => poller.runChanged(run.repo, run.number), () => poller.queueingChanged())
  const buttonOf = async (number: number): Promise<string | undefined> => {
    const row = (await poller.view()).others.groups.flatMap((group) => group.rows).find((entry) => entry.number === number)
    return row?.agent?.action.label
  }
  const latest = (number: number): string | undefined => {
    for (const patch of [...patches].reverse()) {
      const row = patch.rows.find((entry: OpenRow) => entry.number === number)
      if (row !== undefined) return row.agent?.action.label
    }
    return undefined
  }
  try {
    poller.refresh('manual')
    await poller.idle()
    assert.equal(await buttonOf(113), 'Review')
    const first = await launcher.start(request(106))
    // one of two: room remains, so no other row's patch is needed
    assert.equal(await buttonOf(113), 'Review')
    await launcher.start(request(118, { label: 'Review' }))
    await launcher.flushed()
    // at the cap: the patch that announced the second review carries the other rows with the queue wording
    assert.equal(latest(113), 'Queue review')
    assert.equal(await buttonOf(113), 'Queue review')
    // the cap saved higher: the same rows go back, with no reload
    const before = h.settings.current
    h.settings.current = { ...before, maxConcurrentReviews: 3 }
    await poller.configChanged(before)
    await launcher.flushed()
    assert.equal(latest(113), 'Review')
    const lowered = h.settings.current
    h.settings.current = { ...lowered, maxConcurrentReviews: 2 }
    await poller.configChanged(lowered)
    assert.equal(latest(113), 'Queue review')
    // a review finishing frees a slot
    h.launch.children[0]!.exit(1)
    await launcher.settled(first.id)
    await launcher.flushed()
    assert.equal(latest(113), 'Review')
  } finally {
    launcher.close()
    poller.stop()
    await h.cleanup()
  }
})

test('a page loaded while a config save is rescanning does not stop the open pages getting the rows the saved cap changes', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 2 } })
  const patches: Patch[] = []
  let launcher: ReturnType<typeof h.make> | null = null
  const poller = createPoller({
    cache: h.cache,
    gh: createGh(h.gh.runner),
    clock: h.time.clock,
    timers: h.time.timers,
    config: () => h.settings.current,
    home: '/nonexistent/pit-view-test-home',
    timeZone: scenario.timeZone,
    emit: (patch) => patches.push(patch),
    pageSize: scenario.pageSize,
    queueing: () => launcher!.queueing(),
  })
  launcher = h.make((run) => poller.runChanged(run.repo, run.number), () => poller.queueingChanged())
  const latest = (number: number): string | undefined => {
    for (const patch of [...patches].reverse()) {
      const row = patch.rows.find((entry: OpenRow) => entry.number === number)
      if (row !== undefined) return row.agent?.action.label
    }
    return undefined
  }
  try {
    poller.refresh('manual')
    await poller.idle()
    await poller.view()
    await launcher.start(request(106))
    await launcher.start(request(118, { label: 'Review' }))
    await launcher.flushed()
    // the open pages hold the queue wording
    assert.equal(latest(113), 'Queue review')
    // a save that raises the cap and moves the reports directory yields during the rescan
    const before = h.settings.current
    h.settings.current = { ...before, maxConcurrentReviews: 3, reportsDir: join(h.home, 'other-reports') }
    const saving = poller.configChanged(before)
    // a fresh page loads in the middle, and reads the new answer
    const loaded = await poller.view()
    assert.equal(loaded.others.groups.flatMap((group) => group.rows).find((entry) => entry.number === 113)?.agent?.action.label, 'Review')
    await saving
    // the pages that were already open still get the row
    assert.equal(latest(113), 'Review')
  } finally {
    launcher.close()
    poller.stop()
    await h.cleanup()
  }
})

// pages as the browser keeps them: the view it loaded, then every later patch applied in order
const pageRig = async (config: Partial<Config>, fails: (id: number, changes: RunChanges) => boolean = () => false) => {
  const h = await harness({ config })
  // while set, every read of the reports folder waits for it, so a test decides when a config save's rescan finishes
  const gate: { hold: Promise<void> | null } = { hold: null }
  const patches: Patch[] = []
  let launcher: ReturnType<typeof h.make> | null = null
  const poller = createPoller({
    cache: h.cache,
    gh: createGh(h.gh.runner),
    clock: h.time.clock,
    timers: h.time.timers,
    config: () => h.settings.current,
    home: '/nonexistent/pit-view-test-home',
    timeZone: scenario.timeZone,
    emit: (patch) => patches.push(patch),
    pageSize: scenario.pageSize,
    queueing: () => launcher!.queueing(),
    scan: async (dir, targets) => {
      if (gate.hold !== null) await gate.hold
      return scanReports(dir, targets)
    },
  })
  // writes to the runs the test names throw, as an unwritable database's would; the store reads updateRun when the launcher is made
  const updateRun = h.cache.updateRun
  h.cache.updateRun = (id, changes) => {
    if (fails(id, changes)) throw new Error('attempt to write a readonly database')
    return updateRun(id, changes)
  }
  launcher = h.make((run) => poller.runChanged(run.repo, run.number), () => poller.queueingChanged())
  h.cache.updateRun = updateRun
  const labelsOf = (view: { mine: { groups: { rows: OpenRow[] }[] }, others: { groups: { rows: OpenRow[] }[] } }): Map<number, string | undefined> =>
    new Map([...view.mine.groups, ...view.others.groups].flatMap((group) => group.rows).map((row) => [row.number, row.agent?.action.label]))
  const load = async () => {
    const view = await poller.view()
    const labels = labelsOf(view)
    const from = view.version
    return {
      labels: (): Map<number, string | undefined> => {
        const shown = new Map(labels)
        for (const patch of patches.filter((entry) => entry.version > from)) {
          for (const row of patch.rows) if (shown.has(row.number)) shown.set(row.number, row.agent?.action.label)
          for (const number of patch.removed) shown.delete(number)
        }
        return shown
      },
    }
  }
  return { h, patches, poller, launcher: launcher, load, labelsOf, gate }
}

test('a cap saved with a new reports directory, a page loaded during the rescan, and a third review before the save resumes leave every page with the queue wording', async () => {
  const r = await pageRig({ maxConcurrentReviews: 2 })
  try {
    r.poller.refresh('manual')
    await r.poller.idle()
    const open = await r.load()
    await r.launcher.start(request(106))
    await r.launcher.start(request(118, { label: 'Review' }))
    await r.launcher.flushed()
    assert.equal(open.labels().get(113), 'Queue review')
    const before = r.h.settings.current
    r.h.settings.current = { ...before, maxConcurrentReviews: 3, reportsDir: join(r.h.home, 'other-reports') }
    // the save's rescan waits on a promise this test resolves, so the order below is the order that happens
    let release: () => void = () => {}
    r.gate.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    let saved = false
    const saving = r.poller.configChanged(before).then(() => {
      saved = true
    })
    const mid = await r.load()
    assert.equal(mid.labels().get(113), 'Review')
    // a third review fills the raised cap while the save is still waiting on its rescan
    await r.launcher.start(request(113, { label: 'Review' }))
    assert.equal(saved, false, 'the third review started before the save resumed')
    release()
    await saving
    assert.equal(saved, true)
    await r.launcher.flushed()
    assert.equal(r.launcher.queueing().review, true)
    const fresh = r.labelsOf(await r.poller.view())
    for (const page of [open, mid]) {
      for (const [number, label] of fresh) assert.equal(page.labels().get(number), label, `row ${number}`)
    }
    assert.ok([...mid.labels().values()].some((label) => label?.startsWith('Queue')))
    // the last patch each page received that carries a row says what the launcher says now
    const last = r.patches.at(-1)!
    assert.ok(last.rows.length > 0)
    assert.ok(last.rows.every((row) => row.agent === null || row.agent === undefined || row.agent.action.label === fresh.get(row.number)))
  } finally {
    r.launcher.close()
    r.poller.stop()
    await r.h.cleanup()
  }
})

test('after any sequence of review starts, endings, cap saves that yield, and page loads, every page reads the launcher\'s current answer on every row', async () => {
  const seeds = 24
  for (let seed = 1; seed <= seeds; seed++) {
    let state = seed * 2654435761 % 4294967296
    const next = (n: number): number => {
      state = (state * 1664525 + 1013904223) % 4294967296
      return Math.floor(state / 4294967296 * n)
    }
    const r = await pageRig({ maxConcurrentReviews: 2 })
    try {
      r.poller.refresh('manual')
      await r.poller.idle()
      const pages = [await r.load()]
      const saves: Promise<void>[] = []
      const numbers = [106, 118, 113, 116]
      let reports = 0
      for (let step = 0; step < 10; step++) {
        const op = next(4)
        if (op === 0) {
          await r.launcher.start(request(numbers[next(numbers.length)]!, { label: 'Review' })).catch(() => undefined)
        } else if (op === 1) {
          const child = r.h.launch.children.filter((entry) => entry.pid !== undefined)[next(Math.max(1, r.h.launch.children.length))]
          child?.exit(1)
          await Promise.resolve()
        } else if (op === 2) {
          const before = r.h.settings.current
          reports += 1
          r.h.settings.current = { ...before, maxConcurrentReviews: 1 + next(3), reportsDir: join(r.h.home, `reports-${reports}`) }
          saves.push(r.poller.configChanged(before))
        } else if (pages.length < 3) {
          pages.push(await r.load())
        }
      }
      await Promise.all(saves)
      await r.poller.idle()
      for (let spin = 0; spin < 5; spin++) await new Promise((resolve) => setImmediate(resolve))
      await r.launcher.flushed()
      const fresh = r.labelsOf(await r.poller.view())
      for (const [index, page] of pages.entries()) {
        for (const [number, label] of fresh) assert.equal(page.labels().get(number), label, `seed ${seed} page ${index} row ${number}`)
      }
    } finally {
      r.launcher.close()
      r.poller.stop()
      await r.h.cleanup()
    }
  }
})

test('the buttons settle once a review has finished launching, though the review count is below the cap', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 3 } })
  const patches: Patch[] = []
  let launcher: ReturnType<typeof h.make> | null = null
  const poller = createPoller({
    cache: h.cache,
    gh: createGh(h.gh.runner),
    clock: h.time.clock,
    timers: h.time.timers,
    config: () => h.settings.current,
    home: '/nonexistent/pit-view-test-home',
    timeZone: scenario.timeZone,
    emit: (patch) => patches.push(patch),
    pageSize: scenario.pageSize,
    queueing: () => launcher!.queueing(),
  })
  launcher = h.make((run) => poller.runChanged(run.repo, run.number), () => poller.queueingChanged())
  const latest = (number: number): string | undefined => {
    for (const patch of [...patches].reverse()) {
      const row = patch.rows.find((entry: OpenRow) => entry.number === number)
      if (row !== undefined) return row.agent?.action.label
    }
    return undefined
  }
  try {
    poller.refresh('manual')
    await poller.idle()
    await launcher.start(request(106))
    await launcher.start(request(118, { label: 'Review' }))
    await launcher.flushed()
    // two of three are running and none is being launched: the answer is room, and the pages were told so
    assert.deepEqual(launcher.queueing(), roomFor)
    assert.equal(latest(113), 'Review')
  } finally {
    launcher.close()
    poller.stop()
    await h.cleanup()
  }
})

test('a change of the queue answer, whichever repository the run is in, patches the rows of the repository on show', async () => {
  const h = await harness()
  const patches: Patch[] = []
  let answer = roomFor
  const poller = createPoller({
    cache: h.cache,
    gh: createGh(h.gh.runner),
    clock: h.time.clock,
    timers: h.time.timers,
    config: () => h.settings.current,
    home: '/nonexistent/pit-view-test-home',
    timeZone: scenario.timeZone,
    emit: (patch) => patches.push(patch),
    pageSize: scenario.pageSize,
    queueing: () => answer,
  })
  const latest = (number: number): string | undefined => {
    for (const patch of [...patches].reverse()) {
      const row = patch.rows.find((entry: OpenRow) => entry.number === number)
      if (row !== undefined) return row.agent?.action.label
    }
    return undefined
  }
  try {
    poller.refresh('manual')
    await poller.idle()
    await poller.view()
    answer = noRoom
    poller.queueingChanged()
    assert.equal(latest(113), 'Queue review')
    answer = roomFor
    poller.queueingChanged()
    assert.equal(latest(113), 'Review')
  } finally {
    poller.stop()
    await h.cleanup()
  }
})

test('the launcher announces whenever the answer may have changed, whatever moved it', async () => {
  const announced: unknown[] = []
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  let launcher: ReturnType<typeof h.make> | null = null
  launcher = h.make(undefined, () => announced.push(launcher!.queueing()))
  try {
    const first = await launcher.start(request(106))
    await launcher.flushed()
    assert.deepEqual(announced.at(-1), noRoom)
    const before = announced.length
    h.launch.children[0]!.exit(1)
    await launcher.settled(first.id)
    await launcher.flushed()
    assert.deepEqual(announced.at(-1), roomFor)
    assert.ok(announced.length > before)
  } finally {
    launcher.close()
    await h.cleanup()
  }
})

test('a blocked queue read again and again sends no more patches however long it is, and an ordinary run change sends one', async () => {
  const sent: number[] = []
  for (const queued of [2, 12]) {
    const r = await pageRig({ maxConcurrentReviews: 1 })
    try {
      r.poller.refresh('manual')
      await r.poller.idle()
      await r.load()
      await r.launcher.start(request(106))
      for (let index = 0; index < queued; index++) {
        const waiting = await r.launcher.start(request(200 + index, { label: 'Review' }))
        assert.equal(waiting.status, 'queued')
      }
      await r.launcher.flushed()
      // five readings of a queue that stays blocked, with nothing awaited between them
      const from = r.patches.length
      for (let reading = 0; reading < 5; reading++) r.launcher.drain()
      await r.launcher.flushed()
      const reread = r.patches.length - from
      assert.ok(reread <= 1, `${queued} queued: ${reread} patches for five readings`)
      sent.push(reread)
      // a step of the running review is one run change: one patch, with every open row
      const child = r.h.launch.children[0]!
      await child.events(step('resolveBase', 'started', '2026-10-26T14:06:00Z'))
      const beforeStep = r.patches.length
      await r.launcher.check()
      await r.launcher.flushed()
      assert.equal(r.patches.length - beforeStep, 1, `${queued} queued: patches for one step`)
      assert.ok(r.patches.at(-1)!.rows.length > 0)
    } finally {
      r.launcher.close()
      r.poller.stop()
      await r.h.cleanup()
    }
  }
  assert.equal(sent[0], sent[1], 'the patches do not grow with the length of the queue')
})

test('a burst of changes in one turn is announced once, and a blocked queue marks nothing', async () => {
  const h = await harness({ config: { maxConcurrentReviews: 1 } })
  let announced = 0
  const launcher = h.make(undefined, () => {
    announced += 1
  })
  try {
    await launcher.start(request(106))
    for (let index = 0; index < 6; index++) await launcher.start(request(200 + index, { label: 'Review' }))
    await launcher.flushed()
    const before = announced
    for (let reading = 0; reading < 5; reading++) launcher.drain()
    await launcher.flushed()
    assert.equal(announced, before, 'readings that change nothing announce nothing')
    // finishing the review releases the slot, starts the next, and moves the queue: many marks, one announcement per turn
    h.launch.children[0]!.exit(1)
    await launcher.settled(1)
    await launcher.flushed()
    assert.ok(announced > before)
    const after = announced
    await launcher.flushed()
    assert.equal(announced, after)
  } finally {
    launcher.close()
    await h.cleanup()
  }
})

test('a review whose two settlement writes both fail still frees its slot, and the open pages get the plain label with no other event', async () => {
  let broken = false
  const r = await pageRig({ maxConcurrentReviews: 1 }, (_, changes) => broken && changes.status !== undefined && changes.status !== 'running')
  try {
    r.poller.refresh('manual')
    await r.poller.idle()
    const open = await r.load()
    const running = await r.launcher.start(request(106))
    await r.launcher.flushed()
    assert.equal(open.labels().get(113), 'Queue review')
    broken = true
    r.h.launch.children[0]!.exit(1)
    const ended = await within(r.launcher.settled(running.id))
    // its row could not be written, so it still reads running, while the launcher has released its slot
    assert.equal(r.h.cache.getRun(running.id)?.status, 'running')
    assert.deepEqual(r.launcher.queueing(), roomFor)
    await r.launcher.flushed()
    assert.equal(ended.id, running.id)
    assert.equal(open.labels().get(113), 'Review')
  } finally {
    r.launcher.close()
    r.poller.stop()
    await r.h.cleanup()
  }
})
