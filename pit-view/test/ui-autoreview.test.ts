// test/ui-autoreview.test.ts
// the header's auto-review indicator and its popover (public/autoreviewbar.ts): the words for each state, the last ticks, the links, the worktrees left in place, and the Run now request; every expected string is written out here, not built with the module's own helpers
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import type { AutoReviewView } from '../src/autoreview.ts'
import type { Tick } from '../src/cache.ts'
import { setTimeFormat } from '../public/format.ts'
import { nowLine } from '../public/settings-form.ts'
import { indicator, popoverFocus, runLinkKey, popoverModel, runNowRequest, runNowResult, skipWords } from '../public/autoreviewbar.ts'

setTimeFormat('12h')

const timeZone = 'UTC'
// a Friday afternoon
const now = Date.parse('2026-10-30T14:31:00Z')
const reading = { nowMs: now, timeZone }

const view = (patch: Partial<AutoReviewView> = {}): AutoReviewView => ({
  enabled: true, state: 'idle', nextTickAt: '2026-10-30T14:45:00Z', running: 0, queued: 0, startedToday: 0,
  lastTick: null, posting: { others: false, dependabot: false }, sweepHold: null, worktrees: { kept: [], unlisted: [] }, ...patch,
})

test('the indicator reads the scheduler\'s state in the owner\'s words, and is absent until the config has autoReview', () => {
  assert.equal(indicator(null, reading), null)
  assert.deepEqual(indicator(view(), reading), { text: 'Auto-review · next 2:45 PM', tone: 'normal' })
  assert.deepEqual(indicator(view({ state: 'running', running: 1, queued: 2 }), reading), { text: 'Auto-review · 1 running, 2 queued · next 2:45 PM', tone: 'normal' })
  assert.deepEqual(indicator(view({ state: 'running', running: 0, queued: 2 }), reading), { text: 'Auto-review · 2 queued · next 2:45 PM', tone: 'normal' })
  assert.deepEqual(indicator(view({ state: 'running', running: 3, queued: 0 }), reading), { text: 'Auto-review · 3 running · next 2:45 PM', tone: 'normal' })
  // a tick looking for work, with nothing yet running or queued, and no next tick while it runs
  assert.deepEqual(indicator(view({ state: 'running', nextTickAt: null }), reading), { text: 'Auto-review · checking PRs', tone: 'normal' })
  assert.deepEqual(indicator(view({ enabled: false, state: 'off', nextTickAt: null }), reading), { text: 'Auto-review · off', tone: 'normal' })
})

test('outside active hours the indicator names the next opening, with the weekday when it is not today', () => {
  assert.deepEqual(indicator(view({ state: 'outsideHours', nextTickAt: '2026-11-02T09:00:00Z' }), reading), { text: 'Auto-review · outside hours · next Mon 9:00 AM', tone: 'normal' })
  assert.deepEqual(indicator(view({ state: 'outsideHours', nextTickAt: '2026-10-30T19:30:00Z' }), reading), { text: 'Auto-review · outside hours · next 7:30 PM', tone: 'normal' })
  // a window that never opens has no next time to name
  assert.deepEqual(indicator(view({ state: 'outsideHours', nextTickAt: null }), reading), { text: 'Auto-review · outside hours', tone: 'normal' })
})

test('a tick that skipped says why, in amber, whether the reason persists or not', () => {
  const skipped = (skipReason: NonNullable<AutoReviewView['lastTick']>['skipReason']): AutoReviewView['lastTick'] => ({ at: '2026-10-30T14:30:00Z', state: 'skipped', skipReason, queued: null })
  assert.deepEqual(indicator(view({ state: 'blocked', lastTick: skipped('identityMismatch') }), reading), { text: 'Auto-review · skipped: gh login differs from viewer', tone: 'warn' })
  assert.deepEqual(indicator(view({ state: 'blocked', lastTick: skipped('noClone') }), reading), { text: 'Auto-review · skipped: no usable clone folder', tone: 'warn' })
  assert.deepEqual(indicator(view({ state: 'blocked', lastTick: skipped('dailyLimit') }), reading), { text: 'Auto-review · skipped: daily limit reached', tone: 'warn' })
  // a reason that does not persist leaves the state idle, and still shows until the next tick runs
  assert.deepEqual(indicator(view({ lastTick: skipped('fetchFailed') }), reading), { text: 'Auto-review · skipped: GitHub fetch failed · next 2:45 PM', tone: 'warn' })
  assert.deepEqual(indicator(view({ lastTick: skipped('interrupted') }), reading), { text: 'Auto-review · skipped: tick interrupted · next 2:45 PM', tone: 'warn' })
  // a tick that ran, or one still running, is not a skip
  assert.equal(indicator(view({ lastTick: { at: '2026-10-30T14:30:00Z', state: 'ran', skipReason: null, queued: 2 } }), reading)?.tone, 'normal')
  // off and outside hours say so whatever the last tick was
  assert.equal(indicator(view({ enabled: false, state: 'off', lastTick: skipped('identityMismatch') }), reading)?.text, 'Auto-review · off')
  assert.deepEqual(Object.keys(skipWords).sort(), ['dailyLimit', 'fetchFailed', 'identityMismatch', 'interrupted', 'noClone'])
})

