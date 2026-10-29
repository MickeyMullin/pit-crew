// public/drawer.ts
// the Agent drawer: a non-modal panel on the right for one open PR. It starts runs behind an inline
// confirmation, shows the running, waiting and finished cards, the PR's earlier runs and the
// reports on disk, and reads the live row from the page's feed on every draw, so a patch updates
// it in place. drawerview.ts says what every part reads; this file makes the elements, keeps the
// confirmation's state, and moves focus
import type { OpenRow } from '../src/derive.ts'
import type { ReportListing } from '../src/reports.ts'
import { actionDoneText, actionHolds, actionRefusalText, actionRequest } from './actionsview.ts'
import type { ActionConfirmModel, ActionKind, PersonChoice } from './actionsview.ts'
import { refusalText, startRequest, stopRequest } from './agent.ts'
import type { AgentCell, RunView, StartKind } from './agent.ts'
import { copyText, tickTimers, timerLine } from './agentcell.ts'
import { h, newTab, setText, svg, sync } from './dom.ts'
import type { Keyed, Part } from './dom.ts'
import {
  confirmHolds, defaultRunner, drawerModel, escapeTarget, focusKeySelector, latestCell, loadErrorText, mayMoveFocus, optionOf, refetchKeys,
  resumeReadyText, returnSelector,
} from './drawerview.ts'
import type { Confirm, DrawerModel, Loadable, Opener, StartConfirmModel, StopModel } from './drawerview.ts'
import { formatSince } from './format.ts'
import type { ReportPanel } from './reportpanel.ts'
import { getJson, sendRun } from './runapi.ts'
import { safeHref } from './safeurl.ts'

export type DrawerOptions = {
  root: HTMLElement
  // the token this page was served with, from <meta name="pit-view-token">
  token: string
  nowMs: () => number
  // the live row by number, from the page's feed; undefined once the PR has left the open tables
  rowOf: (number: number) => OpenRow | undefined
  // the page's polite live region
  say: (text: string) => void
  reports: ReportPanel
}

export type Drawer = {
  // ask, when given, opens that start's confirmation at once (the banner's Fix session), if the
  // PR offers it and it can run now; otherwise the drawer opens as usual and says why
  open: (number: number, opener: Opener, ask?: StartKind) => void
  close: () => void
  // after every draw: take the live row, refetch what changed, bring the elements up to date
  update: () => void
  isOpen: () => boolean
  number: () => number | null
  // Escape: closes what is topmost; false when there is nothing to close
  escape: () => boolean
  // focus the control with this data-focus-key, or the heading when it is gone; without force
  // only while focus is inside the drawer or on nothing, so a page's field in use keeps it
  focusKey: (key: string | null, force?: boolean) => void
}

const ageSpan = (iso: string, prefix: string, nowMs: number): HTMLSpanElement =>
  h('span', { class: 'drawer-age', 'data-age': iso, 'data-age-prefix': prefix }, `${prefix}${formatSince(iso, nowMs)}`)

const refreshAges = (root: ParentNode, nowMs: number): void => {
  for (const element of root.querySelectorAll<HTMLElement>('[data-age]')) {
    setText(element, `${element.dataset.agePrefix ?? ''}${formatSince(element.dataset.age ?? '', nowMs)}`)
  }
}

// a small tag: a verdict, a run's outcome, Tandem
const tag = (text: string, tone: string): HTMLSpanElement => h('span', { class: `chip chip-small tone-${tone}` }, text)

const section = (id: string, title: string, ...children: (Node | string | null | false)[]): HTMLElement =>
  h('section', { class: 'drawer-section', 'aria-labelledby': `drawer-${id}` },
    h('h3', { id: `drawer-${id}`, class: 'drawer-section-title' }, title),
    ...children)

const facts = (rows: [string, Node | string][]): HTMLDListElement =>
  h('dl', { class: 'confirm-facts' }, rows.flatMap(([term, value]) => [h('dt', {}, term), h('dd', {}, value)]))

