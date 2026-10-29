// test/github.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  closedPrsQuery, closedSearchQuery, commandRunner, createGh, fetchClosedPrs, fetchOpenPrs, fetchViewerLogin,
  GhError, openPrsQuery, searchTime, singlePrQuery,
} from '../src/github.ts'
import type { OpenPage, RawClosedResponse, RawOpenPr, RawOpenResponse } from '../src/github.ts'
import { closedCases, openCases, scenario } from './fixtures/scenario.ts'
import { closedSearch, failed, fakeRunner, field, fixtureRunner, ok, openPage1, openPage2 } from './helpers.ts'

const graphqlCalls = (calls: { args: string[] }[]) => calls.filter((call) => call.args[1] === 'graphql')

test('open PRs arrive page by page, most recently updated first', async () => {
  const { runner, calls } = fixtureRunner()
  const pages: OpenPage[] = []
  const result = await fetchOpenPrs(createGh(runner), scenario.repo, (page) => {
    pages.push(page)
  }, { pageSize: scenario.pageSize })

  assert.deepEqual(result, { pages: 2, totalCount: scenario.openTotal })
  assert.deepEqual(pages.map((page) => [page.page, page.prs.length, page.hasNextPage]), [[1, 9, true], [2, 9, false]])
  assert.equal(pages[0]?.defaultBranch, 'main')
  assert.equal(pages[0]?.rateLimit.cost, 2)
  assert.deepEqual(pages[1]?.raw, await openPage2())

  const [first, second] = graphqlCalls(calls)
  assert.ok(first && second)
  assert.equal(field(first.args, 'owner'), 'octo-example')
  assert.equal(field(first.args, 'name'), 'orbit')
  assert.equal(field(first.args, 'first'), '9')
  assert.equal(field(first.args, 'after'), undefined)
  assert.equal(field(second.args, 'after'), scenario.page2After)
  // numbers go through -F so GitHub receives an Int
  assert.equal(first.args[first.args.indexOf('first=9') - 1], '-F')
})

test('the next page is not requested until the callback for this one settles', async () => {
  const { runner, calls } = fixtureRunner()
  const seen: number[] = []
  await fetchOpenPrs(createGh(runner), scenario.repo, async (page) => {
    seen.push(graphqlCalls(calls).length)
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(graphqlCalls(calls).length, page.page)
  }, { pageSize: scenario.pageSize })
  assert.deepEqual(seen, [1, 2])
})

test('the token is read once and passed to every gh api call', async () => {
  const { runner, calls } = fixtureRunner()
  const gh = createGh(runner)
  await fetchOpenPrs(gh, scenario.repo, () => {}, { pageSize: scenario.pageSize })
  assert.equal(await fetchViewerLogin(gh), scenario.viewer)
  const tokenCalls = calls.filter((call) => call.args.join(' ') === 'auth token')
  assert.equal(tokenCalls.length, 1)
  assert.equal(tokenCalls[0]?.options, undefined)
  for (const call of calls.filter((call) => call.args[0] === 'api')) {
    assert.deepEqual(call.options, { env: { GH_TOKEN: 'gho_fixture_token' } })
  }
})

test('concurrent first calls share one gh auth token, and a failed read is retried later', async () => {
  const { runner, calls } = fixtureRunner()
  const gh = createGh(runner)
  await Promise.all([
    fetchOpenPrs(gh, scenario.repo, () => {}, { pageSize: scenario.pageSize }),
    fetchClosedPrs(gh, scenario.repo, '2026-10-26T04:00:00Z', scenario.now),
  ])
  assert.equal(calls.filter((call) => call.args.join(' ') === 'auth token').length, 1)
  let reads = 0
  const flaky = fakeRunner((args) => {
    if (args[0] === 'auth') return (reads += 1) === 1 ? failed('gh: keychain locked') : ok('token-2')
    return ok(`${scenario.viewer}\n`)
  })
  const retrying = createGh(flaky.runner)
  await assert.rejects(fetchViewerLogin(retrying), (error) => error instanceof GhError && error.kind === 'auth')
  assert.equal(await fetchViewerLogin(retrying), scenario.viewer)
  assert.equal(reads, 2)
})

test('a 401 rereads the token and retries once', async () => {
  let tokens = 0
  let graphql = 0
  const { runner } = fakeRunner(async (args) => {
    if (args[0] === 'auth') return ok(`token-${(tokens += 1)}`)
    graphql += 1
    if (graphql === 1) return failed('HTTP 401: Bad credentials (https://api.github.com/graphql)')
    return ok(JSON.stringify(await openPage2()))
  })
  const pages: OpenPage[] = []
  await fetchOpenPrs(createGh(runner), scenario.repo, (page) => {
    pages.push(page)
  })
  assert.equal(tokens, 2)
  assert.equal(graphql, 2)
  assert.equal(pages.length, 1)
})

test('a second 401 gives up with an auth error', async () => {
  const { runner, calls } = fakeRunner((args) =>
    args[0] === 'auth' ? ok('stale-token') : failed('gh: Bad credentials (HTTP 401)'))
  await assert.rejects(
    fetchOpenPrs(createGh(runner), scenario.repo, () => {}),
    (error) => error instanceof GhError && error.kind === 'auth',
  )
  assert.equal(calls.length, 4)
})

