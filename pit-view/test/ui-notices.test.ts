// test/ui-notices.test.ts
// the in-app notifications area (section 6 of DESIGN.md, Notifications area): the read, dismissed, and cleared marks of one browser, what the bell and the panel say, where a notification leads, the real public/notices.ts and public/noticeopen.ts against the fake document in test/fake-dom.ts, the Settings card's rows through the real public/settings.ts, and the page's markup, wiring, and styles read from the sources. Every fixture is invented, and every expected string is written out here
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { validateConfig, defaultConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import type { PushedNotification, StoredNotification } from '../src/notifications.ts'
import { bannerKinds, notificationKinds, toastDefaults } from '../src/notify.ts'
import { drawerOpenerSelector } from '../public/drawerview.ts'
import { setTimeFormat } from '../public/format.ts'
import { openNotice } from '../public/noticeopen.ts'
import { createNotices, toastLimit, toastMs } from '../public/notices.ts'
import type { NoticeTarget } from '../public/noticesview.ts'
import { bellModel, clearAll, dismissNotice, emptyRead, isUnread, markAllRead, markRead, mergeNotices, noticeTarget, panelModel, parseRead, readKey, settleRead, shownNotices, unreadCount } from '../public/noticesview.ts'
import { fieldId, notifyChoices, toConfig, toForm, toastDefaults as pageToastDefaults } from '../public/settings-form.ts'
import { installFakeBrowser, tick } from './fake-dom.ts'
import type { FakeElement } from './fake-dom.ts'

setTimeFormat('12h')

const repo = 'octo-example/orbit'
const now = Date.parse('2026-11-02T15:00:00Z')

const notice = (id: number, patch: Partial<StoredNotification> = {}): StoredNotification => ({
  id, at: '2026-11-02T14:30:00Z', kind: 'runFinished', label: 'Review session finished', repo, number: 100 + id, title: `feat(nav): invented change ${id}`, run: null, detail: null, ...patch,
})

// the marks of one browser

test('unread is past the read marker and not read by itself, and the count is of what is shown', () => {
  const items = [notice(5), notice(4), notice(3)]
  assert.equal(unreadCount(items, emptyRead()), 3)
  const through = { ...emptyRead(), readThrough: 4 }
  assert.deepEqual(items.map((item) => isUnread(item, through)), [true, false, false])
  assert.equal(unreadCount(items, markRead(emptyRead(), 4)), 2)
  assert.equal(unreadCount(items, dismissNotice(emptyRead(), 5)), 2)
})

test('marking all read moves the marker to the newest, never back, and drops the single marks it covers', () => {
  const read = markAllRead(markRead(markRead(emptyRead(), 4), 9), [notice(5), notice(3)])
  assert.deepEqual([read.readThrough, read.read], [5, [9]])
  assert.equal(markAllRead(read, [notice(2)]).readThrough, 5)
  assert.equal(markAllRead(emptyRead(), []).readThrough, 0)
})

test('dismissing hides one, clearing hides every one listed and none that comes after, and neither touches the list itself', () => {
  const items = [notice(5), notice(4), notice(3)]
  assert.deepEqual(shownNotices(items, dismissNotice(emptyRead(), 4)).map((item) => item.id), [5, 3])
  const cleared = clearAll(dismissNotice(emptyRead(), 4), items)
  assert.deepEqual(shownNotices(items, cleared), [])
  assert.deepEqual([cleared.clearedThrough, cleared.dismissed], [5, []])
  assert.equal(clearAll(cleared, [notice(3)]).clearedThrough, 5, 'and never moves back')
  assert.deepEqual(shownNotices([notice(6), ...items], cleared).map((item) => item.id), [6])
  assert.equal(unreadCount([notice(6), ...items], cleared), 1)
  assert.equal(items.length, 3)
})

test('marks past the highest id the server ever gave belong to a cache that is gone and are dropped; marks at it stand', () => {
  const read = { readThrough: 5, read: [], clearedThrough: 3, dismissed: [4] }
  assert.deepEqual(settleRead(read, 5), read)
  assert.deepEqual(settleRead(read, 4), emptyRead())
  assert.deepEqual(settleRead({ ...emptyRead(), dismissed: [8] }, 7), emptyRead())
  assert.deepEqual(settleRead({ ...emptyRead(), read: [8] }, 7), emptyRead())
})

test('stored marks that are missing, broken, or of another shape read as none', () => {
  const read = { readThrough: 5, read: [7], clearedThrough: 3, dismissed: [6] }
  assert.deepEqual(parseRead(JSON.stringify(read)), read)
  for (const text of [null, '', '{', '[]', '7', 'null', JSON.stringify({ ...read, readThrough: '5' }), JSON.stringify({ ...read, dismissed: ['x'] })]) assert.deepEqual(parseRead(text), emptyRead(), String(text))
  assert.equal(readKey(repo), 'pit-view.notifications:octo-example/orbit')
})

test('lists merge newest first with each notification once', () => {
  assert.deepEqual(mergeNotices([notice(4), notice(2)], [notice(5), notice(4), notice(3)]).map((item) => item.id), [5, 4, 3, 2])
})

// what it says, and where it leads

test('the bell says how many are unread, in its badge and its name', () => {
  assert.deepEqual(bellModel(0), { badge: '', label: 'Notifications' })
  assert.deepEqual(bellModel(1), { badge: '1', label: 'Notifications, 1 unread' })
  assert.deepEqual(bellModel(99), { badge: '99', label: 'Notifications, 99 unread' })
  assert.deepEqual(bellModel(100), { badge: '99+', label: 'Notifications, 100 unread' })
})

test('a run\'s notification opens its run, a PR the page holds opens its drawer, and any other goes to GitHub', () => {
  const holds = (number: number): boolean => number === 104
  assert.deepEqual(noticeTarget(notice(6, { run: 41 }), holds), { kind: 'run', number: 106, runId: 41, title: 'feat(nav): invented change 6' })
  assert.deepEqual(noticeTarget(notice(4), holds), { kind: 'drawer', number: 104 })
  assert.deepEqual(noticeTarget(notice(5), holds), { kind: 'github' })
})

test('the panel lists every kind newest first with its label, PR, title, time, detail, and link, and marks what was unread as it opened', () => {
  const items = [notice(6, { kind: 'postBlocked', label: 'Review done, post blocked', run: 41, detail: 'Review · Clean · post not made', at: '2026-11-02T14:59:55Z' }), notice(4, { title: null })]
  assert.deepEqual(panelModel(items, { ...emptyRead(), readThrough: 4 }, { nowMs: now, holds: () => true }), [
    { id: 6, label: 'Review done, post blocked', text: '#106 feat(nav): invented change 6', detail: 'Review · Clean · post not made', when: 'just now', tip: '2:59 PM', unread: true, href: 'https://github.com/octo-example/orbit/pull/106', target: { kind: 'run', number: 106, runId: 41, title: 'feat(nav): invented change 6' } },
    { id: 4, label: 'Review session finished', text: '#104', detail: null, when: '30m ago', tip: '2:30 PM', unread: false, href: 'https://github.com/octo-example/orbit/pull/104', target: { kind: 'drawer', number: 104 } },
  ].map((item) => ({ ...item, tip: item.tip.replace(/.*/, () => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' }).format(new Date(items.find((found) => found.id === item.id)!.at))) })))
})

// the component

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

const answer = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const pushed = (id: number, toast: boolean, patch: Partial<StoredNotification> = {}): PushedNotification => ({ ...notice(id, patch), toast })

const withNotices = async (served: { repo?: string, lastId?: number, entries?: StoredNotification[], status?: number, hold?: Promise<void> }, check: (page: {
  notices: ReturnType<typeof createNotices>, doc: ReturnType<typeof installFakeBrowser>['document'], bell: FakeElement, badge: FakeElement, panel: FakeElement, toastBox: FakeElement, outside: FakeElement
  opened: NoticeTarget[], stored: Map<string, string>, timers: Map<number, () => void>, refuse: (on: boolean) => void
}) => Promise<void>): Promise<void> => {
  const fake = installFakeBrowser((async (input: string) => {
    assert.equal(String(input), '/api/notifications')
    await served.hold
    return served.status !== undefined ? answer(served.status, {}) : answer(200, { repo: served.repo ?? repo, days: 14, lastId: served.lastId ?? 0, entries: served.entries ?? [] })
  }) as typeof fetch)
  Object.defineProperty(globalThis, 'Node', { value: globalThis.Element, configurable: true, writable: true })
  try {
    const doc = fake.document
    const make = (tag: string, id: string): FakeElement => {
      const element = doc.createElement(tag)
      element.setAttribute('id', id)
      return element
    }
    const [root, bell, badge, panel, toastBox, outside] = [make('div', 'notifications'), make('button', 'notifications-button'), make('span', 'notifications-count'), make('div', 'notifications-panel'), make('div', 'toasts'), make('button', 'elsewhere')]
    panel.hidden = true
    bell.append(badge)
    root.append(bell, panel)
    doc.body.append(root, toastBox, outside)
    const stored = new Map<string, string>()
    const timers = new Map<number, () => void>()
    const opened: NoticeTarget[] = []
    let nextTimer = 0
    let accepts = true
    const notices = createNotices({
      root: root as never, button: bell as never, badge: badge as never, panel: panel as never, toastBox: toastBox as never,
      nowMs: () => now, holds: (number) => number === 104,
      open: (target) => {
        if (accepts) opened.push(target)
        return accepts
      },
      storage: () => ({ getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => void stored.set(key, value) }),
      timers: { set: (run, ms) => {
        assert.equal(ms, toastMs)
        nextTimer += 1
        timers.set(nextTimer, run)
        return nextTimer
      }, clear: (handle) => void timers.delete(handle as number) },
    })
    await check({ notices, doc, bell, badge, panel, toastBox, outside, opened, stored, timers, refuse: (on) => {
      accepts = !on
    } })
  } finally {
    fake.restore()
    delete (globalThis as Record<string, unknown>).Node
  }
}

const texts = (root: FakeElement, selector: string): string[] => root.querySelectorAll(selector).map((element) => element.textContent)

test('a fresh page reads the stored list, counts it on the bell, and toasts none of it', async () => {
  await withNotices({ lastId: 6, entries: [notice(6), notice(4)] }, async ({ notices, bell, badge, panel, toastBox }) => {
    assert.equal(badge.hidden, true)
    await notices.load()
    assert.equal(badge.textContent, '2')
    assert.equal(badge.hidden, false)
    assert.equal(bell.getAttribute('aria-label'), 'Notifications, 2 unread')
    assert.equal(toastBox.children.length, 0)
    assert.equal(panel.hidden, true)
  })
})

test('opening the panel lists every notification and marks them read in this browser, across a reload', async () => {
  const served = { lastId: 6, entries: [notice(6), notice(4)] }
  let kept = new Map<string, string>()
  await withNotices(served, async ({ notices, bell, badge, panel, stored }) => {
    await notices.load()
    bell.dispatch('click')
    assert.equal(panel.hidden, false)
    assert.equal(bell.getAttribute('aria-expanded'), 'true')
    assert.deepEqual(texts(panel, '.notice-open'), ['#106 feat(nav): invented change 6', '#104 feat(nav): invented change 4'])
    assert.equal(panel.querySelectorAll('[data-unread]').length, 2, 'what was unread as it opened still shows so')
    assert.equal(badge.hidden, true)
    kept = stored
    bell.dispatch('click')
    assert.equal(panel.hidden, true)
    bell.dispatch('click')
    assert.equal(panel.querySelectorAll('[data-unread]').length, 0)
  })
  await withNotices(served, async ({ notices, badge, stored }) => {
    for (const [key, value] of kept) stored.set(key, value)
    await notices.load()
    assert.equal(badge.hidden, true)
  })
})

test('a pushed notification lands in the panel and on the bell whether or not it toasts, once however often it comes', async () => {
  await withNotices({}, async ({ notices, badge, toastBox, bell, panel }) => {
    await notices.load()
    notices.take([pushed(1, false, { kind: 'postBlocked' })])
    assert.equal(toastBox.children.length, 0)
    assert.equal(badge.textContent, '1')
    notices.take([pushed(2, true)])
    notices.take([pushed(2, true)])
    assert.equal(toastBox.children.length, 1)
    assert.equal(badge.textContent, '2')
    bell.dispatch('click')
    assert.equal(panel.querySelectorAll('.notice-item').length, 2)
    notices.take([pushed(3, false)])
    assert.equal(panel.querySelectorAll('.notice-item').length, 3)
    assert.equal(badge.hidden, true, 'one that arrives while the panel is open is read')
  })
})

test('a push that lands while the list is being read is kept, its marks with it, and one for another repository is not', async () => {
  let release = (): void => {}
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  await withNotices({ lastId: 6, entries: [notice(6)], hold }, async ({ notices, bell, badge, panel }) => {
    const loading = notices.load()
    notices.take([pushed(7, false), pushed(8, false, { repo: 'octo-example/nebula' })])
    release()
    await loading
    assert.equal(badge.textContent, '2')
    notices.take([pushed(9, false, { repo: 'octo-example/nebula' })])
    bell.dispatch('click')
    assert.deepEqual(texts(panel, '.notice-open'), ['#107 feat(nav): invented change 7', '#106 feat(nav): invented change 6'])
  })
})

test('a toast goes by itself, or by its dismiss button, which leaves the panel entry unread; a pointer or focus on it holds it', async () => {
  await withNotices({}, async ({ notices, toastBox, timers, badge }) => {
    await notices.load()
    notices.take([pushed(1, true), pushed(2, true)])
    assert.deepEqual(toastBox.children.map((toast) => toast.querySelector('.notice-open')?.textContent), ['#101 feat(nav): invented change 1', '#102 feat(nav): invented change 2'])
    const first = toastBox.children[0] as FakeElement
    first.dispatch('pointerenter')
    assert.equal(timers.size, 1)
    first.dispatch('pointerleave')
    assert.equal(timers.size, 2)
    first.dispatch('focusin')
    assert.equal(timers.size, 1)
    first.dispatch('focusout')
    assert.equal(timers.size, 2)
    ;(first.querySelector('.notice-dismiss') as FakeElement).dispatch('click')
    assert.equal(toastBox.children.length, 1)
    assert.equal(timers.size, 1)
    for (const run of [...timers.values()]) run()
    assert.equal(toastBox.children.length, 0)
    assert.equal(badge.textContent, '2')
  })
})

test('the stack holds only the newest toasts', async () => {
  await withNotices({}, async ({ notices, toastBox, timers }) => {
    await notices.load()
    notices.take(Array.from({ length: toastLimit + 2 }, (_, index) => pushed(index + 1, true)))
    assert.equal(toastLimit, 4)
    assert.deepEqual(toastBox.children.map((toast) => toast.querySelector('.notice-open')?.textContent.slice(0, 4)), ['#103', '#104', '#105', '#106'])
    assert.equal(timers.size, 4)
  })
})

test('a toast and a panel entry open the same target, mark it read, and close what they were in', async () => {
  await withNotices({ lastId: 3, entries: [notice(3, { run: 40 })] }, async ({ notices, toastBox, badge, opened, bell, panel }) => {
    await notices.load()
    notices.take([pushed(4, true)])
    ;(toastBox.children[0]?.querySelector('.notice-open') as FakeElement).dispatch('click')
    assert.deepEqual(opened, [{ kind: 'drawer', number: 104 }])
    assert.equal(toastBox.children.length, 0)
    assert.equal(badge.textContent, '1')
    bell.dispatch('click')
    ;(panel.querySelector('[data-notice-open="3"]') as FakeElement).dispatch('click')
    assert.deepEqual(opened.at(-1), { kind: 'run', number: 103, runId: 40, title: 'feat(nav): invented change 3' })
    assert.equal(panel.hidden, true)
  })
})

test('an open that is refused, with a drawer\'s request on its way, leaves the panel and the toast as they are', async () => {
  await withNotices({ lastId: 4, entries: [notice(4)] }, async ({ notices, toastBox, opened, bell, panel, refuse }) => {
    await notices.load()
    refuse(true)
    notices.take([pushed(5, true, { run: 41 })])
    ;(toastBox.children[0]?.querySelector('.notice-open') as FakeElement).dispatch('click')
    assert.equal(toastBox.children.length, 1)
    bell.dispatch('click')
    ;(panel.querySelector('[data-notice-open="4"]') as FakeElement).dispatch('click')
    assert.equal(panel.hidden, false)
    assert.deepEqual(opened, [])
  })
})

test('a notification with no drawer is a link to GitHub in a new tab, and one with a drawer has that link beside its button', async () => {
  await withNotices({ lastId: 5, entries: [notice(5), notice(4)] }, async ({ notices, bell, panel }) => {
    await notices.load()
    bell.dispatch('click')
    const [none, held] = panel.querySelectorAll('.notice-item') as [FakeElement, FakeElement]
    const link = none.querySelector('.notice-open') as FakeElement
    assert.deepEqual([link.tag, link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')], ['a', 'https://github.com/octo-example/orbit/pull/105', '_blank', 'noopener'])
    assert.ok(none.querySelector('.notice-github') === null)
    assert.equal(held.querySelector('.notice-open')?.tag, 'button')
    assert.equal(held.querySelector('.notice-github')?.getAttribute('href'), 'https://github.com/octo-example/orbit/pull/104')
  })
})

test('dismiss and Clear all hide entries in this browser, and Clear all is disabled with nothing to clear', async () => {
  await withNotices({ lastId: 6, entries: [notice(6), notice(5), notice(4)] }, async ({ notices, bell, panel, stored }) => {
    await notices.load()
    bell.dispatch('click')
    ;(panel.querySelector('[data-notice-dismiss="5"]') as FakeElement).dispatch('click')
    assert.deepEqual(texts(panel, '.notice-open'), ['#106 feat(nav): invented change 6', '#104 feat(nav): invented change 4'])
    const clear = (): FakeElement => panel.querySelector('[data-notices-clear]') as FakeElement
    assert.equal(clear().disabled, false)
    clear().dispatch('click')
    assert.equal(panel.querySelectorAll('.notice-item').length, 0)
    assert.equal(clear().disabled, true)
    assert.deepEqual(texts(panel, '.notices-empty'), ['No notifications.'])
    assert.equal(JSON.parse(stored.get(readKey(repo)) ?? '{}').clearedThrough, 6)
    // the server still holds them, and a reload here still hides them
    await notices.load()
    assert.equal(panel.querySelectorAll('.notice-item').length, 0)
    notices.take([pushed(7, false)])
    assert.equal(panel.querySelectorAll('.notice-item').length, 1)
  })
})

test('another tab\'s marks are taken up when its storage changes, and another key\'s are not', async () => {
  await withNotices({ lastId: 6, entries: [notice(6)] }, async ({ notices, badge, stored }) => {
    await notices.load()
    stored.set(readKey(repo), JSON.stringify({ ...emptyRead(), readThrough: 6 }))
    notices.storageChanged('pit-view.theme')
    assert.equal(badge.textContent, '1')
    notices.storageChanged(readKey(repo))
    assert.equal(badge.hidden, true)
  })
})

test('marks of a cache file that is gone are dropped from storage too, so they never hide what comes later', async () => {
  await withNotices({ lastId: 6, entries: [notice(6)] }, async ({ notices, badge, stored }) => {
    stored.set(readKey(repo), JSON.stringify({ ...emptyRead(), readThrough: 500, clearedThrough: 500 }))
    await notices.load()
    assert.equal(badge.textContent, '1')
    assert.deepEqual(parseRead(stored.get(readKey(repo)) ?? null), emptyRead())
  })
})

test('a focused toast that is dismissed hands focus to the bell', async () => {
  await withNotices({}, async ({ notices, doc, bell, toastBox }) => {
    await notices.load()
    notices.take([pushed(1, true)])
    const dismiss = toastBox.children[0]?.querySelector('.notice-dismiss') as FakeElement
    dismiss.focus()
    dismiss.dispatch('click')
    assert.ok(doc.activeElement === bell)
  })
})

test('the notification classes are their own: no rule outside the block names one, and none of the page\'s older classes is restyled', () => {
  const css = read('styles.css')
  const start = css.indexOf('/* the notifications area')
  const end = css.indexOf('/* end of the notifications area */')
  const outside = css.slice(0, start) + css.slice(end)
  assert.ok(start >= 0 && end > start)
  const inside = new Set([...css.slice(start, end).matchAll(/^\.([a-z-]+)/gm)].map(([, name]) => name ?? ''))
  for (const name of inside) assert.doesNotMatch(outside, new RegExp(`\\.${name}(?![\\w-])`), name)
})

test('a list that cannot be read says so in the panel', async () => {
  await withNotices({ status: 500 }, async ({ notices, bell, panel }) => {
    await notices.load()
    bell.dispatch('click')
    assert.deepEqual(texts(panel, '.notices-empty'), ['The notifications could not be loaded.'])
  })
})

test('Escape and a press outside close the panel, Escape returning focus to the bell, and a press inside leaves it', async () => {
  await withNotices({ lastId: 4, entries: [notice(4)] }, async ({ notices, doc, bell, panel, outside }) => {
    await notices.load()
    assert.equal(outside.dispatch('keydown', { key: 'Escape' }), false, 'a closed panel leaves Escape to the page')
    bell.dispatch('click')
    assert.equal((panel.querySelector('.notice-item') as FakeElement).dispatch('pointerdown'), false)
    assert.equal(notices.isOpen(), true)
    assert.equal(panel.dispatch('keydown', { key: 'Escape' }), true)
    assert.equal(panel.hidden, true)
    assert.equal(bell.getAttribute('aria-expanded'), 'false')
    assert.ok(doc.activeElement === bell)
    bell.dispatch('click')
    outside.dispatch('pointerdown')
    assert.equal(panel.hidden, true)
  })
})

test('a redraw that changes nothing keeps the panel\'s own controls', async () => {
  await withNotices({ lastId: 4, entries: [notice(4)] }, async ({ notices, bell, panel }) => {
    await notices.load()
    bell.dispatch('click')
    const before = panel.querySelector('.notice-open')
    notices.update()
    assert.ok(before !== null && panel.querySelector('.notice-open') === before)
  })
})

test('opening a target closes the other panels, opens its drawer with focus to come back to the bell, and waits while a request is on its way', () => {
  const calls: unknown[][] = []
  const state = { drawerBusy: false, sweepBusy: false }
  const open = openNotice({
    drawer: { open: (...args: unknown[]) => void calls.push(['open', ...args]), busy: () => state.drawerBusy } as never,
    sweepDrawer: { close: () => void calls.push(['sweep']), busy: () => state.sweepBusy } as never,
    logPanel: { close: () => void calls.push(['log']) },
    seedRuns: () => void calls.push(['seed']),
  })
  assert.equal(open({ kind: 'run', number: 106, runId: 41, title: null }), true)
  assert.deepEqual(calls, [['seed'], ['sweep'], ['log'], ['open', 106, { key: 'notifications-button', number: 106 }, undefined, { runId: 41, title: null }]])
  calls.length = 0
  assert.equal(open({ kind: 'drawer', number: 104 }), true)
  assert.deepEqual(calls.at(-1), ['open', 104, { key: 'notifications-button', number: 104 }])
  calls.length = 0
  // the link itself goes to GitHub; no drawer moves
  assert.equal(open({ kind: 'github' }), true)
  for (const busy of ['drawerBusy', 'sweepBusy'] as const) {
    state[busy] = true
    assert.equal(open({ kind: 'drawer', number: 104 }), false)
    state[busy] = false
  }
  assert.deepEqual(calls, [])
})

// Settings

const ids = (): (() => string) => {
  let next = 0
  return () => `id-${next += 1}`
}

test('the Settings rows are the server\'s kinds in its order, each with a toast, and a banner only where it has one', () => {
  assert.deepEqual(notifyChoices.map((choice) => choice.kind), notificationKinds)
  assert.deepEqual(notifyChoices.filter((choice) => choice.banner).map((choice) => choice.kind), bannerKinds)
  assert.deepEqual(pageToastDefaults, toastDefaults)
})

test('toasts round-trip: defaults leave the key out, an old config is saved as it was, and a change is saved in the page\'s order', () => {
  const plain = defaultConfig()
  const form = toForm(plain, ids())
  assert.deepEqual(form.notifyToasts, toastDefaults)
  assert.equal('notifications' in toConfig(form, plain), false)
  const old: Config = { ...plain, notifications: { enabled: true, kinds: ['readyToMerge'] } }
  assert.deepEqual(toConfig(toForm(old, ids()), old).notifications, { enabled: true, kinds: ['readyToMerge'] })
  form.notifyToasts = ['postBlocked', 'newForReview']
  assert.deepEqual(toConfig(form, plain).notifications, { enabled: false, kinds: [...bannerKinds], toasts: ['newForReview', 'postBlocked'] })
  // a list the file holds stays, even at the defaults, and an empty one is every toast off
  const kept: Config = { ...plain, notifications: { enabled: false, kinds: [], toasts: [...toastDefaults] } }
  assert.deepEqual(toConfig(toForm(kept, ids()), kept).notifications, kept.notifications)
  const none: Config = { ...plain, notifications: { enabled: false, kinds: [], toasts: [] } }
  assert.deepEqual(toConfig(toForm(none, ids()), none).notifications, none.notifications)
  assert.deepEqual(validateConfig(toConfig(form, plain)).notifications, { enabled: false, kinds: [...bannerKinds], toasts: ['newForReview', 'postBlocked'] })
})

test('the Settings card draws a Toast box for every kind and a banner box for each that has one, and unticking a toast saves only that', async () => {
  const html = readFileSync(new URL('../public/settings.html', import.meta.url), 'utf8')
  const stored = { ...defaultConfig(), repo, viewer: 'vera-quill', notifications: { enabled: true, kinds: ['readyToMerge'] } }
  const puts: Config[] = []
  const fake = installFakeBrowser((async (input: string, init?: RequestInit) => {
    if (String(input) !== '/api/config') return answer(404, {})
    if (init?.method === 'PUT') puts.push(JSON.parse(String(init.body)) as Config)
    return answer(200, init?.method === 'PUT' ? puts.at(-1) : stored)
  }) as typeof fetch)
  try {
    fake.document.loadPage(html)
    await import(new URL('../public/settings.ts?notices=1', import.meta.url).href)
    await settle()
    const byId = (id: string): FakeElement => fake.document.getElementById(id) as FakeElement
    const rows = byId('notify-kinds').querySelectorAll('.kind')
    assert.equal(rows.length, notificationKinds.length)
    for (const [index, kind] of notificationKinds.entries()) {
      const toast = rows[index]?.querySelector(`#${fieldId(`notifyToast.${kind}` as never)}`)
      const banner = rows[index]?.querySelector(`#${fieldId(`notifyKind.${kind}` as never)}`)
      assert.equal(toast?.checked, toastDefaults.includes(kind), kind)
      assert.equal(banner != null, (bannerKinds as readonly string[]).includes(kind), kind)
      assert.equal(banner?.checked ?? false, kind === 'readyToMerge', kind)
      assert.match(toast?.getAttribute('aria-label') ?? '', /^Toast: /)
    }
    tick(byId('f-notifyToast-postFailed'))
    byId('settings-form').dispatch('submit')
    await settle()
    assert.deepEqual(puts.map((put) => put.notifications), [{ enabled: true, kinds: ['readyToMerge'], toasts: ['runNeedsInput', 'commandDenied'] }])
  } finally {
    fake.restore()
  }
})

// the page's markup, wiring, and styles, read from the sources

const read = (name: string): string => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8')

test('the header has one bell, after the page search and before Refresh, with its panel a hidden labeled dialog, and the page has the toast stack', () => {
  const html = read('index.html')
  const at = html.indexOf('<div id="notifications"')
  assert.ok(at > html.indexOf('id="page-search-clear"') && at < html.indexOf('id="refresh"'))
  assert.match(html, /<button id="notifications-button" type="button" class="icon-button notifications-button" aria-label="Notifications" title="Notifications" aria-expanded="false" aria-haspopup="dialog" aria-controls="notifications-panel" data-focus-key="notifications-button">/)
  assert.match(html, /<span id="notifications-count" class="notifications-count" aria-hidden="true" hidden><\/span>/)
  assert.match(html, /<div id="notifications-panel" class="notifications-panel" role="dialog" aria-label="Notifications" hidden><\/div>/)
  assert.match(html, /<div id="toasts" class="toasts" role="status" aria-label="New notifications"><\/div>/)
})

test('app.ts hands the stream\'s notifications over, reads the list with every view, redraws the panel, and opens what it names', () => {
  const app = read('app.ts')
  assert.ok(app.includes('if (patch.notifications !== undefined) notices.take(patch.notifications)'))
  assert.match(app, /const loadView = async \(\): Promise<void> => \{\n  void notices\.load\(\)\n/)
  assert.match(app, /if \(patch\.repo !== undefined\) void notices\.load\(\)/)
  assert.ok(app.includes('notices.update()'))
  assert.ok(app.includes('open: openNotice({ drawer, sweepDrawer, logPanel, seedRuns }),'))
  assert.ok(app.includes('holds: (number) => feed.view !== null && (findOpenRow(feed.view, number) !== undefined || findClosedRow(feed.view, number) !== undefined),'))
  assert.ok(app.includes("window.addEventListener('storage', (event) => notices.storageChanged(event.key))"))
  assert.ok(app.includes('storage: () => window.localStorage,'))
})

test('the panel\'s Escape is heard before the page\'s own, which leaves a handled one alone', () => {
  const app = read('app.ts')
  const made = app.indexOf('const notices = createNotices({')
  assert.ok(made >= 0 && made < app.indexOf("// Escape closes what is topmost"))
  assert.ok(app.includes("if (event.key !== 'Escape' || event.defaultPrevented) return"))
})

test('the Settings card says its switch is the desktop banners\' and that the bell works without them', () => {
  const html = read('settings.html')
  assert.ok(html.includes('Show desktop banners'))
  assert.ok(html.includes('The bell in the header works without them.'))
  assert.ok(html.includes('The bell\'s panel lists every kind.'))
  assert.equal(html.includes('Notify me when a PR changes state'), false)
})

test('a press on a notification that opens a drawer is left to its own click', () => {
  assert.ok(drawerOpenerSelector.includes('button[data-notice-open]'))
  assert.ok(drawerOpenerSelector.split(', ').includes('#toasts'), 'and one anywhere in a toast, so dismissing one never closes the drawer')
  assert.ok(read('notices.ts').includes("'data-notice-open'"))
})

test('the notification styles use the theme\'s variables only, and every class has a rule', () => {
  const css = read('styles.css')
  for (const name of ['notifications', 'notifications-button', 'notifications-count', 'notifications-panel', 'notices-head', 'notices-list', 'notices-empty', 'notice-item', 'notice-meta', 'notice-label', 'notice-open', 'notice-detail', 'notice-github', 'notice-dismiss', 'toasts', 'toast']) {
    assert.match(css, new RegExp(`\\.${name}[ ,{:\\[]`), `.${name} has a rule`)
  }
  const block = css.slice(css.indexOf('/* the notifications area'), css.indexOf('/* end of the notifications area */'))
  assert.ok(block.length > 200)
  assert.doesNotMatch(block, /font-family|#[0-9a-f]{3,8}\b|rgba?\(|light-dark\(/i)
})

test('times in the notifications area come from format.ts alone', () => {
  for (const name of ['notices.ts', 'noticesview.ts', 'noticeopen.ts']) assert.doesNotMatch(read(name), /Intl\.|toLocale|new Date\(/, name)
})
