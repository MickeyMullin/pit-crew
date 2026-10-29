// public/actionsview.ts
// the drawer's direct actions (section 9 of DESIGN.md) as pure functions of the open row and the
// people the config lists: which actions a row offers, the confirmation each one asks, the
// request it sends and the words for a refusal. drawer.ts makes the elements. Nothing here reads
// the DOM or the clock
import type { OpenRow } from '../src/derive.ts'
import { sentence, tokenHeader } from './agent.ts'
import type { RunRequest } from './agent.ts'

// the actions this page offers; merge is always a squash into the PR's base branch
export type ActionKind = 'merge' | 'markReady' | 'convertToDraft' | 'requestReview'

export const actionKinds: readonly ActionKind[] = ['merge', 'markReady', 'convertToDraft', 'requestReview']

// a person the config lists, as far as a reviewer choice needs
export type PersonChoice = { login: string, alias: string }

export type ActionConfirm = { type: 'action', action: ActionKind, reviewer: string }

export type ActionOffer = { action: ActionKind, text: string }

// the actions this page offers: only the viewer's own PRs (Mine rows) have any, and a PR that has left
// the open tables has none. Merge is offered only while the merge state is ready and its base is the
// cached primary branch. The server decides again whatever this says
export const actionOffers = (row: Pick<OpenRow, 'section' | 'merge' | 'primaryBase'>, open: boolean): ActionOffer[] => {
  if (!open || row.section !== 'mine') return []
  const draft = row.merge.state === 'draft'
  return [
    ...row.merge.state === 'ready' && row.primaryBase ? [{ action: 'merge', text: 'Squash and merge' } as const] : [],
    draft ? { action: 'markReady', text: 'Mark ready for review' } : { action: 'convertToDraft', text: 'Convert to draft' },
    { action: 'requestReview', text: 'Request review' },
  ]
}

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
  // false when no eligible reviewer exists, so the confirmation control must be disabled
  canConfirm: boolean
  confirm: string
  busy: string
}

const aliasOf = (people: readonly PersonChoice[], login: string): string =>
  people.find((person) => person.login === login)?.alias ?? login

// null when the row no longer offers that action. The chosen reviewer is kept when still listed,
// otherwise the first choice
export const actionConfirmModel = (
  row: Pick<OpenRow, 'number' | 'title' | 'author' | 'section' | 'merge' | 'baseRef' | 'primaryBase'>,
  ask: ActionConfirm,
  people: readonly PersonChoice[],
): ActionConfirmModel | null => {
  if (!actionOffers(row, true).some((offer) => offer.action === ask.action)) return null
  const n = row.number
  if (ask.action === 'merge') {
    return {
      action: ask.action,
      heading: `Squash and merge #${n} into ${row.baseRef}?`,
      title: row.title,
      effect: `Squashes the PR into one commit on ${row.baseRef} under your account. The head branch is not deleted. The merge cannot be undone from Pit View.`,
      reviewers: null,
      reviewer: '',
      canConfirm: true,
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
      canConfirm: true,
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
      canConfirm: true,
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
    reviewers: choices.map((person) => ({ login: person.login, label: `${person.alias} (@${person.login})` })),
    reviewer,
    canConfirm: reviewer !== '',
    confirm: 'Request review',
    busy: 'Requesting…',
  }
}

// a confirmation outlives nothing: it is dropped when the PR has left the open tables, or no
// longer offers its action (a draft marked ready by a patch no longer offers Mark ready)
export const actionHolds = (ask: ActionConfirm, row: Pick<OpenRow, 'section' | 'merge' | 'primaryBase'>, open: boolean): boolean =>
  actionOffers(row, open).some((offer) => offer.action === ask.action)

// the request the confirmation sends: the token header, and the reviewer for a review request only
export const actionRequest = (number: number, ask: ActionConfirm, token: string): RunRequest => ({
  url: `/api/prs/${number}/actions`,
  init: {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [tokenHeader]: token },
    body: JSON.stringify(ask.action === 'requestReview' ? { action: ask.action, reviewer: ask.reviewer } : { action: ask.action }),
  },
})

// a refusal in the owner's words: the server's message, except for the token, where the fix is a
// reload; status 0 means Pit View did not answer at all
export const actionRefusalText = (status: number, error: string | null): string => {
  if (status === 403) return 'Reload the page to act on PRs: Pit View has restarted since this page loaded.'
  if (status === 0) return 'Pit View did not answer. Check that it is running, then try again.'
  return sentence(error ?? '') || `Pit View refused with status ${status}.`
}

// The row refresh decides whether the REST request merged immediately or was refused by branch
// rules, so this acknowledgement never claims a merge happened before that evidence arrives.
export const actionDoneText = (number: number, ask: ActionConfirm, people: readonly PersonChoice[]): string => {
  const done = ask.action === 'merge'
    ? 'merge requested (squash)'
    : ask.action === 'markReady'
      ? 'marked ready for review'
      : ask.action === 'convertToDraft'
        ? 'converted to a draft'
        : `review requested from ${aliasOf(people, ask.reviewer)}`
  return `#${number}: ${done}. The row is refreshing.`
}
