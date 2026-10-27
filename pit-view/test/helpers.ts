// test/helpers.ts
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clock } from '../src/config.ts'
import type { RawClosedResponse, RawOpenPr, RawOpenResponse, RawPrState, RawSingleResponse, Runner, RunOptions, RunResult } from '../src/github.ts'
import type { Timers } from '../src/poller.ts'
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
