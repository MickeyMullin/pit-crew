// test/scheduler.test.ts
// the auto-review scheduler's runtime (section 10 of DESIGN.md): its own clock, the tick's steps, the launch through the launcher's engine, the worktrees, recovery, and the endpoints, all against a fake gh, a fake git, a fake clock, and a fake runner
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { defaultAutoReview, toAutoRun, toAutoSweep } from '../src/autoreview.ts'
import type { AutoReviewSettings } from '../src/autoreview.ts'
import type { Run, Sweep } from '../src/cache.ts'
import type { Config } from '../src/config.ts'
import type { Runner } from '../src/github.ts'
import type { Patch } from '../src/poller.ts'
import { startServer } from '../src/server.ts'
import type { PitServer } from '../src/server.ts'
import { sweepRequest } from '../src/sweeps.ts'
import { scenario } from './fixtures/scenario.ts'
import { failed, fakeLaunch, fakeRemotes, fakeTime, fixtureRunner, ok, quiet, reviewResult, sweepResult, sweepRow, tempDir, waitFor } from './helpers.ts'
import type { FakeChild, FakeLaunch, FakeTime } from './helpers.ts'

const minute = 60_000
// a Monday at 10:05 in the machine's zone, inside the default active hours
const insideHours = scenario.now
// a Saturday at 10:00 in the machine's zone
const saturday = '2026-10-24T14:00:00Z'

type GitCall = { args: string[], env: Readonly<Record<string, string>> | undefined }

// a git that keeps the worktrees of one clone as git would: added and removed by path, and listed resolved
const fakeGit = (clone: string, repo: string = scenario.repo) => {
  const state = {
    calls: [] as GitCall[],
    worktrees: new Set<string>(),
    // how many fetches fail before one succeeds
    fetchFailures: 0,
    addFails: false,
    // paths, by their last part, whose removal git refuses
    refuse: new Set<string>(),
    holdFetch: null as Promise<void> | null,
    holdAdd: null as Promise<void> | null,
    holdRevParse: null as Promise<void> | null,
    remotes: fakeRemotes(repo) as string | null,
  }
  const name = (path: string): string => basename(path)
  const runner: Runner = async (args, options) => {
    state.calls.push({ args, env: options?.env })
    if (args[0] !== '-C') return failed('usage')
    const verb = args.slice(2)
    if (verb[0] === 'remote') return state.remotes === null ? failed('fatal: not a git repository') : ok(state.remotes)
    if (verb[0] === 'fetch') {
      if (state.holdFetch !== null) await state.holdFetch
      if (state.fetchFailures > 0) {
        state.fetchFailures -= 1
        return failed('error: cannot lock ref refs/remotes/origin/main: is at abc but expected def')
      }
      return ok('')
    }
    if (verb[0] === 'rev-parse' && state.holdRevParse !== null) await state.holdRevParse
    if (verb[0] === 'rev-parse') return ok(`${clone}/.git/worktrees/${name(args[1] ?? '')}\n`)
    if (verb[0] === 'worktree' && verb[1] === 'add') {
      if (state.holdAdd !== null) await state.holdAdd
      if (state.addFails) return failed('fatal: invalid reference: origin/main')
      const path = verb[3] ?? ''
      await mkdir(path, { recursive: true })
      state.worktrees.add(await realpath(path))
      return ok('')
    }
    if (verb[0] === 'worktree' && verb[1] === 'remove') {
      const path = verb[2] ?? ''
      if (state.refuse.has(name(path))) return failed(`fatal: '${path}' contains modified or untracked files, use --force to delete it`)
      const known = [...state.worktrees].find((entry) => name(entry) === name(path))
      if (known === undefined) return failed(`fatal: '${path}' is not a working tree`)
      state.worktrees.delete(known)
      await rm(known, { recursive: true, force: true })
      return ok('')
    }
    if (verb[0] === 'worktree' && verb[1] === 'list') {
      return ok([clone, ...state.worktrees].map((path) => `worktree ${path}\nHEAD 0000000\ndetached\n`).join('\n'))
    }
    if (verb[0] === 'worktree' && verb[1] === 'prune') return ok('')
    return failed(`fake git has no answer for: ${verb.join(' ')}`)
  }
  const verbs = (...words: string[]): GitCall[] => state.calls.filter((call) => words.every((word, index) => call.args[index + 2] === word))
  return { state, runner, verbs }
}

type World = {
  server: PitServer
  time: FakeTime
  launch: FakeLaunch
  git: ReturnType<typeof fakeGit>
  gh: { login: string | null, failCycle: boolean, hold: Promise<void> | null, calls: string[][] }
  home: string
  clone: string
  worktrees: string
  restart: () => Promise<void>
  cleanup: () => Promise<void>
}

const headers = (world: World): Record<string, string> => ({ 'Content-Type': 'application/json', Origin: world.server.url, 'x-pit-view-token': world.server.token })

const setup = async ({ auto = {}, config = {}, now = insideHours, noKey = false, before }: {
  auto?: Partial<AutoReviewSettings>
  config?: Partial<Config>
  now?: string
  noKey?: boolean
  before?: (world: { home: string, clone: string, git: ReturnType<typeof fakeGit> }) => Promise<void> | void
} = {}): Promise<World> => {
  const { dir: home, cleanup: removeHome } = await tempDir()
  const clone = join(home, 'dev', 'orbit')
  await mkdir(clone, { recursive: true })
  const configPath = join(home, '.config', 'pit-view', 'config.json')
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, JSON.stringify({
    repo: scenario.repo,
    viewer: scenario.viewer,
    cloneDir: '~/dev/orbit',
    ...(noKey ? {} : { autoReview: { ...defaultAutoReview(), enabled: true, ...auto } }),
    ...config,
  }), 'utf8')
  const stateDir = join(home, '.local', 'state', 'pit-view')
  const git = fakeGit(clone)
  if (before !== undefined) await before({ home, clone, git })
  const time = fakeTime(now)
  const launch = fakeLaunch()
  launch.deps.git = git.runner
  const base = fixtureRunner()
  const gh = { login: scenario.viewer as string | null, failCycle: false, hold: null as Promise<void> | null, calls: [] as string[][] }
  const runner: Runner = async (args, options) => {
    gh.calls.push(args)
    if (args[0] === 'api' && args[1] === 'user') return gh.login === null ? failed('gh: not logged in') : ok(`${gh.login}\n`)
    if (args[0] === 'api' && args[1] === 'graphql' && gh.hold !== null) await gh.hold
    if (args[0] === 'api' && args[1] === 'graphql' && gh.failCycle) return failed('HTTP 502: Bad Gateway')
    return base.runner(args, options)
  }
  const boot = (): Promise<PitServer> => startServer({
    home,
    port: 0,
    runner,
    clock: time.clock,
    timers: time.timers,
    timeZone: scenario.timeZone,
    configPath,
    cachePath: join(stateDir, 'cache.sqlite'),
    stateDir,
    publicDir: join(home, 'public'),
    launch: launch.deps,
    log: () => {},
    pageSize: scenario.pageSize,
  })
  const world: World = {
    server: await boot(),
    time,
    launch,
    git,
    gh,
    home,
    clone,
    worktrees: join(stateDir, 'worktrees'),
    restart: async () => {
      await world.server.close()
      world.server = await boot()
      await world.server.scheduler.idle()
    },
    cleanup: async () => {
      await world.server.close()
      await removeHome()
    },
  }
  await world.server.scheduler.idle()
  return world
}

// one interval's wait, and the tick it brings
const tick = async (world: World, minutes = 15): Promise<void> => {
  world.time.advance(minutes * minute)
  await world.server.scheduler.idle()
}

const runOf = (world: World, number: number): Run | undefined => world.server.cache.runsFor(scenario.repo, number, 1)[0]

const autoRuns = (world: World): Run[] => world.server.cache.allRuns().filter((run) => run.origin === 'auto')

const running = (world: World): Run[] => autoRuns(world).filter((run) => run.status === 'running')

const ticks = (world: World) => world.server.cache.ticksFor(scenario.repo)

const graphqlCalls = (world: World): number => world.gh.calls.filter((args) => args[0] === 'api' && args[1] === 'graphql').length

const stdinOf = (child: FakeChild): string => child.writes.join('')

// the run's process ends with a finished review of its PR, its report on disk
const finish = async (world: World, run: Run, patch: Record<string, unknown> = {}): Promise<Run> => {
  const child = world.launch.children.find((candidate) => basename(candidate.request.cwd) === `run-${run.id}`)
  assert.ok(child, `run ${run.id} has a process`)
  const report = `agents/output/PR-${run.number}.md`
  await mkdir(join(world.home, dirname(report)), { recursive: true })
  await writeFile(join(world.home, report), 'A report.\n')
  await child.result(reviewResult({ target: { repo: scenario.repo, pr: run.number }, posted: null, notPostedReason: 'noPost', report: `~/${report}`, ...patch }))
  child.exit(0)
  const settled = await world.server.launcher.settled(run.id)
  await world.server.scheduler.idle()
  return world.server.cache.getRun(settled.id) ?? settled
}

// the clock

test('a server start makes no GitHub call and no tick; the first tick comes one interval later, with no page open', async () => {
  const world = await setup()
  try {
    assert.equal(world.gh.calls.filter((args) => args[0] === 'api').length, 0)
    assert.equal(ticks(world).length, 0)
    assert.equal(world.server.scheduler.view()?.nextTickAt, '2026-10-26T14:20:38Z')
    world.time.advance(14 * minute)
    await world.server.scheduler.idle()
    assert.equal(ticks(world).length, 0)
    world.time.advance(minute)
    await world.server.scheduler.idle()
    assert.equal(ticks(world).length, 1)
    assert.equal(ticks(world)[0]?.state, 'ran')
    assert.equal(ticks(world)[0]?.startedAt, '2026-10-26T14:20:38Z')
    assert.equal(world.server.clients.activeCount(), 0)
  } finally {
    await world.cleanup()
  }
})

