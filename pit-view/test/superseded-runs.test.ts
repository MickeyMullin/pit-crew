// test/superseded-runs.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { ciStateOf, currentContexts, deriveIssues, deriveMerge, deriveOpenRows, otherGroup } from '../src/derive.ts'
import type { DeriveContext, Issue, OpenRow } from '../src/derive.ts'
import { createGh, fetchOpenPrs } from '../src/github.ts'
import type { RawCheckContext, RawOpenPr, RawOpenResponse } from '../src/github.ts'
import { scenario } from './fixtures/scenario.ts'
import { fakeRunner, field, ok, failed, openPage1 } from './helpers.ts'

// an invented rollup with the shape of the reported bug: two runs of one workflow on the same head, the older one superseded by a concurrency group a few minutes in. Each run has 39 jobs; the old run ends with 4 canceled jobs and the 2 gate jobs that fail because the jobs they require were canceled

const workflow = { databaseId: 70001, name: 'Validate' }
const oldRun = { databaseId: 31000000101, createdAt: '2026-10-26T10:54:00Z', runAttempt: 1, workflow }
const newRun = { databaseId: 31000000102, createdAt: '2026-10-26T10:59:00Z', runAttempt: 1, workflow }

type Run = typeof oldRun
type Job = { name: string, status: string, conclusion: string | null }

const canceledJobs = ['Web unit tests', 'Server unit tests', 'Engine tests', 'Coverage report']
const gateJobs = ['Coverage gate', 'Required checks']
const otherJobs = Array.from({ length: 33 }, (_, index) => `Job ${index + 1}`)
const jobNames = [...otherJobs, ...canceledJobs, ...gateJobs]

let nextJob = 93000001000
const jobUrl = (run: Run): string => `https://github.com/octo-example/orbit/actions/runs/${run.databaseId}/job/${nextJob++}`

const actionsRun = (run: Run, job: Job, url = jobUrl(run)): RawCheckContext =>
  ({ __typename: 'CheckRun', name: job.name, status: job.status, conclusion: job.conclusion, detailsUrl: url, checkSuite: { workflowRun: structuredClone(run) } }) as RawCheckContext

const done = (name: string, conclusion: string): Job => ({ name, status: 'COMPLETED', conclusion })

// the superseded run as GitHub left it
const oldContexts = (): RawCheckContext[] => jobNames.map((name) =>
  actionsRun(oldRun, canceledJobs.includes(name) ? done(name, 'CANCELLED') : gateJobs.includes(name) ? done(name, 'FAILURE') : done(name, 'SUCCESS')))

// the run that replaced it, every job green
const newGreen = (): RawCheckContext[] => jobNames.map((name) => actionsRun(newRun, done(name, 'SUCCESS')))

// the run that replaced it while it is still going: the four long test jobs in progress, the two gates queued behind them
const newRunning = (): RawCheckContext[] => jobNames.map((name) => actionsRun(newRun,
  canceledJobs.includes(name) ? { name, status: 'IN_PROGRESS', conclusion: null } : gateJobs.includes(name) ? { name, status: 'QUEUED', conclusion: null } : done(name, 'SUCCESS')))

// the run that replaced it failing for real: one test job fails, and the two gates fail behind it
const failingUrl = 'https://github.com/octo-example/orbit/actions/runs/31000000102/job/93000009999'
const newFailing = (): RawCheckContext[] => jobNames.map((name) => name === 'Web unit tests'
  ? actionsRun(newRun, done(name, 'FAILURE'), failingUrl)
  : actionsRun(newRun, gateJobs.includes(name) ? done(name, 'FAILURE') : done(name, 'SUCCESS')))

const config: Config = { ...defaultConfig(), repo: scenario.repo, viewer: scenario.viewer }
const ctx: DeriveContext = { config, clock: { now: () => Date.parse(scenario.now) }, timeZone: scenario.timeZone }

const fixturePr = async (number: number): Promise<RawOpenPr> => {
  const pr = (await openPage1()).data.repository?.pullRequests.nodes.find((candidate) => candidate.number === number)
  assert.ok(pr, `#${number} is missing from the fixture`)
  return pr
}

const withContexts = (pr: RawOpenPr, nodes: RawCheckContext[], patch: Partial<RawOpenPr> = {}): RawOpenPr => {
  const copy = { ...structuredClone(pr), ...patch }
  const head = copy.headCommit.nodes[0]
  assert.ok(head)
  head.commit.statusCheckRollup = { contexts: { totalCount: nodes.length, nodes } }
  return copy
}

const ciChips = (issues: readonly Issue[]): string[] => issues.filter((issue) => issue.kind.startsWith('ci')).map((issue) => issue.label)
const chip = (issues: readonly Issue[], kind: string): Issue | undefined => issues.find((issue) => issue.kind === kind)

// #109 in the scenario is another author's PR that asks the viewer for review, with no changes requested and no conflicts
const reviewable = async (nodes: RawCheckContext[], patch: Partial<RawOpenPr> = {}): Promise<RawOpenPr> => withContexts(await fixturePr(109), nodes, patch)

