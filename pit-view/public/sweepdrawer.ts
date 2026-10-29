// public/sweepdrawer.ts
// the Dependabot sweep drawer: a non-modal panel on the right for the repository's sweeps, not for one PR. It starts a sweep behind an inline confirmation, shows the running, waiting, and finished card of the sweep it is on (the whole sweep-result@1: counts, one card per PR, the merge order, and the summary's path), and lists the earlier sweeps. It reads the sweeps from the page's feed on every draw, so a patch updates it in place. sweepview.ts says what every part reads; this file makes the elements, keeps the confirmation's state, and moves focus
import { copyText, tickTimers, timerLine } from './agentcell.ts'
import { h, newTab, setText, svg, sync } from './dom.ts'
import type { Keyed, Part } from './dom.ts'
import { focusKeySelector, mayMoveFocus, escapeTarget } from './drawerview.ts'
import { formatSince } from './format.ts'
import type { ReportPanel } from './reportpanel.ts'
import { sendRun } from './runapi.ts'
import { safeHref } from './safeurl.ts'
import {
  defaultSweepRunner, shownSweep, sweepCards, sweepConfirmModel, sweepConfirmSignature, sweepList, sweepRefusal, sweepResultModel, sweepRunningModel, sweepStartRequest,
  sweepStopModel, sweepStopRefusal, sweepStopRequest, sweepWaitingModel,
} from './sweepview.ts'
import type { SweepRowModel, SweepsView, SweepView, Tone } from './sweepview.ts'
import type { RunnerName } from './agent.ts'

export type SweepOpener = { key: string }

// what the drawer is asking about: a start waiting for its Start, or a stop waiting for its Stop
type Confirm = { type: 'start', runner: RunnerName } | { type: 'stop', id: number }

export type SweepDrawerOptions = {
  root: HTMLElement
  token: string
  nowMs: () => number
  // the sweeps the page's view carries; null before the first view
  sweeps: () => SweepsView | null
  say: (text: string) => void
  reports: ReportPanel
}

export type SweepDrawer = {
  // sweepId picks the sweep to show (the newest by default), pr scrolls to and marks that PR's card, and ask opens the start's confirmation at once
  open: (opener: SweepOpener | null, show?: { sweepId?: number, pr?: number, ask?: boolean }) => void
  close: () => void
  update: () => void
  isOpen: () => boolean
  escape: () => boolean
  focusKey: (key: string | null, force?: boolean) => void
}

const ageSpan = (iso: string, prefix: string, nowMs: number): HTMLSpanElement =>
  h('span', { class: 'drawer-age', 'data-age': iso, 'data-age-prefix': prefix }, `${prefix}${formatSince(iso, nowMs)}`)

const tag = (text: string, tone: Tone): HTMLSpanElement => h('span', { class: `chip chip-small tone-${tone}` }, text)

const section = (id: string, title: string, ...children: (Node | string | null | false)[]): HTMLElement =>
  h('section', { class: 'drawer-section', 'aria-labelledby': `sweep-${id}` },
    h('h3', { id: `sweep-${id}`, class: 'drawer-section-title' }, title),
    ...children)

const facts = (rows: [string, Node | string][]): HTMLDListElement =>
  h('dl', { class: 'confirm-facts' }, rows.flatMap(([term, value]) => [h('dt', {}, term), h('dd', {}, value)]))

// the bot group's status ages move with the clock and are set in place after each draw
export const updateSweepAges = (root: ParentNode, nowMs: number): void => {
  for (const element of root.querySelectorAll<HTMLElement>('[data-sweep-age]')) {
    setText(element, ` · ${formatSince(element.dataset.sweepAge ?? '', nowMs)}`)
  }
}