test('with enabled false nothing ticks and nothing calls GitHub or git, however long it waits; saving it on starts the clock', async () => {
  const world = await setup({ auto: { enabled: false } })
  try {
    await tick(world, 600)
    assert.equal(ticks(world).length, 0)
    assert.equal(world.gh.calls.filter((args) => args[0] === 'api').length, 0)
    assert.deepEqual(world.git.state.calls.filter((call) => call.args[2] !== 'worktree'), [])
    assert.equal(world.server.scheduler.view()?.state, 'off')
    assert.equal(world.server.scheduler.view()?.nextTickAt, null)
    const stored = await (await fetch(`${world.server.url}/api/config`)).json() as Config
    const saved = await fetch(`${world.server.url}/api/config`, { method: 'PUT', headers: headers(world), body: JSON.stringify({ ...stored, autoReview: { ...stored.autoReview, enabled: true } }) })
    assert.equal(saved.status, 200)
    assert.notEqual(world.server.scheduler.view()?.nextTickAt, null)
    assert.equal(world.server.scheduler.view()?.enabled, true)
  } finally {
    await world.cleanup()
  }
})

test('with no autoReview key there is no scheduler state at all, and the view says null', async () => {
  const world = await setup({ noKey: true })
  try {
    await tick(world, 600)
    assert.equal(ticks(world).length, 0)
    assert.equal(world.server.scheduler.view(), null)
    const view = await (await fetch(`${world.server.url}/api/view`)).json() as { autoReview: unknown }
    assert.equal(view.autoReview, null)
  } finally {
    await world.cleanup()
  }
})

test('outside active hours nothing ticks and no GitHub call is made; the tick comes as the window opens, and none after it closes', async () => {
  const world = await setup({ now: saturday })
  try {
    assert.equal(world.server.scheduler.view()?.state, 'outsideHours')
    // Monday, 09:00 in the machine's zone
    assert.equal(world.server.scheduler.view()?.nextTickAt, '2026-10-26T13:00:00Z')
    // to a minute before Monday 09:00
    world.time.advance(Date.parse('2026-10-26T12:59:00Z') - Date.parse(saturday))
    await world.server.scheduler.idle()
    assert.equal(ticks(world).length, 0)
    assert.equal(world.gh.calls.filter((args) => args[0] === 'api').length, 0)
    await tick(world, 1)
    assert.equal(ticks(world).length, 1)
    assert.equal(ticks(world)[0]?.startedAt, '2026-10-26T13:00:00Z')
    // the rest of Monday, 09:15 through 17:45, then nothing until Tuesday 09:00
    world.time.advance((9 * 60 - 1) * minute)
    await world.server.scheduler.idle()
    const monday = ticks(world).length
    world.time.advance(14 * 60 * minute)
    await world.server.scheduler.idle()
    assert.equal(ticks(world).length, monday)
    for (const row of ticks(world)) {
      const hour = new Date(row.startedAt).getUTCHours()
      assert.ok(hour >= 13 && hour < 22, `${row.startedAt} is inside the window`)
    }
    assert.equal(world.server.scheduler.view()?.nextTickAt, '2026-10-27T13:00:00Z')
  } finally {
    await world.cleanup()
  }
})

test('pages opening, pausing, and going idle never start, stop, or move a tick', async () => {
  const world = await setup()
  try {
    const next = world.server.scheduler.view()?.nextTickAt
    world.server.poller.setActive(1, false)
    assert.equal(world.server.scheduler.view()?.nextTickAt, next)
    world.server.poller.setActive(0, false)
    assert.equal(world.server.scheduler.view()?.nextTickAt, next)
    assert.equal(ticks(world).length, 0)
    await tick(world)
    assert.equal(ticks(world).length, 1)
  } finally {
    await world.cleanup()
  }
})

// the tick's checks

test('a gh login that differs from the viewer skips the tick as identityMismatch, and so does a gh that cannot answer; nothing starts until they match', async () => {
  const world = await setup()
  try {
    world.gh.login = 'somebody-else'
    await tick(world)
    assert.equal(ticks(world)[0]?.state, 'skipped')
    assert.equal(ticks(world)[0]?.skipReason, 'identityMismatch')
    assert.equal(ticks(world)[0]?.qualified, null)
    assert.equal(world.server.scheduler.view()?.state, 'blocked')
    world.gh.login = null
    await tick(world)
    assert.equal(ticks(world)[0]?.skipReason, 'identityMismatch')
    assert.equal(world.launch.children.length, 0)
    assert.deepEqual(world.git.verbs('worktree', 'add'), [])
    // letter case does not matter, as in the launcher's own check
    world.gh.login = scenario.viewer.toUpperCase()
    await tick(world)
    assert.equal(ticks(world)[0]?.state, 'ran')
    assert.equal(world.launch.children.length, 1)
  } finally {
    await world.cleanup()
  }
})

test('a cloneDir that is unset or not a clone of repo skips the tick as noClone, after the identity check and before any fetch', async () => {
  const world = await setup()
  try {
    world.git.state.remotes = fakeRemotes('octo-example/another')
    const before = graphqlCalls(world)
    await tick(world)
    assert.equal(ticks(world)[0]?.skipReason, 'noClone')
    assert.equal(graphqlCalls(world), before)
    world.git.state.remotes = null
    await tick(world)
    assert.equal(ticks(world)[0]?.skipReason, 'noClone')
    assert.equal(world.launch.children.length, 0)
  } finally {
    await world.cleanup()
  }
  const unset = await setup({ config: { cloneDir: '' } })
  try {
    await tick(unset)
    assert.equal(ticks(unset)[0]?.skipReason, 'noClone')
  } finally {
    await unset.cleanup()
  }
})

test('a tick starts an autoReview cycle, reuses one that finished within 60 seconds, and joins one that is running', async () => {
  const world = await setup({ auto: { intervalMinutes: 5 } })
  try {
    await tick(world, 5)
    const first = ticks(world)[0]
    assert.notEqual(first?.cycle, null)
    assert.equal(world.server.cache.cycle(first?.cycle ?? 0)?.trigger, 'autoReview')
    // a cycle of another trigger finishes 30 seconds before the next tick
    world.time.advance(4.5 * minute)
    assert.equal(world.server.poller.refresh('manual').started, true)
    await world.server.poller.idle()
    const calls = graphqlCalls(world)
    world.time.advance(0.5 * minute)
    await world.server.scheduler.idle()
    assert.equal(ticks(world)[0]?.state, 'ran')
    assert.equal(ticks(world)[0]?.cycle, null)
    assert.equal(graphqlCalls(world), calls)
    // one that finished more than 60 seconds ago is not reused
    await tick(world, 5)
    assert.notEqual(ticks(world)[0]?.cycle, null)
    assert.ok(graphqlCalls(world) > calls)
    // one that is running is joined, not doubled
    const held = Promise.withResolvers<void>()
    world.gh.hold = held.promise
    world.time.advance(5 * minute - 1)
    const joined = world.server.poller.refresh('manual').cycle
    const prunes = world.git.verbs('worktree', 'prune').length
    world.time.advance(1)
    await waitFor(() => world.git.verbs('worktree', 'list').length > 0 && world.git.verbs('worktree', 'prune').length > prunes)
    await quiet()
    assert.equal(world.server.cache.runningCycle()?.id, joined)
    held.resolve()
    world.gh.hold = null
    await world.server.scheduler.idle()
    assert.equal(ticks(world)[0]?.cycle, joined)
  } finally {
    await world.cleanup()
  }
})

test('a cycle that fails skips the tick as fetchFailed, so it never decides from stale rows', async () => {
  const world = await setup()
  try {
    await tick(world)
    const started = world.launch.children.length
    const queued = autoRuns(world).length
    world.gh.failCycle = true
    await tick(world)
    assert.equal(ticks(world)[0]?.state, 'skipped')
    assert.equal(ticks(world)[0]?.skipReason, 'fetchFailed')
    assert.equal(ticks(world)[0]?.qualified, null)
    assert.equal(world.launch.children.length, started)
    assert.equal(autoRuns(world).length, queued)
  } finally {
    await world.cleanup()
  }
})

test('the tick row records what it qualified, what was current, and what it queued, and the rows name their tick, reason, and head', async () => {
  const world = await setup()
  try {
    await tick(world)
    const row = ticks(world)[0]
    const queued = autoRuns(world)
    assert.ok(queued.length > 1)
    assert.equal(row?.queued, queued.length)
    assert.equal(row?.qualified, queued.length)
    assert.equal(row?.alreadyCurrent, 0)
    assert.equal(row?.finishedAt, '2026-10-26T14:20:38Z')
    for (const run of queued) {
      assert.equal(run.tick, row?.id)
      assert.equal(run.queuedAt, '2026-10-26T14:20:38Z')
      assert.ok(['requested', 'pushed', 'new'].includes(run.reason ?? ''))
      assert.notEqual(run.headOid, null)
      assert.equal(run.command, 'review-pr')
    }
    // the view's cache row for the same PR says the same head
    const open = world.server.cache.readView(scenario.repo).open
    for (const run of queued) assert.equal(run.headOid, open.find((entry) => entry.number === run.number)?.pr.headRefOid)
    // and the next tick adds none while they wait
    const count = queued.length
    await tick(world)
    assert.equal(autoRuns(world).length, count)
    assert.equal(ticks(world)[0]?.queued, 0)
  } finally {
    await world.cleanup()
  }
})

// the flags

test('with post.others off no run starts without --no-post, and the command line carries --emit-json', async () => {
  const world = await setup({ auto: { concurrency: 2 }, config: { maxConcurrentReviews: 2 } })
  try {
    await tick(world)
    assert.equal(world.launch.children.length, 2)
    for (const child of world.launch.children) {
      assert.match(stdinOf(child), /\/review-pr \d+ --no-post --emit-json=/)
      assert.doesNotMatch(stdinOf(child), /--tandem/)
    }
    for (const run of running(world)) {
      assert.ok(run.args.includes('--no-post'))
      assert.equal(run.posting, false)
    }
  } finally {
    await world.cleanup()
  }
})

