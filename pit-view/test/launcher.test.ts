// test/launcher.test.ts
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { openCache } from '../src/cache.ts'
import type { Run } from '../src/cache.ts'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import type { OpenRow } from '../src/derive.ts'
import { createGh } from '../src/github.ts'
import type { RawOpenPr } from '../src/github.ts'
import {
  agentCell, childEnv, claudeInvocation, codexInvocation, codexNote, createLauncher, defaultRun, descendantGroups, doneText, emptyStream,
  emptySteps, foldStream, foldSteps, isHttpUrl, isTandemRun, judge, LaunchError, notOffered, parsePs, parseResult, parseStepEvent, remoteNamesRepo,
  requestText, runners, runView, shellPath, startOptions, stepsOf,
} from '../src/launcher.ts'
import type { LaunchSpec, RunResultJson, StartRequest, StepEvent } from '../src/launcher.ts'
import { createPoller } from '../src/poller.ts'
import type { Patch } from '../src/poller.ts'
import { scenario } from './fixtures/scenario.ts'
import { fakeLaunch, fakeRemotes, fakeRunner, fakeTime, fixtureRunner, ok, openPage1, openPage2, reviewResult, tempDir } from './helpers.ts'
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
  result: null, note: null, costUsd: null, resume: 'cd ~/dev/orbit && claude --resume sess-1', ...patch,
})

const spec = (patch: Partial<LaunchSpec> = {}): LaunchSpec => ({
  command: 'review-pr', args: ['106'], cwd: '/home/tester/dev/orbit', runDir: '/home/tester/.local/state/pit-view/runs/3', home: '/home/tester',
  sessionId: '6f1c1f9e-0000-4000-8000-000000000003', reportsDir: '/Volumes/Data/agents/output', worktreesDir: '/Volumes/Data/agents/worktrees', ...patch,
})

// command lines

test('Claude starts exactly as Launching runs pins it, with the request as one stream-json user message', () => {
  const invocation = claudeInvocation(spec())
  assert.equal(invocation.command, 'claude')
  assert.deepEqual(invocation.args, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--session-id', '6f1c1f9e-0000-4000-8000-000000000003', '--permission-mode', 'auto', '--add-dir', '/home/tester/agents',
  ])
  assert.ok(invocation.stdin?.endsWith('\n'))
  assert.deepEqual(JSON.parse(invocation.stdin ?? ''), {
    type: 'user',
    message: { role: 'user', content: '/review-pr 106 --emit-json=/home/tester/.local/state/pit-view/runs/3' },
  })
  // never --bare or --safe-mode, which drop the sign-in or the installed commands
  assert.ok(!invocation.args.some((arg) => arg === '--bare' || arg === '--safe-mode'))
})