export const createSweepDrawer = (options: SweepDrawerOptions): SweepDrawer => {
  const { root } = options

  let isOpen = false
  let opener: SweepOpener | null = null
  // the sweep shown: null follows the newest
  let shownId: number | null = null
  // the PR whose card is marked, and whether it is still to be scrolled to
  let marked: number | null = null
  let scrollPending = false
  let confirm: Confirm | null = null
  let confirmFrom: string | null = null
  // the repository and viewer the start confirmation on screen names, which the start request carries
  let confirmedRepo: string | null = null
  let confirmedViewer: string | null = null
  let busy = false
  let error = ''
  // a stop was accepted and the sweep has not settled yet
  let stopping: number | null = null
  let seenStatus = ''

  const heading = h('h2', { id: 'sweep-drawer-heading', class: 'drawer-heading', tabindex: '-1' }, 'Dependabot sweep')
  const subLine = h('p', { class: 'drawer-pr-sub' })
  const closeButton = h('button', { type: 'button', class: 'icon-button drawer-close', 'aria-label': 'Close sweep drawer', title: 'Close sweep drawer' },
    svg([['path', { d: 'M6 6l12 12' }], ['path', { d: 'M18 6L6 18' }]], { size: 14, stroke: '2.4' }))
  const body = h('div', { class: 'drawer-body' })
  root.replaceChildren(h('div', { class: 'drawer-head' }, h('div', { class: 'drawer-titles' }, heading, subLine), closeButton), body)

  const byKey = (key: string): HTMLElement | null => root.querySelector<HTMLElement>(focusKeySelector(key))

  const focusIsFree = (): boolean => {
    const active = document.activeElement
    return mayMoveFocus({ insideDrawer: active !== null && root.contains(active), onBody: active === null || active === document.body })
  }

  const focusKey = (key: string | null, force = false): void => {
    if (!force && !focusIsFree()) return
    const target = key === null ? null : document.querySelector<HTMLElement>(focusKeySelector(key))
    ;(target ?? heading).focus({ preventScroll: true })
  }

  const sweeps = (): SweepsView | null => options.sweeps()
  const shown = (): SweepView | null => {
    const view = sweeps()
    return view === null ? null : shownSweep(view.items, shownId)
  }

  // ---- the confirmation ----

  const errorLine = (): HTMLParagraphElement => h('p', { id: 'sweep-error', class: 'confirm-error', role: 'alert' })

  const confirmActions = (goText: string, tone: 'primary' | 'danger', onGo: () => void): HTMLDivElement => {
    const cancel = h('button', { type: 'button', class: 'button', 'data-focus-key': 'confirm-cancel' }, 'Cancel')
    const go = h('button', { type: 'button', class: `button button-${tone}`, 'data-focus-key': 'confirm-go', 'aria-describedby': 'sweep-error' }, goText)
    cancel.addEventListener('click', () => {
      if (!busy) cancelConfirm()
    })
    go.addEventListener('click', () => {
      if (!busy) onGo()
    })
    return h('div', { class: 'confirm-actions' }, cancel, go)
  }

  const startConfirmBlock = (view: SweepsView, asked: Extract<Confirm, { type: 'start' }>): HTMLElement => {
    const model = sweepConfirmModel(view.start, asked.runner)
    confirmedRepo = model.repo
    confirmedViewer = model.viewer
    const runner: Node | string = model.runners.length === 1
      ? model.runnerLabel
      : h('span', { class: 'confirm-runners', role: 'radiogroup', 'aria-labelledby': 'sweep-runner-term' },
        model.runners.map((choice) => {
          const input = h('input', { type: 'radio', name: 'sweep-runner', value: choice.name, checked: choice.name === model.runner })
          input.addEventListener('change', () => {
            if (!input.checked || confirm?.type !== 'start') return
            confirm = { type: 'start', runner: choice.name }
            paintConfirm()
          })
          return h('label', { class: 'confirm-runner' }, input, choice.label)
        }))
    const list = facts([
      ['Repository', model.repo],
      ['Command', h('code', { class: 'confirm-command mono', 'data-confirm': 'command' }, model.command)],
      ['Runner', runner],
      ['Runs', model.serial],
      ['On GitHub', model.effect],
    ])
    list.querySelector('dt:nth-of-type(3)')?.setAttribute('id', 'sweep-runner-term')
    return h('div', { class: 'confirm', role: 'group', 'aria-labelledby': 'sweep-confirm-heading' },
      h('h4', { id: 'sweep-confirm-heading', class: 'confirm-heading' }, model.heading),
      list,
      errorLine(),
      confirmActions(model.confirm, 'primary', () => void doStart()))
  }

  const stopConfirmBlock = (sweep: SweepView): HTMLElement => {
    const stop = sweepStopModel(sweep)
    return h('div', { class: 'confirm', role: 'group', 'aria-labelledby': 'sweep-confirm-heading' },
      h('h4', { id: 'sweep-confirm-heading', class: 'confirm-heading' }, stop.heading),
      facts([['Sweep', h('span', {}, `${stop.detail}, `, timerLine(sweep, options.nowMs()))], ['Stopping', stop.effect]]),
      errorLine(),
      confirmActions(stop.confirm, 'danger', () => void doStop()))
  }

  // the parts that change without a rebuild: the command for the chosen runner, the error line, and the buttons while a request is on its way
  const paintConfirm = (): void => {
    const view = sweeps()
    const command = root.querySelector<HTMLElement>('[data-confirm="command"]')
    if (command !== null && view !== null && confirm?.type === 'start') setText(command, sweepConfirmModel(view.start, confirm.runner).command)
    for (const input of root.querySelectorAll<HTMLInputElement>('input[name="sweep-runner"]')) {
      const wanted = confirm?.type === 'start' && confirm.runner === input.value
      if (input.checked !== wanted) input.checked = wanted
    }
    const line = root.querySelector<HTMLElement>('#sweep-error')
    if (line !== null) setText(line, error)
    const cancel = byKey('confirm-cancel') as HTMLButtonElement | null
    const go = byKey('confirm-go') as HTMLButtonElement | null
    if (cancel !== null) cancel.disabled = busy
    if (go !== null) {
      go.disabled = busy
      const stop = confirm?.type === 'stop'
      const idle = stop ? 'Stop sweep' : 'Start sweep'
      const working = stop ? 'Stopping…' : 'Starting sweep…'
      setText(go, busy ? working : idle)
    }
  }

  const askStart = (): void => {
    const view = sweeps()
    if (view === null || view.start.unavailable !== null) return
    confirm = { type: 'start', runner: defaultSweepRunner(view.start, view.start.runner) }
    confirmFrom = 'sweep-run'
    error = ''
    render()
    byKey('confirm-cancel')?.focus({ preventScroll: true })
  }

  const askStop = (id: number): void => {
    confirm = { type: 'stop', id }
    confirmFrom = 'sweep-stop'
    error = ''
    render()
    byKey('confirm-cancel')?.focus({ preventScroll: true })
  }

  const cancelConfirm = (): void => {
    const back = confirmFrom
    confirm = null
    confirmFrom = null
    error = ''
    render()
    focusKey(back)
  }

  const doStart = async (): Promise<void> => {
    if (busy || confirm?.type !== 'start') return
    const asked = confirm
    if (confirmedRepo === null || confirmedViewer === null) return
    busy = true
    error = ''
    paintConfirm()
    const answer = await sendRun(sweepStartRequest(asked.runner, confirmedRepo, confirmedViewer, options.token))
    busy = false
    if (answer.ok) {
      confirm = null
      confirmFrom = null
      error = ''
      // the new sweep arrives in the feed; follow the newest
      shownId = null
      render()
      focusKey(null)
      return
    }
    error = sweepRefusal(answer.status, answer.error)
    paintConfirm()
    byKey('confirm-go')?.focus({ preventScroll: true })
  }

  const doStop = async (): Promise<void> => {
    if (busy || confirm?.type !== 'stop') return
    const id = confirm.id
    busy = true
    error = ''
    paintConfirm()
    const answer = await sendRun(sweepStopRequest(id, options.token))
    busy = false
    if (answer.ok) {
      confirm = null
      confirmFrom = null
      error = ''
      stopping = id
      render()
      focusKey(null)
      return
    }
    error = sweepStopRefusal(answer.status, answer.error)
    paintConfirm()
    byKey('confirm-go')?.focus({ preventScroll: true })
  }

  // ---- the parts ----

  const copyButton = (label: string, text: string, said: string, focusKeyName: string): HTMLButtonElement => {
    const button = h('button', { type: 'button', class: 'button button-small', 'aria-label': label, title: label, 'data-focus-key': focusKeyName }, 'Copy')
    button.addEventListener('click', () => {
      void copyText(text).then((copied) => {
        if (copied) {
          options.say(said)
          button.textContent = 'Copied'
          setTimeout(() => {
            if (button.isConnected) button.textContent = 'Copy'
          }, 2_000)
        } else {
          button.title = text
          options.say(`Could not copy. It is: ${text}`)
        }
      })
    })
    return button
  }

  const startPart = (view: SweepsView, latest: SweepView | null): Part => ({
    key: 'start',
    // a start confirmation is rebuilt whenever anything it displays changes, so it never shows a repository, viewer, or command that is not the one a start would use
    sig: JSON.stringify([view.start.unavailable, confirm === null ? null : confirm.type, confirm?.type === 'start' ? sweepConfirmSignature(view.start, confirm.runner) : null, latest?.status === 'running']),
    build: () => {
      if (confirm?.type === 'start') return section('start', 'Start', startConfirmBlock(view, confirm))
      if (latest?.status === 'running') return h('section', { hidden: true })
      const run = h('button', {
        type: 'button',
        class: 'button button-primary',
        'aria-disabled': view.start.unavailable === null ? null : 'true',
        'aria-describedby': view.start.unavailable === null ? null : 'sweep-reason',
        'data-focus-key': 'sweep-run',
      }, 'Run sweep')
      run.addEventListener('click', () => askStart())
      return section('start', 'Start',
        h('div', { class: 'drawer-start' }, run, view.start.unavailable === null ? null : h('p', { id: 'sweep-reason', class: 'drawer-reason' }, view.start.unavailable)))
    },
  })

  const runningCard = (sweep: SweepView): Keyed => ({
    key: 'running',
    create: () => h('section', { class: 'drawer-section drawer-card drawer-running', 'aria-labelledby': 'sweep-running-title' }),
    update: (card) => {
      const model = sweepRunningModel(sweep)
      const settling = stopping === sweep.id
      const parts: Part[] = [
        {
          key: 'head',
          sig: JSON.stringify([sweep.id, model.runnerLabel]),
          build: () => h('div', { class: 'drawer-run-head' },
            h('h3', { id: 'sweep-running-title', class: 'drawer-section-title drawer-run-title' }, h('span', { class: 'agent-dot', 'aria-hidden': 'true' }), 'Sweep running'),
            h('p', { class: 'drawer-run-line' }, timerLine(sweep, options.nowMs()), ` · ${model.runnerLabel}`)),
        },
        {
          key: 'steps',
          sig: JSON.stringify([model.steps.map((step) => [step.step, step.state]), model.stepsName]),
          build: () => h('ol', { class: 'drawer-steps', 'aria-label': model.stepsName },
            model.steps.map((step) => h('li', { class: 'drawer-step', 'data-state': step.state },
              h('span', { class: 'drawer-step-mark', 'aria-hidden': 'true' }, step.glyph),
              h('span', { class: 'drawer-step-label' }, step.label),
              h('span', { class: 'drawer-step-state' }, step.text)))),
        },
      ]
      if (model.note !== null) {
        const note = model.note
        parts.push({
          key: 'note',
          sig: JSON.stringify(note),
          build: () => h('p', { class: 'drawer-run-note' }, h('span', { class: 'drawer-label' }, `${note.label}: `), note.note),
        })
      }
      parts.push({
        key: 'actions',
        sig: JSON.stringify([confirm?.type === 'stop' ? 'confirm' : settling ? 'settling' : 'button', sweep.id]),
        build: () => {
          if (confirm?.type === 'stop') return stopConfirmBlock(sweep)
          if (settling) return h('p', { class: 'drawer-settling', role: 'status' }, 'Stopping the sweep…')
          const stop = h('button', { type: 'button', class: 'button button-danger-outline', 'data-focus-key': 'sweep-stop' }, 'Stop')
          stop.addEventListener('click', () => askStop(sweep.id))
          return h('div', { class: 'drawer-run-actions' }, stop)
        },
      })
      sync(card, parts)
      for (const timer of card.querySelectorAll<HTMLElement>('[data-agent-timer]')) {
        timer.dataset.started = sweep.startedAt
        if (sweep.lastStepAt === null) delete timer.dataset.stepAt
        else timer.dataset.stepAt = sweep.lastStepAt
      }
      tickTimers(card, options.nowMs())
    },
  })

  const resumeBlock = (resume: string | null): HTMLElement | null => resume === null ? null : h('div', { class: 'drawer-resume' },
    h('p', { class: 'drawer-label' }, 'Resume the session'),
    h('code', { class: 'confirm-command mono drawer-command', tabindex: '0' }, resume),
    copyButton('Copy resume command for the sweep', resume, 'Resume command for the sweep copied', 'copy-resume'))

  const waitingCard = (sweep: SweepView): Part => ({
    key: 'waiting',
    sig: JSON.stringify([sweep.id, sweep.question, sweep.resume]),
    build: () => {
      const waiting = sweepWaitingModel(sweep)
      return h('section', { class: 'drawer-section drawer-card drawer-waiting', 'aria-labelledby': 'sweep-waiting-title' },
        h('h3', { id: 'sweep-waiting-title', class: 'drawer-section-title' }, 'Waiting for your answer'),
        h('p', { class: 'drawer-question' }, waiting.question),
        resumeBlock(waiting.resume))
    },
  })

  const reportButton = (name: string, label: string): HTMLButtonElement => {
    const key = `sweep-report:${name}`
    const button = h('button', { type: 'button', class: 'button button-small', 'aria-label': label, title: label, 'data-focus-key': key }, 'Open report')
    button.addEventListener('click', () => options.reports.open(name, key))
    return button
  }

  // what the reviewer posted, linked to the post when GitHub gave one
  const postChip = (row: SweepRowModel): HTMLElement => {
    const href = safeHref(row.posted.url)
    if (href === null) return tag(row.posted.text, row.posted.url === null ? 'gray' : 'blue')
    return h('a', { ...newTab, class: 'chip chip-small chip-link tone-blue', href, title: 'Open the post on GitHub' }, row.posted.text)
  }

  const rowCard = (row: SweepRowModel): HTMLElement => {
    const href = safeHref(row.url)
    const target = marked === row.number
    return h('li', { class: target ? 'sweep-row sweep-row-target' : 'sweep-row', id: `sweep-row-${row.number}`, 'data-sweep-row': row.number, 'aria-current': target ? 'true' : null },
      h('div', { class: 'sweep-row-head' },
        href === null ? h('span', { class: 'mono' }, `#${row.number}`) : h('a', { ...newTab, class: 'pr-link mono', href }, `#${row.number}`),
        h('span', { class: 'sweep-row-title' }, row.title),
        h('code', { class: 'mono sweep-row-head-sha', title: 'Head the sweep read' }, row.head)),
      row.bump === '' ? null : h('p', { class: 'sweep-row-bump' }, row.bump),
      h('p', { class: 'sweep-row-chips' },
        row.recommendation === null ? null : tag(row.recommendation.text, row.recommendation.tone),
        row.ci === null ? null : tag(row.ci.text, row.ci.tone),
        postChip(row),
        row.reused ? tag('Reused', 'gray') : null,
        row.escalation === null ? null : tag('Escalated', 'amber')),
      row.escalation === null ? null : h('p', { class: 'sweep-row-note' }, h('span', { class: 'drawer-label' }, 'Escalation: '), row.escalation),
      row.findings.length === 0 ? null : h('ul', { class: 'sweep-findings' },
        row.findings.map((finding) => h('li', {}, tag(finding.priority, finding.tone), ' ', finding.summary))),
      row.notes === '' ? null : h('p', { class: 'sweep-row-note' }, row.notes),
      row.report === null ? null : h('p', { class: 'sweep-row-report' },
        row.report.name === null
          ? h('code', { class: 'mono' }, row.report.path)
          : reportButton(row.report.name, `Open the report for #${row.number}`),
        row.report.name === null ? null : h('code', { class: 'mono sweep-report-path' }, row.report.path),
        copyButton(`Copy the report path for #${row.number}`, row.report.path, `Report path for #${row.number} copied`, `copy-report-${row.number}`)))
  }

  const resultCard = (sweep: SweepView): Part => ({
    key: 'result',
    // the scroll to a marked card is not in the signature: it must not rebuild the card, which would drop focus
    sig: JSON.stringify([sweep, marked]),
    build: () => {
      const model = sweepResultModel(sweep)
      const order = model.order.length === 0 ? null : h('ol', { class: 'sweep-order' },
        model.order.map((step) => h('li', {},
          step.action,
          step.prs.length === 0 ? null : h('span', { class: 'sweep-order-prs' }, ' ', step.prs.map((number, index) => {
            const goto = h('button', { type: 'button', class: 'link-button mono', 'data-goto': number, 'aria-label': `Go to #${number} in this sweep` }, `#${number}`)
            goto.addEventListener('click', () => gotoRow(number))
            return h('span', {}, index === 0 ? '' : ', ', goto)
          })))))
      return h('section', { class: 'drawer-section drawer-card drawer-result', 'aria-labelledby': 'sweep-result-title' },
        h('h3', { id: 'sweep-result-title', class: 'drawer-section-title' }, 'Sweep of ', sweep.repo),
        h('p', { class: 'drawer-result-text' },
          h('span', { class: `agent-text tone-text-${model.tone}` }, model.text),
          model.finishedAt === null ? null : h('span', { class: 'drawer-meta' }, ' · ', ageSpan(model.finishedAt, 'finished ', options.nowMs())),
          h('span', { class: 'drawer-meta' }, ` · ${model.runnerLabel}`),
          model.cost === null ? null : h('span', { class: 'drawer-meta' }, ` · ${model.cost}`)),
        model.note === null ? null : h('p', { class: 'drawer-note' }, model.note),
        model.empty ? h('p', { class: 'muted', role: 'status' }, 'Nothing to sweep: no open Dependabot PRs were found, so nothing was reviewed or posted.') : null,
        model.counts === null ? null : h('dl', { class: 'sweep-counts' },
          model.counts.map((count) => h('div', { class: 'sweep-count', 'data-count': count.key },
            h('dt', {}, count.label),
            h('dd', { class: 'mono' }, String(count.value))))),
        model.summaryPath === null ? null : h('div', { class: 'sweep-summary' },
          h('p', { class: 'drawer-label' }, 'Summary'),
          h('code', { class: 'confirm-command mono drawer-command', tabindex: '0', 'data-summary-path': '' }, model.summaryPath),
          copyButton('Copy the summary path', model.summaryPath, 'Summary path copied', 'copy-summary')),
        order === null ? null : h('div', { class: 'sweep-merge' }, h('p', { class: 'drawer-label' }, 'Merge order and actions'), order),
        model.rows.length === 0 ? null : h('div', { class: 'sweep-rows' },
          h('p', { class: 'drawer-label' }, `Pull requests · ${model.rows.length}`),
          h('ul', { class: 'drawer-list sweep-row-list' }, model.rows.map(rowCard))),
        // a waiting sweep's own card carries its resume command
        sweep.status === 'needsInput' ? null : resumeBlock(sweep.resume))
    },
  })

  const listPart = (view: SweepsView, current: SweepView | null): Part => ({
    key: 'list',
    sig: JSON.stringify([view.items.map((sweep) => [sweep.id, sweep.status, sweep.text]), current?.id]),
    build: () => {
      const rows = sweepList(view.items, current?.id ?? null)
      return section('list', 'Earlier sweeps',
        rows.length === 0 ? h('p', { class: 'muted' }, 'No sweeps yet.') : h('ul', { class: 'drawer-list' },
          rows.map((row) => {
            const open = h('button', { type: 'button', class: 'button button-small', 'aria-pressed': String(row.selected), 'data-focus-key': `sweep-pick:${row.id}`, 'aria-label': `Show the ${row.label.toLowerCase()}` }, row.selected ? 'Shown' : 'Show')
            open.addEventListener('click', () => {
              shownId = row.id
              marked = null
              render()
            })
            return h('li', { class: 'drawer-item' },
              h('span', { class: 'drawer-item-main' }, h('span', { class: 'drawer-item-name' }, row.label), tag(row.text, row.tone), open),
              h('span', { class: 'drawer-item-meta' }, ageSpan(row.startedAt, 'started ', options.nowMs()), row.cost === null ? '' : ` · ${row.cost}`))
          })))
    },
  })

  // ---- drawing ----

  const gotoRow = (number: number): void => {
    marked = number
    scrollPending = true
    render()
  }

  const render = (): void => {
    const view = sweeps()
    if (view === null) return
    const current = shown()
    const active = document.activeElement
    const focusedKey = active instanceof HTMLElement && root.contains(active) ? active.dataset.focusKey ?? 'heading' : null
    const scroll = body.scrollTop
    setText(subLine, view.start.repo)

    const items: (Part | Keyed)[] = [startPart(view, view.items[0] ?? null)]
    if (current !== null) {
      for (const card of sweepCards(current)) {
        if (card === 'running') items.push(runningCard(current))
        else if (card === 'waiting') items.push(waitingCard(current))
        else items.push(resultCard(current))
      }
    }
    items.push(listPart(view, current))
    sync(body, items)

    for (const element of root.querySelectorAll<HTMLElement>('[data-age]')) {
      setText(element, `${element.dataset.agePrefix ?? ''}${formatSince(element.dataset.age ?? '', options.nowMs())}`)
    }
    paintConfirm()
    if (scrollPending && marked !== null) {
      const row = root.querySelector<HTMLElement>(`#sweep-row-${marked}`)
      if (row !== null) {
        scrollPending = false
        row.scrollIntoView({ block: 'center' })
        // a row marked from outside takes keyboard focus, so a screen reader lands on it
        row.setAttribute('tabindex', '-1')
        row.focus({ preventScroll: true })
      }
    } else if (body.scrollTop !== scroll) {
      body.scrollTop = scroll
    }
    if (focusedKey !== null && (document.activeElement === null || document.activeElement === document.body)) {
      focusKey(focusedKey === 'heading' ? null : focusedKey)
    }
  }

  // a confirmation outlives nothing: a start must still be available, a stop's sweep still running
  const dropStaleConfirm = (view: SweepsView): void => {
    if (confirm === null || busy) return
    const stillAsked = confirm.type === 'start'
      ? view.start.unavailable === null
      : view.items.some((sweep) => sweep.id === (confirm as Extract<Confirm, { type: 'stop' }>).id && sweep.status === 'running')
    if (stillAsked) return
    confirm = null
    confirmFrom = null
    error = ''
  }

  const update = (): void => {
    if (!isOpen) return
    const view = sweeps()
    if (view === null) return
    // a sweep that was stopping has settled
    const current = shown()
    if (stopping !== null && !view.items.some((sweep) => sweep.id === stopping && sweep.status === 'running')) stopping = null
    // a new sweep appears: follow it when the drawer was following the newest
    const status = `${current?.id}:${current?.status}`
    if (status !== seenStatus) {
      seenStatus = status
      if (current?.status === 'running' && confirm?.type === 'start') confirm = null
    }
    dropStaleConfirm(view)
    render()
  }

  const open = (from: SweepOpener | null, show: { sweepId?: number, pr?: number, ask?: boolean } = {}): void => {
    opener = from
    if (!isOpen) {
      isOpen = true
      confirm = null
      confirmFrom = null
      busy = false
      error = ''
      stopping = null
      seenStatus = ''
    }
    shownId = show.sweepId ?? null
    marked = show.pr ?? null
    scrollPending = show.pr !== undefined
    root.hidden = false
    update()
    heading.focus({ preventScroll: true })
    if (show.ask === true && !busy) askStart()
    if (scrollPending) render()
  }

  const close = (): void => {
    if (!isOpen) return
    isOpen = false
    confirm = null
    busy = false
    stopping = null
    marked = null
    scrollPending = false
    root.hidden = true
    options.reports.close()
    const back = opener
    opener = null
    if (back !== null) document.querySelector<HTMLElement>(focusKeySelector(back.key))?.focus({ preventScroll: true })
  }

  closeButton.addEventListener('click', close)

  return {
    open,
    close,
    update,
    isOpen: () => isOpen,
    escape: () => {
      const target = escapeTarget({ report: options.reports.isOpen(), confirm: confirm !== null, busy, drawer: isOpen })
      if (target === 'report') options.reports.close()
      else if (target === 'confirm') cancelConfirm()
      else if (target === 'drawer') close()
      else return false
      return true
    },
    focusKey,
  }
}
