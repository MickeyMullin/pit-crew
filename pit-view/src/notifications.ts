// src/notifications.ts
// the stored notifications (section 9 of DESIGN.md, Notifications): every event that reaches the notifier, kept in a table of its own in the cache file for the days below, whether or not a banner or a toast shows it. Which browser has read or cleared one is that browser's own and never written here
import type { DatabaseSync } from 'node:sqlite'
import { autoReviewLogDays } from './autoreviewlog.ts'
import type { Run } from './cache.ts'
import type { Clock } from './config.ts'
import { doneText, noteKind } from './launcher.ts'
import { cleanText, headlineOf } from './notify.ts'
import type { NotificationKind, NotifyEvent } from './notify.ts'
import { iso } from './time.ts'

// how many days a notification is kept: the auto-review log's own number, so the two stay the same
export const notificationDays = autoReviewLogDays

export type StoredNotification = {
  id: number
  at: string
  kind: NotificationKind
  // the kind in the owner's words, so the page needs no list of its own
  label: string
  repo: string
  number: number
  // the PR's title as the cache had it; null for a run whose PR had left the open rows
  title: string | null
  // the run a run's notification opens, null for a change of a PR's row
  run: number | null
  // what else it says: a run's outcome, and why when it failed or asks
  detail: string | null
}

// one as it is pushed to open pages, with whether its kind toasts under the config in effect as it was sent
export type PushedNotification = StoredNotification & { toast: boolean }

// what a settled run's notification says of it: the run, its outcome in the Agent cell's words, and the question, the failed post's error, or the failure's own text
export const runDetail = (run: Pick<Run, 'label' | 'status' | 'result' | 'note' | 'reason' | 'origin' | 'resolvedByHand'>): string => {
  const words = `${run.label} · ${doneText(run, run.reason === 'selfReview')}`
  const result = run.result
  let why: string | null = null
  if (run.status === 'needsInput') why = result?.question ?? null
  else if (run.status === 'failed') why = noteKind(run.note) === null ? run.note : run.note?.replace(/^\w+: /, '') ?? null
  else if (result?.schema === 'pit-crew/review-result@1' && result.notPostedReason === 'ghFailed') why = result.error
  return cleanText(why === null || why === '' ? words : `${words}: ${why}`)
}

export type NotificationStore = {
  // stores one event now, and drops what is past its days
  record: (event: NotifyEvent) => StoredNotification
  // a repository's notifications within the days kept, newest first
  list: (repo: string) => StoredNotification[]
  // the highest id ever given, 0 when none was: a browser whose markers are past it holds those of a cache file that is gone
  lastId: () => number
  // drops those older than the days kept; answers how many went
  prune: () => number
}

type Row = Record<string, unknown>

const text = (row: Row, key: string): string | null => typeof row[key] === 'string' ? row[key] : null

const toStored = (row: Row): StoredNotification => {
  const kind = String(row.kind) as NotificationKind
  return {
    id: Number(row.id),
    at: String(row.created_at),
    kind,
    label: headlineOf(kind),
    repo: String(row.repo),
    number: Number(row.number),
    title: text(row, 'title'),
    run: row.run === null ? null : Number(row.run),
    detail: text(row, 'detail'),
  }
}

const dayMs = 24 * 60 * 60_000

// the table is the cache's own (src/cache.ts, version 23); this reads and writes it through the cache's handle. Opening it prunes, and so does every record, so it needs no timer
export const openNotifications = ({ db, clock }: { db: DatabaseSync, clock: Clock }): NotificationStore => {
  // times are compared as numbers: iso() leaves the milliseconds off a whole second, so as text a whole second sorts after its own fractions
  const since = (): number => clock.now() - notificationDays * dayMs

  const prune = (): number => {
    const old = (db.prepare('SELECT id, created_at FROM notifications').all() as Row[]).filter((row) => Date.parse(String(row.created_at)) < since())
    const drop = db.prepare('DELETE FROM notifications WHERE id = $id')
    for (const row of old) drop.run({ id: Number(row.id) })
    return old.length
  }

  const record = (event: NotifyEvent): StoredNotification => {
    prune()
    const { kind, repo, number, title, run, detail } = event
    const id = Number(db.prepare('INSERT INTO notifications (created_at, kind, repo, number, title, run, detail) VALUES ($at, $kind, $repo, $number, $title, $run, $detail)')
      .run({ at: iso(clock.now()), kind, repo, number, title, run, detail }).lastInsertRowid)
    return toStored(db.prepare('SELECT * FROM notifications WHERE id = $id').get({ id }) as Row)
  }

  const list = (repo: string): StoredNotification[] =>
    (db.prepare('SELECT * FROM notifications WHERE repo = $repo ORDER BY id DESC').all({ repo }) as Row[]).map(toStored).filter((found) => Date.parse(found.at) >= since())

  const lastId = (): number => Number((db.prepare('SELECT seq FROM sqlite_sequence WHERE name = \'notifications\'').get() as Row | undefined)?.seq ?? 0)

  prune()
  return { record, list, lastId, prune }
}