const tick = (patch: Partial<Tick> = {}): Tick => ({
  id: 12, repo: 'octo-org/widgets', startedAt: '2026-10-30T14:30:00Z', finishedAt: '2026-10-30T14:30:05Z', state: 'ran', skipReason: null,
  cycle: 40, qualified: 5, alreadyCurrent: 3, queued: 2, ...patch,
})

const row = (number: number, state: 'idle' | 'queued' | 'running' | 'done', origin: 'auto' | 'manual' | null, patch: Record<string, unknown> = {}) => ({
  number, url: `https://github.com/octo-org/widgets/pull/${number}`, title: `Invented change ${number}`, agent: { state, origin, label: 'Review', ...patch },
})

test('the popover lists the last ten ticks with what each queued or why it skipped', () => {
  const ticks = Array.from({ length: 12 }, (_, index) => tick({ id: 30 - index, startedAt: `2026-10-30T${String(14 - Math.floor(index / 2)).padStart(2, '0')}:${index % 2 === 0 ? '30' : '00'}:00Z` }))
  const model = popoverModel(view(), ticks, [], [], reading)
  assert.equal(model.ticks.length, 10)
  assert.deepEqual(model.ticks[0], { id: 30, text: '2:30 PM · queued 2 · 5 qualified, 3 already current', tone: 'normal' })
  const mixed = popoverModel(view(), [
    tick({ id: 4, state: null, finishedAt: null, qualified: null, alreadyCurrent: null, queued: null }),
    tick({ id: 3, startedAt: '2026-10-30T13:45:00Z', state: 'skipped', skipReason: 'identityMismatch', qualified: null, alreadyCurrent: null, queued: null }),
    tick({ id: 2, startedAt: '2026-10-30T13:30:00Z', queued: 0, qualified: 2, alreadyCurrent: 2 }),
    tick({ id: 1, startedAt: '2026-10-29T18:00:00Z', queued: 1, qualified: null, alreadyCurrent: null }),
  ], [], [], reading)
  assert.deepEqual(mixed.ticks, [
    { id: 4, text: '2:30 PM · running', tone: 'normal' },
    { id: 3, text: '1:45 PM · skipped: gh login differs from viewer', tone: 'warn' },
    { id: 2, text: '1:30 PM · queued nothing · 2 qualified, 2 already current', tone: 'normal' },
    { id: 1, text: 'Thu 6:00 PM · queued 1', tone: 'normal' },
  ])
})

test('the popover links the PRs auto-review has running or queued, running first, and ignores every other row', () => {
  const rows = [
    row(105, 'queued', 'auto'), row(101, 'running', 'auto'), row(102, 'running', 'manual'), row(103, 'done', 'auto'), row(104, 'idle', null), row(100, 'running', 'auto'),
  ]
  const model = popoverModel(view({ state: 'running', running: 2, queued: 1 }), [], rows, [], reading)
  assert.deepEqual(model.runs, [
    { number: 100, state: 'running', title: 'Invented change 100', url: 'https://github.com/octo-org/widgets/pull/100', text: '#100 · running' },
    { number: 101, state: 'running', title: 'Invented change 101', url: 'https://github.com/octo-org/widgets/pull/101', text: '#101 · running' },
    { number: 105, state: 'queued', title: 'Invented change 105', url: 'https://github.com/octo-org/widgets/pull/105', text: '#105 · queued' },
  ])
  // a scheduled sweep that runs or waits is named, since it has no row of its own; a manual one and a finished one are not
  const sweeps = [
    { id: 9, origin: 'auto' as const, status: 'running' as const },
    { id: 8, origin: 'auto' as const, status: 'queued' as const },
    { id: 7, origin: 'manual' as const, status: 'running' as const },
    { id: 6, origin: 'auto' as const, status: 'done' as const },
  ]
  assert.deepEqual(popoverModel(view(), [], [], sweeps, reading).sweeps, ['Dependabot sweep · running', 'Dependabot sweep · queued'])
})

