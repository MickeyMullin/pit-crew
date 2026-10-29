// src/github.ts
import { spawn } from 'node:child_process'

// raw GraphQL shapes, exactly as gh prints them; derive.ts and cache.ts read these

export type RawActor = {
  __typename: 'User' | 'Bot' | 'Mannequin' | 'Organization' | 'EnterpriseUserAccount'
  login: string
  avatarUrl: string
}

// a login is enough where only identity matters (reviews, events)
export type RawLogin = { login: string }

export type RawPageInfo = { hasNextPage: boolean, endCursor: string | null }

export type RawReviewer =
  | { __typename: 'User', login: string }
  | { __typename: 'Bot', login: string }
  | { __typename: 'Team', name: string }
  | { __typename: 'Mannequin', login: string }

export type RawReviewRequest = { requestedReviewer: RawReviewer | null }

export type RawReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'

export type RawReview = {
  author: RawLogin | null
  state: RawReviewState
  // null only for a review still pending
  submittedAt: string | null
  commit: { oid: string } | null
}

export type RawCheckConclusion =
  | 'ACTION_REQUIRED' | 'CANCELLED' | 'FAILURE' | 'NEUTRAL' | 'SKIPPED'
  | 'STALE' | 'STARTUP_FAILURE' | 'SUCCESS' | 'TIMED_OUT'

export type RawCheckStatus = 'COMPLETED' | 'IN_PROGRESS' | 'PENDING' | 'QUEUED' | 'REQUESTED' | 'WAITING'

export type RawCheckRun = {
  __typename: 'CheckRun'
  name: string
  // null until the run completes
  conclusion: RawCheckConclusion | null
  status: RawCheckStatus
  detailsUrl: string | null
  // workflowRun is null for checks not created by GitHub Actions
  checkSuite: { workflowRun: { workflow: { name: string } } | null } | null
}

export type RawStatusState = 'ERROR' | 'EXPECTED' | 'FAILURE' | 'PENDING' | 'SUCCESS'

export type RawStatusContext = {
  __typename: 'StatusContext'
  context: string
  state: RawStatusState
  targetUrl: string | null
}

export type RawCheckContext = RawCheckRun | RawStatusContext

export type RawStatusCheckRollup = {
  contexts: { totalCount: number, nodes: RawCheckContext[] }
}

export type RawHeadCommit = {
  commit: {
    oid: string
    committedDate: string
    // null when the commit has no checks or statuses at all
    statusCheckRollup: RawStatusCheckRollup | null
  }
}

export type RawRecentCommit = { commit: { oid: string, committedDate: string } }

export type RawIssueRef = { number: number, title: string, url: string }

// timeline nodes, oldest first; the actor fields are null for deleted accounts
export type RawTimelineCommit = {
  __typename: 'PullRequestCommit'
  commit: { oid: string, committedDate: string, author: { name: string | null, user: RawLogin | null } | null }
}
export type RawTimelineReview = {
  __typename: 'PullRequestReview'
  author: RawLogin | null
  state: RawReviewState
  submittedAt: string | null
  createdAt: string
}
export type RawTimelineComment = { __typename: 'IssueComment', author: RawLogin | null, createdAt: string }
export type RawTimelineReviewRequested = {
  __typename: 'ReviewRequestedEvent'
  actor: RawLogin | null
  createdAt: string
  requestedReviewer: RawReviewer | null
}
export type RawTimelineReadyForReview = { __typename: 'ReadyForReviewEvent', actor: RawLogin | null, createdAt: string }
export type RawTimelineConvertToDraft = { __typename: 'ConvertToDraftEvent', actor: RawLogin | null, createdAt: string }
export type RawTimelineRenamedTitle = { __typename: 'RenamedTitleEvent', actor: RawLogin | null, createdAt: string }
export type RawTimelineForcePushed = {
  __typename: 'HeadRefForcePushedEvent'
  actor: RawLogin | null
  createdAt: string
  beforeCommit: { oid: string } | null
  afterCommit: { oid: string } | null
}

export type RawTimelineItem =
  | RawTimelineCommit
  | RawTimelineReview
  | RawTimelineComment
  | RawTimelineReviewRequested
  | RawTimelineReadyForReview
  | RawTimelineConvertToDraft
  | RawTimelineRenamedTitle
  | RawTimelineForcePushed

export type RawMergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
export type RawMergeStateStatus = 'BEHIND' | 'BLOCKED' | 'CLEAN' | 'DIRTY' | 'DRAFT' | 'HAS_HOOKS' | 'UNKNOWN' | 'UNSTABLE'
export type RawReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'

