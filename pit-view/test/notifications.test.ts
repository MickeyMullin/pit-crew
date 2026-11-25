// test/notifications.test.ts
// the stored notifications (section 9 of DESIGN.md, Notifications): the table and its migration from version 22, the 14 days it keeps at both sides of the boundary, the kinds and which toast, what a settled run is recorded as, that every event is stored whether or not a banner is wanted, the GET route, and the push to an open page. Every fixture is invented
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { autoReviewLogDays } from '../src/autoreviewlog.ts'
import { githubTablesVersion, openCache, schemaVersion } from '../src/cache.ts'
import type { Run } from '../src/cache.ts'
import { notificationDays, openNotifications, runDetail } from '../src/notifications.ts'
import type { StoredNotification } from '../src/notifications.ts'
import { bannerKindOf, bannerKinds, createNotifier, headlineOf, notificationKinds, runEvent, toastDefaults, toasts } from '../src/notify.ts'
import type { Notice, NotifyEvent } from '../src/notify.ts'
import type { Patch } from '../src/poller.ts'
import { startServer } from '../src/server.ts'
import { scenario } from './fixtures/scenario.ts'
import { fakeLaunch, fakeTime, fixtureRunner, reviewResult, tempDir } from './helpers.ts'

const day = 24 * 60 * 60_000
const repo = scenario.repo

const event = (patch: Partial<NotifyEvent> = {}): NotifyEvent => ({ kind: 'readyToMerge', number: 102, title: 'feat(nav): an invented change', repo, run: null, detail: null, ...patch })

const store = () => {
  const time = fakeTime()
  const cache = openCache({ path: ':memory:', clock: time.clock })
  return { time, cache, notifications: openNotifications({ db: cache.db, clock: time.clock }) }
}

test('a stored notification holds its time, kind, label, repository, PR, title, run, and detail, and lists newest first per repository', () => {
  const { time, notifications } = store()
  const first = notifications.record(event({ kind: 'runFinished', number: 106, run: 41, detail: 'Review · Approved' }))
  assert.deepEqual(first, { id: 1, at: new Date(time.clock.now()).toISOString().replace('.000Z', 'Z'), kind: 'runFinished', label: 'Review session finished', repo, number: 106, title: 'feat(nav): an invented change', run: 41, detail: 'Review · Approved' })
  notifications.record(event({ number: 113, title: null }))
  notifications.record(event({ repo: 'octo-example/nebula', number: 5 }))
  assert.deepEqual(notifications.list(repo).map((found) => [found.id, found.number, found.title, found.run]), [[2, 113, null, null], [1, 106, 'feat(nav): an invented change', 41]])
  assert.deepEqual(notifications.list('octo-example/nebula').map((found) => found.number), [5])
  assert.equal(notifications.lastId(), 3)
})

test('the retention is the auto-review log\'s own constant', () => {
  assert.equal(notificationDays, autoReviewLogDays)
  assert.equal(notificationDays, 14)
})

test('a notification is kept through exactly 14 days and pruned a millisecond after, and a read shows none older', () => {
  const { time, cache, notifications } = store()
  notifications.record(event())
  time.advance(14 * day)
  assert.equal(notifications.prune(), 0)
  assert.equal(notifications.list(repo).length, 1)
  time.advance(1)
  assert.deepEqual(notifications.list(repo), [], 'a read never shows one past its days, pruned or not')
  assert.equal(Number(cache.db.prepare('SELECT count(*) AS n FROM notifications').get()?.n), 1)
  assert.equal(notifications.prune(), 1)
  assert.equal(Number(cache.db.prepare('SELECT count(*) AS n FROM notifications').get()?.n), 0)
})

test('opening the store and storing a notification both prune, and a pruned id is never reused', () => {
  const { time, cache, notifications } = store()
  notifications.record(event())
  time.advance(15 * day)
  const again = openNotifications({ db: cache.db, clock: time.clock })
  assert.equal(Number(cache.db.prepare('SELECT count(*) AS n FROM notifications').get()?.n), 0)
  assert.equal(again.record(event()).id, 2)
  time.advance(15 * day)
  assert.equal(again.record(event()).id, 3)
  assert.equal(Number(cache.db.prepare('SELECT count(*) AS n FROM notifications').get()?.n), 1)
  assert.equal(again.lastId(), 3)
})