test('with post.others on an others run omits --no-post, and a run queued before the switch takes the setting in effect when it starts', async () => {
  const world = await setup({ auto: { concurrency: 1, post: { others: true, dependabot: false } } })
  try {
    await tick(world)
    const started = running(world)[0]
    assert.ok(started)
    assert.deepEqual(started.args, [String(started.number)])
    assert.equal(started.posting, true)
    assert.doesNotMatch(stdinOf(world.launch.children[0]!), /--no-post/)
    const waiting = autoRuns(world).filter((run) => run.status === 'queued')
    assert.ok(waiting.length >= 2)
    for (const run of waiting) assert.equal(run.posting, true)
    const save = async (others: boolean): Promise<void> => {
      const stored = await (await fetch(`${world.server.url}/api/config`)).json() as Config
      const body = JSON.stringify({ ...stored, autoReview: { ...stored.autoReview, post: { others, dependabot: false } } })
      assert.equal((await fetch(`${world.server.url}/api/config`, { method: 'PUT', headers: headers(world), body })).status, 200)
      await world.server.poller.idle()
    }
    // turned off, a row queued while it was on starts without leave to post
    await save(false)
    await finish(world, started)
    await tick(world)
    const second = running(world)[0]
    assert.ok(second)
    assert.ok(second.args.includes('--no-post'))
    assert.equal(second.posting, false)
    assert.match(stdinOf(world.launch.children[1]!), /--no-post --emit-json=/)
    // turned on again, the same goes the other way
    await save(true)
    await finish(world, second)
    await tick(world)
    const third = running(world)[0]
    assert.ok(third)
    assert.deepEqual(third.args, [String(third.number)])
    assert.equal(third.posting, true)
  } finally {
    await world.cleanup()
  }
})

test('an own PR run always carries --no-post, whatever post.others says', async () => {
  const world = await setup({ auto: { others: false, own: true, post: { others: true, dependabot: true } } })
  try {
    await tick(world)
    const started = running(world)[0]
    assert.ok(started)
    assert.equal(started.reason, 'selfReview')
    assert.equal(started.label, 'Self-review')
    assert.ok(started.args.includes('--no-post'))
    assert.equal(started.posting, false)
    assert.match(stdinOf(world.launch.children[0]!), /--no-post --emit-json=/)
  } finally {
    await world.cleanup()
  }
})

test('a scheduled sweep carries --parallel 1, and --no-post unless post.dependabot is on, in a worktree named for the sweep', async () => {
  const off = await setup({ auto: { others: false, dependabot: true } })
  try {
    await tick(off)
    const sweep = off.server.cache.allSweeps()[0]
    assert.ok(sweep)
    assert.equal(sweep.origin, 'auto')
    assert.equal(sweep.reason, 'dependabot')
    assert.deepEqual(sweep.args, [scenario.repo, '--parallel', '1', '--no-post'])
    assert.equal(sweep.posting, false)
    assert.equal(basename(off.launch.children[0]!.request.cwd), `sweep-${sweep.id}`)
  } finally {
    await off.cleanup()
  }
  const on = await setup({ auto: { others: false, dependabot: true, post: { others: false, dependabot: true } } })
  try {
    await tick(on)
    const sweep = on.server.cache.allSweeps()[0]
    assert.deepEqual(sweep?.args, [scenario.repo, '--parallel', '1'])
    assert.equal(sweep?.posting, true)
  } finally {
    await on.cleanup()
  }
})

// the posting switch at the spawn: a run built to post has awaits ahead of it (the identity check, the fetch, the add, the run directory), and a switch turned off during any of them must reach the process it starts

const savePost = async (world: World, post: AutoReviewSettings['post']): Promise<void> => {
  const stored = await (await fetch(`${world.server.url}/api/config`)).json() as Config
  const body = JSON.stringify({ ...stored, autoReview: { ...stored.autoReview, post } })
  assert.equal((await fetch(`${world.server.url}/api/config`, { method: 'PUT', headers: headers(world), body })).status, 200)
}

type GitHold = 'holdFetch' | 'holdAdd' | 'holdRevParse'

const heldVerbs: Record<GitHold, string[]> = { holdFetch: ['fetch'], holdAdd: ['worktree', 'add'], holdRevParse: ['rev-parse'] }

// the next tick's start, held at one git step while the switches are saved, and then let go
const saveWhileHeld = async (world: World, hold: GitHold, post: AutoReviewSettings['post'], minutes = 15): Promise<void> => {
  const held = Promise.withResolvers<void>()
  world.git.state[hold] = held.promise
  const before = world.git.verbs(...heldVerbs[hold]).length
  world.time.advance(minutes * minute)
  await waitFor(() => world.git.verbs(...heldVerbs[hold]).length === before + 1)
  await savePost(world, post)
  held.resolve()
  await world.server.scheduler.idle()
}

const requestFileOf = async (child: FakeChild): Promise<{ args: string[], argv: string[] }> =>
  JSON.parse(await readFile(join(dirname(child.request.stdoutPath), 'request.json'), 'utf8')) as { args: string[], argv: string[] }

test('post.others turned off while the fetch is held: the others run spawns with --no-post, and its row and request.json say so', async () => {
  const world = await setup({ auto: { post: { others: true, dependabot: true } } })
  try {
    await saveWhileHeld(world, 'holdFetch', { others: false, dependabot: true })
    const started = running(world)[0]
    assert.ok(started)
    assert.equal(world.launch.children.length, 1)
    const child = world.launch.children[0]!
    assert.match(stdinOf(child), /--no-post --emit-json=/)
    assert.deepEqual(started.args, [String(started.number), '--no-post'])
    assert.equal(started.posting, false)
    const file = await requestFileOf(child)
    assert.deepEqual(file.args, started.args)
  } finally {
    await world.cleanup()
  }
})

test('post.others turned off while the worktree is added: a row queued by an earlier tick spawns with --no-post too', async () => {
  const world = await setup({ auto: { concurrency: 1, post: { others: true, dependabot: true } } })
  try {
    await tick(world)
    const first = running(world)[0]
    assert.ok(first)
    assert.deepEqual(first.args, [String(first.number)])
    const waiting = autoRuns(world).filter((run) => run.status === 'queued')
    assert.ok(waiting.length > 0)
    for (const run of waiting) assert.equal(run.posting, true)
    await finish(world, first)
    await saveWhileHeld(world, 'holdAdd', { others: false, dependabot: true })
    const second = running(world)[0]
    assert.ok(second)
    assert.ok(waiting.some((run) => run.id === second.id))
    assert.equal(world.launch.children.length, 2)
    assert.match(stdinOf(world.launch.children[1]!), /--no-post --emit-json=/)
    assert.deepEqual(second.args, [String(second.number), '--no-post'])
    assert.equal(second.posting, false)
  } finally {
    await world.cleanup()
  }
})

test('post.others turned off during the launch\'s own last awaits, after the worktree exists: the Codex command line carries --no-post, in its argv and in request.json', async () => {
  const world = await setup({ auto: { post: { others: true, dependabot: true } }, config: { agent: { runner: 'codex', claudeModel: 'sonnet' } } })
  try {
    await saveWhileHeld(world, 'holdRevParse', { others: false, dependabot: true })
    const started = running(world)[0]
    assert.ok(started)
    const child = world.launch.children[0]!
    assert.equal(started.runner, 'codex')
    assert.equal(child.request.command, 'codex')
    assert.match(child.request.args.at(-1) ?? '', /--no-post --emit-json=/)
    assert.deepEqual(started.args, [String(started.number), '--no-post'])
    assert.equal(started.posting, false)
    const file = await requestFileOf(child)
    assert.deepEqual(file.args, started.args)
    assert.deepEqual(file.argv, [child.request.command, ...child.request.args])
  } finally {
    await world.cleanup()
  }
})

test('post.dependabot turned off while the worktree is added: the scheduled sweep spawns with --no-post, which is what reaches every reviewer\'s brief', async () => {
  const world = await setup({ auto: { others: false, dependabot: true, post: { others: true, dependabot: true } } })
  try {
    await saveWhileHeld(world, 'holdAdd', { others: true, dependabot: false })
    const sweep = world.server.cache.allSweeps()[0]
    assert.ok(sweep)
    assert.equal(sweep.status, 'running')
    const child = world.launch.children[0]!
    assert.match(stdinOf(child), /--no-post --emit-json=/)
    assert.deepEqual(sweep.args, [scenario.repo, '--parallel', '1', '--no-post'])
    assert.equal(sweep.posting, false)
    assert.deepEqual((await requestFileOf(child)).args, sweep.args)
  } finally {
    await world.cleanup()
  }
})

test('a scheduled Dependabot PR run reads post.dependabot at the spawn, not post.others', async () => {
  const startHeld = async (post: AutoReviewSettings['post']): Promise<{ args: string[], posting: boolean, stdin: string }> => {
    const world = await setup({ auto: { others: false, post: { others: true, dependabot: true } } })
    try {
      const tickRow = world.server.cache.createTick(scenario.repo)
      const request = { repo: scenario.repo, number: 900, command: 'review-dependabot', args: ['900'], label: 'Review' }
      const row = world.server.launcher.queueScheduled(request, world.clone, { tick: tickRow.id, reason: 'dependabot', headOid: 'abc1234', posting: true })
      const held = Promise.withResolvers<void>()
      const entered = Promise.withResolvers<void>()
      const starting = world.server.launcher.startScheduled(row.id, request, { args: request.args, posting: true }, async () => {
        entered.resolve()
        await held.promise
        return join(world.worktrees, `run-${row.id}`)
      })
      await entered.promise
      await savePost(world, post)
      held.resolve()
      const started = await starting
      assert.equal(started?.status, 'running')
      return { args: started?.args ?? [], posting: started?.posting ?? true, stdin: stdinOf(world.launch.children[0]!) }
    } finally {
      await world.cleanup()
    }
  }
  const off = await startHeld({ others: true, dependabot: false })
  assert.deepEqual(off.args, ['900', '--no-post'])
  assert.equal(off.posting, false)
  assert.match(off.stdin, /--no-post --emit-json=/)
  // post.others off says nothing about it
  const on = await startHeld({ others: false, dependabot: true })
  assert.deepEqual(on.args, ['900'])
  assert.equal(on.posting, true)
  assert.doesNotMatch(on.stdin, /--no-post/)
})

