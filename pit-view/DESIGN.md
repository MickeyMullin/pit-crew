# Pit View: design and progress tracker

Pit View is a local dashboard for tracking pull requests in one GitHub repository. It answers, at a glance, which PRs need the viewer's attention, which of the viewer's own PRs are blocked or ready, and what closed today. Later it starts and monitors local agentic review sessions using pit-crew's review commands, and in phase 4 starts reviews on a schedule of its own, with or without a page open.

This file is the single source of truth for the design and the progress checklist. A new session should be able to build any milestone from this file alone. Update the checklist and the session log as work lands.

The approved visual mockup is a private Design canvas (version 41) at https://claude.ai/artifact/7B3JZYHqQ1N11mDxxCcdJM. Everything it shows is specified below, so the mockup is a reference, not a dependency. The canvas predates the rename and still shows the old name, Pit Wall; where the two differ, this file wins.

## 1. Purpose, scope and configuration

### Purpose

The viewer reviews, and follows up on, almost every PR in the configured repository. For other people's PRs the dashboard shows whose it is, whether it is ready for review, its issues (changes requested, merge conflicts, CI failures), time since its last activity and what that activity was, and whether it is ready to merge. For the viewer's own PRs it shows whether each is ready for review or re-review, whether a self-review exists and is current, changes requested (with a special call-out), other issues, and whether it is ready to merge. A separate section lists PRs closed (merged or closed unmerged) today.

Each PR is identified primarily by its number, which links to its page on GitHub. Its title is the description (never parsed from the body), truncated in rows and shown in full on hover.

### Scope

- v1: one repository at a time, read-only against GitHub, local only, single viewer. The UI always renders from the local cache first and then updates in place as fresh data arrives (section 3). It polls GitHub only while at least one page is visible and not paused; with no active page the server makes no GitHub calls for the UI. Each page has a Pause control beside Refresh (section 6). The server is started by hand in v1; starting it automatically at login is an optional convenience (section 3, Hosting).
- Phase 2: start and monitor agentic review sessions per PR, and teach pit-crew's review commands a machine-readable call and response for Pit View (section 8).
- v3: stacks grouped, direct actions on PRs, and OS notifications (section 9).
- Phase 4: auto-review, a scheduler that starts review and re-review runs for new or updated PRs whenever the app is running, whether or not any page is open, independent of the UI's polling (section 10). It depends only on phase 2, so it could move ahead of v3. It supersedes, and then retires, the cron job the owner runs today to list which PRs need attention.
- Out of scope: commenting or approving from Pit View itself (reviews post through the review commands and their own rules), multi-user hosting. Pit View itself never posts, in any phase. Until v3 it makes no GitHub write of its own, and phase 4's runs post only through the review commands, and only once the owner turns posting on (section 10).

### Configuration

Configuration lives in `~/.config/pit-view/config.json`, with `~` expanded at runtime. The repository ships `pit-view/config.example.json` with generic values; a missing config file means "use the example defaults plus the gh login". Settings edits in the UI write back to the same file.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `repo` | string `owner/name` | `Port-City/meridian` | The one repository tracked. |
| `viewer` | string | output of `gh api user --jq .login` | Whose PRs count as "Mine" and whose reviews count as "yours". |
| `people` | list of `{login, alias, initials, color, avatar}` | empty | `avatar` is `initials`, `github`, or a local image path under `~`. Unlisted logins get their GitHub avatar and login. New authors are suggested in Settings the first time they appear. |
| `tickets` | list of ticket systems (below) | Jira first, then GitHub issues | Optional; an empty list hides tickets everywhere. |
| `refreshSeconds` | 300, 120 or 60 | 300 | The UI's interval, applied only while a page is active (section 3). Shown in the header as "every 5m". |
| `todayStartsAt` | `local` or `utc` | `local` | Local midnight in the machine's time zone. |
| `bots` | list of login substrings | `["dependabot", "renovate"]` | PRs by these collapse into a bot group. |
| `reportsDir` | path | `~/agents/output` | Where review reports are found for self-review detection. v1 is file-based; section 10, Report storage, proposes making this a legacy import source. |
| `density` | `comfortable` or `compact` | `comfortable` | Row padding 10px or 6px. |
| `showAgentColumn` | boolean | `false` in v1, `true` in phase 2 | Hides the phase 2 column until it works. |
| `notifications` | object | absent (off) | v3 only; shape in section 9. |
| `autoReview` | object | absent (off) | Phase 4 only; shape and defaults in section 10. |

A ticket system entry:

| Field | Meaning |
| --- | --- |
| `enabled` | boolean |
| `kind` | `jira`, `github-issues`, `linear`, or `template` |
| `name` | display name |
| `source` | `title-then-branch` (pattern match) or `linked-issues` (GitHub closing references) |
| `pattern` | regex, case-insensitive, used when `source` is `title-then-branch`; for example `\b[a-z]+-\d+\b` |
| `baseUrl` | for example the Jira site URL; empty means show keys without links |
| `linkTemplate` | for example `{baseUrl}/browse/{key}` or `https://github.com/{repo}/issues/{n}` |

The real Jira base URL and key pattern belong in the local config, not in committed files.

## 2. Where it lives and how pit-crew's rules apply

Pit View lives in `pit-crew/pit-view/` because it uses pit-crew's terminology and, in phase 2, its review commands and prompts.

- No real home directory path is ever committed. Code and docs write `~` and expand it at runtime with `os.homedir()`. Before every commit, run `git grep -I "$HOME" -- pit-view` and confirm it returns nothing.
- Pit View is not part of the `prompts/`, `commands/` and `bin/` source trees, so `scripts/deploy-reviews.sh` and `scripts/sanitize.sh` do not touch it, and it must not depend on either.
- Phase 2 launches the deployed review commands (for example the installed `/review-pr` command and its deployed prompt under `~/agents/prompts/`), never the source copies in `prompts/` or `commands/`, because only the deployed copies have real paths.
- Phases 2 and 4 also change pit-crew's own prompts and commands (sections 8 and 10). Those edits are pit-crew work, not Pit View work: they are made in `prompts/` and `commands/` with `{{HOME}}` placeholders, deployed with `scripts/deploy-reviews.sh --install`, and checked with `git grep -I "$HOME" -- prompts commands bin`, exactly as pit-crew's `CLAUDE.md` requires.
- Pit View reads reports from `reportsDir`; it never writes there. The proposed move of report storage into SQLite (section 10, Report storage) keeps that rule, and pit-crew's prompts keep writing their files.
- Phase 4's per-run worktrees live in a Pit View-owned directory under `~/.local/state/pit-view/`, expanded at runtime, never in the owner's working checkout (section 10, Worktrees).
- The optional start-at-login agent's launchd plist holds real absolute paths, so it is generated at install time from `os.homedir()` and `process.execPath` and written to `~/Library/LaunchAgents/`, outside the repository. No plist, and no template containing a path, is ever committed (section 3, Hosting).
- pit-crew's `CLAUDE.md` and `README.md` need a short entry describing the new folder (milestone M12).
- The repository is public. Keep client specifics (repo names other than the default config value, colleague names, PR titles, job URLs, ticket keys) out of committed files, fixtures included. Fixtures use invented data.

## 3. Architecture and stack

### Stack

- Node 26 (verified: v26.8.1 runs `.ts` files directly through built-in type stripping, `node:sqlite` works without flags, and `stripTypeScriptTypes` from `node:module` is present). Write TypeScript that type stripping accepts: no enums, no namespaces, no parameter properties; use `import type` for types; import local modules with their `.ts` extension.
- pnpm is the package manager; Node is the runtime. pnpm runs the scripts and installs the one dev dependency; nothing pnpm installs is needed to run the app.
- Zero runtime dependencies. HTTP via `node:http`, storage via `node:sqlite`, child processes via `node:child_process`, tests via `node:test` and `node:assert`. A dev-only `typescript` provides `tsc --noEmit` for `pnpm check`; it is not required to run.
- UI: static HTML, CSS and TypeScript ES modules served by the same server. The server serves each `public/*.ts` file as JavaScript by passing it through `stripTypeScriptTypes`, cached in memory by modification time, so there is still no build step. The UI is small and table-shaped; a framework buys little and adds a toolchain.
- Fonts: Inter and JetBrains Mono from Google Fonts, falling back to `system-ui` and `ui-monospace` when offline.

### Layout

```
pit-view/
  DESIGN.md              this file
  README.md              how to run
  config.example.json
  package.json           scripts only: start, test, check (M13 adds service:*); packageManager pins pnpm
  pnpm-lock.yaml         dev dependency only
  tsconfig.json          noEmit, allowImportingTsExtensions, strict
  src/
    server.ts            HTTP server, static files, API, event stream
    config.ts            load, defaults, save, ~ expansion
    github.ts            gh token, GraphQL and search queries, page callbacks
    poller.ts            refresh cycles, per-page apply, patch emission
    clients.ts           connected pages: client ids, visible and paused, the active set
    autoreview.ts        phase 4: scheduler, qualification, queue
    cache.ts             SQLite schema and access
    derive.ts            every rule in section 5, pure functions
    reports.ts           self-review report discovery and parsing
    time.ts              day boundaries, Monday rule, relative ages
  public/
    index.html
    app.ts               view state, patch application, rendering
    styles.css           the only place colors are defined
  scripts/
    service.ts           M13: install, uninstall and status of the launchd user agent
  test/
    fixtures/            invented GraphQL responses and report files
    derive.test.ts
    time.test.ts
    reports.test.ts
    cache.test.ts
    poller.test.ts
    clients.test.ts
    server.test.ts       HTTP on an ephemeral port, temp home, config and cache
    autoreview.test.ts   phase 4
```

### Runtime

- `pnpm start` runs `node src/server.ts` and listens on `127.0.0.1:4791` (configurable with `PIT_VIEW_PORT`). Bind to loopback only, in every hosting mode (Hosting, below).
- Auth: run `gh auth token` once, before the first GitHub call, and again on any 401; never store the token. Fetching the token is local; it is not a GitHub call.
- Viewer: an empty `viewer` is resolved at startup from gh's own config file (`gh config get user -h github.com`, the active account), which is local and not a GitHub call. Only when that names nobody does the first cycle ask `gh api user` before it fetches anything.
- Cache first, always: every read the UI makes is answered from SQLite immediately and never waits on GitHub. Fresh data reaches the UI only as patches on the event stream, so a slow or failed GitHub call can delay an update but never delay or blank the page.
- Active pages: every connected page is a client with an id, and reports whether it is visible (the Page Visibility API's `document.visibilityState`) and whether it is paused (the header's Pause control, section 6). A client is active when it is visible and not paused. A background tab or a minimized window is hidden; a visible page in an unfocused window still counts as visible. The server keeps the clients in memory only (`src/clients.ts`): a client exists while its event stream is open and is dropped when the stream closes.
- The UI polls only while it is active: UI-driven cycles run only while at least one client is active. With no active client the server makes no GitHub calls for the UI, and the interval timer is cleared rather than left to fire and skip. No cycle runs at server start.
- Refresh cycles start on these triggers, each recorded as the cycle's `trigger`:
  - `active`: a client becomes active (it opens its stream visible and unpaused, becomes visible, or resumes), no cycle is running, and the last cycle of any trigger started more than 30 seconds ago. Opening or returning to a page therefore always shows the cache first, then refreshes only when that data is older than 30 seconds.
  - `interval`: every `refreshSeconds` while at least one client is active, counted from the start of the last cycle of any trigger, so a cycle that just ran for another reason postpones the next interval cycle rather than doubling it. The timer starts when the first client becomes active and stops when the last one goes inactive; a cycle already running when that happens finishes.
  - `manual`: `POST /api/refresh`, a one-shot from any page, paused or not.
  - `config`: a saved config change that needs one (`PUT /api/config`), also a one-shot.
  - `autoReview`: phase 4's scheduler, on its own clock and never on the UI's schedule (section 10).
- Only one cycle runs at a time; a trigger during a cycle joins it. A cycle runs its fetch units concurrently: the open-PR query (page by page) and the closed search. Reports in `reportsDir` are rescanned at the start of every cycle.
- Per-response apply: as each response arrives (each open-PR page, the closed search), the poller writes it to SQLite, recomputes only the rows it touched plus the tiles and counts, and emits one patch. Rows the cycle has not reached yet keep their cached values.
- Completion: when every open-PR page has arrived, PRs still cached as open but absent from the full list are removed from the open sections (they closed or merged; the closed search picks them up). A cycle that did not finish removes nothing.
- Failure: on any network or GitHub error the cycle stops, keeps every row it already updated, marks the rows and sections it did not reach as stale with the error and their last fetch time, and the next cycle runs at the normal interval if a client is still active, or when one next becomes active.

### Hosting

The same server runs in one of two modes, on the same loopback address and port. Phase 4's scheduler behaves the same in both: it runs whenever the app is running, whether or not a page is open. The mode decides only how the app gets started.

| Mode | Started by | Lifetime | Use |
| --- | --- | --- | --- |
| Manual (the default) | `pnpm start` in a terminal | until stopped | v1, development, and auto-review while the app is up |
| Service (optional) | a launchd user agent installed by `pnpm service:install` (M13) | starts at login, restarted if it exits with an error | a convenience: the app is already running after login or a reboot, with no terminal to keep open |

