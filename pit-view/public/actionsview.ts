// public/actionsview.ts
// the drawer's direct actions (section 9 of DESIGN.md) as pure functions of the open row and the people the config lists: which actions a row offers, the confirmation each one asks, the request it sends, and the words for a refusal. drawer.ts makes the elements. Nothing here reads the DOM or the clock
import type { OpenRow } from '../src/derive.ts'
import { runnerLabels, sentence, showsMerge, tokenHeader } from './agent.ts'
import type { RunRequest } from './agent.ts'

// the actions this page offers; merge is always a squash into the PR's base branch, update starts an agent session that brings the PR's branch up to date with it, resolveConflicts starts that same session on a conflicting PR, and close closes a PR a relevancy check found irrelevant, without merging it
export type ActionKind = 'merge' | 'markReady' | 'convertToDraft' | 'requestReview' | 'update' | 'resolveConflicts' | 'close'

export const actionKinds: readonly ActionKind[] = ['merge', 'markReady', 'convertToDraft', 'requestReview', 'update', 'resolveConflicts', 'close']

// the actions that start the Update session, and so are bound to the viewer, the head, and the base their confirmation showed
const startsUpdate = (action: ActionKind): boolean => action === 'update' || action === 'resolveConflicts'

// a person the config lists, as far as a reviewer choice needs
export type PersonChoice = { login: string, alias: string }

// repo and viewer are the repository and the login the page showed when the action was asked; every request carries the repository back, and an update, a resolveConflicts, or a close the viewer too, since its session pushes, or the close posts, as the viewer. headSha and baseRef are what the row showed when the action was asked, in full, and a merge, an update, or a resolveConflicts request carries them, a close the head alone; the other actions have nothing more of the row to be bound to. runId and comment are a close's alone: the relevancy check the confirmation showed, and what its comment box holds, which starts as the check's reason
export type ActionConfirm = { type: 'action', action: ActionKind, repo: string, viewer: string, reviewer: string, headSha: string, baseRef: string, runId?: number, comment?: string }

export type ActionOffer = { action: ActionKind, text: string }

// the row fields an offer reads; agent is absent on a row that has no Agent cell
type OfferRow = Pick<OpenRow, 'section' | 'merge' | 'primaryBase' | 'issues' | 'group'> & { agent?: OpenRow['agent'] }

// the relevancy check a row's Close PR acts on: the cell's latest run, still standing for the current head, a done check that found the PR irrelevant; null otherwise
const irrelevantCheck = (row: OfferRow): { runId: number, reason: string } | null => {
  const cell = row.agent
  const result = cell?.result
  if (cell == null || cell.state !== 'done' || cell.status !== 'done' || cell.runId === null || result?.kind !== 'relevancy' || result.verdict !== 'irrelevant') return null
  return { runId: cell.runId, reason: result.reason ?? '' }
}

// the actions this page offers: only the viewer's own PRs (Mine rows) have any, and a PR that has left the open tables has none. Merge is offered only while showsMerge holds (the one rule in ./mergeoffer.ts, which the server's guard applies too: the merge state is ready, or checking on a row in the Ready to merge group, no issue chip withholds it, and the base is the cached primary branch). Update is offered on any of them whose base is the primary branch, drafts included, except while a run of the PR is in flight, since one run per PR runs at a time. Resolve conflicts is offered after it on the same terms, and only while the row carries the Conflicts chip. Close PR comes last, offered only while the latest run is a done relevancy check of the current head that found the PR irrelevant. The server decides again whatever this says
export const actionOffers = (row: OfferRow, open: boolean): ActionOffer[] => {
  if (!open || row.section !== 'mine') return []
  const draft = row.merge.state === 'draft'
  // a stack run started from another PR shows in the cell but is not a run of this PR, so what counts then is the PR's own
  const covered = row.agent?.stackRun
  const status = covered == null ? row.agent?.state : covered.ownStatus
  const updates = row.primaryBase && status !== 'running' && status !== 'queued'
  return [
    ...showsMerge(row) ? [{ action: 'merge', text: 'Squash and merge' } as const] : [],
    draft ? { action: 'markReady', text: 'Mark ready' } : { action: 'convertToDraft', text: 'Convert to draft' },
    { action: 'requestReview', text: 'Request review' },
    ...updates ? [{ action: 'update', text: 'Update branch' } as const] : [],
    ...updates && row.issues.some((issue) => issue.kind === 'conflicts') ? [{ action: 'resolveConflicts', text: 'Resolve conflicts' } as const] : [],
    ...irrelevantCheck(row) === null ? [] : [{ action: 'close', text: 'Close PR' } as const],
  ]
}