test('a switch turned on while a run built with --no-post is held changes nothing: others, a sweep, and an own PR all keep it, once', async () => {
  const others = await setup({ auto: { post: { others: false, dependabot: false } } })
  try {
    await saveWhileHeld(others, 'holdFetch', { others: true, dependabot: true })
    const started = running(others)[0]
    assert.ok(started)
    assert.deepEqual(started.args, [String(started.number), '--no-post'])
    assert.equal(started.posting, false)
    assert.match(stdinOf(others.launch.children[0]!), /--no-post --emit-json=/)
  } finally {
    await others.cleanup()
  }
  const sweeps = await setup({ auto: { others: false, dependabot: true, post: { others: false, dependabot: false } } })
  try {
    await saveWhileHeld(sweeps, 'holdAdd', { others: true, dependabot: true })
    const sweep = sweeps.server.cache.allSweeps()[0]
    assert.deepEqual(sweep?.args, [scenario.repo, '--parallel', '1', '--no-post'])
    assert.equal(sweep?.posting, false)
    assert.match(stdinOf(sweeps.launch.children[0]!), /--no-post --emit-json=/)
  } finally {
    await sweeps.cleanup()
  }
  const own = await setup({ auto: { others: false, own: true, post: { others: false, dependabot: false } } })
  try {
    await saveWhileHeld(own, 'holdFetch', { others: true, dependabot: true })
    const started = running(own)[0]
    assert.ok(started)
    assert.equal(started.reason, 'selfReview')
    assert.deepEqual(started.args, [String(started.number), '--no-post'])
    assert.equal(started.posting, false)
    assert.match(stdinOf(own.launch.children[0]!), /--no-post --emit-json=/)
  } finally {
    await own.cleanup()
  }
})

test('an own PR run keeps --no-post once when the switch is turned off, and another kind\'s switch does not touch a run that may post', async () => {
  const own = await setup({ auto: { others: false, own: true, post: { others: true, dependabot: true } } })
  try {
    await saveWhileHeld(own, 'holdFetch', { others: false, dependabot: true })
    const started = running(own)[0]
    assert.ok(started)
    assert.deepEqual(started.args, [String(started.number), '--no-post'])
  } finally {
    await own.cleanup()
  }
  const others = await setup({ auto: { post: { others: true, dependabot: true } } })
  try {
    await saveWhileHeld(others, 'holdFetch', { others: true, dependabot: false })
    const started = running(others)[0]
    assert.ok(started)
    assert.deepEqual(started.args, [String(started.number)])
    assert.equal(started.posting, true)
    assert.doesNotMatch(stdinOf(others.launch.children[0]!), /--no-post/)
  } finally {
    await others.cleanup()
  }
  const sweeps = await setup({ auto: { others: false, dependabot: true, post: { others: true, dependabot: true } } })
  try {
    await saveWhileHeld(sweeps, 'holdAdd', { others: false, dependabot: true })
    const sweep = sweeps.server.cache.allSweeps()[0]
    assert.deepEqual(sweep?.args, [scenario.repo, '--parallel', '1'])
    assert.equal(sweep?.posting, true)
  } finally {
    await sweeps.cleanup()
  }
})

test('the posting switches govern only scheduled runs: a review the owner starts, fresh or from the queue, and a sweep the owner starts spawn as they were asked', async () => {
  const world = await setup({ auto: { post: { others: false, dependabot: false } }, config: { maxConcurrentReviews: 1 } })
  try {
    const first = await world.server.launcher.start({ repo: scenario.repo, number: 106, command: 'review-pr', args: ['106'], label: 'Review' })
    assert.equal(first.status, 'running')
    assert.deepEqual(first.args, ['106'])
    assert.equal(first.posting, true)
    assert.doesNotMatch(stdinOf(world.launch.children[0]!), /--no-post/)
    const second = await world.server.launcher.start({ repo: scenario.repo, number: 107, command: 'review-pr', args: ['107'], label: 'Review' })
    assert.equal(second.status, 'queued')
    world.launch.children[0]!.exit(0)
    await world.server.launcher.settled(first.id)
    await waitFor(() => world.launch.children.length === 2)
    await world.server.launcher.flushed()
    const after = world.server.cache.getRun(second.id)
    assert.deepEqual(after?.args, ['107'])
    assert.equal(after?.posting, true)
    assert.doesNotMatch(stdinOf(world.launch.children[1]!), /--no-post/)
    world.launch.children[1]!.exit(0)
    await world.server.launcher.settled(second.id)
    const sweep = await world.server.sweepLauncher.start(sweepRequest(scenario.repo))
    assert.deepEqual(sweep.args, [scenario.repo, '--parallel', '1'])
    assert.equal(sweep.posting, true)
    assert.doesNotMatch(stdinOf(world.launch.children[2]!), /--no-post/)
  } finally {
    await world.cleanup()
  }
})

// the worktrees

test('no command ever runs in cloneDir: the fetch and the add name the clone with -C, and the run works in its own detached worktree', async () => {
  const world = await setup()
  try {
    await tick(world)
    const started = running(world)[0]
    assert.ok(started)
    const child = world.launch.children[0]!
    assert.equal(child.request.cwd, join(world.worktrees, `run-${started.id}`))
    assert.notEqual(child.request.cwd, world.clone)
    assert.equal(started.worktree, `~/.local/state/pit-view/worktrees/run-${started.id}`)
    assert.equal(started.cwd, started.worktree)
    assert.deepEqual(world.git.verbs('fetch').map((call) => call.args), [['-C', world.clone, 'fetch', 'origin']])
    assert.deepEqual(world.git.verbs('worktree', 'add').map((call) => call.args), [['-C', world.clone, 'worktree', 'add', '--detach', child.request.cwd, `origin/${scenario.defaultBranch}`]])
    // the launcher's git config for a review: hooks off, and the credential pair
    for (const call of [...world.git.verbs('fetch'), ...world.git.verbs('worktree', 'add')]) {
      assert.equal(call.env?.GIT_CONFIG_VALUE_2, '/dev/null')
      assert.equal(call.env?.GIT_CONFIG_VALUE_1, '!gh auth git-credential')
    }
    // nothing but git's own -C reaches the clone, and every spawn so far is elsewhere
    for (const each of world.launch.children) assert.notEqual(each.request.cwd, world.clone)
    assert.ok(world.git.state.calls.every((call) => call.args[0] === '-C'))
  } finally {
    await world.cleanup()
  }
})

test('a fetch that fails is tried once more a few seconds later, and a second failure fails the run as worktreeFailed, gives the slot back, does not count, and is retried', async () => {
  const world = await setup({ auto: { concurrency: 1, dailyLimit: 1 } })
  try {
    world.git.state.fetchFailures = 1
    world.time.advance(15 * minute)
    await waitFor(() => world.git.verbs('fetch').length === 1)
    await waitFor(() => world.time.pending() > 0)
    world.time.advance(5000)
    await world.server.scheduler.idle()
    assert.equal(world.git.verbs('fetch').length, 2)
    assert.equal(world.launch.children.length, 1)
  } finally {
    await world.cleanup()
  }
  const bad = await setup({ auto: { concurrency: 1, dailyLimit: 1 } })
  try {
    bad.git.state.fetchFailures = 2
    bad.time.advance(15 * minute)
    await waitFor(() => bad.git.verbs('fetch').length === 1)
    await waitFor(() => bad.time.pending() > 0)
    bad.time.advance(5000)
    await bad.server.scheduler.idle()
    assert.equal(bad.launch.children.length, 0)
    assert.deepEqual(bad.git.verbs('worktree', 'add'), [])
    const failure = autoRuns(bad).find((run) => run.status === 'failed')
    assert.ok(failure)
    assert.match(failure.note ?? '', /^worktreeFailed: /)
    assert.equal(failure.pid, null)
    // the slot came back
    assert.equal(bad.server.launcher.queueing().review, false)
    assert.equal(bad.server.scheduler.view()?.startedToday, 0)
    // the next tick retries it: the daily limit of one was not spent
    await tick(bad)
    assert.equal(bad.launch.children.length, 1)
    assert.equal(ticks(bad)[0]?.skipReason, null)
  } finally {
    await bad.cleanup()
  }
})

test('a worktree add that fails ends the run as worktreeFailed', async () => {
  const world = await setup()
  try {
    world.git.state.addFails = true
    await tick(world)
    assert.equal(world.launch.children.length, 0)
    assert.match(autoRuns(world).find((run) => run.status === 'failed')?.note ?? '', /^worktreeFailed: .*invalid reference/)
  } finally {
    await world.cleanup()
  }
})

test('the slot is held before the fetch, so a review that arrives while the worktree is made finds the cap as it will be', async () => {
  const world = await setup({ config: { maxConcurrentReviews: 1 } })
  try {
    const held = Promise.withResolvers<void>()
    world.git.state.holdFetch = held.promise
    world.time.advance(15 * minute)
    await waitFor(() => world.git.verbs('fetch').length === 1)
    assert.equal(world.server.launcher.queueing().review, true)
    assert.equal(world.launch.children.length, 0)
    assert.equal(running(world).length, 1)
    held.resolve()
    await world.server.scheduler.idle()
    assert.equal(world.launch.children.length, 1)
  } finally {
    await world.cleanup()
  }
})

test('a stop that arrives while the worktree is made spawns nothing, ends the run stopped, and removes the worktree', async () => {
  const world = await setup()
  try {
    const held = Promise.withResolvers<void>()
    world.git.state.holdFetch = held.promise
    world.time.advance(15 * minute)
    await waitFor(() => world.git.verbs('fetch').length === 1)
    const started = running(world)[0]
    assert.ok(started)
    world.server.launcher.stop(started.id)
    held.resolve()
    await world.server.scheduler.idle()
    const after = world.server.cache.getRun(started.id)
    assert.equal(after?.status, 'stopped')
    assert.equal(world.launch.children.some((child) => basename(child.request.cwd) === `run-${started.id}`), false)
    assert.equal(after?.worktree, null)
    assert.equal(world.git.state.worktrees.size, world.launch.children.length)
  } finally {
    await world.cleanup()
  }
})

