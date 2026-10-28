// public/agentcell.ts
// the Agent cell's elements, state by state (agent.ts says what each one reads), the running
// timer that moves without a redraw, and the resume command's Copy; app.ts handles the clicks
import type { AgentCell } from '../src/launcher.ts'
import { cellModel, runningLine } from './agent.ts'
import { h, setText } from './dom.ts'

// the cell's signature leaves out every text that moves with the clock (the last review's age,
// the running timer, the finish age) and a running cell's step: a minute going by or a new step
// never rebuilds the cell, so its button stays the same element under the pointer and the
// keyboard; updateAgentCells sets those texts in place after each draw, and the ticker the timer
export const agentCellSig = (cell: AgentCell | null, number: number, nowMs: number): unknown => {
  if (cell === null) return null
  const model = cellModel(cell, number, nowMs)
  if (model.state === 'idle') return { ...model, under: model.under !== null }
  if (model.state === 'running') return { state: model.state, label: model.label, stop: model.stop, runId: cell.runId, startedAt: cell.startedAt }
  return { ...model, line: model.line !== '' }
}

// after each draw: every cell's moving line, and a running cell's step as its tooltip and hidden text
export const updateAgentCells = (root: ParentNode, rows: readonly { number: number, agent: AgentCell | null }[], nowMs: number): void => {
  for (const row of rows) {
    const cell = row.agent
    if (cell === null) continue
    const box = root.querySelector<HTMLElement>(`tr[data-pr="${row.number}"] .agent`)
    const line = box?.querySelector<HTMLElement>('[data-agent-line]')
    if (box == null || line == null) continue
    const model = cellModel(cell, row.number, nowMs)
    if (model.state === 'idle') {
      setText(line, model.under ?? '')
      continue
    }
    if (model.state === 'done') {
      setText(line, model.line)
      continue
    }
    if (line.dataset.stepAt !== (cell.lastStepAt ?? undefined)) {
      if (cell.lastStepAt === null) delete line.dataset.stepAt
      else line.dataset.stepAt = cell.lastStepAt
    }
    if (line.title !== model.step) line.title = model.step
    setText(line, model.line)
    const hidden = box.querySelector('.agent-step')
    if (hidden !== null) setText(hidden, model.step)
  }
}

// a line the ticker keeps current: the run's start and its newest step travel with it
export const timerLine = (cell: Pick<AgentCell, 'startedAt' | 'lastStepAt'>, nowMs: number, attrs: Record<string, string | null> = {}): HTMLSpanElement =>
  h('span', { ...attrs, 'data-agent-timer': '', 'data-started': cell.startedAt, 'data-step-at': cell.lastStepAt }, runningLine(cell, nowMs))

// every running line on the page, the dialog's included, brought up to the clock
export const tickTimers = (root: ParentNode, nowMs: number): void => {
  for (const element of root.querySelectorAll<HTMLElement>('[data-agent-timer]')) {
    setText(element, runningLine({ startedAt: element.dataset.started ?? null, lastStepAt: element.dataset.stepAt ?? null }, nowMs))
  }
}

// the buttons name their PR, and carry data-focus so focus comes back to them across a rebuild
const button = (kind: 'start' | 'again' | 'stop' | 'copy', number: number, name: string, text: string, extra: string): HTMLButtonElement =>
  h('button', {
    type: 'button',
    class: `agent-button agent-${kind} ${extra}`.trim(),
    'data-agent': kind,
    'data-pr': number,
    'aria-label': name,
    title: name,
    'data-focus': `agent-${kind}`,
    'data-focus-key': `agent-${kind}:${number}`,
  }, text)

export const agentCellNodes = (cell: AgentCell | null, number: number, nowMs: number): Node[] => {
  if (cell === null) return [h('span', { class: 'muted' }, '—')]
  const model = cellModel(cell, number, nowMs)
  if (model.state === 'idle') {
    return [h('span', { class: 'agent agent-idle' },
      button('start', number, model.name, model.button, ''),
      model.under === null ? null : h('span', { class: 'agent-line', 'data-agent-line': '' }, model.under))]
  }
  if (model.state === 'running') {
    return [h('span', { class: 'agent agent-running' },
      h('span', { class: 'agent-head' },
        h('span', { class: 'agent-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'agent-label' }, model.label),
        button('stop', number, model.stop, 'Stop', 'agent-small')),
      timerLine(cell, nowMs, { class: 'agent-line', 'data-agent-line': '', title: model.step }),
      h('span', { class: 'sr-only agent-step' }, model.step))]
  }
  return [h('span', { class: 'agent agent-done' },
    h('span', { class: `agent-text tone-text-${model.tone}`, title: model.tip },
      model.text,
      model.tip === null ? null : h('span', { class: 'sr-only' }, `: ${model.tip}`)),
    model.line === '' ? null : h('span', { class: 'agent-line', 'data-agent-line': '' }, model.line),
    model.copy === null && model.again === null
      ? null
      : h('span', { class: 'agent-actions' },
          model.copy === null ? null : button('copy', number, model.copy.name, 'Copy resume command', 'agent-small'),
          model.again === null ? null : button('again', number, model.again.name, 'Run again', 'agent-small')))]
}

// the clipboard, or a selected textarea and the copy command where the clipboard is refused
// (a page reached over plain http by a name other than localhost has no navigator.clipboard)
export const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // fall through to the textarea
  }
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const area = h('textarea', { class: 'copy-buffer', readonly: true, 'aria-hidden': 'true', tabindex: '-1' })
  area.value = text
  document.body.appendChild(area)
  area.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  area.remove()
  active?.focus({ preventScroll: true })
  return copied
}
