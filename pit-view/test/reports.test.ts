// test/reports.test.ts
import assert from 'node:assert/strict'
import { mkdir, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { branchReportName, isReportName, listPrReports, listReports, parseReviewedCommit, parseVerdict, readHead, readReport, ReportReadError, scanReports } from '../src/reports.ts'
import { tempDir } from './helpers.ts'

// invented report bodies in the review commands' format
const report = (branch: string, sha: string, extra = ''): string =>
  `Reviewed commit: \`${branch}\` @ \`${sha}\`\nFix attempts: 0\n\n## Summary\n\nNothing to see.\n${extra}`

const fixedTime = new Date('2026-10-26T12:00:00Z')

const write = async (dir: string, name: string, body: string): Promise<void> => {
  await writeFile(join(dir, name), body, 'utf8')
  await utimes(join(dir, name), fixedTime, fixedTime)
}

test('branch-named reports replace odd characters with - and collapse runs', () => {
  assert.equal(branchReportName('feat/sync-status-endpoint'), 'feat-sync-status-endpoint.md')
  assert.equal(branchReportName('fix//weird..name_ok'), 'fix-weird-name_ok.md')
  assert.equal(branchReportName('chore/a b+c'), 'chore-a-b-c.md')
})

test('the reviewed SHA is the code span after @ on the first Reviewed commit line', () => {
  assert.equal(parseReviewedCommit(['Reviewed commit: `fix/webhook-retry` @ `E37EACD`']), 'e37eacd')
  assert.equal(parseReviewedCommit(['# Review', '**Reviewed commit:** `feat/x` @ `b5d43a3`', 'Reviewed commit: `feat/x` @ `0000000`']), 'b5d43a3')
  // without the @ form, the last code span that looks like a SHA
  assert.equal(parseReviewedCommit(['Reviewed commit: `deadbee` on `main`']), 'deadbee')
  assert.equal(parseReviewedCommit(['Reviewed commit: `feat/x`']), null)
  assert.equal(parseReviewedCommit(['Reviewed stack: `a` @ `1234567`']), null)
  assert.equal(parseReviewedCommit([]), null)
})

test('only the first 20 lines of a report are read', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`)
    await write(dir, 'long.md', lines.join('\n'))
    const head = await readHead(join(dir, 'long.md'))
    assert.equal(head.length, 20)
    assert.equal(head.at(-1), 'line 20')
  } finally {
    await cleanup()
  }
})

test('a missing reports folder means no reports', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    assert.equal((await listReports(join(dir, 'absent'))).size, 0)
    assert.equal((await scanReports(join(dir, 'absent'), [{ number: 101, headRefName: 'fix/webhook-retry' }])).size, 0)
  } finally {
    await cleanup()
  }
})

test('reports are found by PR number, then by branch, with tandem siblings', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    await write(dir, 'PR-101.md', report('fix/webhook-retry', 'e37eacd'))
    await write(dir, 'PR-101-secondary.md', report('fix/webhook-retry', 'e37eacd'))
    // the PR report wins over a branch-named one
    await write(dir, 'fix-webhook-retry.md', report('fix/webhook-retry', '0000000'))
    await write(dir, 'feat-sync-status-endpoint.md', report('feat/sync-status-endpoint', 'aaaaaaa'))
    // a tandem draft alone is not a report
    await write(dir, 'PR-120-secondary.md', report('chore/flags-to-env', '982d87f'))
    // PR-10's drafts do not make PR-101 or PR-102 tandem
    await write(dir, 'PR-102.md', report('docs/local-setup', '59182cb'))
    await write(dir, 'PR-10-secondary.md', report('other', '1111111'))
    // a Reviewed commit line past line 20 is not read
    await write(dir, 'PR-103.md', `${'filler\n'.repeat(20)}Reviewed commit: \`feat/fuzzy-customer-search\` @ \`6d5d12c\`\n`)

    const reports = await scanReports(dir, [
      { number: 101, headRefName: 'fix/webhook-retry' },
      { number: 102, headRefName: 'docs/local-setup' },
      { number: 103, headRefName: 'feat/fuzzy-customer-search' },
      { number: 104, headRefName: 'feat/sync-status-endpoint' },
      { number: 120, headRefName: 'chore/flags-to-env' },
    ])
    assert.deepEqual([...reports.keys()].sort(), [101, 102, 103, 104])
    assert.deepEqual(reports.get(101), { file: 'PR-101.md', reviewedSha: 'e37eacd', at: fixedTime.toISOString(), tandem: true })
    assert.deepEqual(reports.get(102), { file: 'PR-102.md', reviewedSha: '59182cb', at: fixedTime.toISOString(), tandem: false })
    assert.equal(reports.get(103)?.reviewedSha, null)
    assert.deepEqual(reports.get(104), { file: 'feat-sync-status-endpoint.md', reviewedSha: 'aaaaaaa', at: fixedTime.toISOString(), tandem: false })
  } finally {
    await cleanup()
  }
})

