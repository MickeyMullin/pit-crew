// public/reportpanel.ts
// the report side panel: one report fetched from the server, shown Rendered (the server's
// sanitized HTML in a sandboxed iframe whose document reportview.ts builds) or Raw (the Markdown
// as text in a <pre>). It sits to the left of the drawer at desktop widths and over it at phone
// width (styles.css); Escape and the focus return are handled by the page and the drawer
import { formatSince } from './format.ts'
import { h, setText, svg } from './dom.ts'
import { getJson } from './runapi.ts'
import { modeButtons, reportDocument, reportError, reportSandbox, reportSub, themeSources } from './reportview.ts'
import type { ReportMode, ReportTheme } from './reportview.ts'

export type ReportData = { name: string, modifiedAt: string, html: string, raw: string }

type Load = { state: 'idle' } | { state: 'loading' } | { state: 'error', message: string } | { state: 'ready', report: ReportData }

export type ReportPanelOptions = {
  root: HTMLElement
  nowMs: () => number
  // the panel closed: put focus back on the control that opened it
  onClosed: (returnKey: string | null) => void
  // the page's polite live region
  say: (text: string) => void
}

export type ReportPanel = {
  open: (name: string, returnKey: string | null) => void
  close: () => void
  isOpen: () => boolean
  // ages move with the clock
  refresh: () => void
}

// the page's own tokens as colors and fonts the iframe's document can use. A color token is a
// light-dark() pair, which only resolves on an element, so each is read from a probe that uses it
export const readTheme = (doc: Document): ReportTheme => {
  const root = doc.documentElement
  const probe = h('span', { class: 'theme-probe', 'aria-hidden': 'true' })
  doc.body.appendChild(probe)
  const rootStyle = getComputedStyle(root)
  const read = (token: string, kind: 'color' | 'text'): string => {
    if (kind === 'text') return rootStyle.getPropertyValue(`--${token}`).trim()
    probe.style.color = `var(--${token})`
    return getComputedStyle(probe).color
  }
  const theme: Record<string, string> = { colorScheme: rootStyle.colorScheme }
  for (const [key, source] of Object.entries(themeSources)) theme[key] = read(source.token, source.kind)
  probe.remove()
  return theme as ReportTheme
}

