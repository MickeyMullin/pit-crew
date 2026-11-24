// public/copilot.ts
// what an Others' row notes about GitHub Copilot's review; pure
import type { OpenRow } from '../src/derive.ts'

// the login GitHub's GraphQL API gives the author of a Copilot code review, the one place the page names it
export const copilotLogin = 'copilot-pull-request-reviewer'

export const copilotNote = 'Copilot changes requested'

// whether Copilot's change request stands on this row: its reviewer pip is ✗ (section 5 of DESIGN.md, Reviewer pips), so an approval, a dismissal, or a fresh request ends it as it would anyone's
export const copilotRequestsChanges = (row: Pick<OpenRow, 'reviewers'>): boolean =>
  row.reviewers.some((reviewer) => reviewer.state === 'changes' && reviewer.login.toLowerCase() === copilotLogin)
