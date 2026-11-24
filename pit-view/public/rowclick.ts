// public/rowclick.ts
// a click on a PR's row opens its drawer (section 6 of DESIGN.md, Columns, Opening). The links and controls in a row keep their own clicks, and a drag that selects text in the row opens nothing. One listener on the document serves every row, so a redraw never loses it
import type { Drawer } from './drawer.ts'
import { plainRowOf } from './drawerview.ts'
import type { SweepDrawer } from './sweepdrawer.ts'

export type RowClickOptions = {
  drawer: Pick<Drawer, 'open' | 'number' | 'busy'>
  sweepDrawer: Pick<SweepDrawer, 'close' | 'busy'>
  logPanel: { close: () => void }
  // notes the runs the page already shows, so opening the drawer announces none of them
  seedRuns: () => void
}

const selectsTextIn = (row: Node): boolean => {
  const selection = document.getSelection()
  return selection !== null && !selection.isCollapsed && selection.containsNode(row, true)
}

export const mountRowClicks = ({ drawer, sweepDrawer, logPanel, seedRuns }: RowClickOptions): void => {
  const openRow = (row: HTMLElement): void => {
    const number = Number(row.dataset.pr)
    // the drawer that shows this PR stays as it is, and one whose request is on its way keeps its place, as it does against a press outside
    if (drawer.number() === number || drawer.busy() || sweepDrawer.busy()) return
    seedRuns()
    // the PR drawer and the sweep drawer never show together, nor either with the log
    sweepDrawer.close()
    logPanel.close()
    drawer.open(number, { key: `agent-open:${number}`, number })
  }

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || (event.button ?? 0) !== 0) return
    const row = event.target instanceof Element ? plainRowOf<HTMLElement>(event.target) : null
    if (row !== null && row.dataset.table !== 'closed' && !selectsTextIn(row)) openRow(row)
  })
}
