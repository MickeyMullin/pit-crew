// test/table-model.ts
// the model the page hands the real table renderer (public/tables.ts), for tests that draw real rows on the fake document in test/fake-dom.ts
import { closedColumns, mineColumns, othersColumns } from '../public/tables.ts'
import type { TableModel } from '../public/tables.ts'
import type { ClosedRange, ClosedRow, OpenRow } from '../src/derive.ts'
import { scenario } from './fixtures/scenario.ts'

const contextOf = (nowMs: number) => ({ view: { repo: scenario.repo, sweeps: { items: [] }, now: scenario.now, sync: { cycle: null } }, nowMs, paused: false, terms: [], queryTerms: [] })

const model = (table: string, columns: unknown, rows: readonly { number: number }[], nowMs: number): TableModel<never> => ({
  table,
  columns,
  groups: [{ key: 'all', label: 'All', sub: '', rows, collapsible: false, open: true }],
  ctx: contextOf(nowMs),
  state: 'ready', emptyText: 'none', numberOf: (row: { number: number }) => row.number, rowClass: () => 'row', freshnessOf: () => null, onToggleGroup: () => undefined, sort: null, onSort: () => undefined,
}) as unknown as TableModel<never>

export const openTable = (table: 'mine' | 'others', rows: readonly OpenRow[], nowMs: number): TableModel<never> =>
  model(table, table === 'mine' ? mineColumns(true) : othersColumns(true), rows, nowMs)

export const closedTable = (range: ClosedRange, rows: readonly ClosedRow[], nowMs: number): TableModel<never> =>
  model('closed', closedColumns(range), rows, nowMs)