test('Codex starts exactly as Launching runs pins it: a $ skill, the sandbox, the resolved folders and the note', () => {
  const runDir = '/home/tester/.local/state/pit-view/runs/3'
  const base = [
    '-C', '/home/tester/dev/orbit', '-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true',
    '--add-dir', '/home/tester/dev/orbit/.git', '--add-dir', '/Volumes/Data/agents/output', '--add-dir', '/Volumes/Data/agents/worktrees',
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

test('a request is the command, its arguments and --emit-json, with / for Claude and $ for Codex', () => {
  assert.equal(requestText('/', 'review-dependabot', ['114'], '/r/1'), '/review-dependabot 114 --emit-json=/r/1')
  assert.equal(requestText('$', 'review-pr', ['101', '--no-post'], '/r/2'), '$review-pr 101 --no-post --emit-json=/r/2')
})

test('the resume command starts in the run\'s folder; Codex\'s carries its model and sandbox again', () => {
  assert.equal(runners.claude.resume('~/dev/orbit', 'sess-1', spec(), '/home/tester'), 'cd ~/dev/orbit && claude --resume sess-1')
  assert.equal(
    runners.codex.resume('~/dev/orbit', 'th-9', spec({ codexModel: 'gpt-6.1-terra', reportsDir: '/home/tester/agents/output', worktreesDir: '/home/tester/agents/worktrees' }), '/home/tester'),
    'cd ~/dev/orbit && codex resume th-9 -m gpt-6.1-terra -s workspace-write -c sandbox_workspace_write.network_access=true --add-dir ~/dev/orbit/.git --add-dir ~/agents/output --add-dir ~/agents/worktrees',
  )
  // a folder with a space is quoted, ~ left bare
  assert.equal(shellPath('~/dev/my orbit'), `~/'dev/my orbit'`)
  assert.equal(shellPath(`/tmp/it's`), `'/tmp/it'\\''s'`)
})

test('the child environment is built from scratch: home, user, shell, language, temp and PATH only', () => {
  const env = childEnv({
    PATH: '/opt/bin:/usr/bin', USER: 'tester', LOGNAME: 'tester', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', TMPDIR: '/tmp/x/',
    HOME: '/elsewhere', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'desktop', ANTHROPIC_API_KEY: 'sk-fake', GH_TOKEN: 'gho_fake', EMPTY: '',
  }, '/home/tester')
  assert.deepEqual(env, { HOME: '/home/tester', USER: 'tester', LOGNAME: 'tester', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', TMPDIR: '/tmp/x/', PATH: '/opt/bin:/usr/bin' })
  assert.deepEqual(childEnv({ LANG: '' }, '/home/tester'), { HOME: '/home/tester' })
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
  const config = { ...baseConfig(), agent: { runner: 'codex' as const } }
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
  assert.deepEqual(ownDraft.result, { verdict: 'clean', recommendation: null, findings: 0, ci: 'green', posted: null, notPostedReason: 'noPost', report: '~/agents/output/PR-106.md' })
  const notDraft = agentCell(await prOf(104), config, runRow({ number: 104, status: 'done', result: cleanAt((await prOf(104)).headRefOid) }), undefined)
  assert.equal(notDraft.text, 'Clean')
  // the head moved past the reviewed commit: the next move is the idle action again
  const moved = agentCell(await prOf(106), config, runRow({ status: 'done', result: reviewResult({ reviewed: { kind: 'commit', sha: '0123456789abcdef0123456789abcdef01234567' } }) as unknown as RunResultJson }), undefined)
  assert.equal(moved.state, 'idle')
  assert.equal(moved.label, 'Re-review')
  assert.equal(moved.runId, 7)
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
  // the viewer's own PR never posts, tandem or not
  assert.deepEqual(summary(await options(104)), [
    ['default', 'Self-review', 'Self-review', 'review-pr', ['104', '--no-post']],
    ['tandem', 'Tandem self-review', 'Self-review in tandem', 'review-pr', ['104', '--tandem', '--no-post']],
  ])
  // review-dependabot has no tandem mode; Renovate's PRs are ordinary reviews and do
  assert.deepEqual(summary(await options(114)), [['default', 'Review', 'Review PR', 'review-dependabot', ['114']]])
  assert.deepEqual((await options(115)).map((option) => option.kind), ['default', 'tandem'])
  // nothing offered is ever review-local, a fix, or an unflagged review of the viewer's own PR
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
  assert.deepEqual(await posts(104), { default: [['claude', 'codex'], nothing], tandem: [['claude'], nothing], stack: [['claude', 'codex'], stack] })
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
  const settings = { current: { ...baseConfig(), ...config } }
  const stateDir = join(home, '.local', 'state', 'pit-view')
  const make = (onChange: (run: Run) => void = (run) => changes.push(run)) => createLauncher({
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
    onChange,
  })
  const launcher = make()
  const report = (number: number): Promise<void> => writeFile(join(home, 'agents', 'output', `PR-${number}.md`), 'Reviewed commit: `x` @ `f00dfac`\n')
  const cleanup = async (): Promise<void> => {
    launcher.close()
    cache.close()
    await temp.cleanup()
  }
  return { home, time, cache, launcher, make, changes, settings, stateDir, launch, gh, report, cleanup }
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
    assert.deepEqual(child.request.env, { HOME: h.home, USER: 'tester', LANG: 'en_US.UTF-8', PATH: '/usr/bin:/bin' })
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
  const h = await harness({ config: { agent: { runner: 'codex' } } })
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
    // another PR may start meanwhile: there is no overall cap
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
  const h = await harness({ config: { agent: { runner: 'codex', codexModel: 'gpt-6.1-terra' } } })
  try {
    const run = await h.launcher.start(request(104, { args: ['104', '--no-post'], label: 'Self-review' }))
    const runDir = join(h.stateDir, 'runs', String(run.id))
    const child = h.launch.children[0]!
    const cwd = join(h.home, 'dev', 'orbit')
    assert.equal(child.request.command, 'codex')
    assert.deepEqual(child.request.args, codexInvocation({
      command: 'review-pr', args: ['104', '--no-post'], cwd, runDir, home: h.home, sessionId: null, codexModel: 'gpt-6.1-terra',
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
    assert.equal(stored.resume, 'cd ~/dev/orbit && codex resume th-104 -m gpt-6.1-terra -s workspace-write -c sandbox_workspace_write.network_access=true --add-dir ~/dev/orbit/.git --add-dir ~/agents/output --add-dir ~/agents/worktrees')
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
  const h = await harness()
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
    await again.recover()
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
    launch.spawnError = null
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
  const launcher = h.make((run) => poller.runChanged(run.repo, run.number))
  try {
    poller.refresh('manual')
    await poller.idle()
    const before = (await poller.view()).others.groups.flatMap((group) => group.rows).find((row) => row.number === 106)!
    assert.equal(before.agent?.state, 'idle')
    assert.equal(before.agent?.label, 'Re-review')
    const from = patches.length
    const run = await launcher.start(request())
    const child = h.launch.children[0]!
    await child.events(step('resolveBase', 'started', '2026-10-26T14:06:00Z'))
    await launcher.check()
    await h.report(106)
    await child.result(reviewResult({ reviewed: { kind: 'commit', sha: (await prOf(106)).headRefOid } }))
    const settled = launcher.settled(run.id)
    child.exit(0)
    await settled
    const runPatches = patches.slice(from)
    assert.deepEqual(runPatches.map((patch) => patch.version), [from + 1, from + 2, from + 3])
    const cells = runPatches.map((patch) => {
      assert.deepEqual(patch.rows.map((row: OpenRow) => row.number), [106])
      assert.equal(patch.tiles, undefined)
      return patch.rows[0]!.agent!
    })
    assert.deepEqual(cells.map((cell) => [cell.state, cell.step?.name ?? null, cell.text]), [
      ['running', null, null], ['running', 'resolveBase', null], ['done', 'resolveBase', 'Changes requested'],
    ])
    assert.equal(cells[0]!.runId, run.id)
    assert.equal(cells[2]!.finishedAt, '2026-10-26T14:05:38Z')
    // a run in another repo never patches this one
    poller.runChanged('octo-example/other', 106)
    assert.equal(patches.length, from + 3)
  } finally {
    launcher.close()
    poller.stop()
    await h.cleanup()
  }
})