test('a run that ends done has its worktree removed without --force, its row clears the path, and its resume names the clone', async () => {
  const world = await setup()
  try {
    await tick(world)
    const started = running(world)[0]
    assert.ok(started)
    assert.match(started.resume ?? '', /worktrees\/run-/)
    const done = await finish(world, started, { reviewed: { kind: 'commit', sha: started.headOid } })
    assert.equal(done.status, 'done')
    assert.equal(done.worktree, null)
    assert.match(done.resume ?? '', /^cd ~\/dev\/orbit && claude --resume /)
    const removal = world.git.verbs('worktree', 'remove')
    assert.equal(removal.length, 1)
    assert.deepEqual(removal[0]?.args.slice(2), ['worktree', 'remove', join(world.worktrees, `run-${started.id}`)])
    assert.ok(world.git.state.calls.every((call) => !call.args.includes('--force')))
    assert.equal(world.git.state.worktrees.has(join(await realpath(world.worktrees), `run-${started.id}`)), false)
  } finally {
    await world.cleanup()
  }
})

test('a removal git refuses keeps the path, notes worktreeKept, lists it in the view, and never passes --force', async () => {
  const world = await setup()
  try {
    await tick(world)
    const started = running(world)[0]
    assert.ok(started)
    world.git.state.refuse.add(`run-${started.id}`)
    const done = await finish(world, started, { reviewed: { kind: 'commit', sha: started.headOid } })
    assert.equal(done.status, 'done')
    assert.equal(done.worktree, `~/.local/state/pit-view/worktrees/run-${started.id}`)
    assert.equal(done.note, `worktreeKept: ~/.local/state/pit-view/worktrees/run-${started.id}`)
    assert.match(done.resume ?? '', /^cd ~\/dev\/orbit && /)
    assert.deepEqual(world.server.scheduler.view()?.worktrees.kept, [`~/.local/state/pit-view/worktrees/run-${started.id}`])
    assert.ok(world.git.state.calls.every((call) => !call.args.includes('--force')))
    // once the owner clears it, the next sweep removes it and the note goes
    world.git.state.refuse.clear()
    await tick(world)
    const after = world.server.cache.getRun(started.id)
    assert.equal(after?.worktree, null)
    assert.equal(after?.note, null)
    assert.deepEqual(world.server.scheduler.view()?.worktrees.kept, [])
  } finally {
    await world.cleanup()
  }
})

test('a run that ends needsInput keeps its worktree and its resume names it, until its PR gets a new head, which the next sweep notices', async () => {
  const world = await setup()
  try {
    await tick(world)
    const started = running(world)[0]
    assert.ok(started)
    const waiting = await finish(world, started, { status: 'needsInput', question: 'Which base?', reviewed: null, verdict: null, findings: [], report: null })
    assert.equal(waiting.status, 'needsInput')
    assert.equal(waiting.worktree, `~/.local/state/pit-view/worktrees/run-${started.id}`)
    assert.match(waiting.resume ?? '', /worktrees\/run-/)
    assert.deepEqual(world.git.verbs('worktree', 'remove'), [])
    // it is left at that head, and its worktree stays through the next sweep
    await tick(world)
    assert.equal(world.server.cache.getRun(started.id)?.worktree, waiting.worktree)
    assert.deepEqual(world.git.verbs('worktree', 'remove'), [])
    // the cycle of that tick stands until the next one, which sweeps before it fetches
    const row = world.server.cache.readView(scenario.repo).open.find((entry) => entry.number === started.number)
    assert.ok(row)
    world.server.cache.writePr(scenario.repo, { ...row.pr, headRefOid: 'abc1234abc1234abc1234abc1234abc1234abc12' }, scenario.defaultBranch)
    await tick(world)
    const after = world.server.cache.getRun(started.id)
    assert.equal(after?.worktree, null)
    assert.equal(after?.status, 'needsInput')
    assert.match(after?.resume ?? '', /^cd ~\/dev\/orbit && /)
  } finally {
    await world.cleanup()
  }
})

test('the session of a waiting run having ended, shown by a new result.json in its folder, settles its worktree without changing its recorded outcome', async () => {
  const world = await setup()
  try {
    await tick(world)
    const started = running(world)[0]
    assert.ok(started)
    const waiting = await finish(world, started, { status: 'needsInput', question: 'Which base?', reviewed: null, verdict: null, findings: [], report: null })
    const child = world.launch.children[0]!
    await child.result(reviewResult({ target: { repo: scenario.repo, pr: started.number }, status: 'done', posted: null, notPostedReason: 'noPost', report: null }))
    await tick(world)
    const after = world.server.cache.getRun(started.id)
    assert.equal(after?.status, waiting.status)
    assert.equal(after?.worktree, null)
    assert.match(after?.resume ?? '', /^cd ~\/dev\/orbit && /)
  } finally {
    await world.cleanup()
  }
})

// restart recovery

test('at startup, whether or not auto-review is on, the sweep removes a crashed run\'s worktree and leaves another run\'s live one, a queued one, and anything else alone', async () => {
  const world = await setup({ auto: { enabled: false } })
  try {
    const folder = world.worktrees
    await mkdir(folder, { recursive: true })
    const real = await realpath(folder)
    const cache = world.server.cache
    const row = (number: number, status: Run['status'], pid: number | null = null): Run => cache.createRun({
      repo: scenario.repo, number, command: 'review-pr', args: [String(number)], label: 'Review', runner: 'claude', cwd: '~/x', sessionId: null, pid, pidStartedAt: pid === null ? null : `start-${pid}`, startedAt: '2026-10-26T14:00:00Z', lastStepAt: null, step: null, stepState: null, finishedAt: status === 'running' || status === 'queued' ? null : '2026-10-26T14:01:00Z', status, result: null, note: null, costUsd: null, resume: null, origin: 'auto',
    }, (id) => `~/.local/state/pit-view/runs/${id}`)
    const crashed = row(106, 'done')
    const liveRun = row(113, 'running', 5151)
    const queued = row(107, 'queued')
    world.launch.alive.add(5151)
    world.launch.processes.push({ pid: 5151, ppid: 1, pgid: 5151 })
    const worktree = (name: string): string => join(real, name)
    world.git.state.worktrees.add(worktree(`run-${crashed.id}`))
    world.git.state.worktrees.add(worktree(`run-${liveRun.id}`))
    world.git.state.worktrees.add(worktree(`run-${queued.id}`))
    // no row at all
    world.git.state.worktrees.add(worktree('run-999'))
    // not Pit View's: another name in the folder, and one elsewhere
    world.git.state.worktrees.add(worktree('scratch'))
    world.git.state.worktrees.add(join(world.clone, 'run-5'))
    // a directory git no longer lists is reported, not deleted
    await mkdir(join(folder, 'run-777'), { recursive: true })
    await world.restart()
    const removed = world.git.verbs('worktree', 'remove').map((call) => basename(call.args[4] ?? ''))
    assert.deepEqual(removed.sort(), [`run-${crashed.id}`, 'run-999'].sort())
    assert.ok(world.git.state.worktrees.has(worktree(`run-${liveRun.id}`)))
    assert.ok(world.git.state.worktrees.has(worktree(`run-${queued.id}`)))
    assert.ok(world.git.state.worktrees.has(worktree('scratch')))
    assert.ok(world.git.state.worktrees.has(join(world.clone, 'run-5')))
    assert.equal(world.git.verbs('worktree', 'prune').length > 0, true)
    assert.deepEqual(world.server.scheduler.view()?.worktrees.unlisted, ['run-777'])
    assert.equal(world.server.cache.getRun(liveRun.id)?.status, 'running')
    assert.equal(world.server.cache.getRun(queued.id)?.status, 'queued')
    // no GitHub call, and auto-review stayed off
    assert.equal(world.gh.calls.filter((args) => args[0] === 'api').length, 0)
  } finally {
    await world.cleanup()
  }
})

test('with cloneDir unset the sweep has nothing to do', async () => {
  const world = await setup({ config: { cloneDir: '' } })
  try {
    await world.restart()
    assert.deepEqual(world.git.state.calls, [])
  } finally {
    await world.cleanup()
  }
})

test('a restart keeps scheduled runs queued, fails only the manual ones, settles a dead running one, and the next tick starts what waits', async () => {
  const world = await setup()
  try {
    await tick(world)
    const waiting = autoRuns(world).filter((run) => run.status === 'queued')
    assert.ok(waiting.length > 0)
    const dead = running(world)[0]
    assert.ok(dead)
    const manual = world.server.cache.createRun({
      repo: scenario.repo, number: 999, command: 'review-pr', args: ['999'], label: 'Review', runner: 'claude', cwd: '~/x', sessionId: null, pid: null, pidStartedAt: null, startedAt: '2026-10-26T14:00:00Z', lastStepAt: null, step: null, stepState: null, finishedAt: null, status: 'queued', result: null, note: null, costUsd: null, resume: null,
    }, (id) => `~/.local/state/pit-view/runs/${id}`)
    world.launch.alive.delete(world.launch.children[0]!.pid)
    await world.restart()
    for (const run of waiting) assert.equal(world.server.cache.getRun(run.id)?.status, 'queued')
    const failed = world.server.cache.getRun(manual.id)
    assert.equal(failed?.status, 'failed')
    assert.match(failed?.note ?? '', /^serverRestarted/)
    const settled = world.server.cache.getRun(dead.id)
    assert.equal(settled?.status, 'failed')
    assert.match(settled?.note ?? '', /^serverRestarted/)
    // the dead run may be resumed, so its worktree stays until its retry has started
    assert.equal(settled?.worktree, dead.worktree)
    assert.deepEqual(world.git.verbs('worktree', 'remove'), [])
    const spawned = world.launch.children.length
    await tick(world)
    assert.equal(world.launch.children.length, spawned + 1)
  } finally {
    await world.cleanup()
  }
})

// concurrency, the cap, and the limit

