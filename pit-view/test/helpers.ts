// test/helpers.ts
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clock } from '../src/config.ts'
import type { RawClosedResponse, RawOpenPr, RawOpenResponse, RawPrState, RawSingleResponse, Runner, RunOptions, RunResult } from '../src/github.ts'
import { systemFs } from '../src/launcher.ts'
import type { Exit, LauncherFs, ProcessEntry, SpawnRequest } from '../src/launcher.ts'
import type { Timers } from '../src/poller.ts'
import type { LaunchDeps } from '../src/server.ts'
import { scenario } from './fixtures/scenario.ts'

const fixtures = join(import.meta.dirname, 'fixtures')

export const readFixture = async <T>(name: string): Promise<T> =>
  JSON.parse(await readFile(join(fixtures, name), 'utf8')) as T

export const openPage1 = (): Promise<RawOpenResponse> => readFixture('open-page-1.json')
export const openPage2 = (): Promise<RawOpenResponse> => readFixture('open-page-2.json')
export const closedSearch = (): Promise<RawClosedResponse> => readFixture('closed.json')

// one PR as the SinglePullRequest query returns it: a fixture node, changed by patch, in a state
export const singlePr = async (number: number, { state = 'OPEN', patch = {} }: { state?: RawPrState, patch?: Partial<RawOpenPr> } = {}): Promise<RawSingleResponse> => {
  const nodes = [...(await openPage1()).data.repository!.pullRequests.nodes, ...(await openPage2()).data.repository!.pullRequests.nodes]
  const pr = nodes.find((node) => node.number === number)
  return {
    data: {
      rateLimit: { cost: 1, remaining: 4990, resetAt: '2026-10-26T15:00:00Z' },
      repository: { defaultBranchRef: { name: scenario.defaultBranch }, pullRequest: pr === undefined ? null : { ...pr, ...patch, state } },
    },
  }
}

export const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' })
export const failed = (stderr: string, stdout = ''): RunResult => ({ code: 1, stdout, stderr })

export type Call = { args: string[], options: RunOptions | undefined }
export type FakeRunner = { runner: Runner, calls: Call[] }

// records every call and answers it with the handler's result
export const fakeRunner = (handler: (args: string[], call: number) => RunResult | Promise<RunResult>): FakeRunner => {
  const calls: Call[] = []
  const runner: Runner = async (args, options) => {
    calls.push({ args, options })
    return handler(args, calls.length)
  }
  return { runner, calls }
}

// reads a -f/-F field such as after=... from a recorded gh api graphql call
export const field = (args: string[], name: string): string | undefined =>
  args.find((arg, index) => index > 0 && (args[index - 1] === '-f' || args[index - 1] === '-F') && arg.startsWith(`${name}=`))
    ?.slice(name.length + 1)

// a gh that answers like GitHub would for the invented scenario
export const fixtureRunner = (): FakeRunner =>
  fakeRunner(async (args) => {
    if (args[0] === 'auth' && args[1] === 'token') return ok('gho_fixture_token\n')
    if (args[0] === 'api' && args[1] === 'user') return ok(`${scenario.viewer}\n`)
    if (args[0] === 'api' && args[1] === 'graphql') {
      const query = field(args, 'query') ?? ''
      if (query.includes('query OpenPullRequests')) {
        const after = field(args, 'after')
        if (after === undefined) return ok(JSON.stringify(await openPage1()))
        if (after === scenario.page2After) return ok(JSON.stringify(await openPage2()))
      }
      if (query.includes('query ClosedPullRequests')) return ok(JSON.stringify(await closedSearch()))
      if (query.includes('query SinglePullRequest')) return ok(JSON.stringify(await singlePr(Number(field(args, 'number')))))
    }
    return failed(`fixture runner has no answer for: gh ${args.slice(0, 2).join(' ')}`)
  })

// a fresh directory under the OS temp dir, removed by the returned cleanup
export const tempDir = async (): Promise<{ dir: string, cleanup: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), 'pit-view-test-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