// reports on disk for the drawer

const findings = (priorities: string[]): string =>
  `Reviewed commit: \`feat/x\` @ \`abc1234\`\n\n## Summary\n\n${priorities.map((priority) => `- **${priority}**\n  - Something (a.ts)`).join('\n')}\n\n## Findings\n\n${priorities.map((priority) => `**[${priority}] Something**\n\nWhy.\n`).join('\n')}`

test('the verdict is changes requested for any P0, P1 or P2, clean for P3 only or no findings, and nothing otherwise', () => {
  assert.equal(parseVerdict(findings(['P1', 'P3'])), 'changesRequested')
  assert.equal(parseVerdict(findings(['P2'])), 'changesRequested')
  assert.equal(parseVerdict(findings(['P0'])), 'changesRequested')
  assert.equal(parseVerdict(findings(['P3'])), 'clean')
  assert.equal(parseVerdict('Reviewed commit: `x` @ `abc1234`\n\n## Summary\n\nNo actionable findings.\n\n## Findings\n\nNo actionable findings.\n'), 'clean')
  assert.equal(parseVerdict(report('feat/x', 'abc1234')), null)
  assert.equal(parseVerdict(''), null)
  // a P1 only mentioned in prose is not a finding
  assert.equal(parseVerdict('Earlier I called this a [P1] but it is fine.\n\nNo actionable findings.\n'), 'clean')
})

test('a PR\'s reports are listed newest first with sha, verdict and tandem, and only that PR\'s files', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    await write(dir, 'PR-101.md', findings(['P1']))
    await utimes(join(dir, 'PR-101.md'), new Date('2026-10-26T12:00:00Z'), new Date('2026-10-26T12:00:00Z'))
    await write(dir, 'PR-101-codex.md', findings(['P3']))
    await utimes(join(dir, 'PR-101-codex.md'), new Date('2026-10-26T13:00:00Z'), new Date('2026-10-26T13:00:00Z'))
    await write(dir, 'PR-1010.md', findings(['P1']))
    await write(dir, 'PR-102.md', findings(['P1']))
    await write(dir, 'STACK-101.md', findings(['P1']))
    await write(dir, 'PR-101.txt', 'nope')
    await write(dir, 'PR-101-.md', 'nope')
    await mkdir(join(dir, 'PR-101-dir.md'))
    assert.deepEqual(await listPrReports(dir, 101), [
      { name: 'PR-101-codex.md', modifiedAt: '2026-10-26T13:00:00.000Z', sha: 'abc1234', verdict: 'clean', tandem: true },
      { name: 'PR-101.md', modifiedAt: '2026-10-26T12:00:00.000Z', sha: 'abc1234', verdict: 'changesRequested', tandem: true },
    ])
    assert.deepEqual((await listPrReports(dir, 102)).map((entry) => [entry.name, entry.tandem]), [['PR-102.md', false]])
    assert.deepEqual(await listPrReports(dir, 103), [])
    assert.deepEqual(await listPrReports(join(dir, 'missing'), 101), [])
  } finally {
    await cleanup()
  }
})

test('a report with no Reviewed commit line or no findings lists with nulls', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    await write(dir, 'PR-105.md', '# Notes\n\nfree text\n')
    assert.deepEqual((await listPrReports(dir, 105)).map((entry) => [entry.sha, entry.verdict, entry.tandem]), [[null, null, false]])
  } finally {
    await cleanup()
  }
})

test('a symlink in reportsDir is never listed', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    await mkdir(join(dir, 'reports'))
    await mkdir(join(dir, 'outside'))
    await write(join(dir, 'outside'), 'secret.md', 'top secret')
    await symlink(join(dir, 'outside', 'secret.md'), join(dir, 'reports', 'PR-106.md'))
    assert.deepEqual(await listPrReports(join(dir, 'reports'), 106), [])
  } finally {
    await cleanup()
  }
})

