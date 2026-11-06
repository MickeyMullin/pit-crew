// public/mergeoffer.ts
// the one rule for offering Merge, shared by the merge state (deriveMerge in src/derive.ts), the page (the idle Agent button and the drawer's Squash and merge), and the server's guard (src/actions.ts), so they cannot disagree. Merge is offered only on the viewer's own, non-draft PR into the primary branch that is approved (reviewDecision APPROVED; REVIEW_REQUIRED and null are not approved), not conflicting, with no withholding chip (Changes requested, Conflicts, CI failing, or CI running; CI not run and CI canceled do not withhold), and whose merge status is CLEAN, HAS_HOOKS, or UNKNOWN. It imports types only, because the server and the browser both load it.
import type { Issue, IssueKind, MergeState, MineGroup } from '../src/derive.ts'
import type { RawOpenPr } from '../src/github.ts'

// THE UNSTABLE RULE, in one place. UNSTABLE is GitHub's status for a mergeable PR whose failing or pending checks are not required. It reads Blocked and offers no Merge until the owner decides otherwise; flipping this to true makes an approved UNSTABLE PR with no change request and no conflicts read Ready whatever its CI chips say, lets the server's live read accept `unstable`, and changes no other status
export const unstableOffersMerge = false

// a change is requested or the PR conflicts: these withhold Merge whatever GitHub reports
const reviewAndConflictIssues: readonly IssueKind[] = ['changesRequested', 'conflicts']

// a check is failing or still running: these withhold Merge too, except on an UNSTABLE PR under the owner's rule, where such checks are exactly what UNSTABLE reports. CI not run and CI canceled do not: a repository without checks merges, and a canceled run says nothing about the head
const allWithholdingIssues: readonly IssueKind[] = [...reviewAndConflictIssues, 'ciFailing', 'ciRunning']

const carries = (issues: readonly Pick<Issue, 'kind'>[], kinds: readonly IssueKind[]): boolean => issues.some((issue) => kinds.includes(issue.kind))

// the states of a PR the rule admits, read before anything else about its merge state. Ready when GitHub's answer is mergeable, Checking when GitHub has not finished computing it (the server's live read before the write refuses if it is still unknown), and null otherwise. The review decision comes first, so no merge status can read Ready without an approval, and only a chip that withholds can stop it, so CI not run cannot turn an UNKNOWN PR into a Blocked one
export const offerableMergeState = (pr: Pick<RawOpenPr, 'reviewDecision' | 'mergeStateStatus'>, issues: readonly Pick<Issue, 'kind'>[]): 'ready' | 'checking' | null => {
  if (pr.reviewDecision !== 'APPROVED') return null
  if (pr.mergeStateStatus === 'UNSTABLE') return unstableOffersMerge && !carries(issues, reviewAndConflictIssues) ? 'ready' : null
  if (carries(issues, allWithholdingIssues)) return null
  if (pr.mergeStateStatus === 'CLEAN' || pr.mergeStateStatus === 'HAS_HOOKS') return 'ready'
  return pr.mergeStateStatus === 'UNKNOWN' ? 'checking' : null
}

// what a row's chips can withhold. A row does not carry its merge status, so under the owner's UNSTABLE rule the CI chips no longer count here: offerableMergeState has already refused them on every other status
const rowWithholdingIssues = unstableOffersMerge ? reviewAndConflictIssues : allWithholdingIssues

// Squash and merge is offered on a row whose base is the primary branch, with no chip that withholds it, whose merge state the rule admitted: ready, or checking while the row groups as Ready to merge. A draft reads the draft state and is never offered. Whose PR it is sits with the callers: showsMerge reads the row's section, and the server compares the PR's author with the viewer
export const mergeOffered = (row: { merge: Pick<MergeState, 'state'>, group: MineGroup | string, issues: readonly Pick<Issue, 'kind'>[], primaryBase: boolean }): boolean =>
  row.primaryBase && !carries(row.issues, rowWithholdingIssues) && (row.merge.state === 'ready' || (row.merge.state === 'checking' && row.group === 'readyToMerge'))
