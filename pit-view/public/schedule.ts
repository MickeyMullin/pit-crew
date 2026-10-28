// public/schedule.ts
// the refresh schedule across reloads: the start of the last cycle this browser saw, kept in
// localStorage and sent when the page opens its event stream, so a reload within refreshSeconds
// keeps the server's interval instead of refreshing on arrival (keepsSchedule in src/clients.ts)
import type { Sync } from '../src/poller.ts'

export const lastUpdateKey = 'pit-view.lastUpdate'

export type ScheduleStorage = Pick<Storage, 'getItem' | 'setItem'>

// what the server's schedule counts from: the start of the latest cycle of any trigger
export const lastUpdateOf = (sync: Pick<Sync, 'cycle'>): string | null => sync.cycle?.startedAt ?? null

// storage is passed as a getter, since even reading window.localStorage can throw when blocked;
// anything but a time reads as none
export const readLastUpdate = (storage: () => ScheduleStorage): string | null => {
  try {
    const value = storage().getItem(lastUpdateKey)
    return value !== null && Number.isFinite(Date.parse(value)) ? value : null
  } catch {
    return null
  }
}

// false when storage refused, which leaves the next load refreshing on arrival as before
export const writeLastUpdate = (storage: () => ScheduleStorage, at: string): boolean => {
  try {
    storage().setItem(lastUpdateKey, at)
    return true
  } catch {
    return false
  }
}