// the confirmation Close PR asks, bound to the check and the head the row shows, its box prefilled with the check's reason; null when the row does not offer it
export const closeAsk = (row: OfferRow & Pick<OpenRow, 'headSha' | 'baseRef'>, repo: string, viewer: string): ActionConfirm | null => {
  const check = irrelevantCheck(row)
  if (check === null || row.section !== 'mine') return null
  return { type: 'action', action: 'close', repo, viewer, reviewer: '', headSha: row.headSha, baseRef: row.baseRef, runId: check.runId, comment: check.reason }
}

// the closing comment's bound, which the server holds it to as well
export const maxCloseComment = 2000

// who a review can be requested from: the people the config lists, except the PR's author
export const reviewerChoices = (row: Pick<OpenRow, 'author'>, people: readonly PersonChoice[]): PersonChoice[] =>
  people.filter((person) => person.login.toLowerCase() !== row.author.login.toLowerCase())

export type ActionConfirmModel = {
  action: ActionKind
  // names the PR and the action
  heading: string
  title: string
  // what happens on GitHub, in words
  effect: string
  // the choice of reviewer for a review request; null for the others
  reviewers: { login: string, label: string }[] | null
  reviewer: string
  // the runner and model of the agent session an action starts (Update branch and Resolve conflicts, always Claude); null for an action that starts no agent, and for a row without an Agent cell, which has no model to name
  session: { runner: string, model: string } | null
  // false when no eligible reviewer exists, so the confirmation control must be disabled
  canConfirm: boolean
  // a plain line for an action that rewrites the branch, which gives the confirmation its caution treatment; null for the others
  caution: string | null
  // Close PR's comment box: its label, what it holds now, and the line under it; null for every other action
  comment: { label: string, text: string, detail: string } | null
  confirm: string
  busy: string
}

const aliasOf = (people: readonly PersonChoice[], login: string): string =>
  people.find((person) => person.login === login)?.alias ?? login

type ConfirmRow = Pick<OpenRow, 'number' | 'title' | 'author' | 'section' | 'merge' | 'group' | 'issues' | 'headRef' | 'baseRef' | 'primaryBase' | 'headOid' | 'headSha'> & { agent?: OpenRow['agent'] }

// null when the row no longer offers that action. The chosen reviewer is kept when still listed, otherwise the first choice. Close PR alone has a comment box, which shows what the confirmation holds
export const actionConfirmModel = (row: ConfirmRow, ask: ActionConfirm, people: readonly PersonChoice[]): ActionConfirmModel | null => {
  if (!actionHolds(ask, row, true)) return null
  if (ask.action === 'close') {
    return {
      action: ask.action,
      heading: `Close #${row.number} without merging?`,
      title: row.title,
      effect: 'Closes the PR on GitHub under your account without merging it, and posts what the box below holds as its closing comment. An empty box closes it with no comment. The branch is kept, and the PR can be reopened on GitHub.',
      reviewers: null,
      reviewer: '',
      session: null,
      canConfirm: true,
      caution: null,
      comment: { label: 'Closing comment', text: ask.comment ?? '', detail: `Prefilled with the relevancy check's reason. What the box holds when you confirm is posted, at most ${maxCloseComment.toLocaleString('en-US')} characters.` },
      confirm: 'Close PR',
      busy: 'Closing…',
    }
  }
  const model = otherConfirmModel(row, ask, people)
  return { ...model, comment: null }
}