test('the two-run rollup holds 78 contexts, 39 per run, which fits the page of 100', () => {
  const rollup = [...oldContexts(), ...newGreen()]
  assert.equal(rollup.length, 78)
  assert.ok(rollup.length <= 100)
})

test('with the new run green, the superseded run\'s canceled jobs and failed gates read as nothing', async () => {
  for (const nodes of [[...oldContexts(), ...newGreen()], [...newGreen(), ...oldContexts()]]) {
    const pr = await reviewable(nodes)
    assert.deepEqual(ciChips(deriveIssues(pr)), [])
    assert.equal(ciStateOf(pr), 'green')
    assert.equal(currentContexts(nodes).length, 39)
  }
})

test('with the new run still going, Issues shows CI running only', async () => {
  for (const nodes of [[...oldContexts(), ...newRunning()], [...newRunning(), ...oldContexts()]]) {
    const pr = await reviewable(nodes)
    // four test jobs in progress and two gates queued, all in the new run
    assert.deepEqual(ciChips(deriveIssues(pr)), ['CI running · 6'])
    assert.equal(ciStateOf(pr), 'pending')
  }
})

test('with the new run failing, CI failing counts and links to the new run\'s jobs only', async () => {
  for (const nodes of [[...oldContexts(), ...newFailing()], [...newFailing(), ...oldContexts()]]) {
    const pr = await reviewable(nodes)
    const issues = deriveIssues(pr)
    assert.deepEqual(ciChips(issues), ['CI failing · 3'])
    const failing = chip(issues, 'ciFailing')
    assert.equal(failing?.url, failingUrl)
    assert.equal(failing?.tip, 'Open the failing job: Web unit tests')
    assert.equal(ciStateOf(pr), 'failed')
  }
})

test('a newest run that was itself canceled still reads CI canceled, and one that really failed still reads CI failing', async () => {
  const canceled = jobNames.map((name) => actionsRun(newRun, canceledJobs.includes(name) ? done(name, 'CANCELLED') : done(name, 'SUCCESS')))
  const pr = await reviewable([...oldContexts(), ...canceled])
  assert.deepEqual(ciChips(deriveIssues(pr)), ['CI canceled · 4'])
  assert.equal(ciStateOf(pr), 'failed')
  // the old run alone, with nothing newer, is the current run and reads as it does today
  const alone = await reviewable(oldContexts())
  assert.deepEqual(ciChips(deriveIssues(alone)), ['CI failing · 2'])
})

test('newest is the higher run id, not the later place in the list or a later creation time', () => {
  // a run id that only grows decides, even against a creation time that reads older
  const skewed = { ...newRun, createdAt: '2026-10-26T10:00:00Z' }
  const nodes = [actionsRun(skewed, done('Unit', 'SUCCESS')), actionsRun(oldRun, done('Unit', 'FAILURE'))]
  assert.deepEqual(currentContexts(nodes).map((context) => context.__typename === 'CheckRun' ? context.checkSuite?.workflowRun?.databaseId : null), [newRun.databaseId])
})

test('of two attempts of one run, only the later attempt counts, and a creation time breaks a tie of run ids', () => {
  const first = { ...newRun, runAttempt: 1 }
  const second = { ...newRun, runAttempt: 2 }
  const nodes = [actionsRun(second, done('Unit', 'SUCCESS')), actionsRun(first, done('Unit', 'CANCELLED'))]
  assert.deepEqual(currentContexts(nodes).map((context) => context.__typename === 'CheckRun' ? context.conclusion : null), ['SUCCESS'])
  const earlier = { ...newRun, createdAt: '2026-10-26T10:58:00Z' }
  const tie = [actionsRun(earlier, done('Unit', 'FAILURE')), actionsRun(newRun, done('Unit', 'SUCCESS'))]
  assert.deepEqual(currentContexts(tie).map((context) => context.__typename === 'CheckRun' ? context.conclusion : null), ['SUCCESS'])
})

test('another workflow\'s older run is its own current run and is kept', async () => {
  const security = { databaseId: 31000000050, createdAt: '2026-10-26T09:00:00Z', runAttempt: 1, workflow: { databaseId: 111, name: 'Security scan' } }
  const pr = await reviewable([...oldContexts(), ...newGreen(), actionsRun(security, done('CodeQL', 'FAILURE'), 'https://example.test/codeql')])
  const issues = deriveIssues(pr)
  assert.deepEqual(ciChips(issues), ['CI failing · 1'])
  assert.equal(chip(issues, 'ciFailing')?.url, 'https://example.test/codeql')
})

