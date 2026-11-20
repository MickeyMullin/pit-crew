// test/sweeppost.test.ts
// the post button on a scheduled Dependabot sweep's rows (section 10 of DESIGN.md, Posting): the offer a row of a sweep that ran with --no-post gets, derived by one function for the page and for the server at click time, the record that proves the stored report is the one the reviewer wrote, and the route that posts it. Every GitHub write here goes to a fake gh, and every name, SHA, and report is invented
import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Run, Sweep } from '../src/cache.ts'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import type { OpenRow } from '../src/derive.ts'
import type { RawOpenPr } from '../src/github.ts'
import { parseResult } from '../src/launcher.ts'
import { reportHash } from '../src/reports.ts'
import { startServer } from '../src/server.ts'
import type { PitServer } from '../src/server.ts'
import { sweepOfferOf, sweepRequest } from '../src/sweeps.ts'
import type { View } from '../src/poller.ts'
import type { SweepOffer } from '../src/launcher.ts'
import { scenario } from './fixtures/scenario.ts'
import { fakeLaunch, fakeRunner, fakeTime, fixtureRunner, ok, failed, openPage1, openPage2, sweepResult, sweepRow, tempDir } from './helpers.ts'
import type { Call, FakeLaunch, FakeRunner } from './helpers.ts'

const repo = scenario.repo
// #114 is Dependabot's, #101 the viewer's own, and #106 someone else's (openCases in fixtures/scenario.ts)
const head114 = 'd6b9780883a05ddb3bb7ace1a5cb494104e1015a'
const head101 = 'e37eacd2ed3b5053796e287306e816198192777d'
const earlier = '0123456789abcdef0123456789abcdef01234567'

const reportText = (sha: string, findings = 'No actionable findings.'): string => `Reviewed commit: \`dependabot/npm_and_yarn/lodash-4.17.21\` @ \`${sha.slice(0, 7)}\`\n\n## Summary\n\n${findings}\n`

const row114 = (patch: Record<string, unknown> = {}): Record<string, unknown> => sweepRow({
  number: 114, url: `https://github.com/${repo}/pull/114`, title: 'build(deps): bump lodash from 4.17.20 to 4.17.21', head: head114, bump: 'lodash 4.17.20 → 4.17.21 (patch)',
  recommendation: 'approve', ci: 'green', findings: [], escalation: null, posted: null, reused: false, report: '~/agents/output/PR-114.md', notes: 'clean bump', ...patch,
})

const noPostResult = (rows: Record<string, unknown>[], patch: Record<string, unknown> = {}): Record<string, unknown> =>
  sweepResult({ notPostedReason: 'noPost', counts: { swept: rows.length, fresh: rows.length, reused: 0, failed: 0 }, rows, mergeOrder: [], summary: '~/agents/output/dependabot-sweep-orbit-2026-10-26.md', ...patch })

// ---- the derivation, on records built the way the cache holds them ----

const prsOf = async (): Promise<RawOpenPr[]> => [...(await openPage1()).data.repository!.pullRequests.nodes, ...(await openPage2()).data.repository!.pullRequests.nodes] as RawOpenPr[]
const prOf = async (number: number, patch: Partial<RawOpenPr> = {}): Promise<RawOpenPr> => ({ ...(await prsOf()).find((pr) => pr.number === number)!, ...patch })