test('a gh that cannot start is a command error', async () => {
  const { runner } = fakeRunner(() => Promise.reject(new Error('spawn gh ENOENT')))
  await assert.rejects(
    fetchViewerLogin(createGh(runner)),
    (error) => error instanceof GhError && error.kind === 'command' && /cannot run gh: spawn gh ENOENT/.test(error.message),
  )
})

test('a failing gh auth token is an auth error', async () => {
  const { runner } = fakeRunner(() => failed('You are not logged into any GitHub hosts. To log in, run: gh auth login'))
  await assert.rejects(
    fetchViewerLogin(createGh(runner)),
    (error) => error instanceof GhError && error.kind === 'auth' && /not logged into/.test(error.message),
  )
})

test('GraphQL errors are reported with GitHub\'s message', async () => {
  // gh prints the body to stdout, a summary to stderr, and exits 1
  const body = JSON.stringify({
    data: { repository: null },
    errors: [{ type: 'NOT_FOUND', path: ['repository'], message: 'Could not resolve to a Repository with the name \'octo-example/missing\'.' }],
  })
  const { runner } = fakeRunner((args) => args[0] === 'auth' ? ok('t') : failed('gh: Could not resolve to a Repository', body))
  await assert.rejects(
    fetchOpenPrs(createGh(runner), 'octo-example/missing', () => {}),
    (error) => error instanceof GhError && error.kind === 'graphql' && /Could not resolve/.test(error.message),
  )
})

test('a RATE_LIMITED GraphQL error is a rate limit error', async () => {
  const body = JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 1.' }] })
  const { runner } = fakeRunner((args) => args[0] === 'auth' ? ok('t') : failed('gh: API rate limit exceeded', body))
  await assert.rejects(
    fetchOpenPrs(createGh(runner), scenario.repo, () => {}),
    (error) => error instanceof GhError && error.kind === 'rateLimit',
  )
})

test('a network failure on page 2 throws after page 1 was delivered', async () => {
  const { runner } = fakeRunner(async (args) => {
    if (args[0] === 'auth') return ok('t')
    if (field(args, 'after') === undefined) return ok(JSON.stringify(await openPage1()))
    return failed('error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com')
  })
  const delivered: number[] = []
  await assert.rejects(
    fetchOpenPrs(createGh(runner), scenario.repo, (page) => {
      delivered.push(page.page)
    }, { pageSize: scenario.pageSize }),
    (error) => error instanceof GhError && error.kind === 'network' && error.stderr.includes('internet connection'),
  )
  assert.deepEqual(delivered, [1])
})

test('a missing repository without GraphQL errors still fails clearly', async () => {
  const { runner } = fakeRunner((args) => args[0] === 'auth'
    ? ok('t')
    : ok(JSON.stringify({ data: { rateLimit: { cost: 1, remaining: 1, resetAt: scenario.now }, repository: null } })))
  await assert.rejects(fetchOpenPrs(createGh(runner), scenario.repo, () => {}), /repository octo-example\/orbit not found/)
})

test('output that is not JSON is a parse error', async () => {
  const { runner } = fakeRunner((args) => args[0] === 'auth' ? ok('t') : ok('<html>proxy error</html>'))
  await assert.rejects(
    fetchOpenPrs(createGh(runner), scenario.repo, () => {}),
    (error) => error instanceof GhError && error.kind === 'parse',
  )
})

test('pagination that does not advance stops instead of looping', async () => {
  const page = await openPage1()
  const { runner } = fakeRunner((args) => args[0] === 'auth' ? ok('t') : ok(JSON.stringify(page)))
  let delivered = 0
  await assert.rejects(
    fetchOpenPrs(createGh(runner), scenario.repo, () => {
      delivered += 1
    }),
    /did not advance/,
  )
  assert.equal(delivered, 2)
})

test('a malformed repo is rejected before any gh call', async () => {
  const { runner, calls } = fixtureRunner()
  await assert.rejects(fetchOpenPrs(createGh(runner), 'orbit', () => {}), /owner\/name/)
  await assert.rejects(fetchClosedPrs(createGh(runner), 'a/b/c', scenario.yesterdayFrom, scenario.now), /owner\/name/)
  assert.equal(calls.length, 0)
})

test('search times use second precision and an explicit offset', () => {
  assert.equal(searchTime('2026-10-23T04:00:00Z'), '2026-10-23T04:00:00+00:00')
  assert.equal(searchTime('2026-10-26T14:05:38.123Z'), '2026-10-26T14:05:38+00:00')
  assert.equal(
    closedSearchQuery(scenario.repo, scenario.yesterdayFrom, scenario.now),
    'repo:octo-example/orbit is:pr is:closed closed:2026-10-23T04:00:00+00:00..2026-10-26T14:05:38+00:00',
  )
})