export type FakeTime = {
  clock: Clock
  timers: Timers
  // moves the clock forward, running every timer that falls due on the way, in time order
  advance: (ms: number) => void
  // timers set and not yet run or cleared
  pending: () => number
}

// a clock and timers that move only when the test says so
export const fakeTime = (start: string = scenario.now): FakeTime => {
  let now = Date.parse(start)
  let nextId = 1
  const tasks = new Map<number, { at: number, run: () => void }>()
  const timers: Timers = {
    set: (run, ms) => {
      const id = nextId
      nextId += 1
      tasks.set(id, { at: now + Math.max(0, ms), run })
      return id
    },
    clear: (handle) => {
      tasks.delete(handle as number)
    },
  }
  const advance = (ms: number): void => {
    const target = now + ms
    for (;;) {
      const due = [...tasks.entries()].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (due === undefined) break
      tasks.delete(due[0])
      now = due[1].at
      due[1].run()
    }
    now = target
  }
  return { clock: { now: () => now }, timers, advance, pending: () => tasks.size }
}

export type GatedRunner = FakeRunner & { release: () => void, hold: () => void }

// holds every gh api call until release, so a test can act while a cycle is in flight
export const gatedRunner = (base: FakeRunner): GatedRunner => {
  let open = false
  const waiting: (() => void)[] = []
  const runner: Runner = async (args, options) => {
    if (args[0] === 'api' && !open) await new Promise<void>((resolve) => waiting.push(resolve))
    return base.runner(args, options)
  }
  return {
    runner,
    calls: base.calls,
    release: () => {
      open = true
      for (const resume of waiting.splice(0)) resume()
    },
    hold: () => {
      open = false
    },
  }
}

// the gh api calls a runner has answered: every one of them reached GitHub
export const githubCalls = (fake: FakeRunner): Call[] => fake.calls.filter((call) => call.args[0] === 'api')

// launching runs with nothing real behind it: no runner, no ps, no signals reach a process

export type FakeChild = {
  request: SpawnRequest
  pid: number
  // what the launcher wrote to stdin, and whether it closed it
  writes: string[]
  stdinEnded: boolean
  // the --emit-json folder the request names
  runDir: string
  // lines the runner prints (stream.jsonl) and the command appends (events.jsonl)
  stream: (...events: unknown[]) => Promise<void>
  events: (...events: unknown[]) => Promise<void>
  // writes result.json as the command's last act
  result: (value: unknown) => Promise<void>
  exit: (code?: number | null, signal?: string | null) => void
}

export type Kill = { pid: number, signal: NodeJS.Signals | 0 }

export type FakeLaunch = {
  deps: LaunchDeps
  children: FakeChild[]
  // signals sent, signal 0 (liveness checks) left out
  kills: Kill[]
  // what the fake ps lists, and which pids are alive
  processes: ProcessEntry[]
  alive: Set<number>
  // runners that ignore SIGTERM, so a stop has to escalate
  ignoreTerm: Set<number>
  gitCalls: string[][]
  removed: string[]
  // spawn throws this when set
  spawnError: Error | null
}

export const fakeRemotes = (repo: string): string =>
  `origin\tgit@github.com:${repo}.git (fetch)\norigin\tgit@github.com:${repo}.git (push)\n`