test('only files the report endpoint would open are listed, so a listed report always opens', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const names = ['PR-107.md', 'PR-107-secondary.md', 'PR-107-r2.v1.md', 'PR-107-a b.md', 'PR-107-é.md', 'PR-107-a..b.md', 'PR-107-a;b.md', 'PR-107-x.md.bak']
    for (const name of names) await write(dir, name, 'Reviewed commit: `x` @ `abc1234`\n')
    const listed = (await listPrReports(dir, 107)).map((entry) => entry.name).sort()
    assert.deepEqual(listed, ['PR-107-r2.v1.md', 'PR-107-secondary.md', 'PR-107.md'])
    for (const name of listed) assert.equal((await readReport(dir, name)).name, name)
    // the same rule decides what the endpoint reads
    assert.ok(isReportName('PR-107-r2.v1.md') && !isReportName('PR-107-a..b.md') && !isReportName('PR-107-a b.md'))
  } finally {
    await cleanup()
  }
})

const refused = (code: string) => (error: unknown): boolean => error instanceof ReportReadError && error.code === code

test('a report is read by name from directly inside reportsDir, and anything else is refused', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const reports = join(dir, 'reports')
    await mkdir(join(reports, 'nested'), { recursive: true })
    await mkdir(join(dir, 'outside'))
    await write(reports, 'PR-101.md', 'Reviewed commit: `x` @ `abc1234`\n')
    await write(reports, 'PR-101-r2.v1.md', 'draft')
    await write(reports, 'notes.md', 'not a report name')
    await write(join(reports, 'nested'), 'PR-103.md', 'nested')
    await write(join(dir, 'outside'), 'PR-104.md', 'outside')
    await write(dir, 'PR-105.md', 'parent')
    await symlink(join(dir, 'outside', 'PR-104.md'), join(reports, 'PR-104.md'))
    await symlink(join(dir, 'PR-105.md'), join(reports, 'PR-105.md'))
    await symlink(join(reports, 'nested', 'PR-103.md'), join(reports, 'PR-103.md'))
    await symlink(join(reports, 'PR-101.md'), join(reports, 'PR-106.md'))
    await symlink(join(dir, 'outside'), join(reports, 'PR-107.md'))
    await mkdir(join(reports, 'PR-108.md'))

    assert.deepEqual(await readReport(reports, 'PR-101.md'), { name: 'PR-101.md', modifiedAt: '2026-10-26T12:00:00.000Z', raw: 'Reviewed commit: `x` @ `abc1234`\n' })
    assert.equal((await readReport(reports, 'PR-101-r2.v1.md')).raw, 'draft')
    // a symlink to another file directly inside the folder resolves inside it
    assert.equal((await readReport(reports, 'PR-106.md')).raw, 'Reviewed commit: `x` @ `abc1234`\n')

    for (const name of ['../PR-105.md', '..%2FPR-105.md', 'PR-1/../PR-101.md', 'sub/PR-103.md', '/etc/passwd', 'PR-101.md/', 'PR-101.md\0.md', 'PR-..md', 'PR-1..md', '', 'PR-.md', 'PR-x.md', 'notes.md', 'PR-101.txt', 'pr-101.md', 'PR-101.md\n']) {
      await assert.rejects(readReport(reports, name), refused('badName'), JSON.stringify(name))
    }
    // outside the folder, below it, a directory, or absent
    for (const name of ['PR-104.md', 'PR-105.md', 'PR-103.md', 'PR-107.md', 'PR-108.md', 'PR-999.md']) {
      await assert.rejects(readReport(reports, name), refused('notFound'), name)
    }
    await assert.rejects(readReport(join(dir, 'missing'), 'PR-101.md'), refused('notFound'))
  } finally {
    await cleanup()
  }
})

test('a report over the size limit is refused, and one at the limit is read', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    await write(dir, 'PR-101.md', 'x'.repeat(100))
    await write(dir, 'PR-102.md', 'x'.repeat(101))
    assert.equal((await readReport(dir, 'PR-101.md', 100)).raw.length, 100)
    await assert.rejects(readReport(dir, 'PR-102.md', 100), refused('tooLarge'))
  } finally {
    await cleanup()
  }
})

test('reportsDir may itself be a symlink: the configured folder is followed, files inside it still must not leave', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    await mkdir(join(dir, 'real'))
    await symlink(join(dir, 'real'), join(dir, 'output'))
    await write(join(dir, 'real'), 'PR-101.md', 'ok')
    assert.equal((await readReport(join(dir, 'output'), 'PR-101.md')).raw, 'ok')
    assert.deepEqual((await listPrReports(join(dir, 'output'), 101)).map((entry) => entry.name), ['PR-101.md'])
  } finally {
    await cleanup()
  }
})