export type RawOpenPr = {
  number: number
  title: string
  url: string
  isDraft: boolean
  // null for a deleted account
  author: RawActor | null
  headRefName: string
  baseRefName: string
  headRefOid: string
  createdAt: string
  updatedAt: string
  additions: number
  deletions: number
  changedFiles: number
  mergeable: RawMergeable
  mergeStateStatus: RawMergeStateStatus
  // null when the repository requires no review and none decided it
  reviewDecision: RawReviewDecision | null
  // read only for the no-ticket marker; never displayed
  body: string
  reviewRequests: { nodes: RawReviewRequest[] }
  latestReviews: { nodes: RawReview[] }
  // the newest approving or change-requesting review per reviewer; GitHub keeps it when a re-request
  // drops the reviewer from latestReviews, so rules read both through derive.ts's latestReviewsOf
  latestOpinionatedReviews: { nodes: RawReview[] }
  // commits(last: 1): the head commit and its checks
  headCommit: { nodes: RawHeadCommit[] }
  // commits(last: 30), oldest first: counts pushes since a review
  recentCommits: { totalCount: number, nodes: RawRecentCommit[] }
  closingIssuesReferences: { nodes: RawIssueRef[] }
  timelineItems: { nodes: RawTimelineItem[] }
}

export type RawRateLimit = { cost: number, remaining: number, resetAt: string }

export type RawOpenResponse = {
  data: {
    rateLimit: RawRateLimit
    // null when the repository does not exist or is not visible to the token
    repository: {
      defaultBranchRef: { name: string } | null
      pullRequests: { totalCount: number, pageInfo: RawPageInfo, nodes: RawOpenPr[] }
    } | null
  }
}

export type RawPrState = 'OPEN' | 'CLOSED' | 'MERGED'

export type RawSingleResponse = {
  data: {
    rateLimit: RawRateLimit
    repository: {
      defaultBranchRef: { name: string } | null
      // null when no PR has that number
      pullRequest: (RawOpenPr & { state: RawPrState }) | null
    } | null
  }
}

export type RawClosedPr = {
  number: number
  title: string
  url: string
  author: RawActor | null
  state: 'CLOSED' | 'MERGED'
  merged: boolean
  mergedBy: RawLogin | null
  closedAt: string
  headRefName: string
  // read only for the no-ticket marker; never displayed
  body: string
  closingIssuesReferences: { nodes: RawIssueRef[] }
  // the closing event: who closed an unmerged PR (a merge also emits one)
  timelineItems: { nodes: { actor: RawLogin | null, createdAt: string }[] }
}

export type RawClosedResponse = {
  data: {
    rateLimit: RawRateLimit
    search: { issueCount: number, pageInfo: RawPageInfo, nodes: RawClosedPr[] }
  }
}

// what fetchOpenPrs hands to its callback, once per page as it arrives
export type OpenPage = {
  // 1-based
  page: number
  totalCount: number
  hasNextPage: boolean
  defaultBranch: string | null
  prs: RawOpenPr[]
  rateLimit: RawRateLimit
  // the parsed gh output, for the snapshots table
  raw: RawOpenResponse
}

// what fetchPr resolves with: the PR in the open-row shape, and whether it is still open
export type SinglePr = {
  state: RawPrState
  pr: RawOpenPr
  defaultBranch: string | null
  rateLimit: RawRateLimit
}

export type ClosedResult = {
  query: string
  from: string
  to: string
  prs: RawClosedPr[]
  // one parsed gh output per search page, for the snapshots table
  raw: RawClosedResponse[]
}

// the command runner every gh call goes through; tests pass a fake that replays fixtures

export type RunResult = { code: number, stdout: string, stderr: string }
export type RunOptions = { env?: Record<string, string> }
export type Runner = (args: string[], options?: RunOptions) => Promise<RunResult>

export type GhErrorKind = 'auth' | 'network' | 'rateLimit' | 'graphql' | 'command' | 'parse'

export class GhError extends Error {
  override name = 'GhError'
  kind: GhErrorKind
  stderr: string
  constructor (kind: GhErrorKind, message: string, stderr = '') {
    super(message)
    this.kind = kind
    this.stderr = stderr
  }
}

// a write that did not run because the account gh would write as could not be confirmed as the expected one: login is the account gh reported, or null when it could not be read at all
export class WriteIdentityError extends Error {
  override name = 'WriteIdentityError'
  login: string | null
  errorKind: GhErrorKind | null
  constructor (message: string, login: string | null, errorKind: GhErrorKind | null = null) {
    super(message)
    this.login = login
    this.errorKind = errorKind
  }
}