test('concurrency holds scheduled runs to its number, inside the cap they share with the owner\'s reviews, and what does not fit makes no worktree', async () => {
  const world = await setup({ auto: { concurrency: 1 }, config: { maxConcurrentReviews: 3 } })
  try {
    await tick(world)
    assert.equal(world.launch.children.length, 1)
    assert.equal(world.git.verbs('worktree', 'add').length, 1)
    const queued = autoRuns(world).filter((run) => run.status === 'queued')
    assert.ok(queued.length > 0)
    for (const run of queued) assert.equal(run.worktree, null)
    await tick(world)
    assert.equal(world.launch.children.length, 1)
    await finish(world, running(world)[0]!)
    await tick(world)
    assert.equal(world.launch.children.length, 2)
  } finally {
    await world.cleanup()
  }
  const wide = await setup({ auto: { concurrency: 5 }, config: { maxConcurrentReviews: 2 } })
  try {
    await tick(wide)
    assert.equal(wide.launch.children.length, 2)
    assert.equal(wide.server.launcher.queueing().review, true)
  } finally {
    await wide.cleanup()
  }
})

test('a review the owner started fills the cap, so a scheduled run stays queued, and a scheduled self-review takes no place over the cap', async () => {
  const world = await setup({ auto: { others: false, own: true, concurrency: 3 }, config: { maxConcurrentReviews: 1, selfReviewOverCap: true } })
  try {
    assert.equal((await world.server.poller.refresh('manual')).started, true)
    await world.server.poller.idle()
    const manual = await world.server.launcher.start({ repo: scenario.repo, number: 106, command: 'review-pr', args: ['106'], label: 'Review' })
    assert.equal(manual.status, 'running')
    const spawned = world.launch.children.length
    await tick(world)
    assert.equal(world.launch.children.length, spawned)
    assert.deepEqual(world.git.verbs('worktree', 'add'), [])
    assert.ok(autoRuns(world).length > 0)
    assert.ok(autoRuns(world).every((run) => run.status === 'queued'))
    // the launcher's start pass never holds a scheduled row: it stays queued when the owner's review ends
    world.launch.children[0]!.exit(0)
    await world.server.launcher.settled(manual.id)
    await world.server.launcher.flushed()
    assert.equal(world.launch.children.length, spawned)
    assert.ok(autoRuns(world).every((run) => run.status === 'queued'))
  } finally {
    await world.cleanup()
  }
})

test('the owner\'s review of a PR waits for no scheduled row, and a PR with a manual run in flight gets none', async () => {
  const world = await setup({ config: { maxConcurrentReviews: 4 } })
  try {
    world.server.poller.refresh('manual')
    await world.server.poller.idle()
    const manual = await world.server.launcher.start({ repo: scenario.repo, number: 106, command: 'review-pr', args: ['106'], label: 'Review' })
    await tick(world)
    assert.equal(autoRuns(world).some((run) => run.number === 106), false)
    assert.equal(world.server.cache.runsFor(scenario.repo, 106, 1)[0]?.id, manual.id)
  } finally {
    await world.cleanup()
  }
})

test('the daily limit stops new starts, leaves what waits queued, skips ticks as dailyLimit, and starts over on the next local day', async () => {
  const world = await setup({ auto: { dailyLimit: 1, concurrency: 1 } })
  try {
    await tick(world)
    assert.equal(ticks(world)[0]?.state, 'ran')
    assert.equal(world.launch.children.length, 1)
    assert.equal(world.server.scheduler.view()?.startedToday, 1)
    await finish(world, running(world)[0]!)
    await tick(world)
    assert.equal(ticks(world)[0]?.state, 'skipped')
    assert.equal(ticks(world)[0]?.skipReason, 'dailyLimit')
    assert.notEqual(ticks(world)[0]?.qualified, null)
    assert.equal(world.launch.children.length, 1)
    assert.ok(autoRuns(world).some((run) => run.status === 'queued'))
    assert.equal(world.server.scheduler.view()?.state, 'blocked')
    // Tuesday, 09:00 in the machine's zone
    world.time.advance(Date.parse('2026-10-27T13:00:00Z') - world.time.clock.now())
    await world.server.scheduler.idle()
    assert.equal(ticks(world)[0]?.state, 'ran')
    assert.equal(world.launch.children.length, 2)
  } finally {
    await world.cleanup()
  }
})

test('a run still queued when the window closes starts only when it reopens, and one in flight finishes', async () => {
  const world = await setup({ now: '2026-10-26T21:40:00Z' })
  try {
    await tick(world)
    assert.equal(world.launch.children.length, 1)
    const started = running(world)[0]
    assert.ok(started)
    world.time.advance(30 * minute)
    await world.server.scheduler.idle()
    assert.equal(world.server.scheduler.view()?.state, 'running')
    await finish(world, started)
    assert.equal(world.launch.children.length, 1)
    assert.equal(world.server.scheduler.view()?.state, 'outsideHours')
    // Tuesday, 09:00 in the machine's zone
    world.time.advance(Date.parse('2026-10-27T13:00:00Z') - world.time.clock.now())
    await world.server.scheduler.idle()
    assert.equal(world.launch.children.length, 2)
  } finally {
    await world.cleanup()
  }
})

// the checks before a start

test('a queued PR that closed is dropped as skipped with the note closed, counted nowhere; one whose head moved runs and records the new head', async () => {
  const world = await setup()
  try {
    await tick(world)
    const waiting = autoRuns(world).filter((run) => run.status === 'queued')
    assert.ok(waiting.length >= 2)
    const closing = waiting[0]!
    const moving = waiting[1]!
    await finish(world, running(world)[0]!)
    // the tick reuses the cache: a cycle finished within 60 seconds, so what the test wrote stands
    world.time.advance(15 * minute - 30_000)
    world.server.poller.refresh('manual')
    await world.server.poller.idle()
    world.server.cache.closePr(scenario.repo, closing.number)
    const row = world.server.cache.readView(scenario.repo).open.find((entry) => entry.number === moving.number)
    assert.ok(row)
    world.server.cache.writePr(scenario.repo, { ...row.pr, headRefOid: 'abc1234abc1234abc1234abc1234abc1234abc12' }, scenario.defaultBranch)
    world.time.advance(30_000)
    await world.server.scheduler.idle()
    const dropped = world.server.cache.getRun(closing.id)
    assert.equal(dropped?.status, 'skipped')
    assert.equal(dropped?.note, 'closed')
    assert.equal(dropped?.pid, null)
    const moved = world.server.cache.getRun(moving.id)
    assert.equal(moved?.status, 'running')
    assert.equal(moved?.headOid, 'abc1234abc1234abc1234abc1234abc1234abc12')
  } finally {
    await world.cleanup()
  }
})

test('a stopped auto run holds its PR at that head, and a queued one the owner takes out does too', async () => {
  const world = await setup({ auto: { concurrency: 1 } })
  try {
    await tick(world)
    const started = running(world)[0]
    assert.ok(started)
    const queued = autoRuns(world).find((run) => run.status === 'queued')
    assert.ok(queued)
    assert.equal(world.server.launcher.stop(queued.id).status, 'stopped')
    world.server.launcher.stop(started.id)
    const stopped = await world.server.launcher.settled(started.id)
    await world.server.scheduler.idle()
    assert.equal(stopped.status, 'stopped')
    assert.equal(world.server.cache.getRun(started.id)?.worktree, null)
    assert.match(world.server.cache.getRun(started.id)?.resume ?? '', /^cd ~\/dev\/orbit && /)
    const before = autoRuns(world).filter((run) => run.number === started.number || run.number === queued.number).length
    await tick(world)
    assert.equal(autoRuns(world).filter((run) => run.number === started.number || run.number === queued.number).length, before)
  } finally {
    await world.cleanup()
  }
})

test('a failed run is retried once on a later tick, and a second failure is recorded as failedTwice on the newest and left for the owner', async () => {
  const world = await setup({ auto: { dailyLimit: 100 } })
  try {
    await tick(world)
    const first = running(world)[0]
    assert.ok(first)
    await finish(world, first, { status: 'failed', error: 'the session gave up', reviewed: null, verdict: null, findings: [], report: null })
    assert.equal(world.server.cache.getRun(first.id)?.status, 'failed')
    await tick(world)
    // the queue holds other PRs too, so the retry waits its turn behind them
    const retries = (): Run[] => autoRuns(world).filter((run) => run.number === first.number)
    assert.equal(retries().length, 2)
    for (;;) {
      const now = running(world)[0]
      if (now === undefined) break
      if (now.number === first.number) {
        await finish(world, now, { status: 'failed', error: 'the session gave up again', reviewed: null, verdict: null, findings: [], report: null })
        break
      }
      await finish(world, now, { reviewed: { kind: 'commit', sha: now.headOid } })
      await tick(world)
    }
    await tick(world)
    assert.equal(retries().length, 2)
    const newest = retries().sort((a, b) => b.id - a.id)[0]
    assert.match(newest?.note ?? '', /^failedTwice/)
    assert.match(newest?.note ?? '', /gave up again/)
    // written once, however many ticks read it
    const note = newest?.note
    await tick(world)
    assert.equal(world.server.cache.getRun(newest?.id ?? 0)?.note, note)
    // the first attempt's worktree went once its retry had started, and the newest failure still holds its own
    const firstAfter = world.server.cache.getRun(first.id)
    assert.equal(firstAfter?.worktree, null)
    assert.match(firstAfter?.resume ?? '', /^cd ~\/dev\/orbit && /)
    assert.notEqual(newest?.worktree, null)
  } finally {
    await world.cleanup()
  }
})

test('a failed run that was allowed to post and began its post is recorded as postUnknown and not retried', async () => {
  const world = await setup({ auto: { post: { others: true, dependabot: false }, dailyLimit: 100 } })
  try {
    await tick(world)
    const first = running(world)[0]
    assert.ok(first)
    await world.launch.children[0]!.events({ at: '2026-10-26T14:21:00Z', step: 'post', state: 'started', note: null })
    await world.server.launcher.check()
    await finish(world, first, { status: 'failed', error: 'died at the post', reviewed: null, verdict: null, findings: [], report: null })
    await tick(world)
    const row = world.server.cache.getRun(first.id)
    assert.match(row?.note ?? '', /^postUnknown/)
    assert.equal(autoRuns(world).filter((run) => run.number === first.number).length, 1)
  } finally {
    await world.cleanup()
  }
})