const otherConfirmModel = (row: ConfirmRow, ask: ActionConfirm, people: readonly PersonChoice[]): Omit<ActionConfirmModel, 'comment'> => {
  const n = row.number
  const fallback = (branch: string, base: string): string => `If a rebase is not workable (someone else has commits on the branch, another PR is based on it, or it already holds a merge), it merges ${base} into ${branch} instead and pushes without force.`
  const rewrite = (branch: string, base: string): string => `A rebase rewrites the PR's own commits and replaces ${branch} on GitHub. Nothing on ${base} is rewritten.`
  // the Update session asked for on a conflicting PR: the same session, method, and push, in the words of the conflicts
  // an update session always runs in Claude, as updateRequest names it
  const started = row.agent == null ? null : { runner: runnerLabels.claude, model: row.agent.models.claude }
  if (ask.action === 'resolveConflicts') {
    const branch = row.headRef
    const base = ask.baseRef
    return {
      action: ask.action,
      heading: `Resolve the conflicts between #${n} and ${base}?`,
      title: row.title,
      effect: `Starts an agent session that resolves the conflicts between ${branch} and ${base} by rebasing ${branch} onto ${base}, and force-pushes ${branch} with --force-with-lease under your account, so the push is refused if ${branch} has moved on from head ${row.headOid}. ${fallback(branch, base)} It changes nothing but what the update and its conflicts need, and stops to ask when a conflict needs your judgment.`,
      reviewers: null,
      reviewer: '',
      session: started,
      canConfirm: true,
      caution: rewrite(branch, base),
      confirm: 'Start resolving conflicts',
      busy: 'Starting session…',
    }
  }
  if (ask.action === 'update') {
    const branch = row.headRef
    const base = ask.baseRef
    return {
      action: ask.action,
      heading: `Update #${n} from ${base}?`,
      title: row.title,
      effect: `Starts an agent session that rebases ${branch} onto ${base}, resolving any conflicts, and force-pushes ${branch} with --force-with-lease under your account, so the push is refused if ${branch} has moved on from head ${row.headOid}. ${fallback(branch, base)} It stops to ask when a conflict needs your judgment.`,
      reviewers: null,
      reviewer: '',
      session: started,
      canConfirm: true,
      caution: rewrite(branch, base),
      confirm: 'Start update',
      busy: 'Starting update…',
    }
  }
  if (ask.action === 'merge') {
    return {
      action: ask.action,
      heading: `Squash and merge #${n} into ${ask.baseRef}?`,
      title: row.title,
      effect: `Squashes the PR at head ${row.headOid} into one commit on ${ask.baseRef} under your account. The head branch is not deleted. The merge cannot be undone from Pit View.`,
      reviewers: null,
      reviewer: '',
      session: null,
      canConfirm: true,
      caution: null,
      confirm: 'Squash and merge',
      busy: 'Merging…',
    }
  }
  if (ask.action === 'markReady') {
    return {
      action: ask.action,
      heading: `Mark #${n} ready for review?`,
      title: row.title,
      effect: 'Takes the PR out of draft under your account. Its requested reviewers and watchers are notified.',
      reviewers: null,
      reviewer: '',
      session: null,
      canConfirm: true,
      caution: null,
      confirm: 'Mark ready',
      busy: 'Marking ready…',
    }
  }
  if (ask.action === 'convertToDraft') {
    return {
      action: ask.action,
      heading: `Convert #${n} to a draft?`,
      title: row.title,
      effect: 'Turns the PR back into a draft under your account. It cannot be merged until it is marked ready again.',
      reviewers: null,
      reviewer: '',
      session: null,
      canConfirm: true,
      caution: null,
      confirm: 'Convert to draft',
      busy: 'Converting…',
    }
  }
  const choices = reviewerChoices(row, people)
  const reviewer = choices.some((person) => person.login === ask.reviewer) ? ask.reviewer : choices[0]?.login ?? ''
  return {
    action: ask.action,
    heading: `Request a review on #${n}?`,
    title: row.title,
    effect: reviewer === ''
      ? 'No one else is listed in people. Add reviewers in Settings first.'
      : `Asks GitHub to request a review from ${aliasOf(people, reviewer)} (@${reviewer}) under your account. They are notified.`,
    session: null,
    reviewers: choices.map((person) => ({ login: person.login, label: `${person.alias} (@${person.login})` })),
    reviewer,
    canConfirm: reviewer !== '',
    caution: null,
    confirm: 'Request review',
    busy: 'Requesting…',
  }
}

