// public/agentdialog.ts
// the confirmation before starting or stopping a run: a modal <dialog>, so focus moves into it,
// stays there and Escape cancels; focus goes back to the cell when it closes, and a refusal is
// shown inside it, never as an alert()
import type { OpenRow } from '../src/derive.ts'
import { refusalText, runnerLabels, runnerNames, startConfirm, startRequest, stopConfirm, stopRequest } from './agent.ts'
import type { RunnerName, RunRequest } from './agent.ts'
import { timerLine } from './agentcell.ts'
import { h } from './dom.ts'

export type AgentDialogOptions = {
  dialog: HTMLDialogElement
  // the token this page was served with, from <meta name="pit-view-token">
  token: string
  viewer: () => string
  nowMs: () => number
  // the dialog closed, started or not: focus goes back to that PR's cell
  onClosed: (number: number) => void
}

export type AgentDialog = {
  start: (row: OpenRow) => void
  stop: (row: OpenRow) => void
}

// the meta tag the server inserts into each page it serves; empty when missing, which the
// server then refuses with 403, read as "reload the page"
export const readToken = (doc: Document): string =>
  doc.querySelector('meta[name="pit-view-token"]')?.getAttribute('content') ?? ''

// sends a run request; status 0 when Pit View did not answer
const send = async (request: RunRequest): Promise<{ status: number, error: string | null }> => {
  try {
    const response = await fetch(request.url, request.init)
    if (response.ok) return { status: response.status, error: null }
    const body = await response.json().catch(() => null) as { error?: unknown } | null
    return { status: response.status, error: typeof body?.error === 'string' ? body.error : null }
  } catch {
    return { status: 0, error: null }
  }
}

export const createAgentDialog = (options: AgentDialogOptions): AgentDialog => {
  const { dialog } = options
  let number: number | null = null
  let busy = false

  // nothing closes it while a request is on its way, so its answer always has somewhere to go
  dialog.addEventListener('cancel', (event) => {
    if (busy) event.preventDefault()
  })
  dialog.addEventListener('close', () => {
    const closed = number
    number = null
    dialog.replaceChildren()
    if (closed !== null) options.onClosed(closed)
  })

  const facts = (rows: [string, Node | string][]): HTMLDListElement =>
    h('dl', { class: 'dialog-facts' }, rows.flatMap(([term, value]) => [h('dt', {}, term), h('dd', {}, value)]))

  // heading, the PR's title, the facts, a slot for a refusal, and Cancel beside the action;
  // Cancel takes focus first, since the action may post on GitHub
  const open = (row: OpenRow, heading: string, body: Node[], confirm: string, tone: 'primary' | 'danger', act: (error: HTMLElement, button: HTMLButtonElement) => Promise<void>): void => {
    if (dialog.open) dialog.close()
    number = row.number
    busy = false
    const error = h('p', { id: 'agent-dialog-error', class: 'dialog-error', role: 'alert' })
    const cancel = h('button', { type: 'button', class: 'button', autofocus: true }, 'Cancel')
    const action = h('button', { type: 'button', class: `button button-${tone}`, 'aria-describedby': 'agent-dialog-error' }, confirm)
    cancel.addEventListener('click', () => {
      if (!busy) dialog.close()
    })
    action.addEventListener('click', () => {
      if (busy) return
      busy = true
      action.disabled = true
      cancel.disabled = true
      error.textContent = ''
      void act(error, action).finally(() => {
        busy = false
        if (!dialog.open) return
        action.disabled = false
        cancel.disabled = false
      })
    })
    dialog.replaceChildren(
      h('h2', { id: 'agent-dialog-heading', class: 'dialog-heading' }, heading),
      h('p', { class: 'dialog-title' }, row.title),
      ...body,
      error,
      h('div', { class: 'dialog-actions' }, cancel, action))
    dialog.setAttribute('aria-labelledby', 'agent-dialog-heading')
    dialog.showModal()
  }

  const start = (row: OpenRow): void => {
    const cell = row.agent
    if (cell === null) return
    let runner: RunnerName = cell.action.runner
    const text = () => startConfirm(row, cell.action, runner, options.viewer())
    const command = h('code', { class: 'dialog-command mono' }, text().command)
    const choices = h('span', { class: 'dialog-runners', role: 'radiogroup', 'aria-labelledby': 'agent-dialog-runner' },
      runnerNames.map((name) => {
        const input = h('input', { type: 'radio', name: 'agent-runner', value: name, checked: name === runner })
        input.addEventListener('change', () => {
          if (!input.checked) return
          runner = name
          command.textContent = text().command
        })
        return h('label', { class: 'dialog-runner' }, input, runnerLabels[name])
      }))
    const confirm = text()
    open(row, confirm.heading, [
      facts([
        ['Command', command],
        ['Runner', choices],
        ['On GitHub', confirm.effect],
      ]),
    ], confirm.confirm, 'primary', async (error, button) => {
      button.textContent = 'Starting…'
      const answer = await send(startRequest(row.number, runner, options.token))
      if (answer.status >= 200 && answer.status < 300) {
        dialog.close()
        return
      }
      button.textContent = confirm.confirm
      error.textContent = refusalText('start', answer.status, answer.error)
    })
    // the Runner term labels the radio group
    dialog.querySelector('.dialog-facts dt:nth-of-type(2)')?.setAttribute('id', 'agent-dialog-runner')
  }

  const stop = (row: OpenRow): void => {
    const cell = row.agent
    if (cell === null || cell.runId === null) return
    const runId = cell.runId
    const confirm = stopConfirm(row, cell, options.nowMs())
    open(row, confirm.heading, [
      facts([
        ['Run', h('span', {}, `${confirm.detail}, `, timerLine(cell, options.nowMs()))],
        ['Stopping', confirm.effect],
      ]),
    ], confirm.confirm, 'danger', async (error, button) => {
      button.textContent = 'Stopping…'
      const answer = await send(stopRequest(runId, options.token))
      if (answer.status >= 200 && answer.status < 300) {
        dialog.close()
        return
      }
      button.textContent = confirm.confirm
      error.textContent = refusalText('stop', answer.status, answer.error)
    })
  }

  return { start, stop }
}