// the scheduled sweep

const finishSweep = async (world: World, sweep: Sweep, patch: Record<string, unknown> = {}): Promise<Sweep> => {
  const child = world.launch.children.find((candidate) => basename(candidate.request.cwd) === `sweep-${sweep.id}`)
  assert.ok(child)
  await mkdir(join(world.home, 'agents', 'output'), { recursive: true })
  await writeFile(join(world.home, 'agents', 'output', 'sweep-summary.md'), 'A summary.\n')
  await child.result(sweepResult({ rows: [sweepRow({ number: 114, head: world.server.cache.readView(scenario.repo).open.find((entry) => entry.number === 114)?.pr.headRefOid })], summary: '~/agents/output/sweep-summary.md', ...patch }))
  child.exit(0)
  const settled = await world.server.sweepLauncher.settled(sweep.id)
  await world.server.scheduler.idle()
  return world.server.cache.getSweep(settled.id) ?? settled
}

test('a scheduled sweep that waits for input holds new sweeps and says so in the view; its worktree stays; its session ending releases both', async () => {
  const world = await setup({ auto: { others: false, dependabot: true } })
  try {
    await tick(world)
    const sweep = world.server.cache.allSweeps()[0]
    assert.ok(sweep)
    assert.equal(world.server.scheduler.view()?.state, 'running')
    const waiting = await finishSweep(world, sweep, { status: 'needsInput', question: 'Hold the major bump?', rows: [] })
    assert.equal(waiting.status, 'needsInput')
    assert.notEqual(waiting.worktree, null)
    await tick(world)
    assert.equal(world.server.cache.allSweeps().length, 1)
    assert.equal(world.server.scheduler.view()?.sweepHold, 'needsInput')
    // the owner's session finishes and writes its result
    await world.launch.children[0]!.result(sweepResult({ rows: [], summary: null }))
    await tick(world)
    assert.equal(world.server.scheduler.view()?.sweepHold, null)
    assert.equal(world.server.cache.getSweep(sweep.id)?.status, 'needsInput')
  } finally {
    await world.cleanup()
  }
})

test('a sweep whose rows match the open heads is not queued again; a failed one is retried once, then failedTwice shows in the note and the view', async () => {
  const world = await setup({ auto: { others: false, dependabot: true, dailyLimit: 100 } })
  try {
    await tick(world)
    const first = world.server.cache.allSweeps()[0]
    assert.ok(first)
    const done = await finishSweep(world, first)
    assert.equal(done.status, 'done', done.note ?? '')
    assert.equal(done.worktree, null)
    await tick(world)
    assert.equal(world.server.cache.allSweeps().length, 1)
    // a new head makes it due again, and it fails twice
    const row = world.server.cache.readView(scenario.repo).open.find((entry) => entry.number === 114)
    assert.ok(row)
    const fail = async (): Promise<Sweep> => {
      const newest = world.server.cache.allSweeps().sort((a, b) => b.id - a.id)[0]
      assert.ok(newest)
      return finishSweep(world, newest, { status: 'failed', error: 'no reviewer answered', rows: [] })
    }
    world.time.advance(14.5 * minute)
    world.server.poller.refresh('manual')
    await world.server.poller.idle()
    world.server.cache.writePr(scenario.repo, { ...row.pr, headRefOid: 'fedcba9fedcba9fedcba9fedcba9fedcba9fedc' }, scenario.defaultBranch)
    world.time.advance(0.5 * minute)
    await world.server.scheduler.idle()
    assert.equal(world.server.cache.allSweeps().length, 2)
    await fail()
    world.time.advance(14.5 * minute)
    world.server.poller.refresh('manual')
    await world.server.poller.idle()
    world.server.cache.writePr(scenario.repo, { ...row.pr, headRefOid: 'fedcba9fedcba9fedcba9fedcba9fedcba9fedc' }, scenario.defaultBranch)
    world.time.advance(0.5 * minute)
    await world.server.scheduler.idle()
    assert.equal(world.server.cache.allSweeps().length, 3)
    await fail()
    world.time.advance(14.5 * minute)
    world.server.poller.refresh('manual')
    await world.server.poller.idle()
    world.server.cache.writePr(scenario.repo, { ...row.pr, headRefOid: 'fedcba9fedcba9fedcba9fedcba9fedcba9fedc' }, scenario.defaultBranch)
    world.time.advance(0.5 * minute)
    await world.server.scheduler.idle()
    assert.equal(world.server.cache.allSweeps().length, 3)
    assert.equal(world.server.scheduler.view()?.sweepHold, 'failedTwice')
    const newest = world.server.cache.allSweeps().sort((a, b) => b.id - a.id)[0]
    assert.match(newest?.note ?? '', /^failedTwice/)
  } finally {
    await world.cleanup()
  }
})

// a Codex run

test('a Codex run in a worktree takes the clone\'s .git and the worktree\'s metadata folder as its roots, and a finished one\'s resume names the clone\'s', async () => {
  const world = await setup({ config: { agent: { runner: 'codex', claudeModel: 'sonnet' } } })
  try {
    await tick(world)
    const started = running(world)[0]
    assert.ok(started)
    const child = world.launch.children[0]!
    const args = child.request.args
    const roots = args.flatMap((arg, index) => args[index - 1] === '--add-dir' ? [arg] : [])
    const path = join(world.worktrees, `run-${started.id}`)
    assert.ok(roots.includes(join(world.clone, '.git')))
    assert.ok(roots.includes(join(world.clone, '.git', 'worktrees', `run-${started.id}`)))
    assert.equal(roots.includes(join(path, '.git')), false)
    assert.ok(world.git.state.calls.some((call) => call.args[1] === path && call.args[2] === 'rev-parse' && call.args[3] === '--absolute-git-dir'))
    await child.stream({ type: 'thread.started', thread_id: 'codex-session-1' })
    await world.server.launcher.check()
    const resumed = world.server.cache.getRun(started.id)?.resume ?? ''
    assert.match(resumed, new RegExp(`^cd ~/\\.local/state/pit-view/worktrees/run-${started.id} && codex resume codex-session-1 `))
    assert.match(resumed, /--add-dir ~\/dev\/orbit\/\.git /)
    const done = await finish(world, started, { reviewed: { kind: 'commit', sha: started.headOid } })
    assert.match(done.resume ?? '', /^cd ~\/dev\/orbit && codex resume codex-session-1 /)
    assert.match(done.resume ?? '', /--add-dir ~\/dev\/orbit\/\.git /)
    assert.doesNotMatch(done.resume ?? '', /worktrees\/run-/)
  } finally {
    await world.cleanup()
  }
})

// the engine's other paths for a scheduled row

test('a start the cap takes back at the last moment reads queued again in its own table, holds no worktree, and the owner\'s line never starts it', async () => {
  const world = await setup({ config: { maxConcurrentReviews: 2 } })
  try {
    world.server.poller.refresh('manual')
    await world.server.poller.idle()
    const manual = await world.server.launcher.start({ repo: scenario.repo, number: 106, command: 'review-pr', args: ['106'], label: 'Review' })
    const held = Promise.withResolvers<void>()
    world.git.state.holdFetch = held.promise
    world.time.advance(15 * minute)
    await waitFor(() => world.git.verbs('fetch').length === 1)
    const starting = running(world)[0]
    assert.ok(starting)
    const queuedSince = world.server.cache.getRun(starting.id)?.queuedAt
    const stored = await (await fetch(`${world.server.url}/api/config`)).json() as Config
    assert.equal((await fetch(`${world.server.url}/api/config`, { method: 'PUT', headers: headers(world), body: JSON.stringify({ ...stored, maxConcurrentReviews: 1 }) })).status, 200)
    held.resolve()
    await world.server.scheduler.idle()
    const back = world.server.cache.getRun(starting.id)
    assert.equal(back?.status, 'queued')
    assert.equal(back?.worktree, null)
    assert.equal(back?.queuedAt, queuedSince)
    assert.equal(world.git.state.worktrees.size, 0)
    assert.equal(world.launch.children.length, 1)
    // the owner's review ending starts no scheduled row: only a tick does
    world.launch.children[0]!.exit(0)
    await world.server.launcher.settled(manual.id)
    await world.server.launcher.flushed()
    await world.server.scheduler.idle()
    assert.equal(world.launch.children.length, 1)
    assert.equal(world.server.cache.getRun(starting.id)?.status, 'queued')
  } finally {
    await world.cleanup()
  }
})

test('a live scheduled self-review watched again after a restart counts as one of the cap\'s own', async () => {
  const world = await setup({ auto: { others: false, own: true }, config: { maxConcurrentReviews: 1, selfReviewOverCap: true } })
  try {
    await tick(world)
    const started = running(world)[0]
    assert.ok(started)
    assert.equal(started.reason, 'selfReview')
    await world.restart()
    assert.equal(world.server.cache.getRun(started.id)?.status, 'running')
    // counted as a review it fills the cap of 1; counted as a self-review it would leave room for one
    assert.equal(world.server.launcher.queueing().review, true)
    // the setting's one place over the cap is still free for a self-review the owner starts
    assert.equal(world.server.launcher.queueing().selfReview, false)
  } finally {
    await world.cleanup()
  }
})

test('a clone that stops being one between the tick\'s check and the start fails the run as spawnFailed, and gh refusing there leaves it queued', async () => {
  const world = await setup()
  try {
    const answer = world.git.runner
    let remoteCalls = 0
    world.launch.deps.git = async (args, options) => {
      if (args[2] === 'remote') {
        remoteCalls += 1
        if (remoteCalls > 1) return failed('fatal: not a git repository')
      }
      return answer(args, options)
    }
    await world.restart()
    world.time.advance(15 * minute)
    await world.server.scheduler.idle()
    const failure = autoRuns(world).find((run) => run.status === 'failed')
    assert.match(failure?.note ?? '', /^spawnFailed: /)
    assert.equal(world.launch.children.length, 0)
  } finally {
    await world.cleanup()
  }
  const refused = await setup()
  try {
    // the tick's own check passes, and the login changes during its cycle, ahead of the start's check
    const held = Promise.withResolvers<void>()
    refused.gh.hold = held.promise
    refused.time.advance(15 * minute)
    await waitFor(() => graphqlCalls(refused) > 0)
    refused.gh.login = 'somebody-else'
    held.resolve()
    await refused.server.scheduler.idle()
    assert.equal(refused.launch.children.length, 0)
    assert.ok(autoRuns(refused).length > 0)
    assert.ok(autoRuns(refused).every((run) => run.status === 'queued'))
    assert.deepEqual(refused.git.verbs('fetch'), [])
  } finally {
    await refused.cleanup()
  }
})

