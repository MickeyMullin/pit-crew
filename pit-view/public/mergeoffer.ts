// public/mergeoffer.ts
// the one rule for offering Merge, shared by the page (the idle Agent button and the drawer's Squash and merge) and the server's guard (src/actions.ts), so they cannot disagree. It reads only what a row carries: its merge state, its group, its issue chips, and whether its base is the primary branch. It imports types only, because the server and the browser both load it.
import type { Issue, IssueKind, MergeState, MineGroup } from '../src/derive.ts'

// THE UNSTABLE RULE, in one place. UNSTABLE is GitHub's status for a mergeable PR whose failing or pending checks are not required. It reads Blocked and offers no Merge until the owner decides otherwise; flipping this to true makes deriveMerge read it Ready (conflict-free, no change requested) and stops the CI chips withholding Merge, and nothing else changes
export const unstableOffersMerge = false

// the issue chips that withhold Merge whatever the merge status says: a change is requested, the PR conflicts, or a check is failing or still running. CI not run and CI canceled do not: a repository without checks merges, and a canceled run says nothing about the head
export const withholdingIssues: readonly IssueKind[] = unstableOffersMerge ? ['changesRequested', 'conflicts'] : ['changesRequested', 'conflicts', 'ciFailing', 'ciRunning']

export const hasWithholdingIssue = (issues: readonly Pick<Issue, 'kind'>[]): boolean => issues.some((issue) => withholdingIssues.includes(issue.kind))

// Squash and merge is offered on the viewer's own PR into the primary branch when its merge state is ready, or checking while the row groups as Ready to merge (an approved PR whose mergeability GitHub has not finished computing: the server's live read before the write refuses if it is still unknown), and no issue chip withholds it. A draft reads the draft state and is never offered
export const mergeOffered = (row: { merge: Pick<MergeState, 'state'>, group: MineGroup | string, issues: readonly Pick<Issue, 'kind'>[], primaryBase: boolean }): boolean =>
  row.primaryBase && !hasWithholdingIssue(row.issues) && (row.merge.state === 'ready' || (row.merge.state === 'checking' && row.group === 'readyToMerge'))