const config = (patch: Partial<Config> = {}): Config => ({ ...defaultConfig(), repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit', ...patch })

const recordOf = (id: number, value: Record<string, unknown> | null, patch: Partial<Sweep> = {}): Sweep => {
  const parsed = value === null ? null : parseResult(JSON.stringify(value))
  if (parsed !== null && !parsed.ok) throw new Error(parsed.error)
  return {
    id, repo, command: 'review-dependabot-sweep', args: [repo, '--parallel', '1', '--no-post'], label: 'Dependabot sweep', runner: 'claude',
    cwd: '~/dev/orbit', dir: `~/.local/state/pit-view/sweeps/${id}`, sessionId: `s-${id}`, pid: 4000 + id, pidStartedAt: null, startedAt: `2026-10-26T1${id}:00:00Z`,
    lastStepAt: null, step: null, stepState: null, steps: null, finishedAt: `2026-10-26T1${id}:20:00Z`, status: 'done', result: parsed?.ok === true ? parsed.value : null, note: null, costUsd: null,
    resume: null, origin: 'auto', tick: id, reason: 'dependabot', queuedAt: `2026-10-26T1${id}:00:00Z`, posting: false, worktree: null,
    rowReports: { 114: { hash: 'a'.repeat(64), verdict: 'clean' }, 101: { hash: 'b'.repeat(64), verdict: 'clean' } }, postAttempts: {}, ...patch,
  } as Sweep
}

const sweepOf = (id: number, rows = [row114()], patch: Partial<Sweep> = {}, result: Record<string, unknown> = {}): Sweep => recordOf(id, noPostResult(rows, result), patch)

const runOf = (patch: Partial<Run> = {}): Run => ({
  id: 9, repo, number: 114, command: 'review-dependabot', args: ['114'], label: 'Review', runner: 'claude', cwd: '~/dev/orbit', dir: '~/runs/9', sessionId: null, pid: 4100, pidStartedAt: null,
  startedAt: '2026-10-26T12:30:00Z', lastStepAt: null, step: null, stepState: null, steps: null, finishedAt: '2026-10-26T12:40:00Z', status: 'done', result: null, note: null, costUsd: null, resume: null,
  origin: 'manual', tick: null, reason: null, queuedAt: null, posting: true, worktree: null, resolvedByHand: false, firstNote: null, reportHash: null, postAttemptedAt: null, headOid: null, extraInstructions: null, models: null, ...patch,
} as Run)

test('a row of a scheduled --no-post sweep offers its stored report: the recommended form and Comment, the report, the heads, the login, the CI state, and the commands', async () => {
  const derived = sweepOfferOf(await prOf(114), config(), [sweepOf(3)])
  assert.equal(derived.sweepId, 3)
  assert.deepEqual(derived.offer, {
    sweepId: 3,
    number: 114,
    forms: ['approve', 'comment'],
    report: 'PR-114.md',
    reportPath: '~/agents/output/PR-114.md',
    reviewedSha: head114,
    headSha: head114,
    repo,
    viewer: scenario.viewer,
    ci: 'green',
    commands: {
      approve: `gh pr review 114 --repo ${repo} --approve --body-file ~/agents/output/PR-114.md`,
      comment: `gh pr comment 114 --repo ${repo} --body-file ~/agents/output/PR-114.md`,
    },
  })
})

test('the form is the report\'s recommendation by section 10\'s table: a P0 to P2 verdict requests changes, a hold is a comment alone, and a draft or conflicting PR is not approved', async () => {
  const changes = sweepOfferOf(await prOf(114), config(), [sweepOf(3, [row114()], { rowReports: { 114: { hash: 'a'.repeat(64), verdict: 'changesRequested' } } })])
  assert.deepEqual(changes.offer?.forms, ['requestChanges', 'comment'])
  const hold = sweepOfferOf(await prOf(114), config(), [sweepOf(3, [row114({ recommendation: 'hold' })])])
  assert.deepEqual(hold.offer?.forms, ['comment'])
  const draft = sweepOfferOf(await prOf(114, { isDraft: true }), config(), [sweepOf(3)])
  assert.deepEqual(draft.offer?.forms, ['comment'])
  const conflicting = sweepOfferOf(await prOf(114, { mergeable: 'CONFLICTING' }), config(), [sweepOf(3)])
  assert.deepEqual(conflicting.offer?.forms, ['comment'])
})

test('the offer survives a moved head and says so by its two SHAs, as a single run\'s stored report does', async () => {
  const derived = sweepOfferOf(await prOf(114), config(), [sweepOf(3, [row114({ head: earlier })])])
  assert.equal(derived.offer?.reviewedSha, earlier)
  assert.equal(derived.offer?.headSha, head114)
})

test('no offer for the viewer\'s own PR, whatever the sweep says', async () => {
  const own = sweepOf(3, [row114({ number: 101, head: head101, report: '~/agents/output/PR-101.md' })])
  assert.deepEqual(sweepOfferOf(await prOf(101), config(), [own]), { sweepId: 3, offer: null })
})

test('no offer unless the sweep was a scheduled one that ran with --no-post and finished done, the row posted nothing, its report is the PR\'s own file, and its report was recorded with a verdict', async () => {
  const pr = await prOf(114)
  const none = async (sweep: Sweep, why: string): Promise<void> => assert.equal(sweepOfferOf(pr, config(), [sweep]).offer, null, why)
  await none(sweepOf(3, [row114()], { origin: 'manual' }), 'started by hand')
  await none(sweepOf(3, [row114()], { args: [repo, '--parallel', '1'] }), 'allowed to post')
  await none(sweepOf(3, [row114()], {}, { notPostedReason: null }), 'its result does not say noPost')
  await none(sweepOf(3, [row114()], { status: 'failed', note: 'noReport' }), 'not done')
  await none(sweepOf(3, [row114()], { status: 'stopped' }), 'stopped')
  await none(sweepOf(3, [row114({ posted: { form: 'comment', url: `https://github.com/${repo}/pull/114#issuecomment-1` } })]), 'the row posted')
  await none(sweepOf(3, [row114({ report: '~/agents/output/elsewhere/PR-114.md' })]), 'a report path that is not the PR\'s own file')
  await none(sweepOf(3, [row114({ report: null })]), 'no report')
  await none(sweepOf(3, [row114({ head: 'd6b9780' })]), 'a head that is not a full SHA')
  await none(sweepOf(3, [row114()], { rowReports: null }), 'no report recorded at settle')
  await none(sweepOf(3, [row114()], { rowReports: { 114: { hash: 'a'.repeat(64), verdict: null } } }), 'a report with no verdict')
  await none(sweepOf(3, [row114()], { postAttempts: { 114: '2026-10-26T14:00:00Z' } }), 'a post already begun')
  await none(sweepOf(3, [row114()], { repo: 'other-org/other-repo' }), 'another repository')
  await none(sweepOf(3, [row114()], { runner: 'hermes' }), 'a hermes sweep, whose reports are never cleared of keys')
})

test('no offer once the viewer has approved or requested changes on the PR\'s current head', async () => {
  const reviewed = await prOf(114, {
    latestReviews: { nodes: [{ author: { login: scenario.viewer }, state: 'APPROVED', submittedAt: '2026-10-26T14:00:00Z', commit: { oid: head114 }, databaseId: 1 }] },
  } as unknown as Partial<RawOpenPr>)
  assert.equal(sweepOfferOf(reviewed, config(), [sweepOf(3)]).offer, null)
})

test('the newest sweep with a row for the PR is the one on offer: an older sweep\'s row is never offered behind it, and a newer sweep that did not reach the PR is passed over', async () => {
  const pr = await prOf(114)
  // newest first, as the cache lists them
  const posted = sweepOf(5, [row114({ posted: { form: 'approve', url: `https://github.com/${repo}/pull/114#pullrequestreview-2` } })])
  assert.deepEqual(sweepOfferOf(pr, config(), [posted, sweepOf(3)]), { sweepId: 5, offer: null })
  const elsewhere = sweepOf(5, [row114({ number: 115, report: '~/agents/output/PR-115.md' })])
  assert.equal(sweepOfferOf(pr, config(), [elsewhere, sweepOf(3)]).offer?.sweepId, 3)
  const failedBefore = sweepOf(5, [], { status: 'failed', note: 'noResult' })
  assert.equal(sweepOfferOf(pr, config(), [failedBefore, sweepOf(3)]).offer?.sweepId, 3)
})

test('a sweep queued, running, or waiting for an answer withdraws every row\'s offer, since it may write the same report again', async () => {
  const pr = await prOf(114)
  for (const status of ['queued', 'running', 'needsInput'] as const) {
    assert.deepEqual(sweepOfferOf(pr, config(), [recordOf(5, null, { status, finishedAt: null }), sweepOf(3)]), { sweepId: null, offer: null }, status)
  }
})

test('a review of the PR in flight, or one that ran after the sweep started, withdraws the offer; one that ended before the sweep, never spawned, or does not write the PR\'s report leaves it', async () => {
  const pr = await prOf(114)
  const sweep = sweepOf(3)
  const offered = (runs: Run[]): number | null => sweepOfferOf(pr, config(), [sweep], runs).offer?.sweepId ?? null
  assert.equal(offered([runOf({ status: 'running', finishedAt: null })]), null)
  assert.equal(offered([runOf({ status: 'queued', pid: null, finishedAt: null })]), null)
  assert.equal(offered([runOf({ status: 'needsInput' })]), null)
  assert.equal(offered([runOf({ startedAt: '2026-10-26T13:10:00Z', finishedAt: '2026-10-26T13:30:00Z' })]), null)
  assert.equal(offered([runOf({ command: 'review-pr', startedAt: '2026-10-26T13:30:00Z', finishedAt: '2026-10-26T13:50:00Z', status: 'failed' })]), null)
  assert.equal(offered([runOf()]), 3)
  assert.equal(offered([runOf({ status: 'stopped', pid: null, startedAt: '2026-10-26T13:30:00Z', finishedAt: '2026-10-26T13:31:00Z' })]), 3)
  assert.equal(offered([runOf({ command: 'fix-pr', startedAt: '2026-10-26T13:30:00Z', finishedAt: '2026-10-26T13:50:00Z' })]), 3)
})

// ---- the server: the record at settle, the row's offer, and the route ----

type Harness = { server: PitServer, runner: FakeRunner, launch: FakeLaunch, base: string, home: string, options: Parameters<typeof startServer>[0], cleanup: () => Promise<void> }

type Behavior = {
  bodies?: { text: string, mode: number }[]
  writeError?: string
  reviews?: string
  live?: (number: number) => Record<string, unknown>
  // runs while the post's live read of the PR waits for GitHub, and as the write reaches gh
  onLive?: () => Promise<void>
  onWrite?: () => Promise<void>
  // holds each write until the test lets it go
  hold?: Promise<void>
}

const isWrite = (args: string[]): boolean => args[0] === 'pr' && (args[1] === 'review' || args[1] === 'comment')
const isLiveRead = (args: string[]): boolean => args[0] === 'api' && /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(args[1] ?? '') && !args.includes('--method')
const isReviewsRead = (args: string[]): boolean => args[0] === 'api' && args.some((arg) => /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews$/.test(arg))
const postsOf = (runner: FakeRunner): Call[] => runner.calls.filter((call) => isWrite(call.args))

const heads: Record<number, string> = { 114: head114, 101: head101 }

const ghWorld = (behavior: Behavior = {}): FakeRunner => {
  const base = fixtureRunner()
  return fakeRunner(async (args) => {
    if (isLiveRead(args)) {
      await behavior.onLive?.()
      const number = Number(args[1]!.split('/').pop())
      return ok(JSON.stringify({ state: 'open', draft: false, merged: false, head: { sha: heads[number] }, ...behavior.live?.(number) }))
    }
    if (isReviewsRead(args)) return ok(behavior.reviews ?? '')
    if (isWrite(args)) {
      await behavior.onWrite?.()
      await behavior.hold
      const bodyFile = args[args.indexOf('--body-file') + 1]
      if (bodyFile !== undefined && behavior.bodies !== undefined) behavior.bodies.push({ text: await readFile(bodyFile, 'utf8'), mode: (await stat(bodyFile)).mode & 0o777 })
      if (behavior.writeError !== undefined) return failed(behavior.writeError)
      return ok(args[1] === 'comment' ? `https://github.com/${repo}/pull/114#issuecomment-77\n` : '')
    }
    if (args[0] === 'api' && args[1] === 'user') return ok(`${scenario.viewer}\n`)
    return base.runner(args)
  })
}

const setup = async (behavior: Behavior = {}): Promise<Harness> => {
  const { dir: home, cleanup: removeHome } = await tempDir()
  const configPath = join(home, '.config', 'pit-view', 'config.json')
  await mkdir(join(configPath, '..'), { recursive: true })
  await writeFile(configPath, JSON.stringify({ repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit' }), 'utf8')
  const time = fakeTime()
  const launch = fakeLaunch()
  const runner = ghWorld(behavior)
  const options = {
    home, port: 0, runner: runner.runner, clock: time.clock, timers: time.timers, timeZone: scenario.timeZone, configPath,
    cachePath: join(home, '.local', 'state', 'pit-view', 'cache.sqlite'), stateDir: join(home, '.local', 'state', 'pit-view'), publicDir: join(home, 'public'),
    launch: launch.deps, log: () => {}, pageSize: scenario.pageSize,
  }
  const server = await startServer(options)
  await (await fetch(`${server.url}/api/refresh`, { method: 'POST' })).json()
  await server.poller.idle()
  const h: Harness = { server, runner, launch, base: server.url, home, options, cleanup: async () => { await h.server.close(); await removeHome() } }
  return h
}

// a second start over the same home, cache, and state folder, which is what a restart of the server is
const restart = async (h: Harness): Promise<void> => {
  await h.server.close()
  h.server = await startServer(h.options)
  h.base = h.server.url
}

// the post button's offer the page holds for a PR
const offerOf = async (h: Harness, number: number): Promise<SweepOffer | null | undefined> => (await rowOf(h, number))?.agent?.sweepOffer

// a sweep the scheduler started, with --no-post, still running: its reviewers have written each row's report and its review step has ended, which Pit View has seen. reviewEnd false leaves the step's end unwritten
const reviewedSweep = async (h: Harness, reports: Record<number, string> = { 114: reportText(head114) }, reviewEnd = true): Promise<{ id: number, child: FakeLaunch['children'][number] }> => {
  const folder = join(h.home, 'agents', 'output')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'dependabot-sweep-orbit-2026-10-26.md'), '# Sweep\n')
  const tick = h.server.cache.createTick(repo)
  const cwd = join(h.home, 'dev', 'orbit')
  const request = sweepRequest(repo)
  const args = [...request.args, '--no-post']
  const queued = h.server.sweepLauncher.queueScheduled({ ...request, args }, cwd, { tick: tick.id, reason: 'dependabot', headOid: null, posting: false })
  await h.server.sweepLauncher.startScheduled(queued.id, { ...request, args }, { args, posting: false }, async () => cwd)
  const child = h.launch.children.at(-1)!
  await child.events({ at: '2026-10-26T12:01:00Z', step: 'review', state: 'started', note: null })
  for (const [number, text] of Object.entries(reports)) await writeFile(join(folder, `PR-${number}.md`), text)
  if (reviewEnd) await child.events({ at: '2026-10-26T12:10:00Z', step: 'review', state: 'done', note: null })
  await h.server.sweepLauncher.check()
  return { id: queued.id, child }
}

// a sweep the scheduler started, with --no-post, that settles with these rows. Each row's report is written during the sweep's review step, as its reviewer writes it; replaced is written over a report after Pit View saw that step end and before the sweep settles
const scheduledSweep = async (h: Harness, rows: Record<string, unknown>[], reports: Record<number, string> = { 114: reportText(head114) }, result: Record<string, unknown> = {}, replaced: Record<number, string> = {}): Promise<Sweep> => {
  const { id, child } = await reviewedSweep(h, reports)
  for (const [number, text] of Object.entries(replaced)) await writeFile(join(h.home, 'agents', 'output', `PR-${number}.md`), text)
  await child.result(noPostResult(rows, result))
  child.exit(0)
  return h.server.sweepLauncher.settled(id)
}

const rowOf = async (h: Harness, number: number): Promise<OpenRow | undefined> => {
  const view = await (await fetch(`${h.base}/api/view`)).json() as View
  return [...view.mine.groups, ...view.others.groups].flatMap((group) => group.rows as OpenRow[]).find((row) => row.number === number)
}

const post = async (h: Harness, id: number | string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number, body: Record<string, unknown> }> => {
  const response = await fetch(`${h.base}/api/sweeps/${id}/post`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: h.base, 'X-Pit-View-Token': h.server.token, ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

const bodyOf = (form = 'approve', patch: Record<string, unknown> = {}): Record<string, unknown> => ({ repo, viewer: scenario.viewer, number: 114, headSha: head114, reviewedSha: head114, form, ...patch })

test('a scheduled --no-post sweep records each row\'s report by its hash and verdict when it settles, and the row of that PR offers the post button; nothing is posted', async () => {
  const h = await setup()
  try {
    const sweep = await scheduledSweep(h, [row114()])
    assert.equal(sweep.status, 'done')
    assert.deepEqual(h.server.cache.getSweep(sweep.id)?.rowReports, { 114: { hash: reportHash(reportText(head114)), verdict: 'clean' } })
    assert.deepEqual(h.server.cache.getSweep(sweep.id)?.postAttempts, {})
    const offer = (await rowOf(h, 114))?.agent?.sweepOffer
    assert.equal(offer?.sweepId, sweep.id)
    assert.deepEqual(offer?.forms, ['approve', 'comment'])
    assert.equal(offer?.reviewedSha, head114)
    assert.deepEqual(postsOf(h.runner), [])
  } finally {
    await h.cleanup()
  }
})

test('a sweep allowed to post records no row reports, and its rows offer nothing', async () => {
  const h = await setup()
  try {
    const folder = join(h.home, 'agents', 'output')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'PR-114.md'), reportText(head114))
    await writeFile(join(folder, 'dependabot-sweep-orbit-2026-10-26.md'), '# Sweep\n')
    const started = await h.server.sweepLauncher.start(sweepRequest(repo))
    const child = h.launch.children.at(-1)!
    await child.result(noPostResult([row114()], { notPostedReason: null }))
    child.exit(0)
    const sweep = await h.server.sweepLauncher.settled(started.id)
    assert.equal(sweep.status, 'done')
    assert.equal(h.server.cache.getSweep(sweep.id)?.rowReports, null)
    assert.equal((await rowOf(h, 114))?.agent?.sweepOffer, null)
  } finally {
    await h.cleanup()
  }
})

test('a report replaced after the sweep\'s review step ended and before the sweep settled is not the reviewer\'s, so it is not recorded and its row offers nothing', async () => {
  const h = await setup()
  try {
    const sweep = await scheduledSweep(h, [row114()], { 114: reportText(head114) }, {}, { 114: reportText(head114, 'No actionable findings. Written by another review.') })
    assert.equal(sweep.status, 'done')
    assert.equal(h.server.cache.getSweep(sweep.id)?.rowReports?.[114], undefined)
    assert.equal(await offerOf(h, 114), null)
    const answer = await post(h, sweep.id, bodyOf())
    assert.equal(answer.status, 422, JSON.stringify(answer.body))
    assert.deepEqual(postsOf(h.runner), [])
  } finally {
    await h.cleanup()
  }
})

test('a sweep whose review step Pit View never saw end before it settled records no row report, since nothing ties the report to its reviewer', async () => {
  const h = await setup()
  try {
    const { id, child } = await reviewedSweep(h, { 114: reportText(head114) }, false)
    await child.events({ at: '2026-10-26T12:10:00Z', step: 'review', state: 'done', note: null })
    await child.result(noPostResult([row114()]))
    child.exit(0)
    const sweep = await h.server.sweepLauncher.settled(id)
    assert.equal(sweep.status, 'done')
    assert.equal(h.server.cache.getSweep(id)?.rowReports?.[114], undefined)
    assert.equal(await offerOf(h, 114), null)
  } finally {
    await h.cleanup()
  }
})

test('a sweep that settles in the recovery after a restart records no row report, so a report replaced while the server was down is never offered', async () => {
  const h = await setup()
  try {
    const { id, child } = await reviewedSweep(h)
    await child.result(noPostResult([row114()]))
    // the server stops before the sweep settles; meanwhile another writer replaces the report and the sweep's process ends
    await h.server.close()
    await writeFile(join(h.home, 'agents', 'output', 'PR-114.md'), reportText(head114, 'No actionable findings. Written while the server was down.'))
    h.launch.alive.delete(child.pid)
    h.server = await startServer(h.options)
    h.base = h.server.url
    await (await fetch(`${h.base}/api/refresh`, { method: 'POST' })).json()
    await h.server.poller.idle()
    const sweep = h.server.cache.getSweep(id)
    assert.equal(sweep?.status, 'done')
    assert.equal(sweep?.rowReports?.[114], undefined)
    assert.equal(await offerOf(h, 114), null)
    const answer = await post(h, id, bodyOf())
    assert.equal(answer.status, 422, JSON.stringify(answer.body))
    assert.deepEqual(postsOf(h.runner), [])
  } finally {
    await h.cleanup()
  }
})

test('a reused row keeps the report an earlier sweep recorded for the same head while the file is unchanged, and records nothing for a report no sweep recorded', async () => {
  const h = await setup()
  try {
    const older = await scheduledSweep(h, [row114()])
    // the newer sweep reuses #114's unchanged report, writing nothing to it
    const newer = await scheduledSweep(h, [row114({ reused: true })], {})
    assert.deepEqual(h.server.cache.getSweep(newer.id)?.rowReports?.[114], h.server.cache.getSweep(older.id)?.rowReports?.[114])
    assert.equal((await offerOf(h, 114))?.sweepId, newer.id)
    // a reused row whose report differs from what the earlier sweep recorded is not that sweep's report
    const changed = await scheduledSweep(h, [row114({ reused: true })], {}, {}, { 114: reportText(head114, 'No actionable findings. Edited by hand.') })
    assert.equal(h.server.cache.getSweep(changed.id)?.rowReports?.[114], undefined)
    assert.equal(await offerOf(h, 114), null)
  } finally {
    await h.cleanup()
  }
})

test('the post button posts the sweep row\'s stored report once, as the form clicked, through gh on a private copy, after the account and live checks, and records it on the row', async () => {
  const behavior: Behavior = { bodies: [] }
  const h = await setup(behavior)
  try {
    const sweep = await scheduledSweep(h, [row114()])
    const children = h.launch.children.length
    const answer = await post(h, sweep.id, bodyOf('approve'))
    assert.equal(answer.status, 200, JSON.stringify(answer.body))
    assert.equal(answer.body.number, 114)
    assert.equal(answer.body.sweepId, sweep.id)
    assert.deepEqual(answer.body.posted, { form: 'approve', url: `https://github.com/${repo}/pull/114` })
    const posts = postsOf(h.runner)
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0]?.args.slice(0, -1), ['pr', 'review', '114', '--repo', repo, '--approve', '--body-file'])
    assert.notEqual(posts[0]?.args.at(-1), join(h.home, 'agents', 'output', 'PR-114.md'))
    assert.equal(behavior.bodies?.[0]?.text, reportText(head114))
    assert.equal(behavior.bodies?.[0]?.mode, 0o600)
    const order = h.runner.calls.map((call) => call.args)
    const writeAt = order.findIndex(isWrite)
    assert.ok(order.slice(0, writeAt).some((args) => args[0] === 'api' && args[1] === 'user'), 'the account was confirmed first')
    assert.ok(order.slice(0, writeAt).some(isLiveRead) && order.slice(0, writeAt).some(isReviewsRead), 'the PR and its reviews were read live first')
    // no review or sweep started, the row's post is on the sweep's record, and the offer is gone
    assert.equal(h.launch.children.length, children)
    const recorded = h.server.cache.getSweep(sweep.id)
    const rows = recorded?.result?.schema === 'pit-crew/sweep-result@1' ? recorded.result.rows as Record<string, unknown>[] : []
    assert.deepEqual(rows.find((row) => row.number === 114)?.posted, { form: 'approve', url: `https://github.com/${repo}/pull/114` })
    assert.equal(typeof recorded?.postAttempts[114], 'string')
    assert.equal((await rowOf(h, 114))?.agent?.sweepOffer, null)
    const shown = h.server.sweeps.get(sweep.id)?.result?.rows.find((row) => row.number === 114)
    assert.deepEqual(shown?.posted, { form: 'approve', url: `https://github.com/${repo}/pull/114` })
    // a second click posts nothing
    assert.equal((await post(h, sweep.id, bodyOf('approve'))).status, 422)
    assert.equal(postsOf(h.runner).length, 1)
  } finally {
    await h.cleanup()
  }
})

test('Comment posts through gh pr comment and keeps the comment\'s address', async () => {
  const h = await setup()
  try {
    const sweep = await scheduledSweep(h, [row114()])
    const answer = await post(h, sweep.id, bodyOf('comment'))
    assert.equal(answer.status, 200)
    assert.deepEqual(postsOf(h.runner)[0]?.args.slice(0, -1), ['pr', 'comment', '114', '--repo', repo, '--body-file'])
    assert.deepEqual(answer.body.posted, { form: 'comment', url: `https://github.com/${repo}/pull/114#issuecomment-77` })
  } finally {
    await h.cleanup()
  }
})

test('the route takes a direct action\'s Origin and token, and a body that names the stored report\'s commit, before anything is read', async () => {
  const h = await setup()
  try {
    const sweep = await scheduledSweep(h, [row114()])
    const noOrigin = await fetch(`${h.base}/api/sweeps/${sweep.id}/post`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pit-View-Token': h.server.token }, body: JSON.stringify(bodyOf()) })
    assert.equal(noOrigin.status, 403)
    assert.equal((await post(h, sweep.id, bodyOf(), { 'X-Pit-View-Token': 'wrong' })).status, 403)
    const { reviewedSha: _reviewed, ...withoutReviewed } = bodyOf()
    assert.equal((await post(h, sweep.id, withoutReviewed)).status, 400)
    assert.equal((await post(h, sweep.id, bodyOf('approve', { extra: true }))).status, 400)
    assert.equal((await post(h, 'x', bodyOf())).status, 400)
    assert.deepEqual(postsOf(h.runner), [])
    assert.equal((await rowOf(h, 114))?.agent?.sweepOffer?.sweepId, sweep.id)
  } finally {
    await h.cleanup()
  }
})

test('every refusal writes nothing: another repository or viewer, an unknown sweep, a form not offered, another reviewed commit, and a head that moved', async () => {
  const h = await setup()
  try {
    const sweep = await scheduledSweep(h, [row114({ recommendation: 'hold' })])
    const refused = async (id: number, body: Record<string, unknown>, status: number, error: RegExp): Promise<void> => {
      const answer = await post(h, id, body)
      assert.equal(answer.status, status, JSON.stringify(answer.body))
      assert.match(String(answer.body.error), error)
    }
    await refused(sweep.id, bodyOf('comment', { repo: 'other-org/other-repo' }), 409, /the repository is now/)
    await refused(sweep.id, bodyOf('comment', { viewer: 'someone-else' }), 409, /the viewer is now/)
    await refused(sweep.id + 40, bodyOf('comment'), 404, /does not exist/)
    await refused(sweep.id, bodyOf('approve'), 409, /offers a comment, not an approval/)
    await refused(sweep.id, bodyOf('comment', { reviewedSha: earlier }), 409, /reviewed d6b9780, not 0123456/)
    await refused(sweep.id, bodyOf('comment', { headSha: earlier }), 409, /new commits since the confirmation was shown/)
    assert.deepEqual(postsOf(h.runner), [])
    assert.equal((await rowOf(h, 114))?.agent?.sweepOffer?.sweepId, sweep.id)
  } finally {
    await h.cleanup()
  }
})

test('a report rewritten since the sweep settled, or one that names another commit, is refused with nothing posted', async () => {
  const h = await setup()
  try {
    const sweep = await scheduledSweep(h, [row114()])
    await writeFile(join(h.home, 'agents', 'output', 'PR-114.md'), reportText(head114, '- **P1** something new'))
    const changed = await post(h, sweep.id, bodyOf())
    assert.equal(changed.status, 422)
    assert.match(String(changed.body.error), new RegExp(`has changed since sweep ${sweep.id} finished`))
    assert.deepEqual(postsOf(h.runner), [])
  } finally {
    await h.cleanup()
  }
  const other = await setup()
  try {
    const sweep = await scheduledSweep(other, [row114()], { 114: reportText(earlier) })
    const named = await post(other, sweep.id, bodyOf())
    assert.equal(named.status, 422)
    assert.match(String(named.body.error), /is about another commit/)
    assert.deepEqual(postsOf(other.runner), [])
  } finally {
    await other.cleanup()
  }
})

test('an older sweep\'s row is never posted once a newer sweep has a row for the PR', async () => {
  const h = await setup()
  try {
    const older = await scheduledSweep(h, [row114()])
    const newer = await scheduledSweep(h, [row114()])
    assert.equal((await rowOf(h, 114))?.agent?.sweepOffer?.sweepId, newer.id)
    const answer = await post(h, older.id, bodyOf())
    assert.equal(answer.status, 409)
    assert.match(String(answer.body.error), /no longer the latest for this PR; nothing was posted/)
    assert.deepEqual(postsOf(h.runner), [])
  } finally {
    await h.cleanup()
  }
})

test('the viewer\'s own PR in a sweep gets no button, and a post for it is refused with no gh call', async () => {
  const h = await setup()
  try {
    const sweep = await scheduledSweep(h, [row114({ number: 101, head: head101, report: '~/agents/output/PR-101.md' })], { 101: reportText(head101) })
    assert.equal((await rowOf(h, 101))?.agent?.sweepOffer, null)
    // the sweep's own start confirmed the account; the post must not
    const before = h.runner.calls.length
    const answer = await post(h, sweep.id, { repo, viewer: scenario.viewer, number: 101, headSha: head101, reviewedSha: head101, form: 'approve' })
    assert.equal(answer.status, 422)
    assert.deepEqual(postsOf(h.runner), [])
    assert.ok(!h.runner.calls.slice(before).some((call) => call.args[0] === 'api' && call.args[1] === 'user'), 'no account lookup either')
  } finally {
    await h.cleanup()
  }
})

test('a post GitHub refuses is a 502 with its reason, takes the mark off, and leaves the offer standing', async () => {
  const h = await setup({ writeError: 'HTTP 422: Unprocessable Entity (https://api.github.com/graphql)' })
  try {
    const sweep = await scheduledSweep(h, [row114()])
    const answer = await post(h, sweep.id, bodyOf())
    assert.equal(answer.status, 502)
    assert.deepEqual(h.server.cache.getSweep(sweep.id)?.postAttempts, {})
    assert.equal((await rowOf(h, 114))?.agent?.sweepOffer?.sweepId, sweep.id)
  } finally {
    await h.cleanup()
  }
})

// a single auto-review of #114 that ran with --no-post and finished with its report on disk, so its row offers the stored report's button
const storedRun = async (h: Harness): Promise<number> => {
  await writeFile(join(h.home, 'agents', 'output', 'PR-114.md'), reportText(head114))
  const tick = h.server.cache.createTick(repo)
  const cwd = join(h.home, 'dev', 'orbit')
  const request = { repo, number: 114, command: 'review-dependabot', args: ['114', '--no-post'], label: 'Review' }
  const queued = h.server.launcher.queueScheduled(request, cwd, { tick: tick.id, reason: 'dependabot', headOid: head114.slice(0, 7), posting: false })
  await h.server.launcher.startScheduled(queued.id, request, { args: request.args, posting: false }, async () => cwd)
  const child = h.launch.children.at(-1)!
  await child.result({
    schema: 'pit-crew/review-result@1', command: 'review-dependabot', status: 'done', target: { repo, pr: 114 }, reviewed: { kind: 'commit', sha: head114 }, verdict: 'clean', recommendation: 'approve',
    findings: [], ci: 'green', fixAttempts: 0, posted: null, notPostedReason: 'noPost', report: '~/agents/output/PR-114.md', question: null, error: null,
  })
  child.exit(0)
  await h.server.launcher.settled(queued.id)
  return queued.id
}

test('a Comment whose outcome is unknown leaves the PR marked: a newer sweep\'s fresh row of it offers nothing and a click on it is refused, and a later single auto-review offers nothing either', async () => {
  const h = await setup({ writeError: 'read tcp: connection reset by peer' })
  try {
    const first = await scheduledSweep(h, [row114()])
    const unknown = await post(h, first.id, bodyOf('comment'))
    assert.equal(unknown.status, 502)
    assert.match(String(unknown.body.error), /may have landed/)
    // the next sweep reviews the unchanged PR again, with a fresh row and a fresh report
    const newer = await scheduledSweep(h, [row114()])
    assert.notEqual(h.server.cache.getSweep(newer.id)?.rowReports?.[114], undefined)
    assert.equal(await offerOf(h, 114), null)
    const again = await post(h, newer.id, bodyOf('comment'))
    assert.equal(again.status, 422, JSON.stringify(again.body))
    assert.match(String(again.body.error), /may have landed/)
    // a single auto-review's stored report of the PR is not offered either
    const run = await storedRun(h)
    assert.equal(h.server.cache.getRun(run)?.reportHash !== null, true)
    assert.equal((await rowOf(h, 114))?.agent?.storedOffer, null)
    const fromRun = await fetch(`${h.base}/api/runs/${run}/post`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: h.base, 'X-Pit-View-Token': h.server.token }, body: JSON.stringify(bodyOf('comment')),
    })
    assert.equal(fromRun.status, 422)
    assert.equal(postsOf(h.runner).length, 1)
  } finally {
    await h.cleanup()
  }
})