test('an opt-in turned off leaves what it queued waiting, and starts none of it', async () => {
  const world = await setup({ auto: { concurrency: 1 } })
  try {
    await tick(world)
    const spawned = world.launch.children.length
    const stored = await (await fetch(`${world.server.url}/api/config`)).json() as Config
    assert.equal((await fetch(`${world.server.url}/api/config`, { method: 'PUT', headers: headers(world), body: JSON.stringify({ ...stored, autoReview: { ...stored.autoReview, others: false } }) })).status, 200)
    await world.server.poller.idle()
    await finish(world, running(world)[0]!)
    await tick(world)
    assert.equal(world.launch.children.length, spawned)
    assert.ok(autoRuns(world).some((run) => run.status === 'queued'))
  } finally {
    await world.cleanup()
  }
})

test('the mapping onto the pure rules: a run that never started has no start time, and a manual review\'s head comes from what it reviewed', async () => {
  const world = await setup()
  try {
    const cache = world.server.cache
    const base = { repo: scenario.repo, number: 106, command: 'review-pr', args: ['106'], label: 'Review', runner: 'claude' as const, cwd: '~/x', sessionId: null, pid: null, pidStartedAt: null, startedAt: '2026-10-26T14:00:00Z', lastStepAt: null, step: null, stepState: null, finishedAt: null, result: null, note: null, costUsd: null, resume: null }
    const make = (patch: Partial<Run>): Run => cache.updateRun(cache.createRun({ ...base, status: 'queued' }, (id) => `~/runs/${id}`).id, patch)
    assert.equal(toAutoRun(make({ status: 'queued' })).startedAt, null)
    assert.equal(toAutoRun(make({ status: 'running' })).startedAt, '2026-10-26T14:00:00Z')
    assert.equal(toAutoRun(make({ status: 'stopped' })).startedAt, null)
    assert.equal(toAutoRun(make({ status: 'failed', note: 'worktreeFailed: no' })).startedAt, null)
    assert.equal(toAutoRun(make({ status: 'stopped', pid: 44 })).startedAt, '2026-10-26T14:00:00Z')
    const finished = reviewResult({ reviewed: { kind: 'commit', sha: 'abc1234' } }) as unknown as Run['result']
    const reviewed = toAutoRun(make({ status: 'done', result: finished }))
    assert.equal(reviewed.headOid, 'abc1234')
    assert.equal(reviewed.posted, true)
    assert.equal(toAutoRun(make({ status: 'done', result: reviewResult({ reviewed: null }) as unknown as Run['result'] })).headOid, null)
    assert.equal(toAutoRun(make({ status: 'failed', result: reviewResult({ posted: null, notPostedReason: 'ghFailed' }) as unknown as Run['result'] })).ghFailed, true)
    assert.equal(toAutoRun(make({ headOid: 'def5678', result: finished, status: 'done' })).headOid, 'def5678')
    assert.equal(toAutoRun(make({ status: 'failed' }), new Set([cache.allRuns().at(-1)?.id ?? 0])).settled, true)
    const started = make({ status: 'failed', steps: [{ step: 'post', state: 'started', at: null, note: null }] })
    assert.equal(toAutoRun(started).postStarted, true)
    const sweep = cache.createSweep({ ...base, status: 'stopped' }, (id) => `~/sweeps/${id}`)
    assert.equal(toAutoSweep(sweep).startedAt, null)
    assert.equal(toAutoSweep(sweep, new Set([sweep.id])).settled, true)
  } finally {
    await world.cleanup()
  }
})

// the view, the feed, and the endpoints

test('the view and the feed carry autoReview: counts, the last tick, what posts, and a patch whenever it changes', async () => {
  const world = await setup({ auto: { post: { others: false, dependabot: true } } })
  const patches: Patch[] = []
  const controller = new AbortController()
  try {
    const stream = await fetch(`${world.server.url}/api/events?client=auto-test`, { signal: controller.signal })
    const decoder = new TextDecoder()
    void (async () => {
      let buffer = ''
      for await (const chunk of stream.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true })
        for (;;) {
          const at = buffer.indexOf('\n\n')
          if (at < 0) break
          const frame = buffer.slice(0, at)
          buffer = buffer.slice(at + 2)
          if (frame.startsWith('event: patch\n')) patches.push(JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as Patch)
        }
      }
    })().catch(() => {})
    await waitFor(() => world.server.clients.activeCount() === 1)
    await world.server.poller.idle()
    await tick(world)
    await waitFor(() => patches.some((patch) => patch.autoReview?.running === 1))
    const view = await (await fetch(`${world.server.url}/api/view`)).json() as { autoReview: NonNullable<ReturnType<PitServer['scheduler']['view']>> }
    assert.equal(view.autoReview.enabled, true)
    assert.equal(view.autoReview.state, 'running')
    assert.equal(view.autoReview.running, 1)
    assert.ok(view.autoReview.queued > 0)
    assert.equal(view.autoReview.startedToday, 1)
    assert.deepEqual(view.autoReview.posting, { others: false, dependabot: true })
    assert.equal(view.autoReview.lastTick?.at, '2026-10-26T14:20:38Z')
    assert.equal(view.autoReview.lastTick?.state, 'ran')
    assert.equal(view.autoReview.lastTick?.skipReason, null)
    assert.equal(view.autoReview.lastTick?.queued, view.autoReview.queued + 1)
    assert.equal(view.autoReview.nextTickAt, '2026-10-26T14:35:38Z')
    assert.equal(view.autoReview.sweepHold, null)
    // an unchanged answer sends nothing
    const count = patches.filter((patch) => patch.autoReview !== undefined).length
    world.server.poller.autoReviewChanged()
    assert.equal(patches.filter((patch) => patch.autoReview !== undefined).length, count)
  } finally {
    controller.abort()
    await world.cleanup()
  }
})

test('GET /api/auto-review/ticks lists recent ticks newest first', async () => {
  const world = await setup()
  try {
    world.gh.login = 'somebody-else'
    await tick(world)
    world.gh.login = scenario.viewer
    await tick(world)
    const response = await fetch(`${world.server.url}/api/auto-review/ticks`)
    assert.equal(response.status, 200)
    const body = await response.json() as { state: string, skipReason: string | null }[]
    assert.deepEqual(body.map((row) => row.state), ['ran', 'skipped'])
    assert.equal(body[1]?.skipReason, 'identityMismatch')
  } finally {
    await world.cleanup()
  }
})

test('POST /api/auto-review/run needs the Origin and the token, runs one tick outside active hours, still makes its checks, and refuses while off', async () => {
  const world = await setup({ now: saturday })
  try {
    const url = `${world.server.url}/api/auto-review/run`
    assert.equal((await fetch(url, { method: 'POST' })).status, 403)
    assert.equal((await fetch(url, { method: 'POST', headers: { 'x-pit-view-token': world.server.token } })).status, 403)
    assert.equal((await fetch(url, { method: 'POST', headers: { Origin: world.server.url } })).status, 403)
    assert.equal((await fetch(url, { method: 'POST', headers: { Origin: 'https://evil.example.test', 'x-pit-view-token': world.server.token } })).status, 403)
    assert.equal(ticks(world).length, 0)
    const ran = await fetch(url, { method: 'POST', headers: headers(world) })
    assert.equal(ran.status, 200)
    assert.deepEqual(await ran.json(), { started: true, tick: 1 })
    await world.server.scheduler.idle()
    assert.equal(ticks(world)[0]?.state, 'ran')
    assert.equal(world.launch.children.length, 1)
    world.gh.login = 'somebody-else'
    assert.equal((await fetch(url, { method: 'POST', headers: headers(world) })).status, 200)
    await world.server.scheduler.idle()
    assert.equal(ticks(world)[0]?.skipReason, 'identityMismatch')
  } finally {
    await world.cleanup()
  }
  const off = await setup({ auto: { enabled: false } })
  try {
    assert.equal((await fetch(`${off.server.url}/api/auto-review/run`, { method: 'POST', headers: headers(off) })).status, 409)
    assert.equal(ticks(off).length, 0)
  } finally {
    await off.cleanup()
  }
})

test('PUT /api/config needs the Origin and the token, so another page cannot turn on auto-review or posting', async () => {
  const world = await setup({ auto: { enabled: false } })
  try {
    const url = `${world.server.url}/api/config`
    const stored = await (await fetch(url)).json() as Config
    const body = JSON.stringify({ ...stored, autoReview: { ...stored.autoReview, enabled: true, post: { others: true, dependabot: true } } })
    const json = { 'Content-Type': 'application/json' }
    assert.equal((await fetch(url, { method: 'PUT', headers: json, body })).status, 403)
    assert.equal((await fetch(url, { method: 'PUT', headers: { ...json, 'x-pit-view-token': world.server.token }, body })).status, 403)
    assert.equal((await fetch(url, { method: 'PUT', headers: { ...json, Origin: world.server.url }, body })).status, 403)
    assert.equal((await fetch(url, { method: 'PUT', headers: { ...json, Origin: world.server.url, 'x-pit-view-token': 'wrong' }, body })).status, 403)
    assert.equal(((await (await fetch(url)).json()) as Config).autoReview?.enabled, false)
    assert.equal((await fetch(url, { method: 'PUT', headers: headers(world), body })).status, 200)
    assert.equal(((await (await fetch(url)).json()) as Config).autoReview?.enabled, true)
  } finally {
    await world.cleanup()
  }
})