// the run folder a request names, from Claude's stdin line or Codex's prompt argument
const runDirOf = (text: string): string => /--emit-json=(\S+?)(?:\\n|"|\s|$)/.exec(text)?.[1] ?? ''

export const fakeLaunch = ({ remotes = fakeRemotes('octo-example/orbit'), fs = {} }: { remotes?: string | null, fs?: Partial<LauncherFs> } = {}): FakeLaunch => {
  let nextPid = 4000
  const fake: FakeLaunch = {
    deps: undefined as unknown as LaunchDeps,
    children: [],
    kills: [],
    processes: [],
    alive: new Set(),
    ignoreTerm: new Set(),
    gitCalls: [],
    removed: [],
    spawnError: null,
  }
  const lines = (values: unknown[]): string => values.map((value) => `${typeof value === 'string' ? value : JSON.stringify(value)}\n`).join('')
  const deps: LaunchDeps = {
    spawn: (request) => {
      if (fake.spawnError !== null) throw fake.spawnError
      nextPid += 1
      const pid = nextPid
      let finish: (exit: Exit) => void = () => {}
      const exited = new Promise<Exit>((resolve) => {
        finish = resolve
      })
      const writes: string[] = []
      const child: FakeChild = {
        request,
        pid,
        writes,
        stdinEnded: false,
        runDir: runDirOf(request.stdin === 'pipe' ? '' : request.args.at(-1) ?? ''),
        stream: (...events) => appendFile(request.stdoutPath, lines(events)),
        events: (...events) => appendFile(join(child.runDir, 'events.jsonl'), lines(events)),
        result: (value) => writeFile(join(child.runDir, 'result.json'), typeof value === 'string' ? value : JSON.stringify(value)),
        exit: (code = 0, signal = null) => {
          fake.alive.delete(pid)
          finish({ code, signal, error: null })
        },
      }
      fake.alive.add(pid)
      fake.processes.push({ pid, ppid: 1, pgid: pid })
      fake.children.push(child)
      return {
        pid,
        stdin: request.stdin === 'pipe'
          ? {
              write: (text) => {
                writes.push(text)
                if (child.runDir === '') child.runDir = runDirOf(text)
              },
              end: () => {
                child.stdinEnded = true
              },
            }
          : null,
        exited,
      }
    },
    fs: {
      ...systemFs,
      // tests read the files when they say so, through launcher.check
      watch: () => ({ close: () => {} }),
      rm: async (path) => {
        // the pre-spawn write probe cleans up after itself; only folder removals are recorded
        if (!path.endsWith('.write-probe')) fake.removed.push(path)
        await systemFs.rm(path)
      },
      ...fs,
    },
    kill: (pid, signal) => {
      if (signal === 0) {
        if (!fake.alive.has(pid)) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
        return
      }
      fake.kills.push({ pid, signal })
      // a negative pid is a process group
      const group = pid < 0 ? fake.processes.filter((entry) => entry.pgid === -pid).map((entry) => entry.pid) : [pid]
      for (const member of group) {
        if (signal === 'SIGTERM' && fake.ignoreTerm.has(member)) continue
        fake.alive.delete(member)
        fake.children.find((child) => child.pid === member)?.exit(null, signal)
      }
    },
    procs: {
      list: async () => fake.processes,
      startTime: async (pid) => fake.alive.has(pid) ? `start-${pid}` : null,
    },
    git: async (args) => {
      fake.gitCalls.push(args)
      if (remotes === null) return failed('fatal: not a git repository (or any of the parent directories): .git')
      return ok(remotes)
    },
    env: { PATH: '/usr/bin:/bin', USER: 'tester', LANG: 'en_US.UTF-8', CLAUDE_CODE_ENTRYPOINT: 'desktop', ANTHROPIC_API_KEY: 'sk-fake' },
    newSessionId: () => '00000000-0000-4000-8000-000000000001',
  }
  fake.deps = deps
  return fake
}

// a review-result@1 as the commands write it, changed by patch
export const reviewResult = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'pit-crew/review-result@1',
  command: 'review-pr',
  status: 'done',
  target: { repo: 'octo-example/orbit', pr: 106 },
  reviewed: { kind: 'commit', sha: 'f00dfacecafebeefdeadbeef0123456789abcdef' },
  verdict: 'changesRequested',
  recommendation: null,
  findings: [{ priority: 'P1', summary: 'Retry loop never backs off', files: ['src/retry.ts'] }],
  ci: 'green',
  fixAttempts: 0,
  posted: { form: 'requestChanges', url: 'https://github.com/octo-example/orbit/pull/106#pullrequestreview-1' },
  notPostedReason: null,
  report: '~/agents/output/PR-106.md',
  question: null,
  error: null,
  ...patch,
})

// an invented fix-pr result: a fix of #101 that pushed two commits answering two of three requests
export const fixHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1'
export const fixPushedHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2'
export const fixCommits = ['cccccccccccccccccccccccccccccccccccccc01', fixPushedHead]

