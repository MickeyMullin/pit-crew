// public/idle.ts
// whether this page's user has gone quiet: after idleMinutes with no activity the page counts as
// idle, which the server treats like paused; any activity ends it at once; time is injected, so
// the logic runs under Node with fake timers
import type { Timers } from '../src/poller.ts'

const minute = 60_000

// how long until a page last used at lastMs goes idle (0 when it already has), or null when
// minutes is 0 and it never does
export const idleDueIn = (lastMs: number, nowMs: number, minutes: number): number | null =>
  minutes <= 0 ? null : Math.max(0, lastMs + minutes * minute - nowMs)

export type IdleOptions = {
  minutes: number
  now: () => number
  timers: Timers
  // once per change, entering idle or leaving it
  onChange: (idle: boolean) => void
}

export type IdleTracker = {
  // any user activity; cheap enough for every pointer move, and calls onChange only when it ends idle
  activity: () => void
  // a new idleMinutes from Settings; 0 ends idle and stops the timer
  setMinutes: (minutes: number) => void
  idle: () => boolean
  stop: () => void
}

// one timer at a time, aimed at the moment the page would go idle; activity only moves the last
// activity time, and the timer re-aims when it fires early, so a burst of moves sets no timers
export const createIdleTracker = (options: IdleOptions): IdleTracker => {
  const { now, timers, onChange } = options
  let minutes = options.minutes
  let last = now()
  let idle = false
  let timer: unknown = null

  const disarm = (): void => {
    if (timer !== null) timers.clear(timer)
    timer = null
  }

  const set = (next: boolean): void => {
    if (idle === next) return
    idle = next
    onChange(next)
  }

  const check = (): void => {
    timer = null
    const due = idleDueIn(last, now(), minutes)
    if (due === null) return
    if (due > 0) {
      timer = timers.set(check, due)
      return
    }
    set(true)
  }

  const arm = (): void => {
    disarm()
    const due = idleDueIn(last, now(), minutes)
    if (due !== null && !idle) timer = timers.set(check, due)
  }

  const activity = (): void => {
    last = now()
    if (!idle) return
    set(false)
    arm()
  }

  const setMinutes = (next: number): void => {
    minutes = next
    if (next <= 0) set(false)
    arm()
  }

  arm()
  return { activity, setMinutes, idle: () => idle, stop: disarm }
}
