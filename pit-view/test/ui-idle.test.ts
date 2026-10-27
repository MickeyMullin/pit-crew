// test/ui-idle.test.ts
// the page's idle tracking (public/idle.ts), run under Node with fake time: going idle after
// idleMinutes with no activity, leaving it on the first activity, and reporting only the changes
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createIdleTracker, idleDueIn } from '../public/idle.ts'
import { fakeTime } from './helpers.ts'

const minute = 60_000

const tracker = (minutes = 90) => {
  const time = fakeTime()
  const changes: boolean[] = []
  const idle = createIdleTracker({ minutes, now: time.clock.now, timers: time.timers, onChange: (next) => changes.push(next) })
  return { time, changes, idle }
}

test('idleDueIn counts down from the last activity, and 0 minutes never goes idle', () => {
  assert.equal(idleDueIn(0, 0, 90), 90 * minute)
  assert.equal(idleDueIn(0, 30 * minute, 90), 60 * minute)
  assert.equal(idleDueIn(0, 120 * minute, 90), 0)
  assert.equal(idleDueIn(0, 120 * minute, 0), null)
})

test('a page with no activity goes idle once, at idleMinutes, and stays idle', () => {
  const { time, changes, idle } = tracker()
  time.advance(90 * minute - 1)
  assert.equal(idle.idle(), false)
  time.advance(1)
  assert.equal(idle.idle(), true)
  assert.deepEqual(changes, [true])
  // nothing more is scheduled or reported while it sits idle
  assert.equal(time.pending(), 0)
  time.advance(10 * 60 * minute)
  assert.deepEqual(changes, [true])
})

test('activity before the deadline postpones it without reporting anything', () => {
  const { time, changes, idle } = tracker()
  time.advance(60 * minute)
  idle.activity()
  // the old deadline passes: the timer re-aims at 90 minutes after the activity
  time.advance(60 * minute)
  assert.equal(idle.idle(), false)
  assert.deepEqual(changes, [])
  time.advance(30 * minute)
  assert.equal(idle.idle(), true)
  assert.deepEqual(changes, [true])
})

test('a storm of pointer moves keeps one timer and reports nothing', () => {
  const { time, changes, idle } = tracker()
  for (let move = 0; move < 1_000; move += 1) {
    idle.activity()
    time.advance(50)
  }
  assert.equal(time.pending(), 1)
  assert.deepEqual(changes, [])
})

test('the first activity after going idle ends it at once, and the countdown starts again', () => {
  const { time, changes, idle } = tracker()
  time.advance(2 * 60 * minute)
  assert.equal(idle.idle(), true)
  idle.activity()
  assert.equal(idle.idle(), false)
  // further activity is not another change
  idle.activity()
  idle.activity()
  assert.deepEqual(changes, [true, false])
  time.advance(90 * minute)
  assert.deepEqual(changes, [true, false, true])
})

test('0 minutes never goes idle; changing the setting re-aims, and 0 ends idle at once', () => {
  const { time, changes, idle } = tracker(0)
  assert.equal(time.pending(), 0)
  time.advance(24 * 60 * minute)
  assert.deepEqual(changes, [])
  // a shorter setting counts from the last activity, so a page already quiet that long goes idle now
  idle.setMinutes(30)
  time.advance(0)
  assert.equal(idle.idle(), true)
  idle.setMinutes(0)
  assert.equal(idle.idle(), false)
  assert.equal(time.pending(), 0)
  assert.deepEqual(changes, [true, false])
})

test('stop clears the timer', () => {
  const { time, changes, idle } = tracker()
  idle.stop()
  assert.equal(time.pending(), 0)
  time.advance(2 * 60 * minute)
  assert.deepEqual(changes, [])
})
