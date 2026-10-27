// test/clients.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClients, isActive } from '../src/clients.ts'

const shown = { visible: true, paused: false }
const hidden = { visible: false, paused: false }
const paused = { visible: true, paused: true }

test('a client is active only while visible and not paused', () => {
  assert.equal(isActive(shown), true)
  assert.equal(isActive(hidden), false)
  assert.equal(isActive(paused), false)
  assert.equal(isActive({ visible: false, paused: true }), false)
})

test('opening a stream visible and unpaused makes the client active at once', () => {
  const clients = createClients()
  const { change } = clients.connect('tab-a', shown)
  assert.deepEqual(change, { active: true, becameActive: true, activeCount: 1 })
  assert.deepEqual(clients.get('tab-a'), shown)
  // a hidden tab exists but is not active
  assert.deepEqual(clients.connect('tab-b', hidden).change, { active: false, becameActive: false, activeCount: 1 })
  assert.equal(clients.size(), 2)
  assert.equal(clients.activeCount(), 1)
})

test('becoming visible or resuming makes a client active; hiding or pausing does not', () => {
  const clients = createClients()
  clients.connect('tab-a', hidden)
  assert.deepEqual(clients.update('tab-a', shown), { active: true, becameActive: true, activeCount: 1 })
  // staying active is not becoming active
  assert.deepEqual(clients.update('tab-a', shown), { active: true, becameActive: false, activeCount: 1 })
  assert.deepEqual(clients.update('tab-a', paused), { active: false, becameActive: false, activeCount: 0 })
  assert.deepEqual(clients.update('tab-a', shown), { active: true, becameActive: true, activeCount: 1 })
  assert.deepEqual(clients.update('tab-a', hidden), { active: false, becameActive: false, activeCount: 0 })
})

test('an id with no open stream is unknown', () => {
  const clients = createClients()
  assert.equal(clients.update('tab-z', shown), null)
  assert.equal(clients.disconnect('tab-z', 1), null)
  assert.equal(clients.get('tab-z'), null)
})

test('closing the last stream drops the client; a reconnect that overlaps keeps it', () => {
  const clients = createClients()
  const first = clients.connect('tab-a', shown)
  // the page reconnects with the same id before the old stream has closed
  const second = clients.connect('tab-a', paused)
  assert.deepEqual(second.change, { active: false, becameActive: false, activeCount: 0 })
  assert.deepEqual(clients.disconnect('tab-a', first.connection), { active: false, becameActive: false, activeCount: 0 })
  assert.deepEqual(clients.get('tab-a'), paused)
  // a connection closes only once
  assert.equal(clients.disconnect('tab-a', first.connection), null)
  assert.deepEqual(clients.disconnect('tab-a', second.connection), { active: false, becameActive: false, activeCount: 0 })
  assert.equal(clients.size(), 0)

  const back = clients.connect('tab-a', shown)
  assert.equal(back.change.becameActive, true)
  assert.deepEqual(clients.disconnect('tab-a', back.connection), { active: false, becameActive: false, activeCount: 0 })
})