export const createReportPanel = (options: ReportPanelOptions): ReportPanel => {
  const { root } = options
  // kept in memory only: a reload starts on Rendered
  let mode: ReportMode = 'rendered'
  let name: string | null = null
  let returnKey: string | null = null
  let load: Load = { state: 'idle' }
  let request = 0

  const heading = h('h2', { id: 'report-heading', class: 'report-heading mono', tabindex: '-1' })
  const sub = h('span', { class: 'report-sub' })
  const close = h('button', { type: 'button', class: 'icon-button report-close', 'aria-label': 'Close report', title: 'Close report' },
    svg([['path', { d: 'M6 6l12 12' }], ['path', { d: 'M18 6L6 18' }]], { size: 14, stroke: '2.4' }))
  const segmented = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Report view' })
  const body = h('div', { class: 'report-body' })
  // the next stop after the rendered report: keys pressed inside a sandboxed iframe never reach this
  // page, so Tab out of it lands on a Close that Escape and Enter work on
  const foot = h('div', { class: 'report-foot' },
    h('span', { class: 'report-hint' }, 'Esc closes this panel'),
    h('button', { type: 'button', class: 'button button-small report-close-foot' }, 'Close'))
  root.replaceChildren(
    h('div', { class: 'report-head' },
      h('div', { class: 'report-titles' }, heading, sub),
      close),
    h('div', { class: 'report-bar' }, segmented),
    body,
    foot)

  const paintModes = (): void => {
    segmented.replaceChildren(...modeButtons(mode).map((button) => {
      const element = h('button', { type: 'button', class: 'segment', 'aria-pressed': String(button.pressed), 'data-focus-key': `report-mode:${button.key}` }, button.label)
      element.addEventListener('click', () => {
        if (mode === button.key) return
        mode = button.key
        paintModes()
        paintBody()
        document.querySelector<HTMLElement>(`[data-focus-key="report-mode:${button.key}"]`)?.focus({ preventScroll: true })
      })
      return element
    }))
  }

  const documentFor = (report: ReportData): string => reportDocument(report.html, readTheme(document))

  const paintBody = (): void => {
    if (name === null) {
      body.replaceChildren()
      return
    }
    if (load.state === 'loading') {
      body.replaceChildren(h('p', { class: 'report-state', role: 'status' }, `Loading ${name}…`))
      return
    }
    if (load.state === 'error') {
      const retry = h('button', { type: 'button', class: 'button button-small' }, 'Try again')
      const wanted = name
      retry.addEventListener('click', () => open(wanted, returnKey))
      body.replaceChildren(h('div', { class: 'report-state' }, h('p', { class: 'report-error', role: 'alert' }, load.message), retry))
      return
    }
    if (load.state !== 'ready') return
    const report = load.report
    if (mode === 'raw') {
      const pre = h('pre', { class: 'report-raw mono', tabindex: '0', 'aria-label': `${report.name}, raw Markdown` })
      pre.textContent = report.raw
      body.replaceChildren(pre)
      return
    }
    // no scripts and no same-origin access: only popups, so a link opens in a new tab
    body.replaceChildren(h('iframe', {
      class: 'report-frame',
      sandbox: reportSandbox,
      title: `${report.name}, rendered`,
      referrerpolicy: 'no-referrer',
      srcdoc: documentFor(report),
    }))
  }

  const age = (iso: string): string => formatSince(iso, options.nowMs())

  const paintHead = (): void => {
    setText(heading, name ?? '')
    setText(sub, load.state === 'ready' ? reportSub(load.report.modifiedAt, age) : '')
  }

  const open = (wanted: string, back: string | null): void => {
    request += 1
    const mine = request
    const wasOpen = !root.hidden
    name = wanted
    returnKey = back
    load = { state: 'loading' }
    root.hidden = false
    root.dataset.open = 'true'
    paintModes()
    paintHead()
    paintBody()
    // opened by the owner's click: focus goes to the heading, and a second report replacing the
    // first is said, since nothing else about the panel changes
    heading.focus({ preventScroll: true })
    if (wasOpen) options.say(`${wanted} opened in the report panel`)
    void getJson<{ name: string, modifiedAt: string, html: string, raw: string }>(`/api/reports/${encodeURIComponent(wanted)}`).then((answer) => {
      if (mine !== request || name === null) return
      load = answer.ok && answer.value !== null
        ? { state: 'ready', report: answer.value }
        : { state: 'error', message: reportError(wanted, answer.status, answer.ok ? null : answer.error) }
      paintHead()
      paintBody()
    })
  }

  const shut = (): void => {
    if (root.hidden) return
    request += 1
    const back = returnKey
    name = null
    returnKey = null
    load = { state: 'idle' }
    root.hidden = true
    delete root.dataset.open
    body.replaceChildren()
    options.onClosed(back)
  }

  close.addEventListener('click', shut)
  foot.querySelector('button')?.addEventListener('click', shut)
  // Escape on anything in the panel closes it, and only it: the drawer behind stays open
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    shut()
  })

  // the iframe's document holds the colors it was built with, so a change of theme rebuilds it:
  // the header's toggle changes the root's color-scheme, and System follows the operating system
  // only when what the document would hold has changed: reloading it resets the reader's scroll
  const rebuild = (): void => {
    if (root.hidden || load.state !== 'ready' || mode !== 'rendered') return
    const frame = body.querySelector('iframe')
    if (frame === null) return
    const next = documentFor(load.report)
    if (frame.getAttribute('srcdoc') !== next) frame.setAttribute('srcdoc', next)
  }
  // data-theme is what the header's toggle sets (theme.ts), and also what another tab's choice sets
  new MutationObserver(rebuild).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rebuild)
  } catch {
    // without matchMedia the toggle still rebuilds it
  }

  return {
    open,
    close: shut,
    isOpen: () => !root.hidden,
    refresh: () => {
      if (!root.hidden && load.state === 'ready') setText(sub, reportSub(load.report.modifiedAt, age))
    },
  }
}
