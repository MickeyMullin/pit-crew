// test/scheduler.test.ts
// the auto-review scheduler's runtime (section 10 of DESIGN.md): its own clock, the tick's steps, the launch through the launcher's engine, the worktrees, recovery, and the endpoints, all against a fake gh, a fake git, a fake clock, and a fake runner
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { indicatorWords } from '../public/autoreviewbar.ts'
import { nowLine } from '../public/settings-form.ts'
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
  gh: { login: string | null, failCycle: boolean, hold: Promise<void> | null, holdUser: Promise<void> | null, calls: string[][] }
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
  const gh = { login: scenario.viewer as string | null, failCycle: false, hold: null as Promise<void> | null, holdUser: null as Promise<void> | null, calls: [] as string[][] }
  const runner: Runner = async (args, options) => {
    gh.calls.push(args)
    if (args[0] === 'api' && args[1] === 'user' && gh.holdUser !== null) await gh.holdUser
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

// the posting switch at the spawn: a run built to post has awaits ahead of it (the identity check, the fetch, the add, and the run directory), and a switch turned off during any of them must reach the process it starts

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
    // the run ending starts the next at once, held at its worktree add while the switch is saved
    const held = Promise.withResolvers<void>()
    world.git.state.holdAdd = held.promise
    const added = world.git.verbs('worktree', 'add').length
    await endWithoutIdle(world, first)
    await waitFor(() => world.git.verbs('worktree', 'add').length === added + 1)
    await savePost(world, { others: false, dependabot: true })
    held.resolve()
    await world.server.scheduler.idle()
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
    // it may answer queued while the second review's launch has yet to return (section 8, Queueing), and spawn once that has
    await waitFor(() => world.launch.children.length === 3)
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
    const failure = autoRuns(bad).find((run) => run.status === 'failed')
    assert.ok(failure)
    assert.match(failure.note ?? '', /^worktreeFailed: /)
    assert.equal(failure.pid, null)
    // the slot came back, and the row behind the failed one took it in the same pass; the failed start did not count toward the daily limit, the next did
    assert.equal(bad.launch.children.length, 1)
    assert.equal(bad.server.cache.getRun(failure.id)?.status, 'failed')
    assert.equal(bad.server.scheduler.view()?.startedToday, 1)
    // the limit of one is spent, so the next tick retries nothing until the day ends
    await tick(bad)
    assert.equal(bad.launch.children.length, 1)
    assert.equal(ticks(bad)[0]?.skipReason, 'dailyLimit')
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

// rows a test seeds to reach a state a tick would take many steps to, each with the fields a scheduled run leaves; a pid means it really started

const sessionFields = (status: Run['status'], pid: number | null) => ({
  command: 'review-pr', label: 'Review', runner: 'claude' as const, cwd: '~/x', sessionId: null, pid, pidStartedAt: pid === null ? null : `start-${pid}`, startedAt: '2026-10-26T14:00:00Z', lastStepAt: null, step: null, stepState: null, finishedAt: status === 'running' || status === 'queued' ? null : '2026-10-26T14:01:00Z', status, result: null, note: null, costUsd: null, resume: null, origin: 'auto' as const,
})

const seedRun = (world: World, { repo = scenario.repo, number, status, pid = null, head = null }: { repo?: string, number: number, status: Run['status'], pid?: number | null, head?: string | null }): Run => {
  const run = world.server.cache.createRun({ repo, number, args: [String(number)], ...sessionFields(status, pid) }, (id) => `~/.local/state/pit-view/runs/${id}`)
  return head === null ? run : world.server.cache.updateRun(run.id, { headOid: head })
}

const seedSweep = (world: World, { repo = scenario.repo, status, pid = null }: { repo?: string, status: Sweep['status'], pid?: number | null }): Sweep =>
  world.server.cache.createSweep({ repo, args: [repo], ...sessionFields(status, pid) }, (id) => `~/.local/state/pit-view/sweeps/${id}`)

// a worktree git lists for the row, as the row records it
const seedWorktree = async (world: World, kind: 'run' | 'sweep', id: number): Promise<string> => {
  await mkdir(world.worktrees, { recursive: true })
  const path = join(await realpath(world.worktrees), `${kind}-${id}`)
  world.git.state.worktrees.add(path)
  const changes = { worktree: `~/.local/state/pit-view/worktrees/${kind}-${id}` }
  if (kind === 'run') world.server.cache.updateRun(id, changes)
  else world.server.cache.updateSweep(id, changes)
  return path
}

const listed = async (world: World): Promise<void> => {
  world.server.poller.refresh('manual')
  await world.server.poller.idle()
}

const headOf = (world: World, number: number): string => {
  const row = world.server.cache.readView(scenario.repo).open.find((entry) => entry.number === number)
  assert.ok(row, `#${number} is open`)
  return row.pr.headRefOid
}

const otherRepo = 'octo-example/another'

const removedNames = (world: World): string[] => world.git.verbs('worktree', 'remove').map((call) => basename(call.args[4] ?? '')).sort()

// a run or a sweep that ends each way a worktree outlives it: failed, waiting for input, or found running with its process gone and no result.json, which recovery marks failed with the note serverRestarted
const unsettledShapes = [
  { seeded: 'failed', ends: 'failed', note: null },
  { seeded: 'needsInput', ends: 'needsInput', note: null },
  { seeded: 'running', ends: 'failed', note: /^serverRestarted/ },
] as const

// the settlement of a run, in two repositories

test('two repositories with the same PR number: a later started run of the other repository settles nothing here, at a restart or at a tick, whether the run here failed, waits for input, or crashed; a later started run of its own repository does', async () => {
  for (const { seeded, ends, note } of unsettledShapes) {
    const world = await setup({ auto: { others: false } })
    try {
      await listed(world)
      const head = headOf(world, 113)
      const pid = (base: number): number | null => seeded === 'running' ? base : null
      const here = seedRun(world, { number: 113, status: seeded, pid: pid(6101), head })
      const there = seedRun(world, { repo: otherRepo, number: 113, status: seeded, pid: pid(6102), head })
      seedRun(world, { repo: otherRepo, number: 113, status: 'done', pid: 6103, head })
      const pathHere = await seedWorktree(world, 'run', here.id)
      const pathThere = await seedWorktree(world, 'run', there.id)
      // the same shape, on another PR, with the later run in its own repository
      const superseded = seedRun(world, { number: 106, status: seeded, pid: pid(6104), head: headOf(world, 106) })
      seedRun(world, { number: 106, status: 'done', pid: 6105, head: headOf(world, 106) })
      const pathSuperseded = await seedWorktree(world, 'run', superseded.id)
      await world.restart()
      const after = world.server.cache.getRun(here.id)
      assert.equal(after?.status, ends, seeded)
      if (note !== null) assert.match(after?.note ?? '', note)
      assert.notEqual(after?.worktree, null, `${seeded}: the row keeps its worktree`)
      assert.deepEqual(removedNames(world), [`run-${superseded.id}`], `${seeded}: at the restart`)
      assert.ok(world.git.state.worktrees.has(pathHere))
      assert.ok(world.git.state.worktrees.has(pathThere))
      assert.equal(world.git.state.worktrees.has(pathSuperseded), false)
      assert.equal(world.server.cache.getRun(superseded.id)?.worktree, null)
      await tick(world)
      assert.equal(ticks(world)[0]?.state, 'ran')
      assert.deepEqual(removedNames(world), [`run-${superseded.id}`], `${seeded}: at the tick`)
      assert.ok(world.git.state.worktrees.has(pathHere))
      assert.notEqual(world.server.cache.getRun(here.id)?.worktree, null)
    } finally {
      await world.cleanup()
    }
  }
})

test('two repositories: a later started sweep of the other repository settles no sweep here and lifts no hold, whether the sweep here failed, waits for input, or crashed; a later started sweep of its own repository does', async () => {
  for (const { seeded, ends, note } of unsettledShapes) {
    const world = await setup({ auto: { others: false } })
    try {
      const pid = (base: number): number | null => seeded === 'running' ? base : null
      const here = seedSweep(world, { status: seeded, pid: pid(6201) })
      const there = seedSweep(world, { repo: otherRepo, status: seeded, pid: pid(6202) })
      seedSweep(world, { repo: otherRepo, status: 'done', pid: 6203 })
      const pathHere = await seedWorktree(world, 'sweep', here.id)
      const pathThere = await seedWorktree(world, 'sweep', there.id)
      await world.restart()
      const after = world.server.cache.getSweep(here.id)
      assert.equal(after?.status, ends, seeded)
      if (note !== null) assert.match(after?.note ?? '', note)
      assert.notEqual(after?.worktree, null, `${seeded}: the row keeps its worktree`)
      assert.deepEqual(removedNames(world), [], `${seeded}: at the restart`)
      assert.equal(world.server.scheduler.view()?.sweepHold, ends === 'needsInput' ? 'needsInput' : null, seeded)
      await tick(world)
      assert.deepEqual(removedNames(world), [], `${seeded}: at the tick`)
      assert.ok(world.git.state.worktrees.has(pathHere))
      assert.ok(world.git.state.worktrees.has(pathThere))
      seedSweep(world, { status: 'done', pid: 6204 })
      await tick(world)
      assert.deepEqual(removedNames(world), [`sweep-${here.id}`], `${seeded}: once one of its own has started`)
      assert.equal(world.server.scheduler.view()?.sweepHold, null, seeded)
      assert.ok(world.git.state.worktrees.has(pathThere))
    } finally {
      await world.cleanup()
    }
  }
})

test('rows of another repository with the same PR number hold nothing in this one\'s tick: no live run, done run, stop, or failures of theirs reach a PR here, and a failure here counts once', async () => {
  const world = await setup({ auto: { dependabot: true, concurrency: 1 } })
  try {
    await listed(world)
    const qualifying = world.server.poller.openRows().filter((row) => row.section === 'others' && row.group === 'yourMove' && row.number !== 114 && row.number !== 115).map((row) => row.number)
    assert.ok(qualifying.length >= 2)
    const theirs: Run[] = []
    for (const number of qualifying) {
      const head = headOf(world, number)
      for (const status of ['done', 'stopped', 'failed', 'failed', 'queued'] as const) theirs.push(seedRun(world, { repo: otherRepo, number, status, pid: status === 'queued' ? null : 6300, head }))
    }
    seedSweep(world, { repo: otherRepo, status: 'failed', pid: 6301 })
    seedSweep(world, { repo: otherRepo, status: 'failed', pid: 6302 })
    const first = qualifying[0]!
    const failedHere = seedRun(world, { number: first, status: 'failed', pid: 6303, head: headOf(world, first) })
    await tick(world)
    const here = autoRuns(world).filter((run) => run.repo === scenario.repo && run.id !== failedHere.id)
    assert.deepEqual([...new Set(here.map((run) => run.number))].sort(), [...qualifying].sort())
    assert.equal(ticks(world)[0]?.alreadyCurrent, 0)
    // its retry is queued or running, and it is not marked as failed twice
    assert.ok(here.some((run) => run.number === first && (run.status === 'queued' || run.status === 'running')))
    assert.equal(world.server.cache.getRun(failedHere.id)?.note, null)
    for (const run of theirs) assert.equal(world.server.cache.getRun(run.id)?.note, null)
    assert.equal(world.server.cache.allSweeps().filter((sweep) => sweep.repo === scenario.repo).length, 1)
    assert.equal(world.server.scheduler.view()?.sweepHold, null)
  } finally {
    await world.cleanup()
  }
})

// restart recovery

test('at startup, whether or not auto-review is on, the sweep removes the worktree of a crashed run that is settled, a done run\'s leftover, and one with no row, and leaves a crashed run still unsettled, a live run, a queued one, and anything else alone', async () => {
  const world = await setup({ auto: { enabled: false } })
  try {
    await listed(world)
    // a crash: recorded as running, its process gone, and no result.json. One has a newer run of its PR in this repository, one's PR is no longer open, and one's PR is still open at its head
    const superseded = seedRun(world, { number: 106, status: 'running', pid: 7101, head: headOf(world, 106) })
    seedRun(world, { number: 106, status: 'done', pid: 7102, head: headOf(world, 106) })
    const closed = seedRun(world, { number: 109, status: 'running', pid: 7103, head: headOf(world, 109) })
    const unsettled = seedRun(world, { number: 111, status: 'running', pid: 7104, head: headOf(world, 111) })
    world.server.cache.closePr(scenario.repo, 109)
    const leftover = seedRun(world, { number: 108, status: 'done', head: headOf(world, 108) })
    const liveRun = seedRun(world, { number: 113, status: 'running', pid: 5151, head: headOf(world, 113) })
    const queued = seedRun(world, { number: 107, status: 'queued' })
    world.launch.alive.add(5151)
    world.launch.processes.push({ pid: 5151, ppid: 1, pgid: 5151 })
    const worktreeOf = async (run: Run): Promise<string> => seedWorktree(world, 'run', run.id)
    const pathSuperseded = await worktreeOf(superseded)
    const pathClosed = await worktreeOf(closed)
    const pathUnsettled = await worktreeOf(unsettled)
    const pathLeftover = await worktreeOf(leftover)
    const pathLive = await worktreeOf(liveRun)
    const pathQueued = await worktreeOf(queued)
    const folder = await realpath(world.worktrees)
    // no row at all
    world.git.state.worktrees.add(join(folder, 'run-999'))
    // not Pit View's: another name in the folder, and one elsewhere
    world.git.state.worktrees.add(join(folder, 'scratch'))
    world.git.state.worktrees.add(join(world.clone, 'run-5'))
    // a directory git no longer lists is reported, not deleted
    await mkdir(join(world.worktrees, 'run-777'), { recursive: true })
    const githubCalls = world.gh.calls.filter((args) => args[0] === 'api').length
    await world.restart()
    const cache = world.server.cache
    for (const crashed of [superseded, closed, unsettled]) {
      const row = cache.getRun(crashed.id)
      assert.equal(row?.status, 'failed', `run ${crashed.id}`)
      assert.match(row?.note ?? '', /^serverRestarted/)
    }
    assert.deepEqual(removedNames(world), [`run-${superseded.id}`, `run-${closed.id}`, `run-${leftover.id}`, 'run-999'].sort())
    for (const gone of [pathSuperseded, pathClosed, pathLeftover]) assert.equal(world.git.state.worktrees.has(gone), false)
    for (const run of [superseded, closed, leftover]) assert.equal(cache.getRun(run.id)?.worktree, null, `run ${run.id}`)
    // its PR is open at the head it reviewed and no newer run has started, so the owner may still resume it, where its worktree is
    assert.ok(world.git.state.worktrees.has(pathUnsettled))
    assert.notEqual(cache.getRun(unsettled.id)?.worktree, null)
    assert.ok(world.git.state.worktrees.has(pathLive))
    assert.ok(world.git.state.worktrees.has(pathQueued))
    assert.ok(world.git.state.worktrees.has(join(folder, 'scratch')))
    assert.ok(world.git.state.worktrees.has(join(world.clone, 'run-5')))
    assert.ok(world.git.verbs('worktree', 'remove').every((call) => !call.args.includes('--force')))
    assert.equal(world.git.verbs('worktree', 'prune').length > 0, true)
    assert.deepEqual(world.server.scheduler.view()?.worktrees.unlisted, ['run-777'])
    assert.equal(cache.getRun(liveRun.id)?.status, 'running')
    assert.equal(cache.getRun(queued.id)?.status, 'queued')
    // no GitHub call, and auto-review stayed off
    assert.equal(world.gh.calls.filter((args) => args[0] === 'api').length, githubCalls)
    assert.equal(ticks(world).length, 0)
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
    // the owner's review ending opens the cap, and the oldest scheduled self-review starts at once, with no tick; the cap holds it to one
    world.launch.children[0]!.exit(0)
    await world.server.launcher.settled(manual.id)
    await world.server.scheduler.idle()
    assert.equal(world.launch.children.length, spawned + 1)
    assert.equal(running(world).length, 1)
    assert.equal(ticks(world).length, 1)
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

// the header's words and the Settings Now line, read from the scheduler's own view as the page reads them
const pageWords = async (world: World): Promise<{ header: string | undefined, now: string, fix: string | null }> => {
  const stored = await (await fetch(`${world.server.url}/api/config`)).json() as Config
  const reading = { nowMs: world.time.clock.now(), timeZone: scenario.timeZone }
  const view = world.server.scheduler.view()
  const line = nowLine({ saved: stored.autoReview, view, viewer: 'octocat', reading })
  return { header: indicatorWords(view, reading)?.body, now: line.text, fix: line.fix }
}

// the view's answer once a tick has skipped as dailyLimit and the saved limit changes before the next tick
const skippedAtLimit = async (world: World): Promise<void> => {
  await tick(world)
  while (running(world).length > 0) await finish(world, running(world)[0]!)
  await tick(world)
  assert.equal(ticks(world)[0]?.skipReason, 'dailyLimit')
  assert.equal(world.server.scheduler.view()?.state, 'blocked')
  assert.equal(world.server.scheduler.view()?.lastTick?.skipReason, 'dailyLimit')
}

test('a daily limit saved as 0 after a dailyLimit skip stops that skip counting as the status: the view is idle and carries no lastTick, the page gets the patch, and the recorded tick stays as it was', async () => {
  const world = await setup({ auto: { dailyLimit: 1, concurrency: 1 } })
  const patches: Patch[] = []
  const controller = new AbortController()
  try {
    const stream = await fetch(`${world.server.url}/api/events?client=limit-test`, { signal: controller.signal })
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
    await skippedAtLimit(world)
    const recorded = ticks(world)[0]
    patches.length = 0
    await saveAuto(world, { dailyLimit: 0 })
    await world.server.scheduler.idle()
    // with no limit the save opens room, and the oldest queued run starts at once
    const view = world.server.scheduler.view()
    assert.equal(view?.state, 'running')
    assert.equal(view?.lastTick, null)
    assert.equal(view?.startedToday, 2)
    assert.notEqual(view?.nextTickAt, null)
    const words = await pageWords(world)
    assert.equal(words.header?.includes('daily limit'), false)
    assert.equal(words.now.includes('daily limit'), false)
    assert.equal(words.fix, null)
    // the open page is told in the same step as the save, not at the next tick
    await waitFor(() => patches.some((patch) => patch.autoReview?.lastTick === null))
    assert.equal(patches.find((patch) => patch.autoReview?.lastTick === null)?.autoReview?.enabled, true)
    // nothing recorded is rewritten or removed
    assert.deepEqual(ticks(world)[0], recorded)
  } finally {
    controller.abort()
    await world.cleanup()
  }
})

test('a daily limit raised above the runs started today stops a dailyLimit skip counting too, and the next tick records its own state', async () => {
  const world = await setup({ auto: { dailyLimit: 1, concurrency: 1 } })
  try {
    await skippedAtLimit(world)
    await saveAuto(world, { dailyLimit: 5 })
    await world.server.scheduler.idle()
    // the raised limit opens room, and the oldest queued run starts at once
    assert.equal(world.server.scheduler.view()?.startedToday, 2)
    assert.equal(world.server.scheduler.view()?.state, 'running')
    assert.equal(world.server.scheduler.view()?.lastTick, null)
    const words = await pageWords(world)
    assert.equal(words.header?.includes('daily limit'), false)
    assert.equal(words.now.includes('daily limit'), false)
    assert.equal(words.fix, null)
    await tick(world)
    assert.equal(ticks(world)[0]?.state, 'ran')
    assert.equal(world.server.scheduler.view()?.lastTick?.state, 'ran')
  } finally {
    await world.cleanup()
  }
})

test('a daily limit that is lowered or left as it was while still reached keeps the dailyLimit skip as the status: blocked, with the skip as the last tick', async () => {
  const world = await setup({ auto: { dailyLimit: 2, concurrency: 2 } })
  try {
    await skippedAtLimit(world)
    assert.equal(world.server.scheduler.view()?.startedToday, 2)
    await saveAuto(world, { concurrency: 1 })
    assert.equal(world.server.scheduler.view()?.state, 'blocked')
    assert.equal(world.server.scheduler.view()?.lastTick?.skipReason, 'dailyLimit')
    await saveAuto(world, { dailyLimit: 1 })
    assert.equal(world.server.scheduler.view()?.state, 'blocked')
    assert.equal(world.server.scheduler.view()?.lastTick?.skipReason, 'dailyLimit')
    assert.equal(world.server.scheduler.view()?.lastTick?.state, 'skipped')
    const words = await pageWords(world)
    assert.equal(words.header, 'skipped: daily limit reached')
    assert.equal(words.now, 'Skipped: daily limit reached')
    assert.equal(words.fix, 'Runs started today have reached the daily limit; it starts over tomorrow.')
  } finally {
    await world.cleanup()
  }
})

test('a daily limit of 0 never skips a tick as dailyLimit and never leaves a run queued for it, while concurrency still bounds the starts', async () => {
  const world = await setup({ auto: { dailyLimit: 0, concurrency: 1 } })
  try {
    await tick(world)
    assert.equal(ticks(world)[0]?.state, 'ran')
    assert.equal(world.launch.children.length, 1)
    assert.equal(world.server.scheduler.view()?.startedToday, 1)
    await finish(world, running(world)[0]!)
    // one started today and the limit is 0: the next tick still runs and starts the next, where a limit of 1 would have skipped
    await tick(world)
    assert.equal(ticks(world)[0]?.state, 'ran')
    assert.notEqual(ticks(world)[0]?.skipReason, 'dailyLimit')
    assert.equal(world.launch.children.length, 2)
    assert.equal(world.server.scheduler.view()?.state === 'blocked', false)
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
    // what the cache says when the run ends is what the start step reads, with no tick in between
    world.server.cache.closePr(scenario.repo, closing.number)
    const row = world.server.cache.readView(scenario.repo).open.find((entry) => entry.number === moving.number)
    assert.ok(row)
    world.server.cache.writePr(scenario.repo, { ...row.pr, headRefOid: 'abc1234abc1234abc1234abc1234abc1234abc12' }, scenario.defaultBranch)
    await finish(world, running(world)[0]!)
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
    // the owner's review ending opens the cap again, and the same row starts at once, without a tick
    world.launch.children[0]!.exit(0)
    await world.server.launcher.settled(manual.id)
    await world.server.launcher.flushed()
    await world.server.scheduler.idle()
    assert.equal(world.launch.children.length, 2)
    assert.equal(world.server.cache.getRun(starting.id)?.status, 'running')
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

// the line among queued runs: a run whose opt-in is off cannot start, so it is ahead of no one, and a run that can start and does not end up running ends the tick's starts

const saveAuto = async (world: World, patch: Partial<AutoReviewSettings>): Promise<void> => {
  const stored = await (await fetch(`${world.server.url}/api/config`)).json() as Config
  assert.equal((await fetch(`${world.server.url}/api/config`, { method: 'PUT', headers: headers(world), body: JSON.stringify({ ...stored, autoReview: { ...stored.autoReview, ...patch } }) })).status, 200)
}

const queuedOwn = (world: World): Run[] => autoRuns(world).filter((run) => run.status === 'queued' && run.reason === 'selfReview')
const queuedOthers = (world: World): Run[] => autoRuns(world).filter((run) => run.status === 'queued' && run.reason !== 'selfReview')

test('a tick passes a queued run whose opt-in is off, even the oldest: a later run that can start starts, the older one stays queued, and it starts first once its opt-in is back on', async () => {
  const world = await setup({ auto: { others: true, own: true, concurrency: 1 } })
  try {
    await tick(world)
    const older = queuedOthers(world)
    const own = queuedOwn(world)
    assert.ok(older.length > 0 && own.length > 0)
    assert.ok(older[0]!.id < own[0]!.id, 'the opted-out run is the oldest in the line')
    await saveAuto(world, { others: false })
    await finish(world, running(world)[0]!)
    await tick(world)
    assert.deepEqual(running(world).map((run) => run.id), [own[0]!.id])
    for (const run of older) {
      const row = world.server.cache.getRun(run.id)
      assert.equal(row?.status, 'queued')
      assert.equal(row?.worktree, null)
    }
    assert.equal(ticks(world)[0]?.state, 'ran')
    // it kept its place
    await saveAuto(world, { others: true })
    await finish(world, running(world)[0]!)
    await tick(world)
    assert.deepEqual(running(world).map((run) => run.id), [older[0]!.id])
  } finally {
    await world.cleanup()
  }
})

test('Run now passes a queued run whose opt-in is off too, and the sweep behind it starts', async () => {
  const world = await setup({ auto: { others: true, dependabot: true, concurrency: 1 } })
  try {
    await tick(world)
    const older = queuedOthers(world)
    assert.ok(older.length > 0)
    const sweep = world.server.cache.allSweeps().find((entry) => entry.origin === 'auto')
    assert.equal(sweep?.status, 'queued')
    await saveAuto(world, { others: false })
    await finish(world, running(world)[0]!)
    assert.equal(world.server.scheduler.runNow()?.started, true)
    await world.server.scheduler.idle()
    assert.equal(world.server.cache.getSweep(sweep!.id)?.status, 'running')
    for (const run of older) assert.equal(world.server.cache.getRun(run.id)?.status, 'queued')
  } finally {
    await world.cleanup()
  }
})

test('within one tick, an opt-in turned off while a run is being started passes the rest of that kind, queued by that same tick, and a later run that can start starts', async () => {
  const world = await setup({ auto: { others: true, own: true, concurrency: 2 }, config: { maxConcurrentReviews: 4 } })
  try {
    let release = (): void => {}
    world.git.state.holdAdd = new Promise<void>((resume) => {
      release = resume
    })
    world.time.advance(15 * minute)
    await waitFor(() => world.git.verbs('worktree', 'add').length === 1)
    await saveAuto(world, { others: false })
    const older = queuedOthers(world)
    const own = queuedOwn(world)
    assert.ok(older.length > 0 && own.length > 0)
    assert.ok(older[0]!.id < own[0]!.id, 'an opted-out run is first in the line')
    release()
    await world.server.scheduler.idle()
    assert.equal(world.server.cache.getRun(own[0]!.id)?.status, 'running')
    for (const run of older) assert.equal(world.server.cache.getRun(run.id)?.status, 'queued')
    assert.equal(running(world).length, 2)
  } finally {
    await world.cleanup()
  }
})

test('a queued run that fails to start does not hold the rows behind it: the next is tried, an opted-out run ahead of it is passed, and the failed row is not tried again', async () => {
  const world = await setup({ auto: { others: true, own: true, concurrency: 3 }, config: { maxConcurrentReviews: 4 } })
  const failFetch = async (target: World): Promise<void> => {
    target.git.state.fetchFailures = 2
    const before = target.git.verbs('fetch').length
    target.time.advance(15 * minute)
    await waitFor(() => target.git.verbs('fetch').length === before + 1)
    await waitFor(() => target.time.pending() > 0)
    target.time.advance(5000)
    await target.server.scheduler.idle()
    // the failed row's two fetches, then one for each of the rows behind it that started
    assert.ok(target.git.verbs('fetch').length >= before + 3)
  }
  try {
    await failFetch(world)
    const failure = autoRuns(world).filter((run) => run.status === 'failed')
    assert.equal(failure.length, 1)
    assert.match(failure[0]!.note ?? '', /^worktreeFailed: /)
    assert.equal(failure[0]!.id, Math.min(...autoRuns(world).map((run) => run.id)), 'the oldest was the one tried')
    assert.equal(world.launch.children.length, 3)
    assert.equal(running(world).length, 3)
    assert.ok(running(world).every((run) => run.id !== failure[0]!.id))
  } finally {
    await world.cleanup()
  }
  const passed = await setup({ auto: { others: true, own: true, concurrency: 1 } })
  try {
    await tick(passed)
    const older = queuedOthers(passed)
    const own = queuedOwn(passed)
    assert.ok(older.length > 0 && own.length >= 3)
    await saveAuto(passed, { others: false })
    await finish(passed, running(passed)[0]!)
    assert.equal(passed.server.cache.getRun(own[0]!.id)?.status, 'running')
    passed.git.state.fetchFailures = 2
    const fetched = passed.git.verbs('fetch').length
    await endWithoutIdle(passed, running(passed)[0]!)
    await waitFor(() => passed.git.verbs('fetch').length === fetched + 1)
    await waitFor(() => passed.time.pending() > 0)
    passed.time.advance(5000)
    await passed.server.scheduler.idle()
    assert.match(passed.server.cache.getRun(own[1]!.id)?.note ?? '', /^worktreeFailed: /)
    assert.equal(passed.server.cache.getRun(own[1]!.id)?.status, 'failed')
    assert.equal(passed.server.cache.getRun(own[2]!.id)?.status, 'running')
    for (const run of older) assert.equal(passed.server.cache.getRun(run.id)?.status, 'queued')
  } finally {
    await passed.cleanup()
  }
})

test('the mapping onto the pure rules: a run that never started has no start time, and a manual review\'s head comes from what it reviewed', async () => {
  const world = await setup()
  try {
    const cache = world.server.cache
    const base = { repo: scenario.repo, number: 106, command: 'review-pr', args: ['106'], label: 'Review', runner: 'claude' as const, cwd: '~/x', sessionId: null, pid: null, pidStartedAt: null, startedAt: '2026-10-26T14:00:00Z', lastStepAt: null, step: null, stepState: null, finishedAt: null, result: null, note: null, costUsd: null, resume: null }
    const make = (patch: Partial<Run>): Run => cache.updateRun(cache.createRun({ ...base, status: 'queued' }, (id) => `~/runs/${id}`).id, patch)
    assert.equal(toAutoRun(make({ status: 'queued' })).repo, scenario.repo)
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
    assert.equal(toAutoSweep(sweep).repo, scenario.repo)
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

// the queue drains when a scheduled run ends or the cap has room, not at the next tick: "Check every" paces the board checks and the queueing alone (section 10, Scheduler)

const queuedAuto = (world: World): Run[] => autoRuns(world).filter((run) => run.status === 'queued').sort((a, b) => a.id - b.id)

// a run's process ends with a result, without waiting for the scheduler to go idle, since a start it triggers may be held
const endWithoutIdle = async (world: World, run: Run): Promise<void> => {
  const child = world.launch.children.find((candidate) => basename(candidate.request.cwd) === `run-${run.id}`)
  assert.ok(child, `run ${run.id} has a process`)
  await child.result(reviewResult({ target: { repo: scenario.repo, pr: run.number }, posted: null, notPostedReason: 'noPost' }))
  child.exit(0)
  await world.server.launcher.settled(run.id)
}

test('a scheduled run that ends starts the next queued one at once, in queue order, with no tick in between and never twice', async () => {
  const world = await setup({ auto: { concurrency: 1 }, config: { maxConcurrentReviews: 3 } })
  try {
    await tick(world)
    const line = queuedAuto(world)
    assert.ok(line.length >= 2, 'a queue longer than the concurrency')
    const first = running(world)[0]!
    const ticksBefore = ticks(world).length
    const clockBefore = world.time.clock.now()
    await finish(world, first)
    assert.equal(world.time.clock.now(), clockBefore, 'the clock did not move')
    assert.deepEqual(running(world).map((run) => run.id), [line[0]!.id])
    await finish(world, running(world)[0]!)
    assert.deepEqual(running(world).map((run) => run.id), [line[1]!.id])
    assert.equal(ticks(world).length, ticksBefore, 'no tick ran')
    assert.equal(world.launch.children.length, 3)
    // one worktree and one process per started row
    assert.equal(world.git.verbs('worktree', 'add').length, 3)
    assert.equal(new Set(world.launch.children.map((child) => child.request.cwd)).size, 3)
  } finally {
    await world.cleanup()
  }
})

test('a queue longer than the review cap drains as the owner\'s review and the scheduled runs end, each start taking the cap\'s room as it opens', async () => {
  const world = await setup({ auto: { concurrency: 5 }, config: { maxConcurrentReviews: 2 } })
  try {
    await tick(world)
    assert.equal(running(world).length, 2)
    const waiting = queuedAuto(world)
    assert.ok(waiting.length >= 2)
    await finish(world, running(world)[0]!)
    assert.equal(running(world).length, 2)
    assert.equal(world.server.cache.getRun(waiting[0]!.id)?.status, 'running')
    assert.equal(world.server.cache.getRun(waiting[1]!.id)?.status, 'queued')
  } finally {
    await world.cleanup()
  }
})

test('a cap raised by a save opens room that a queued scheduled run takes at once', async () => {
  const raised = await setup({ auto: { concurrency: 3 }, config: { maxConcurrentReviews: 1 } })
  try {
    await tick(raised)
    assert.equal(running(raised).length, 1)
    const stored = await (await fetch(`${raised.server.url}/api/config`)).json() as Config
    const saved = await fetch(`${raised.server.url}/api/config`, { method: 'PUT', headers: headers(raised), body: JSON.stringify({ ...stored, maxConcurrentReviews: 3 }) })
    assert.equal(saved.status, 200)
    await raised.server.scheduler.idle()
    assert.equal(running(raised).length, 3)
  } finally {
    await raised.cleanup()
  }
})

test('the drain stops at the daily limit, leaves the rest queued, and starts nothing outside the active hours', async () => {
  const world = await setup({ auto: { concurrency: 1, dailyLimit: 2 }, config: { maxConcurrentReviews: 3 } })
  try {
    await tick(world)
    await finish(world, running(world)[0]!)
    assert.equal(running(world).length, 1)
    assert.equal(world.server.scheduler.view()?.startedToday, 2)
    await finish(world, running(world)[0]!)
    assert.equal(running(world).length, 0, 'the limit of two is reached')
    assert.ok(queuedAuto(world).length > 0)
    assert.equal(world.launch.children.length, 2)
  } finally {
    await world.cleanup()
  }
  const closed = await setup({ auto: { concurrency: 1 }, config: { maxConcurrentReviews: 3 } })
  try {
    await tick(closed)
    const first = running(closed)[0]!
    // past 18:00 local: the window is shut, and a run in flight finishes
    closed.time.advance(9 * 60 * minute)
    await closed.server.scheduler.idle()
    assert.equal(closed.server.scheduler.view()?.state, 'running')
    await finish(closed, first)
    assert.equal(running(closed).length, 0)
    assert.ok(queuedAuto(closed).length > 0)
    assert.equal(closed.launch.children.length, 1)
  } finally {
    await closed.cleanup()
  }
})

test('a queued run whose opt-in is off is not started by a run ending, and keeps its place', async () => {
  const world = await setup({ auto: { others: true, concurrency: 1 } })
  try {
    await tick(world)
    const line = queuedAuto(world)
    assert.ok(line.length > 0)
    await saveAuto(world, { others: false })
    await finish(world, running(world)[0]!)
    assert.equal(running(world).length, 0)
    assert.equal(world.launch.children.length, 1)
    for (const run of line) assert.equal(world.server.cache.getRun(run.id)?.status, 'queued')
    // the run that ended started nothing while the switch was off, and turning it back on starts the oldest
    await saveAuto(world, { others: true })
    await world.server.scheduler.idle()
    assert.deepEqual(running(world).map((run) => run.id), [line[0]!.id])
  } finally {
    await world.cleanup()
  }
})

test('a drain does not start while the last tick skipped over the gh login, and an unconfirmed login at the start leaves the row queued without failing it or looping', async () => {
  const world = await setup({ auto: { concurrency: 1 } })
  try {
    await tick(world)
    const line = queuedAuto(world)
    world.gh.login = 'somebody-else'
    const asked = (): number => world.gh.calls.filter((args) => args[0] === 'api' && args[1] === 'user').length
    const before = asked()
    await finish(world, running(world)[0]!)
    // retaken: the launcher's own identity check left it queued; the pass ended there, once
    assert.equal(asked() - before, 1)
    assert.equal(running(world).length, 0)
    for (const run of line) assert.equal(world.server.cache.getRun(run.id)?.status, 'queued')
    assert.equal(autoRuns(world).filter((run) => run.status === 'failed').length, 0)
    // the next tick says why, and a drain after a skip as identityMismatch starts nothing and asks nobody
    await tick(world)
    assert.equal(ticks(world)[0]?.skipReason, 'identityMismatch')
    const afterTick = asked()
    await saveAuto(world, { concurrency: 2 })
    await world.server.scheduler.idle()
    assert.equal(asked(), afterTick)
    assert.equal(running(world).length, 0)
    // the login back and the next tick starts the oldest
    world.gh.login = scenario.viewer
    await tick(world)
    assert.equal(running(world).length, 2)
  } finally {
    await world.cleanup()
  }
})

test('a start that fails does not hold the rows behind it, a second failure in one pass ends it, and a failed row never makes the drain loop', async () => {
  const world = await setup({ auto: { concurrency: 1, own: true }, config: { maxConcurrentReviews: 3 } })
  const failNext = async (fetches: number): Promise<void> => {
    world.git.state.fetchFailures = fetches
    const before = world.git.verbs('fetch').length
    await endWithoutIdle(world, running(world)[0]!)
    await waitFor(() => world.git.verbs('fetch').length === before + 1)
    await waitFor(() => world.time.pending() > 0)
  }
  try {
    await tick(world)
    const line = queuedAuto(world)
    assert.ok(line.length >= 4)
    // the first queued row's fetch fails twice (its own retry), the row behind it starts
    await failNext(2)
    world.time.advance(5000)
    await world.server.scheduler.idle()
    assert.equal(world.server.cache.getRun(line[0]!.id)?.status, 'failed')
    assert.match(world.server.cache.getRun(line[0]!.id)?.note ?? '', /^worktreeFailed: /)
    assert.equal(world.server.cache.getRun(line[1]!.id)?.status, 'running')
    // two failures in a row: the pass ends, the rest stay queued, and nothing retries by itself
    world.git.state.fetchFailures = 4
    const before = world.git.verbs('fetch').length
    await endWithoutIdle(world, running(world)[0]!)
    // the first row of the pass: its fetch fails, waits for its one retry, and fails again; the row behind it does the same, and the pass ends
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await waitFor(() => world.git.verbs('fetch').length >= before + 2 * attempt - 1)
      await waitFor(() => world.time.pending() > 0)
      world.time.advance(5000)
    }
    await world.server.scheduler.idle()
    assert.equal(world.server.cache.getRun(line[2]!.id)?.status, 'failed')
    assert.equal(world.server.cache.getRun(line[3]!.id)?.status, 'failed')
    assert.equal(running(world).length, 0)
    const rest = queuedAuto(world)
    assert.ok(rest.length > 0)
    assert.equal(world.git.verbs('fetch').length, before + 4)
    await world.server.scheduler.idle()
    assert.equal(world.git.verbs('fetch').length, before + 4, 'the failed rows started nothing more')
  } finally {
    await world.cleanup()
  }
})

test('two triggers at once, a run ending and a save, serialize: one start in the engine at a time, and each queued row starts once', async () => {
  const world = await setup({ auto: { concurrency: 2 }, config: { maxConcurrentReviews: 4 } })
  try {
    await tick(world)
    assert.equal(running(world).length, 2)
    const line = queuedAuto(world)
    assert.ok(line.length >= 2)
    let inEngine = 0
    let widest = 0
    const launcher = world.server.launcher
    const original = launcher.startScheduled.bind(launcher)
    launcher.startScheduled = async (...args: Parameters<typeof original>) => {
      inEngine += 1
      widest = Math.max(widest, inEngine)
      try {
        return await original(...args)
      } finally {
        inEngine -= 1
      }
    }
    const both = running(world)
    await endWithoutIdle(world, both[0]!)
    await endWithoutIdle(world, both[1]!)
    await saveAuto(world, { dailyLimit: 50 })
    await world.server.scheduler.idle()
    assert.equal(widest, 1)
    assert.deepEqual(running(world).map((run) => run.id).sort(), [line[0]!.id, line[1]!.id])
    assert.equal(world.launch.children.length, 4)
    assert.equal(new Set(world.launch.children.map((child) => child.request.cwd)).size, 4)
  } finally {
    await world.cleanup()
  }
})

test('the tick keeps its job: it still fetches, qualifies, and queues, and a tick racing a drain starts no row twice', async () => {
  const world = await setup({ auto: { concurrency: 1 }, config: { maxConcurrentReviews: 3 } })
  try {
    await tick(world)
    const queuedFirst = queuedAuto(world).length
    assert.equal(ticks(world)[0]?.queued, queuedFirst + 1)
    let release = (): void => {}
    world.git.state.holdAdd = new Promise<void>((resume) => {
      release = resume
    })
    await endWithoutIdle(world, running(world)[0]!)
    await waitFor(() => world.git.verbs('worktree', 'add').length === 2)
    world.time.advance(15 * minute)
    await waitFor(() => ticks(world).length === 2)
    for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resume) => setImmediate(resume))
    release()
    await world.server.scheduler.idle()
    assert.equal(world.launch.children.length, 2)
    assert.equal(world.git.verbs('worktree', 'add').length, 2)
    assert.equal(running(world).length, 1)
    assert.equal(ticks(world)[0]?.state, 'ran')
  } finally {
    await world.cleanup()
  }
})

// a tick in flight owns the start step: nothing between ticks starts a row before that tick has checked the login, the clone, and the board (section 10, The start step)

const holdUserCheck = (world: World): (() => void) => {
  let release = (): void => {}
  world.gh.holdUser = new Promise<void>((resume) => {
    release = resume
  })
  return release
}

const holdBoard = (world: World): (() => void) => {
  let release = (): void => {}
  world.gh.hold = new Promise<void>((resume) => {
    release = resume
  })
  return release
}

test('a run ending and a config save during a tick start nothing until that tick reaches its own start step, which covers both', async () => {
  const world = await setup({ auto: { concurrency: 1 }, config: { maxConcurrentReviews: 3 } })
  try {
    await tick(world)
    const line = queuedAuto(world)
    assert.ok(line.length >= 2)
    const first = running(world)[0]!
    const release = holdBoard(world)
    world.time.advance(15 * minute)
    await waitFor(() => ticks(world).length === 2)
    const children = world.launch.children.length
    await endWithoutIdle(world, first)
    await saveAuto(world, { concurrency: 2 })
    for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resume) => setImmediate(resume))
    assert.equal(world.launch.children.length, children, 'nothing started while the tick was still fetching')
    assert.equal(world.git.verbs('worktree', 'add').length, children)
    assert.equal(running(world).length, 0)
    world.gh.hold = null
    release()
    await world.server.scheduler.idle()
    assert.deepEqual(running(world).map((run) => run.id), [line[0]!.id, line[1]!.id])
    assert.equal(world.launch.children.length, children + 2, 'each row started once')
    assert.equal(ticks(world)[0]?.state, 'ran')
  } finally {
    await world.cleanup()
  }
})

test('after a tick that skipped as identityMismatch or noClone, and a trigger that arrived during it, a run ending starts nothing', async () => {
  for (const reason of ['identityMismatch', 'noClone'] as const) {
    const world = await setup({ auto: { concurrency: 1 }, config: { maxConcurrentReviews: 3 } })
    try {
      await tick(world)
      const line = queuedAuto(world)
      assert.ok(line.length >= 2)
      const first = running(world)[0]!
      if (reason === 'identityMismatch') world.gh.login = 'somebody-else'
      else world.git.state.remotes = null
      const release = holdUserCheck(world)
      world.time.advance(15 * minute)
      await waitFor(() => ticks(world).length === 2)
      const children = world.launch.children.length
      // the run ends while the tick has not yet checked the login: the pending trigger must not start the row before the tick says why it skipped
      await endWithoutIdle(world, first)
      for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resume) => setImmediate(resume))
      assert.equal(world.launch.children.length, children)
      world.gh.holdUser = null
      release()
      await world.server.scheduler.idle()
      assert.equal(ticks(world)[0]?.skipReason, reason)
      assert.equal(world.launch.children.length, children, `the pending trigger started nothing after a ${reason} skip`)
      assert.equal(running(world).length, 0)
      for (const run of line) assert.equal(world.server.cache.getRun(run.id)?.status, 'queued')
      // the run that ended wrote no report, so it alone is failed
      assert.deepEqual(autoRuns(world).filter((run) => run.status === 'failed').map((run) => run.id), [first.id])
      // a run ending after the skip starts nothing either
      await saveAuto(world, { concurrency: 2 })
      await world.server.scheduler.idle()
      assert.equal(world.launch.children.length, children)
    } finally {
      await world.cleanup()
    }
  }
})

test('a trigger that arrives during a tick that then skips before its start step is not lost: one pass runs after the tick ends', async () => {
  const world = await setup({ auto: { concurrency: 1 }, config: { maxConcurrentReviews: 3 } })
  try {
    await tick(world)
    const line = queuedAuto(world)
    assert.ok(line.length >= 2)
    const first = running(world)[0]!
    world.gh.failCycle = true
    const release = holdBoard(world)
    world.time.advance(15 * minute)
    await waitFor(() => ticks(world).length === 2)
    await endWithoutIdle(world, first)
    for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resume) => setImmediate(resume))
    assert.equal(running(world).length, 0, 'held back while the tick was in flight')
    world.gh.hold = null
    release()
    await world.server.scheduler.idle()
    assert.equal(ticks(world)[0]?.skipReason, 'fetchFailed')
    assert.deepEqual(running(world).map((run) => run.id), [line[0]!.id])
    assert.equal(world.launch.children.length, 2)
  } finally {
    await world.cleanup()
  }
})

test('a queued run the owner stops while an earlier start is in progress stays stopped, even with its PR missing from the open list: never started, never skipped', async () => {
  const world = await setup({ auto: { concurrency: 2 }, config: { maxConcurrentReviews: 4 } })
  try {
    await tick(world)
    const line = queuedAuto(world)
    assert.ok(line.length >= 3)
    const [one, two] = running(world)
    let release = (): void => {}
    world.git.state.holdAdd = new Promise<void>((resume) => {
      release = resume
    })
    // the PR is gone from the open list the pass will capture
    const victim = line[1]!
    world.server.cache.closePr(scenario.repo, victim.number)
    await endWithoutIdle(world, one!)
    await waitFor(() => world.git.verbs('worktree', 'add').length === 3)
    // both places are free, so the pass in progress goes on to the second queued row once the first start returns
    await endWithoutIdle(world, two!)
    assert.equal(world.server.launcher.stop(victim.id).status, 'stopped')
    const children = world.launch.children.length
    release()
    await world.server.scheduler.idle()
    const after = world.server.cache.getRun(victim.id)
    assert.equal(after?.status, 'stopped')
    assert.notEqual(after?.note, 'closed')
    assert.equal(world.launch.children.length, children + 2, 'the two rows around it started')
    assert.equal(world.launch.children.some((child) => basename(child.request.cwd) === `run-${victim.id}`), false, 'it was never started')
    assert.equal(world.server.cache.getRun(line[0]!.id)?.status, 'running')
    assert.equal(world.server.cache.getRun(line[2]!.id)?.status, 'running')
  } finally {
    await world.cleanup()
  }
})

test('a between-ticks drain already under way when a tick begins starts no second row until that tick reaches its own start step, then the queue drains in order, never twice', async () => {
  const world = await setup({ auto: { concurrency: 2 }, config: { maxConcurrentReviews: 5 } })
  try {
    await tick(world)
    const line = queuedAuto(world)
    assert.ok(line.length >= 3)
    const [one, two] = running(world)
    let releaseAdd = (): void => {}
    world.git.state.holdAdd = new Promise<void>((resume) => {
      releaseAdd = resume
    })
    // both places free: the drain's first start waits on its worktree
    await endWithoutIdle(world, one!)
    await endWithoutIdle(world, two!)
    await waitFor(() => world.git.verbs('worktree', 'add').length === 3)
    // the launcher's own login check must stay free, so the tick waits in its board check
    const releaseBoard = holdBoard(world)
    world.time.advance(15 * minute)
    await waitFor(() => ticks(world).length === 2)
    const children = world.launch.children.length
    world.git.state.holdAdd = null
    releaseAdd()
    await waitFor(() => world.launch.children.length === children + 1)
    // time enough for a second candidate to start if nothing held it
    for (let turn = 0; turn < 30; turn += 1) await new Promise<void>((resume) => setTimeout(resume, 2))
    assert.equal(world.launch.children.length, children + 1, 'only the start already under way finished; the second candidate waited for the tick')
    assert.equal(world.git.verbs('worktree', 'add').length, 3)
    assert.equal(world.server.cache.getRun(line[1]!.id)?.status, 'queued')
    world.gh.hold = null
    releaseBoard()
    await world.server.scheduler.idle()
    assert.equal(ticks(world)[0]?.state, 'ran')
    assert.deepEqual(running(world).map((run) => run.id), [line[0]!.id, line[1]!.id])
    assert.equal(world.server.cache.getRun(line[2]!.id)?.status, 'queued', 'concurrency 2 holds the third')
    assert.equal(world.launch.children.length, children + 2, 'each row started once')
    assert.equal(world.git.verbs('worktree', 'add').length, 4)
    // the queue goes on in order as places free
    await endWithoutIdle(world, running(world)[0]!)
    await world.server.scheduler.idle()
    assert.ok(running(world).some((run) => run.id === line[2]!.id))
    assert.equal(new Set(world.launch.children.map((child) => child.request.cwd)).size, world.launch.children.length)
  } finally {
    await world.cleanup()
  }
})

// real time for the worktree preparation and the tick's file reads, which a count of microtask turns does not cover
const pause = async (ms = 80): Promise<void> => {
  await new Promise<void>((resume) => setTimeout(resume, ms))
}

test('a between-ticks drain suspended in a start does not act on its older open list after a tick has begun, even when that tick has since finished its board check: a PR the tick found closed is dropped by the tick\'s pass and never started', async () => {
  const world = await setup({ auto: { concurrency: 2 }, config: { maxConcurrentReviews: 5 } })
  try {
    await tick(world)
    const line = queuedAuto(world)
    assert.ok(line.length >= 3)
    const [one, two] = running(world)
    let releaseAdd = (): void => {}
    world.git.state.holdAdd = new Promise<void>((resume) => {
      releaseAdd = resume
    })
    // both places free: the drain's first start waits on its worktree, holding the open list from before the tick
    await endWithoutIdle(world, one!)
    await endWithoutIdle(world, two!)
    await waitFor(() => world.git.verbs('worktree', 'add').length === 3)
    const releaseBoard = holdBoard(world)
    world.time.advance(15 * minute)
    await waitFor(() => ticks(world).length === 2)
    // the tick's board check finds the next queued row's PR closed
    const victim = line[1]!
    const cache = world.server.cache
    const original = cache.latestCycle.bind(cache)
    let checked = false
    cache.latestCycle = (...args) => {
      cache.latestCycle = original
      cache.closePr(scenario.repo, victim.number)
      checked = true
      return original(...args)
    }
    world.gh.hold = null
    releaseBoard()
    await waitFor(() => checked)
    // the tick is past its board check and at its start step, while the old start still waits
    await pause()
    const children = world.launch.children.length
    world.git.state.holdAdd = null
    releaseAdd()
    await world.server.scheduler.idle()
    const after = world.server.cache.getRun(victim.id)
    assert.equal(world.launch.children.some((child) => basename(child.request.cwd) === `run-${victim.id}`), false, 'the closed PR was never started')
    assert.equal(after?.status, 'skipped')
    assert.equal(after?.note, 'closed')
    assert.equal(ticks(world)[0]?.state, 'ran')
    assert.deepEqual(running(world).map((run) => run.id), [line[0]!.id, line[2]!.id])
    assert.equal(world.launch.children.length, children + 2, 'the first start finished and the tick\'s pass started the row behind the closed one')
    assert.equal(new Set(world.launch.children.map((child) => child.request.cwd)).size, world.launch.children.length, 'each row started once')
  } finally {
    await world.cleanup()
  }
})

test('a between-ticks drain that finds a tick has begun and already ended without a start step asks for one more pass on a fresh snapshot: nothing is lost and no stale open list is acted on', async () => {
  const world = await setup({ auto: { concurrency: 2 }, config: { maxConcurrentReviews: 5 } })
  try {
    await tick(world)
    const line = queuedAuto(world)
    assert.ok(line.length >= 3)
    const [one, two] = running(world)
    let releaseAdd = (): void => {}
    world.git.state.holdAdd = new Promise<void>((resume) => {
      releaseAdd = resume
    })
    await endWithoutIdle(world, one!)
    await endWithoutIdle(world, two!)
    await waitFor(() => world.git.verbs('worktree', 'add').length === 3)
    // a tick begins and skips before its start step, while the old start still waits
    world.gh.failCycle = true
    world.time.advance(15 * minute)
    await waitFor(() => ticks(world).length === 2 && ticks(world)[0]?.finishedAt !== null)
    assert.equal(ticks(world)[0]?.skipReason, 'fetchFailed')
    world.gh.failCycle = false
    // the cache moved on after the old pass took its snapshot
    const victim = line[1]!
    world.server.cache.closePr(scenario.repo, victim.number)
    world.git.state.holdAdd = null
    releaseAdd()
    await world.server.scheduler.idle()
    assert.equal(world.launch.children.some((child) => basename(child.request.cwd) === `run-${victim.id}`), false, 'the stale snapshot was not acted on')
    assert.equal(world.server.cache.getRun(victim.id)?.note, 'closed')
    assert.deepEqual(running(world).map((run) => run.id), [line[0]!.id, line[2]!.id], 'the pass after it covered the rest')
  } finally {
    await world.cleanup()
  }
})

test('a between-ticks drain suspended in a start, when a tick begins and skips as identityMismatch or noClone and the problem then clears, starts no further row: only a successful tick lifts the block', async () => {
  for (const reason of ['identityMismatch', 'noClone'] as const) {
    const world = await setup({ auto: { concurrency: 2 }, config: { maxConcurrentReviews: 5 } })
    try {
      await tick(world)
      const line = queuedAuto(world)
      assert.ok(line.length >= 3)
      const [one, two] = running(world)
      let releaseAdd = (): void => {}
      world.git.state.holdAdd = new Promise<void>((resume) => {
        releaseAdd = resume
      })
      // both places free: the drain's first start waits on its worktree
      await endWithoutIdle(world, one!)
      await endWithoutIdle(world, two!)
      await waitFor(() => world.git.verbs('worktree', 'add').length === 3)
      // a tick begins while the start waits, and records the blocking skip
      const remotes = world.git.state.remotes
      if (reason === 'identityMismatch') world.gh.login = 'somebody-else'
      else world.git.state.remotes = null
      world.time.advance(15 * minute)
      await waitFor(() => ticks(world).length === 2 && ticks(world)[0]?.finishedAt !== null)
      assert.equal(ticks(world)[0]?.skipReason, reason)
      // the problem was transient: the launcher's own checks would now succeed
      world.gh.login = scenario.viewer
      world.git.state.remotes = remotes
      const children = world.launch.children.length
      world.git.state.holdAdd = null
      releaseAdd()
      await world.server.scheduler.idle()
      assert.equal(world.launch.children.length, children + 1, `${reason}: only the start already under way finished`)
      assert.deepEqual(running(world).map((run) => run.id), [line[0]!.id])
      for (const run of line.slice(1)) assert.equal(world.server.cache.getRun(run.id)?.status, 'queued', `${reason}: the rest stay queued`)
      // a run ending or a save starts nothing either, until a tick succeeds
      await saveAuto(world, { concurrency: 3 })
      await world.server.scheduler.idle()
      assert.equal(world.launch.children.length, children + 1)
      world.time.advance(15 * minute)
      await waitFor(() => ticks(world).length === 3)
      await world.server.scheduler.idle()
      assert.equal(ticks(world)[0]?.state, 'ran')
      assert.equal(world.launch.children.length, children + 3, 'the next successful tick drains the queue')
    } finally {
      await world.cleanup()
    }
  }
})

test('a tick that joins a drain already under way takes its answer from a pass that began after its board check: the earlier pass starts the last permitted review, and the tick is skipped as dailyLimit', async () => {
  const world = await setup({ auto: { concurrency: 2, dailyLimit: 3 }, config: { maxConcurrentReviews: 5 } })
  try {
    await tick(world)
    const line = queuedAuto(world)
    assert.ok(line.length >= 2)
    assert.equal(world.server.scheduler.view()?.startedToday, 2)
    const [one] = running(world)
    let releaseAdd = (): void => {}
    world.git.state.holdAdd = new Promise<void>((resume) => {
      releaseAdd = resume
    })
    // one place frees: the drain's start of the last permitted review waits on its worktree
    await endWithoutIdle(world, one!)
    await waitFor(() => world.git.verbs('worktree', 'add').length === 3)
    const releaseBoard = holdBoard(world)
    world.time.advance(15 * minute)
    await waitFor(() => ticks(world).length === 2)
    const cache = world.server.cache
    const original = cache.latestCycle.bind(cache)
    let checked = false
    cache.latestCycle = (...args) => {
      cache.latestCycle = original
      checked = true
      return original(...args)
    }
    world.gh.hold = null
    releaseBoard()
    await waitFor(() => checked)
    await pause()
    world.git.state.holdAdd = null
    releaseAdd()
    await world.server.scheduler.idle()
    assert.equal(world.server.scheduler.view()?.startedToday, 3)
    assert.equal(world.server.cache.getRun(line[0]!.id)?.status, 'running')
    assert.equal(ticks(world)[0]?.state, 'skipped')
    assert.equal(ticks(world)[0]?.skipReason, 'dailyLimit')
  } finally {
    await world.cleanup()
  }
})

test('a save arriving during the tick\'s own start pass cannot turn a tick that started the last permitted review into a dailyLimit skip, and the next tick skips', async () => {
  const world = await setup({ auto: { concurrency: 1, dailyLimit: 1 }, config: { maxConcurrentReviews: 3 } })
  try {
    let release = (): void => {}
    world.git.state.holdAdd = new Promise<void>((resume) => {
      release = resume
    })
    world.time.advance(15 * minute)
    await waitFor(() => world.git.verbs('worktree', 'add').length === 1)
    // the save asks for another pass while the tick's own pass starts its only permitted review
    await saveAuto(world, { others: true })
    for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resume) => setImmediate(resume))
    world.git.state.holdAdd = null
    release()
    await world.server.scheduler.idle()
    assert.equal(world.launch.children.length, 1)
    assert.equal(ticks(world)[0]?.state, 'ran')
    assert.equal(ticks(world)[0]?.skipReason, null)
    assert.equal(world.server.scheduler.view()?.startedToday, 1)
    await finish(world, running(world)[0]!)
    await tick(world)
    assert.equal(ticks(world)[0]?.state, 'skipped')
    assert.equal(ticks(world)[0]?.skipReason, 'dailyLimit')
    assert.equal(world.launch.children.length, 1)
  } finally {
    await world.cleanup()
  }
})