test('a version 22 cache gains the notifications table in place: its PRs and runs stay, and what is stored survives a restart and a rebuild', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const path = join(dir, 'cache.sqlite')
    const time = fakeTime()
    openCache({ path, clock: time.clock }).close()
    const old = new DatabaseSync(path)
    old.exec('DROP TABLE IF EXISTS notifications')
    old.exec('INSERT INTO prs (repo, number, state, updated_at, head_oid, fetched_at, cycle, last_seen_at, data) VALUES (\'octo-example/orbit\', 106, \'open\', \'2026-10-26T12:00:00Z\', \'abc\', \'2026-10-26T12:00:00Z\', 1, \'2026-10-26T12:00:00Z\', \'{"number":106}\')')
    old.exec('UPDATE meta SET value = \'22\' WHERE key = \'schemaVersion\'')
    old.close()
    assert.equal(schemaVersion, 23)
    assert.equal(githubTablesVersion, 21)
    const cache = openCache({ path, clock: time.clock })
    assert.equal(Number(cache.db.prepare('SELECT count(*) AS n FROM prs').get()?.n), 1)
    assert.equal(cache.db.prepare('SELECT value FROM meta WHERE key = \'schemaVersion\'').get()?.value, '23')
    openNotifications({ db: cache.db, clock: time.clock }).record(event())
    // an older cache still has its GitHub tables rebuilt, and the notifications are not one of them
    cache.db.exec('UPDATE meta SET value = \'2\' WHERE key = \'schemaVersion\'')
    cache.close()
    const rebuilt = openCache({ path, clock: time.clock })
    assert.equal(Number(rebuilt.db.prepare('SELECT count(*) AS n FROM prs').get()?.n), 0)
    assert.deepEqual(openNotifications({ db: rebuilt.db, clock: time.clock }).list(repo).map((found) => found.number), [102])
    rebuilt.close()
  } finally {
    await cleanup()
  }
})

test('the kinds in the page\'s order, the ones a banner has, and the ones that toast by default', () => {
  assert.deepEqual(notificationKinds, ['changesRequested', 'readyToMerge', 'reviewRequested', 'newForReview', 'ciFailing', 'runFinished', 'runNeedsInput', 'postBlocked', 'postFailed', 'commandDenied'])
  assert.deepEqual(bannerKinds, ['changesRequested', 'readyToMerge', 'reviewRequested', 'ciFailing', 'runFinished', 'runNeedsInput'])
  assert.deepEqual(toastDefaults, ['runNeedsInput', 'postFailed', 'commandDenied'])
  // a run that ends in one of the new ways banners as the finished run it always was; a new PR for review never bannered
  assert.deepEqual(notificationKinds.map((kind) => bannerKindOf(kind)), ['changesRequested', 'readyToMerge', 'reviewRequested', null, 'ciFailing', 'runFinished', 'runNeedsInput', 'runFinished', 'runFinished', 'runFinished'])
  assert.deepEqual(notificationKinds.map((kind) => headlineOf(kind)), [
    'Changes requested on your PR', 'Your PR is ready to merge', 'Review requested of you', 'PR awaiting your review', 'CI is failing on your PR', 'Review session finished',
    'Review session needs your input', 'Review done, post blocked', 'Review done, post failed', 'Command denied in a session',
  ])
})

test('a kind toasts by the config\'s toasts list, or the defaults when there is none, and the banner settings have no say', () => {
  const shown = (settings: Parameters<typeof toasts>[1]): string[] => notificationKinds.filter((kind) => toasts(kind, settings))
  assert.deepEqual(shown(undefined), toastDefaults)
  assert.deepEqual(shown({ enabled: false, kinds: [] }), toastDefaults)
  assert.deepEqual(shown({ enabled: true, kinds: [...bannerKinds] }), toastDefaults)
  assert.deepEqual(shown({ enabled: false, kinds: [], toasts: [] }), [])
  assert.deepEqual(shown({ enabled: false, kinds: [], toasts: ['newForReview', 'postBlocked'] }), ['newForReview', 'postBlocked'])
})