test('the popover names the worktrees left in place, those git no longer lists, and why scheduled sweeps have stopped', () => {
  const left = view({ worktrees: { kept: ['~/.local/state/pit-view/worktrees/run-12'], unlisted: ['run-9'] } })
  const model = popoverModel(left, [], [], [], reading)
  assert.deepEqual(model.worktrees, ['Left in place: ~/.local/state/pit-view/worktrees/run-12', 'Not listed by git: run-9'])
  assert.deepEqual(popoverModel(view(), [], [], [], reading).worktrees, [])
  assert.equal(popoverModel(view({ sweepHold: 'needsInput' }), [], [], [], reading).hold, 'Scheduled sweeps are paused: one is waiting for your answer.')
  assert.equal(popoverModel(view({ sweepHold: 'failedTwice' }), [], [], [], reading).hold, 'Scheduled sweeps are paused: two failed in a row.')
  assert.equal(popoverModel(view(), [], [], [], reading).hold, null)
})

test('Run now is offered only while auto-review is on, and its request carries the per-start token and no body', () => {
  assert.deepEqual(popoverModel(view(), [], [], [], reading).runNow, { disabled: false, reason: null })
  assert.deepEqual(popoverModel(view({ enabled: false, state: 'off' }), [], [], [], reading).runNow, { disabled: true, reason: 'Auto-review is off; turn it on in Settings.' })
  assert.deepEqual(runNowRequest('tok'), { url: '/api/auto-review/run', init: { method: 'POST', headers: { 'X-Pit-View-Token': 'tok' } } })
  assert.equal(runNowResult(200, { started: true, tick: 12 }, null), 'Checking for PRs to review (tick 12).')
  assert.equal(runNowResult(200, { started: false, tick: 11 }, null), 'A check is already running (tick 11).')
  assert.equal(runNowResult(409, null, 'auto-review is off; turn it on in Settings first'), 'Auto-review is off; turn it on in Settings first.')
  assert.equal(runNowResult(403, null, 'bad token'), 'Reload the page to run auto-review: Pit View has restarted since this page loaded.')
  assert.equal(runNowResult(0, null, null), 'Pit View did not answer. Check that it is running, then try again.')
})

test('the dashboard\'s header holds the auto-review button hidden by default, beside the sync status, and outside any live region', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8')
  const start = html.indexOf('<div id="auto-review"')
  assert.ok(start > html.indexOf('id="sync-live"'), 'after the sync status and its live region')
  const block = html.slice(start, html.indexOf('</div>\n', html.indexOf('id="auto-review-popover"')) + 6)
  assert.match(block, /^<div id="auto-review" class="auto-review" hidden>/)
  assert.match(block, /<button id="auto-review-button" type="button"[^>]*aria-expanded="false"/)
  assert.doesNotMatch(block, /aria-live|role="status"|role="alert"/)
  // the popover starts hidden and is a labeled dialog
  assert.match(block, /<div id="auto-review-popover"[^>]*role="dialog"[^>]*aria-label="Auto-review"[^>]*hidden>/)
})

test('after the popover is rebuilt, focus goes back to the control that had it, or to the header button when that control is gone or disabled', () => {
  // focus was outside the popover: nothing to restore
  assert.deepEqual(popoverFocus(null, ['auto-run-now', 'auto-settings']), { target: 'none' })
  // the same control is still there and enabled
  assert.deepEqual(popoverFocus('auto-run-now', ['auto-run-now', 'auto-settings']), { target: 'key', key: 'auto-run-now' })
  assert.deepEqual(popoverFocus('auto-settings', ['auto-settings']), { target: 'key', key: 'auto-settings' })
  // Run now is disabled while it starts, so it is not in the enabled list
  assert.deepEqual(popoverFocus('auto-run-now', ['auto-settings']), { target: 'toggle' })
  // focus was on something with no key, such as a PR link that the rebuild removed
  assert.deepEqual(popoverFocus('', ['auto-run-now']), { target: 'toggle' })
  assert.deepEqual(popoverFocus('auto-run-now', []), { target: 'toggle' })
  // a PR link keeps its place by its number, not its position in the list
  assert.equal(runLinkKey({ number: 412 }), 'auto-pr:412')
  assert.deepEqual(popoverFocus('auto-pr:412', ['auto-pr:97', 'auto-pr:412', 'auto-run-now']), { target: 'key', key: 'auto-pr:412' })
  assert.deepEqual(popoverFocus('auto-pr:412', ['auto-pr:97', 'auto-run-now']), { target: 'toggle' })
})

