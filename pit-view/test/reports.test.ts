// test/reports.test.ts
import assert from 'node:assert/strict'
import { utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { branchReportName, listReports, parseReviewedCommit, readHead, scanReports } from '../src/reports.ts'
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
