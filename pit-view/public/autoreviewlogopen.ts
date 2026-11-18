// public/autoreviewlogopen.ts
// what a run link in the auto-review log opens (section 10 of DESIGN.md, The log): a sweep opens the sweep drawer at that sweep, and a run opens the Agent drawer of its PR on that run, whether or not the PR has newer runs and whether or not it is still open. Focus goes back to the header's Auto-review button when the drawer closes
import type { LogRunLink } from './autoreviewlogview.ts'
import type { Drawer } from './drawer.ts'
import type { SweepDrawer } from './sweepdrawer.ts'

export const openLoggedRun = ({ drawer, sweepDrawer, seedRuns }: { drawer: Pick<Drawer, 'open'>, sweepDrawer: Pick<SweepDrawer, 'open'>, seedRuns: () => void }): (link: LogRunLink) => void => (link) => {
  seedRuns()
  if (link.kind === 'sweep') sweepDrawer.open({ key: 'auto-review-button' }, { sweepId: link.id })
  else if (link.number !== null) drawer.open(link.number, { key: 'auto-review-button', number: link.number }, undefined, { runId: link.id, title: link.title })
}
