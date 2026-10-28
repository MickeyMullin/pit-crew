// public/agentcell.ts
// the Agent cell's elements, state by state (agent.ts says what each one reads), the running
// timer that moves without a redraw, and the clipboard helper the drawer uses; the cell is one
// button that opens the drawer, and app.ts handles the click
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
  if (model.state === 'running') return { state: model.state, label: model.label, name: model.name, runId: cell.runId, startedAt: cell.startedAt }
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

// a line the ticker keeps current: the run's start and its newest step travel with it, and a
// suffix such as the head SHA stays at its end
export const timerLine = (
  cell: Pick<AgentCell, 'startedAt' | 'lastStepAt'>,
  nowMs: number,
  attrs: Record<string, string | null> = {},
  suffix = '',
): HTMLSpanElement =>
  h('span', {
    ...attrs,
    'data-agent-timer': '',
    'data-started': cell.startedAt,
    'data-step-at': cell.lastStepAt,
    'data-suffix': suffix === '' ? null : suffix,
  }, `${runningLine(cell, nowMs)}${suffix === '' ? '' : ` · ${suffix}`}`)

// every running line on the page, the drawer's included, brought up to the clock
export const tickTimers = (root: ParentNode, nowMs: number): void => {
  for (const element of root.querySelectorAll<HTMLElement>('[data-agent-timer]')) {
    const line = runningLine({ startedAt: element.dataset.started ?? null, lastStepAt: element.dataset.stepAt ?? null }, nowMs)
    const suffix = element.dataset.suffix
    setText(element, suffix === undefined ? line : `${line} · ${suffix}`)
  }
}

// the cell's one button: it opens the drawer, and carries data-focus so focus comes back to it
// across a rebuild
const openButton = (number: number, name: string, extra: string, children: (Node | string | null)[]): HTMLButtonElement =>
  h('button', {
    type: 'button',
    class: `agent-button ${extra}`.trim(),
    'data-agent': 'open',
    'data-pr': number,
    'aria-label': name,
    title: name,
    'data-focus': 'agent-open',
    'data-focus-key': `agent-open:${number}`,
  }, children)

export const agentCellNodes = (cell: AgentCell | null, number: number, nowMs: number): Node[] => {
  if (cell === null) return [h('span', { class: 'muted' }, '—')]
  const model = cellModel(cell, number, nowMs)
  if (model.state === 'idle') {
    return [h('span', { class: 'agent agent-idle' },
      openButton(number, model.name, 'agent-start', [model.button]),
      model.under === null ? null : h('span', { class: 'agent-line', 'data-agent-line': '' }, model.under))]
  }
  if (model.state === 'running') {
    return [h('button', {
      type: 'button',
      class: 'agent agent-open agent-running',
      'data-agent': 'open',
      'data-pr': number,
      'aria-label': model.name,
      'data-focus': 'agent-open',
      'data-focus-key': `agent-open:${number}`,
    },
    h('span', { class: 'agent-head' },
      h('span', { class: 'agent-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'agent-label' }, model.label)),
    timerLine(cell, nowMs, { class: 'agent-line', 'data-agent-line': '', title: model.step }),
    h('span', { class: 'sr-only agent-step' }, model.step))]
  }
  return [h('button', {
    type: 'button',
    class: 'agent agent-open agent-done',
    'data-agent': 'open',
    'data-pr': number,
    'aria-label': model.name,
    'data-focus': 'agent-open',
    'data-focus-key': `agent-open:${number}`,
  },
  h('span', { class: `agent-text tone-text-${model.tone}`, title: model.tip }, model.text),
  model.line === '' ? null : h('span', { class: 'agent-line', 'data-agent-line': '' }, model.line))]
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
