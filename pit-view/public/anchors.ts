// public/anchors.ts
// the GitHub anchors that Last activity and "push since yours" link to. Pure: the repository must be a plain owner/name, the PR number a positive integer, a comment or review id digits only, and a commit a 7 to 40 character hex SHA, so nothing else reaches the URL. Null means no anchor, and the caller uses the PR URL. The caller still passes the result through safeHref

import type { ActivityAnchor } from '../src/derive.ts'

const pullUrl = (repo: string | undefined, number: number): string | null =>
  repo !== undefined && /^[\w.-]+\/[\w.-]+$/.test(repo) && !repo.split('/').some((part) => /^\.+$/.test(part)) && Number.isInteger(number) && number > 0
    ? `https://github.com/${repo}/pull/${number}`
    : null

// the PR a based-on indication names: its page, or null when the repository or the number is not plain, so the indication stays text
export const pullHref = (repo: string | undefined, number: number): string | null => pullUrl(repo, number)

export const pushHref = (sha: string | null | undefined, repo: string | undefined, number: number): string | null => {
  const base = pullUrl(repo, number)
  return base === null || sha == null || !/^[0-9a-f]{7,40}$/i.test(sha) ? null : `${base}/commits/${sha.toLowerCase()}`
}

export const activityHref = (anchor: ActivityAnchor | null | undefined, repo: string | undefined, number: number): string | null => {
  if (anchor == null) return null
  if (anchor.kind === 'commit') return pushHref(anchor.id, repo, number)
  const base = pullUrl(repo, number)
  if (base === null || !/^\d+$/.test(anchor.id)) return null
  if (anchor.kind === 'comment') return `${base}#issuecomment-${anchor.id}`
  if (anchor.kind === 'review') return `${base}#pullrequestreview-${anchor.id}`
  return null
}

// the Re-review flag's link: the first commit after the viewer's review when the flag names one, otherwise the PR URL
export const reReviewHref = (sinceSha: string | null | undefined, repo: string | undefined, number: number, url: string): string => pushHref(sinceSha, repo, number) ?? url

// the Changes requested banner's and chip's link: the review that requested changes, otherwise the PR URL when its id is unknown
export const changesRequestedHref = (anchor: ActivityAnchor | null | undefined, repo: string | undefined, number: number, url: string): string => activityHref(anchor, repo, number) ?? url
