// test/githooks.test.ts
// real git in a scratch clone of an invented repository, with the environment the launcher builds for a child: no runner, gh, or network is involved
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, chmod, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { childEnv } from '../src/launcher.ts'
import { tempDir } from './helpers.ts'

const run = promisify(execFile)

// every command that must run no hook, as the launcher names them, then the two that keep the repository's hooks
const hooksOff = ['review-pr', 'review-dependabot', 'review-stack', 'review-dependabot-sweep']
const hooksKept = ['fix-pr', 'update-pr']

const exists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false)

const writeHook = async (dir: string, name: string, marker: string): Promise<void> => {
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\n: > '${marker}'\n`)
  await chmod(path, 0o755)
}

// an origin with one commit on main and a pr-branch that adds a file, and a real clone of it; the scratch home's own git config is all that applies beyond the system's
const scratch = async () => {
  const temp = await tempDir()
  const home = await realpath(temp.dir)
  const plain = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' }
  const origin = join(home, 'origin')
  const clone = join(home, 'orbit')
  const marker = join(home, 'hook-fired')
  const git = async (env: Record<string, string>, ...args: string[]): Promise<string> => (await run('git', args, { env })).stdout.trim()
  const asFixture = (...args: string[]): Promise<string> => git(plain, '-C', origin, ...args)
  await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Orbit Tester\n\temail = tester@example.invalid\n')
  await git(plain, 'init', '--quiet', '--initial-branch=main', origin)
  await writeFile(join(origin, 'README.md'), 'orbit\n')
  await asFixture('add', '.')
  await asFixture('commit', '--quiet', '-m', 'first')
  await asFixture('switch', '--quiet', '-c', 'pr-branch')
  // what a PR author controls: a hook in the tree, at the path a relative core.hooksPath names
  await writeHook(join(origin, '.githooks'), 'post-checkout', marker)
  await asFixture('add', '.')
  await asFixture('commit', '--quiet', '-m', 'second')
  await asFixture('switch', '--quiet', 'main')
  await git(plain, 'clone', '--quiet', origin, clone)
  // whether a hook fired since the last ask
  const fired = async (): Promise<boolean> => {
    const was = await exists(marker)
    await rm(marker, { force: true })
    return was
  }
  let worktrees = 0
  // git worktree add from the clone, as the prompts run it; a worktree that was not made would prove nothing about its hook
  const addWorktree = async (env: Record<string, string>, ref = 'origin/main'): Promise<string> => {
    worktrees += 1
    const path = join(home, 'worktrees', `w${worktrees}`)
    await git(env, '-C', clone, 'worktree', 'add', '--quiet', '--detach', path, ref)
    assert.ok(await exists(join(path, 'README.md')), `${path} was not checked out`)
    return path
  }
  return { home, plain, origin, clone, marker, git, fired, addWorktree, cleanup: temp.cleanup }
}

const envOf = (home: string, command: string): Record<string, string> => childEnv({ PATH: process.env.PATH ?? '/usr/bin:/bin' }, home, command)

test('git worktree add with a clone\'s core.hooksPath: a run with hooks off fires nothing, no variables fire the hook, and a Fix or Update session fires it', { timeout: 30_000 }, async () => {
  const h = await scratch()
  try {
    const hooks = join(h.home, 'hooks')
    await writeHook(hooks, 'post-checkout', h.marker)
    await h.git(h.plain, '-C', h.clone, 'config', 'core.hooksPath', hooks)

    await h.addWorktree(h.plain)
    assert.equal(await h.fired(), true, 'the hook fires with no variables, so its absence below means something')
    for (const command of hooksOff) {
      await h.addWorktree(envOf(h.home, command))
      assert.equal(await h.fired(), false, `${command} fired the clone's hook`)
    }
    for (const command of hooksKept) {
      await h.addWorktree(envOf(h.home, command))
      assert.equal(await h.fired(), true, `${command} did not run the repository's hook`)
    }
  } finally {
    await h.cleanup()
  }
})