- Manual start is the default, and nothing in any phase requires the service: v1 needs nothing else, and auto-review runs under a manual start for as long as the app is up. Starting at login is a separate, optional convenience. M5 still builds the server so that it can run as a service without changes, and M13 adds the service whenever the owner wants it.
- In both modes the server idles when nobody is looking: with no active client, and auto-review off or outside its hours, it makes no GitHub calls and starts no processes. It holds only the scheduler's timer for its next tick or next active-hours start, and sends keepalives on any open streams.
- What M5 builds so the service needs no server changes: no GitHub call at startup; a clean exit on `SIGTERM` and `SIGINT` (close the streams, finish the SQLite write in progress); when the port is already taken, an exit with a non-zero status and a message naming the port, never a fallback to another port (the port is bound before the cache is opened, so the second server exits without touching the running one's cache); logs on stdout and stderr only; every path resolved from the config, `os.homedir()` or `import.meta.url`, never from the working directory, since launchd starts the process in `/`.
- The service, when installed: a user agent labeled `local.pit-view`, its plist at `~/Library/LaunchAgents/local.pit-view.plist` with `RunAtLoad` true, `KeepAlive` set to restart only on an unsuccessful exit, `ProgramArguments` holding the absolute path of the Node binary (`process.execPath` at install time) and of `src/server.ts`, `EnvironmentVariables` holding the `PATH` captured at install time so `gh` and the review command runner resolve (launchd's default `PATH` lacks most user tool locations), and stdout and stderr redirected to `~/Library/Logs/pit-view/server.log`.
- `pnpm service:install` writes the plist and loads it with `launchctl bootstrap gui/<uid>`, replacing an earlier install, so it is safe to rerun (and must be rerun after upgrading Node, since the plist pins the binary). `pnpm service:uninstall` runs `launchctl bootout gui/<uid>/local.pit-view` and removes the plist. `pnpm service:status` says whether the agent is loaded and whether `127.0.0.1:4791` answers. The plist is written at install time from real paths and never committed (section 2).
- With the service running, a manual `pnpm start` exits with the port-taken message; the service is the one server. Neither mode binds anything but `127.0.0.1`.
- The service runs in the user's login session, so `gh auth token` reads the same credentials as a terminal; M13 confirms this.

### GitHub queries

Open PRs: one GraphQL query per cycle, `pullRequests(states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC})` paginated by 100, so the most recently changed PRs refresh first. Each page is handed to the poller as it arrives. For each PR it fetches: `number`, `title`, `url`, `isDraft`, `author { login avatarUrl }`, `headRefName`, `baseRefName`, `headRefOid`, `createdAt`, `updatedAt`, `additions`, `deletions`, `changedFiles`, `mergeable`, `mergeStateStatus`, `reviewDecision`, `body` (only to detect the no-ticket marker; never displayed), `reviewRequests { requestedReviewer { ... on User { login } ... on Team { name } } }`, `latestReviews { author { login } state submittedAt commit { oid } }`, `commits(last: 1) { commit { oid committedDate statusCheckRollup { contexts(first: 100) { ... on CheckRun { name conclusion status detailsUrl checkSuite { workflowRun { workflow { name } } } } ... on StatusContext { context state targetUrl } } } } }`, `closingIssuesReferences(first: 10) { number title url }`, and `timelineItems(last: 5, itemTypes: [PULL_REQUEST_COMMIT, PULL_REQUEST_REVIEW, ISSUE_COMMENT, REVIEW_REQUESTED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, RENAMED_TITLE_EVENT, HEAD_REF_FORCE_PUSHED_EVENT]) { ... }` for last activity. Reviews since the viewer's last review also need `commits(last: 30) { commit { oid committedDate } }` to count pushes; fetch it in the same query.

Closed PRs: one search query `repo:<repo> is:pr is:closed closed:<from>..<to>`, where `<from>` is the start of the Yesterday range (section 5, Monday rule included) and `<to>` is now, so a single response fills both the Today and Yesterday views and the Closed tile's subtext. It fetches the per-PR fields the Closed table needs (number, title, url, author, state, merged, mergedBy, closedAt, headRefName, closingIssuesReferences).

### SQLite cache

File: `~/.local/state/pit-view/cache.sqlite`.

| Table | Columns | Purpose |
| --- | --- | --- |
| `cycles` | `id`, `repo`, `trigger` (`active`, `interval`, `manual`, `config` or `autoReview`), `started_at`, `finished_at`, `ok`, `error`, `error_kind` (gh's error kind, `interrupted` or `internal`; added in M11, schema version 3), `pages_done`, `prs_updated` (distinct PRs written), `prs_total` | One row per refresh cycle; keep the last 200. |
| `snapshots` | `id`, `cycle`, `repo`, `kind` (`open-page` or `closed`), `page`, `fetched_at`, `ok`, `error`, `payload` (raw JSON) | Raw responses; keep those of the last 50 cycles. |
| `prs` | `repo`, `number`, `state`, `updated_at`, `head_oid`, `fetched_at`, `cycle`, `last_seen_at`, `data` (normalized JSON) | Latest known state per PR and when it was fetched; the source of every open row. |
| `meta` | `key`, `value` | `schemaVersion`, plus per-repo JSON values: `lastSuccess:<repo>`, `lastError:<repo>`, `closedFetched:<repo>`, `openListed:<repo>` (last cycle that reached the final page), `defaultBranch:<repo>`. |

The view is always computed from `prs` (open rows), the latest successful `closed` snapshot, local reports and the config. A failed or partial cycle never blanks or rolls back a row; it only changes the freshness the row reports.

### Freshness

Every row and every section carries its own freshness, so the UI can show which parts are current:

| State | Meaning |
| --- | --- |
| `current` | Fetched by the latest finished cycle, or already by the running one. |
| `pending` | A cycle is running and has not reached it yet; the cached value is shown. |
| `stale` | The latest cycle failed before reaching it; the cached value is shown. |
| `loading` | Sections only: nothing has ever been fetched (first run, empty cache). |

### HTTP API

All responses are JSON. Times are ISO 8601 UTC strings; the UI formats them.

`GET /api/view` returns the whole dashboard from the cache, immediately:

```json
{
  "version": 42,
  "repo": "owner/name",
  "viewer": { "login": "viewer", "alias": "You", "initials": "VW", "color": "#1D4ED8", "avatarUrl": null },
  "sync": {
    "refreshSeconds": 300,
    "lastSuccessAt": "2026-10-27T14:02:00Z",
    "ui": { "activeClients": 1, "nextCycleAt": "2026-10-27T14:10:00Z" },
    "cycle": { "id": 17, "trigger": "interval", "state": "running", "startedAt": "2026-10-27T14:05:00Z", "finishedAt": null, "error": null, "errorKind": null, "prsUpdated": 12, "prsTotal": 30 },
    "sections": {
      "open": { "state": "pending", "fetchedAt": "2026-10-27T14:02:00Z", "error": null },
      "closed": { "state": "current", "fetchedAt": "2026-10-27T14:05:02Z", "error": null }
    }
  },
  "now": "2026-10-27T14:05:38Z",
  "autoReview": null,
  "tiles": { "yourMove": 11, "mineChangesRequested": 1, "mineChangesRequestedDetail": { "number": 101, "by": "Alex", "at": "2026-10-26T22:14:00Z" }, "mineReadyToMerge": 4, "waitingOnAuthor": 10, "closedToday": 0, "closedPrevious": { "count": 13, "merged": 10, "closed": 3, "label": "yesterday" } },
  "counts": { "mine": { "open": 12, "drafts": 4 }, "others": { "open": 30 } },
  "mine": { "groups": [ { "key": "changesRequested", "label": "Changes requested", "sub": "your move", "collapsible": false, "rows": [ "MineRow" ] } ] },
  "others": { "groups": [ { "key": "yourMove", "label": "Your move", "sub": "requested of you, not reviewed by you, or pushed since your review", "collapsible": false, "rows": [ "OtherRow" ] } ] },
  "closed": {
    "today": { "label": "Today", "isMondayRule": false, "from": "2026-10-27T04:00:00Z", "to": "2026-10-27T14:05:38Z", "rows": [ "ClosedRow" ] },
    "yesterday": { "label": "Yesterday*", "isMondayRule": true, "from": "2026-10-23T04:00:00Z", "to": "2026-10-26T04:00:00Z", "rows": [ "ClosedRow" ] }
  }
}
```

`cycle` is null before the first cycle. `cycle.state` is `running`, `finished` or `failed`; `cycle.trigger` is one of the triggers in Runtime. `cycle.errorKind` says why a failed cycle failed: `network`, `auth`, `rateLimit`, `graphql`, `command` or `parse` (gh's own error kinds), `interrupted` (the server stopped mid-cycle) or `internal`; it is null otherwise. `sync.ui` is the server's shared polling state: how many clients are active and when the next interval cycle is due, `nextCycleAt` being null while no client is active. Whether this page is paused is the page's own state, not part of the view. `autoReview` is null until phase 4 (shape in section 10). Both Closed ranges are always present, so the Today / Yesterday control switches locally without another request; Today's `to` is the server's `now` when the view or the closed patch was made. `counts` holds the section heading counts, the same object patches carry. Every group is always present, empty or not, in display order (Mine: `changesRequested`, `readyToMerge`, `awaitingReview`, `drafts`; Others': `yourMove`, `readyToMerge`, `waitingOnAuthor`, `bots`), and `collapsible` is true for Mine's Drafts and Others' bots. Group labels and subs are fixed except the bots label, which is the bot's alias when only one bot appears and "Bots" otherwise; patches do not carry groups, so the UI recomputes that label from the rows it holds. `viewer.avatarUrl` and every person's `avatarUrl` follow `config.people[].avatar`: a GitHub image URL for `github` and for unlisted people, null for `initials`, and `/api/avatar/<login>` for a local image (Other endpoints, below).

Shared row fields (`PrBase`):

```json
{
  "number": 101,
  "url": "https://github.com/owner/name/pull/101",
  "title": "fix(scope): example title",
  "author": { "login": "alex", "alias": "Alex", "initials": "AL", "color": "#0F766E", "avatarUrl": "https://..." },
  "headRef": "fix/example", "baseRef": "main", "headOid": "755b78b",
  "createdAt": "...", "additions": 212, "deletions": 48, "changedFiles": 7,
  "tickets": [ { "system": "Jira", "label": "ABC-251", "url": "https://jira.example/browse/ABC-251" } ],
  "stack": { "position": 2, "size": 4 },
  "reviewers": [ { "login": "viewer", "alias": "You", "initials": "VW", "color": "#1D4ED8", "state": "changes" } ],
  "issues": [ { "kind": "ciFailing", "label": "CI failing · 1", "count": 1, "url": "https://github.com/owner/name/actions/runs/1/job/2", "tip": "Open the failing job: Unit tests" } ],
  "merge": { "state": "ready", "label": "Ready" },
  "lastActivity": { "at": "...", "actor": "Alex", "text": "Alex pushed 1 commit" },
  "freshness": { "state": "current", "fetchedAt": "2026-10-27T14:05:01Z" },
  "agent": null
}
```

`reviewers[].state` is `approved`, `changes`, `commented` or `requested`; a pip for a requested team carries `team: true`, with the team's name as its `login` and `alias`. `issues[].kind` is `changesRequested`, `conflicts`, `ciFailing`, `ciRunning`, `ciCanceled` or `ciNotRun`; `url` is set only for `ciFailing`. `merge.state` is `ready`, `needsReview`, `needsApproval`, `checking`, `blocked` or `draft`. `stack` is null for unstacked PRs. `tickets` may hold a `{ "system": "none", "label": "no-ticket" }` entry. `freshness.state` is one of the row states in Freshness above; a row's `freshness` carries only `state` and `fetchedAt`, the error living in `sync.cycle.error` and the sections. `agent` is null until phase 2 (shape in section 8). Person `color` values are config data, not styling; the UI applies them through one CSS custom property (section 4).

`OtherRow` adds `section: "others"`, `group` (`yourMove`, `readyToMerge`, `waitingOnAuthor`, `bots`) and `flags` (list of `{ "kind": "reReview", "label": "Re-review · 1 push since yours", "count": 1 }` or `{ "kind": "requestedOfYou", "label": "Requested of you" }`).

`MineRow` adds `section: "mine"`, `group` (`changesRequested`, `readyToMerge`, `awaitingReview`, `drafts`), `stage` (`changesRequested`, `awaitingReview`, `approved`, `draft`), `selfReview` (`{ "state": "current" | "stale" | "none", "reviewedOid": "b5d43a3", "headOid": "5c65b9b", "tandem": true, "file": "PR-101.md", "at": "..." }`) and `changesRequested` (`{ "login": "alex", "alias": "Alex", "at": "..." }` from the latest changes-requested review, for the call-out banner, or null).

`ClosedRow` is `number`, `url`, `title`, `author`, `outcome` (`merged` or `closed`), `closedBy` (`{ "alias": "Alex", "login": "alex", "text": "merged by Alex" }`, with `text` "merged by you" for the viewer, or `{ "label": "superseded", "text": "superseded" }`, or `{ "label": "merged" | "closed", "text": ... }` when GitHub names no actor), `closedAt`, `tickets`.

`GET /api/events?client=<id>&visible=<true|false>&paused=<true|false>` is a server-sent events stream of patches. The page generates its client id once per load (`crypto.randomUUID()`) and reuses it on every reconnect, and the query carries its current state, so a reconnect restores the client exactly; opening the stream registers the client and closing it drops the client. Each patch is one `patch` event, applied atomically, carrying only what changed:

```json
{
  "version": 43,
  "rows": [ "MineRow or OtherRow, upserted by number; section and group say where it goes" ],
  "removed": [ 97 ],
  "closed": null,
  "tiles": { "yourMove": 10 },
  "counts": { "mine": { "open": 12, "drafts": 4 }, "others": { "open": 30 } },
  "sync": { "cycle": { "id": 17, "state": "running", "prsUpdated": 30, "prsTotal": 30 } }
}
```

- The poller emits one patch per arrived response: an open-PR page yields the upserted rows (each with `freshness.state` `current`), the tiles and counts; the closed search yields `closed` with both ranges in full; the end of a cycle yields `removed`, the final `sync`, and, on failure, the rows it did not reach with `freshness.state` `stale`. The start of a cycle yields a `sync` patch, so the header can show "refreshing".
- As built (M5): every patch carries `version`, `now` (the server's clock, for ages), `rows` and `removed` (possibly empty) and `closed` (null when unchanged); `tiles`, `counts` and `sync` are sent whole whenever present, so merging them is a plain replace of each key. A page's PR that now derives to no row (an others' PR turned draft) arrives in that page's `removed`. The end-of-cycle patch also re-sends every row whose derivation changed since its page patch, since a stack can span pages. Rows are not re-sent as `pending` when a cycle starts: while `sync.cycle.state` is `running`, the UI treats a row whose `freshness.fetchedAt` is earlier than `sync.cycle.startedAt` as pending. A change in the active clients or the next interval sends a `sync`-only patch.
- A saved config that changes what rows say (or which repo they come from) yields one patch at once, recomputed from the cache: the rows that changed, `removed` for rows that no longer exist (all of them on a repo change), `closed` when it changed, tiles, counts and sync, plus `repo` and `viewer` when those changed. A repo change made while a cycle for the old repo runs lets that cycle finish into the cache without patching, then starts the `config` cycle for the new repo.
- `tiles`, `counts`, `sync` and, in phase 4, `autoReview` are partial objects merged into the current view; `rows` and `removed` are keyed by PR number; `closed`, when present, replaces the whole Closed section.
- `version` increases by exactly one per patch. The client opens the event stream first, then fetches `/api/view`, drops buffered patches with a version at or below the view's, and applies the rest in order. Any gap in versions, or a reconnect, means the client refetches `/api/view` and starts again from it.
- The stream sends a comment line every 30 seconds to keep the connection open. Keepalives are local and never cause a GitHub call. Patches reach every connected page, active or not, so a paused or hidden page that is still connected stays current with whatever other triggers fetch.

Other endpoints:

- `POST /api/clients/<id>` with `{ "visible": true, "paused": false }` updates a client's state. The page sends it on every `visibilitychange` and on every Pause or Resume. It returns `{ "active": true, "cycle": 18 }`, where `cycle` is the cycle this change started or joined under the `active` rule, or null. An unknown id (its stream is not open) returns 404, and the page reopens its stream, which carries its state.
- `POST /api/refresh` starts a cycle now, or joins the running one, whatever the client states; returns `{ "started": true, "cycle": 18 }` or `{ "started": false, "cycle": 17 }`.
- `GET /api/config` and `PUT /api/config` read and replace the config (validated; returns the saved config or `{ "error": "..." }` with status 400). A saved config that changes `repo`, `viewer`, `people`, `tickets` or `bots` starts a one-shot `config` cycle, and the recomputed rows arrive as patches. From phase 4, `PUT /api/config` requires the same-origin and token checks in section 10.
- `GET /api/people/suggestions` lists logins seen in cached PRs (open authors and reviewers, closed authors) that are not in `people` and are not the viewer (who always shows as You), as `[ { "login": "sam", "avatarUrl": "https://...", "count": 4 } ]`, most often seen first.
- `GET /api/avatar/<login>` serves the image file a `config.people` entry names as its `avatar` (a path under `~`), so a local image never reaches the page as a path. Only PNG, JPEG, GIF, WebP and AVIF files that resolve inside the home directory are served; anything else is 404. Derived people point at it as their `avatarUrl`.
- Every request must name the server by its loopback address (`Host` of `127.0.0.1`, `localhost` or `[::1]` with the port), so a page that reached it through another name is refused (403). Requests other than GET with an `Origin` header that is not the server's own are refused (403), and JSON bodies must be sent as `application/json` (415 otherwise), which keeps another site's page from writing through a simple request. These are the cheap half of section 9's checks; the per-start token still comes with phase 4 or v3.
- `GET /api/config` returns the config as stored, so an empty `viewer` stays empty there; the view's `viewer` is the resolved login. `GET /` serves `public/index.html`; `public/*.ts` is served as `text/javascript` after `stripTypeScriptTypes`, and dot files and paths outside `public/` are 404.
- The event stream starts with a `: connected` comment, so the page's `EventSource` opens before it fetches the view, and keepalives are `: keepalive` comments. Patches carry no SSE `id`, since nothing is replayed.

Grouping, filtering and sorting are done in the UI from these rows; the server only assigns `group` and computes derived fields.

## 4. Code conventions

These are the owner's conventions, adapted to this app. They apply to every file under `pit-view/`, tests and fixtures included.

- TypeScript everywhere (`src/`, `public/`, `test/`), ES modules only (`"type": "module"`), written for Node's type stripping as described in section 3. Runtime is Node; pnpm is only the package manager. Zero runtime dependencies stays the rule: new needs are met from Node's built-ins or not at all.
- Single-quoted strings; template literals only when interpolating. JSON files keep JSON's double quotes.
- No end-of-line semicolons. A line that would otherwise start with `(`, `[` or a template literal starts with `;` instead.
- Single-line comments begin with a lowercase letter, except acronyms and proper nouns (`// gh returns 401 when the token expired`, `// SQLite keeps one row per PR`).
- Every file starts with a path comment relative to `pit-view/`: `// src/derive.ts` in TypeScript, `/* public/styles.css */` in CSS, `<!-- public/index.html -->` in HTML. JSON and Markdown files are exempt because they have no comment syntax or are documentation.
- Named exports and `const` arrow functions; no default exports, no `function` declarations, and no classes except error types (for example `GhError extends Error`). Streams of results, such as GraphQL pages, are delivered to a callback rather than through a generator.
- Plain CSS. Every color is a `light-dark()` token defined once in `public/styles.css`, which sets `color-scheme: light dark`. No literal hex or other color value appears anywhere else: not in other CSS, not in HTML, not in TypeScript. Person colors from the config are data, set on an element as the `--person` custom property, which the stylesheet consumes.
- Modules that touch the outside world take their dependencies as arguments: file paths, the home directory, the clock, and the command runner for `gh`. Only `src/server.ts` resolves the real defaults.
- Tests use `node:test` and `node:assert` with in-memory SQLite (`:memory:`) and temporary fixture directories from `fs.mkdtemp` under `os.tmpdir()`. A test never reads or writes the real `reportsDir`, the real `~/.config/pit-view/config.json` or the real cache, and never runs the real `gh`; it passes a fake runner that replays fixtures.

A file in this style:

```ts
// src/time.ts
import type { Clock } from './config.ts'

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour

// relative age: minutes under an hour, hours under a day, days otherwise
export const formatAge = (fromIso: string, clock: Clock): string => {
  const elapsed = clock.now() - Date.parse(fromIso)
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`
  return `${Math.floor(elapsed / day)}d`
}
```

## 5. Derivation rules

All rules are pure functions in `src/derive.ts`, tested against invented fixture JSON. "The viewer" is `config.viewer`.

### Bots

A PR is a bot PR when its author login contains any `config.bots` entry (case-insensitive). Bot PRs always go to the `bots` group in Others', whatever else applies.

### Reviewer pips

Built from `latestReviews` (one per reviewer) plus pending `reviewRequests`:

| State | Mark | Color | Source |
| --- | --- | --- | --- |
| approved | ✓ | green | latest review state `APPROVED` |
| changes | ✗ | red | latest review state `CHANGES_REQUESTED` |
| commented | … | gray | latest review state `COMMENTED` |
| requested | ○ | amber | in `reviewRequests` with no newer review |

A reviewer who has both a past review and a pending re-request shows as `requested`.

### Flags (Others' only)

- **Re-review · n pushes since yours**: the viewer has a latest review, and the head commit differs from that review's `commit.oid`. `n` is the number of commits after the reviewed commit in `commits(last: 30)`; if the reviewed commit is not in that window (force push or rebase), show `Re-review · new commits`.
- **Requested of you**: the viewer is in `reviewRequests`.

### Issue chips

Evaluated in this order and shown in this order:

1. **Changes requested**: `reviewDecision == CHANGES_REQUESTED`.
1. **Conflicts**: `mergeable == CONFLICTING`.
1. **CI failing · n**: n status contexts concluded `FAILURE`, `TIMED_OUT`, `STARTUP_FAILURE` or `ERROR`. The chip links to the first failing check's `detailsUrl` (the job run page), with the job name as its tooltip.
1. **CI running · n**: n contexts queued, in progress, pending or waiting.
1. **CI canceled · n**: n contexts `CANCELLED`, and none failing.
1. **CI not run**: the head commit has no status contexts at all (typical when conflicts block the workflow).

`mergeable == UNKNOWN` (GitHub has not computed it yet) produces no chip; it is rechecked on the next cycle.

### Merge state

| State | Label | Rule |
| --- | --- | --- |
| draft | — | `isDraft` |
| ready | Ready | `mergeStateStatus == CLEAN` |
| needsApproval | Needs approval | no issue chips, `reviewDecision` empty or `REVIEW_REQUIRED`, and at least one review exists |
| needsReview | Needs review | no issue chips and no reviews yet |
| checking | Checking | no issue chips and `mergeStateStatus == UNKNOWN`: GitHub has not computed mergeability yet, typically just after the base branch moved; the next cycle reads it (added in M11, where approved PRs showed Blocked for one cycle) |
| blocked | Blocked | anything else (any issue chip, or `BLOCKED`, `DIRTY`, `BEHIND`, `UNSTABLE`) |

The rules apply top to bottom, so a PR with no reviews whose state is `UNKNOWN` still reads Needs review. Sorting puts Checking between Needs review and Blocked; the Merge filters have no Checking option (it shows under any, and as Not ready in Mine).

### Others' groups, in precedence order

1. **Dependabot** (`bots`): bot PR. The group is labeled with the bot's alias when only one bot appears, otherwise "Bots".
1. **Ready to merge** (`readyToMerge`): merge state `ready`. Only the author can act.
1. **Waiting on author** (`waitingOnAuthor`): any of Conflicts, CI failing, CI not run, or Changes requested with no commits since the latest changes-requested review. A PR here still shows the Requested of you flag when it applies.
1. **Your move** (`yourMove`): anything left that is not a draft: the viewer is requested, has never reviewed it, or it has commits since the viewer's latest review.
1. Others' drafts are hidden in v1 (none occurred in practice); revisit if they matter.

Within a group, the default (attention) order is: flags first (Re-review, then Requested of you), then most recent activity first.

### Mine groups and stage

| Group | Stage | Rule |
| --- | --- | --- |
| Changes requested | changesRequested | not a draft and `reviewDecision == CHANGES_REQUESTED` |
| Ready to merge | approved | merge state `ready` |
| Awaiting review | awaitingReview or approved | any other non-draft PR |
| Drafts | draft | `isDraft`; collapsed by default |

The Changes requested group drives the red call-out banner above the Mine table: one line per PR, "<reviewer> requested changes on #n · <age>", the title, and the self-review state, with "Open review" (the PR's review URL) and, in phase 2, "Start a fix session".

### Self-review detection (Mine only)

1. Look in `reportsDir` for `PR-<number>.md`; if absent, for the branch-named report: the head branch with every character that is not alphanumeric, `-` or `_` replaced by `-`, runs of `-` collapsed, plus `.md`.
1. Parse the first line matching `Reviewed commit:`; it carries the branch and a short SHA in backticks. Extract the SHA.
1. **Current** when the SHA is a prefix of `headRefOid`; **Stale** otherwise, displayed as `<reviewedSha> → <headShort>`; **None** when no report exists.
1. **Tandem** when sibling files `PR-<number>-<suffix>.md` (any suffix) exist next to the report.
1. Read only the first 20 lines; never display report contents in v1.

v1 detects self-reviews from these files, as built. Section 10, Report storage, proposes moving detection to Pit View's database, with `reportsDir` kept as a legacy import source during the transition.

### Last activity

The most recent of: commits (pushed), reviews (approved, requested changes, commented), issue comments, review requests, ready-for-review or draft conversion, title edits, force pushes. Text is "<actor alias> <verb>", for example "Alex pushed 3 commits" (consecutive commits by one actor merge into one count), "You requested changes", "Sam approved", "Alex edited the title". The age is relative: `34m`, `16h`, `4d`, using minutes under an hour, hours under a day, days otherwise.

### Stacks

A PR is stacked when its base ref is another open PR's head ref. Walk base links down to a PR whose base is the default branch; that PR is position 1. `stack n/m` shows the PR's position and the stack's size. A PR that is the base of another but itself targets the default branch is position 1 of that stack. Stack membership is recomputed for every open row when a cycle completes, since a page can change a PR that other pages' PRs stack on.

### Tickets

For each enabled ticket system, in config order:

- `title-then-branch`: match `pattern` against the title first; if nothing matches, against the head branch. Every distinct match is a ticket (uppercased for display).
- `linked-issues`: every `closingIssuesReferences` entry is a ticket labeled `#<n>` with the issue's URL.
- The description is read only to detect the `no-ticket` marker (`\bno-ticket\b`, case-insensitive). When present and no other ticket was found, show a `no-ticket` chip without a link.

Links use the system's `linkTemplate` with `{baseUrl}`, `{key}`, `{repo}` and `{n}` substituted; an empty `baseUrl` on a template that uses it means no link.

### Closed range and the Monday rule

- **Today**: from the start of the current day (per `todayStartsAt`) to now.
- **Yesterday**: the previous day. On a Monday, Yesterday covers Friday 00:00 through Sunday 24:00, its label becomes `Yesterday*`, and the table shows the footnote "* On Mondays, Yesterday covers Friday through Sunday." Times in that range show the weekday ("Sun 5:53 PM").
- The Closed section defaults to Today. When Today is empty it still shows Today with its empty state; the viewer switches to Yesterday.
- `closedBy` is "merged by <alias>" for merged PRs, "merged by you" for the viewer, and "superseded" or "closed by <alias>" for closed-unmerged ones (bot PRs closed by the bot itself are "superseded").

## 6. UI specification

### Visual tokens

Each token is a `light-dark()` pair in `public/styles.css` (section 4). The values below are the light halves, as approved in the mockup; M6 chooses each dark half and checks it against the same contrast rules.

| Token | Light value | Use |
| --- | --- | --- |
| ground | `#F6F6F3` | page and group header background |
| surface | `#FFFFFF` | cards, tables |
| ink | `#17181A` | text |
| muted | `#5B5F66` | secondary text (passes 4.5:1 on white) |
| line | `#E4E4E0` | card borders |
| line-row | `#ECECE8` | row separators |
| line-control | `#D9D9D4` | control borders |
| blue | fg `#1D4ED8`, bg `#E3ECFD` | your move, flags, links |
| red | fg `#9F1D1D`, bg `#FDE7E7` | changes requested, CI failing, closed unmerged |
| red-row | `#FFF7F7` | background of rows in Mine's Changes requested group |
| amber | fg `#7A4106`, bg `#FCEFD2` | conflicts, CI running, stale self-review, offline, stale rows |
| green | fg `#14632F`, bg `#DDF5E3` | ready, approved, current self-review |
| purple | fg `#5B21B6`, bg `#EEE8FD` | merged |
| gray | fg `#4A4E55`, bg `#EEEEEB` | neutral chips, bots |

Type: Inter 400/500/600/700 for UI, 13px base; JetBrains Mono 500/600 for PR numbers, SHAs, ages and times. Chips are 22px tall, 4px radius, 12px semibold. Avatars are initials on the person's color in a circle (28px in rows, 22px in Closed, 18px in reviewer pips), white text.

### Page structure

1. **Header**: logo and "Pit View"; repo selector button; "viewing as" avatar and login; sync status ("updated 38s ago · every 5m"; "refreshing · 12 of 30" while a cycle runs; "offline · cached 10:02 AM" in amber after a failed cycle; "paused · updated 4m ago" while this page is paused); in phase 4, the auto-review indicator (section 10); refresh button; pause button; theme toggle; settings link.
1. **Offline banner** (only when the latest cycle failed): amber strip, "Can't reach GitHub. Showing cached data from <time> (<age> old)." plus "Ages, CI and merge states may be out of date. Retrying every <interval>." While this page is paused, the second sentence ends "Updates are paused; Refresh retries once." instead. `<time>` is the oldest fetch time among the rows and sections shown. When the cycle failed partway, the first sentence reads "Refresh stopped partway: <n> of <m> PRs updated; the rest show cached data from <time> (<age> old)." As built (M11), the opening clause and the header's word follow `cycle.errorKind`: unreachable reads as above ("offline"); `auth` reads "GitHub did not accept gh's sign-in" ("sign-in failed") and adds "Check it with gh auth status in a terminal." before the retry sentence; `rateLimit` reads "GitHub's rate limit stopped the refresh" ("rate-limited"); `interrupted` reads "The last refresh stopped when Pit View did" ("interrupted"); any other kind reads "The refresh failed (<error>)" ("refresh failed"). A failure recorded without a kind reads as unreachable.
1. **Summary tiles**, five, in a wrapping grid: Your move (blue number), Changes requested on yours (red card), Yours ready to merge (green number), Waiting on author (gray number), Closed today (purple number; subtext "<n> yesterday · <m> merged, <c> closed", or "Fri–Sun*" on Mondays).
1. **Mine** section.
1. **Others'** section.
1. **Closed** section.

### Loading and live updates

- The page renders the moment `/api/view` answers, from the cache, with whatever it holds. It never shows a page-wide spinner and never waits for GitHub.
- With an empty cache (first run), each section in state `loading` shows three placeholder rows and "Loading from GitHub…"; if that first cycle fails, the placeholders give way to "No cached data yet" under the offline banner.
- Patches update elements in place: a row's cells, a tile's number, a section's counts, the header's sync status. A row whose `group` changes moves to its new group; a removed row disappears. Filters and the current sort are reapplied to the affected table only. Keyboard focus and an open hover card stay with their PR by number across an update, and the scroll position is kept.
- Per-row freshness: a `stale` row shows an amber dot before its age, with the tooltip "cached <time>, refresh failed". A `pending` row looks normal unless its `fetchedAt` is older than `refreshSeconds`, in which case its age is muted and its tooltip reads "cached <time>, refreshing". A `current` row has no marker. A section that is `stale` shows the same amber dot in its heading.
- Tiles count what the tables hold, so a tile always agrees with its section, whatever the rows' freshness.

### Polling, visibility and pause

- The page reports its state to the server (section 3): it opens the event stream with its client id and current state, then sends `POST /api/clients/<id>` on every `visibilitychange` and every Pause or Resume. The page itself never polls; it only says whether it is looking.
- Returning to a hidden page shows what it already holds at once; the server refreshes only when the data is older than 30 seconds, and the patches update the page in place.
- **Pause is per page.** It pauses polling for the current interface only: this page stops counting as active, and it does not pause other tabs, the server, or phase 4's auto-review. When every page is paused or hidden, the server stops polling, since nothing is active. A paused page keeps its event stream and still applies the patches other triggers produce (another active tab, its own Refresh, auto-review), because showing newer cached data is never wrong; it just stops asking for them.
- The pause button sits immediately after the refresh button: an icon button with `aria-pressed`, labeled "Pause updates" when off and "Resume updates" when on. Pausing changes the sync status to "paused · updated <age> ago", the age being since the last successful cycle. Resuming makes the page active again, which refreshes under the 30-second rule.
- Refresh still works while paused, as a one-shot: it runs one cycle, the status shows "refreshing · 12 of 30" during it and returns to "paused · updated just now", and the page stays paused.
- The paused state is kept in `sessionStorage` (wrapped in try/catch; it defaults to unpaused when storage is unavailable), so reloading the tab keeps it paused while a new tab starts unpaused.
- While paused, a row whose `fetchedAt` is older than `refreshSeconds` gets the muted age of a `pending` row, with the tooltip "cached <time>, paused".

### Theme

- A single tri-state icon button in the header, immediately to the left of the Settings gear, and the same toggle in the Settings page's header. Each click cycles System (the default) → Light → Dark → System.
- Its icon shows the current state (a half-filled circle for System, a sun for Light, a moon for Dark), drawn as inline stroke SVGs like the header's other icons and marked `aria-hidden`; its `aria-label` and tooltip say the current state and what a click does, for example "Theme: System. Switch to light".
- It sets `color-scheme` on the root element (`light dark`, `light` or `dark`). Every color is a `light-dark()` token, so no token changes. The choice is kept per browser in `localStorage` (wrapped in try/catch; System removes the key, and unavailable storage means System), applied before first paint by a small inline script at the top of each page's `head` that `public/theme.ts` mirrors, and followed by other open tabs through the `storage` event.

### Summary tiles are filter presets

Each tile is a button (`aria-pressed`). Clicking one clears all filters, opens its target section, collapses the other two sections and applies its filter:

| Tile | Section | Filter |
| --- | --- | --- |
| Your move | Others' | Status = Your move |
| Changes requested on yours | Mine | Issues = Changes requested |
| Yours ready to merge | Mine | Merge = Ready |
| Waiting on author | Others' | Status = Waiting on author |
| Closed today | Closed | range = Today |

The active tile gets a 2px ink border and its subtext reads "showing only these · click to show all". Clicking the active tile clears all filters and reopens all three sections. Changing any filter by hand releases the tile (it becomes inactive, the filters stay). A patch never releases a tile; the filtered table simply updates.

### Sections

Each section heading is a disclosure button (chevron rotates, `aria-expanded`) that collapses the whole section. The heading shows counts ("12 open · 4 drafts").

Each table has a filter bar, a column header row, then rows (grouped or flat):

- **Filter bar**: text search (title or number, a leading `#` ignored), per-table selects, a "Group by status" checkbox (Mine and Others'), a count ("12 PRs" or "3 of 12 shown"), and a Clear button when any filter is set.
  - Mine selects: Issues (any, none, Changes requested, Conflicts, CI failing); Self-review (any, Current, Stale, None); Merge (any, Ready, Not ready).
  - Others' selects: Status (any, Your move, Ready to merge, Waiting on author, Dependabot); Author (all, then each alias seen); Issues (any, none, Changes requested, Conflicts, CI failing, CI running); Merge (any, Ready, Needs review, Blocked).
  - Closed selects: Author (all, then each alias); Outcome (all, Merged, Closed unmerged). Closed also has a Today / Yesterday segmented control in its heading, with the range summary ("Mon Oct 26 · 10 merged, 3 closed unmerged").
- **Sorting**: every column header is a button. First click sorts ascending (arrow ↑), second descending (↓), third returns to attention order. Sorting applies within groups when grouped, across all rows when not. Sort keys: PR number; title; author alias; review (flags first, then reviewed, then unreviewed; Mine: changes requested, awaiting, approved, draft); self-review (stale, none, current); issues (more issues first); last activity (most recent first ascending); merge (ready, needs review, blocked, draft); Closed time by `closedAt`.
- **Group headers**: label (colored per group), count, one-line explanation, and for collapsible groups (Mine Drafts, Others' bots) a Show n / Hide button. Bot groups also carry a "Run sweep" action in phase 2. Collapsible groups open automatically while any filter is set. Empty groups are hidden; when every group is empty the table says "No PRs match these filters."

### Columns

Mine: PR · Title · Review (stage label plus reviewer pips) · Self-review (state, and `at <sha>` or `<old> → <head>`, plus "· tandem") · Issues · Last activity (age, then text) · Merge · Agent (phase 2).

Others': Author (avatar and alias) · PR · Title (plus `stack n/m` chip) · Review (flags, reviewer pips, or "no reviews yet") · Issues · Last activity · Merge · Agent (phase 2).

Closed: Outcome (Merged or Closed chip) · PR · Ticket (only when any row in the range has one) · Title · Author · Closed by · When.

Open PRs do not get a ticket column; their tickets appear in the title's hover. Rows in Mine's Changes requested group get the faint `red-row` background.

### Hover card

On hovering a PR number or title (and on keyboard focus of the PR link): full title; `head → base`; author login; "opened <age> ago"; `+additions −deletions · n files`; head short SHA; tickets as linked chips; and, when the row is not `current`, "cached <time>". Nothing from the body.

### Settings page

Sections: Repository and viewer (two text fields; viewer notes it defaults to the gh login and uses gh's token); People (table of login, alias, initials, avatar mode select, live preview with color swatch; "+ Add person"; note that unlisted people get their GitHub avatar); Tickets (table of systems with on/off, kind select, source, key pattern, link template, sample chip; "+ Add ticket system"; note on where patterns look); Behavior (refresh interval with "5 minutes (default)" first, then 2 minutes and 60 seconds, noted as applying only while a page is open, visible and not paused; "Today" starts at; bots list; self-review reports folder); in phase 4, Auto-review (section 10). The config file path is shown in the page header.

As built (M10), at `/settings.html` (`public/settings.html`, `settings.ts`, and the pure `settings-form.ts`):

- Header: a link back to the dashboard, the title, the config path written with `~`, and the theme toggle. The dashboard's repo button links to `#repository`, which focuses the Repository field.
- People rows: login, alias, initials, avatar mode (Initials, GitHub avatar, Image file with a path under `~`), color (a color input), a preview drawn with the dashboard's own avatar (an image file shows only once saved at that path, since the server serves only the saved one; until then the initials show), and Remove. Person colors are config data and reach the page only as the `--person` custom property, the one exception to tokens-only colors; a new person gets a color computed from the login and darkened until white initials reach 4.5:1. A "Seen in PRs, not listed yet" list shows `GET /api/people/suggestions` less anyone already in the form; clicking one adds a row with a guessed alias and the dashboard's default initials.
- Ticket rows: On, kind, name, where tickets are found, key pattern (disabled for linked issues), base URL, link template, a "Shows as" sample, and Remove. Changing the kind fills in that kind's defaults only over fields still empty or holding the old kind's defaults. The sample is the chip the dashboard would show for the first cached open PR title, then branch, then cached closed PR title (added in M11, since a repository's open PRs may carry no keys at all), the pattern matches, falling back to invented example keys, with the link it would carry as its tooltip.
- Behavior also holds row density and the Agent column switch.
- Saving: the form sends only known keys (and carries over settings it does not edit, such as `notifications`) through `PUT /api/config`. Checks run on Save and then follow every edit; each error sits under its field, which gets `aria-invalid` and an `aria-describedby` naming the hint and the error, and a focused summary above the form links to each field. A refusal from the server is placed on the field its path names, or shown in the summary when the form has no such field. A sticky save bar has the status line (`role="status"`), Discard changes and Save; a save that changes `repo`, `viewer`, `people`, `tickets` or `bots` says the dashboard is refreshing. After a save the page posts on a `BroadcastChannel`, so an open dashboard rereads density and the Agent column at once; everything else reaches it as the save's patch. Leaving with unsaved changes asks first.

### Responsiveness and accessibility

- Tables sit in horizontally scrolling boxes with a minimum width (about 1180px for open PRs, 1000px for Closed); the header and tiles wrap at phone width.
- Use real buttons, links, inputs and labels; icon-only buttons have `aria-label`; decorative SVGs are `aria-hidden`.
- Text meets 4.5:1 contrast in both color schemes; colors that must be told apart also differ in lightness. Freshness is never shown by color alone: the stale dot has a tooltip and an accessible name.
- The changes-requested banner uses `role="alert"` only when it first appears, not on every patch.
- Header sync status is an `aria-live="polite"` region updated at most once per cycle (start and end), not per patch, and once on each Pause or Resume.
- The pause button is a real `button` with `aria-pressed` and an `aria-label` that names the action ("Pause updates", "Resume updates"); the icon is `aria-hidden`.

## 7. Caching and GitHub efficiency

v1 decision: cache first. Each cycle runs one GraphQL query for open PRs (most recently updated first, page by page) and one search query covering both Closed ranges, every 5 minutes by default while at least one page is visible and not paused, plus when a page becomes active and on manual refresh. With no active page the UI causes no GitHub calls at all. Each response is stored in SQLite and pushed to the UI as a patch as soon as it arrives; the UI itself only ever reads the cache. A failed cycle leaves every cached row in place, marked stale where it was not refreshed. No incremental fetching in v1: every cycle refetches every open PR.

Why polling is cheap: GraphQL is limited to 5,000 points per hour, and a query like the open-PR one costs a point or two per page, so even a 60-second interval uses a few percent of the budget. The page-becomes-active trigger is bounded by its 30-second floor, and nothing polls while every page is hidden or paused. Phase 4's scheduler adds at most one cycle per tick, every 15 minutes during its active hours (section 10).

Open investigations, to look at only if polling ever becomes a problem:

1. **Incremental fetch by `updatedAt`**: the open query is already ordered by `UPDATED_AT` descending, so it could stop at the last seen value, or search `is:pr updated:>=<time>`. To verify: CI completing probably does not change a PR's `updatedAt` (checks belong to the commit), and a moving base branch can create conflicts without changing it. If so, PRs with pending CI or `UNKNOWN` mergeability still need rechecking every cycle, as targeted per-PR queries whose results arrive as their own patches.
1. **REST conditional requests**: REST supports ETag with `If-None-Match`; a `304 Not Modified` does not count against the rate limit. `gh api` can send the header and also has `--cache`. GraphQL does not support conditional requests.
1. **Notifications API**: a cheap "something changed for you" signal with `Last-Modified` and `X-Poll-Interval`; covers only threads the viewer is involved in.
1. **Repository events API**: also supports conditional requests, but GitHub documents delays from 30 seconds to hours; probably not worth it.
1. **Webhooks**: true push via the `gh webhook forward` extension to localhost, which needs admin rights on the repository. Check whether the viewer has admin.

## 8. Phase 2: agent integration

Pit View starts and watches review sessions; it never posts to GitHub itself. Posting stays with the review commands and their own rules (one post, after the report file is written; nothing posted on the viewer's own PRs).

### Agent cell (both open tables)

`agent` on a row:

```json
{ "state": "idle" | "running" | "done", "label": "Tandem re-review", "startedAt": "...", "lastStepAt": "...", "finishedAt": null, "result": null, "lastReviewAt": "..." }
```

- **running**: blue dot, label, then "running 3m · last step 20s ago". Links to the drawer.
- **done**: the result ("Changes requested", "Approved", "Clean · mark ready?"), then "finished 17h ago". Links to the drawer.
- **idle**: a dashed button ("Review", "Re-review", "Self-review", or "Fix session" on own PRs with changes requested), with "last review 7d ago" under it when a report exists.

Agent state reaches the UI the same way as everything else: the row is upserted in a patch whenever a run's progress or result changes, so the cell and the drawer update in place. Runs are cached in a `runs` table (`id`, `repo`, `number`, `command`, `dir`, `started_at`, `last_step_at`, `finished_at`, `status`, `result`), so a reload or restart shows the last known state at once.

### Drawer

Opens from the right over the dashboard, from the Agent cell or the changes-requested banner. Contents: PR number, author, full title, `head → base · head <sha>`; Start buttons (Review PR, Review in tandem, Open a session here; Fix mode only on the viewer's own PRs, confirmed by matching the gh login against the PR author; stacked PRs offer Review stack instead, which reports only and never fixes); Running card with "running Xm · last step Ys ago · <sha>", Open session and Stop, a five-step progress bar (Resolve base, Review, Consolidate, Write report, Post) and, for tandem runs, primary and secondary status; a Waiting card when a run stopped to ask a question (below), showing the question and Open session; Reports on disk (each `PR-<n>*.md` with its reviewed SHA, verdict and an Open link).

### Machine-readable call and response from pit-crew's commands

Pit View needs to start a review the way an orchestrator starts a subagent: a fixed request in, progress it can observe, and a fixed response out. pit-crew's review commands gain this as an addition. A command invoked without it behaves exactly as today; a command invoked with it still does everything it does today, including writing its human-readable report and posting under its own rules, and additionally emits the machine-readable files.

- **The flag**: `--emit-json=<run-dir>` on `review-pr`, `review-local`, `review-stack`, `review-dependabot` and `review-dependabot-sweep`. Pit View creates `<run-dir>` under `~/.local/state/pit-view/runs/<run-id>/` and passes its absolute path. Every other argument keeps its current grammar, so the request is an ordinary invocation that Pit View builds from the drawer's choices; each prompt's "anything else is bad usage" rule stays, with the new flag added to its list of arguments.
- **Progress**: the command appends one JSON line to `<run-dir>/events.jsonl` as it reaches each step, `{ "at": "...", "step": "resolveBase" | "review" | "consolidate" | "writeReport" | "post", "note": "..." }`. These are the drawer's five steps; a run that skips a step (no tandem, nothing to post) records it with `"note": "skipped"`.
- **Response**: as its last act, after the report is written and after any post, the command writes `<run-dir>/result.json`. For a single review:

```json
{
  "schema": "pit-crew/review-result@1",
  "command": "review-pr",
  "status": "done",
  "target": { "repo": "owner/name", "pr": 101 },
  "reviewed": { "kind": "commit", "sha": "755b78b" },
  "verdict": "changesRequested",
  "findings": [ { "priority": "P1", "summary": "Retry loop never backs off" } ],
  "fixAttempts": 0,
  "posted": { "form": "requestChanges", "url": "https://github.com/owner/name/pull/101#pullrequestreview-1" },
  "report": "~/agents/output/PR-101.md",
  "question": null
}
```

`status` is `done`, `failed` (with `error`) or `needsInput`. `posted` is null when nothing was posted, with `notPostedReason` saying why.

- **Stop-and-ask points stay stops**: wherever a prompt says to stop and ask (the one-attempt bound after a fix re-review, a tandem draft that fails its checks, an unreachable pinned SHA), a run with `--emit-json` stops there too and writes `result.json` with `"status": "needsInput"` and the question in `question`. It never answers its own question or picks a default. Pit View shows the question in the drawer; the viewer answers in the session or starts a new run.
- **The Dependabot sweep**: with `--emit-json`, the sweep still writes its Markdown summary to `~/agents/output/dependabot-sweep-<repo>-<YYYY-MM-DD>.md` and prints it, and additionally writes the same content as JSON to `<run-dir>/result.json`: `schema` `pit-crew/sweep-result@1`, the first-line counts (`swept`, `fresh`, `reused`, `failed`), `rows` (one per PR, sorted by number, carrying the reviewer return structure's fields: `number`, `url`, `title`, `head`, `bump`, `recommendation`, `ci`, `findings`, `escalation`, `posted`, `report`, plus the table's `notes`), `mergeOrder` (the ordered actions, each with its `prs`), and `summary` (the Markdown file's path). Pit View renders this in the bot group's drawer instead of parsing the Markdown table.
- **What the flag never changes**: the single permitted GitHub write per review and the sweep's list of things it must never do; writing the report to disk before posting it; the one-attempt bound; `review-pr` fixing only the viewer's own PR, confirmed with `gh api user`; `review-local`'s single WIP commit; `review-stack` never fixing. The no-attribution rules apply to the JSON exactly as to the Markdown: no model, provider or agent names, and escalation is reported by its trigger, not by which model ran.
- **Where it lives in pit-crew**: the shared contract (flag, file names, both schemas, the needs-input rule) goes in one new agent-agnostic prompt, `prompts/review/emit-json.md`, which each review prompt references when the flag is present, the way they reference `tandem.md` today. Each prompt adds the flag to its argument list and the step lines at its existing steps, without rewording its constraints. The wrappers in `commands/claude/` and `commands/skills/` change only their argument hints; agent-specific instructions stay out of the shared skills and prompts. Deploy with `scripts/deploy-reviews.sh --install` and run `git grep -I "$HOME" -- prompts commands bin` before committing.

### Other phase 2 items

- The bot group's "Run sweep" starts the Dependabot sweep command for the repo with `--emit-json`.
- How sessions are launched (which installed command runner, headless invocation, where the session log goes, how Stop works) is designed at the start of phase 2 (P2.1), from the installed commands and the deployed prompts. Progress and results come from `events.jsonl` and `result.json`, not from scraping session output.
- Phase 4 (section 10) reuses this launcher, the `runs` table, the Agent cell and the drawer for unattended runs, so P2.1 keeps the launcher callable from the server with no page or drawer involved, under a manual start and, when the optional login agent is installed, from its environment (section 3, Hosting). The launcher takes the run's working directory as an argument, because phase 4 runs each command in its own worktree (section 10, Worktrees).
- `result.json` is also the proposed route by which report content reaches Pit View's database (section 10, Report storage); v1 and phase 2 still read reports from `reportsDir`.

## 9. v3: stacks, actions and notifications

v3 starts after v1 has been in daily use. Each item below is a decision on direction; its details are settled at the start of its milestone.

### Stacks grouped

- In Mine and Others', the PRs of one stack render together under a stack header row: a disclosure button (`aria-expanded`) with the stack's size, its top PR's title, and the most urgent issue and merge state among its members. Each stack is collapsible on its own.
- Expanded, the stack's PRs are listed by position, and each keeps its `stack n/m` chip, so a PR reads the same inside and outside the group.
- To revisit after v1, with real use: which status group a stack sits in when its members' groups differ (the most urgent member's is the starting proposal), whether stacks start collapsed, and how stack grouping interacts with sorting. The stack header is also the natural home for phase 2's Review stack.

### Direct actions

- Pit View gains a small set of explicit GitHub writes on the viewer's own PRs: merge (only when merge state is `ready`), mark ready for review, convert to draft, and request review (choosing from `people`). Others like re-running failed checks are considered at the same time. Whether any action extends to others' PRs is decided at the start of v3; commenting and approving stay out of scope.
- Each action is one viewer click followed by a confirmation naming the PR and the action, runs through `gh` with the viewer's own token, and is never automatic or batched. The result arrives the way everything else does: the server starts a targeted refresh of that PR and the updated row comes back as a patch.
- The endpoint is `POST /api/prs/<number>/actions` with `{ "action": "merge" | "markReady" | "convertToDraft" | "requestReview", ... }`. Because a loopback server that writes can be reached by any page in the browser, write endpoints require a same-origin `Origin` header and a per-start token embedded in the served page.

### Notifications

- OS notifications on state transitions, starting with macOS, through the built-in `osascript` `display notification` so the zero-runtime-dependency rule holds. Other platforms follow later.
- A transition is a difference between a PR's previous and new cached state, so each fires once, and nothing fires for the first load, an empty cache, or rows marked stale. Candidate transitions: changes requested on yours, yours ready to merge, review requested of you, CI failing on yours, and, with phase 2, a review session finished or waiting for input.
- Configured by the `notifications` key (`{ "enabled": false, "kinds": [...] }`), off by default, with a Notifications section in Settings. What clicking a notification does on macOS is checked at the start of the milestone.

## 10. Phase 4: auto-review

Auto-review starts review and re-review runs on its own, for new or updated PRs, whenever the app is running, whether or not any page is open. It is placed after v3, but it depends only on phase 2's launcher (P2.1), its machine-readable output (P2.2, P2.3), and its Agent cell and drawer (P2.4, P2.5), so it could move ahead of v3. It does not depend on the optional start-at-login agent (M13), which only saves starting the app by hand. It is off until the owner turns it on.

It supersedes the cron job the owner runs today, which lists the PRs that need attention every 15 minutes: the scheduler covers the same ground on the same default interval, and acts on it. Once auto-review is in use, that job is retired (P4.8).

### Configuration

The `autoReview` key, with its defaults:

```json
{
  "enabled": false,
  "intervalMinutes": 15,
  "activeHours": { "days": ["mon", "tue", "wed", "thu", "fri"], "from": "09:00", "to": "18:00" },
  "others": true,
  "own": false,
  "dependabot": false,
  "concurrency": 1,
  "dailyLimit": 10,
  "post": { "others": false, "dependabot": false },
  "cloneDir": null
}
```

| Key | Default | Notes |
| --- | --- | --- |
| `enabled` | `false` | Master switch. Off means no ticks, no runs, and no GitHub calls from the scheduler. |
| `intervalMinutes` | 15 | Minutes between ticks during active hours; 5 at least. |
| `activeHours` | weekdays, 09:00 to 18:00 local (a chosen default) | Days and a local-time window, in the machine's time zone. Ticks run only inside it. |
| `others` | `true` | Others' PRs qualify (What qualifies, below). Applies only once `enabled` is true. |
| `own` | `false` | The viewer's own PRs qualify for a self-review. A separate opt-in. |
| `dependabot` | `false` | Dependabot PRs qualify for a sweep. A separate opt-in. |
| `concurrency` | 1 | Runs in flight at once; a sweep counts as one. |
| `dailyLimit` | 10 | Configurable. Auto-review runs started per local day, a cost guard; a sweep counts as one. 10 is only the starting default for auto-reviews, not a cap on reviewing: the owner does more than ten reviews a day, and runs started by hand never count against it. Validation accepts any whole number of 1 or more. |
| `post` | both `false` | Whether runs may post, for others' PRs and for Dependabot separately (Posting, below). Own PRs have no switch: they never post. |
| `cloneDir` | none; required | The local clone of `repo`, shared with phase 2's launcher (P2.1), written with `~`. Auto-review never runs a command in it directly: each run gets its own worktree of this clone (Worktrees, below), so the owner's working checkout is never touched. |

Runs are launched the way phase 2 launches them: P2.1's launcher, the installed pit-crew review commands and their deployed prompts, with `--emit-json=<run-dir>`. Runs are single reviews; `--tandem` is not passed.

### Scheduler

- The scheduler lives in the server (`src/autoreview.ts`) and keeps its own clock: a tick every `intervalMinutes` inside active hours. It is separate from and independent of the UI's polling: pages opening, hiding or pausing never start, stop or move a tick, and the header's Pause does not pause it. Its fetches refresh the cache like any cycle, but never on the UI's schedule.
- It runs whenever the app is running, with or without a page open, in either hosting mode: under a manual `pnpm start` for as long as that process is up, and under the optional login agent (M13) from login onward. The login agent changes only how the app gets started, not what the scheduler does.
- Outside active hours, or while `enabled` is false, nothing ticks and the scheduler makes no GitHub calls; it holds one timer for the next active-hours start. A run already in flight when the window closes finishes; nothing new starts until it reopens.
- A tick, in order:
  1. Checks that `gh api user --jq .login` equals `viewer`. The machine may hold logins for more than one account, and the commands post as whichever one `gh` is using, so a mismatch skips the tick as `identityMismatch`, and every tick skips until they match again.
  1. Checks that `cloneDir` is set and is a clone of `repo`; otherwise it skips as `noClone`.
  1. Sweeps orphaned Pit View worktrees (Worktrees, below).
  1. Brings the cache up to date: it joins a running cycle, or reuses the cache when a cycle finished successfully within the last 60 seconds, or starts a cycle with trigger `autoReview`. That cycle's patches reach any open page. If the cycle fails or stops partway, the tick skips as `fetchFailed`; it never decides from stale rows.
  1. Computes the qualifying PRs (below), drops those already reviewed at their head, and queues the rest in attention order (section 5): others' PRs first, flags first and then most recent activity, then own PRs, then the sweep.
  1. Starts queued runs while fewer than `concurrency` are in flight and the day's `dailyLimit` is not reached. Runs that do not fit stay queued for later ticks. Once the limit is reached, ticks skip as `dailyLimit` until the next local day.
- Before a queued run starts, it is checked against the cache again: a PR that closed is dropped as `closed`; a PR whose head moved still runs (the command resolves the head itself) and records the new head.
- A restart of the server keeps queued runs queued. A run recorded as running whose process is gone is settled from its `result.json` when one exists, and otherwise marked failed with the note `serverRestarted`. Once those runs are settled, server startup sweeps orphaned Pit View worktrees, whether or not auto-review is enabled (Worktrees, below).
- "Run now" (from the header indicator) runs one tick immediately, inside or outside active hours, as long as `enabled` is true; the identity and clone checks still apply.

### Worktrees

Every auto-review run works in its own git worktree of `cloneDir`, never in the owner's working checkout, and cleans up after itself.

- **Where they live**: `~/.local/state/pit-view/worktrees/`, a directory Pit View owns, with `~` expanded at runtime from `os.homedir()`. Nothing else is ever created there, and Pit View creates its worktrees nowhere else.
- **How they are named**: `run-<run-id>`, the run's id in the `runs` table, so `~/.local/state/pit-view/worktrees/run-42`. The name ties each worktree to exactly one run, and is what lets the sweep touch only its own.
- **Creation**: just before the run starts, Pit View runs `git -C <cloneDir> fetch origin`, then `git -C <cloneDir> worktree add --detach <path> origin/<defaultBranch>`, and launches the command with that worktree as its working directory. Detached, so it creates no branch; should a later design ever need one, it is named `pit-view/run-<run-id>` and deleted with the worktree. If the add fails, the run fails with the note `worktreeFailed` and is retried like any failed run.
- **The prompts' own worktree rules are respected, not duplicated.** The commands run with a named target, so each prompt's Target section already reviews that target in a throwaway worktree of its own under `~/agents/worktrees/`, detached, created and removed by the prompt, never forced; the sweep's reviewers work the same way, and the sweep cleans up its own. Pit View does not check out the PR head, pass a worktree path, or create, move or remove anything under `~/agents/worktrees/`. Its worktree is only the run's working directory: it keeps the command's working directory, and anything the session does there, off the owner's checkout, which may be dirty or on another branch. The prompts' `git worktree prune` clears only metadata for worktrees whose directory is already gone, so it never removes a live Pit View worktree.
- **Removal**: when the run finishes, fails, or is stopped, Pit View runs `git -C <cloneDir> worktree remove <path>`. It never passes `--force`, matching the prompts: a worktree that refuses holds something unexpected, so it is left in place, the run gets the note `worktreeKept` with the path, and the header popover lists it for the owner. A run that ends `needsInput` is waiting rather than finished, because the owner answers in that session, which works from this directory; its worktree stays until the owner settles the run (the session ends, or a new run is started for the PR), or the PR closes or gets a new head, which the next sweep notices from the cache.
- **The sweep**, at server startup and at every tick, cleans up after a crash or a killed process: it lists `git -C <cloneDir> worktree list --porcelain`, keeps only entries whose path is directly inside `~/.local/state/pit-view/worktrees/` and whose name matches `run-<digits>` exactly, and removes each whose run is not queued, running or waiting for input (or has no row at all), as above and never forced. It then runs `git -C <cloneDir> worktree prune`, which clears only metadata for worktrees whose directory is already gone, the same command every prompt runs before adding its own. A directory in Pit View's folder that git no longer lists is reported in the popover, not deleted. The sweep never removes a worktree outside that folder or with any other name, and makes no GitHub call. With `cloneDir` unset there is nothing to sweep.
- **Concurrency**: worktrees of one clone share its object store and lock files, so runs above a `concurrency` of 1 can contend on fetches, as the sweep prompt notes for its own reviewers. P4.1 checks this before the default is raised.
- Phase 2's manual runs may adopt the same worktrees; P2.1 decides, since a drawer run the owner starts may intentionally use their checkout.

### What qualifies

These reuse section 5's rules rather than adding new ones:

| Kind | Opt-in | Qualifies when | Command |
| --- | --- | --- | --- |
| Others' PRs | `others` | the PR is in Others' Your move group: requested of the viewer, never reviewed by the viewer, or with commits since the viewer's latest review (the Re-review flag); never a draft, since drafts are hidden | `review-pr <number> --emit-json=<run-dir>`, plus `--no-post` unless `post.others` is on |
| Own PRs | `own` | the PR is in Mine, not a draft, and its self-review is `none` or `stale` | `review-pr <number> --emit-json=<run-dir> --no-post`, always |
| Dependabot | `dependabot` | any open Dependabot PR is new or has a new head since the last sweep the scheduler ran (from that sweep's `result.json` rows) | `review-dependabot-sweep <owner/repo> --parallel 1 --emit-json=<run-dir>`, plus `--no-post` unless `post.dependabot` is on |

- **Already reviewed at its head** (the duplicate-run guard, file-based, reusing v1's report reading; Report storage, below, proposes how it changes): a PR is not queued when its report, found and parsed by section 5's self-review detection (`PR-<number>.md`, then the branch-named file, its `Reviewed commit:` SHA), was written against the current head, whoever ran it; or when an auto-review run for that PR and head has already finished or is waiting for input. The report on disk is what marks a PR done, because while posting is off the viewer's review never appears on GitHub and the PR stays in Your move.
- Ready to merge and Waiting on author are not Your move, so they never qualify, and neither do bot PRs from bots other than Dependabot (the sweep covers Dependabot only).
- A Dependabot sweep reviews the whole set, so that its sibling detection and merge order stay intact, and reuses unchanged verdicts on its own. At most one sweep is queued or running at a time, and `--parallel 1` keeps an unattended sweep to one reviewer at a time.
- A run that ends `needsInput` stays waiting: its PR is not queued again at that head, and the drawer's Waiting card shows the question (section 8). A new head qualifies again.
- A failed run is retried once on a later tick. If the retry fails too, it is recorded as `failedTwice` and that PR is left for the owner at that head.

### Posting

The review commands post to GitHub under the owner's account, so an unattended run that posts is a significant decision. It is an open question (section 11). Until the owner answers it, the conservative default holds: **auto-review runs do not post**.

- **`--no-post`**: a new pit-crew flag, an addition like `--emit-json` (section 8). A command invoked with it does everything it does today, including writing its report to `reportsDir` and, with `--emit-json`, its events and `result.json`, but makes no GitHub write of any kind: no review, approval or comment, and no fix mode, since fix mode pushes commits. The CI wait that exists only to choose the post's form is skipped, since there is no post. Its `post` step event is recorded as skipped, and `result.json` carries `"posted": null` with `"notPostedReason": "noPost"`.
- It only removes writes; it relaxes nothing. Every stop-and-ask point still stops (with `--emit-json`, as `needsInput`). The report is still written to disk first. A `--no-post` run is not a fix attempt, and the report carries the `Fix attempts:` line forward exactly as the prompt's rule says. The single permitted write, the posting forms, the CI gate and the one-attempt bound are untouched for every run that omits the flag.
- **The report is surfaced, never posted by Pit View.** The Agent cell reads, for example, "Changes requested · not posted", and the drawer lists the report under Reports on disk with an Open link. To post it, the owner starts a review from the drawer (phase 2), which posts under the command's own rules. Pit View never posts a report, and an unposted report is never posted later by anything; turning posting on affects only runs that start afterward.
- **Turning posting on** is per kind: `post.others` for others' PRs, and `post.dependabot` for the sweep, whose reviewers approve clean bumps automatically under `review-dependabot.md`. With it on, the run omits `--no-post`, and posting follows the command's own rules unchanged: one post, only after the report file is written, in the form the findings and CI select; for the sweep, everything on its list of things it must never do. Turning a switch on in Settings asks for confirmation, naming what will post and under which login.
- **Own PRs never post and never fix**, posting on or off. `review-pr` already never posts on the author's own PR, so `--no-post` costs nothing there, and it keeps fix mode, the one write `review-pr` makes on the author's PR, out of unattended runs. A fix stays a session the owner starts by hand (P2.6), under fix mode's own rules: authorship confirmed with `gh api user`, the one-attempt bound, and the `Fix attempts:` line.
- **With `--emit-json`**: `result.json` records whether and how a run posted, exactly as in section 8, so the drawer can show "not posted" as distinct from "posted as request changes". `--no-post` without `--emit-json` is also valid (a person may use it by hand).
- **In the sweep**, `--no-post` goes into every reviewer's brief, so the sweep's only GitHub writes, each reviewer's single report post, become none. Its skip-unchanged rule keeps every condition except the one that requires an approval already on the head, which nothing could have posted; the next sweep run without `--no-post` applies the full rule again, so a clean bump then gets reviewed fresh and its approval gets its chance. The escalation re-run posts nothing either.
- **Where it lives in pit-crew**: the contract goes in one new agent-agnostic prompt, `prompts/review/no-post.md`, which `review-pr.md`, `review-dependabot.md` and `review-dependabot-sweep.md` reference when the flag is present, as they reference `emit-json.md`. Each adds the flag to its argument list without rewording its constraints; the wrappers in `commands/claude/` and `commands/skills/` change only their argument hints. The same pit-crew rules apply as for phase 2 (section 2).

### Recording

- Every tick is a row in a new `ticks` table: `id`, `repo`, `started_at`, `finished_at`, `state` (`ran` or `skipped`), `skip_reason` (`identityMismatch`, `noClone`, `fetchFailed` or `dailyLimit`), `cycle`, `qualified`, `already_current`, `queued`. Keep the last 500.
- Each auto-review run is a row in phase 2's `runs` table, which gains `origin` (`manual` or `auto`), `tick`, `head_oid`, `reason` (`requested`, `new`, `pushed`, `selfReview` or `dependabot`), `queued_at`, `posting` (whether the run was allowed to post) and `note` (why it was dropped or failed, or what was left behind: `closed`, `failedTwice`, `serverRestarted`, `worktreeFailed`, `worktreeKept` with the path, or the command's error), `worktree` (the run's worktree path, written with `~`). Run statuses gain `queued` and `skipped`.
- Everything the UI shows about auto-review comes from these tables, so a page opened hours later shows what happened while it was closed.

### In the UI

Auto-review surfaces only through the existing Agent cells and drawer, plus one header indicator:

- `agent` on a row (section 8) gains `origin`, `queuedAt`, `posted` (true, false, or null before the run ends) and `note`, and its `state` gains `queued`. The Agent cell shows: queued, "queued · auto" and its age; running, the phase 2 running cell with "auto" before the label and its timers ("running 3m · last step 20s ago"); done, the result plus "· not posted" when it did not post, then "auto · finished 1h ago"; failed or skipped, "auto · failed" or "auto · skipped" with the note as its tooltip.
- The drawer gains an Auto-review list for the PR: each auto run with its reason, head SHA, outcome, whether it posted, and its queued, started and finished times.
- The header indicator sits beside the sync status: "Auto-review · next 2:45 PM", "Auto-review · 1 running, 2 queued · next 2:45 PM", "Auto-review · outside hours · next Mon 9:00 AM", "Auto-review · off", or in amber "Auto-review · skipped: gh login differs from viewer" (or the other tick skip reasons). It is a button that opens a popover with the last 10 ticks (what each queued, or why it skipped), links to the queued and running PRs, any Pit View worktree left in place (Worktrees, above), Run now, and a link to Settings. It is hidden until `autoReview` exists in the config. Its text is not a live region, so it does not announce every tick.
- `GET /api/view` carries `autoReview`, and patches carry it as a partial object, like `sync`:

```json
{
  "enabled": true,
  "state": "running",
  "nextTickAt": "2026-10-27T14:45:00Z",
  "running": 1,
  "queued": 2,
  "startedToday": 3,
  "lastTick": { "at": "2026-10-27T14:30:00Z", "state": "ran", "skipReason": null, "queued": 2 },
  "posting": { "others": false, "dependabot": false }
}
```

`state` is `off`, `idle`, `running`, `outsideHours` or `blocked` (the last tick skipped for a reason that persists, such as `identityMismatch` or `noClone`).

- Endpoints: `GET /api/auto-review/ticks` lists recent ticks; `POST /api/auto-review/run` is Run now. With a server that is always up and can start runs that post, a malicious page in the same browser could otherwise turn on auto-review or posting, so from phase 4 this POST and `PUT /api/config` require the same-origin `Origin` header and per-start token that section 9 specifies for direct actions; whichever of phase 4 and v3's direct actions lands first builds the check.
- Settings gains an Auto-review section: on and off, interval, active days and hours, the three opt-ins, concurrency, daily limit (a number field, default 10, any whole number of 1 or more, with a note that it caps only auto-review runs), clone folder (with a note that runs use their own worktrees of it, never the checkout itself), the two posting switches with their confirmation, and a note that runs happen whenever the app is running, with or without a page open. The optional start-at-login agent's status (installed or not) is shown beside it as a separate convenience, with a note that auto-review does not need it.

### Report storage (direction, not v1)

A direction to design and refine, not v1 work. v1 stays file-based as built, reading `reportsDir` (section 5), and phases 2 and 4 start that way. The question is whether review reports should move out of the flat reports folder into Pit View's SQLite database, or be used differently. The proposed direction:

- **Others' PRs: GitHub is the source of truth.** The posted review or comment is the record. Pit View reads it from GitHub rather than from files: the viewer's latest review already arrives in `latestReviews` with its `commit.oid`; a plain-comment post (the form `review-pr` uses when CI failed) carries no commit, so its reviewed SHA comes from the `Reviewed commit:` line that begins every report. Reading the viewer's comments needs a field added to the open-PR query, settled when this is designed. No local copy of a posted report is kept.
- **Stored, temporarily, in SQLite: self-reviews and unposted auto-review reports only.** Self-reviews never post (the prompts never post on the author's own PR), and `--no-post` runs leave nothing on GitHub, so for those the database is the record until it is superseded. A proposed `reports` table: `id`, `repo`, `number`, `kind` (`self` or `unposted`), `reviewed_oid`, `run`, `verdict`, `findings` (JSON), `fix_attempts`, `body` (the Markdown), `created_at`.
- **Retention**: a stored report is dropped once it is superseded, by a newer report for the same PR at a newer head or, for an unposted report, by the viewer's posted review or comment at that head or later; and once the PR closes or merges. The exact timing (at once, or after the Closed range passes) is settled in the design.
- **How content arrives**: phase 2's `--emit-json` result. When a run ends, Pit View ingests its `result.json` (`reviewed`, `verdict`, `findings`, `fixAttempts`, `posted`) into the row. The Markdown body is read once, at ingest, from the file `result.json`'s `report` names, or taken from `result.json` itself if a later schema version carries it. Pit View still never writes to `reportsDir`.

Consequences:

1. Self-review detection (section 5) moves from file scanning to the `reports` table, and the row's `selfReview.file` names a stored report rather than a file; that response-shape change lands with the milestone.
1. `reportsDir` becomes a legacy and import source during the transition. Reviews run by hand outside Pit View produce no `result.json`, so until the owner retires the files, new or changed reports there are still read and imported (keyed on file name and modification time) and treated like ingested ones. The drawer's Reports on disk becomes Reports, listing stored reports and the viewer's posts on GitHub.
1. The duplicate-run guard (What qualifies, above) changes: an others' PR counts as reviewed at its head when the viewer's review or comment on GitHub is at that head, or a stored unposted report is; an own PR when a stored self-review is; and an auto-review run already finished or waiting for input at that head still counts. A plain comment is not a GitHub review, so the PR stays in Your move after one; the guard must count the comment or the PR would be queued again.
1. pit-crew's prompts keep writing their files to `~/agents/output/` until the owner decides otherwise, and Pit View relaxes none of their output rules: the report is written to disk before anything posts, it begins with `Reviewed commit:`, the prior report is read before it is overwritten, and `Fix attempts:` is carried forward. The prompts also read the prior report from that file at the start of a re-review and to enforce the one-attempt bound, so the files cannot go away through a Pit View change; any change there is pit-crew work under section 2.
1. An unposted report is still never posted later by anything (Posting, above). Moving it into the database changes where it is kept, not what may be done with it.

## 11. Open questions and decisions

Open, with the defaults we proceed on:

| Question | Default until answered |
| --- | --- |
| Should a PR that requests your review but has conflicts be in Your move or Waiting on author? | Waiting on author, still flagged "Requested of you". |
| What counts as last activity (CI finishing, title edits, the viewer's own actions)? | The event list in section 5; CI completion excluded; the viewer's own actions included. |
| Is a self-review current after a rebase with no new changes? | No; current means the reviewed SHA matches the head exactly. |
| Jira base URL? | Set in the local config; links hidden until set. |
| One repo at a time, or several? | One. |
| Should unattended auto-review runs post to GitHub under the owner's account? | No. Runs pass `--no-post`: the report is written to disk and surfaced in Pit View, and nothing is posted. The owner can turn posting on separately for others' PRs and for Dependabot; when on, posting follows the review command's own rules (section 10). |
| Should auto-review ever fix the owner's own PRs? | No. Own-PR runs always pass `--no-post`, which also keeps fix mode out; fixes stay sessions the owner starts by hand (section 10). |
| Dependabot under auto-review: the whole sweep, or `review-dependabot` per changed PR? | The whole sweep, one at a time with `--parallel 1`, so sibling detection and the merge order stay intact; it reuses unchanged verdicts itself (section 10). |
| Auto-review's active hours? | Weekdays, 09:00 to 18:00 local; configurable (section 10). |
| Should review reports move out of the flat reports folder into Pit View's SQLite database, or be used differently? | Not in v1, which stays file-based as built. Direction to refine: GitHub is the record for others' PRs; only self-reviews and unposted auto-review reports are stored, temporarily, in SQLite with a retention rule, arriving through `--emit-json`; `reportsDir` becomes a legacy import source; pit-crew's prompts keep writing their files (section 10, Report storage; P4.9). |

Decided:

| Question | Decision |
| --- | --- |
| Stacked PRs: flat with a `stack n/m` chip, or grouped by stack? | v1 is flat with the chip. Grouped, collapsible stacks come in v3 (section 9), revisited after v1. |
| Should Pit View merge the viewer's ready PRs? | Not in v1 or phase 2: no merge button, it only links to GitHub. v3 adds merge and other direct actions (section 9). |
| macOS notifications on state changes? | Not in v1. v3 adds OS notifications, macOS first (section 9). |
| How does the UI load? | Cache first: render from SQLite at once, then update individual elements as GitHub responses arrive (section 3). |
| Machine-readable output from pit-crew's commands: replacement or addition? | Addition, behind `--emit-json`, invoked by Pit View; the human-readable report is unchanged (section 8). |
| When does the UI poll GitHub? | Only while at least one page is visible and not paused. With no active page the server makes no GitHub calls for the UI; opening or returning to a page shows the cache first, then refreshes when the data is older than 30 seconds (section 3). |
| Pausing: per page or global? | Per page: a header button beside Refresh pauses and resumes polling for that page only. While paused the status reads "paused · updated <age> ago" and Refresh still works as a one-shot (section 6). |
| Automatic reviews on a schedule? | Yes, as phase 4 after v3, movable earlier: a scheduler independent of the UI, every 15 minutes during active hours by default, off until turned on, reusing section 5's rules and phase 2's launcher (section 10). |
| How is the server hosted? | Manual `pnpm start` is the default. Starting the app at login or after a reboot, as a launchd user agent (M13) that idles when nobody is looking, is a separate, optional convenience. Both bind to loopback only (section 3). |
| Does auto-review need the app to start at login? | No. The scheduler runs whenever the app is running, whether or not a page is open; the login agent only saves starting it by hand, and no phase 4 milestone depends on it (sections 3 and 10). |
| Does Pit View's scheduler replace the cron job that lists which PRs need attention every 15 minutes? | Yes. It supersedes that job, and the job is retired once auto-review is in use (P4.8). |
| Auto-review's daily limit? | Configurable, default 10. Ten is only the starting default for auto-reviews; the owner does more than ten reviews a day, and runs started by hand never count (section 10). |
| Where do auto-review runs work? | Each in its own detached git worktree of `cloneDir` under `~/.local/state/pit-view/worktrees/`, named `run-<run-id>`, never in the owner's checkout; removed when the run ends, with a sweep at every tick and at server startup for orphans. The prompts' own throwaway worktrees are left to the prompts (section 10, Worktrees). |

## 12. Milestones

Each milestone is sized for one focused session or subagent. Check items off as they land and note them in the session log. Every milestone follows the code conventions in section 4.

- [x] M0 Mockup approved (Design canvas, version 41)
- [x] M0 Design and progress doc (this file)
- [x] M1 Scaffold: `package.json` (`"type": "module"`, `packageManager` pinning pnpm, scripts `start`, `test`, `check`), `pnpm-lock.yaml` with only the dev `typescript`, `tsconfig.json`, `README.md`, `config.example.json`, `src/config.ts` with defaults, `~` expansion, load and save, and `node:test` wiring; confirm `pnpm test` and `pnpm check` run
- [x] M2 GitHub fetch: `src/github.ts` with `gh auth token`, the open-PR GraphQL query ordered by `UPDATED_AT` with pagination that hands each page to a callback as it arrives, the closed search covering both ranges, and error handling; all `gh` calls go through an injected runner; record one invented fixture per query shape under `test/fixtures/`
- [x] M3 Cache: `src/cache.ts` with the SQLite schema in section 3 (`cycles`, `snapshots`, `prs` with `fetched_at`, `meta`), per-page writes, retention, per-row and per-section freshness, and the reads that build the view; tests on `:memory:`
- [x] M4 Derivation engine: `src/derive.ts`, `src/reports.ts` and `src/time.ts` implementing every rule in section 5, with unit tests against fixtures (groups and precedence, pips, flags, issues, merge states, self-review, last activity, stacks, tickets, Closed range and the Monday rule); reports tests use temporary directories
- [x] M5 Server, cycles and patches: `src/clients.ts` tracking clients by id with their visible and paused state and the active set; `src/poller.ts` with the cycle triggers in section 3 (`active` with the 30-second rule, `interval` only while a client is active and counted from the last cycle of any trigger, `manual` and `config` one-shots; no cycle at start and no GitHub call with no active client), per-response apply and patch emission, removal at cycle completion, and partial-failure staleness; `src/server.ts` with `GET /api/view` served only from the cache, the patch event stream with client ids, versions and keepalive, `POST /api/clients/<id>`, the other endpoints in section 3, and static serving with type stripping for `public/*.ts`, on loopback, with the service-ready behavior in section 3, Hosting (manual `pnpm start` stays the v1 default); tests for patch order, version gaps, a cycle failing partway, the active and interval triggers with a fake clock, and no GitHub call while every client is hidden or paused
- [x] M6 UI shell and tables: header, summary tiles (display only), collapsible sections, the three tables with the columns in section 6, hover card, density; render from `/api/view`, then apply patches in place (subscribe first, drop old versions, refetch on a gap) keeping focus, hover card and scroll; a client id per page load, reporting visibility and pause through the event stream query and `POST /api/clients/<id>` (section 6, Polling, visibility and pause); the per-page pause button beside Refresh, kept in `sessionStorage`; loading placeholders for an empty cache; all colors as `light-dark()` tokens with dark halves chosen and contrast-checked
- [x] M7 Filters, sorting and grouping: filter bars, the sort cycle, Group by status, tiles as filter presets with release-on-manual-change, and filters and sort reapplied per patch
- [x] M8 Closed section: Today / Yesterday control switching locally between both cached ranges, Monday rule label and footnote, Ticket column when present, empty states
- [x] M9 Offline, stale and paused: header sync states (updated, refreshing with progress, offline, paused with the last update's age), the offline banner in both its full and partway forms and its paused wording, per-row and per-section freshness markers and tooltips including "cached <time>, paused", Refresh as a one-shot while paused, a check that the page renders fully from the cache with GitHub unreachable, and a check (from the server log or `cycles` triggers) that a hidden or paused page causes no cycles and that returning to it refreshes only past 30 seconds
- [x] M10 Settings page: all sections in section 6, writing the config through `PUT /api/config` with the refresh it triggers, people suggestions
- [x] M11 End-to-end check against the real repository from the local config, and fixes
- [x] M12 pit-crew integration: entries in pit-crew's `CLAUDE.md` and `README.md` for `pit-view/`, and a `git grep -I "$HOME" -- pit-view` check before the first commit
- [ ] M13 Start at login (optional): `scripts/service.ts` behind `pnpm service:install`, `service:uninstall` and `service:status`, for the launchd user agent in section 3, Hosting (plist generated at install time from `os.homedir()` and `process.execPath`, never committed; `PATH` captured; logs under `~/Library/Logs/pit-view/`; loopback only); confirm that `gh auth token` works under the agent, that the server idles with no page open (no cycles in `cycles` over an hour), that it restarts after a crash but not after `service:uninstall`, and that a manual `pnpm start` alongside it exits with the port-taken message. Optional in every phase, a convenience that has the app running after login or a reboot; the default stays manual start, and auto-review does not need it, since the scheduler runs whenever the app is running. Can land any time after M5; no other milestone depends on it
- [ ] P2.1 Design session launching from the installed review commands (runner, headless invocation, run directories, Stop) and pin the `--emit-json` contract and both result schemas in section 8
- [ ] P2.2 pit-crew review prompts: add `prompts/review/emit-json.md` and the `--emit-json` flag, step events and `result.json` to `review-pr.md`, `review-local.md`, `review-stack.md` and `review-dependabot.md`, with the needs-input rule; update the argument hints in `commands/claude/` and `commands/skills/`; keep every existing constraint word for word; deploy with `scripts/deploy-reviews.sh --install`, run the `git grep` check, and show the diff before committing
- [ ] P2.3 pit-crew sweep: add `--emit-json` to `review-dependabot-sweep.md` so it writes the JSON result (rows, merge order, summary path) alongside the unchanged Markdown summary; same deploy and checks as P2.2
- [ ] P2.4 Agent column states and timers, driven by `events.jsonl` and `result.json`, cached in `runs`, pushed as row patches
- [ ] P2.5 Agent drawer: start, running card, waiting card for `needsInput`, stop, reports on disk
- [ ] P2.6 Fix-session start from the changes-requested banner (own PRs only)
- [ ] P2.7 Dependabot sweep from the bot group, rendering the sweep's `result.json`
- [ ] V3.1 Grouped stacks: revisit the section 9 questions with v1 experience, then collapsible stack groups with the `stack n/m` chip kept on each expanded PR
- [ ] V3.2 Direct actions: merge, mark ready for review, convert to draft, request review on the viewer's own PRs, with confirmation, origin and token checks, and a targeted refresh patch after each
- [ ] V3.3 OS notifications, macOS first: transition detection from the cache, the `notifications` config and Settings section, delivery through `osascript`
- [ ] P4.1 Design check for auto-review: confirm P2.1's launcher runs from the server with no page open under a manual start (the runner on `PATH`, the `gh` identity, `cloneDir`), and from the login agent's environment too if M13 is installed; confirm a command run with a Pit View worktree as its working directory still creates and removes its own throwaway worktree under its prompt's rules, and check concurrent runs' contention in one clone; pin the `autoReview` config shape (with `dailyLimit` configurable, default 10), the worktree location, naming and sweep, the `--no-post` contract and the `ticks` and `runs` columns in section 10, and confirm the posting default with the owner in section 11. Phase 4 needs only P2.1 to P2.5, so it may start before v3
- [ ] P4.2 pit-crew `--no-post`: add `prompts/review/no-post.md` and the flag to `review-pr.md`, `review-dependabot.md` and `review-dependabot-sweep.md` (no post, no fix mode, skipped `post` step, `notPostedReason`; the sweep passes it to every reviewer and drops only the approval condition from its reuse rule while it is set); keep every existing constraint word for word; update the argument hints in `commands/claude/` and `commands/skills/`; deploy with `scripts/deploy-reviews.sh --install`, run the `git grep` check, and show the diff before committing
- [ ] P4.3 Qualification and queue: pure functions in `src/autoreview.ts` for active hours and days, the three qualification rules reusing `src/derive.ts`, already-reviewed-at-head detection reusing `src/reports.ts`, attention ordering, one sweep at a time, retry once then `failedTwice`, the configurable daily limit (default 10, counting auto runs only), and the worktree sweep's selection (only `run-<digits>` entries directly inside Pit View's worktrees folder, only for runs not queued, running or waiting); tests with a fake clock and fixture rows
- [ ] P4.4 Scheduler runtime: the tick timer on its own clock, independent of clients; the identity and clone checks; the `autoReview` cycle trigger with the 60-second reuse; launching through P2.1's launcher with `--emit-json`, and `--no-post` per the posting rules, each run in its own worktree (section 10, Worktrees: created before the run, removed without `--force` when it finishes, fails or is stopped, kept while waiting for input, swept at every tick and at server startup, `worktreeFailed` and `worktreeKept` notes); concurrency; the `ticks` table and the new `runs` columns; restart recovery; `autoReview` in the view and in patches; `GET /api/auto-review/ticks`, `POST /api/auto-review/run`, and the origin and token check on it and on `PUT /api/config`; tests with a fake runner and clock proving that no command starts without `--no-post` while posting is off, that own-PR runs always carry it, that no tick runs outside active hours or with `enabled` false, that no command ever runs in `cloneDir` itself, and that a crashed run's worktree is swept on restart while another run's live worktree is left alone
- [ ] P4.5 Auto-review UI: Agent cell states for auto runs (queued, running with timers, done with "not posted", failed, skipped), the drawer's Auto-review list, the header indicator and its popover with Run now, and the Settings section with the posting confirmation, the daily limit field and its validation, and the start-at-login status shown as a separate, optional item
- [ ] P4.6 Dependabot auto-sweep: qualifying on new or changed Dependabot heads, one sweep at a time with `--parallel 1`, rendering its `result.json` in the bot group's drawer as P2.7 does
- [ ] P4.7 End-to-end for a working day with the app running and no page open (under a manual start, or the login agent if installed) and posting off: ticks only inside active hours, runs started, recorded and capped, reports surfaced when a page opens, nothing posted on GitHub (each run's `result.json` shows `posted` null, and the PRs' reviews and comments are unchanged), the owner's checkout in `cloneDir` untouched, and no Pit View worktree left behind at the end of the day (`git worktree list` shows none under `~/.local/state/pit-view/worktrees/` except runs still waiting for input)
- [ ] P4.8 Retire the cron job the owner runs today to list which PRs need attention every 15 minutes: once auto-review is in use and P4.7 has passed, confirm the scheduler and the dashboard cover what the job reported, then remove the job; Pit View's scheduler replaces it
- [ ] P4.9 Report storage: design and refine the direction in section 10, Report storage, with the owner (the `reports` table, the retention rule, reading the viewer's posted reviews and comments from GitHub, ingest from `--emit-json`, importing from `reportsDir` during the transition), then move self-review detection and the duplicate-run guard to the database; pit-crew's prompts keep writing their files unchanged unless the owner decides otherwise. Needs P2.2; not v1 work
- [ ] Investigate the caching items in section 7, only if polling becomes a problem

## 13. Resuming work

1. Read this file, especially sections 3, 4, 5 and 12.
1. Find the first unchecked milestone and read the session log for anything in flight.
1. From `pit-crew/pit-view/`, run `pnpm install` (once, for the dev-only type checker), then `pnpm test` and `pnpm check` to confirm the current state, then `pnpm start` and open http://127.0.0.1:4791 once M5 exists.
1. Before committing, run `git grep -I "$HOME" -- pit-view` and confirm it prints nothing.
1. When a milestone lands, check it off here and add a session log entry.

## Session log

### 2026-10-27

- Mockup iterated to version 41 and approved; this design doc written. No code yet.
- Design revised: renamed to Pit View (folder `pit-view/`); pnpm as package manager; code conventions added (section 4); cache-first loading with per-element patches and freshness; phase 2 machine-readable call and response for pit-crew's review commands and sweep; v3 section for grouped stacks, direct actions and notifications; the stacks, merging and notifications questions moved to decided. No code yet.
- M1 and M2 landed: scaffold, `src/config.ts`, `src/github.ts`, invented fixtures (`test/fixtures/open-page-1.json`, `open-page-2.json`, `closed.json`, described in `scenario.ts`) and 32 passing tests; `@types/node` added as a second dev-only dependency because `tsc` cannot check `node:` imports without it; the open query aliases its two `commits` connections as `headCommit` and `recentCommits` and also fetches `defaultBranchRef`, `rateLimit` and `totalCount`, and the closed search also fetches `body` and the closing event's actor for `closedBy`.
- M5 landed: `src/clients.ts`, `src/poller.ts` and `src/server.ts` (triggers, per-response patches with consecutive versions, the event stream, cache-first `/api/view`, static serving with type stripping, a loopback `/api/avatar/<login>` route for local images, Host and Origin checks), the `trigger` column in `cycles` (schema version 2), `readConfig` split out of `loadConfig`, and 123 passing tests; an empty viewer now resolves locally from `gh config get user`, so startup makes no GitHub call; smoke-tested with the fixture runner and read-only against the default repo with a temp home, config and cache.
- M6 landed: `public/index.html`, `styles.css` (every color a `light-dark()` token, dark halves contrast-checked by a test) and modules `app.ts`, `live.ts` (event stream, client reports, reconnect), `state.ts` (view plus patches, regrouping, pending), `status.ts`, `render.ts`, `tables.ts` (column definitions and keyed rows), `cells.ts`, `hovercard.ts`, `dom.ts` and `format.ts`; `tsconfig.json` now covers `public/` with the DOM lib; 136 passing tests, including client state checked against the real poller's patches; tiles display only, Closed shows Today, and the stale and pending markers wait for M9 (rows carry `data-freshness`); rendered with the fixture gh and a temp home, config and cache in a browser at desktop and phone widths, light and dark, with no console errors.
- M7 landed: `public/filters.ts` (pure: filter predicates, the sort cycle and per-column sort values, Group by status and the flat list, tile presets with release on a hand-made filter change, all unit-tested in `test/ui-filters.test.ts`) and `public/filterbar.ts` (each table's filter bar, built once and updated in place); tiles are `aria-pressed` buttons, sortable headers are buttons with `aria-sort` on the `th`, and a rebuilt tile, header or group toggle gets focus back by `data-focus-key`; filters, sort, grouping and the active tile live in memory only (section 6 is silent, as was the mockup), and `setClosedRange` (releases a tile when the range changes) waits for M8's control; 151 passing tests; checked in a browser with the fixture gh and a temp home (tiles, filters, the sort cycle by mouse and keyboard, grouping, Clear, the all-hidden message, a manual refresh keeping the tile and filters), light and dark, desktop and phone widths, with no console errors.
- M8 and M9 landed: `public/closed.ts` (pure: range days, summary, the Today / Yesterday buttons, the Monday footnote, whether the Ticket column shows) and the Closed heading's labeled button group with `aria-pressed`, switching locally between both cached ranges; the Ticket column between PR and Title only when a row in the range has a ticket (a no-ticket marker counts), sorted by its first label with ticketless rows last; range days are read twelve hours inside each end, so DST days and `todayStartsAt: utc` name the right dates; `public/status.ts` now holds the offline and partway banner (`role="status"` with `aria-live="off"`, since the sync region already announces each cycle end once), the header's offline and `paused · offline · cached <time>` readings (that combination is not in section 6), row markers (stale dot with an accessible name, muted age with a hidden reason, "cached <time>, paused"), section dots and the tables' states, where a failed first cycle, or a paused first load with no cycle running, now shows "No cached data yet" instead of endless placeholders; cache times show the weekday when not today; the banner disappears while a retry cycle runs, since only the latest cycle counts; the server needed no change, and two server tests now cover GitHub unreachable with and without a cache, then recovery; 166 passing tests; checked in a browser with the fixture gh and a temp home on a Tuesday and on a Monday clock (Today / Yesterday and Yesterday* with Fri–Sun times and the footnote, the Ticket column appearing and hiding, offline from the start and after a good cycle, Pause while offline, Refresh as a one-shot recovering while paused, muted paused ages after the interval, no cycles while paused and an `active` cycle only on a resume past 30 seconds), light and dark, desktop and phone widths, with no console errors.
- Theme toggle and M10 landed: the header's System / Light / Dark toggle on both pages (`public/theme.ts`, `localStorage` with a System fallback, applied before first paint by an inline head script that a test runs against `theme.ts`, synced across tabs), and the Settings page (`public/settings.html`, `settings.ts`, pure `settings-form.ts`) with every section, client checks and server refusals placed on their fields, people suggestions, live ticket samples, and a `BroadcastChannel` so an open dashboard picks up density and the Agent column; `cycleKeys` is now exported from `src/poller.ts` so a test keeps the page's refresh notice in step; `.table-box` is positioned so a cell's screen-reader-only text no longer widens the page at phone width; 190 passing tests; checked in a browser with the fixture gh and a temp home (toggle on both pages in light and dark system settings, persistence across reload and tabs, load, edit, client and server errors, save with the `config` cycle, the dashboard's aliases and density updating), desktop and phone widths, with no console errors.
- M11 and M12 landed: an end-to-end run against the default repository with the real `gh`, a temporary home and a logging `gh` shim on `PATH` (desktop and phone widths, light, dark and the theme toggle, tiles, filters, sorting, grouping, the hover card, Pause and Refresh, Settings load, validation, save with its `config` cycle, an image avatar, the unsaved-changes guard, unreachable and refused-sign-in GitHub simulated by the shim, and the Monday rule on a server started with a Monday clock), with rows spot-checked against `gh pr view` and the report files; the shim's log showed no GitHub call while the only page was hidden or paused past the interval, an `active` cycle on resuming, and none on returning within 30 seconds. Fixes: the `checking` merge state for `mergeStateStatus` `UNKNOWN`, which had shown approved, clean PRs as Blocked and grouped them as Waiting on author for a cycle; bot commits named `dependabot[bot]` as their actor; the viewer offered as a people suggestion; ticket samples finding no key when no open PR carries one (closed titles are now searched too); a Settings preview asking the server for an unsaved image; two concurrent `gh auth token` reads per cycle; and the failure's kind (`cycles.error_kind`, schema version 3, carried as `sync.cycle.errorKind`) so a refused sign-in, a rate limit, an interrupted cycle or another failure no longer reads as "Can't reach GitHub". 194 passing tests. pit-crew's `CLAUDE.md` (with its `AGENTS.md` target) and `README.md` now describe `pit-view/`, and `pit-view/.gitignore` also keeps out stray configs, caches, worktrees, demo folders, logs and plists.