test('the popover remembers its focus before it rebuilds and restores it after, and its Settings link has a focus key', async () => {
  const source = await readFile(new URL('../public/autoreviewmenu.ts', import.meta.url), 'utf8')
  const draw = source.slice(source.indexOf('const draw = '), source.indexOf('const loadTicks'))
  const before = draw.indexOf('document.activeElement')
  const replace = draw.indexOf('popover.replaceChildren()')
  const after = draw.indexOf('popoverFocus(')
  assert.ok(before > -1 && before < replace, 'focus is read before the popover is cleared')
  assert.ok(after > draw.indexOf('append(popover'), 'focus is restored after the new content is in')
  assert.match(source, /'data-focus-key': 'auto-settings'/)
  assert.match(source, /'data-focus-key': runLinkKey\(run\)/)
  assert.match(draw, /button\.focus\(/)
})

test('DESIGN.md does not say the clone folder is missing from the Settings page, and says where it is edited', async () => {
  const design = await readFile(new URL('../DESIGN.md', import.meta.url), 'utf8')
  const row = design.split('\n').find((line) => line.startsWith('| `cloneDir` |')) ?? ''
  assert.notEqual(row, '')
  assert.doesNotMatch(row, /Not on the Settings page/)
  assert.doesNotMatch(row, /carries it over unchanged/)
  // the field moved to the Agent card (task 1110)
  assert.match(row, /Edited in the Agent card of the Settings page, after Concurrent reviews/)
  assert.doesNotMatch(row, /Auto-review section/)
  assert.match(row, /is checked at every start, not on save/)
})

test('the header says nothing about the daily limit while runs start under a limit of 0: the count of runs started today is never shown, and no tick skips for it', () => {
  // the view carries runs started today but not the limit, so the indicator and the popover read the same at any count
  assert.deepEqual(indicator(view({ startedToday: 500 }), reading), { text: 'Auto-review · next 2:45 PM', tone: 'normal' })
  assert.deepEqual(indicator(view({ startedToday: 0 }), reading), indicator(view({ startedToday: 500 }), reading))
  const model = popoverModel(view({ startedToday: 500 }), [], [], [], reading)
  assert.deepEqual(model.ticks, [])
  assert.equal(model.hold, null)
  // the one daily-limit wording stays for a limit that is set, and nothing else in the header names a limit
  assert.equal(skipWords.dailyLimit, 'daily limit reached')
})

test('after a dailyLimit skip whose limit no longer blocks, the header and the Now line read as for any idle scheduler while the popover still lists the recorded tick', () => {
  // the view the scheduler gives once a limit of 0 (or a raised limit) is saved: idle, with no last tick, though the skip is still the newest recorded row
  const unblocked = view({ startedToday: 10 })
  assert.deepEqual(indicator(unblocked, reading), { text: 'Auto-review · next 2:45 PM', tone: 'normal' })
  const saved = { dailyLimit: 0, post: { others: false, dependabot: false } } as Parameters<typeof nowLine>[0]['saved']
  const line = nowLine({ saved, view: unblocked, viewer: 'octocat', reading })
  assert.equal(line.text, 'On · next 2:45 PM')
  assert.equal(line.tone, 'normal')
  assert.equal(line.fix, null)
  assert.equal(line.meta.startsWith('10 runs started today · no daily limit · posting off'), true)
  const recorded = tick({ id: 7, state: 'skipped', skipReason: 'dailyLimit', qualified: 4, alreadyCurrent: 1, queued: 0 })
  assert.deepEqual(popoverModel(unblocked, [recorded], [], [], reading).ticks, [{ id: 7, text: '2:30 PM · skipped: daily limit reached', tone: 'warn' }])
  // the opposite: a limit that still blocks keeps the skip in the header and the explanation in the Now line
  const blocked = view({ state: 'blocked', startedToday: 10, nextTickAt: null, lastTick: { at: '2026-10-30T14:30:00Z', state: 'skipped', skipReason: 'dailyLimit', queued: 0 } })
  assert.deepEqual(indicator(blocked, reading), { text: 'Auto-review · skipped: daily limit reached', tone: 'warn' })
  const stuck = nowLine({ saved: { dailyLimit: 10, post: { others: false, dependabot: false } } as Parameters<typeof nowLine>[0]['saved'], view: blocked, viewer: 'octocat', reading })
  assert.equal(stuck.text, 'Skipped: daily limit reached')
  assert.equal(stuck.fix, 'Runs started today have reached the daily limit; it starts over tomorrow.')
})
