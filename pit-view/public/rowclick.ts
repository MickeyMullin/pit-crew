// public/rowclick.ts
// a click on a PR's row opens its drawer, a Closed row's read-only (section 6 of DESIGN.md, Columns, Row click), and so do Enter and Space on a focused Closed row, which has no Agent button. The links and controls in a row keep their own clicks, and a drag that selects text in the row opens nothing. One listener on the document serves every row, so a redraw never loses it
import type { Drawer } from './drawer.ts'
import { plainRowOf } from './drawerview.ts'
import type { SweepDrawer } from './sweepdrawer.ts'

export type RowClickOptions = {
  drawer: Pick<Drawer, 'open' | 'number' | 'form' | 'busy'>
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
    const shut = row.dataset.table === 'closed'
    // the drawer that shows this PR stays as it is, unless it is on a PR that closed under it and the click is on that PR's Closed row; and one whose request is on its way keeps its place, as it does against a press outside
    if ((drawer.number() === number && !(shut && drawer.form() === 'gone')) || drawer.busy() || sweepDrawer.busy()) return
    seedRuns()
    // the PR drawer and the sweep drawer never show together, nor either with the log
    sweepDrawer.close()
    logPanel.close()
    drawer.open(number, { key: shut ? `closed-row:${number}` : `agent-open:${number}`, number })
  }

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || (event.button ?? 0) !== 0) return
    const row = event.target instanceof Element ? plainRowOf<HTMLElement>(event.target) : null
    if (row !== null && !selectsTextIn(row)) openRow(row)
  })

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || (event.key !== 'Enter' && event.key !== ' ') || event.ctrlKey || event.metaKey || event.altKey) return
    const row = event.target instanceof Element ? plainRowOf<HTMLElement>(event.target) : null
    // only the row itself: a key on a link in it is the link's
    if (row === null || row !== event.target || row.dataset.table !== 'closed') return
    // Space would scroll the page
    event.preventDefault()
    openRow(row)
  })
}