// a settled run's record, as the poller reads it
const settled = (patch: Partial<Run>): Run => ({ id: 41, repo, number: 106, label: 'Review', status: 'done', result: reviewResult(), note: null, pid: 4242, reason: null, origin: 'manual', resolvedByHand: false, ...patch }) as unknown as Run

const eventOf = (patch: Partial<Run>): { kind: string, detail: string | null, run: number | null } | null => {
  const run = settled(patch)
  const found = runEvent(repo, { number: 106, title: 'Fix the thing' }, run, runDetail(run))
  return found === null ? null : { kind: found.kind, detail: found.detail, run: found.run }
}

test('a run that finished is one kind whether or not it posted, and its detail says which', () => {
  assert.deepEqual(eventOf({}), { kind: 'runFinished', detail: 'Review · Changes requested', run: 41 })
  assert.deepEqual(eventOf({ origin: 'auto', result: reviewResult({ verdict: 'clean', posted: null, notPostedReason: 'noPost' }) } as never), { kind: 'runFinished', detail: 'Review · Clean · not posted', run: 41 })
})

test('a done review whose post was refused is postBlocked, and one whose post failed is postFailed with the failure\'s text', () => {
  assert.deepEqual(eventOf({ result: reviewResult({ posted: null, notPostedReason: 'postBlocked' }) as never }), { kind: 'postBlocked', detail: 'Review · Changes requested · post not made', run: 41 })
  assert.deepEqual(eventOf({ result: reviewResult({ posted: null, notPostedReason: 'ghFailed', error: 'HTTP 502\nfrom GitHub' }) as never }), { kind: 'postFailed', detail: 'Review · Changes requested · post failed: HTTP 502 from GitHub', run: 41 })
  // only a done run's review has a post to speak of
  assert.equal(eventOf({ status: 'failed', note: 'noReport: no such file', result: reviewResult({ posted: null, notPostedReason: 'postBlocked' }) as never })?.kind, 'runFinished')
})

test('a run that failed on a denied tool call is commandDenied with the tools, and one whose folder could not be written, which never spawned, is not', () => {
  assert.deepEqual(eventOf({ status: 'failed', note: 'permissionDenied: Bash, Write', result: null }), { kind: 'commandDenied', detail: 'Review · Failed · permission denied: Bash, Write', run: 41 })
  assert.equal(eventOf({ status: 'failed', note: 'permissionDenied: ~/runs/41 cannot be written: EACCES', result: null, pid: null })?.kind, 'runFinished')
  assert.deepEqual(eventOf({ status: 'failed', note: 'noResult: no result.json', result: null }), { kind: 'runFinished', detail: 'Review · Failed · no result: no result.json', run: 41 })
})

test('a run that needs input says its question, and a stopped, skipped, queued, or running one is no event', () => {
  assert.deepEqual(eventOf({ status: 'needsInput', result: reviewResult({ status: 'needsInput', question: 'Which base?' }) as never }), { kind: 'runNeedsInput', detail: 'Review · Needs your answer: Which base?', run: 41 })
  // a run still waiting on an answer is that, whatever its result says of a post
  assert.equal(eventOf({ status: 'needsInput', result: reviewResult({ status: 'needsInput', question: 'Post?', posted: null, notPostedReason: 'ghFailed' }) as never })?.kind, 'runNeedsInput')
  for (const status of ['stopped', 'skipped', 'queued', 'running'] as const) assert.equal(eventOf({ status }), null, status)
})

test('a detail is flat text of at most 200 characters', () => {
  const run = settled({ status: 'failed', note: `noResult: ${'x'.repeat(400)}\u0007` })
  assert.equal(runDetail(run).length, 200)
  assert.equal(/\p{Cc}/u.test(runDetail(run)), false)
})