// spawns the real command; resolves with its exit code rather than rejecting on failure
export const commandRunner = (command: string): Runner => (args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
    }))
  })

const reviewerFields = '__typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { name }'
const actorFields = '__typename login avatarUrl'
const issueRefFields = 'closingIssuesReferences(first: 10) { nodes { number title url } }'

// every field an open row is derived from, shared by the open list and the one-PR refresh
const openPrFields = `number title url isDraft
author { ${actorFields} }
headRefName baseRefName headRefOid
createdAt updatedAt additions deletions changedFiles
mergeable mergeStateStatus reviewDecision
body
reviewRequests(first: 50) { nodes { requestedReviewer { ${reviewerFields} } } }
latestReviews(first: 50) { nodes { author { login } state submittedAt commit { oid } } }
latestOpinionatedReviews(first: 50) { nodes { author { login } state submittedAt commit { oid } } }
headCommit: commits(last: 1) {
  nodes {
    commit {
      oid committedDate
      statusCheckRollup {
        contexts(first: 100) {
          totalCount
          nodes {
            __typename
            ... on CheckRun { name conclusion status detailsUrl checkSuite { workflowRun { workflow { name } } } }
            ... on StatusContext { context state targetUrl }
          }
        }
      }
    }
  }
}
recentCommits: commits(last: 30) { totalCount nodes { commit { oid committedDate } } }
${issueRefFields}
timelineItems(last: 5, itemTypes: [PULL_REQUEST_COMMIT, PULL_REQUEST_REVIEW, ISSUE_COMMENT, REVIEW_REQUESTED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, RENAMED_TITLE_EVENT, HEAD_REF_FORCE_PUSHED_EVENT]) {
  nodes {
    __typename
    ... on PullRequestCommit { commit { oid committedDate author { name user { login } } } }
    ... on PullRequestReview { author { login } state submittedAt createdAt }
    ... on IssueComment { author { login } createdAt }
    ... on ReviewRequestedEvent { actor { login } createdAt requestedReviewer { ${reviewerFields} } }
    ... on ReadyForReviewEvent { actor { login } createdAt }
    ... on ConvertToDraftEvent { actor { login } createdAt }
    ... on RenamedTitleEvent { actor { login } createdAt }
    ... on HeadRefForcePushedEvent { actor { login } createdAt beforeCommit { oid } afterCommit { oid } }
  }
}`

export const openPrsQuery = `query OpenPullRequests($owner: String!, $name: String!, $first: Int!, $after: String) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequests(states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }, first: $first, after: $after) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        ${openPrFields}
      }
    }
  }
}`

// one PR by number, for a row's own refresh; state says whether it is still open
export const singlePrQuery = `query SinglePullRequest($owner: String!, $name: String!, $number: Int!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequest(number: $number) {
      state
      ${openPrFields}
    }
  }
}`

export const closedPrsQuery = `query ClosedPullRequests($q: String!, $first: Int!, $after: String) {
  rateLimit { cost remaining resetAt }
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title url
        author { ${actorFields} }
        state merged mergedBy { login } closedAt headRefName
        body
        ${issueRefFields}
        timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) { nodes { ... on ClosedEvent { actor { login } createdAt } } }
      }
    }
  }
}`

const classify = (stderr: string): GhErrorKind => {
  if (/HTTP 401|bad credentials|gh auth login|not logged in/i.test(stderr)) return 'auth'
  if (/rate limit|RATE_LIMITED|HTTP 429|secondary rate/i.test(stderr)) return 'rateLimit'
  if (/error connecting|dial tcp|no such host|timeout|timed out|connection (refused|reset)|network is unreachable|TLS handshake|HTTP 50[234]/i.test(stderr)) return 'network'
  return 'command'
}

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? ''

export type Gh = {
  // runs gh with the cached token, refreshing it once on a 401
  run: (args: string[]) => Promise<string>
  graphql: <T>(query: string, variables: Record<string, string | number | null>) => Promise<T>
  // a GitHub write as the expected account: reads one token, confirms with it that gh is signed in as that account, then runs the write with the same token. It runs at most once: a failure of the lookup or the write, a 401 included, is never retried and never meets another token. A mismatch or an unreadable account throws WriteIdentityError before anything is written. The optional check runs after the account is confirmed and before the write, reading through the same token; if it throws, nothing is written and its error propagates unchanged
  write: (args: string[], expected: string, check?: (read: (args: string[]) => Promise<string>) => Promise<void>) => Promise<string>
}

