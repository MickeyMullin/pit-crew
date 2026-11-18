// test/scheduler-world.ts
// a running server with a fake gh, git, clock, and runner, for tests that drive the auto-review scheduler through its real ticks; the same world test/scheduler.test.ts builds for itself, kept apart so that file stays as it is
import assert from 'node:assert/strict'
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { defaultAutoReview } from '../src/autoreview.ts'
import type { AutoReviewSettings } from '../src/autoreview.ts'
import type { Run } from '../src/cache.ts'
import type { Config } from '../src/config.ts'
import type { Runner } from '../src/github.ts'
import { startServer } from '../src/server.ts'
import type { PitServer } from '../src/server.ts'
import { scenario } from './fixtures/scenario.ts'
import { failed, fakeLaunch, fakeRemotes, fakeTime, fixtureRunner, ok, reviewResult, tempDir } from './helpers.ts'
import type { FakeLaunch, FakeTime } from './helpers.ts'

export const minute = 60_000
// a Monday at 10:05 in the machine's zone, inside the default active hours
export const insideHours = scenario.now
// a Saturday at 10:00 in the machine's zone
export const saturday = '2026-10-24T14:00:00Z'

// a git that keeps the worktrees of one clone as git would: added and removed by path, and listed resolved
const fakeGit = (clone: string, repo: string = scenario.repo) => {
  const state = { worktrees: new Set<string>(), remotes: fakeRemotes(repo) as string | null, addFails: false }
  const runner: Runner = async (args) => {
    if (args[0] !== '-C') return failed('usage')
    const verb = args.slice(2)
    if (verb[0] === 'remote') return state.remotes === null ? failed('fatal: not a git repository') : ok(state.remotes)
    if (verb[0] === 'fetch') return ok('')
    if (verb[0] === 'rev-parse') return ok(`${clone}/.git/worktrees/${basename(args[1] ?? '')}\n`)
    if (verb[0] === 'worktree' && verb[1] === 'add') {
      if (state.addFails) return failed('fatal: invalid reference: origin/main')
      const path = verb[3] ?? ''
      await mkdir(path, { recursive: true })
      state.worktrees.add(await realpath(path))
      return ok('')
    }
    if (verb[0] === 'worktree' && verb[1] === 'remove') {
      const path = verb[2] ?? ''
      const known = [...state.worktrees].find((entry) => basename(entry) === basename(path))
      if (known === undefined) return failed(`fatal: '${path}' is not a working tree`)
      state.worktrees.delete(known)
      await rm(known, { recursive: true, force: true })
      return ok('')
    }
    if (verb[0] === 'worktree' && verb[1] === 'list') return ok([clone, ...state.worktrees].map((path) => `worktree ${path}\nHEAD 0000000\ndetached\n`).join('\n'))
    if (verb[0] === 'worktree' && verb[1] === 'prune') return ok('')
    return failed(`fake git has no answer for: ${verb.join(' ')}`)
  }
  return { state, runner }
}

export type World = {
  server: PitServer
  time: FakeTime
  launch: FakeLaunch
  git: ReturnType<typeof fakeGit>
  gh: { login: string | null }
  home: string
  configPath: string
  restart: () => Promise<void>
  cleanup: () => Promise<void>
}

export const headers = (world: World): Record<string, string> => ({ 'Content-Type': 'application/json', Origin: world.server.url, 'x-pit-view-token': world.server.token })

export const setup = async ({ auto = {}, config = {}, now = insideHours, drafts = [], autoReviewLog }: {
  auto?: Partial<AutoReviewSettings>
  config?: Partial<Config>
  now?: string
  // PRs the open list reports as drafts, over the fixture's own
  drafts?: number[]
  // false starts the server without the log
  autoReviewLog?: boolean
} = {}): Promise<World> => {
  const { dir: home, cleanup: removeHome } = await tempDir()
  const clone = join(home, 'dev', 'orbit')
  await mkdir(clone, { recursive: true })
  const configPath = join(home, '.config', 'pit-view', 'config.json')
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, JSON.stringify({ repo: scenario.repo, viewer: scenario.viewer, cloneDir: '~/dev/orbit', autoReview: { ...defaultAutoReview(), enabled: true, ...auto }, ...config }), 'utf8')
  const stateDir = join(home, '.local', 'state', 'pit-view')
  const git = fakeGit(clone)
  const time = fakeTime(now)
  const launch = fakeLaunch()
  launch.deps.git = git.runner
  const base = fixtureRunner()
  const gh = { login: scenario.viewer as string | null }
  const runner: Runner = async (args, options) => {
    if (args[0] === 'api' && args[1] === 'user') return gh.login === null ? failed('gh: not logged in') : ok(`${gh.login}\n`)
    const answer = await base.runner(args, options)
    if (drafts.length === 0 || args[0] !== 'api' || args[1] !== 'graphql' || answer.code !== 0) return answer
    const page = JSON.parse(answer.stdout) as { data?: { repository?: { pullRequests?: { nodes?: { number: number, isDraft?: boolean }[] } } } }
    const nodes = page.data?.repository?.pullRequests?.nodes
    if (nodes === undefined || !nodes.some((node) => typeof node.isDraft === 'boolean')) return answer
    for (const node of nodes) if (drafts.includes(node.number)) node.isDraft = true
    return { ...answer, stdout: JSON.stringify(page) }
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
    ...(autoReviewLog === undefined ? {} : { autoReviewLog }),
  })
  const world: World = {
    server: await boot(),
    time,
    launch,
    git,
    gh,
    home,
    configPath,
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
export const tick = async (world: World, minutes = 15): Promise<void> => {
  world.time.advance(minutes * minute)
  await world.server.scheduler.idle()
}

export const autoRuns = (world: World): Run[] => world.server.cache.allRuns().filter((run) => run.origin === 'auto')

export const running = (world: World): Run[] => autoRuns(world).filter((run) => run.status === 'running')

// the run's process ends with a finished review of its PR, its report on disk
export const finish = async (world: World, run: Run, patch: Record<string, unknown> = {}): Promise<Run> => {
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

// a save from Settings, with the token every write carries
export const save = async (world: World, change: (config: Config) => Config): Promise<Response> => {
  const stored = await (await fetch(`${world.server.url}/api/config`)).json() as Config
  const answer = await fetch(`${world.server.url}/api/config`, { method: 'PUT', headers: headers(world), body: JSON.stringify(change(stored)) })
  await world.server.scheduler.idle()
  return answer
}