test('the closed search covers both ranges in one query', async () => {
  const { runner, calls } = fixtureRunner()
  const result = await fetchClosedPrs(createGh(runner), scenario.repo, scenario.yesterdayFrom, scenario.now)
  const [call] = graphqlCalls(calls)
  assert.ok(call)
  assert.equal(field(call.args, 'q'), result.query)
  assert.equal(field(call.args, 'first'), '100')
  assert.equal(result.from, scenario.yesterdayFrom)
  assert.equal(result.to, scenario.now)
  assert.deepEqual(result.prs.map((pr) => pr.number), [100, 93, 99, 97, 96, 98, 95, 94])
  assert.deepEqual(result.raw, [await closedSearch()])
})

test('the closed search follows pages and skips non-PR results', async () => {
  const full = await closedSearch()
  const nodes = full.data.search.nodes
  const pageOf = (slice: unknown[], hasNextPage: boolean, endCursor: string): RawClosedResponse => ({
    data: { rateLimit: full.data.rateLimit, search: { issueCount: nodes.length, pageInfo: { hasNextPage, endCursor }, nodes: slice as RawClosedResponse['data']['search']['nodes'] } },
  })
  const { runner, calls } = fakeRunner((args) => {
    if (args[0] === 'auth') return ok('t')
    return field(args, 'after') === undefined
      ? ok(JSON.stringify(pageOf([...nodes.slice(0, 3), {}], true, 'c1')))
      : ok(JSON.stringify(pageOf(nodes.slice(3), false, 'c2')))
  })
  const result = await fetchClosedPrs(createGh(runner), scenario.repo, scenario.yesterdayFrom, scenario.now, { pageSize: 3 })
  assert.equal(result.prs.length, nodes.length)
  assert.equal(result.raw.length, 2)
  assert.equal(field(graphqlCalls(calls)[1]?.args ?? [], 'after'), 'c1')
})

test('the queries name the operations the fixtures are keyed by', () => {
  assert.match(openPrsQuery, /^query OpenPullRequests\(/)
  assert.match(openPrsQuery, /orderBy: \{ field: UPDATED_AT, direction: DESC \}/)
  assert.match(closedPrsQuery, /^query ClosedPullRequests\(/)
})

test('the open list and the one-PR refresh both ask for the reviews a re-request leaves out of latestReviews', () => {
  for (const query of [openPrsQuery, singlePrQuery]) {
    assert.match(query, /latestReviews\(first: 50\) \{ nodes \{ author \{ login \} state submittedAt commit \{ oid \} \} \}/)
    assert.match(query, /latestOpinionatedReviews\(first: 50\) \{ nodes \{ author \{ login \} state submittedAt commit \{ oid \} \} \}/)
  }
})

test('commandRunner reports exit code, stdout, stderr and extra env', async () => {
  const run = commandRunner(process.execPath)
  const script = 'process.stdout.write(process.env.GH_TOKEN + " " + process.env.GH_PROMPT_DISABLED); process.stderr.write("oops"); process.exit(3)'
  assert.deepEqual(await run(['-e', script], { env: { GH_TOKEN: 'abc' } }), { code: 3, stdout: 'abc 1', stderr: 'oops' })
  await assert.rejects(commandRunner('pit-view-no-such-command')([]), /ENOENT/)
})

// the fixtures are a contract for the cache and derivation tests; keep them coherent

const allOpen = async (): Promise<RawOpenPr[]> => [
  ...(await openPage1()).data.repository?.pullRequests.nodes ?? [],
  ...(await openPage2()).data.repository?.pullRequests.nodes ?? [],
]

test('fixture pages are ordered by updatedAt and cover every documented case', async () => {
  const page1: RawOpenResponse = await openPage1()
  const prs = await allOpen()
  assert.equal(page1.data.repository?.pullRequests.totalCount, prs.length)
  const updated = prs.map((pr) => Date.parse(pr.updatedAt))
  assert.deepEqual(updated, [...updated].sort((a, b) => b - a))
  assert.deepEqual(prs.map((pr) => pr.number).sort(), Object.keys(openCases).map(Number).sort())
  const closed = (await closedSearch()).data.search.nodes
  assert.deepEqual(closed.map((pr) => pr.number).sort(), Object.keys(closedCases).map(Number).sort())
  for (const pr of closed) {
    const at = Date.parse(pr.closedAt)
    assert.ok(at >= Date.parse(scenario.yesterdayFrom) && at <= Date.parse(scenario.now), `#${pr.number} closed in range`)
    assert.equal(pr.merged, pr.state === 'MERGED')
  }
})

test('fixture commits agree with each PR\'s head', async () => {
  for (const pr of await allOpen()) {
    const head = pr.headCommit.nodes[0]?.commit
    const recent = pr.recentCommits.nodes
    assert.equal(head?.oid, pr.headRefOid, `#${pr.number} headCommit`)
    assert.equal(recent.at(-1)?.commit.oid, pr.headRefOid, `#${pr.number} recentCommits`)
    assert.equal(pr.url, `https://github.com/${scenario.repo}/pull/${pr.number}`)
    assert.match(pr.headRefOid, /^[0-9a-f]{40}$/)
  }
})