export const createDrawer = (options: DrawerOptions): Drawer => {
  const { root } = options

  let number: number | null = null
  let last: OpenRow | null = null
  let opener: Opener | null = null
  let runs: Loadable<RunView> = { state: 'loading' }
  let reports: Loadable<ReportListing> = { state: 'loading' }
  let confirm: Confirm | null = null
  // a start or stop request is on its way
  let busy = false
  let error = ''
  // the people used for the current confirmation; review requests refresh this list every time
  // they are asked because Settings can change while the drawer is open
  let people: PersonChoice[] | null = null
  // what the last direct action did, shown under the buttons until the next ask or another PR
  let actionNote = ''
  // a direct action that could not even be asked (the people could not be read)
  let actionFail = ''
  // the control to give focus back to when a confirmation is canceled
  let confirmFrom: string | null = null
  // a stop was accepted and the run has not settled yet; and whether to show the session then
  let stopping: number | null = null
  let openAfterStop = false
  let seen = { runs: '', reports: '', gone: false }
  // while a PR that left the open tables still has a run going, its runs are read again on this timer
  let poll: ReturnType<typeof setTimeout> | undefined
  let goneRunning = false
  let runsRequest = 0
  let reportsRequest = 0

  const heading = h('h2', { id: 'drawer-heading', class: 'drawer-heading', tabindex: '-1' })
  const headingLabel = document.createTextNode('Agent for ')
  const headingLink = h('a', { ...newTab, href: '#', class: 'pr-link' })
  heading.append(headingLabel, headingLink)
  const titleLine = h('p', { class: 'drawer-pr-title' })
  const authorLine = h('p', { class: 'drawer-pr-sub' })
  const refsLine = h('p', { class: 'drawer-pr-sub mono' })
  const closeButton = h('button', { type: 'button', class: 'icon-button drawer-close', 'aria-label': 'Close agent drawer', title: 'Close agent drawer' },
    svg([['path', { d: 'M6 6l12 12' }], ['path', { d: 'M18 6L6 18' }]], { size: 14, stroke: '2.4' }))
  const body = h('div', { class: 'drawer-body' })
  root.replaceChildren(
    h('div', { class: 'drawer-head' },
      h('div', { class: 'drawer-titles' }, heading, titleLine, authorLine, refsLine),
      closeButton),
    body)

  const byKey = (key: string): HTMLElement | null => root.querySelector<HTMLElement>(focusKeySelector(key))

  // focus is only moved when it cannot pull the owner out of something: inside the drawer, on the
  // body, or already where it is going
  const focusIsFree = (): boolean => {
    const active = document.activeElement
    return mayMoveFocus({ insideDrawer: active !== null && root.contains(active), onBody: active === null || active === document.body })
  }

  const focusKey = (key: string | null, force = false): void => {
    if (!force && !focusIsFree()) return
    const target = key === null ? null : document.querySelector<HTMLElement>(focusKeySelector(key))
    ;(target ?? heading).focus({ preventScroll: true })
  }

  // ---- the confirmation, built once per ask and painted from the state ----

  const errorLine = (): HTMLParagraphElement => h('p', { id: 'drawer-error', class: 'confirm-error', role: 'alert' })

  const confirmActions = (goText: string, tone: 'primary' | 'danger' | 'caution', onGo: () => void): HTMLDivElement => {
    const cancel = h('button', { type: 'button', class: 'button', 'data-focus-key': 'confirm-cancel' }, 'Cancel')
    const go = h('button', { type: 'button', class: `button button-${tone}`, 'data-focus-key': 'confirm-go', 'aria-describedby': 'drawer-error' }, goText)
    cancel.addEventListener('click', () => {
      if (!busy) cancelConfirm()
    })
    go.addEventListener('click', () => {
      if (!busy) onGo()
    })
    return h('div', { class: 'confirm-actions' }, cancel, go)
  }

  const startConfirmBlock = (ask: StartConfirmModel): HTMLElement => {
    const command = h('code', { class: 'confirm-command mono', 'data-confirm': 'command' }, ask.command)
    const runner: Node | string = ask.runners.length === 1
      ? ask.runnerLabel
      : h('span', { class: 'confirm-runners', role: 'radiogroup', 'aria-labelledby': 'drawer-runner-term' },
        ask.runners.map((choice) => {
          const input = h('input', { type: 'radio', name: 'drawer-runner', value: choice.name, checked: choice.name === ask.runner })
          input.addEventListener('change', () => {
            if (!input.checked || confirm?.type !== 'start') return
            confirm = { ...confirm, runner: choice.name }
            paintConfirm()
          })
          return h('label', { class: 'confirm-runner' }, input, choice.label)
        }))
    const list = facts([['Command', command], ['Runner', runner], ['On GitHub', ask.effect]])
    list.querySelector('dt:nth-of-type(2)')?.setAttribute('id', 'drawer-runner-term')
    // a start that pushes is told apart from a review's by its caution treatment, a plain line
    // about the push, and a Start that names the session
    const caution = ask.caution !== null
    return h('div', {
      class: caution ? 'confirm confirm-caution' : 'confirm',
      role: 'group',
      'aria-labelledby': 'drawer-confirm-heading',
      'aria-describedby': caution ? 'drawer-confirm-caution' : null,
    },
      h('h4', { id: 'drawer-confirm-heading', class: 'confirm-heading' },
        caution ? svg([['path', { d: 'M12 3l10 18H2z' }], ['path', { d: 'M12 10v5' }], ['path', { d: 'M12 18h.01' }]], { size: 16, stroke: '2.2', className: 'confirm-caution-icon' }) : null,
        ask.heading),
      h('p', { class: 'confirm-title' }, ask.title),
      list,
      caution ? h('p', { id: 'drawer-confirm-caution', class: 'confirm-caution-line' }, ask.caution) : null,
      errorLine(),
      confirmActions(ask.confirm, caution ? 'caution' : 'primary', () => void doStart()))
  }

  const stopConfirmBlock = (stop: StopModel, row: OpenRow): HTMLElement => {
    const cell = row.agent
    return h('div', { class: 'confirm', role: 'group', 'aria-labelledby': 'drawer-confirm-heading' },
      h('h4', { id: 'drawer-confirm-heading', class: 'confirm-heading' }, stop.heading),
      facts([
        ['Run', h('span', {}, `${stop.detail}, `, cell === null ? null : timerLine(cell, options.nowMs()))],
        ['Stopping', stop.effect],
        ...(stop.after === null ? [] : [['Then', stop.after] as [string, string]]),
      ]),
      errorLine(),
      confirmActions(stop.confirm, 'danger', () => void doStop()))
  }

  const actionConfirmBlock = (ask: ActionConfirmModel): HTMLElement => {
    const picker = ask.reviewers === null ? null : h('select', { id: 'drawer-reviewer', class: 'confirm-select', 'data-focus-key': 'action-reviewer', disabled: ask.reviewers.length === 0 },
      ask.reviewers.map((choice) => h('option', { value: choice.login, selected: choice.login === ask.reviewer }, choice.label)))
    picker?.addEventListener('change', () => {
      if (confirm?.type !== 'action') return
      confirm = { ...confirm, reviewer: picker.value }
      paintConfirm()
    })
    const list = facts([
      ...(picker === null ? [] : [['Reviewer', picker] as [string, Node]]),
      ['On GitHub', h('span', { 'data-confirm': 'effect' }, ask.effect)],
    ])
    if (picker !== null) list.querySelector('dt')?.setAttribute('id', 'drawer-reviewer-term')
    picker?.setAttribute('aria-labelledby', 'drawer-reviewer-term')
    return h('div', { class: 'confirm', role: 'group', 'aria-labelledby': 'drawer-confirm-heading' },
      h('h4', { id: 'drawer-confirm-heading', class: 'confirm-heading' }, ask.heading),
      h('p', { class: 'confirm-title' }, ask.title),
      list,
      errorLine(),
      confirmActions(ask.confirm, 'primary', () => void doAction()))
  }

  // the parts of the confirmation that change without a rebuild: the command for the chosen
  // runner, the error line and the buttons while a request is on its way
  const paintConfirm = (): void => {
    const model = current()
    const command = root.querySelector<HTMLElement>('[data-confirm="command"]')
    if (command !== null && model?.confirm != null) setText(command, model.confirm.command)
    const effect = root.querySelector<HTMLElement>('[data-confirm="effect"]')
    if (effect !== null && model?.actionAsk != null) setText(effect, model.actionAsk.effect)
    const picker = root.querySelector<HTMLSelectElement>('#drawer-reviewer')
    if (picker !== null && model?.actionAsk != null && picker.value !== model.actionAsk.reviewer) picker.value = model.actionAsk.reviewer
    for (const input of root.querySelectorAll<HTMLInputElement>('input[name="drawer-runner"]')) {
      const wanted = confirm?.type === 'start' && confirm.runner === input.value
      if (input.checked !== wanted) input.checked = wanted
    }
    const line = root.querySelector<HTMLElement>('#drawer-error')
    if (line !== null) setText(line, error)
    const cancel = byKey('confirm-cancel')
    const go = byKey('confirm-go') as HTMLButtonElement | null
    if (picker !== null) picker.disabled = busy || (model?.actionAsk?.reviewers?.length ?? 0) === 0
    if (cancel !== null) (cancel as HTMLButtonElement).disabled = busy
    if (go !== null) {
      go.disabled = busy || (confirm?.type === 'action' && model?.actionAsk?.canConfirm === false)
      const idleText = confirm?.type === 'stop' ? (model?.stop?.confirm ?? 'Stop run')
        : confirm?.type === 'action' ? (model?.actionAsk?.confirm ?? 'Confirm')
          : (model?.confirm?.confirm ?? 'Start')
      const busyText = confirm?.type === 'stop' ? (model?.stop?.busy ?? 'Stopping…')
        : confirm?.type === 'action' ? (model?.actionAsk?.busy ?? 'Working…')
          : (model?.confirm?.busy ?? 'Starting…')
      setText(go, busy ? busyText : idleText)
    }
  }

  const askStart = (kind: StartKind): void => {
    const cell = latest()
    if (cell === null) return
    const option = optionOf(cell, kind)
    if (option === undefined || option.unavailable !== null || options.rowOf(number ?? 0) === undefined) return
    confirm = { type: 'start', kind, runner: defaultRunner(option, cell.action.runner) }
    confirmFrom = `start:${kind}`
    error = ''
    render()
    byKey('confirm-cancel')?.focus({ preventScroll: true })
  }

  // a direct action: one click opens the confirmation, naming the PR and the action; nothing is
  // sent until its own button is clicked. A review request first reads the people it chooses from
  const askAction = async (action: ActionKind): Promise<void> => {
    const n = number
    if (n === null || options.rowOf(n) === undefined) return
    actionNote = ''
    actionFail = ''
    if (action === 'requestReview') {
      const answer = await getJson<{ people?: PersonChoice[] }>('/api/config')
      if (n !== number) return
      if (!answer.ok || !Array.isArray(answer.value?.people)) {
        actionFail = 'Could not read the people list to choose a reviewer from. Try again.'
        render()
        return
      }
      people = answer.value.people.map((person) => ({ login: person.login, alias: person.alias }))
    }
    // the head and base shown now are the ones a merge is bound to
    const row = options.rowOf(n)
    if (row === undefined) return
    confirm = { type: 'action', action, reviewer: '', headSha: row.headSha, baseRef: row.baseRef }
    confirmFrom = `action:${action}`
    error = ''
    render()
    byKey('confirm-cancel')?.focus({ preventScroll: true })
  }

  const doAction = async (): Promise<void> => {
    if (busy || confirm?.type !== 'action' || number === null) return
    const asked = confirm
    const n = number
    // the reviewer shown is the one sent: a stale choice falls back to the first listed
    const ask = current()?.actionAsk
    const sent = { ...asked, reviewer: asked.action === 'requestReview' ? ask?.reviewer ?? '' : '' }
    if (asked.action === 'requestReview' && sent.reviewer === '') return
    busy = true
    error = ''
    paintConfirm()
    const request = actionRequest(n, sent, options.token)
    const answer = await sendRun(request)
    busy = false
    if (n !== number) return
    if (answer.ok) {
      confirm = null
      confirmFrom = null
      error = ''
      actionNote = actionDoneText(n, sent, people ?? [])
      options.say(actionNote)
      render()
      focusKey(`action:${asked.action}`)
      return
    }
    error = actionRefusalText(answer.status, answer.error)
    paintConfirm()
    byKey('confirm-go')?.focus({ preventScroll: true })
  }

  const askStop = (andOpen: boolean): void => {
    const runId = latest()?.runId
    if (runId === null || runId === undefined) return
    confirm = { type: 'stop', andOpen, runId }
    confirmFrom = andOpen ? 'stop-open' : 'stop'
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
    if (busy || confirm?.type !== 'start' || number === null) return
    const asked = confirm
    const n = number
    busy = true
    error = ''
    paintConfirm()
    const answer = await sendRun(startRequest(n, asked.kind, asked.runner, options.token))
    busy = false
    if (n !== number) return
    if (answer.ok) {
      confirm = null
      confirmFrom = null
      error = ''
      render()
      // the confirmation is gone; the heading holds focus until the run's card appears, and the
      // page's live region says the run started
      focusKey(null)
      void loadRuns()
      return
    }
    error = refusalText('start', answer.status, answer.error)
    paintConfirm()
    byKey('confirm-go')?.focus({ preventScroll: true })
  }

  const doStop = async (): Promise<void> => {
    if (busy || confirm?.type !== 'stop' || number === null) return
    const asked = confirm
    const n = number
    const runId = asked.runId
    busy = true
    error = ''
    paintConfirm()
    const answer = await sendRun(stopRequest(runId, options.token))
    busy = false
    if (n !== number) return
    if (answer.ok) {
      confirm = null
      confirmFrom = null
      error = ''
      stopping = runId
      openAfterStop = asked.andOpen
      render()
      focusKey(null)
      return
    }
    error = refusalText('stop', answer.status, answer.error)
    paintConfirm()
    byKey('confirm-go')?.focus({ preventScroll: true })
  }

  // ---- the parts ----

  const copyButton = (name: string, command: string, n: number): HTMLButtonElement => {
    const button = h('button', { type: 'button', class: 'button button-small', 'aria-label': name, title: name, 'data-focus-key': 'copy-resume' }, 'Copy resume command')
    button.addEventListener('click', () => {
      void copyText(command).then((copied) => {
        if (copied) {
          options.say(`Resume command for #${n} copied`)
          button.textContent = 'Copied'
          setTimeout(() => {
            if (button.isConnected) button.textContent = 'Copy resume command'
          }, 2_000)
        } else {
          button.title = command
          options.say(`Could not copy. The resume command for #${n} is: ${command}`)
        }
      })
    })
    return button
  }

  const resumeBlock = (resume: string | null, copyName: string, n: number): HTMLElement | null => {
    if (resume === null) return null
    return h('div', { class: 'drawer-resume' },
      h('p', { class: 'drawer-label' }, 'Resume the session'),
      h('code', { class: 'confirm-command mono drawer-command', tabindex: '0' }, resume),
      copyButton(copyName, resume, n))
  }

  const startPart = (model: DrawerModel): Part => ({
    key: 'start',
    sig: JSON.stringify([model.starts, model.confirm === null ? null : { ...model.confirm, runner: '', command: '' }]),
    build: () => {
      if (model.confirm !== null) return section('start', 'Start', startConfirmBlock(model.confirm))
      return section('start', 'Start',
        model.starts.buttons.length === 0 ? h('p', { class: 'muted' }, 'Nothing can be started for this PR.') : h('div', { class: 'drawer-starts' },
          model.starts.buttons.map((button, index) => {
            const reasonId = `drawer-reason-${button.kind}`
            const element = h('button', {
              type: 'button',
              class: `button ${index === 0 ? 'button-primary' : ''}`.trim(),
              disabled: button.disabled,
              'data-focus-key': `start:${button.kind}`,
              'aria-describedby': button.reason === null ? null : reasonId,
            }, button.text)
            element.addEventListener('click', () => askStart(button.kind))
            return h('div', { class: 'drawer-start' }, element, button.reason === null ? null : h('p', { id: reasonId, class: 'drawer-reason' }, button.reason))
          })),
        model.starts.shared === null ? null : h('p', { class: 'drawer-reason' }, model.starts.shared))
    },
  })

  const actionsPart = (model: DrawerModel): Part | null => {
    if (model.actions.length === 0) return null
    return {
      key: 'actions',
      sig: JSON.stringify([model.actions, model.actionAsk === null ? null : { ...model.actionAsk, reviewer: '', effect: '' }, actionNote, actionFail]),
      build: () => {
        if (model.actionAsk !== null) return section('actions', 'Actions', actionConfirmBlock(model.actionAsk))
        return section('actions', 'Actions',
          h('div', { class: 'drawer-starts' }, model.actions.map((offer) => {
            const button = h('button', { type: 'button', class: 'button', 'data-focus-key': `action:${offer.action}` }, offer.text)
            button.addEventListener('click', () => void askAction(offer.action))
            return h('div', { class: 'drawer-start' }, button)
          })),
          h('p', { class: 'drawer-reason' }, 'Each one asks for your confirmation first and acts on GitHub under your account.'),
          actionNote === '' ? null : h('p', { class: 'drawer-reason', role: 'status' }, actionNote),
          actionFail === '' ? null : h('p', { class: 'confirm-error', role: 'alert' }, actionFail))
      },
    }
  }

  const goneNote = (text: string): Part => ({
    key: 'gone',
    sig: text,
    build: () => h('p', { class: 'drawer-gone', role: 'status' }, text),
  })

  // the running card is one element for the whole run; its parts rebuild only when what they
  // show changes, so Stop is never replaced under the pointer by a new step or a tick
  const runningCard = (model: DrawerModel, row: OpenRow): Keyed => ({
    key: 'running',
    create: () => h('section', { class: 'drawer-section drawer-card drawer-running', 'aria-labelledby': 'drawer-running-title' }),
    update: (card) => {
      const running = model.running
      const cell = row.agent
      if (running === null || cell === null || model.stop === null) return
      const stopConfirmAsk = confirm?.type === 'stop'
      const settling = stopping !== null && stopping === cell.runId
      const parts: Part[] = [
        {
          key: 'head',
          sig: JSON.stringify([running.label, running.tandem, running.runnerLabel, running.sha]),
          build: () => h('div', { class: 'drawer-run-head' },
            h('h3', { id: 'drawer-running-title', class: 'drawer-section-title drawer-run-title' },
              h('span', { class: 'agent-dot', 'aria-hidden': 'true' }),
              running.label,
              running.tandem ? tag('Tandem', 'blue') : null),
            h('p', { class: 'drawer-run-line' }, timerLine(cell, options.nowMs(), {}, running.sha), ` · ${running.runnerLabel}`)),
        },
        {
          key: 'steps',
          sig: JSON.stringify([running.steps.map((step) => [step.step, step.state]), running.stepsName]),
          build: () => h('ol', { class: 'drawer-steps', 'aria-label': running.stepsName },
            running.steps.map((step) => h('li', { class: 'drawer-step', 'data-state': step.state },
              h('span', { class: 'drawer-step-mark', 'aria-hidden': 'true' }, step.glyph),
              h('span', { class: 'drawer-step-label' }, step.label),
              h('span', { class: 'drawer-step-state' }, step.text)))),
        },
      ]
      if (running.note !== null) {
        const note = running.note
        parts.push({
          key: 'note',
          sig: JSON.stringify(note),
          build: () => h('p', { class: 'drawer-run-note' }, h('span', { class: 'drawer-label' }, `${note.label}: `), note.note),
        })
      }
      parts.push({
        key: 'actions',
        sig: JSON.stringify([stopConfirmAsk ? ['confirm', model.stop] : settling ? 'settling' : 'buttons', cell.runId, model.stopsEnabled]),
        build: () => {
          if (stopConfirmAsk) return stopConfirmBlock(model.stop as StopModel, row)
          if (settling) {
            return h('p', { class: 'drawer-settling', role: 'status' }, openAfterStop
              ? 'Stopping the run. Its resume command appears here when it has stopped.'
              : 'Stopping the run…')
          }
          const stop = h('button', { type: 'button', class: 'button button-danger-outline', disabled: !model.stopsEnabled, 'data-focus-key': 'stop' }, 'Stop')
          const stopOpen = h('button', { type: 'button', class: 'button', disabled: !model.stopsEnabled, 'data-focus-key': 'stop-open' }, 'Stop and open')
          stop.addEventListener('click', () => askStop(false))
          stopOpen.addEventListener('click', () => askStop(true))
          return h('div', { class: 'drawer-run-actions' }, stop, stopOpen)
        },
      })
      sync(card, parts)
      // the timer's start and newest step travel with the element, which a new step does not rebuild
      for (const timer of card.querySelectorAll<HTMLElement>('[data-agent-timer]')) {
        if (cell.startedAt !== null) timer.dataset.started = cell.startedAt
        if (cell.lastStepAt === null) delete timer.dataset.stepAt
        else timer.dataset.stepAt = cell.lastStepAt
      }
      tickTimers(card, options.nowMs())
    },
  })

  const waitingCard = (model: DrawerModel, n: number): Part => ({
    key: 'waiting',
    sig: JSON.stringify(model.waiting),
    build: () => {
      const waiting = model.waiting
      return h('section', { class: 'drawer-section drawer-card drawer-waiting', 'aria-labelledby': 'drawer-waiting-title' },
        h('h3', { id: 'drawer-waiting-title', class: 'drawer-section-title' }, 'Waiting for your answer'),
        h('p', { class: 'drawer-question' }, waiting?.question ?? ''),
        waiting === null ? null : resumeBlock(waiting.resume, waiting.copyName, n))
    },
  })

  const resultCard = (model: DrawerModel, n: number): Part => ({
    key: 'result',
    sig: JSON.stringify(model.result === null ? null : { ...model.result, finishedAt: model.result.finishedAt !== null }),
    build: () => {
      const result = model.result
      if (result === null) return h('section')
      const parts = result.facts.map((fact) => h('div', { class: 'drawer-fact' },
        h('dt', {}, fact.label),
        h('dd', {}, fact.href === null ? fact.value : h('a', { ...newTab, href: fact.href }, fact.value))))
      const fix = result.fix
      if (fix !== null) {
        parts.push(h('div', { class: 'drawer-fact' }, h('dt', {}, 'Requests'), h('dd', {}, fix.requests)))
        if (fix.outcomes !== null) parts.push(h('div', { class: 'drawer-fact' }, h('dt', {}, 'Outcome'), h('dd', {}, fix.outcomes)))
        if (fix.checks.length > 0) {
          parts.push(h('div', { class: 'drawer-fact' }, h('dt', {}, 'Checks'), h('dd', {},
            h('ul', { class: 'drawer-checks' }, fix.checks.map((check) => h('li', {},
              h('code', { class: 'mono' }, check.name), ' ', h('span', { class: `agent-text tone-text-${check.tone}` }, check.text)))))))
        }
      }
      return h('section', { class: 'drawer-section drawer-card drawer-result', 'aria-labelledby': 'drawer-result-title' },
        h('h3', { id: 'drawer-result-title', class: 'drawer-section-title' }, result.stale === null ? 'Latest run' : 'Last run'),
        h('p', { class: 'drawer-result-text' },
          h('span', { class: `agent-text tone-text-${result.tone}` }, result.text),
          result.finishedAt === null ? null : h('span', { class: 'drawer-meta' }, ' · ', ageSpan(result.finishedAt, 'finished ', options.nowMs())),
          h('span', { class: 'drawer-meta' }, ` · ${result.runnerLabel}`),
          result.cost === null ? null : h('span', { class: 'drawer-meta' }, ` · ${result.cost}`)),
        result.note === null ? null : h('p', { class: 'drawer-note' }, result.note),
        result.stale === null ? null : h('p', { class: 'drawer-note' }, result.stale),
        fix?.pushed == null ? null : h('div', { class: 'drawer-pushed' },
          h('p', { class: 'drawer-label' }, 'Pushed to ', h('code', { class: 'mono' }, fix.pushed.branch)),
          h('ul', { class: 'drawer-commits' }, fix.pushed.commits.map((commit) => h('li', {},
            h('code', { class: 'mono drawer-commit-sha' }, commit.sha), ' ', h('span', {}, commit.subject))))),
        parts.length === 0 ? null : h('dl', { class: 'drawer-facts' }, parts),
        fix?.worktree == null ? null : h('p', { class: 'drawer-notice' }, fix.worktree),
        fix?.report == null ? null : reportButton(fix.report.name, fix.report.openName, 'Open report'),
        resumeBlock(result.resume, result.copyName, n))
    },
  })

  // the report panel opens a report by its file name; focus comes back to this button
  const reportButton = (name: string, label: string, text: string): HTMLButtonElement => {
    const key = text === 'Open' ? `report:${name}` : `result-report:${name}`
    const button = h('button', { type: 'button', class: 'button button-small', 'aria-label': label, title: label, 'data-focus-key': key }, text)
    button.addEventListener('click', () => options.reports.open(name, key))
    return button
  }

  const listState = (what: string, state: string, message: string | null, retry: () => void): Node | null => {
    if (state === 'loading') return h('p', { class: 'muted', role: 'status' }, `Loading ${what}…`)
    if (state !== 'error') return null
    const again = h('button', { type: 'button', class: 'button button-small' }, 'Try again')
    again.addEventListener('click', retry)
    return h('div', { class: 'drawer-list-error' }, h('p', { class: 'confirm-error', role: 'alert' }, message ?? ''), again)
  }

  const runsPart = (model: DrawerModel): Part => ({
    key: 'runs',
    sig: JSON.stringify([model.runs.state, model.runs.message, model.runs.rows.map((row) => ({ ...row, startedAt: '' }))]),
    build: () => section('runs', 'Previous runs',
      listState('runs', model.runs.state, model.runs.message, () => void loadRuns()),
      model.runs.state === 'ready' && model.runs.rows.length === 0 ? h('p', { class: 'muted' }, 'No earlier runs.') : null,
      model.runs.rows.length === 0 ? null : h('ul', { class: 'drawer-list' },
        model.runs.rows.map((row) => h('li', { class: 'drawer-item' },
          h('span', { class: 'drawer-item-main' },
            h('span', { class: 'drawer-item-name' }, row.label),
            tag(row.text, row.tone)),
          h('span', { class: 'drawer-item-meta' },
            `${row.runner} · `, ageSpan(row.startedAt, 'started ', options.nowMs()), row.cost === null ? '' : ` · ${row.cost}`))))),
  })

  const reportsPart = (model: DrawerModel): Part => ({
    key: 'reports',
    // a report rewritten under the same name (a second Fix session's FIX-<n>.md) has a new time, so it rebuilds
    sig: JSON.stringify([model.reports.state, model.reports.message, model.reports.rows]),
    build: () => section('reports', 'Reports on disk',
      listState('reports', model.reports.state, model.reports.message, () => void loadReports()),
      model.reports.state === 'ready' && model.reports.rows.length === 0 ? h('p', { class: 'muted' }, 'No reports on disk for this PR.') : null,
      model.reports.rows.length === 0 ? null : h('ul', { class: 'drawer-list' },
        model.reports.rows.map((row) => {
          const open = reportButton(row.name, row.openName, 'Open')
          return h('li', { class: 'drawer-item' },
            h('span', { class: 'drawer-item-main' },
              h('span', { class: 'drawer-item-name mono' }, row.name),
              row.fix ? tag('Fix', 'gray') : null,
              row.verdict === null ? null : tag(row.verdict.text, row.verdict.tone),
              row.tandem ? tag('Tandem', 'blue') : null,
              open),
            h('span', { class: 'drawer-item-meta' },
              ageSpan(row.modifiedAt, '', options.nowMs()), row.sha === null ? '' : ` · at ${row.sha}`))
        }))),
  })

  // ---- drawing ----

  // the row's cell, or for a PR that left the open tables the newest run read from the server
  const latest = (): AgentCell | null => {
    if (number === null || last === null) return null
    return options.rowOf(number) === undefined ? latestCell(last.agent, runs) : last.agent
  }

  const current = (): DrawerModel | null => {
    if (number === null || last === null) return null
    const cell = latest()
    return drawerModel({ row: cell === last.agent ? last : { ...last, agent: cell }, open: options.rowOf(number) !== undefined, runs, reports, confirm, people: people ?? [] })
  }

  const render = (): void => {
    const model = current()
    const cell = latest()
    const row = last === null ? null : cell === last.agent ? last : { ...last, agent: cell }
    if (model === null || row === null || number === null) return
    const active = document.activeElement
    const focusedKey = active instanceof HTMLElement && root.contains(active) ? active.dataset.focusKey ?? 'heading' : null
    const scroll = body.scrollTop

    setText(headingLink, `#${model.header.number}`)
    const href = safeHref(model.header.url)
    if (href === null) headingLink.removeAttribute('href')
    else if (headingLink.getAttribute('href') !== href) headingLink.setAttribute('href', href)
    setText(titleLine, model.header.title)
    setText(authorLine, model.header.author)
    setText(refsLine, model.header.refs)

    const items: (Part | Keyed)[] = []
    if (model.gone !== null) items.push(goneNote(model.gone))
    items.push(startPart(model))
    const actions = actionsPart(model)
    if (actions !== null) items.push(actions)
    if (model.card === 'running') items.push(runningCard(model, row))
    else if (model.card === 'waiting') items.push(waitingCard(model, number))
    else if (model.card === 'result') items.push(resultCard(model, number))
    items.push(runsPart(model), reportsPart(model))
    sync(body, items)

    refreshAges(root, options.nowMs())
    paintConfirm()
    if (body.scrollTop !== scroll) body.scrollTop = scroll
    // a rebuilt control gets focus back; one that is gone sends it to the heading, so it is
    // never dropped on the page behind
    if (focusedKey !== null && (document.activeElement === null || document.activeElement === document.body)) {
      focusKey(focusedKey === 'heading' ? null : focusedKey)
    }
  }

  // ---- data ----

  const loadRuns = async (): Promise<void> => {
    const n = number
    if (n === null) return
    runsRequest += 1
    const mine = runsRequest
    const answer = await getJson<RunView[]>(`/api/prs/${n}/runs`)
    if (mine !== runsRequest || n !== number) return
    runs = answer.ok && Array.isArray(answer.value)
      ? { state: 'ready', items: answer.value }
      : { state: 'error', message: loadErrorText('runs', answer.status, answer.ok ? null : answer.error) }
    followGone(n)
    settleStop(latest())
    dropStaleConfirm()
    render()
  }

  // a PR that left the open tables sends no more patches: while its newest run is still going the
  // runs are read again, and when it ends the reports are, once
  const followGone = (n: number): void => {
    clearTimeout(poll)
    if (options.rowOf(n) !== undefined) {
      goneRunning = false
      return
    }
    const newest = runs.state === 'ready' ? runs.items[0] : undefined
    if (newest?.status === 'running') {
      goneRunning = true
      poll = setTimeout(() => void loadRuns(), 3_000)
    } else if (goneRunning) {
      goneRunning = false
      void loadReports()
    }
  }

  const loadReports = async (): Promise<void> => {
    const n = number
    if (n === null) return
    reportsRequest += 1
    const mine = reportsRequest
    const answer = await getJson<ReportListing[]>(`/api/prs/${n}/reports`)
    if (mine !== reportsRequest || n !== number) return
    reports = answer.ok && Array.isArray(answer.value)
      ? { state: 'ready', items: answer.value }
      : { state: 'error', message: loadErrorText('reports', answer.status, answer.ok ? null : answer.error) }
    render()
  }

  // a stop the server accepted is over when the row's run is no longer running
  const settleStop = (cell: AgentCell | null): void => {
    if (stopping === null || number === null) return
    if (cell !== null && cell.runId === stopping && cell.status === 'running') return
    stopping = null
    const wanted = openAfterStop
    openAfterStop = false
    if (!wanted) return
    options.say(resumeReadyText(number, cell?.resume != null))
    render()
    if (byKey('copy-resume') !== null) focusKey('copy-resume')
  }

  // a confirmation that can no longer be built (its run ended, its start vanished, the PR left)
  // is dropped, so a later Escape is not swallowed and a later run shows nothing nobody asked for
  const dropStaleConfirm = (): void => {
    if (confirm === null || busy) return
    const live = number === null ? undefined : options.rowOf(number)
    if (confirm.type === 'action') {
      if (last !== null && actionHolds(confirm, last, live !== undefined)) return
    } else if (confirmHolds(confirm, latest(), live !== undefined)) {
      return
    }
    confirm = null
    confirmFrom = null
    error = ''
  }

  const update = (): void => {
    if (number === null) return
    const live = options.rowOf(number)
    if (live !== undefined) last = live
    if (last === null) return
    const gone = live === undefined
    if (gone !== seen.gone) {
      seen = { ...seen, gone }
      // the feed can no longer say what the run did: read the newest run and the reports now
      if (gone) {
        void loadRuns()
        void loadReports()
      } else {
        clearTimeout(poll)
        goneRunning = false
      }
    }
    if (!gone) {
      const keys = refetchKeys(last.agent)
      if (keys.runs !== seen.runs) {
        seen = { ...seen, runs: keys.runs }
        void loadRuns()
      }
      if (keys.reports !== seen.reports) {
        seen = { ...seen, reports: keys.reports }
        void loadReports()
      }
    }
    settleStop(latest())
    dropStaleConfirm()
    render()
  }

  const open = (n: number, from: Opener, ask?: StartKind): void => {
    const row = options.rowOf(n)
    if (row === undefined) return
    opener = from
    if (number !== n) {
      if (number !== null) options.reports.close()
      number = n
      last = row
      runs = { state: 'loading' }
      reports = { state: 'loading' }
      confirm = null
      confirmFrom = null
      busy = false
      error = ''
      actionNote = ''
      actionFail = ''
      people = null
      stopping = null
      openAfterStop = false
      seen = { runs: '', reports: '', gone: false }
      clearTimeout(poll)
      goneRunning = false
      runsRequest += 1
      reportsRequest += 1
    }
    root.hidden = false
    update()
    heading.focus({ preventScroll: true })
    // a start that cannot run now opens no confirmation: the drawer shows its reason instead
    if (ask !== undefined && !busy) askStart(ask)
  }

  const close = (): void => {
    const n = number
    if (n === null) return
    number = null
    last = null
    confirm = null
    busy = false
    actionNote = ''
    actionFail = ''
    stopping = null
    openAfterStop = false
    clearTimeout(poll)
    goneRunning = false
    runsRequest += 1
    reportsRequest += 1
    // the report panel closes with the drawer; its own focus return is not wanted
    root.hidden = true
    options.reports.close()
    const selector = returnSelector(opener, n, (candidate) => document.querySelector(candidate) !== null)
    opener = null
    if (selector !== null) document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true })
  }

  closeButton.addEventListener('click', close)

  return {
    open,
    close,
    update,
    isOpen: () => number !== null,
    number: () => number,
    escape: () => {
      const target = escapeTarget({ report: options.reports.isOpen(), confirm: confirm !== null, busy, drawer: number !== null })
      if (target === 'report') options.reports.close()
      else if (target === 'confirm') cancelConfirm()
      else if (target === 'drawer') close()
      else return false
      return true
    },
    focusKey,
  }
}
