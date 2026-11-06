// public/mergeoffer.ts
// the one rule for offering Merge, shared by the merge state (deriveMerge in src/derive.ts), the page (the idle Agent button and the drawer's Squash and merge), and the server's guard (src/actions.ts), so they cannot disagree. Merge is offered only on the viewer's own, non-draft PR into the primary branch that is approved (reviewDecision APPROVED; REVIEW_REQUIRED and null are not approved), not conflicting, with no withholding chip (Changes requested, Conflicts, CI failing, or CI running; CI not run and CI canceled do not withhold), and whose merge status is CLEAN, HAS_HOOKS, or UNKNOWN. It imports types only, because the server and the browser both load it.
import type { Issue, IssueKind, MergeState, MineGroup } from '../src/derive.ts'
import type { RawOpenPr } from '../src/github.ts'

// a change is requested, the PR conflicts, or a check is failing or still running: these withhold Merge whatever GitHub reports. CI not run and CI canceled do not: a repository without checks merges, and a canceled run says nothing about the head
const withholdingIssues: readonly IssueKind[] = ['changesRequested', 'conflicts', 'ciFailing', 'ciRunning']

const carries = (issues: readonly Pick<Issue, 'kind'>[], kinds: readonly IssueKind[]): boolean => issues.some((issue) => kinds.includes(issue.kind))

// the states of a PR the rule admits, read before anything else about its merge state. Ready when GitHub's answer is mergeable, Checking when GitHub has not finished computing it (the server's live read before the write refuses if it is still unknown), and null otherwise. UNSTABLE, GitHub's status for a mergeable PR whose failing or pending checks are not required, is one of those others: it reads Blocked and offers no Merge. The review decision comes first, so no merge status can read Ready without an approval, and only a chip that withholds can stop it, so CI not run cannot turn an UNKNOWN PR into a Blocked one
export const offerableMergeState = (pr: Pick<RawOpenPr, 'reviewDecision' | 'mergeStateStatus'>, issues: readonly Pick<Issue, 'kind'>[]): 'ready' | 'checking' | null => {
  if (pr.reviewDecision !== 'APPROVED' || carries(issues, withholdingIssues)) return null
  if (pr.mergeStateStatus === 'CLEAN' || pr.mergeStateStatus === 'HAS_HOOKS') return 'ready'
  return pr.mergeStateStatus === 'UNKNOWN' ? 'checking' : null
}

// Squash and merge is offered on a row whose base is the primary branch, with no chip that withholds it, whose merge state the rule admitted: ready, or checking while the row groups as Ready to merge. A draft reads the draft state and is never offered. Whose PR it is sits with the callers: showsMerge reads the row's section, and the server compares the PR's author with the viewer
export const mergeOffered = (row: { merge: Pick<MergeState, 'state'>, group: MineGroup | string, issues: readonly Pick<Issue, 'kind'>[], primaryBase: boolean }): boolean =>
  row.primaryBase && !carries(row.issues, withholdingIssues) && (row.merge.state === 'ready' || (row.merge.state === 'checking' && row.group === 'readyToMerge'))
