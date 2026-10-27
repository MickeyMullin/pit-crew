// test/fixtures/scenario.ts
// the invented world the JSON fixtures describe; every name, SHA, URL and key here is made up

export const scenario = {
  repo: 'octo-example/orbit',
  defaultBranch: 'main',
  viewer: 'vera-quill',
  // a Monday, so Yesterday covers Friday through Sunday
  now: '2026-10-26T14:05:38Z',
  // local day boundaries fall at 04:00Z (EDT) on these dates
  timeZone: 'America/New_York',
  todayFrom: '2026-10-26T04:00:00Z',
  yesterdayFrom: '2026-10-23T04:00:00Z',
  yesterdayTo: '2026-10-26T04:00:00Z',
  // open-page-1.json holds the first 9 PRs, open-page-2.json the other 9
  pageSize: 9,
  openTotal: 18,
  // the endCursor of open-page-1.json, sent as $after for page 2
  page2After: 'Y3Vyc29yOnYyOmZpeHR1cmUtOQ==',
  jiraPattern: '\\b[a-z]+-\\d+\\b',
  people: ['alex-mendez', 'sam-tran', 'priya-k', 'lee-park'],
  bots: ['dependabot', 'renovate'],
  team: 'platform-reviewers',
  botReviewer: 'review-helper',
} as const

// what each open PR exists to exercise (section 5 of DESIGN.md)
export const openCases: Record<number, string> = {
  118: 'others; viewer requested changes at the head commit, no push since: waiting on author; Jira key only in body (not a ticket source)',
  101: 'mine; changes requested by alex-mendez on the head commit, plus a commented review: Changes requested group; Jira key in title',
  106: 'others; viewer commented on c1, then 2 pushes, then sam-tran approved: your move, Re-review · 2 pushes; Jira key only in branch (lowercase)',
  109: 'others; CI failing · 2 (check run with job URL first, then a status context), one canceled run ignored; viewer requested: waiting on author with Requested of you',
  103: 'mine; draft with pending checks (queued, in progress, waiting, status pending); converted back to draft in the timeline',
  113: 'others; mergeable UNKNOWN: no chip; no reviews, no requests: your move, merge needs review; lowercase Jira key in title',
  111: 'others; stack 2/3, base is #110 head (page 2), team review request',
  102: 'mine; approved twice, CLEAN: ready to merge; closing issue #57',
  107: 'others; viewer requested changes on a commit lost to a force push, then re-requested: your move, Re-review · new commits, Requested of you, viewer pip requested',
  108: 'others; CONFLICTING and DIRTY, no status contexts at all: Conflicts and CI not run, waiting on author with Requested of you; title rename is last activity',
  112: 'others; stack 3/3, base is #111 head (page 1), CI running · 1',
  110: 'others; stack 1/3 on main, approved and CLEAN: ready to merge',
  116: 'others; viewer commented on the head commit, nothing since, not requested; body has the no-ticket marker',
  114: 'bot (dependabot); branch name contains lodash-4, which the default Jira pattern matches',
  115: 'bot (renovate); only canceled checks: CI canceled · 2',
  119: 'others; draft: hidden in v1',
  120: 'mine; approved but BEHIND: awaiting review group, stage approved, merge blocked; pending Bot reviewer request',
  104: 'mine; no reviews, a user and a team requested: awaiting review, merge needs review',
}

// closed.json lists these in search order, not closedAt order
export const closedCases: Record<number, string> = {
  100: 'mine; merged by the viewer Monday 13:10Z: Today, merged by you; Jira key only in branch',
  93: 'closed unmerged by its own author Monday 12:00Z: Today, closed by Lee; no-ticket marker',
  99: 'merged Monday 02:30Z, which is Sunday 10:30 PM in New York: Yesterday* in local mode, Today in utc mode',
  97: 'merged Sunday 21:53Z (Sun 5:53 PM local); closing issue #51',
  96: 'dependabot PR closed by dependabot Saturday: superseded',
  98: 'closed unmerged by someone other than the author Friday: closed by Priya; Jira key only in body',
  95: 'merged by the viewer Friday 15:12Z: merged by you; Jira key in title',
  94: 'renovate PR merged by alex-mendez Friday 09:00Z',
}
