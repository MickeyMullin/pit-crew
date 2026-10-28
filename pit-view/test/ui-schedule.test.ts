// test/ui-schedule.test.ts
// the last update a browser keeps for its next load (public/schedule.ts): what it stores, and
// storage that is empty, holds something else, or fails
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lastUpdateKey, lastUpdateOf, readLastUpdate, writeLastUpdate } from '../public/schedule.ts'
import type { ScheduleStorage } from '../public/schedule.ts'

const memory = (initial: Record<string, string> = {}): ScheduleStorage & { items: Map<string, string> } => {
  const items = new Map(Object.entries(initial))
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value)
    },
  }
}

const blocked = (): ScheduleStorage => {
  throw new Error('SecurityError')
}

const refusing: ScheduleStorage = {
  getItem: () => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  },
}

test('the last update is the start of the latest cycle, of any trigger and outcome', () => {
  const cycle = { id: 4, trigger: 'interval', state: 'failed', startedAt: '2026-10-26T14:00:00.000Z', finishedAt: '2026-10-26T14:00:03.000Z', error: 'down', errorKind: 'network', prsUpdated: 0, prsTotal: null } as const
  assert.equal(lastUpdateOf({ cycle }), '2026-10-26T14:00:00.000Z')
  assert.equal(lastUpdateOf({ cycle: null }), null)
})

test('a stored time reads back; anything else, or storage that fails, reads as none', () => {
  const storage = memory()
  assert.equal(readLastUpdate(() => storage), null)
  assert.equal(writeLastUpdate(() => storage, '2026-10-26T14:00:00.000Z'), true)
  assert.equal(storage.items.get(lastUpdateKey), '2026-10-26T14:00:00.000Z')
  assert.equal(readLastUpdate(() => storage), '2026-10-26T14:00:00.000Z')
  assert.equal(readLastUpdate(() => memory({ [lastUpdateKey]: 'yesterday-ish' })), null)
  assert.equal(readLastUpdate(blocked), null)
  assert.equal(readLastUpdate(() => refusing), null)
  assert.equal(writeLastUpdate(blocked, '2026-10-26T14:00:00.000Z'), false)
  assert.equal(writeLastUpdate(() => refusing, '2026-10-26T14:00:00.000Z'), false)
})