test('a post GitHub refused takes the PR\'s mark off, so a newer sweep\'s row of it offers the button again', async () => {
  const h = await setup({ writeError: 'HTTP 422: Unprocessable Entity (https://api.github.com/graphql)' })
  try {
    const first = await scheduledSweep(h, [row114()])
    assert.equal((await post(h, first.id, bodyOf('comment'))).status, 502)
    const newer = await scheduledSweep(h, [row114()])
    assert.equal((await offerOf(h, 114))?.sweepId, newer.id)
  } finally {
    await h.cleanup()
  }
})

test('the PR\'s mark is on disk before gh is asked to write, so a restart before any record of the post offers the PR to no sweep, old or new', async () => {
  const behavior: Behavior = { writeError: 'read tcp: connection reset by peer' }
  const h = await setup(behavior)
  try {
    const first = await scheduledSweep(h, [row114()])
    let markedBeforeWrite = false
    behavior.onWrite = async () => {
      markedBeforeWrite = h.server.cache.unresolvedPostMarks(repo).has(114)
    }
    assert.equal((await post(h, first.id, bodyOf('comment'))).status, 502)
    assert.equal(markedBeforeWrite, true)
    await restart(h)
    await (await fetch(`${h.base}/api/refresh`, { method: 'POST' })).json()
    await h.server.poller.idle()
    assert.equal(await offerOf(h, 114), null)
    const newer = await scheduledSweep(h, [row114()])
    assert.equal(await offerOf(h, 114), null)
    assert.equal((await post(h, newer.id, bodyOf('comment'))).status, 422)
    assert.equal(postsOf(h.runner).length, 1)
  } finally {
    await h.cleanup()
  }
})

