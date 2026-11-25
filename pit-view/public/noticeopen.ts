// public/noticeopen.ts
// what a notification opens (section 6 of DESIGN.md, Notifications area): the Agent drawer on its run, or on its PR, with focus to come back to the header's bell. False while a drawer's request is on its way, which keeps that drawer as it is
import type { Drawer } from './drawer.ts'
import type { NoticeTarget } from './noticesview.ts'
import type { SweepDrawer } from './sweepdrawer.ts'

export type OpenNoticeOptions = {
  drawer: Pick<Drawer, 'open' | 'busy'>
  sweepDrawer: Pick<SweepDrawer, 'close' | 'busy'>
  logPanel: { close: () => void }
  // notes the runs the page already shows, so opening the drawer announces none of them
  seedRuns: () => void
}

export const openNotice = ({ drawer, sweepDrawer, logPanel, seedRuns }: OpenNoticeOptions): (target: NoticeTarget) => boolean => (target) => {
  // its control is a link, which goes to GitHub itself
  if (target.kind === 'github') return true
  if (drawer.busy() || sweepDrawer.busy()) return false
  seedRuns()
  // the PR drawer, the sweep drawer, and the log never show together
  sweepDrawer.close()
  logPanel.close()
  const opener = { key: 'notifications-button', number: target.number }
  if (target.kind === 'run') drawer.open(target.number, opener, undefined, { runId: target.runId, title: target.title })
  else drawer.open(target.number, opener)
  return true
}