test('a check run without run identity, a check run from outside GitHub Actions, and a commit status are kept as they are', async () => {
  // cached before the query asked for the run's id: the workflow's name only
  const unidentified = { __typename: 'CheckRun', name: 'Legacy', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://example.test/legacy', checkSuite: { workflowRun: { workflow: { name: workflow.name } } } } as RawCheckContext
  const external = { __typename: 'CheckRun', name: 'Vercel', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://example.test/vercel', checkSuite: { workflowRun: null } } as RawCheckContext
  const status = { __typename: 'StatusContext', context: 'ci/jenkins', state: 'PENDING', targetUrl: 'https://example.test/jenkins' } as RawCheckContext
  const nodes = [...oldContexts(), unidentified, ...newGreen(), external, status]
  const kept = currentContexts(nodes)
  assert.equal(kept.length, 39 + 3)
  assert.ok(kept.includes(unidentified) && kept.includes(external) && kept.includes(status))
  const pr = await reviewable(nodes)
  assert.deepEqual(ciChips(deriveIssues(pr)), ['CI failing · 2', 'CI running · 1'])
  assert.equal(chip(deriveIssues(pr), 'ciFailing')?.url, 'https://example.test/legacy')
  // a rollup with no run identity at all reads exactly as the whole list did
  const plain = [unidentified, external, status]
  assert.deepEqual(currentContexts(plain), plain)
})

test('a PR with one run per workflow reads as before', () => {
  const nodes = newFailing()
  assert.deepEqual(currentContexts(nodes), nodes)
})

test('pure rules: a superseded run neither keeps an approved, clean PR out of Ready to merge nor puts a reviewable one in Waiting on author', async () => {
  const approved = { reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' } as Partial<RawOpenPr>
  const groupOf = (pr: RawOpenPr): string | null => {
    const issues = deriveIssues(pr)
    return otherGroup(pr, issues, deriveMerge(pr, issues), config)
  }
  for (const nodes of [[...oldContexts(), ...newGreen()], [...newGreen(), ...oldContexts()]]) {
    const ready = await reviewable(nodes, approved)
    assert.equal(deriveMerge(ready, deriveIssues(ready)).state, 'ready')
    assert.equal(groupOf(ready), 'readyToMerge')
    // requested of the viewer, with only the superseded run failing: the viewer's move
    assert.equal(groupOf(await reviewable(nodes)), 'yourMove')
  }
  for (const nodes of [[...oldContexts(), ...newFailing()], [...newFailing(), ...oldContexts()]]) {
    // the new run failing for real waits on the author, approved or not
    assert.equal(groupOf(await reviewable(nodes, approved)), 'waitingOnAuthor')
    assert.equal(groupOf(await reviewable(nodes)), 'waitingOnAuthor')
  }
  // the new run still going withholds Merge without waiting on the author
  const running = await reviewable([...oldContexts(), ...newRunning()], approved)
  assert.notEqual(deriveMerge(running, deriveIssues(running)).state, 'ready')
  assert.notEqual(groupOf(running), 'waitingOnAuthor')
})

const page = async (nodes: RawCheckContext[], patch: Partial<RawOpenPr> = {}): Promise<RawOpenResponse> => {
  const raw = structuredClone(await openPage1())
  const repository = raw.data.repository
  assert.ok(repository)
  repository.pullRequests.nodes = [withContexts(await fixturePr(109), nodes, patch)]
  repository.pullRequests.pageInfo = { hasNextPage: false, endCursor: null }
  repository.pullRequests.totalCount = 1
  return raw
}

// the wiring: a gh answering the real open-PR query with the two-run rollup, read through fetchOpenPrs and the row builder
const rowsFrom = async (response: RawOpenResponse): Promise<{ rows: OpenRow[], query: string }> => {
  let query = ''
  const { runner } = fakeRunner(async (args) => {
    if (args[0] === 'auth' && args[1] === 'token') return ok('gho_fixture_token\n')
    if (args[0] === 'api' && args[1] === 'graphql') {
      query = field(args, 'query') ?? ''
      return ok(JSON.stringify(response))
    }
    return failed('unexpected call')
  })
  const prs: RawOpenPr[] = []
  const result = await fetchOpenPrs(createGh(runner), scenario.repo, (fetched) => { prs.push(...fetched.prs) })
  assert.equal(result.pages, 1)
  return { rows: deriveOpenRows(prs, scenario.defaultBranch, ctx), query }
}

test('the open-PR query asks for the workflow run\'s identity in the same call, and the row builder drops the superseded run', async () => {
  const { rows, query } = await rowsFrom(await page([...oldContexts(), ...newGreen()]))
  assert.match(query, /workflowRun \{ databaseId createdAt runAttempt workflow \{ databaseId name \} \}/)
  assert.match(query, /contexts\(first: 100\)/)
  const [row] = rows
  assert.ok(row)
  assert.deepEqual(ciChips(row.issues), [])
  // requested of the viewer with no CI failing: the viewer's move, not the author's
  assert.equal(row.group, 'yourMove')
})

test('a stale failed gate no longer keeps an approved, clean PR out of Ready to merge', async () => {
  const { rows } = await rowsFrom(await page([...oldContexts(), ...newGreen()], { reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' }))
  assert.equal(rows[0]?.group, 'readyToMerge')
  // the same PR with its new run failing for real waits on its author
  const { rows: failing } = await rowsFrom(await page([...oldContexts(), ...newFailing()], { reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' }))
  assert.equal(failing[0]?.group, 'waitingOnAuthor')
  assert.equal(chip(failing[0]?.issues ?? [], 'ciFailing')?.url, failingUrl)
})