export const fixRequest = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'PRRT_example1', kind: 'thread', author: 'alex-mendez', path: 'src/retry.ts', line: 12, outdated: false,
  url: 'https://github.com/octo-example/orbit/pull/101#discussion_r1', summary: 'Back off between retries', triage: 'clear', outcome: 'fixed',
  commits: [fixCommits[0]], ...patch,
})

export const fixResult = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'pit-crew/fix-result@1',
  command: 'fix-pr',
  status: 'done',
  target: { repo: 'octo-example/orbit', pr: 101, branch: 'fix/webhook-retry' },
  head: { sha: fixHead },
  requests: [
    fixRequest(),
    fixRequest({ id: 'PRRT_example2', line: 40, outdated: true, url: 'https://github.com/octo-example/orbit/pull/101#discussion_r2', summary: 'Log the attempt number', commits: [fixPushedHead] }),
    fixRequest({ id: 'PRR_example3', kind: 'review', path: null, line: null, url: 'https://github.com/octo-example/orbit/pull/101#pullrequestreview-3', summary: 'Split the handler', triage: 'outOfScope', outcome: 'notFixed', commits: [] }),
  ],
  checks: [{ name: 'pnpm test', result: 'passed' }, { name: 'pnpm check', result: 'passed' }],
  pushed: { branch: 'fix/webhook-retry', head: fixPushedHead, commits: [{ sha: fixCommits[0], subject: 'Back off between retries' }, { sha: fixPushedHead, subject: 'Log the attempt number' }] },
  notPushedReason: null,
  worktree: null,
  report: '~/agents/output/FIX-101.md',
  question: null,
  error: null,
  ...patch,
})

// invented sweep rows: two Dependabot PRs of the fixture repo, each at a full 40-character head
export const sweepHead201 = '2010000000000000000000000000000000000201'
export const sweepHead202 = '2020000000000000000000000000000000000202'

export const sweepRow = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 201,
  url: 'https://github.com/octo-example/orbit/pull/201',
  title: 'build(deps): bump left-pad from 1.2.0 to 1.2.1',
  head: sweepHead201,
  bump: 'left-pad 1.2.0 → 1.2.1 (patch)',
  recommendation: 'approve',
  ci: 'green',
  findings: [],
  escalation: null,
  posted: { form: 'approve', url: 'https://github.com/octo-example/orbit/pull/201#pullrequestreview-9' },
  reused: false,
  report: '~/agents/output/PR-201.md',
  notes: 'approved',
  ...patch,
})

// an invented sweep-result@1: two PRs swept, one approved and one held, with a merge order
export const sweepResult = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'pit-crew/sweep-result@1',
  command: 'review-dependabot-sweep',
  status: 'done',
  repo: 'octo-example/orbit',
  counts: { swept: 2, fresh: 1, reused: 1, failed: 0 },
  rows: [
    sweepRow(),
    sweepRow({
      number: 202,
      url: 'https://github.com/octo-example/orbit/pull/202',
      title: 'build(deps): bump right-pad from 2.0.0 to 3.0.0',
      head: sweepHead202,
      bump: 'right-pad 2.0.0 → 3.0.0 (major)',
      recommendation: 'hold',
      ci: 'failed',
      findings: [{ priority: 'P1', summary: 'Drops the callback form the importer still uses' }],
      escalation: 'a major version of a runtime dependency',
      posted: null,
      reused: true,
      report: '~/agents/output/PR-202.md',
      notes: 'CI failed in the importer tests; unchanged since Oct 25',
    }),
  ],
  mergeOrder: [{ action: 'Merge #201', prs: [201] }, { action: 'Hold #202 until the importer moves off the callback form', prs: [202] }],
  summary: '~/agents/output/dependabot-sweep-octo-example-orbit-2026-10-26.md',
  question: null,
  error: null,
  ...patch,
})

// a sweep with nothing to sweep: done, every count zero, no rows, and no summary
export const emptySweepResult = (): Record<string, unknown> => sweepResult({ counts: { swept: 0, fresh: 0, reused: 0, failed: 0 }, rows: [], mergeOrder: [], summary: null })
