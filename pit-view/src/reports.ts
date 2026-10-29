// src/reports.ts
import { createReadStream } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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

// fix-pr's report, one per PR and never a self-review
export const fixReportName = (number: number): string => `FIX-${number}.md`
export const fixReportPattern = /^FIX-\d+\.md$/

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

// PR-<number>.md first, then the branch-named report; tandem drafts alone are not a report, and
// neither is a fix report, even for a branch whose name would make one
export const findReport = async (dir: string, files: ReadonlySet<string>, target: ReportTarget): Promise<ReportInfo | null> => {
  const file = [prReportName(target.number), branchReportName(target.headRefName)].find((name) => files.has(name) && !fixReportPattern.test(name))
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

// reports on disk for the drawer (section 8 of DESIGN.md, Drawer)

export type ReportVerdict = 'changesRequested' | 'clean'

export type ReportListing = {
  name: string
  // a review's report (PR-<n>.md and its drafts) or fix-pr's (FIX-<n>.md)
  kind: 'review' | 'fix'
  modifiedAt: string
  // as the report writes it (short): a review's `Reviewed commit:` SHA, a fix's head from its `PR:`
  // line; null when it has none
  sha: string | null
  // null for a fix report
  verdict: ReportVerdict | null
  // a tandem draft, or a review report with tandem drafts next to it; false for a fix report
  tandem: boolean
}

// fix-pr's first line: PR: #<number> `<branch>` @ `<short head SHA>`
export const parseFixHead = (lines: readonly string[]): string | null => {
  const line = lines.find((text) => /^\s*PR:\s*#\d+/.test(text))
  if (line === undefined) return null
  const sha = /@\s*`([0-9a-f]{4,40})`/i.exec(line)?.[1]
  return sha === undefined ? null : sha.toLowerCase()
}

// how much of a report is read to tell its verdict: the summary index is at the top
const verdictBytes = 256 * 1024
// a fix report is read only for its first lines
const headBytes = 16 * 1024

// the review prompts' own format: the summary index lists `- **P1**` bullets and each finding
// opens with `**[P1] title**`; any P0, P1 or P2 means changes requested, P3 only or
// "No actionable findings." means clean, and a file in neither form says nothing
export const parseVerdict = (text: string): ReportVerdict | null => {
  const found = new Set<string>()
  for (const line of text.split('\n')) {
    const priority = /^\s*\*\*\[(P[0-3])\]/.exec(line)?.[1] ?? /^\s*[-*]\s+\*\*(P[0-3])\*\*\s*$/.exec(line)?.[1]
    if (priority !== undefined) found.add(priority)
  }
  if (['P0', 'P1', 'P2'].some((priority) => found.has(priority))) return 'changesRequested'
  if (found.has('P3') || /^\s*No actionable findings\./m.test(text)) return 'clean'
  return null
}

// the first bytes of a file, decoded; a multi-byte character cut at the end shows as a replacement
const readPrefix = async (path: string, bytes: number): Promise<string> => {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

// PR-<number>.md and its suffixed drafts PR-<number>-<suffix>.md; PR-1010.md is not PR 101's
// and only a name the report endpoint would accept, so every listed report can be opened
const belongsTo = (number: number) => {
  const own = `PR-${number}.md`
  const prefix = `PR-${number}-`
  return (name: string): boolean =>
    isReportName(name) && (name === own || (name.startsWith(prefix) && name.endsWith('.md') && name.length > prefix.length + 3))
}

// a PR's reports in dir, newest first: its review reports and its fix report; a missing folder
// means none. Only regular files directly in dir are listed, so a symlink never leads out of it
export const listPrReports = async (dir: string, number: number): Promise<ReportListing[]> => {
  const files = await listReports(dir)
  const reviews = [...files].filter(belongsTo(number))
  const drafts = reviews.some((name) => name !== prReportName(number))
  const names = files.has(fixReportName(number)) ? [...reviews, fixReportName(number)] : reviews
  const listed = await Promise.all(names.map(async (name): Promise<ReportListing | null> => {
    const path = join(dir, name)
    const fix = name === fixReportName(number)
    try {
      const [text, info] = await Promise.all([readPrefix(path, fix ? headBytes : verdictBytes), stat(path)])
      const head = text.split('\n').slice(0, headLines)
      return fix
        ? { name, kind: 'fix', modifiedAt: info.mtime.toISOString(), sha: parseFixHead(head), verdict: null, tandem: false }
        : { name, kind: 'review', modifiedAt: info.mtime.toISOString(), sha: parseReviewedCommit(head), verdict: parseVerdict(text), tandem: drafts }
    } catch (error) {
      // removed between the listing and the read
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }))
  return listed.filter((entry) => entry !== null).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name))
}

export const reportNamePattern = /^PR-\d+[A-Za-z0-9._-]*\.md$/
export const isReportName = (name: string): boolean => (reportNamePattern.test(name) || fixReportPattern.test(name)) && !name.includes('..')
export const maxReportBytes = 1024 * 1024

export type ReportReadErrorCode = 'badName' | 'notFound' | 'tooLarge'

export class ReportReadError extends Error {
  override name = 'ReportReadError'
  code: ReportReadErrorCode
  constructor (code: ReportReadErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export type ReportFile = { name: string, modifiedAt: string, raw: string }

const absent = (error: unknown): boolean => ['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')

// one report's text. The name must be a report's, and the file it resolves to (symlinks followed)
// must be a regular file directly inside the folder reportsDir resolves to; anything else is not found
export const readReport = async (dir: string, name: string, limit = maxReportBytes): Promise<ReportFile> => {
  if (!isReportName(name)) throw new ReportReadError('badName', 'a report is named like PR-101.md or FIX-101.md')
  let root: string
  let path: string
  try {
    root = await realpath(dir)
    path = await realpath(join(root, name))
  } catch (error) {
    if (absent(error)) throw new ReportReadError('notFound', `no report named ${name}`)
    throw error
  }
  if (dirname(path) !== root) throw new ReportReadError('notFound', `no report named ${name}`)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if (absent(error)) throw new ReportReadError('notFound', `no report named ${name}`)
    throw error
  }
  try {
    // the size is read from the open file, so what is checked is what is read
    const info = await handle.stat()
    if (!info.isFile()) throw new ReportReadError('notFound', `no report named ${name}`)
    if (info.size > limit) throw new ReportReadError('tooLarge', `${name} is larger than ${Math.floor(limit / 1024)} KB`)
    const buffer = Buffer.alloc(info.size)
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0)
    return { name, modifiedAt: info.mtime.toISOString(), raw: buffer.subarray(0, bytesRead).toString('utf8') }
  } finally {
    await handle.close()
  }
}