test('every event is recorded whether banners are absent, off, or leave its kind out, and only a wanted banner is delivered', async () => {
  for (const [notifications, wanted] of [[undefined, 0], [{ enabled: false, kinds: [...bannerKinds] }, 0], [{ enabled: true, kinds: [] }, 0], [{ enabled: true, kinds: [...bannerKinds] }, 2]] as const) {
    const recorded: string[] = []
    const delivered: Notice[] = []
    const notifier = createNotifier({
      config: () => ({ notifications: notifications as never }), deliver: async (notice) => void delivered.push(notice), log: () => {},
      record: (events) => recorded.push(...events.map((found) => found.kind)),
    })
    notifier.send([event(), event({ kind: 'postBlocked', run: 41 }), event({ kind: 'newForReview' })])
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(recorded, ['readyToMerge', 'postBlocked', 'newForReview'])
    // a blocked post keeps the finished run's banner, words and all, and a new PR for review has none
    assert.deepEqual(delivered.map((notice) => notice.subtitle), wanted === 0 ? [] : ['Your PR is ready to merge', 'Review session finished'])
  }
})

test('a store that throws is logged, reaches no caller, and costs no banner; no events store nothing', async () => {
  const logs: string[] = []
  const delivered: Notice[] = []
  let calls = 0
  const notifier = createNotifier({
    config: () => ({ notifications: { enabled: true, kinds: ['readyToMerge'] } }), deliver: async (notice) => void delivered.push(notice), log: (line) => logs.push(line),
    record: () => {
      calls += 1
      throw new Error('disk full')
    },
  })
  notifier.send([])
  assert.equal(calls, 0)
  notifier.send([event()])
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(logs, ['notifications: cannot store: disk full'])
  assert.equal(delivered.length, 1)
})

// the server: the store behind the poller's own events, the route, and the push

type Answer = { repo: string, days: number, lastId: number, entries: StoredNotification[] }

const rig = async (config: Record<string, unknown> = {}) => {
  const { dir: home, cleanup: removeHome } = await tempDir()
  const configPath = join(home, '.config', 'pit-view', 'config.json')
  await mkdir(join(configPath, '..'), { recursive: true })
  await writeFile(configPath, JSON.stringify({ repo, viewer: scenario.viewer, ...config }), 'utf8')
  const time = fakeTime()
  const delivered: Notice[] = []
  const start = () => startServer({
    home, port: 0, runner: fixtureRunner().runner, clock: time.clock, timers: time.timers, timeZone: scenario.timeZone, configPath,
    cachePath: join(home, '.local', 'state', 'pit-view', 'cache.sqlite'), stateDir: join(home, '.local', 'state', 'pit-view'), publicDir: join(home, 'public'),
    launch: fakeLaunch().deps, log: () => {}, pageSize: scenario.pageSize, deliver: async (notice) => void delivered.push(notice),
  })
  const harness = { server: await start(), time, delivered, start }
  const read = async (): Promise<Answer> => await (await fetch(`${harness.server.url}/api/notifications`)).json() as Answer
  const cleanup = async (): Promise<void> => {
    await harness.server.close()
    await removeHome()
  }
  // a run the server watches, settled as given
  const settle = (patch: Partial<Run>): number => {
    const { cache, poller } = harness.server
    const run = cache.createRun({
      repo, number: 106, command: 'review-pr', args: ['106'], label: 'Review', runner: 'claude', cwd: '~/dev/orbit', sessionId: null, pid: 4242, pidStartedAt: null,
      startedAt: scenario.now, lastStepAt: null, step: null, stepState: null, finishedAt: null, status: 'running', result: null, note: null, costUsd: null, resume: null,
    }, (id) => `~/runs/${id}`)
    poller.runWatched({ id: run.id, repo, number: 106 })
    cache.updateRun(run.id, { finishedAt: scenario.now, ...patch })
    poller.runChanged(repo, 106)
    return run.id
  }
  return { harness, read, settle, cleanup }
}

