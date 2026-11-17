// public/copyreport.ts
// the Copy report button: a two-square icon that puts one report's raw Markdown on the clipboard.
// It reads the report from the route Open uses (GET /api/reports/<name>, read-only, the same read the post path makes) and copies its `raw` field untouched, through the drawer's one clipboard helper (copyText). An unreadable or refused report copies nothing and says why. Where the surface holds what it showed (a row's modifiedAt, the panel's loaded text), a fresh read that differs copies nothing and says the report changed; the result card holds only a name, so it copies the report as it is on disk at the click
import { copyText } from './agentcell.ts'
import { h, svg } from './dom.ts'
import { getJson } from './runapi.ts'
import { reportError } from './reportview.ts'

const squares = (): SVGSVGElement => svg([
  ['rect', { x: '3', y: '3', width: '13', height: '13', rx: '2' }],
  ['rect', { x: '9', y: '9', width: '12', height: '12', rx: '2' }],
], { size: 14 })

const check = (): SVGSVGElement => svg([['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]], { size: 14, stroke: '2.4' })

// the button's name, its tooltip, and what it says is fixed; `key` is the focus key the drawer's redraws restore focus by
// what a surface showed of the report: a listing row's modifiedAt, or the panel's loaded text; a field left out is not compared
export type Shown = { modifiedAt?: string, raw?: string }

export const copyReportButton = (name: string, key: string, say: (text: string) => void, shown: () => Shown | null = () => null): HTMLButtonElement => {
  const button = h('button', { type: 'button', class: 'button button-small copy-report', 'aria-label': 'Copy report', title: 'Copy report', 'data-focus-key': key }, squares())
  let busy = false
  // one revert timer per button: a later success restarts it
  let revert: ReturnType<typeof setTimeout> | undefined
  button.addEventListener('click', () => {
    if (busy) return
    busy = true
    void (async () => {
      try {
        const answer = await getJson<{ raw: string, modifiedAt?: string }>(`/api/reports/${encodeURIComponent(name)}`)
        if (!answer.ok || answer.value === null || typeof answer.value.raw !== 'string') {
          say(`Could not copy: ${reportError(name, answer.status, answer.ok ? null : answer.error)}`)
          return
        }
        const seen = shown()
        if (seen !== null && ((seen.modifiedAt !== undefined && answer.value.modifiedAt !== seen.modifiedAt) || (seen.raw !== undefined && answer.value.raw !== seen.raw))) {
          say(`Could not copy ${name}: it changed since it was shown. Open it again to see the current text.`)
          return
        }
        if (!await copyText(answer.value.raw)) {
          say(`Could not copy ${name}: the browser refused the clipboard.`)
          return
        }
        say('Report copied')
        button.setAttribute('data-copied', 'true')
        button.replaceChildren(check())
        clearTimeout(revert)
        revert = setTimeout(() => {
          button.removeAttribute('data-copied')
          if (button.isConnected) button.replaceChildren(squares())
        }, 2_000)
      } finally {
        busy = false
      }
    })()
  })
  return button
}