test('two clicks on one PR\'s button at once post once: the first holds the PR, and the second is refused with nothing written', async () => {
  let release: () => void = () => {}
  const behavior: Behavior = { hold: new Promise<void>((resolve) => { release = resolve }) }
  const h = await setup(behavior)
  try {
    const sweep = await scheduledSweep(h, [row114()])
    const first = post(h, sweep.id, bodyOf('approve'))
    for (let tries = 0; tries < 200 && postsOf(h.runner).length === 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(postsOf(h.runner).length, 1, 'the first click reached the write')
    const second = await post(h, sweep.id, bodyOf('approve'))
    assert.equal(second.status, 409, JSON.stringify(second.body))
    assert.match(String(second.body.error), /already in progress/)
    release()
    assert.equal((await first).status, 200)
    assert.equal(postsOf(h.runner).length, 1)
  } finally {
    release()
    await h.cleanup()
  }
})

test('a sweep that starts while the click\'s live read of the PR waits on GitHub withdraws the offer before the mark: nothing is written and the PR is not marked', async () => {
  const behavior: Behavior = {}
  const h = await setup(behavior)
  try {
    const sweep = await scheduledSweep(h, [row114()])
    let started = false
    behavior.onLive = async () => {
      if (started) return
      started = true
      await h.server.sweepLauncher.start(sweepRequest(repo))
    }
    const answer = await post(h, sweep.id, bodyOf('approve'))
    assert.equal(started, true)
    assert.equal(answer.status, 409, JSON.stringify(answer.body))
    assert.match(String(answer.body.error), /no longer the latest for this PR; nothing was posted/)
    assert.deepEqual(postsOf(h.runner), [])
    assert.equal(h.server.cache.unresolvedPostMarks(repo).has(114), false)
    assert.deepEqual(h.server.cache.getSweep(sweep.id)?.postAttempts, {})
  } finally {
    await h.cleanup()
  }
})

test('a post refused over the scan names the term, and the second click with that hit set and hash posts it', async () => {
  const h = await setup()
  try {
    const sweep = await scheduledSweep(h, [row114()], { 114: reportText(head114, 'No actionable findings. Checked with an assistant.') })
    const first = await post(h, sweep.id, bodyOf())
    assert.equal(first.status, 422)
    assert.match(String(first.body.error), /contains "assistant"/)
    assert.deepEqual(postsOf(h.runner), [])
    const hits = first.body.hits as { term: string }[]
    const second = await post(h, sweep.id, bodyOf('approve', { allow: { terms: hits.map((hit) => hit.term), reportHash: first.body.reportHash } }))
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(postsOf(h.runner).length, 1)
  } finally {
    await h.cleanup()
  }
})

test('the sweep\'s view shows a row whose post was begun and never recorded as a post that may have landed, and keeps hashes and marks off the page', async () => {
  const h = await setup()
  try {
    const sweep = await scheduledSweep(h, [row114()])
    h.server.cache.updateSweep(sweep.id, { postAttempts: { 114: '2026-10-26T14:10:00Z' } })
    h.server.sweeps.set(h.server.cache.getSweep(sweep.id)!)
    const shown = h.server.sweeps.get(sweep.id)
    assert.equal(shown?.result?.rows.find((row) => row.number === 114)?.postUnknown, true)
    assert.equal('rowReports' in (shown ?? {}), false)
    assert.equal('postAttempts' in (shown ?? {}), false)
    assert.equal((await rowOf(h, 114))?.agent?.sweepOffer, null)
  } finally {
    await h.cleanup()
  }
})

test('a sweep row\'s offer reaches the page with the sweep\'s own patch, so a settle shows the button and a new sweep starting takes it away', async () => {
  const h = await setup()
  try {
    const patches: { rows: OpenRow[], sweeps?: unknown }[] = []
    const controller = new AbortController()
    const response = await fetch(`${h.base}/api/events?client=tab-1&visible=true&paused=true`, { signal: controller.signal })
    const reader = response.body!.getReader()
    let buffer = ''
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) return
          buffer += new TextDecoder().decode(value)
          for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const frame = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            if (frame.startsWith('event: patch\n')) patches.push(JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as { rows: OpenRow[] })
          }
        }
      } catch {
        // aborted at the end of the test
      }
    })()
    try {
      const sweep = await scheduledSweep(h, [row114()])
      await h.server.sweepLauncher.flushed()
      for (let tries = 0; tries < 200 && !patches.some((patch) => patch.sweeps !== undefined && patch.rows.some((row) => row.number === 114 && row.agent?.sweepOffer?.sweepId === sweep.id)); tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      assert.ok(patches.some((patch) => patch.sweeps !== undefined && patch.rows.some((row) => row.number === 114 && row.agent?.sweepOffer?.sweepId === sweep.id)), 'the settle\'s patch carries the row with its offer')
      const seen = patches.length
      await h.server.sweepLauncher.start(sweepRequest(repo))
      for (let tries = 0; tries < 200 && !patches.slice(seen).some((patch) => patch.rows.some((row) => row.number === 114 && row.agent?.sweepOffer === null)); tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      assert.ok(patches.slice(seen).some((patch) => patch.rows.some((row) => row.number === 114 && row.agent?.sweepOffer === null)), 'a sweep in flight takes the offer away in its own patch')
    } finally {
      controller.abort()
    }
  } finally {
    await h.cleanup()
  }
})
