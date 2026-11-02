// test/spawn.test.ts
// the system spawn's own steps around the process it starts, over fake descriptors and a fake child, so no process is ever started
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { spawnWith } from '../src/launcher.ts'
import type { SpawnRequest } from '../src/launcher.ts'

const spawnRequest: SpawnRequest = {
  command: 'claude',
  args: ['-p'],
  cwd: '/nonexistent/pit-view-test-clone',
  env: {},
  stdoutPath: '/nonexistent/pit-view-test-runs/7/stream.jsonl',
  stderrPath: '/nonexistent/pit-view-test-runs/7/stderr.log',
  stdin: 'ignore',
}

const fakeChild = () => Object.assign(new EventEmitter(), { pid: 4242, stdin: null, unref: () => {} })

const descriptors = (path: string): number => path.endsWith('stream.jsonl') ? 11 : 12

test('a process that started is always handed back, even when closing its output files afterward fails', async () => {
  const closed: number[] = []
  const child = fakeChild()
  const spawn = spawnWith({
    open: descriptors,
    close: (fd) => {
      closed.push(fd)
      throw new Error('EIO: i/o error, close')
    },
    spawn: () => child,
  })
  const spawned = spawn(spawnRequest)
  assert.equal(spawned.pid, 4242)
  // both descriptors are closed, the second though the first refused
  assert.deepEqual(closed, [11, 12])
  child.emit('exit', 0, null)
  assert.deepEqual(await spawned.exited, { code: 0, signal: null, error: null })
})

test('a spawn that throws closes both output files and throws, and an output file that cannot be opened closes the one that was', () => {
  const closed: number[] = []
  const throwing = spawnWith({
    open: descriptors,
    close: (fd) => {
      closed.push(fd)
    },
    spawn: () => {
      throw new Error('spawn EAGAIN')
    },
  })
  assert.throws(() => throwing(spawnRequest), /spawn EAGAIN/)
  assert.deepEqual(closed, [11, 12])
  closed.length = 0
  let started = false
  const unopenable = spawnWith({
    open: (path) => {
      if (path.endsWith('stderr.log')) throw new Error('EMFILE: too many open files, open')
      return descriptors(path)
    },
    close: (fd) => {
      closed.push(fd)
    },
    spawn: () => {
      started = true
      return fakeChild()
    },
  })
  assert.throws(() => unopenable(spawnRequest), /EMFILE/)
  assert.deepEqual(closed, [11])
  assert.equal(started, false)
})