// holds the token in memory only; it is read once and again after any 401
export const createGh = (runner: Runner): Gh => {
  // shared while it is being read, so concurrent first calls ask gh once
  let token: Promise<string> | null = null

  // a runner that cannot start gh at all (not installed, not on PATH) rejects
  const spawnSafe = async (args: string[], options?: RunOptions): Promise<RunResult> => {
    try {
      return await runner(args, options)
    } catch (error) {
      throw new GhError('command', `cannot run gh: ${(error as Error).message}`)
    }
  }

  const readToken = async (): Promise<string> => {
    const result = await spawnSafe(['auth', 'token'])
    const value = result.stdout.trim()
    if (result.code !== 0 || value === '') {
      throw new GhError('auth', `gh auth token failed: ${firstLine(result.stderr) || 'no token'}`, result.stderr)
    }
    return value
  }

  const attempt = async (args: string[]): Promise<RunResult> => {
    const reading = token ??= readToken()
    let value: string
    try {
      value = await reading
    } catch (error) {
      // a failed read is not kept: the next call asks gh again
      if (token === reading) token = null
      throw error
    }
    return spawnSafe(args, { env: { GH_TOKEN: value } })
  }

  const runRaw = async (args: string[]): Promise<RunResult> => {
    let result = await attempt(args)
    if (result.code !== 0 && classify(result.stderr) === 'auth') {
      token = null
      result = await attempt(args)
    }
    return result
  }

  const run = async (args: string[]): Promise<string> => {
    const result = await runRaw(args)
    if (result.code !== 0) {
      throw new GhError(classify(result.stderr), `gh ${args[0]} failed: ${firstLine(result.stderr)}`, result.stderr)
    }
    return result.stdout
  }

  const write = async (args: string[], expected: string, check?: (read: (args: string[]) => Promise<string>) => Promise<void>): Promise<string> => {
    const reading = token ??= readToken()
    let value: string
    try {
      value = await reading
    } catch (error) {
      if (token === reading) token = null
      throw new WriteIdentityError(`cannot confirm which account gh uses: ${(error as Error).message}`, null, error instanceof GhError ? error.kind : null)
    }
    const forget = (result: RunResult): void => {
      // a 401 means the cached token is dead for the reads that follow; this write is not retried
      if (result.code !== 0 && classify(result.stderr) === 'auth') token = null
    }
    const env = { GH_TOKEN: value }
    let lookup: RunResult
    try {
      lookup = await spawnSafe(['api', 'user', '--jq', '.login'], { env })
    } catch (error) {
      throw new WriteIdentityError(`cannot confirm which account gh uses: ${(error as Error).message}`, null, error instanceof GhError ? error.kind : null)
    }
    forget(lookup)
    if (lookup.code !== 0) {
      throw new WriteIdentityError(`cannot confirm which account gh uses: gh api failed: ${firstLine(lookup.stderr)}`, null, classify(lookup.stderr))
    }
    const login = lookup.stdout.trim()
    if (login.toLowerCase() !== expected.toLowerCase()) {
      throw new WriteIdentityError(`gh is signed in as ${login || 'nobody'}, but the viewer is ${expected}; switch with gh auth switch before acting`, login)
    }
    if (check !== undefined) {
      // read-only, with the token that was just verified; a 401 here is not retried either
      await check(async (readArgs) => {
        const read = await spawnSafe(readArgs, { env })
        forget(read)
        if (read.code !== 0) throw new GhError(classify(read.stderr), `gh ${readArgs[0]} failed: ${firstLine(read.stderr)}`, read.stderr)
        return read.stdout
      })
    }
    const result = await spawnSafe(args, { env })
    forget(result)
    if (result.code !== 0) {
      throw new GhError(classify(result.stderr), `gh ${args[0]} failed: ${firstLine(result.stderr)}`, result.stderr)
    }
    return result.stdout
  }

  const graphql = async <T>(query: string, variables: Record<string, string | number | null>): Promise<T> => {
    const args = ['api', 'graphql', '-f', `query=${query}`]
    for (const [key, value] of Object.entries(variables)) {
      if (value === null) continue
      // -F sends numbers as numbers; -f keeps strings as strings
      args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`)
    }
    const result = await runRaw(args)
    let parsed: { data?: unknown, errors?: { type?: string, message: string }[] } | null = null
    try {
      parsed = JSON.parse(result.stdout)
    } catch {
      parsed = null
    }
    // gh exits non-zero on GraphQL errors and still prints the body
    const errors = parsed?.errors ?? []
    if (errors.length > 0) {
      const kind = errors.some((error) => error.type === 'RATE_LIMITED') ? 'rateLimit' : 'graphql'
      throw new GhError(kind, `GitHub GraphQL error: ${errors.map((error) => error.message).join('; ')}`, result.stderr)
    }
    if (result.code !== 0) {
      throw new GhError(classify(result.stderr), `gh api graphql failed: ${firstLine(result.stderr)}`, result.stderr)
    }
    if (parsed === null || parsed.data === undefined || parsed.data === null) {
      throw new GhError('parse', 'gh api graphql returned no data', result.stderr)
    }
    return parsed as T
  }

  return { run, graphql, write }
}

export const fetchViewerLogin = async (gh: Gh): Promise<string> =>
  (await gh.run(['api', 'user', '--jq', '.login'])).trim()

const splitRepo = (repo: string): { owner: string, name: string } => {
  const [owner, name, ...rest] = repo.split('/')
  if (!owner || !name || rest.length > 0) throw new GhError('command', `repo must look like owner/name, got ${repo}`)
  return { owner, name }
}

export type FetchOptions = { pageSize?: number }

// fetches open PRs most recently updated first, awaiting onPage for each page before asking
// for the next; a failure throws after the pages already delivered
export const fetchOpenPrs = async (
  gh: Gh,
  repo: string,
  onPage: (page: OpenPage) => void | Promise<void>,
  { pageSize = 100 }: FetchOptions = {},
): Promise<{ pages: number, totalCount: number }> => {
  const { owner, name } = splitRepo(repo)
  let after: string | null = null
  let page = 0
  let totalCount = 0
  for (;;) {
    const raw: RawOpenResponse = await gh.graphql<RawOpenResponse>(openPrsQuery, { owner, name, first: pageSize, after })
    const repository = raw.data.repository
    if (repository === null) throw new GhError('graphql', `repository ${repo} not found`)
    const { pullRequests } = repository
    page += 1
    totalCount = pullRequests.totalCount
    await onPage({
      page,
      totalCount,
      hasNextPage: pullRequests.pageInfo.hasNextPage,
      defaultBranch: repository.defaultBranchRef?.name ?? null,
      prs: pullRequests.nodes,
      rateLimit: raw.data.rateLimit,
      raw,
    })
    if (!pullRequests.pageInfo.hasNextPage) break
    if (pullRequests.pageInfo.endCursor === null || pullRequests.pageInfo.endCursor === after) {
      throw new GhError('parse', 'open PR pagination did not advance')
    }
    after = pullRequests.pageInfo.endCursor
  }
  return { pages: page, totalCount }
}

// one PR by number, in the same shape as an open-list node; its state is kept apart
export const fetchPr = async (gh: Gh, repo: string, number: number): Promise<SinglePr> => {
  const { owner, name } = splitRepo(repo)
  const raw = await gh.graphql<RawSingleResponse>(singlePrQuery, { owner, name, number })
  const repository = raw.data.repository
  if (repository === null) throw new GhError('graphql', `repository ${repo} not found`)
  if (repository.pullRequest === null) throw new GhError('graphql', `PR #${number} not found in ${repo}`)
  const { state, ...pr } = repository.pullRequest
  return { state, pr, defaultBranch: repository.defaultBranchRef?.name ?? null, rateLimit: raw.data.rateLimit }
}

// GitHub search takes second precision with an explicit offset
export const searchTime = (iso: string): string =>
  new Date(iso).toISOString().replace(/\.\d{3}Z$/, '+00:00')

export const closedSearchQuery = (repo: string, from: string, to: string): string =>
  `repo:${repo} is:pr is:closed closed:${searchTime(from)}..${searchTime(to)}`

// one search covering both Closed ranges; from is the start of Yesterday (Monday rule
// included) and to is now; resolves once every search page has arrived
export const fetchClosedPrs = async (
  gh: Gh,
  repo: string,
  from: string,
  to: string,
  { pageSize = 100 }: FetchOptions = {},
): Promise<ClosedResult> => {
  splitRepo(repo)
  const query = closedSearchQuery(repo, from, to)
  const raw: RawClosedResponse[] = []
  let after: string | null = null
  for (;;) {
    const response: RawClosedResponse = await gh.graphql<RawClosedResponse>(closedPrsQuery, { q: query, first: pageSize, after })
    raw.push(response)
    const { pageInfo } = response.data.search
    if (!pageInfo.hasNextPage) break
    if (pageInfo.endCursor === null || pageInfo.endCursor === after) {
      throw new GhError('parse', 'closed PR search pagination did not advance')
    }
    after = pageInfo.endCursor
  }
  // search nodes for non-PR results come back empty; keep only PRs
  const prs = raw.flatMap((response) => response.data.search.nodes).filter((node) => typeof node.number === 'number')
  return { query, from, to, prs, raw }
}