test('the first load stores nothing, through the real server', async () => {
  const { harness, read, cleanup } = await rig()
  try {
    harness.server.poller.refresh('manual')
    await harness.server.poller.idle()
    assert.deepEqual(await read(), { repo, days: 14, lastId: 0, entries: [] })
  } finally {
    await cleanup()
  }
})

test('a settled run is stored with banners off, read back, and still there after a restart', async () => {
  const { harness, read, settle, cleanup } = await rig()
  try {
    harness.server.poller.refresh('manual')
    await harness.server.poller.idle()
    const id = settle({ status: 'done', result: reviewResult({ posted: null, notPostedReason: 'postBlocked' }) as never })
    const answer = await read()
    assert.deepEqual([answer.repo, answer.days, answer.lastId], [repo, 14, 1])
    assert.deepEqual(answer.entries.map((found) => [found.kind, found.label, found.number, found.run, found.detail]), [['postBlocked', 'Review done, post blocked', 106, id, 'Review · Changes requested · post not made']])
    assert.ok((answer.entries[0]?.title ?? '').length > 0)
    assert.deepEqual(harness.delivered, [])
    await harness.server.close()
    harness.server = await harness.start()
    assert.deepEqual(await read(), answer)
  } finally {
    await cleanup()
  }
})

// what an open page receives on its event stream while `work` runs, until it has `count` notifications
const pushedDuring = async (url: string, count: number, work: () => void): Promise<NonNullable<Patch['notifications']>> => {
  const controller = new AbortController()
  // one that never comes fails the test here, with its stream closed, rather than holding the server open
  const response = await fetch(`${url}/api/events?client=c1&visible=false&paused=true`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]) })
  const reader = response.body!.getReader()
  work()
  const pushed: NonNullable<Patch['notifications']> = []
  let text = ''
  while (pushed.length < count) {
    const { value, done } = await reader.read()
    assert.equal(done, false)
    text += new TextDecoder().decode(value)
    const frames = text.split('\n\n')
    text = frames.pop() ?? ''
    for (const frame of frames) {
      if (frame.startsWith('event: patch\n')) pushed.push(...(JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as Patch).notifications ?? [])
    }
  }
  controller.abort()
  await reader.cancel().catch(() => {})
  return pushed
}

const blocked = { status: 'done', result: reviewResult({ posted: null, notPostedReason: 'postBlocked' }) } as never
const asking = { status: 'needsInput', result: reviewResult({ status: 'needsInput', question: 'Which base?' }) } as never

test('an open page receives each new notification on its event stream, marked by whether its kind toasts', { timeout: 15_000 }, async () => {
  const { harness, settle, cleanup } = await rig()
  try {
    const pushed = await pushedDuring(harness.server.url, 2, () => {
      settle(blocked)
      settle(asking)
    })
    assert.deepEqual(pushed.map((found) => [found.id, found.kind, found.toast]), [[1, 'postBlocked', false], [2, 'runNeedsInput', true]])
  } finally {
    await cleanup()
  }
})

test('the Toast switches change only the push\'s mark: a muted kind is pushed, stored, and read back all the same', { timeout: 15_000 }, async () => {
  const { harness, read, settle, cleanup } = await rig({ notifications: { enabled: false, kinds: [], toasts: ['postBlocked'] } })
  try {
    const pushed = await pushedDuring(harness.server.url, 2, () => {
      settle(blocked)
      settle(asking)
    })
    assert.deepEqual(pushed.map((found) => [found.kind, found.toast]), [['postBlocked', true], ['runNeedsInput', false]])
    assert.deepEqual((await read()).entries.map((found) => found.kind), ['runNeedsInput', 'postBlocked'])
  } finally {
    await cleanup()
  }
})

test('a page through no session is refused the list, as every read is', async () => {
  const { harness, cleanup } = await rig()
  try {
    const refused = await fetch(`${harness.server.url}/api/notifications`, { headers: { 'X-Forwarded-For': '192.0.2.10' } })
    assert.equal(refused.status, 401)
    assert.equal((await fetch(`${harness.server.url}/api/notifications`, { method: 'POST' })).status, 405)
  } finally {
    await cleanup()
  }
})