test('a tick that throws clears the in-flight state: a run ending afterward starts the next row, and Run now during a tick starts no second tick', async () => {
  const world = await setup({ auto: { concurrency: 1 }, config: { maxConcurrentReviews: 3 } })
  try {
    await tick(world)
    const line = queuedAuto(world)
    assert.ok(line.length >= 2)
    const first = running(world)[0]!
    // Run now while a tick is in flight is refused with that tick's id
    const release = holdBoard(world)
    world.time.advance(15 * minute)
    await waitFor(() => ticks(world).length === 2)
    assert.deepEqual(world.server.scheduler.runNow(), { started: false, tick: ticks(world)[0]!.id })
    assert.equal(ticks(world).length, 2)
    // the board check throws rather than failing: the cache read after it is what breaks
    const cache = world.server.cache
    const original = cache.latestCycle.bind(cache)
    cache.latestCycle = () => {
      cache.latestCycle = original
      throw new Error('cache unreadable')
    }
    world.gh.hold = null
    release()
    await world.server.scheduler.idle()
    assert.equal(ticks(world)[0]?.state, 'skipped')
    assert.equal(ticks(world)[0]?.skipReason, 'interrupted')
    // nothing is left in flight and no trigger is left remembered: the next trigger is served by itself, once
    const children = world.launch.children.length
    await endWithoutIdle(world, first)
    await world.server.scheduler.idle()
    assert.deepEqual(running(world).map((run) => run.id), [line[0]!.id])
    assert.equal(world.launch.children.length, children + 1)
    assert.equal(world.server.scheduler.runNow()?.started, true)
    await world.server.scheduler.idle()
    assert.equal(ticks(world)[0]?.state, 'ran')
    assert.equal(world.launch.children.length, children + 1, 'a completed tick left no pending pass')
  } finally {
    await world.cleanup()
  }
})

test('the last statuses the scheduler keeps are bounded: ended rows are pruned past a limit and live ones are kept', async () => {
  const world = await setup({ auto: { enabled: false } })
  try {
    const row = (id: number, status: Run['status']): Run => ({ ...world.server.cache.allRuns()[0], id, status, origin: 'manual', worktree: null } as unknown as Run)
    world.server.scheduler.sessionChanged('run', row(100_000, 'running'))
    for (let id = 1; id <= 1500; id += 1) world.server.scheduler.sessionChanged('run', row(id, 'done'))
    const size = world.server.scheduler.tracked()
    assert.ok(size < 1000, `bounded, kept ${size}`)
    assert.ok(size >= 1, 'the live row is kept')
  } finally {
    await world.cleanup()
  }
})
