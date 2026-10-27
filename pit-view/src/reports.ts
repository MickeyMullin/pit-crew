// src/reports.ts
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

// what derive.ts needs to know about one PR's self-review report
export type ReportInfo = {
  // the file name inside reportsDir
  file: string
  // the short SHA from the `Reviewed commit:` line; null when the line is missing
  reviewedSha: string | null
  // the report file's modification time
  at: string
  // tandem drafts PR-<number>-<suffix>.md sit next to it
  tandem: boolean
}

export type ReportTarget = { number: number, headRefName: string }

const headLines = 20

export const prReportName = (number: number): string => `PR-${number}.md`

// the review commands' branch rule: anything not alphanumeric, - or _ becomes -, runs collapsed
export const branchReportName = (branch: string): string => `${branch.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-{2,}/g, '-')}.md`

const isTandemOf = (number: number) => {
  const prefix = `PR-${number}-`
  return (name: string): boolean => name.startsWith(prefix) && name.endsWith('.md') && name.length > prefix.length + 3
}

// `Reviewed commit: \`<branch>\` @ \`<short-sha>\``; the SHA is the code span after @,
// or failing that the last code span that looks like one
export const parseReviewedCommit = (lines: readonly string[]): string | null => {
  const line = lines.find((text) => /^\s*(?:[*_>#-]+\s*)?Reviewed commit:/.test(text))
  if (line === undefined) return null
  const rest = line.slice(line.indexOf('Reviewed commit:') + 'Reviewed commit:'.length)
  const afterAt = /@\s*`([0-9a-f]{4,40})`/i.exec(rest)
  if (afterAt?.[1] !== undefined) return afterAt[1].toLowerCase()
  const spans = [...rest.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '')
  const sha = spans.reverse().find((span) => /^[0-9a-f]{4,40}$/i.test(span))
  return sha === undefined ? null : sha.toLowerCase()
}

// reads at most the first 20 lines and closes the file
export const readHead = async (file: string, count = headLines): Promise<string[]> => {
  const stream = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  const head: string[] = []
  try {
    for await (const line of lines) {
      head.push(line)
      if (head.length >= count) break
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  return head
}

// the file names in reportsDir; a missing folder means no reports
export const listReports = async (dir: string): Promise<Set<string>> => {
  try {
    return new Set((await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return new Set()
    throw error
  }
}

// PR-<number>.md first, then the branch-named report; tandem drafts alone are not a report
export const findReport = async (dir: string, files: ReadonlySet<string>, target: ReportTarget): Promise<ReportInfo | null> => {
  const file = [prReportName(target.number), branchReportName(target.headRefName)].find((name) => files.has(name))
  if (file === undefined) return null
  const path = join(dir, file)
  try {
    const [head, info] = await Promise.all([readHead(path), stat(path)])
    return {
      file,
      reviewedSha: parseReviewedCommit(head),
      at: info.mtime.toISOString(),
      tandem: [...files].some(isTandemOf(target.number)),
    }
  } catch (error) {
    // removed between the listing and the read
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

// rescanned at the start of every cycle for the viewer's open PRs; keyed by PR number
export const scanReports = async (dir: string, targets: readonly ReportTarget[]): Promise<Map<number, ReportInfo>> => {
  const files = await listReports(dir)
  const found = await Promise.all(targets.map(async (target) => [target.number, await findReport(dir, files, target)] as const))
  const reports = new Map<number, ReportInfo>()
  for (const [number, report] of found) {
    if (report !== null) reports.set(number, report)
  }
  return reports
}