// a confirmation outlives nothing: it is dropped when the PR has left the open tables, or no longer offers its action (a draft marked ready by a patch no longer offers Mark ready, a PR whose run has started no longer offers Update, and one whose conflicts are gone no longer offers Resolve conflicts). A merge, update, or resolveConflicts confirmation is also dropped when a patch changed the head or base it showed: the request is bound to them, and the confirmation must not go on describing a PR that is no longer the one cached
type BoundRow = OfferRow & Pick<OpenRow, 'headSha' | 'baseRef'>

// A close confirmation is dropped when the head moves or the check it showed is no longer the latest run
export const actionHolds = (ask: ActionConfirm, row: BoundRow, open: boolean): boolean =>
  actionOffers(row, open).some((offer) => offer.action === ask.action) &&
  (ask.action === 'close'
    ? row.headSha === ask.headSha && irrelevantCheck(row)?.runId === ask.runId
    : (ask.action !== 'merge' && !startsUpdate(ask.action)) || (row.headSha === ask.headSha && row.baseRef === ask.baseRef))

// actionHolds, and the page's repository and viewer are still the ones the confirmation was opened for: #<n> in another repository is another PR, and an update pushes as the viewer, so a confirmation never outlives a switch of either
export const actionBound = (ask: ActionConfirm, row: BoundRow, open: boolean, repo: string, viewer: string = ask.viewer): boolean =>
  ask.repo === repo && ask.viewer.toLowerCase() === viewer.toLowerCase() && actionHolds(ask, row, open)

// the request the confirmation sends: the token header, the repository the confirmation showed, the head SHA and base it showed for a merge, those and the viewer for an update or a resolveConflicts, the reviewer for a review request, and for a close the viewer, the head, the check's run, and what the comment box holds
export const actionRequest = (number: number, ask: ActionConfirm, token: string): RunRequest => ({
  url: `/api/prs/${number}/actions`,
  init: {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [tokenHeader]: token },
    body: JSON.stringify(
      ask.action === 'close'
        ? { action: ask.action, repo: ask.repo, viewer: ask.viewer, headSha: ask.headSha, runId: ask.runId, comment: ask.comment ?? '' }
        : ask.action === 'requestReview'
        ? { action: ask.action, repo: ask.repo, reviewer: ask.reviewer }
        : ask.action === 'merge'
          ? { action: ask.action, repo: ask.repo, headSha: ask.headSha, base: ask.baseRef }
          : startsUpdate(ask.action)
            ? { action: ask.action, repo: ask.repo, viewer: ask.viewer, headSha: ask.headSha, base: ask.baseRef }
            : { action: ask.action, repo: ask.repo }),
  },
})

// a refusal in the owner's words: the server's message, except for the token, where the fix is a reload; status 0 means Pit View did not answer at all
export const actionRefusalText = (status: number, error: string | null): string => {
  if (status === 403) return 'Reload the page to act on PRs: Pit View has restarted since this page loaded.'
  if (status === 0) return 'Pit View did not answer. Check that it is running, then try again.'
  return sentence(error ?? '') || `Pit View refused with status ${status}.`
}

// The row refresh decides whether the REST request merged immediately or was refused by branch rules, so this acknowledgment never claims a merge happened before that evidence arrives.
export const actionDoneText = (number: number, ask: ActionConfirm, people: readonly PersonChoice[]): string => {
  // the session has only started; its outcome arrives on the row, and the PR is read again once it ends
  if (ask.action === 'update') return `#${number}: update session started. The row is refreshed when it ends.`
  if (ask.action === 'resolveConflicts') return `#${number}: session to resolve conflicts started. The row is refreshed when it ends.`
  if (ask.action === 'close') return `#${number}: closed without merging. The row is refreshing.`
  const done = ask.action === 'merge'
    ? 'merge requested (squash)'
    : ask.action === 'markReady'
      ? 'marked ready for review'
      : ask.action === 'convertToDraft'
        ? 'converted to a draft'
        : `review requested from ${aliasOf(people, ask.reviewer)}`
  return `#${number}: ${done}. The row is refreshing.`
}