test('a core.hooksPath in the user\'s global config loses to a run with hooks off as well, and stays in force for a Fix or Update session', { timeout: 30_000 }, async () => {
  const h = await scratch()
  try {
    const hooks = join(h.home, 'global-hooks')
    await writeHook(hooks, 'post-checkout', h.marker)
    await h.git(h.plain, 'config', '--global', 'core.hooksPath', hooks)
    await h.addWorktree(h.plain)
    assert.equal(await h.fired(), true)
    await h.addWorktree(envOf(h.home, 'review-pr'))
    assert.equal(await h.fired(), false)
    await h.addWorktree(envOf(h.home, 'fix-pr'))
    assert.equal(await h.fired(), true)
  } finally {
    await h.cleanup()
  }
})

test('a relative core.hooksPath resolves from where git runs: the PR\'s own hook fires from inside its tree or from a clone checked out on it, never for a run with hooks off', { timeout: 30_000 }, async () => {
  const h = await scratch()
  try {
    await h.git(h.plain, '-C', h.clone, 'config', 'core.hooksPath', '.githooks')
    const review = envOf(h.home, 'review-pr')

    // from the clone, on main, which has no hook at that path: git does not look in the new worktree's tree
    const tree = await h.addWorktree(h.plain, 'origin/pr-branch')
    assert.equal(await h.fired(), false)

    // inside the PR's tree the path names the PR's own file
    await h.git(h.plain, '-C', tree, 'checkout', '--quiet', '--detach', 'HEAD')
    assert.equal(await h.fired(), true, 'with no variables, git inside the PR\'s tree runs the PR\'s hook')
    await h.git(review, '-C', tree, 'checkout', '--quiet', '--detach', 'HEAD')
    assert.equal(await h.fired(), false, 'hooks off must hold inside the PR\'s tree')

    // a clone left on the PR's branch holds that file at the same path, so a worktree add from it runs the PR's hook
    await h.git(review, '-C', h.clone, 'checkout', '--quiet', '--detach', 'origin/pr-branch')
    assert.equal(await h.fired(), false)
    await h.addWorktree(h.plain, 'origin/pr-branch')
    assert.equal(await h.fired(), true, 'with no variables, a worktree add from a clone on the PR\'s branch runs the PR\'s hook')
    await h.addWorktree(review, 'origin/pr-branch')
    assert.equal(await h.fired(), false)
  } finally {
    await h.cleanup()
  }
})

test('a pre-push hook, which is why a Fix or Update session keeps its hooks, runs for those two and not for a run with hooks off', { timeout: 30_000 }, async () => {
  const h = await scratch()
  try {
    const hooks = join(h.home, 'hooks')
    await writeHook(hooks, 'pre-push', h.marker)
    await h.git(h.plain, '-C', h.clone, 'config', 'core.hooksPath', hooks)
    let pushes = 0
    const push = async (env: Record<string, string>): Promise<void> => {
      pushes += 1
      await h.git(env, '-C', h.clone, 'push', '--quiet', 'origin', `HEAD:refs/heads/pushed-${pushes}`)
    }
    for (const command of hooksKept) {
      await push(envOf(h.home, command))
      assert.equal(await h.fired(), true, `${command} did not run pre-push`)
    }
    await push(envOf(h.home, 'review-pr'))
    assert.equal(await h.fired(), false)
    // the push went through, so the hook's absence is not a push that never started
    assert.match(await h.git(h.plain, '-C', h.origin, 'branch', '--list', 'pushed-*'), /pushed-3/)
  } finally {
    await h.cleanup()
  }
})

test('git itself reads the entries: hooks off adds core.hooksPath over the clone\'s and keeps the redirect and the helper, and a Fix or Update session reads the clone\'s value', { timeout: 30_000 }, async () => {
  const h = await scratch()
  try {
    await h.git(h.plain, '-C', h.clone, 'config', 'core.hooksPath', '.githooks')
    const read = (env: Record<string, string>, key: string): Promise<string> => h.git(env, '-C', h.clone, 'config', '--get', key)
    for (const command of [...hooksOff, ...hooksKept]) {
      const env = envOf(h.home, command)
      assert.equal(await read(env, 'core.hooksPath'), hooksKept.includes(command) ? '.githooks' : '/dev/null', command)
      assert.equal(await read(env, 'url.https://github.com/.insteadOf'), 'git@github.com:', command)
      assert.equal(await read(env, 'credential.helper'), '!gh auth git-credential', command)
    }
  } finally {
    await h.cleanup()
  }
})
