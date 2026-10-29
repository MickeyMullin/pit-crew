# Pit View: design

Pit View is a local dashboard for tracking pull requests in one GitHub repository. It answers, at a glance, which PRs need the viewer's attention, which of the viewer's own PRs are blocked or ready, and what closed today. Later it starts and monitors local agentic review sessions using pit-crew's review commands, and in phase 4 starts reviews on a schedule of its own, with or without a page open.

This file is the single source of truth for the design: the specification and master context for Pit View. It holds no task list and no progress history. Tasks, their dependencies, acceptance criteria and history live in the Pit View project in Dispatch, and the milestone codes cited in this file (M13, P2.9, P4.8 and the like) are the prefixes of those tasks' titles. A new session should be able to build any task from this file and its task alone. Update this file in the same change as any behavior change.

The approved visual mockup is a private Design canvas (version 41) at https://claude.ai/artifact/7B3JZYHqQ1N11mDxxCcdJM. Everything it shows is specified below, so the mockup is a reference, not a dependency. The canvas predates the rename and still shows the old name, Pit Wall; where the two differ, this file wins.

## 1. Purpose, scope and configuration

### Purpose

The viewer reviews, and follows up on, almost every PR in the configured repository. For other people's PRs the dashboard shows whose it is, whether it is ready for review, its issues (changes requested, merge conflicts, CI failures), time since its last activity and what that activity was, and whether it is ready to merge. For the viewer's own PRs it shows whether each is ready for review or re-review, whether a self-review exists and is current, changes requested (with a special call-out), other issues, and whether it is ready to merge. A separate section lists PRs closed (merged or closed unmerged) today.

Each PR is identified primarily by its number, which links to its page on GitHub. Its title is the description (never parsed from the body), truncated in rows and shown in full on hover.

### Scope

- v1: one repository at a time, read-only against GitHub, local only, single viewer. The UI always renders from the local cache first and then updates in place as fresh data arrives (section 3). It polls GitHub only while at least one page is visible, not paused and not idle; with no active page the server makes no GitHub calls for the UI. Each page has a Pause control beside Refresh (section 6). The deployed app runs from a clone under `~/app` as a launchd user agent, and a development checkout runs beside it as a separate instance (section 3, Hosting); nothing in any phase depends on the agent.
- Phase 2: start and monitor agentic review sessions per PR, and teach pit-crew's review commands a machine-readable call and response for Pit View (section 8).
- v3: stacks grouped, direct actions on PRs, and OS notifications (section 9).
- Phase 4: auto-review, a scheduler that starts review and re-review runs for new or updated PRs whenever the app is running, whether or not any page is open, independent of the UI's polling (section 10). It depends only on phase 2, so it could move ahead of v3. It supersedes, and then retires, the cron job the owner runs today to list which PRs need attention.
- Out of scope: commenting or approving from Pit View itself (reviews post through the review commands and their own rules), multi-user hosting. Pit View itself never posts, in any phase. Until v3 it makes no GitHub write of its own, and phase 4's runs post only through the review commands, and only once the owner turns posting on (section 10).

### Configuration

Configuration lives in `~/.config/pit-view/config.json`, with `~` expanded at runtime; a named instance such as `dev` uses `~/.config/pit-view-<name>/config.json` instead (section 3, Hosting). The repository ships `pit-view/config.example.json` with generic values; a missing config file means "use the example defaults plus the gh login". Settings edits in the UI write back to the same file. When proxy sign-in is configured, the OAuth client secret stays out of the repository and out of `config.json`'s Settings round trip.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `repo` | string `owner/name` | `Port-City/meridian` | The one repository tracked. |
| `viewer` | string | output of `gh api user --jq .login` | Whose PRs count as "Mine" and whose reviews count as "yours". |
| `people` | list of `{login, alias, initials, color, avatar}` | empty | `avatar` is `initials`, `github`, or a local image path under `~`. Unlisted logins get their GitHub avatar and login. New authors are suggested in Settings the first time they appear. |
| `tickets` | list of ticket systems (below) | Jira first, then GitHub issues | Optional; an empty list hides tickets everywhere. |
| `refreshSeconds` | 60, 120 or 300 | 300 | The UI's interval, applied only while a page is active (section 3). Shown in the header as "every 5m". |
| `idleMinutes` | 0, or a whole number from 5 to 1440 | 90 | Minutes with no user activity after which a visible page counts as idle and stops polling, as if paused (section 6). 0 means never idle. On the Settings page under Behavior. |
| `todayStartsAt` | `local` or `utc` | `local` | Local midnight in the machine's time zone. |
| `bots` | list of login substrings | `["dependabot", "renovate"]` | PRs by these collapse into a bot group. |
| `reportsDir` | path | `~/agents/output` | Where review reports are found for self-review detection. v1 is file-based; section 10, Report storage, proposes making this a legacy import source. |
| `density` | `comfortable` or `compact` | `comfortable` | Row padding 10px or 6px. |
| `showAgentColumn` | boolean | `false` in v1, `true` in phase 2 | Hides the phase 2 column until it works. As built (P2.4): the default stays `false`, and the owner turns the column on in Settings. |
| `allowedHosts` | list of host names | empty | Names a reverse proxy may reach the server by, besides its loopback names, for example `["pit.example.test"]`. Bare host names only: no scheme, port, path or wildcard; stored lowercased. The server still binds loopback only (section 3, Hosting). Not on the Settings page, which carries it over unchanged on save. |
| `cloneDir` | path | none | Phase 2 and 4: the owner's local clone of `repo`, written with `~`. Manual runs work in it (section 8, Launching runs); auto-review runs each work in their own worktree of it (section 10). Required before any run starts. As built (P2.4): optional and left out of the file when unset or empty; a save accepts any absolute path or path under `~`, and whether it is a clone of `repo` (a `git -C <cloneDir> remote -v` line naming `owner/name` over https or ssh) is checked at every start, not on save. Not on the Settings page yet, which carries it over unchanged on save. |
| `agent` | `{ "runner": "claude" \| "codex", "codexModel": string }` | `{ "runner": "claude" }` | Phase 2: the default runner for review sessions, which the drawer can override for one run, and an optional model passed to Codex as `-m` (section 8, Launching runs). As built (P2.4): a config without it validates as the default; `codexModel` is optional, an empty one is dropped, and it must be a bare model name (letters, digits, `.`, `_`, `:`, `/`, `-`, not starting with `-`). Not on the Settings page yet, which carries it over unchanged on save. |
| `notifications` | `{ "enabled": boolean, "kinds": [...] }` | absent (off) | v3: OS notifications on state transitions (section 9). Absent means off, and a save from the Settings page leaves the key out until notifications are turned on or a kind is unticked. `kinds` holds any of `changesRequested`, `readyToMerge`, `reviewRequested`, `ciFailing`, `runFinished`, and `runNeedsInput`; any other name, any other key, or an `enabled` that is not true or false is refused on save, and repeats are dropped. `config.example.json` leaves the key out, since absent is its default. On the Settings page under Notifications. |
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
- The launch agent's plist holds real absolute paths, so the committed `deploy/com.mickey.pit-view.plist` is a template holding only `__HOME__`, `__APP_DIR__`, `__NODE__` and `__PATH__` placeholders. `pnpm service:install` fills them at install time from `os.homedir()`, the checkout's own `pit-view/` folder, `process.execPath` and the shell's `PATH`, and writes the result to `~/Library/LaunchAgents/`, outside the repository. No rendered plist is ever committed; `pit-view/.gitignore` admits only the template (section 3, Hosting).
- pit-crew's `CLAUDE.md` and `README.md` carry a short entry describing the new folder.
- The repository is public. Keep client specifics (repo names other than the default config value, colleague names, PR titles, job URLs, ticket keys) out of committed files, fixtures included. Fixtures use invented data.

## 3. Architecture and stack

### Stack

- Node 26 (verified: v26.8.1 runs `.ts` files directly through built-in type stripping, `node:sqlite` works without flags, and `stripTypeScriptTypes` from `node:module` is present). Write TypeScript that type stripping accepts: no enums, no namespaces, no parameter properties; use `import type` for types; import local modules with their `.ts` extension.
- pnpm is the package manager; Node is the runtime. pnpm runs the scripts and installs the dependencies listed below.
- Built-ins first. HTTP via `node:http`, storage via `node:sqlite`, child processes via `node:child_process`, tests via `node:test` and `node:assert`. A runtime dependency is fine when it does a job the built-ins can't; each one is listed here with its reason. A dev-only `typescript` provides `tsc --noEmit` for `pnpm check`; it is not required to run. The dev-only `typescript` check includes the Node type declarations needed for `node:` imports, currently `@types/node`; the runtime does not require that package.
- Runtime dependencies:
  - `marked`, to render Markdown (review reports, for a start) as HTML. Rendering happens on the server, so the browser never loads it, and follows the two defenses in dispatch's `client/src/markdown.ts`: a custom renderer that escapes all raw HTML, block and inline, and drops any link or image URL whose scheme is not http, https or mailto (decoding entities and stripping control characters before reading the scheme; an unsafe link keeps its text), with links opening in a new tab with `rel="noopener noreferrer nofollow"`; and display only inside a sandboxed `<iframe srcdoc>` whose document carries no script, a no-referrer policy and a CSP of `default-src 'none'; img-src https:; style-src 'unsafe-inline'` (https only, so a hostile report cannot make the browser send requests to a local http service). The iframe's `sandbox` is exactly `allow-popups allow-popups-to-escape-sandbox` and nothing else, so a report's links (http, https and mailto only) open in a new, unsandboxed tab while no script can run; the reports are local, but they quote other people's text. Built as `src/markdown.ts` (the fragment) and `public/reportview.ts` (the document). Report text quotes other people's PRs, so it is treated as hostile input.
- UI: static HTML, CSS and TypeScript ES modules served by the same server. The server serves each `public/*.ts` file as JavaScript by passing it through `stripTypeScriptTypes`, cached in memory by modification time, so there is still no build step. The UI is small and table-shaped; a framework buys little and adds a toolchain.
- Fonts: Inter and JetBrains Mono from Google Fonts, falling back to `system-ui` and `ui-monospace` when offline.

### Layout

```
pit-view/
  DESIGN.md              this file
  README.md              how to run
  config.example.json
  package.json           scripts: start, dev, test, check, service:*; the runtime dependency `marked`; packageManager pins pnpm
  pnpm-lock.yaml
  tsconfig.json          noEmit, allowImportingTsExtensions, strict
  src/
    server.ts            HTTP server, static files, API, event stream
    config.ts            load, defaults, save, ~ expansion
    github.ts            gh token, GraphQL and search queries, page callbacks
    poller.ts            refresh cycles, per-page apply, patch emission
    clients.ts           connected pages: client ids, visible, paused and idle, the active set
    launcher.ts          phase 2: review runs: command lines, default runs, the Agent cell, start, watch, settle, stop, recovery
    autoreview.ts        phase 4: scheduler, qualification, queue
    notify.ts            v3: transition detection, the run-kind mapping, the notice text, and the osascript delivery behind an injectable function
    cache.ts             SQLite schema and access
    derive.ts            every rule in section 5, pure functions
    reports.ts           self-review report discovery and parsing; the drawer's report listing and the contained read
    markdown.ts          Markdown to a sanitized HTML fragment (marked, with the escaping renderer)
    time.ts              day boundaries, Monday rule, relative ages
  public/
    index.html
    app.ts               view state, patch application, rendering
    agent.ts, agentcell.ts  the Agent column: the pure cell model and the cell's single button
    drawer.ts, drawerview.ts, runapi.ts   the Agent drawer: DOM and focus, the pure view model, the run calls
    reportpanel.ts, reportview.ts   the report side panel and the sandboxed document builder
    safeurl.ts           the scheme check every server-supplied link or image passes through
    styles.css           the only place colors are defined
  deploy/
    README.md            first deployment to ~/app and updates
    com.mickey.pit-view.plist   the launch agent's template, placeholders only
  scripts/
    service.ts           install, uninstall, status and restart of the launchd user agent
  test/
    fixtures/            invented GraphQL responses and report files
    derive.test.ts
    time.test.ts
    reports.test.ts
    cache.test.ts
    poller.test.ts
    clients.test.ts
    server.test.ts       HTTP on an ephemeral port, temp home, config and cache
    launcher.test.ts     phase 2: builders, settling, stop, recovery, retention, with fake processes
    launcher-run.test.ts phase 2: end to end with fake claude and codex executables on a temp PATH
    markdown.test.ts     hostile Markdown through the renderer
    ui-drawer.test.ts, ui-report.test.ts, ui-safeurl.test.ts   the drawer's view model, the report document, the link and image checks
    notify.test.ts       v3: the transitions, the kind filter, and argv safety, with a recording delivery
    autoreview.test.ts   phase 4
```

### Runtime

- `pnpm start` runs `node src/server.ts` and listens on `127.0.0.1:4791` (configurable with `PIT_VIEW_PORT`); `pnpm dev` runs the `dev` instance on `127.0.0.1:4792` (Hosting, below). Bind to loopback only, in every hosting mode.
- Auth: run `gh auth token` once, before the first GitHub call, and again on any 401; never store the token. Fetching the token is local; it is not a GitHub call.
- Viewer: an empty `viewer` is resolved at startup from gh's own config file (`gh config get user -h github.com`, the active account), which is local and not a GitHub call. Only when that names nobody does the first cycle ask `gh api user` before it fetches anything.
- Cache first, always: every read the UI makes is answered from SQLite immediately and never waits on GitHub. Fresh data reaches the UI only as patches on the event stream, so a slow or failed GitHub call can delay an update but never delay or blank the page.
- Active pages: every connected page is a client with an id, and reports whether it is visible (the Page Visibility API's `document.visibilityState`) whether it is paused (the header's Pause control, section 6), and whether it is idle (no user activity for `idleMinutes`, section 6). A client is active when it is visible, not paused and not idle; an idle page counts exactly as a paused one, so a visible but idle page is not active and the server makes no GitHub calls for it. A background tab or a minimized window is hidden; a visible page in an unfocused window still counts as visible. The server keeps the clients in memory only (`src/clients.ts`): a client exists while its event stream is open and is dropped when the stream closes.
- The UI polls only while it is active: UI-driven cycles run only while at least one client is active. With no active client the server makes no GitHub calls for the UI, and the interval timer is cleared rather than left to fire and skip. No cycle runs at server start.
- Refresh cycles start on these triggers, each recorded as the cycle's `trigger`:
  - `active`: a client becomes active (it opens its stream visible, unpaused and not idle, becomes visible, resumes, or leaves idle), no cycle is running, and the last cycle of any trigger started more than 30 seconds ago. Opening or returning to a page therefore always shows the cache first, then refreshes only when that data is older than 30 seconds. A reload keeps the schedule instead: a page opening its stream with a `lastUpdate` (Polling, visibility, pause and idle, in section 6) under `refreshSeconds` old is not this trigger, so it shows the cache and the interval timer counts on from the last start, firing at once if that is already past. `keepsSchedule` in `src/clients.ts` is the rule.
  - `interval`: every `refreshSeconds` while at least one client is active, counted from the start of the last cycle of any trigger, so a cycle that just ran for another reason postpones the next interval cycle rather than doubling it. The timer starts when the first client becomes active and stops when the last one goes inactive; a cycle already running when that happens finishes.
  - `manual`: `POST /api/refresh`, a one-shot from any page, paused or not.
  - `config`: a saved config change that needs one (`PUT /api/config`), also a one-shot.
  - `autoReview`: phase 4's scheduler, on its own clock and never on the UI's schedule (section 10).
- Only one cycle runs at a time; a trigger during a cycle joins it. A cycle runs its fetch units concurrently: the open-PR query (page by page) and the closed search. Reports in `reportsDir` are rescanned at the start of every cycle.
- Per-response apply: as each response arrives (each open-PR page, the closed search), the poller writes it to SQLite, recomputes only the rows it touched plus the tiles and counts, and emits one patch. Rows the cycle has not reached yet keep their cached values.
- Completion: when every open-PR page has arrived, PRs still cached as open but absent from the full list are removed from the open sections (they closed or merged; the closed search picks them up). A cycle that did not finish removes nothing.
- Failure: on any network or GitHub error the cycle stops, keeps every row it already updated, marks the rows and sections it did not reach as stale with the error and their last fetch time, and the next cycle runs at the normal interval if a client is still active, or when one next becomes active.

### Hosting

The owner's convention: apps are developed in `~/dev` and deployed to `~/app` (or `/Volumes/Hyperspace/app`), where an install is a clone of the repository's `master` branch, supervised by launchd under a `com.mickey.<name>` label and registered in `~/app/service-registry.yaml`; the development and deployed instances run side by side on ports one apart. For Pit View the deployed app is `~/app/pit-crew`, run from its `pit-view/` folder. The server binds loopback only. By default it also answers only to its loopback names; to serve it on the LAN, a reverse proxy such as Caddy terminates HTTPS on the same machine, forwards to `127.0.0.1:4791` with the `Host` header passed through, and that host name is listed in the app's `allowedHosts` (section 1). The real name lives in the local config, never in the repository. `deploy/README.md` has the commands for the first deployment and for updates. After a runtime dependency changes, the deployed instance must run `pnpm install` before its next restart.

| Instance | Started by | Port | Config folder | State folder (cache, logs, phase 4 worktrees) |
| --- | --- | --- | --- | --- |
| App (default) | the `com.mickey.pit-view` launch agent, from `~/app/pit-crew/pit-view` | 4791 | `~/.config/pit-view/` | `~/.local/state/pit-view/` |
| Dev | `pnpm dev` in `~/dev/pit-crew/pit-view` | 4792 | `~/.config/pit-view-dev/` | `~/.local/state/pit-view-dev/` |

- The instance override: `PIT_VIEW_INSTANCE` names the instance. Unset or empty is the default instance, the deployed app; `pnpm dev` sets it to `dev`. A name is lowercase letters, digits and `-`, starting with a letter, and puts every folder at `pit-view-<name>`; its default port is 4792 for `dev`, and any other name must also set `PIT_VIEW_PORT`. `PIT_VIEW_PORT` overrides the port of any instance. `resolveRuntime` in `src/server.ts` is the one place this is decided, so two instances never share a config, a cache, a port or (since each port is its own browser origin) the pages' theme and pause state.
- A named instance marks itself: `GET /api/instance` returns `{ "name": "dev", "configPath": "~/.config/pit-view-dev/config.json", "pid": 123 }`, and both pages lead their title with the name (`dev · Pit View`) and show it as a small badge in the header. The default instance answers with an empty `name` and shows neither, so the owner can tell dev from the app at a glance.
- Either instance can also be run by hand (`pnpm start`, `pnpm dev`) and behaves the same: phase 4's scheduler runs whenever the app is running, whether or not a page is open. The hosting mode decides only how the app gets started, and nothing in any phase requires the agent.
- In every mode the server idles when nobody is looking: with no active client, and auto-review off or outside its hours, it makes no GitHub calls and starts no processes. It holds only the scheduler's timer for its next tick or next active-hours start, and sends keepalives on any open streams.
- What M5 built so the agent needs no server changes: no GitHub call at startup; a clean exit on `SIGTERM` and `SIGINT` (close the streams, finish the SQLite write in progress); when the port is already taken, an exit with a non-zero status and a message naming the port, never a fallback to another port (the port is bound before the cache is opened, so the second server exits without touching the running one's cache); logs on stdout and stderr only; every path resolved from the config, `os.homedir()` or `import.meta.url`, never from the working directory.
- The launch agent: label `com.mickey.pit-view`, plist at `~/Library/LaunchAgents/com.mickey.pit-view.plist`, rendered from the committed template `deploy/com.mickey.pit-view.plist` (section 2) by `renderPlist` in `scripts/service.ts`, a pure function that XML-escapes each value and refuses an unknown placeholder or a relative path. The agent has `RunAtLoad` true; `KeepAlive` restarting it only after an unsuccessful exit (a crash, or a start that failed), so a clean `SIGTERM` exit stays stopped; `ProgramArguments` holding the Node binary that ran the install (`process.execPath`) and the clone's `src/server.ts`; `WorkingDirectory` the clone's `pit-view/` folder; `EnvironmentVariables` holding the installing shell's `PATH`, without the entries pnpm adds for its scripts and with Node's folder first, so `gh` and the review command runner resolve (launchd's default `PATH` lacks most user tool locations); no `PIT_VIEW_INSTANCE`, since the agent is always the default instance; and stdout and stderr in `~/.local/state/pit-view/server.log` and `server.err.log`.
- `pnpm service:install` refuses a checkout that is not on `master`, so a development checkout never becomes the agent. It renders the plist, creates the state folder (launchd does not create a log file's folder), boots out an earlier install and waits for it to go, writes the plist, bootstraps it into `gui/<uid>` (retrying, since bootout can return before launchd has finished), and waits until 127.0.0.1:4791 answers from the agent's own process, comparing the pid `/api/instance` reports with the one `launchctl print` shows. It is safe to rerun, and must be rerun after upgrading or moving Node, since the plist pins the binary. `pnpm service:restart` runs `launchctl kickstart -k` and waits the same way. `pnpm service:uninstall` boots the agent out and removes the plist, leaving the config, cache and logs. `pnpm service:status` reports the plist, whether the agent is loaded and its pid, and whether 127.0.0.1:4791 answers from that process, rather than from a manual start or another instance; it exits non-zero unless all of that holds.
- With the agent running, a manual `pnpm start` of the default instance exits with the port-taken message; the agent is the one app server, and `pnpm dev` is the second copy. No mode binds anything but `127.0.0.1`.
- The agent runs in the user's login session, so `gh auth token` reads the same credentials as a terminal; the first deployment confirmed this.
- Behind a reverse proxy: the `Host` check accepts a name in `allowedHosts` with any port or none, and the `Origin` check for writes accepts `http://` or `https://` on that name, with any port or none, besides the loopback origins (HTTP API, below). `hostAllowed` and `originAllowed` in `src/server.ts` are the pure functions that decide, and they read the config in effect, so a saved change applies at once. The event stream sends `Cache-Control: no-cache, no-store, no-transform` and `X-Accel-Buffering: no`, has no `Content-Length`, turns off Nagle's algorithm on its socket, and keeps its 30-second keepalives, so a proxy neither buffers nor compresses it and an idle stream is not timed out.
- Security behind a proxy: Pit View has no sign-in. Anyone who reaches the proxy can read the dashboard and use every write, Refresh and Settings included (`PUT /api/config` can change the repository, `reportsDir` and `allowedHosts` itself). The Host and Origin checks stop DNS rebinding and other sites' pages, not people on the network, so the proxy must be limited to the LAN (or a trusted tailnet) and never published. Section 9's per-start token exists since P2.4 and guards starting and stopping review runs (HTTP API, below), which are allowed from anywhere the app is reachable, loopback or an allowed proxy host; the token stops other sites' pages, not people on the LAN, who are served the page and its token like the owner, so P2.8's sign-in is what closes that. Phase 4's checks on `PUT /api/config` still come with that phase.
- When access is through an allowed reverse-proxy host, Pit View must authenticate users with a GitHub OAuth app whose callback is that proxied host. Only the configured `viewer` login may use the app. The authenticated session must be kept in a signed, `HttpOnly`, `Secure`, `SameSite=Strict` cookie. The OAuth client secret must stay out of the repository and out of `config.json`'s Settings round trip. The design still needs to state whether loopback access stays open without sign-in and how OAuth authentication combines with the per-start token. After sign-in is built, starting runs that post under the owner's account must no longer be open to anyone on the LAN.

### GitHub queries

Open PRs: one GraphQL query per cycle, `pullRequests(states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC})` paginated by 100, so the most recently changed PRs refresh first. Each page is handed to the poller as it arrives. For each PR it fetches: `number`, `title`, `url`, `isDraft`, `author { login avatarUrl }`, `headRefName`, `baseRefName`, `headRefOid`, `createdAt`, `updatedAt`, `additions`, `deletions`, `changedFiles`, `mergeable`, `mergeStateStatus`, `reviewDecision`, `body` (only to detect the no-ticket marker; never displayed), `reviewRequests { requestedReviewer { ... on User { login } ... on Team { name } } }`, `latestReviews { author { login } state submittedAt commit { oid } }`, `latestOpinionatedReviews { author { login } state submittedAt commit { oid } }`, `commits(last: 1) { commit { oid committedDate statusCheckRollup { contexts(first: 100) { ... on CheckRun { name conclusion status detailsUrl checkSuite { workflowRun { workflow { name } } } } ... on StatusContext { context state targetUrl } } } } }`, `closingIssuesReferences(first: 10) { number title url }`, and `timelineItems(last: 5, itemTypes: [PULL_REQUEST_COMMIT, PULL_REQUEST_REVIEW, ISSUE_COMMENT, REVIEW_REQUESTED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, RENAMED_TITLE_EVENT, HEAD_REF_FORCE_PUSHED_EVENT]) { ... }` for last activity. Reviews since the viewer's last review also need `commits(last: 30) { commit { oid committedDate } }` to count pushes; fetch it in the same query. The open-PR query aliases its two `commits` connections as `headCommit` and `recentCommits`, and it must fetch `defaultBranchRef`, `rateLimit` and `totalCount` in addition to the fields above. It fetches both `latestReviews` and `latestOpinionatedReviews` (the newest approving or change-requesting review per reviewer) because GitHub drops a reviewer from `latestReviews` once a review is re-requested of them, while `latestOpinionatedReviews` keeps what they decided; every rule in section 5 reads the newest review per reviewer across the two, never one connection alone.

Closed PRs: one search query `repo:<repo> is:pr is:closed closed:<from>..<to>`, where `<from>` is the start of the Yesterday range (section 5, Monday rule included) and `<to>` is now, so a single response fills both the Today and Yesterday views and the Closed tile's subtext. It fetches the per-PR fields the Closed table needs (number, title, url, author, state, merged, mergedBy, closedAt, headRefName, closingIssuesReferences). The closed search must also fetch `body` for ticket-marker detection and the closing event's actor for `closedBy`.

### SQLite cache

File: `~/.local/state/pit-view/cache.sqlite`, or `~/.local/state/pit-view-<name>/cache.sqlite` for a named instance (Hosting, above).

| Table | Columns | Purpose |
| --- | --- | --- |
| `cycles` | `id`, `repo`, `trigger` (`active`, `interval`, `manual`, `config` or `autoReview`), `started_at`, `finished_at`, `ok`, `error`, `error_kind` (gh's error kind, `interrupted` or `internal`; added in M11, schema version 3), `pages_done`, `prs_updated` (distinct PRs written), `prs_total` | One row per refresh cycle; keep the last 200. |
| `snapshots` | `id`, `cycle`, `repo`, `kind` (`open-page` or `closed`), `page`, `fetched_at`, `ok`, `error`, `payload` (raw JSON) | Raw responses; keep those of the last 50 cycles. |
| `prs` | `repo`, `number`, `state`, `updated_at`, `head_oid`, `fetched_at`, `cycle`, `last_seen_at`, `data` (normalized JSON) | Latest known state per PR and when it was fetched; the source of every open row. |
| `meta` | `key`, `value` | `schemaVersion`, plus per-repo JSON values: `lastSuccess:<repo>`, `lastError:<repo>`, `closedFetched:<repo>`, `openListed:<repo>` (last cycle that reached the final page), `defaultBranch:<repo>`. |
| `runs` | `id`, `repo`, `number`, `command`, `args` (JSON, without `--emit-json`), `label`, `runner`, `cwd` (written with `~`), `dir` (the run directory, written with `~`), `session_id`, `pid`, `pid_started_at` (the start time `ps -o lstart=` prints), `started_at`, `last_step_at`, `step`, `step_state` (the newest `events.jsonl` line), `finished_at`, `status` (`running`, `done`, `failed`, `needsInput` or `stopped`), `result` (`result.json` as parsed and checked, JSON), `note`, `cost_usd`, `resume` (the Open session command), `steps` (JSON, the five step slots, section 8); added in P2.4, schema version 4, with `steps` added in P2.5, schema version 5 | Phase 2's review runs (section 8, Launching runs); keep the last 200, never pruning one still running, and delete a pruned run's directory with it. |

The view is always computed from `prs` (open rows), the latest successful `closed` snapshot, local reports, the latest run of each PR in `runs`, and the config. A failed or partial cycle never blanks or rolls back a row; it only changes the freshness the row reports.

A cache file from another schema version has its GitHub tables (`meta`, `cycles`, `snapshots`, `prs`) dropped and rebuilt, since GitHub gives them back; a new field in the open-PR query bumps the version for the same reason, because a cached row written before it lacks the field. `runs` is the exception: it is created if missing and otherwise kept through a rebuild, its ids never reused (`AUTOINCREMENT`), since nothing else records the runs. A change to its own columns needs a migration of its own (`steps` came as `ALTER TABLE ... ADD COLUMN`, so existing runs survived the bump to version 5, reading as five pending slots); phase 4's columns are additions (`ALTER TABLE ... ADD COLUMN`), and `status` has no `CHECK` constraint, so phase 4's `queued` and `skipped` need no rebuild either.

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
  "refresh": null,
  "agent": null
}
```

`reviewers[].state` is `approved`, `changes`, `commented` or `requested`; a pip for a requested team carries `team: true`, with the team's name as its `login` and `alias`. `issues[].kind` is `changesRequested`, `conflicts`, `ciFailing`, `ciRunning`, `ciCanceled` or `ciNotRun`; `url` is set only for `ciFailing`. `merge.state` is `ready`, `needsReview`, `needsApproval`, `checking`, `blocked` or `draft`. `stack` is null for unstacked PRs. `tickets` may hold a `{ "system": "none", "label": "no-ticket" }` entry. `freshness.state` is one of the row states in Freshness above; a row's `freshness` carries only `state` and `fetchedAt`, the error living in `sync.cycle.error` and the sections. `refresh` is the row's own one-PR refresh (Other endpoints, below): `{ "state": "running", "startedAt": "..." }` while it runs, `{ "state": "failed", "at": "...", "error": "...", "errorKind": "rateLimit" }` after it failed (gh's error kinds, or `internal`), and null otherwise; a failure stays until the row is next fetched, by a cycle or by a refresh of its own that succeeds. `agent` is the row's Agent cell (shape in section 8, Agent cell); every row the server serves carries one, idle when the PR has no run. Person `color` values are config data, not styling; the UI applies them through one CSS custom property (section 4).

`OtherRow` adds `section: "others"`, `group` (`yourMove`, `readyToMerge`, `waitingOnAuthor`, `bots`) and `flags` (list of `{ "kind": "reReview", "label": "Re-review · 1 push since yours", "count": 1 }` or `{ "kind": "requestedOfYou", "label": "Requested of you" }`).

`MineRow` adds `section: "mine"`, `group` (`changesRequested`, `readyToMerge`, `awaitingReview`, `drafts`), `stage` (`changesRequested`, `reReviewRequested`, `updatedNotRequested`, `awaitingReview`, `approved`, `draft`), `selfReview` (`{ "state": "current" | "stale" | "none", "reviewedOid": "b5d43a3", "headOid": "5c65b9b", "tandem": true, "file": "PR-101.md", "at": "..." }`) and `changesRequested` (`{ "login": "alex", "alias": "Alex", "at": "..." }` from the latest changes-requested review, for the call-out banner, or null).

`ClosedRow` is `number`, `url`, `title`, `author`, `outcome` (`merged` or `closed`), `closedBy` (`{ "alias": "Alex", "login": "alex", "text": "merged by Alex" }`, with `text` "merged by you" for the viewer, or `{ "label": "superseded", "text": "superseded" }`, or `{ "label": "merged" | "closed", "text": ... }` when GitHub names no actor), `closedAt`, `tickets`.

`GET /api/events?client=<id>&visible=<true|false>&paused=<true|false>&idle=<true|false>[&lastUpdate=<time>]` is a server-sent events stream of patches. `lastUpdate`, sent when the browser has one, is the start of the last cycle it saw (section 6); one under `refreshSeconds` old keeps the schedule rather than starting an `active` cycle, and a value that is not a time is refused with 400. The page generates its client id once per load (`crypto.randomUUID()`) and reuses it on every reconnect, and the query carries its current state, so a reconnect restores the client exactly; opening the stream registers the client and closing it drops the client. Each patch is one `patch` event, applied atomically, carrying only what changed:

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
- A one-PR refresh (Other endpoints, below) yields two patches: the row alone with `refresh.state` `running`, then its rows, `removed`, tiles and counts. Neither carries `sync`, since no cycle ran.
- `tiles`, `counts`, `sync` and, in phase 4, `autoReview` are partial objects merged into the current view; `rows` and `removed` are keyed by PR number; `closed`, when present, replaces the whole Closed section.
- `version` increases by exactly one per patch. The client opens the event stream first, then fetches `/api/view`, drops buffered patches with a version at or below the view's, and applies the rest in order. Any gap in versions, or a reconnect, means the client refetches `/api/view` and starts again from it.
- The stream sends a comment line every 30 seconds to keep the connection open. Keepalives are local and never cause a GitHub call. Patches reach every connected page, active or not, so a paused or hidden page that is still connected stays current with whatever other triggers fetch.

Other endpoints:

- `POST /api/clients/<id>` with `{ "visible": true, "paused": false, "idle": false }` updates a client's state. The page sends it on every `visibilitychange`, on every Pause or Resume, and when it enters or leaves idle. `idle` may be left out, meaning false, so a page loaded before idle existed still reports; in the stream query, too, an absent `idle` is false. It returns `{ "active": true, "cycle": 18 }`, where `cycle` is the cycle this change started or joined under the `active` rule, or null. An unknown id (its stream is not open) returns 404, and the page reopens its stream, which carries its state.
- `POST /api/refresh` starts a cycle now, or joins the running one, whatever the client states; returns `{ "started": true, "cycle": 18 }` or `{ "started": false, "cycle": 17 }`.
- `POST /api/prs/<number>/refresh` fetches that one PR, whatever the client states (a deliberate one-shot like Refresh, so a paused page may ask), and never starts or joins a cycle. It takes no body; one sent anyway must be `application/json`, and the Host and Origin checks apply as to every write. It runs one GraphQL query, `SinglePullRequest`, asking `repository.pullRequest(number:)` for its `state` and exactly the open query's PR fields, through the same injected gh runner. It patches the row first with `refresh.state` `running`; then, if the PR is still open, writes it to the cache (stamped with the repo's latest cycle, so it reads `current`), rescans that PR's self-review report when it is the viewer's, re-derives the view (stacks included), and patches that row plus every other row whose derivation changed, with tiles and counts. If it is now closed or merged, it marks the row closed in the cache and the patch carries it in `removed`; the Closed section is the closed search's, so the PR appears there with the next cycle. A failure records nothing in `cycles` and no section changes, so the board never reads offline: the row alone carries `refresh.state` `failed` with the error and its kind. A request for a PR whose refresh is already in flight joins it rather than asking GitHub again. It answers once done with `{ "number": 101, "outcome": "open" | "closed" | "failed", "joined": false, "error": null, "errorKind": null }`; a number that is not a positive integer is 400.
- `GET /api/config` and `PUT /api/config` read and replace the config (validated; returns the saved config or `{ "error": "..." }` with status 400). A saved config that changes `repo`, `viewer`, `people`, `tickets` or `bots` starts a one-shot `config` cycle, and the recomputed rows arrive as patches. From phase 4, `PUT /api/config` requires the same-origin and token checks in section 10.
- `GET /api/instance` returns `{ "name": "", "configPath": "~/.config/pit-view/config.json", "pid": 123 }`: the instance's name (empty for the default instance), its config file written with `~`, and the server's process id, which `pnpm service:status` compares with the agent's (Hosting, above). The pages use it for their title, header badge and the Settings page's config path.
- `POST /api/prs/<number>/runs` starts the row's default run (section 8, Launching runs, and Agent cell for which run that is), never `review-local`, and with `--no-post` on every review of the viewer's own PR. The body is optional: `{ "kind": "default" | "tandem" | "stack" | "fix", "runner": "claude" | "codex" }` picks what to start (`default`, the row's default run, when omitted; `tandem` is `review-pr <n> --tandem`, Claude only, still with `--no-post` on the viewer's own PRs; `stack` is `review-stack <n>`, offered only for a stacked PR; `fix` is `fix-pr <n>`, P2.6's Fix session, offered only on the viewer's own open PRs (drafts included, never a bot's), Claude only, and never with `--no-post`, since its push is what it is for; the row's `agent.starts` lists what is offered) and the runner for this run, otherwise `agent.runner` (Claude for `tandem` and `fix`); any other field is 400, and a body must be `application/json`. It answers with the run as the `runs` table holds it (`id`, `repo`, `number`, `command`, `args`, `label`, `runner`, `cwd`, `dir`, `sessionId`, `pid`, `pidStartedAt`, `startedAt`, `lastStepAt`, `step`, `stepState`, `finishedAt`, `status`, `result`, `note`, `costUsd`, `resume`, plus `steps`, the five step slots, and `tandem`), status `running` (or `failed` with `spawnFailed: ...` when the runner could not be spawned). Refusals carry `{ "error": "..." }`: 400 for a number that is not a positive integer, a bad body, an unknown kind or runner, or `tandem` or `fix` with `codex` (checked before whose PR it is); 422 for a PR that is not an open PR of `repo` in the cache, a kind not offered for it (tandem on a Dependabot PR, stack on a PR outside a stack, fix on a PR that is not the viewer's, whatever the page asks), an unset `cloneDir`, a `cloneDir` that is not a clone of `repo`, or a `gh api user --jq .login` that is not `viewer` (the message names both logins); 502 when gh's account cannot be read; 409 while a run for that PR is in flight. The start's one GitHub call is the identity check.
- `POST /api/runs/<id>/stop` stops a running run (section 8, Launching runs, Stop). It takes no body and answers at once with the run, still `running`; the row's patch says `stopped` once the process is gone. 404 for an unknown id, 409 for a run that is not running.
- `GET /api/prs/<number>/runs` lists that PR's runs in the current `repo`, newest first, in the same shape, for the drawer. A read: no token.
- `GET /api/prs/<number>/reports` lists that PR's reports, newest first, from `reportsDir`: `PR-<n>.md` and `PR-<n>-*.md` (so `PR-1010.md` is not PR 101's; a tandem run's suffixed drafts are listed and mark every review entry `tandem`), and since P2.6 `FIX-<n>.md`, `fix-pr`'s report (exactly that name: no suffixes, and `FIX-1010.md` is not PR 101's); symlinks are skipped. Each entry is `{ "name": "PR-101.md", "kind": "review" | "fix", "modifiedAt": "...", "sha": "abc1234" | null, "tandem": false, "verdict": "changesRequested" | "clean" | null }`. A review's verdict is read from the first 256 KB (a P0 to P2 finding means changes requested; P3 only or no findings means clean). A fix report's `sha` is the short head on its `PR:` line (the head the run read), its `verdict` is null and its `tandem` false, and it never makes a review report `tandem`. A read: no token.
- `GET /api/reports/<name>` returns one report as `{ "name", "modifiedAt", "html", "raw" }`: `raw` is the Markdown and `html` a body fragment rendered by `src/markdown.ts` (raw HTML escaped, unsafe link and image URLs dropped, section 3). The name must match `^PR-\d+[A-Za-z0-9._-]*\.md$` or, since P2.6, `^FIX-\d+\.md$`, with no `..` or separators (400); the file is resolved with `realpath` and must be a regular file directly inside the resolved `reportsDir`, which may itself be a symlink (404 otherwise, symlinks leading elsewhere included); larger than 1 MB is 413. A read: no token. Stack reports (`STACK-<n>.md`) are not listed or served until P2.9.
- `review-stack` writes `STACK-<n>.md`, named for the top layer's number.
- Once stack reports are supported, the name must also match `^STACK-\d+\.md$`; the existing no-`..`, no-separator, realpath containment, regular-file and size checks still apply.
- The per-start token: at every start the server makes a random token (32 random bytes, base64url) and keeps it in memory only. Every HTML page it serves gets `<meta name="pit-view-token" content="<token>">` inserted before `</head>` at serve time, never written to the file on disk, and is sent with `Cache-Control: no-store`, so a page from an earlier start cannot be replayed from a cache. Both run writes require the token in an `X-Pit-View-Token` header, compared in constant time; missing or wrong is 403 ("reload the page"), on top of the Host, Origin and content-type checks below. A restart therefore makes open pages refuse to start runs until they reload. The dashboard reads the tag once at load and sends the header on both run writes since P2.4 (section 6, Columns, the Agent cell).
- `GET /api/people/suggestions` lists logins seen in cached PRs (open authors and reviewers, closed authors) that are not in `people` and are not the viewer (who always shows as You), as `[ { "login": "sam", "avatarUrl": "https://...", "count": 4 } ]`, most often seen first.
- `GET /api/avatar/<login>` serves the image file a `config.people` entry names as its `avatar` (a path under `~`), so a local image never reaches the page as a path. Only PNG, JPEG, GIF, WebP and AVIF files that resolve inside the home directory are served; anything else is 404. Derived people point at it as their `avatarUrl`.
- Every request must name the server by its loopback address (`Host` of `127.0.0.1`, `localhost` or `[::1]` with the port) or by a name in `config.allowedHosts` (with any port or none), so a page that reached it through another name is refused (403). Requests other than GET with an `Origin` header that is not the server's own (`http://` and a loopback address with the port, or `http://` or `https://` on an allowed host) are refused (403), and JSON bodies must be sent as `application/json` (415 otherwise), which keeps another site's page from writing through a simple request. These are the cheap half of section 9's checks. The other half, the per-start token, guards the run endpoints (below) since P2.4; `PUT /api/config` gets it in phase 4.
- `GET /api/config` returns the config as stored, so an empty `viewer` stays empty there; the view's `viewer` is the resolved login. `GET /` serves `public/index.html`; `public/*.ts` is served as `text/javascript` after `stripTypeScriptTypes`, and dot files and paths outside `public/` are 404.
- The event stream starts with a `: connected` comment, so the page's `EventSource` opens before it fetches the view, and keepalives are `: keepalive` comments. Patches carry no SSE `id`, since nothing is replayed.

Grouping, filtering and sorting are done in the UI from these rows; the server only assigns `group` and computes derived fields.

## 4. Code conventions

These are the owner's conventions, adapted to this app. They apply to every file under `pit-view/`, tests and fixtures included.

- TypeScript everywhere (`src/`, `public/`, `test/`), ES modules only (`"type": "module"`), written for Node's type stripping as described in section 3. Runtime is Node; pnpm is only the package manager.
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

Built from the newest review per reviewer across `latestReviews` and `latestOpinionatedReviews` (compared by `submittedAt`, `latestReviews` winning a tie), plus pending `reviewRequests`. Both connections are read because GitHub drops a reviewer from `latestReviews` once a review is re-requested of them, which would hide the change request or approval the re-request is about; `latestOpinionatedReviews` keeps it. Everywhere this file says a reviewer's "latest review" (the viewer's too, in the flags, groups, and stages below), it means this merged list:

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
| checking | Checking | no issue chips and `mergeStateStatus == UNKNOWN`: GitHub has not computed mergeability yet, typically just after a server restart or after the base branch moved; the next cycle reads it (added in M11, where approved PRs showed Blocked for one cycle). With `reviewDecision == APPROVED` the PR still groups as Ready to merge (below), keeping this state and label so the row says the merge is not yet confirmed |
| blocked | Blocked | anything else (any issue chip, or `BLOCKED`, `DIRTY`, `BEHIND`, `UNSTABLE`) |

The rules apply top to bottom, so a PR with no reviews whose state is `UNKNOWN` still reads Needs review, and one that is not approved never reaches Checking. Sorting puts Checking between Needs review and Blocked, so within Ready to merge an unconfirmed PR sorts after the confirmed ones; the Merge filters have no Checking option (it shows under any, and as Not ready in Mine), so Merge = Ready leaves out an approved PR that is still checking while Status = Ready to merge keeps it.

### Others' groups, in precedence order

1. **Dependabot** (`bots`): bot PR. The group is labeled with the bot's alias when only one bot appears, otherwise "Bots".
1. **Ready to merge** (`readyToMerge`): merge state `ready`, or merge state `checking` with `reviewDecision == APPROVED` (a non-draft PR with no issue chips whose mergeability GitHub has not computed yet), so an approved PR does not drop into another group for a cycle after a restart or a base branch move. Only the author can act.
1. **Waiting on author** (`waitingOnAuthor`): any of Conflicts, CI failing, CI not run, or Changes requested with no commits since the latest changes-requested review. A PR here still shows the Requested of you flag when it applies.
1. **Your move** (`yourMove`): anything left that is not a draft: the viewer is requested, has never reviewed it, or it has commits since the viewer's latest review.
1. Others' drafts are hidden in v1 (none occurred in practice); revisit if they matter.

Within a group, the default (attention) order is: flags first (Re-review, then Requested of you), then most recent activity first.

### Mine groups and stage

| Group | Stage | Rule |
| --- | --- | --- |
| Changes requested | changesRequested | not a draft, `reviewDecision == CHANGES_REQUESTED`, and not yet answered (below) |
| Ready to merge | approved | merge state `ready`, or merge state `checking` with `reviewDecision == APPROVED` (as in Others' Ready to merge, above); the Yours ready to merge tile counts this group |
| Awaiting review | reReviewRequested or updatedNotRequested | not a draft, `reviewDecision == CHANGES_REQUESTED`, and answered (below) |
| Awaiting review | awaitingReview or approved | any other non-draft PR |
| Drafts | draft | `isDraft`; collapsed by default |

A changes request is answered once the viewer has acted on it, so it stops reading as the viewer's move and waits on its reviewers instead:

- **Re-review requested** (`reReviewRequested`): every reviewer whose latest review is `CHANGES_REQUESTED` is in `reviewRequests` again. A pending request means it was made after that review, since submitting a review clears it. A team request does not count. With one reviewer this is simply that reviewer re-requested.
- **Updated · re-review not requested** (`updatedNotRequested`): otherwise, commits landed after the latest changes-requested review: that review's `commit.oid` differs from `headRefOid`, or, when its commit is null, the head commit's `committedDate` is later than its `submittedAt`. This is the same test as Others' Waiting on author.

Re-review requested wins when both hold. An answered PR keeps the Changes requested issue chip, since that is still GitHub's review decision, and keeps `changesRequested` on its row; its reviewer pip shows ✗ after a push and, under the reviewer pip rule above, ○ once re-requested. It sorts with Awaiting review.

The Changes requested group drives the red call-out banner above the Mine table: one line per PR, "<reviewer> requested changes on #n · <age>", the title, and the self-review state, with "Open review" (the PR's review URL; both links open in a new tab, like every GitHub link, section 6) and, in phase 2, "Open agent" (the drawer, which works with the Agent column off) and, from P2.6, "Fix session" (the drawer with the Fix session's confirmation already open; section 8, Drawer), shown while the row's `agent.starts` offers a Fix session. Answered PRs are not in the group, so they leave the banner, and the banner disappears when none remain.

### Self-review detection (Mine only)

1. Look in `reportsDir` for `PR-<number>.md`; if absent, for the branch-named report: the head branch with every character that is not alphanumeric, `-` or `_` replaced by `-`, runs of `-` collapsed, plus `.md`.
1. Parse the first line matching `Reviewed commit:`; it carries the branch and a short SHA in backticks. Extract the SHA.
1. **Current** when the SHA is a prefix of `headRefOid`; **Stale** otherwise, displayed as `<reviewedSha> → <headShort>`; **None** when no report exists.
1. **Tandem** when sibling files `PR-<number>-<suffix>.md` (any suffix) exist next to the report.
1. Read only the first 20 lines; never display report contents in v1.

A fix report (`FIX-<number>.md`, P2.6) never counts as a self-review, even for a branch whose report name it would be.

v1 detects self-reviews from these files, as built. Section 10, Report storage, proposes moving detection to Pit View's database, with `reportsDir` kept as a legacy import source during the transition.

### Last activity

The most recent of: commits (pushed), reviews (approved, requested changes, commented), issue comments, review requests, ready-for-review or draft conversion, title edits, force pushes. Text is "<actor alias> <verb>", for example "Alex pushed 3 commits" (consecutive commits by one actor merge into one count), "You requested changes", "Sam approved", "Alex edited the title". A commit's actor is its author's login, or the author's name when no user is linked, with a trailing `[bot]` removed, so a bot's commits name it the way its other events do. The age is relative: `34m`, `16h`, `4d`, using minutes under an hour, hours under a day, days otherwise.

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
- Range-day calculations must read twelve hours inside each range end, so DST days and `todayStartsAt: utc` name the right dates.
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

1. **Header**: logo and "Pit View"; repo selector button; "viewing as" avatar and login; sync status ("updated 38s ago · every 5m"; "refreshing · 12 of 30" while a cycle runs; "offline · cached 10:02 AM" in amber after a failed cycle; "paused · updated 4m ago" while this page is paused; "idle · updated 2h ago" while it is idle and not paused); the page-search field (Page search, below); in phase 4, the auto-review indicator (section 10); refresh button; pause button; theme toggle; settings link. The header is sticky, here and on the Settings page alike: it stays pinned to the top of the window while the page scrolls, on the `surface` token's solid background, and gets a bottom line (`line`) and a soft `shadow` only once content has scrolled under it. While the latest cycle failed because GitHub was out of reach (the sync status's "offline"), an amber "Offline" badge sits beside the brand, after any instance badge; at phone width it shrinks to the amber no-signal glyph the offline banner uses. It comes and goes with the banner, but only for that cause: sign-in, rate-limit, interrupted and other failures leave it off. It is `aria-hidden`, since the sync status already says offline in words. As built (U1), `public/sticky.ts` does the measuring without a scroll listener: an `IntersectionObserver` on a 1px marker at the top of the page sets `data-scrolled` on the header, and a `ResizeObserver` keeps the header's height, which grows as it wraps at narrow widths, in `--header-height` on the root element. Everything inside `main` takes that height plus 8px as its `scroll-margin-top` (56px plus 8px before the script runs; a Settings card jumped to keeps 16px instead of 8px), so a focused element, an in-page anchor's target or a field the error summary focuses lands below the header rather than under it. It is a margin on the content rather than `scroll-padding-top` on the page, because padding would also apply to the header's own controls and make Tab into them jump the page. The line and shadow are both drawn as `box-shadow`, so the header's height never changes when they appear. Layers, lowest first: the page, the header, the hover card, the skip link, so the hover card always covers the header and the focused skip link shows above it. At phone width the header's gaps tighten to 8px and its spacer drops out, so it usually wraps to three lines rather than four. Its markup gains only `id="site-header"` and the badge; its focus order and the sync status's live region are unchanged.
1. **Offline banner** (only when the latest cycle failed): amber strip, "Can't reach GitHub. Showing cached data from <time> (<age> old)." plus "Ages, CI and merge states may be out of date. Retrying every <interval>." While this page is paused, the second sentence ends "Updates are paused; Refresh retries once." instead. `<time>` is the oldest fetch time among the rows and sections shown. When the cycle failed partway, the first sentence reads "Refresh stopped partway: <n> of <m> PRs updated; the rest show cached data from <time> (<age> old)." As built (M11), the opening clause and the header's word follow `cycle.errorKind`: unreachable reads as above ("offline"); `auth` reads "GitHub did not accept gh's sign-in" ("sign-in failed") and adds "Check it with gh auth status in a terminal." before the retry sentence; `rateLimit` reads "GitHub's rate limit stopped the refresh" ("rate-limited"); `interrupted` reads "The last refresh stopped when Pit View did" ("interrupted"); any other kind reads "The refresh failed (<error>)" ("refresh failed"). A failure recorded without a kind reads as unreachable. The banner disappears while a retry cycle runs, since only the latest cycle counts. It sits just below the header and is not pinned: it scrolls away under the header, whose sync status and Offline badge keep saying so. The offline banner has `role="status"` and `aria-live="off"`.
1. **Summary tiles**, five, in a wrapping grid: Your move (blue number), Changes requested on yours (a red card with a red number while the Changes requested group holds any PR; at 0 a plain card with a gray number), Yours ready to merge (green number), Waiting on author (gray number), Closed today (purple number; subtext "<n> yesterday · <m> merged, <c> closed", or "Fri–Sun*" on Mondays).
1. **Mine** section.
1. **Others'** section.
1. **Closed** section.

### Loading and live updates

- The page renders the moment `/api/view` answers, from the cache, with whatever it holds. It never shows a page-wide spinner and never waits for GitHub.
- With an empty cache (first run), each section in state `loading` shows three placeholder rows and "Loading from GitHub…"; if that first cycle fails, the placeholders give way to "No cached data yet" under the offline banner.
- With a paused first load and no cycle running, placeholders give way to "No cached data yet".
- Patches update elements in place: a row's cells, a tile's number, a section's counts, the header's sync status. A row whose `group` changes moves to its new group; a removed row disappears. Filters and the current sort are reapplied to the affected table only. Keyboard focus and an open hover card stay with their PR by number across an update, and the scroll position is kept.
- Per-row freshness: a `stale` row shows an amber dot before its age, with the tooltip "cached <time>, refresh failed". A row's own refresh outranks this: while it runs the age is muted with the tooltip "cached <time>, refreshing this PR", and after it failed the amber dot reads "cached <time>, refreshing this PR failed: <cause>", the cause being "can't reach GitHub", "GitHub did not accept gh's sign-in; check it with gh auth status in a terminal", "GitHub's rate limit stopped it", or the error itself. A `pending` row looks normal unless its `fetchedAt` is older than `refreshSeconds`, in which case its age is muted and its tooltip reads "cached <time>, refreshing". A `current` row has no marker. A section that is `stale` shows the same amber dot in its heading.
- Cache times show the weekday whenever the cached time is not today.
- Tiles count what the tables hold, so a tile always agrees with its section, whatever the rows' freshness.

### Polling, visibility, pause and idle

- The page reports its state to the server (section 3): it opens the event stream with its client id and current state, then sends `POST /api/clients/<id>` on every `visibilitychange` and every Pause or Resume. The page itself never polls; it only says whether it is looking.
- Returning to a hidden page shows what it already holds at once; the server refreshes only when the data is older than 30 seconds, and the patches update the page in place.
- **A reload keeps the schedule.** The page keeps the start of the newest cycle it has seen (`sync.cycle.startedAt`, of any trigger, which is what the interval counts from) in `localStorage` as `pit-view.lastUpdate`, and sends it as `lastUpdate` whenever it opens its event stream. While that is under `refreshSeconds` old, opening the page does not refresh: it shows the cache and the next cycle comes when the schedule says, "updated 2m ago · every 5m" carrying on as before the reload. Once it is older, the schedule is due and the page refreshes on arrival as before. A browser with nothing stored, or storage that is blocked (reads and writes are wrapped in try/catch), falls back to the 30-second rule. Being `localStorage`, the time is shared by every tab of the instance's origin, so opening another tab keeps the schedule too. As built, `public/schedule.ts` reads and writes it and `public/app.ts` writes it after each frame, only when it changed.
- **Pause is per page.** It pauses polling for the current interface only: this page stops counting as active, and it does not pause other tabs, the server, or phase 4's auto-review. When every page is paused or hidden, the server stops polling, since nothing is active. A paused page keeps its event stream and still applies the patches other triggers produce (another active tab, its own Refresh, auto-review), because showing newer cached data is never wrong; it just stops asking for them.
- The pause button sits immediately after the refresh button: an icon button with `aria-pressed`, labeled "Pause updates" when off and "Resume updates" when on. Pausing changes the sync status to "paused · updated <age> ago", the age being since the last successful cycle. Resuming makes the page active again, which refreshes under the 30-second rule.
- Refresh still works while paused, as a one-shot: it runs one cycle, the status shows "refreshing · 12 of 30" during it and returns to "paused · updated just now", and the page stays paused.
- A paused page whose latest cycle failed reads "paused · offline · cached <time>".
- The paused state is kept in `sessionStorage` (wrapped in try/catch; it defaults to unpaused when storage is unavailable), so reloading the tab keeps it paused while a new tab starts unpaused.
- While paused, a row whose `fetchedAt` is older than `refreshSeconds` gets the muted age of a `pending` row, with the tooltip "cached <time>, paused".
- **Idle is per page, like pause.** The page watches for user activity (pointer down and move, keys, wheel and scroll, touch, focus, and becoming visible) and, after `idleMinutes` with none, reports itself idle (`idle: true` beside `visible` and `paused`), so a visible tab left open overnight stops counting as active and the server stops polling for it. Any activity clears idle at once and reports it; the page is then active again, and the server's `active` rule refreshes it when the data is older than 30 seconds. `idleMinutes` of 0 turns idle off. As built, the countdown runs in `public/idle.ts` (pure apart from injected time): activity only records its time, one timer aims at the moment the page would go idle and re-aims when activity moved it, and only entering and leaving idle are posted, so mouse movement costs a clock read and never a request.
- Idle reads apart from paused: the sync status is "idle · updated <age> ago" (in the normal tone, since the page is not stopped by choice), or "idle · offline · cached <time>" after a failed cycle, and "refreshing · 12 of 30" while a cycle runs. When the page is both paused and idle, pause wins and the status reads as paused. The offline banner, the row and section markers and the tables' loading states are unaffected by idle.
- Idle is never persisted: a reload starts active, whatever the page was. It does not affect the row Refresh buttons, the header's Refresh (a click is activity anyway, so it also ends idle), or phase 4's auto-review scheduler, which keeps its own clock (section 10). A page open in a hidden tab keeps counting down; returning to it is activity and ends idle.

### Theme

- A single tri-state icon button in the header, immediately to the left of the Settings gear, and the same toggle in the Settings page's header. Each click cycles System (the default) → Light → Dark → System.
- Its icon shows the current state (a half-filled circle for System, a sun for Light, a moon for Dark), drawn as inline stroke SVGs like the header's other icons and marked `aria-hidden`; its `aria-label` and tooltip say the current state and what a click does, for example "Theme: System. Switch to light".
- It sets `color-scheme` on the root element (`light dark`, `light` or `dark`). Every color is a `light-dark()` token, so no token changes. The choice is kept per browser in `localStorage` (wrapped in try/catch; System removes the key, and unavailable storage means System), applied before first paint by a small inline script at the top of each page's `head` that `public/theme.ts` mirrors, and followed by other open tabs through the `storage` event.

### Summary tiles are filter presets

Each tile is a button (`aria-pressed`). Clicking one clears all filters, opens its target section, collapses the other two sections and applies its filter:

| Tile | Section | Filter |
| --- | --- | --- |
| Your move | Others' | Status = Your move |
| Changes requested on yours | Mine | Status = Changes requested |
| Yours ready to merge | Mine | Status = Ready to merge |
| Waiting on author | Others' | Status = Waiting on author |
| Closed today | Closed | range = Today |

The active tile gets a 2px ink border and its subtext reads "showing only these · click to show all". Clicking the active tile clears all filters and reopens all three sections. Changing any filter by hand releases the tile (it becomes inactive, the filters stay). A patch never releases a tile; the filtered table simply updates.

Filters, sort, grouping and the active tile live in memory only and are not persisted across a reload. Changing the Closed Today / Yesterday range also releases the active tile.

### Sections

Each section heading is a disclosure button (chevron rotates, `aria-expanded`) that collapses the whole section. The heading shows counts ("12 open · 4 drafts").

Each table has a filter bar, a column header row, then rows (grouped or flat):

- **Filter bar**: text search (title or number, a leading `#` ignored), per-table selects, a "Group by status" checkbox (Mine and Others'), a count ("12 PRs" or "3 of 12 shown"), and a Clear button when any filter is set.
  - Mine selects: Status (any, Changes requested, Ready to merge, Awaiting review, Drafts); Issues (any, none, Changes requested, Conflicts, CI failing); Self-review (any, Current, Stale, None); Merge (any, Ready, Not ready). The Status select is what the Changes requested and Yours ready to merge tiles set: an answered PR keeps its Changes requested chip but has left that group, and an approved PR GitHub is still checking is in Ready to merge with merge state Checking, which Merge = Ready leaves out (section 5).
  - Others' selects: Status (any, Your move, Ready to merge, Waiting on author, Dependabot); Author (all, then each alias seen); Issues (any, none, Changes requested, Conflicts, CI failing, CI running); Merge (any, Ready, Needs review, Blocked).
  - Closed selects: Author (all, then each alias); Outcome (all, Merged, Closed unmerged). Closed also has a Today / Yesterday segmented control in its heading, with the range summary ("Mon Oct 26 · 10 merged, 3 closed unmerged").
- **Sorting**: every column header is a button. First click sorts ascending (arrow ↑), second descending (↓), third returns to attention order. Sorting applies within groups when grouped, across all rows when not. Sort keys: PR number; title; author alias; review (flags first, then reviewed, then unreviewed; Mine: changes requested, then awaiting with re-review requested and updated, then approved, then draft); self-review (stale, none, current); issues (more issues first); last activity (most recent first ascending); merge (ready, needs review, blocked, draft); Closed time by `closedAt`; Ticket by its first label, ticketless rows last.
- **Group headers**: label (colored per group), count, one-line explanation, and for collapsible groups (Mine Drafts, Others' bots) a Show n / Hide button. Bot groups also carry a "Run sweep" action in phase 2. Collapsible groups open automatically while any filter is set. Empty groups are hidden; when every group is empty the table says "No PRs match these filters."

### Page search

The header has one page-search field. It searches Mine, Others', Closed and the changes-requested banner by PR number, title, author alias or login, branch and ticket; a leading `#` in the PR-number query is ignored. Matching rows remain visible and nonmatching rows hide. Each section heading shows `n of m`, a section with no page-search match says so, and matching text is highlighted. Escape and a clear button empty the field, and `/` focuses it when no field has focus. A collapsed section opens when it holds a page-search match. Still to settle before it is built, with these proposals: the field applies on top of each table's own text search and filters, and a tile preset clears it like any other filter; and the field lives in memory only, like the filters, so it does not survive a reload.

### Columns

Mine: PR · Title · Review (stage label plus reviewer pips) · Self-review (state, and `at <sha>` or `<old> → <head>`, plus "· tandem") · Issues · Last activity (age, then text) · Merge · Agent (phase 2).

Others': Author (avatar and alias) · PR · Title (plus `stack n/m` chip) · Review (flags, reviewer pips, or "no reviews yet") · Issues · Last activity · Merge · Agent (phase 2).

Closed: Outcome (Merged or Closed chip) · PR · Ticket (only when any row in the range has one, a no-ticket marker counting as one) · Title · Author · Closed by · When.

Open PRs do not get a ticket column; their tickets appear in the title's hover. Rows in Mine's Changes requested group get the faint `red-row` background.

Every server-supplied URL the page turns into a link or an image (the PR and banner links, the CI job and ticket chips, a run's `posted.url`, avatars) goes through `public/safeurl.ts`, which passes only absolute http and https URLs (avatars also accept `/api/avatar/<login>`) and otherwise shows plain text; a test scans `public/` for any link or image that bypasses it. Every link to GitHub or a ticket system opens in a new tab (`target="_blank"`, `rel="noopener"`), so the dashboard's own tab never navigates away: the PR number in all three tables, the banner's `#n` and Open review, a CI failing chip's job link, and ticket and linked-issue chips, in rows and in the hover card. As built, they spread the `newTab` attributes from `public/dom.ts`, and a static test fails on any other link the page builds unless its `href` starts with `#` or `/`. Links within the app, such as Settings and the repository button, open in place.

Both open tables end with a narrow Refresh column (52px, its header named for screen readers only) holding one icon button per row, so revealing it never moves another column. The button refreshes that PR alone (`POST /api/prs/<number>/refresh`), paused or not. Its accessible name is "Refresh #<n>", or "Refreshing #<n>" with `aria-busy` while it runs. It is faded out (opacity, never `display` or `visibility`) until its row is hovered or holds focus, so it stays in the tab order and the accessibility tree; it stays shown while its PR is refreshing (the icon spins, unless reduced motion is asked for) or after a failure (amber, its tooltip naming the cause), and always on screens without hover. Focus stays on it across the patches that rebuild it, by its `data-focus` within the row. Closed rows have no button: they come from the closed search, which a one-PR refresh does not touch. The hover card is unchanged and has no refresh control.

The Agent column, as built in P2.4 and reshaped by P2.5 (`public/agent.ts`, pure, and `agentcell.ts`), sits before the Refresh column at 196px in both open tables while `showAgentColumn` is on, and draws the row's `agent` exactly as the server sends it (section 8, Agent cell); it derives no state of its own, so a done cell whose PR has moved on simply arrives idle. Since P2.5 the cell is a display with one button that opens the drawer (section 8, Drawer); starting, Stop and the resume command all live there.

- **Idle**: a dashed button in the link color with the action's label (Review, Re-review, Self-review), named "Review #101: open agent" for screen readers, opening the drawer, and "last review 7d ago" under it when `lastReviewAt` is set.
- **Running**: one button named "Open agent for #101, <label> running": a blue dot, the run's label, then "running 3m · last step 20s ago · <sha>" ("· starting" before the first step), with the newest step ("Step: review, started") as its tooltip and as screen-reader text. A one-second page timer rewrites only the elements marked `data-agent-timer` from their `data-started` and `data-step-at`; it never redraws a table.
- **Done**: one button named "Open agent for #101, <text>": the server's `text`, colored by what comes next (red for Changes requested and failures, amber for Needs your answer, Clean · CI failed, post failed and a fix's "Not pushed" texts, gray for Stopped, Done and Nothing to fix, green otherwise, a fix's "Fixed · pushed" included), then "finished 17h ago". A running Fix session's step tooltip uses the fix step names ("Step: triage, started"). The question, the failure note and the resume command are shown in the drawer, not in the cell; the cell offers no Stop, Copy or Run again.
- **Stable cells**: a cell's signature leaves out every text that moves with the clock and a running cell's step, and those are set in place after each draw, so a button is never replaced under the pointer or the keyboard while its state holds. Focus on an Agent button that a state change replaces moves to the cell's new button (Review becomes Stop, Stop becomes Run again or Copy), or to the PR link when the cell has none.
- **Opening**: the cell button and the banner's "Open agent" button open the drawer for that PR; neither starts anything. The banner's "Fix session" button (from P2.6, named "Fix session for #101") opens the drawer with the Fix session's confirmation already open and focus on its Cancel; when the start is unavailable it opens the drawer without one, and the drawer shows the reason. Starting always goes through the drawer's inline confirmation (section 8, Drawer), and closing the drawer returns focus to whichever button opened it.
- **Announcements**: a separate polite live region says "#101: Review started" and "#101: Review finished: Changes requested" once per change of a row's run, state and status, never per timer tick, nothing for what the page showed when it loaded, and nothing when a done cell returns to idle; a copied resume command is announced there too, and the announcements also run while the drawer is open with the Agent column off.
- **Colors**: only tokens; the dashed border and text are `blue-fg`. The contrast test lists the cell's, the drawer's and the report panel's pairs in both schemes, and since P2.6 the Fix session confirmation's (`amber-fg`, `red-fg`, `muted` and `ink` on `amber-bg`, and `on-amber-button` on the new `amber-button`). The modal dialog and its `backdrop` token are gone with P2.5.

### Hover card

On hovering a PR number or title (and on keyboard focus of the PR link): full title; `head → base`; author login; "opened <age> ago"; `+additions −deletions · n files`; head short SHA; tickets as linked chips; and, when the row is not `current`, "cached <time>". Nothing from the body.

### Settings page

Sections: Repository and viewer (two text fields; viewer notes it defaults to the gh login and uses gh's token); People (table of login, alias, initials, avatar mode select, live preview with color swatch; "+ Add person"; note that unlisted people get their GitHub avatar); Tickets (table of systems with on/off, kind select, source, key pattern, link template, sample chip; "+ Add ticket system"; note on where patterns look); Behavior (refresh interval offering 60 seconds, 2 minutes, and "5 minutes (default)", smallest first, with 5 minutes selected by default, noted as applying only while a page is open, visible, not paused, and not idle; stop when idle after, in minutes; "Today" starts at; bots list; self-review reports folder); Notifications (section 9); in phase 4, Auto-review (section 10). The config file path is shown in the page header.

As built (M10), at `/settings.html` (`public/settings.html`, `settings.ts`, and the pure `settings-form.ts`):

- Header: a link back to the dashboard, the title, the config path written with `~`, and the theme toggle. The dashboard's repo button links to `#repository`, which focuses the Repository field.
- People rows: login, alias, initials, avatar mode (Initials, GitHub avatar, Image file with a path under `~`), color (a color input), a preview drawn with the dashboard's own avatar (an image file shows only once saved at that path, since the server serves only the saved one; until then the initials show), and Remove. For an Image file that has not been saved, the preview must never ask the server for it; it shows the initials until the path is saved. Person colors are config data and reach the page only as the `--person` custom property, the one exception to tokens-only colors; a new person gets a color computed from the login and darkened until white initials reach 4.5:1. A "Seen in PRs, not listed yet" list shows `GET /api/people/suggestions` less anyone already in the form; clicking one adds a row with a guessed alias and the dashboard's default initials.
- Ticket rows: On, kind, name, where tickets are found, key pattern (disabled for linked issues), base URL, link template, a "Shows as" sample, and Remove. Changing the kind fills in that kind's defaults only over fields still empty or holding the old kind's defaults. The sample is the chip the dashboard would show for the first cached open PR title, then branch, then cached closed PR title (added in M11, since a repository's open PRs may carry no keys at all), the pattern matches, falling back to invented example keys, with the link it would carry as its tooltip.
- Behavior also holds row density, the Agent column switch, and "Stop when idle after", a number field for `idleMinutes` (0 for never, otherwise 5 to 1440 minutes, checked on the page and by the server). After a save, an open dashboard rereads it with density and applies it at once, counting from the last activity.
- Notifications (v3.3): a card after Behavior with one checkbox, "Notify me when a PR changes state", which is off unless the config says otherwise, and one checkbox per kind (section 9) with a one-line description, all ticked the first time notifications are turned on. The hint says that delivery happens on macOS only and that clicking a notification does not open anything. The kinds stay editable while notifications are off. Saving writes `notifications` only when the key was already in the file or the card differs from its default (off, every kind ticked); kinds are written in the page's order.
- Saving: the form sends only known keys (and carries over settings it does not edit: `allowedHosts`, `cloneDir`, and `agent`) through `PUT /api/config`. Checks run on Save and then follow every edit; each error sits under its field, which gets `aria-invalid` and an `aria-describedby` naming the hint and the error, and a focused summary above the form links to each field. A refusal from the server is placed on the field its path names, or shown in the summary when the form has no such field. A sticky save bar has the status line (`role="status"`), Discard changes and Save; `public/sticky.ts` keeps its height in `--save-bar-height`, and everything on the page except the bar itself takes that height plus 8px as its `scroll-margin-bottom`, so a field reached by Tab or by the error summary is never left behind the bar; a save that changes `repo`, `viewer`, `people`, `tickets`, or `bots` says the dashboard is refreshing. After a save the page posts on a `BroadcastChannel`, so an open dashboard rereads density, the Agent column, and `idleMinutes` at once; everything else reaches it as the save's patch. Leaving with unsaved changes asks first.

### Responsiveness and accessibility

- Tables sit in horizontally scrolling boxes with a minimum width (about 1180px for open PRs, 1000px for Closed); the header and tiles wrap at phone width, and the header stays pinned however many lines it wraps to.
- Use real buttons, links, inputs and labels; icon-only buttons have `aria-label`; decorative SVGs are `aria-hidden`.
- Text meets 4.5:1 contrast in both color schemes; colors that must be told apart also differ in lightness. Freshness is never shown by color alone: the stale dot has a tooltip and an accessible name.
- The changes-requested banner uses `role="alert"` only when it first appears, not on every patch.
- Header sync status is an `aria-live="polite"` region updated at most once per cycle (start and end), not per patch, once on each Pause or Resume, and once on entering and once on leaving idle.
- The pause button is a real `button` with `aria-pressed` and an `aria-label` that names the action ("Pause updates", "Resume updates"); the icon is `aria-hidden`.
- A sortable column's `th` carries `aria-sort`; the Closed Today / Yesterday control is a labeled button group whose buttons carry `aria-pressed`; and a tile, sortable header or group toggle that a patch or filter change rebuilds gets focus back.

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
- **idle**: a dashed button ("Review", "Re-review" or "Self-review"), with "last review 7d ago" under it when a report exists. The Fix session is never the idle action, even on an own PR with changes requested: it is started from the drawer, or from the changes-requested banner's "Fix session" button, which opens the drawer at its confirmation.

Agent state reaches the UI the same way as everything else: the row is upserted in a patch whenever a run's progress or result changes, so the cell and the drawer update in place. Runs are cached in a `runs` table (`id`, `repo`, `number`, `command`, `dir`, `started_at`, `last_step_at`, `finished_at`, `status`, `result`), so a reload or restart shows the last known state at once.

As built (P2.4, the server half; section 6, Columns, has the cell as the page draws it), `agentCell` in `src/launcher.ts` derives it from the PR, the config, the PR's latest run and, for own PRs, the self-review report:

```json
{
  "state": "done",
  "label": "Re-review",
  "action": { "kind": "reReview", "label": "Re-review", "command": "review-pr", "args": ["106"], "runner": "claude" },
  "lastReviewAt": "2026-10-24T16:02:00Z",
  "runId": 42, "runner": "claude", "command": "review-pr", "args": ["106"], "status": "done",
  "startedAt": "...", "lastStepAt": "...", "step": { "name": "post", "state": "done" }, "finishedAt": "...",
  "text": "Changes requested",
  "result": { "verdict": "changesRequested", "recommendation": null, "findings": 3, "ci": "green", "posted": { "form": "requestChanges", "url": "https://..." }, "notPostedReason": null, "report": "~/agents/output/PR-106.md" },
  "question": null, "note": null,
  "resume": "cd ~/dev/orbit && claude --resume 6f1c...", "costUsd": 0.74
}
```

- `state` is `running` while the latest run is; `done` while its outcome still stands (`done`, `failed`, `needsInput` or `stopped`); and `idle` with no run, or once the PR's head no longer starts with the SHA the latest run's `result.json` says it reviewed, since that outcome is then about an older commit and the next move is the idle action again. A finished run with no reviewed SHA (it failed or stopped first) stays `done`. An idle cell after a run still carries the run's fields, so the drawer can show it. A `review-stack` run is the exception: its `result.reviewed.sha` is the top layer's commit, which never matches a lower layer's head, so a finished stack run stays `done`.
- `label` is the run's own label, or the idle action's when `state` is `idle`. `action` is what Start does now: the row's default run with `agent.runner`. Own PRs: `review-pr <n> --no-post`, Self-review, also while changes requested are unanswered (the Fix session is a start of its own, never the default). Others' PRs: `review-pr <n>`, Re-review when the viewer has a latest review of it and Review otherwise. Dependabot's PRs (an author login containing `dependabot`): `review-dependabot <n>`, labeled the same way. Other bots' PRs (Renovate) get `review-pr`, since `review-dependabot` fails on a branch that is not Dependabot's.
- `lastReviewAt`: for own PRs the self-review report's modification time; for others' the `submittedAt` of the viewer's latest review. Null when there is none.
- `text`, for a finished run: the done-text mapping under the `review-result@1` table below ("Changes requested", "Approved", "Clean · CI failed", "Clean · mark ready?" only on the viewer's own draft, "Clean" otherwise, "Done" for a result with no verdict), with " · post failed" added when `notPostedReason` is `ghFailed`; "Needs your answer" for `needsInput`; "Stopped"; and "Failed · no result", "Failed · no report", "Failed · permission denied", "Failed · server restarted", "Failed · could not start", or plain "Failed" when the command's own `error` is the note. A fix run's texts are under the `fix-result@1` table below.
- `note`: why a run failed, as `<kind>` or `<kind>: <detail>` for Pit View's own kinds (`noResult`, `noReport`, `permissionDenied`, `serverRestarted`, `spawnFailed`, and since P2.6 `badResult` for a fix result that contradicts itself), or the command's `error` verbatim when `result.json` says `failed`. `question` is `result.json`'s question while the run waits for an answer. `result` is a summary of `review-result@1` (since P2.6 with `kind` `review`) or of `fix-result@1` (`kind` `fix`, its shape under the `fix-result@1` table below), and null for a sweep (P2.7 renders those).
- Patches: the launcher calls back on every change to a run's row (the start, each read of `events.jsonl` or the stream that changed something, the settle), and the poller emits one patch upserting just that row, with no tiles, counts or sync, through the same version counter as every other patch.
- P2.5 added three fields to the cell: `starts`, what the drawer's Start buttons can start now (default first): `{ "kind": "default" | "tandem" | "stack", "label" (the run's label while it is live: "Re-review", "Tandem re-review", "Review stack" and so on), "button" (the drawer's text: "Review PR", "Re-review PR", "Self-review", "Review in tandem", "Review stack"), "command", "args" (without `--emit-json`; an own PR's are `["104", "--tandem", "--no-post"]`), "runners" (`["claude", "codex"]`, or `["claude"]` for tandem), "posts": { "kind": "review" | "nothing" | "autoApprove" | "offer", "text" } (the sentence about what the run does on GitHub, with the viewer filled in, so the page derives none of it), "unavailable": null | "<reason>" }` (a run already in flight, or `cloneDir` unset; the server does not refuse on it, the launcher's own checks do); `steps`, the latest run's five slots, also while the cell is idle or done, all pending with no run; and `tandem`, whether the latest run was a tandem run. `action` is unchanged and is the default start.
- Step slots: `[ { "step": "resolveBase" | "review" | "consolidate" | "writeReport" | "post", "state": "pending" | "started" | "done" | "skipped", "at": "..." | null, "note": "..." | null } ]`, always five in that order, built by folding every `events.jsonl` line (the latest event per step wins, so a re-run step appended again replaces the earlier one) and stored in the run's `steps` column; a run pruned or recorded before schema version 5 reads as five pending slots. A change to a note alone changes the row, so it still patches. Tandem runs have no per-reviewer progress in this contract: the drawer shows the same bar, a Tandem tag and the newest step's note (P2.10 would extend the contract).
- P2.6 added the Fix session to `starts` (server half): `{ "kind": "fix", "label": "Fix session", "button": "Fix requested changes", "command": "fix-pr", "args": ["101"], "runners": ["claude"], "posts": { "kind": "push", "text": "Pushes new commits to fix/example on GitHub. It posts no replies or reviews, and stops to ask when a request needs judgment." }, "unavailable": null }`, listed last, on every one of the viewer's own open PRs (drafts included, changes requested or not, never a bot's), its text naming the PR's `headRef`; `posts.kind` gains `push`. `action` stays the default start. A fix run's `steps` are the same five slots, which `fix-pr` records with meanings of its own (the fix command, below); the server adds no step labels, and the page maps them by command.

### Drawer

As built in P2.5 (`public/drawer.ts`, with the pure view model in `drawerview.ts`, the server calls in `runapi.ts`). It opens from the right for one open PR (Mine or Others'), from the Agent cell or from the changes-requested banner's "Open agent" button; the drawer does not depend on `showAgentColumn`. It reads the live row from the feed, so patches update it in place without moving focus or scroll. It is `<aside role="dialog" aria-modal="false">`, labeled by its heading, and does not trap Tab. Contents, top to bottom:

- **Header**: the PR number (a link that opens in a new tab), author, full title, and `head → base · head <sha>` as far as the row carries them.
- **Start**: one button per `agent.starts` entry (Review PR, Review in tandem for Claude only, Review stack for a stacked PR, and since P2.6 Fix requested changes on the viewer's own PRs), a disabled one showing its `unavailable` reason as text. Choosing one opens an inline confirmation in the drawer, which replaced P2.4's modal: the PR title, the command as the runner receives it (`/review-pr 101 --tandem`, with `$` for Codex; Pit View adds `--emit-json`), a Runner choice only when `runners` has both (defaulting to `action.runner`, Claude for tandem), the entry's `posts.text`, and Cancel and Start, with Cancel taking focus first since the run may post. Start sends `POST /api/prs/<n>/runs` with `{ "kind", "runner" }` and the `X-Pit-View-Token` header. A refusal stays in the confirmation in a `role="alert"` line: the server's message as a sentence, "Reload the page to start runs: Pit View has restarted since this page loaded." for 403, "Pit View did not answer." when the request failed; never an `alert()`. While a request is on its way both buttons are disabled and Escape is ignored for it.
- **Fix session confirmation** (P2.6): visibly stronger than a review's, since it pushes. It has a caution treatment (an `amber-bg` panel with an `amber-edge` border, thicker on the left, and a warning mark in an `amber-fg` heading); the heading names the push, "Push fixes to fix/webhook-retry?", from the row's `headRef`; then the PR title, the command as the runner gets it (`/fix-pr 101`), the runner as plain text (Claude Code; `runners` is Claude only, so there is no choice), the start's `posts.text`, and a plain line, "It pushes new commits to fix/webhook-retry on GitHub under your account, and never force-pushes.", which the group's `aria-describedby` names. Its Start reads "Start fix session" ("Starting fix session…" while the request is on its way) on the `amber-button` fill, and Cancel takes focus first. Start sends `{ "kind": "fix" }` with no runner. Refusals show in the same `role="alert"` line as a review's.
- **Running card**: the label, a Tandem tag for tandem runs, "running 3m · last step 20s ago · <sha>", the five-step bar from `steps` (Resolve base, Review, Consolidate, Write report, Post for the review commands; Resolve, Triage, Fix and check, Write report, Push for `fix-pr`, chosen by the run's command, with the screen-reader list and the newest note's step named the same way; pending, started, done and skipped differ in mark and in words, with a text list for screen readers), the newest step's note, and two buttons. Stop asks "Stop the run on #101?" inline with the run's label, runner, live timer and the note that a throwaway worktree under `~/agents/worktrees/` may remain; Stop and open stops the run, and when the row settles shows the resume command, announces it and focuses Copy. The timers set only their own elements, and a button is never rebuilt under the pointer or the keyboard while its state holds. If tandem events carry `part`, the running card must show two lanes, one for `primary` and one for `secondary`.
- **Waiting card** for a run that ended `needsInput`: the question and the resume command with Copy (the clipboard, then a selected textarea, and when both are refused the command is announced). **Finished block** for a done, failed or stopped latest run: the cell's `text`, the failure note as a sentence (a small client map turns Pit View's note kinds into sentences and keeps the detail; the command's own `error` is shown as written), the finish age, the cost, and the resume command; an idle cell that still carries a run whose head has moved shows it as "Last run" with a "head has moved" note.
- **Fix finished block** (P2.6), for a run whose `result` has `kind` `fix`, in place of a review's facts: the cell's `text`; when it pushed, "Pushed to <branch>" and each commit as its short SHA and subject; Requests, the count and the non-zero triage counts in words ("3 requests: 2 clear, 1 out of scope", or "No requests to act on"); Outcome, the non-zero outcome counts ("2 fixed, 1 not fixed"); Checks, each command with "passed", "failed" or "not run"; a notice when `worktree` is set ("Commits not pushed are in <path>", or "Its worktree was left behind in <path>" when the push landed); and, when `report` is set, an "Open report" button that opens the report panel on the basename of `report` (only a Markdown file name is accepted), with focus returning to it when the panel closes. A fix run's "head has moved" note leaves out the advice to start a new review. A fix that stopped to ask gets the Waiting card as a review does: the question and the resume command with Copy.
- **Previous runs**: a compact list from `GET /api/prs/<n>/runs` (label, runner, outcome, started age, cost). The outcome text is a simplified client copy of the server's, without the own-draft case, and since P2.6 with the fix texts ("Fixed · pushed 2 commits", "Nothing to fix", the "Not pushed" texts, "Failed · push refused") kept in step with the server's.
- **Reports on disk**: from `GET /api/prs/<n>/reports`: name, age, short SHA, a verdict chip and a Tandem tag, each with an Open button that opens the report panel. A Fix session's report (`kind` `fix`, `FIX-<n>.md`) shows a Fix tag and no verdict chip or Tandem tag.

Runs are refetched when this row's run id, status, step or state changes, and reports when a run starts or ends. A PR that leaves the open tables keeps its last content with "#101 is no longer open" and disabled starts.

**Placement and focus**: at desktop widths the drawer (about 440px) and the report panel (about 560px, docked to the left of the drawer) sit below the sticky header, so Refresh, Pause and the theme toggle stay reachable; at 720px and under each is a full-screen overlay above the header, the report panel on top, with no horizontal page scroll. Layers: header 10, drawer 12, report panel 13, hover card 20, skip link 30; slide-in is 160ms and absent under reduced motion. Opening moves focus to the heading; Escape closes the report panel first (it has its own handler and a footer Close button, because key events inside the sandboxed iframe never reach the page), then a pending confirmation, then the drawer, and the page-level handler ignores a keystroke aimed at an input, textarea or select outside the panels so the filter boxes keep their native clear; and focus returns to the opener (the cell or banner button, or the PR link when it is gone), or to the report's Open button when the panel closes. A patch or a refetch never takes focus: focus moves only when it is already inside the drawer or on the page body, and never out of a field being typed in. A stop confirmation carries its run id and is dropped when that run ends or another replaces it. When a PR leaves the open tables mid-run, the drawer fetches its runs, rebuilds the card from the newest one and polls every 3 seconds until it ends, with Stop disabled until the runs have been read.

**Report panel** (`reportpanel.ts`, with the pure document builder in `reportview.ts`): a header with the report name, its age, a Rendered / Raw switch (two buttons with `aria-pressed`, Rendered by default, kept in memory) and Close. Rendered shows the server's `html` fragment in `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="...">` (section 3, Runtime dependencies); the page builds the document around it: a doctype, charset, a no-referrer meta, the CSP, a stylesheet whose colors and fonts are read from the page's own tokens through a probe element (so no color literal appears in the TypeScript; values that could close the style element or end a declaration are filtered, including backslashes, comment markers, `url(` and `@import`), and no script. A fragment's raw `<script>`, `<style>`, `<iframe>`, `<meta>`, `<base>` and similar openings are escaped again there as a second line of defense. A change of theme (`data-theme` or the color-scheme media query) rebuilds the document, which resets its scroll; the document is reassigned only when its built text changed. Raw shows the Markdown as text in a `<pre>`.

**As built (P2.6, browser)**: the Fix session in the page, within the decisions above.

- The changes-requested banner draws "Fix session" between "Open agent" and "Open review" while `fixStart(row.agent)` (`public/agent.ts`) finds a `fix` entry in `starts`, available or not; it carries `data-fix-session` and the focus key `banner-fix:<n>`, and `app.ts` opens the drawer with that opener and the start kind to ask. The drawer's `open` asks that start's confirmation only when the PR is open and the start available, so an unavailable one opens the drawer at its heading with the reason under the disabled Fix requested changes button. Escape then closes the confirmation first (focus to the drawer's Fix requested changes button) and the drawer second (focus back to the banner button), as for every confirmation.
- Step names come from `stepTitle(command, step)` in `public/agent.ts`, used by the bar, its screen-reader list, the newest note and the cell's step tooltip.
- `doneTone` reads a fix's texts: "Not pushed" and its variants amber, "Nothing to fix" gray, "Fixed · pushed" green, "Failed · push refused" red with the other failures.
- `drawerview.ts`'s `summaryOf` is the client copy of the server's result summary, for both kinds, used when the card is rebuilt from the runs list (a PR that left the open tables); `fixModel` turns a fix summary into the finished block's words, and `reportName` takes the report's basename.
- The reports list's signature now keeps each report's modification time, so a report rewritten under the same name (a second Fix session's `FIX-<n>.md`) rebuilds with its new age instead of keeping the old one.

### Machine-readable call and response from pit-crew's commands

Pit View needs to start a review the way an orchestrator starts a subagent: a fixed request in, progress it can observe, and a fixed response out. pit-crew's review commands gain this as an addition. A command invoked without it behaves exactly as today; a command invoked with it still does everything it does today, including writing its human-readable report and posting under its own rules, and additionally emits the machine-readable files.

- **The flag**: `--emit-json=<run-dir>` on `review-pr`, `review-stack`, `review-dependabot`, `review-dependabot-sweep` and `fix-pr`. `review-local` does not get it: Pit View never launches it (Launching runs, below). Pit View creates `<run-dir>` under `~/.local/state/pit-view/runs/<run-id>/` and passes its absolute path. Every other argument keeps its current grammar, so the request is an ordinary invocation that Pit View builds from the drawer's choices; the new flag is added to each prompt's argument grammar (Launching runs, below, Arguments).
- Before doing anything else, a command invoked with `--emit-json=<run-dir>` must verify that `<run-dir>` is an existing absolute directory.
- **Progress**: the command appends one JSON line to `<run-dir>/events.jsonl` each time a step starts, finishes or is skipped, and never rewrites a line: `{ "at": "<ISO 8601 UTC>", "step": "resolveBase" | "review" | "consolidate" | "writeReport" | "post", "state": "started" | "done" | "skipped", "note": "<text>" | null }`. These are the drawer's five steps, in that order. Each step records `started` then `done`, or a single `skipped` with the reason in `note` (no tandem, so nothing to consolidate; nothing to post, and why). A run that fails or stops to ask stops appending where it stopped. A note never names a model, provider or agent. If a real tandem run shows the shared progress is insufficient, the `--emit-json` contract must add `part` with value `primary` or `secondary` to the review step's events, and the review prompts that support `--tandem` must emit it. The no-model-names rule remains in force.
- **Response**: as its last act, after the report is written and after any post, the command writes `<run-dir>/result.json`. For a single review:

```json
{
  "schema": "pit-crew/review-result@1",
  "command": "review-pr",
  "status": "done",
  "target": { "repo": "owner/name", "pr": 101 },
  "reviewed": { "kind": "commit", "sha": "755b78b2c4e1f0a9d3b6e8c7a5f4d2e1b0c9a8f7" },
  "verdict": "changesRequested",
  "recommendation": null,
  "findings": [ { "priority": "P1", "summary": "Retry loop never backs off", "files": ["src/retry.ts"] } ],
  "ci": "green",
  "fixAttempts": 0,
  "posted": { "form": "requestChanges", "url": "https://github.com/owner/name/pull/101#pullrequestreview-1" },
  "notPostedReason": null,
  "report": "~/agents/output/PR-101.md",
  "question": null,
  "error": null
}
```

`pit-crew/review-result@1`, pinned in P2.1 (every field is always present, null when it does not apply):

| Field | Values |
| --- | --- |
| `schema` | `pit-crew/review-result@1` |
| `command` | `review-pr`, `review-stack` or `review-dependabot` |
| `status` | `done`, `failed` (with `error`) or `needsInput` (with `question`) |
| `target` | `{ "repo", "pr" }` for `review-pr` and `review-dependabot`; `{ "repo", "stack": [numbers, bottom to top], "top" }` for `review-stack` |
| `reviewed` | `{ "kind": "commit", "sha" }` with the full SHA the review read; null when the run stopped before reading anything |
| `verdict` | `changesRequested` (any P0, P1 or P2 finding) or `clean` (no findings, or P3 only); null when no report was written |
| `recommendation` | `review-dependabot` only: `approve`, `fixBeforeMerge`, `hold` or `doNotMerge`, the report's merge recommendation; otherwise null |
| `findings` | `[ { "priority": "P0" \| "P1" \| "P2" \| "P3", "summary", "files": [paths] } ]`, the report's summary index in the same order and count |
| `ci` | `green`, `failed`, `pending` or `none` (no checks configured), as the post's CI gate read it; null when CI was not read |
| `fixAttempts` | the report's `Fix attempts:` count, 0 when the line is absent |
| `posted` | `{ "form": "approve" \| "requestChanges" \| "comment", "url" }`, or null when nothing was posted |
| `notPostedReason` | null when posted; otherwise `noPost` (run with `--no-post`, which wins over every other reason), `ownPr` (the PR is the viewer's), `awaitingAnswer` (the run stopped to ask first, as `review-stack` does before posting) or `ghFailed` (the post failed; `status` stays `done` and the gh error is in `error`); also null when nothing was posted for another reason (the run failed first, no PR exists, or the owner declined the offer), which the `post` step's note or `error` names |
| `report` | the report's path, written with `~` |
| `question` | the question, when `status` is `needsInput` |
| `error` | what failed, when `status` is `failed` or the post failed |

The Agent cell's done text comes from `verdict` and `posted`: "Changes requested" for `changesRequested`; "Approved" for `clean` posted as `approve`; "Clean · CI failed" for `clean` posted as `comment`; "Clean · mark ready?" for `clean` on the viewer's own draft; "Clean" otherwise.

- **Stopping to say so is a failure, not a question**: a prompt's instruction to stop and say so with no question (no clone here, a branch with no PR, a closed Dependabot PR, a stack whose layers have diverged) ends the run as `failed`.
- **Stop-and-ask points stay stops**: wherever a prompt says to stop and ask (the one-attempt bound after a fix re-review, a tandem draft that fails its checks, an unreachable pinned SHA), a run with `--emit-json` stops there too and writes `result.json` with `"status": "needsInput"` and the question in `question`. It never answers its own question or picks a default. Pit View shows the question in the drawer; the viewer answers in the session or starts a new run.
- **The Dependabot sweep**: with `--emit-json`, the sweep still writes its Markdown summary to `~/agents/output/dependabot-sweep-<repo>-<YYYY-MM-DD>.md` and prints it, and additionally writes the same content as JSON to `<run-dir>/result.json`: `schema` `pit-crew/sweep-result@1`, `notPostedReason` (`null` when the sweep may post, `noPost` when it ran with `--no-post`), the first-line counts (`swept`, `fresh`, `reused`, `failed`), `rows` (one per PR, sorted by number, carrying the reviewer return structure's fields: `number`, `url`, `title`, `head`, `bump`, `recommendation`, `ci`, `findings`, `escalation`, `posted`, `report`, plus the table's `notes`), `mergeOrder` (the ordered actions, each with its `prs`), and `summary` (the Markdown file's path). The sweep writes `result.json` last, after its cleanup. Pit View renders this in the bot group's drawer instead of parsing the Markdown table. A sweep with nothing to sweep (no open Dependabot PRs, or none of the numbers given) ends `done` with every count 0, no rows and a null `summary`, not `failed`, so an idle repository never reads as a failure or gets retried.
- For `review-dependabot-sweep` with `--emit-json`, `resolveBase` covers preflight and enumeration; `review` covers sibling detection through the last reviewer return, including reuse, retries and escalated re-runs; `consolidate` covers synthesis and merge order and is recorded rather than skipped; `writeReport` covers the summary file; and `post` is always skipped because each PR's one post belongs to its reviewer and is reported in that row. The sweep must not pass `--emit-json` to a reviewer, and a repeated sweep must not carry the flag.

`pit-crew/sweep-result@1`, pinned in P2.1:

| Field | Values |
| --- | --- |
| `schema` | `pit-crew/sweep-result@1` |
| `command` | `review-dependabot-sweep` |
| `status` | `done`, `failed` (with `error`) or `needsInput` (with `question`); a sweep that finishes with some reviews failed is `done`, its failures counted and noted per row |
| `repo` | `owner/name` |
| `notPostedReason` | `null` when the sweep may post; `noPost` when it ran with `--no-post`. Always present, and named and valued as in `review-result`; no other reason applies to a sweep. A `result.json` written before the field existed lacks it, and Pit View reads a missing `notPostedReason` as `null` (for this schema and this field only); any other value is rejected |
| `counts` | `{ "swept", "fresh", "reused", "failed" }`, the summary's first line |
| `rows` | one per PR, by number: `{ "number", "url", "title", "head" (full SHA), "bump" (the return structure's `Bump` text), "recommendation" (as `review-result`), "ci" (as `review-result`), "findings" ([`{ "priority", "summary" }`], at most four), "escalation" (the trigger, or null), "posted" (as `review-result`; under `--no-post`, `null` unless the row is `reused`, in which case it is the post that already exists on the PR), "reused" (true when the row reused an unchanged report), "report", "notes" }` |
| `mergeOrder` | `[ { "action", "prs": [numbers] } ]`, the summary's Merge order and actions, in order |
| `summary` | the Markdown summary's path, written with `~` |
| `question`, `error` | as `review-result` |

A sweep stop is a failure. A sweep with nothing to sweep ends `done` with every count zero, no rows and a null summary.

- **The fix command**: `fix-pr <n>` (`prompts/fix/fix-pr.md`) acts on reviewers' requested changes on the viewer's own PR, P2.6's Fix session. It fails on anyone else's PR, a bot's, a fork's, or a closed or merged one. It also stops as `needsInput` before touching code when a local branch of the same name holds unpushed commits. A fix may only touch files in the PR's diff, plus a test file covering them. Suggested replies go in the report for the owner to post. It gathers every unresolved review thread (outdated ones marked) and each reviewer's standing change request, triages each, stops as `needsInput` before touching code when any request needs judgment, makes only the clear fixes in a throwaway worktree, runs the repo's checks once, and pushes new commits with `git push origin HEAD:<branch>`, its only GitHub write: no replies, no resolved threads, no re-requested review, no comments. Its report is `~/agents/output/FIX-<n>.md`. With `--emit-json` it records the same five steps with meanings of its own: `resolveBase` the PR, the clone, authorship and push-target checks and the base; `review` gathering and triage; `consolidate` the fixes and checks; `writeReport` the report; `post` the push. Nothing to fix skips `consolidate` and `post` and ends `done`; a failed or unrunnable check ends `needsInput` with the commits left unpushed in the named worktree; a refused push is `failed`. It writes `pit-crew/fix-result@1`.
- A fix command must never apply, check or push a suggestion from a reviewer outside the repository: it counts only comments from an `OWNER`, `MEMBER` or `COLLABORATOR`, or a bot, as requests, and code from a bot must never be applied as written. A change to a file tooling runs, including scripts, lockfiles, CI, hooks, build configuration or test configuration, must need judgment unless the owner's answer names that file. Fix commit messages must not contain `GH-<n>`. Every field-bearing `gh api` call must use `--method GET`. Dependencies must be installed in frozen mode immediately after the worktree is made. The unpushed local branch check must run before code changes and again after an answer. The command must check the push URL before pushing.

`pit-crew/fix-result@1`, pinned with `fix-pr` (every field is always present, null when it does not apply):

| Field | Values |
| --- | --- |
| `schema` | `pit-crew/fix-result@1` |
| `command` | `fix-pr` |
| `status` | `done` (pushed, nothing to fix, or the owner chose to discard the commits at a stop), `failed` (with `error`; a refused push included) or `needsInput` (with `question`) |
| `target` | `{ "repo", "pr", "branch" }`, the PR's head branch; null when the run stopped before resolving it |
| `head` | `{ "sha" }`, the full SHA of the PR head the run read and triaged against; null when the run stopped before reading it |
| `requests` | `[ { "id" (the thread's or review's node id), "kind": "thread" \| "review", "author", "path" (null for a review), "line" (the thread's line, or its original line when outdated; null for a review), "outdated", "url", "summary", "triage": "needsJudgment" \| "noChange" \| "disagree" \| "outOfScope" \| "clear", "outcome": "fixed" \| "notFixed" \| "awaitingAnswer", "commits": [full SHAs] } ]`, in the report's order; `fixed` means a commit answers it, pushed or not |
| `checks` | `[ { "name" (the command as run), "result": "passed" \| "failed" \| "notRun" } ]`; `[]` when nothing was fixed |
| `pushed` | `{ "branch", "head" (full SHA), "commits": [ { "sha", "subject" } ] }` when the push landed; otherwise null |
| `notPushedReason` | null when pushed; otherwise `nothingToFix`, `awaitingAnswer` (a stop to ask before touching code, or a fix needing a file outside its rules), `checksFailed`, `checksNotRun` or `pushFailed`; also null when the run failed before deciding the push |
| `worktree` | the worktree's path, written with `~`, when the run left one behind (unpushed commits, or a removal that refused); otherwise null |
| `report` | `~/agents/output/FIX-<n>.md`; null when none was written, as at a stop before touching code |
| `question`, `error` | as `review-result`; `error` also carries git's error for a refused push |

The Agent cell keeps a finished fix run `done` while the PR's head starts with `pushed.head` or `head.sha` when something was pushed (the cached row keeps the head the run read until the PR is next fetched), or with `head.sha` when nothing was, and returns to idle once the head is neither (As built, below). Two names differ from the shape first proposed for it: the read head is `head`, not `base`, since "base" already means the PR's base branch in this command and in `resolveBase`; and the reason field is `notPushedReason`, paired with `pushed` as `notPostedReason` is with `posted`. `requests` gained `outdated`, the triage gained `noChange` for requests the head already satisfies or that ask for no change, and the reasons gained `checksNotRun`.

As built (P2.6, server half), Pit View's reading of a fix result:

- **Result check**: a fix run's `result.json` must validate against `fix-result@1`: every field present; `command` `fix-pr`; `status` with its `question` or `error` as for the other schemas; `target` null or `{ repo, pr, branch }` with `pr` a positive integer; `head` null or `{ sha }`; each request's `kind`, `triage` and `outcome` exactly as pinned, `outdated` a boolean, `line` a positive integer or null, and `url` an absolute http or https URL, held to `posted.url`'s rule since the page may link it; `checks[].result` `passed`, `failed` or `notRun`; `pushed` null or `{ branch, head, commits }` with at least one commit; `notPushedReason` as pinned. Every SHA (`head.sha`, `pushed.head`, `pushed.commits[].sha`, `requests[].commits`) must be a full 40-character hex SHA. `notPushedReason` must be null when `pushed` is set. Anything else fails the run as `noResult`, with no result kept.
- **Consistency**: a fix result that passes the check but contradicts itself fails the run while keeping its `result`, so the drawer still shows what it found and pushed and the head rule below still applies, as a review's `noReport` does. Checked before the status, for every status: `report`, when not null, must have the basename `FIX-<target.pr>.md` (so a fix run can never point Open report at a review report, and a null `target` with a report fails), and `pushed.branch` must equal `target.branch`; either mismatch fails as `badResult` with the field in the note. Then, for `done` only: a result carrying neither `pushed` nor a `notPushedReason` fails as `badResult`; a null `report` fails as `noReport` ("result.json names no report"), since every way of finishing done writes one (a push, nothing to fix, commits discarded after a stop); and, as for reviews, a named report missing on disk fails as `noReport`. A null `report` is fine for `needsInput` and `failed`. The cell's summary carries `report` only when its basename is `FIX-<target.pr>.md`, and null otherwise.
- **Done until the head moves**: a finished fix run stays `done` while the PR's head starts with `pushed.head` or with `head.sha`, since the cached row keeps the head the run read until the PR is next fetched, and a run that has just pushed would otherwise read idle at once. When nothing was pushed, only `head.sha` applies. Once the head is neither, the cell is idle with the run still attached. A run whose `head` is null (it failed or stopped before reading it), or that left no valid result, stays `done`.
- **Done text**, in this order of precedence: "Stopped"; "Needs your answer" for any `needsInput`, whatever its reason; for `failed`, Pit View's own failure texts first ("Failed · no result", "Failed · no report", "Failed · bad result", "Failed · permission denied", "Failed · server restarted", "Failed · could not start"), then "Failed · push refused" for `pushFailed`, then plain "Failed" with the command's `error` as the note; for `done`:

| `done` with | Text |
| --- | --- |
| `pushed` set | "Fixed · pushed 2 commits", counting `pushed.commits` ("Fixed · pushed 1 commit" for one) |
| `nothingToFix` | "Nothing to fix" |
| `checksFailed` (the owner discarded the commits at the stop) | "Not pushed · checks failed" |
| `checksNotRun` (likewise) | "Not pushed · checks not run" |
| `awaitingAnswer` (discarded after a fix needed a file outside its rules) | "Not pushed" |
| `pushFailed` (outside the contract, which makes a refused push `failed`) | "Not pushed · push refused" |

- **Summary**: the cell's `result` for a fix run carries what the drawer shows without reading `result.json` again:

```json
{
  "kind": "fix",
  "requests": 3,
  "triage": { "needsJudgment": 0, "noChange": 0, "disagree": 0, "outOfScope": 1, "clear": 2 },
  "outcomes": { "fixed": 2, "notFixed": 1, "awaitingAnswer": 0 },
  "pushed": { "branch": "fix/example", "head": "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432", "count": 2, "commits": [ { "sha": "1a2b3c4", "subject": "Back off between retries" }, { "sha": "9f8e7d6", "subject": "Log the attempt number" } ] },
  "notPushedReason": null,
  "checks": [ { "name": "pnpm test", "result": "passed" } ],
  "worktree": null,
  "report": "~/agents/output/FIX-101.md"
}
```

Every triage and outcome key is always present, zero or not; `pushed` is null when nothing was pushed; `pushed.head` is the full SHA and each commit's `sha` its first seven characters; `notPushedReason`, `checks`, `worktree` and `report` are the result's own. The cell's `question` is the result's question while the run waits, as for reviews.

- **What the flag never changes**: the single permitted GitHub write per review and the sweep's list of things it must never do; writing the report to disk before posting it; the one-attempt bound; `review-pr` fixing only the viewer's own PR, confirmed with `gh api user`; `review-stack` never fixing. The no-attribution rules apply to the JSON exactly as to the Markdown: no model, provider or agent names, and escalation is reported by its trigger, not by which model ran.
- **Where it lives in pit-crew**: the shared contract (flag, file names, both schemas, the needs-input rule) goes in one new agent-agnostic prompt, `prompts/review/emit-json.md`, which each review prompt references when the flag is present, the way they reference `tandem.md` today. Each prompt adds the flag to its argument list and the step lines at its existing steps, without rewording its constraints. The wrappers in `commands/claude/` and `commands/skills/` change only their argument hints; agent-specific instructions stay out of the shared skills and prompts. Deploy with `scripts/deploy-reviews.sh --install` and run `git grep -I "$HOME" -- prompts commands bin` before committing.

### Launching runs

Decided with the owner in the P2.1 design session, from the installed commands, the deployed prompts and smoke tests of each runner. `src/launcher.ts` starts, watches and stops runs. It takes the runner, the command and its arguments, the working directory and the run directory as arguments and needs no page or drawer, so phase 4's scheduler calls it the same way (section 10).

- **Runners**: Claude Code (`claude`) and Codex (`codex`), two of the three agents pit-crew installs its commands for (the `agents=` registry in `scripts/deploy-reviews.sh`). Hermes is not driven. The new config key `agent` holds the default, `{ "runner": "claude" }` or `"codex"`, and the drawer can pick the other for a single run. Each runner is one entry in a table in `src/launcher.ts` saying how to build its command line, where its session id comes from and how to resume it, so adding Hermes later is one more entry.
- **Claude**: `claude -p --input-format stream-json --output-format stream-json --verbose --session-id <uuid> --permission-mode auto --add-dir ~/agents`, with the working directory as the process's cwd, since there is no cwd flag. The request, `/<command> <args> --emit-json=<run-dir>`, goes in as one JSON user message on stdin, and stdin stays open: a one-shot `-p` run exits when its turn ends and kills its background tasks, so a tandem primary waiting on its secondary's notification would end with no consolidation, while with stdin open the notification starts a new turn (smoke-tested). The launcher closes stdin once a `result` event arrives while no background task is outstanding (the latest `background_tasks_changed` event lists none), and the process then exits. Pit View generates the session id, so it is known before the run starts. `--bare` and `--safe-mode` are never passed: they drop the owner's sign-in or the installed commands. The stream's `system`/`init` event is not its first line (hook events come before it) and the `result` event is not always its last, so the launcher reads events by type, never by position.
- **Codex**: `codex exec --json [-m <agent.codexModel>] -C <cwd> -s workspace-write -c sandbox_workspace_write.network_access=true --add-dir <cwd>/.git --add-dir <reports folder> --add-dir <worktrees folder> '$<command> <args> --emit-json=<run-dir>' <note>`, a skill being named with `$`, not a slash. The read-only sandbox cannot write a report; workspace-write keeps `.git` read-only, so `git fetch` and `git worktree add` need `<cwd>/.git` added; `--add-dir` refuses a path with a symlink in it, so `~/agents/output` and `~/agents/worktrees` are passed resolved (`pwd -P`); and Codex's file patches are refused through the symlink even then, so the request ends with a note naming the reports folder's resolved path to write to. All of this was smoke-tested. The session id is the first event's `thread.started` `thread_id`. Codex reports no cost and no permission denials (a sandbox refusal shows only in a command's output), so its run is judged by its files alone. Codex cannot be a tandem primary, so the drawer offers Review in tandem only with Claude.
- **Model**: Claude uses the owner's own default. Codex uses the model in the owner's Codex config (now `gpt-6.1-terra`, as `bin/tandem-secondary` also pins), or the optional `agent.codexModel`, passed as `-m` when set. The override exists because a configured default can name a model the ChatGPT sign-in rejects, as `gpt-6-luna` did during P2.1's smoke tests, before Codex 0.165.0 and Terra 6.1.
- **Environment**: the child's environment is built from scratch rather than inherited: `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `TMPDIR` and the server's `PATH` (under the launch agent, the one captured at install). A server started from inside an agent session would otherwise pass on that session's `CLAUDE_*` and `ANTHROPIC_*` variables, and the smoke test's runs recorded themselves as the desktop app's; with a clean environment the runner signs in as usual and records itself as a headless run.
- **Permissions**: never bypassed. Claude runs in `auto` mode under the owner's own allow rules, plus `--add-dir ~/agents`. In `-p` a tool call that would ask is denied, so after the run the launcher reads `permission_denials` from the final `result` event, and when it is not empty fails the run as `permissionDenied`, naming the tools, even if `result.json` says done: a denied report write must never pass silently. Codex runs in the workspace-write sandbox above.
- **Identity**: before every start the launcher checks that `gh api user --jq .login` equals `viewer`, one GitHub call per start, because the commands post as whichever account `gh` is using and this machine holds more than one. A mismatch refuses the start, naming both logins. Phase 4's tick makes the same check.
- **Working directory**: manual runs work in `cloneDir`, the owner's clone of `repo`, which becomes a top-level config key shared with phase 4 (`autoReview.cloneDir` moves there). The commands that review a named target already do it in their own throwaway worktree under `~/agents/worktrees/`, so the clone is only the session's working directory, and Open session can always resume from it; P2.6's fix sessions work there too. Manual runs do not adopt phase 4's worktrees, which stay for unattended runs only (section 10, Worktrees).
- **Run directory**: `<state folder>/runs/<run-id>/`, so `~/.local/state/pit-view/runs/42/`, or under `pit-view-dev` for the dev instance. Pit View creates it before the start and passes its absolute path as `--emit-json`. It holds `request.json` (runner, command, arguments, cwd, session id, pid and start time), `stream.jsonl` (the runner's stdout), `stderr.log`, and the command's own `events.jsonl` and `result.json`. A run's folder is deleted with its `runs` row; the last 200 runs are kept.
- **Process and progress**: the runner is spawned detached in its own process group, with its output going to the files above (Claude's stdin as above; Codex's closed), so restarting the server does not end it. The launcher watches `events.jsonl` for steps (the drawer's "last step" is its newest line's `at`) and the process for its exit. The stream is kept for diagnosis and is never scraped for progress or results.
- **Outcome**: when the process exits, the run settles from `result.json` alone, checked against its schema: `done`, `failed` with `error`, or `needsInput` with `question`. A missing or invalid `result.json` (a `posted.url` that is not an absolute http or https URL is invalid, since the field becomes a link) fails the run as `noResult`, with the exit code and the stream's last event in its note. The exit code never decides an outcome by itself, and neither does the stream: a Claude run that ends by asking a question reports an ordinary successful `result`, so only `result.json`'s `needsInput` tells waiting from done. A `done` run whose `report` file does not exist fails as `noReport`.
- **Restart**: at server start, a run recorded as running whose process is still alive (the pid and start time in `request.json` match) is watched again. One whose process is gone settles from its `result.json` when there is one, and otherwise fails as `serverRestarted`, as in section 10.
- **Stop**: SIGTERM to the run's process group, then wait. Claude exits within a second and stops its own background tasks (smoke-tested). Claude runs each background command in a process group of its own, so a SIGKILL of the runner alone would orphan them: only if the runner is still alive after 10 seconds does the launcher list the run's descendants (`ps -A -o pid=,ppid=,pgid=`) and SIGKILL each of their process groups, the runner's last. The run settles as `stopped`. The command's throwaway worktree under `~/agents/worktrees/` may stay behind; Pit View never touches that folder, and the drawer says one may remain.
- **Open session**: the drawer shows the resume command with a Copy button, `cd <cwd> && claude --resume <session-id>`, or for Codex `cd <cwd> && codex resume <session-id>` followed by the run's model and sandbox flags, since a resumed Codex session does not keep them (smoke-tested). Claude resumes from any folder under the same id, but its tools then run in that folder, so the command starts with the run's own. Pit View opens no terminal. A session cannot be resumed while the headless process is still writing it, so on a running run the button reads Stop and open: it stops the run, then shows the command.
- **Concurrency**: one run per PR in flight, and one sweep per repository; a second Start for the same PR is refused while one runs. There is no overall cap, and manual runs never count against phase 4's `concurrency` or `dailyLimit`.
- **Closing questions**: a command's own closing question, such as `review-stack`'s offer to post, ends the run as `needsInput` like every other stop-and-ask point. The Waiting card shows it and the owner answers through Open session. No prompt changes for this.
- **Tandem**: the primary launches its secondary as a background task and waits for its notification, exactly as the prompts say; holding stdin open (Claude, above) is what lets that work, so Pit View never starts a secondary itself. Claude only.
- **No fixing from a review**: run headlessly, `review-pr` on the viewer's own PR and `review-local` both enter fix mode by themselves when a review has findings (the smoke test's `review-local` made its WIP commit and edited files unasked). So Pit View never launches `review-local`, and every `review-pr` it starts on the viewer's own PR passes `--no-post`, which also excludes fix mode (section 10, Posting); that part of the flag lands in P2.2 for `review-pr`, ahead of phase 4. Only P2.6's Fix session, started deliberately from the banner, omits it.
- **Cost**: each Claude session costs about $0.21 before it does any work (the smoke test's `review-local` on a small diff came to $0.68). `total_cost_usd` in a `result` event is the session's running total; the launcher keeps the last one in the run's row.
- **As built (P2.4)**: decided while building, within the decisions above.
  - The launcher (`createLauncher`) takes every outside dependency as an argument (spawn, a small fs, kill, a `ps` runner, a `git` runner, the gh runner, clock and timers, the environment, a session id maker); only `src/server.ts`'s `main` passes the real ones. Tests pass fakes, and one test spawns fake `claude` and `codex` executables from a temp `PATH`.
  - A start runs the identity check, then the clone check, then records the row (so its id names `runs/<id>/`), creates the folder, writes `request.json`, spawns, and rewrites `request.json` with the pid and its `ps -o lstart=` start time. A PR whose start is still between its checks and its row counts as in flight, so two quick clicks start one run.
  - The runner's stdout and stderr go straight to `stream.jsonl` and `stderr.log` as file descriptors, so nothing breaks when the server goes away. The launcher reads the folder's files from saved byte offsets, whole lines only, on every `fs.watch` event and on a timer (every 10 seconds as a safety net while the folder is watched, every second when it cannot be).
  - The stdin rule reads `background_tasks_changed` (a `system` event with that subtype, or an event of that type) and counts the tasks it lists in `tasks`, `background_tasks`, `backgroundTasks` or `data.tasks` whose `status` is not a finished one (`completed`, `failed`, `killed`, `stopped`, `canceled` and the like). That shape is not pinned by a smoke test, so it lives in one function, `outstandingTasks`, to correct if a real tandem run disagrees. A `result` event with none outstanding closes stdin; the request goes in as `{ "type": "user", "message": { "role": "user", "content": "/<command> <args> --emit-json=<run-dir>" } }`.
  - A server restart closes a Claude run's stdin with the server, so a run that outlives its server ends at the end of its current turn (a tandem primary still waiting on its secondary may end without consolidating); recovery then watches it to its end and settles it from its files.
  - Codex's request and note are one prompt argument, the note after a blank line, so the skill never reads the note as part of its target.
  - The resume command is stored with the run once its session id is known: at the start for Claude, at `thread.started` for Codex, with Codex's model and sandbox flags written with `~` where they are under home.
  - Settling: a stopped run is `stopped` whatever its files say; a spawn error is `spawnFailed`; then `permissionDenied`, then `serverRestarted` (no `result.json` and nobody saw the process end), then `noResult` (with the exit code or signal and the stream's newest line, clipped), then `result.json`'s own status, with `noReport` for a done result whose report (or a sweep's summary) is missing, and a sweep with nothing to sweep done without one.
  - Restart recovery at server start re-watches a run whose pid is alive with the start time `request.json` recorded, checking its liveness on the timer; any other running run is settled at once. It makes no GitHub call.
  - Stop signals the group (`-pid`) with SIGTERM; after 10 seconds, if the runner is alive, it walks `ps -A -o pid=,ppid=,pgid=` from the runner's pid and SIGKILLs each descendant's process group in the order found, the runner's own last. A process outside the runner's tree is never signaled.
  - Retention runs after each start: the newest 200 runs stay, a running one is never pruned, and a pruned run's directory is removed only if it resolves inside the instance's `runs/` folder.
- **As built (P2.6, server)**: the Fix session's start, within the decisions above.
  - `kind` `fix` on `POST /api/prs/<n>/runs` starts `fix-pr <n>` with `--emit-json` and never `--no-post`, labeled "Fix session". `offersFix` offers it only when the PR's author is the viewer and is neither a `Bot` actor nor a configured bot login, drafts included; the server refuses it on any other PR with 422 whatever the page sends, and the cell never makes it the default.
  - Codex with `fix` is 400, like tandem, and a fix start without a runner is Claude's whatever `agent.runner` says. The launcher refuses `fix-pr` with Codex itself too (`fixRunner`), as it refuses a tandem start (`tandemRunner`), so no caller gets around it.
  - The identity check (`gh api user`) and the clone check still run before the start, and one run per PR in flight holds across kinds. `fix-pr` confirms authorship again by itself.
  - `parseResult` accepts `pit-crew/fix-result@1` beside the other two schemas, under the check pinned with that table. `judge` then applies `fixMismatch`, the consistency rules pinned there, as `badResult`, a new Pit View failure kind ("Failed · bad result") that keeps the result; a done result's `report` is checked on disk as a review's is.
  - The `runs` table stores `result.json` as parsed text, so fix results need no new column and no schema change of their own.
  - Reports: `FIX-<n>.md` is listed and served as section 3 says, and `findReport` skips a fix report's name, so it never counts as a self-review.
  - `public/drawerview.ts` changed only so the type check passes: its facts list showed nothing for a fix summary, and the review summary it builds from a run carries `kind` `review`. The browser half (section 8, Drawer, "As built (P2.6, browser)") has since replaced that stopgap.
- **Arguments**: today only the sweep rejects an argument it does not know; `review-pr`, `review-local` and `review-stack` would read an unknown flag as part of their target, and the wrappers pass through everything but the tandem flags. P2.2 therefore adds `--emit-json`, and `--no-post` for `review-pr`, to each prompt's argument grammar and to what each wrapper strips from the target; the Dependabot commands accept `--no-post` too.
- A terse re-run carries `--no-post` but never `--emit-json`. A session continued after a `needsInput` stop keeps its run directory and writes `result.json` again at its new end. `--emit-json` must never be passed to a tandem secondary or to a sweep's reviewers. A repeated sweep must not carry the flag. The six wrappers must strip both flags from the target.

### Other phase 2 items

- Once stack reports are supported, `GET /api/prs/<n>/reports` lists the stack's report on every layer's drawer: `STACK-<top>.md`, where `<top>` is the top layer's number found through the row's `stack`, under the same `reportsDir` realpath containment checks as every other report.
- The bot group's "Run sweep" starts the Dependabot sweep command for the repo with `--emit-json`.
- Progress and results come from `events.jsonl` and `result.json`, not from scraping session output (Launching runs, above).
- Phase 4 (section 10) reuses this launcher, the `runs` table, the Agent cell and the drawer for unattended runs, so P2.1 keeps the launcher callable from the server with no page or drawer involved, under a manual start and, when the optional login agent is installed, from its environment (section 3, Hosting). The launcher takes the run's working directory as an argument, because phase 4 runs each command in its own worktree (section 10, Worktrees).
- `result.json` is also the proposed route by which report content reaches Pit View's database (section 10, Report storage); v1 and phase 2 still read reports from `reportsDir`.

### Relevancy command

Planned: a Relevancy start kind for the viewer's own PRs, offered in the drawer. It starts a dedicated pit-crew command with `--emit-json` and a result schema like `fix-pr`. The command checks the PR against the current base branch (`main` or `master`) and reports whether the PR is still necessary and whether it needs any updates. The design pass must decide whether it only reports or may also fix, how it relates to `fix-pr` and rebasing, what "still necessary" is judged against (the base's history since the PR's merge base, other merged PRs, linked tickets), and what the Agent cell and drawer show for each verdict.

## 9. v3: stacks, actions and notifications

v3 starts after v1 has been in daily use. Each item below is a decision on direction; its details are settled at the start of its milestone.

### Stacks grouped

- In Mine and Others', the PRs of one stack render together under a stack header row: a disclosure button (`aria-expanded`) with the stack's size, its top PR's title, and the most urgent issue and merge state among its members. Each stack is collapsible on its own.
- Expanded, the stack's PRs are listed by position, and each keeps its `stack n/m` chip, so a PR reads the same inside and outside the group.
- To revisit after v1, with real use: which status group a stack sits in when its members' groups differ (the most urgent member's is the starting proposal), whether stacks start collapsed, and how stack grouping interacts with sorting. The stack header is also the natural home for phase 2's Review stack.

### Direct actions

- Pit View gains a small set of explicit GitHub writes on the viewer's own PRs: merge (only when merge state is `ready`), mark ready for review, convert to draft, and request review (choosing from `people`). Others like re-running failed checks are considered at the same time. Whether any action extends to others' PRs is decided at the start of v3; commenting and approving stay out of scope.
- Each action is one viewer click followed by a confirmation naming the PR and the action, runs through `gh` with the viewer's own token, and is never automatic or batched. The result arrives the way everything else does: the server starts a targeted refresh of that PR and the updated row comes back as a patch.
- The endpoint is `POST /api/prs/<number>/actions` with `{ "action": "merge" | "markReady" | "convertToDraft" | "requestReview", ... }`. Because a loopback server that writes can be reached by any page in the browser, write endpoints require a same-origin `Origin` header and a per-start token embedded in the served page. The token itself was built in P2.4 for the run endpoints (section 3, HTTP API), so this milestone reuses it.

### Notifications

As built (v3.3). Off until the `notifications` key turns it on; nothing below happens, and no notification command is run, while it is absent or `enabled` is false.

- **Transitions.** A transition is a difference between a PR's previous and new cached state, so each fires once. `src/poller.ts` keeps, for the repo and viewer in effect, the state each open row was last compared in: taken from the cache when a cycle or a one-PR refresh starts, before any fetch changes it, and advanced at every comparison. A cycle compares only when it finishes without error; a one-PR refresh compares its own row when it succeeds. After a failed cycle nothing is compared, and the next good cycle compares against the same earlier state, so a transition is neither lost nor fired from rows the failed cycle left stale, but only while the same repository and viewer stay in effect and the server keeps running. The baseline lives in memory only, as a single baseline for the repo and viewer in effect: a server restart, a repository switch (switching back replaces it again), or a viewer change rebuilds it from the cache as it stands, silently, like a first load, so a transition that a failed cycle had already written to the cache before then is not notified. A row marked stale, in the new state, neither fires nor moves its stored state. After a saved config changes `repo` or `viewer`, the stored state is rebuilt from the cache when the next cycle or one-PR refresh starts.
- **What fires nothing.** The first load, which is derived from the baseline itself and never kept as a flag: a baseline with no rows is the first load. That is a repo with no successful cycle recorded or no open rows in the cache when it is built, and it is also an established baseline that has become empty because every row was removed. The first comparison that finds open rows records them as the baseline and fires nothing, and a one-PR refresh while the baseline is empty fires nothing either; cycles that leave the cache empty keep it silent. The viewer rule: while the configured viewer is empty and no local gh account has been found, so the viewer is not yet resolved, nothing is compared and nothing fires, because rows read differently as the viewer's and as someone else's; once the first cycle resolves the viewer, the first comparison is a baseline and fires nothing, the same first-load rule. An unchanged state fires nothing. A PR with no previous state, one that is new since the previous comparison, has no transition, so it fires nothing on arrival; its state is recorded, and only later changes to it fire. The consequence is that a PR which arrives already meeting a condition, such as one that already requests your review, does not notify on arrival. Opening Pit View after it has been closed for a while is a restart: the baseline is rebuilt from the cache as it stands, so it fires only for what changes after that.
- **Kinds** (the `kinds` values). Each fires when its condition turns true after being false:
  - `changesRequested`: a Mine row enters the Changes requested group (section 5), which an answered request (re-review requested, or pushed since) is not in.
  - `readyToMerge`: a Mine row's merge state becomes `ready`.
  - `reviewRequested`: an Others' row gains the "Requested of you" flag.
  - `ciFailing`: a Mine row gains the CI failing issue chip.
  - `runFinished`: a run this server is watching (below) settles as `done` or `failed`. A stopped run fires nothing, since the owner stopped it.
  - `runNeedsInput`: a run this server is watching settles as `needsInput`.
  - The two run kinds are decided by run id alone, with no baseline, no stored statuses, and no clock comparison. A run is watched by this server process when the launcher creates it here, including a run whose start fails at once (`spawnFailed`, section 8, Launching runs), which is created and settles in the same call, or when the launcher's startup recovery adopts a run that was still running. The launcher announces each such run to the poller (`runWatched`) before its first change report. A run found already settled in history, and a run recorded as running at startup whose process is gone and which recovery settles, are never watched, so history never fires: not at startup, not at a repository switch, and not from any later read of the cache.
  - When a watched run settles as `done` or `failed`, `runFinished` fires, and when it settles as `needsInput`, `runNeedsInput` fires, each once; a run that settles as `stopped` fires nothing. A run is forgotten as soon as it is seen settled, whatever its status, and a run id is never reused, so a run fires at most once and nothing fires for it again. The run is looked up by its id in the cache, not from the open row, and row freshness is ignored, since runs are local. A run that settles after its PR has left the open rows (closed, merged, or moved out of the fetched set) still notifies, and its notice names the PR by number alone, `#<number>`, because the row's title is no longer available; the Agent cell has no row to show it on, but the notification still reports the outcome.
  - A run belongs to the repository it was requested in, which its record holds, and it fires only if that repository is the one in effect when it settles; if another is in effect, it settles silently and is forgotten, and it does not fire later if the old repository is restored. The decision reads the configuration in effect at that moment, never the result of the asynchronous scan that follows a saved config, so a run in the new repository that settles while `configChanged` is still scanning fires once. Every run Pit View starts, phase 4's included, that is watched and settles as `done`, `failed`, or `needsInput` in the repository in effect produces exactly one notification of the matching kind.
- **Delivery.** `src/notify.ts` builds a notice: the title `Pit View`, the kind's headline as the subtitle (for example "Your PR is ready to merge"), and the body `#<number> <title>`, with control characters removed, whitespace collapsed, and at most 200 characters. The body always starts with `#`, so it can never read as an option. Delivery sits behind an injectable `Deliver` function: `startServer` takes it as an option and delivers nothing when it is left out, so no test fires a real notification, and only `main()` passes the real one. A delivery that throws or rejects is logged and never reaches the poller. Events are filtered by the `kinds` in effect when they are sent, so a saved change applies at once.
- **macOS.** The real `Deliver` runs the built-in `osascript` with `execFile` (no shell) and no dependency. The AppleScript is a constant three-line `on run argv` handler passed with `-e`; the title, subtitle, and body follow as arguments and the script reads them as `item 1`, `item 2`, and `item 3 of argv`, so no quote, backslash, or newline in a PR title can change what runs. A test checks that the script lines never contain the title and that the text arrives only as the last three arguments. On any other platform `Deliver` does nothing; Windows and Linux delivery is follow-up work.
- **Clicking a notification (a platform fact, checked by hand at the start of v3.3 on macOS 26.7.1 with Node 26.8.1; no test asserts it, since a click cannot be exercised headlessly).** `osascript`'s `display notification` takes only a title, a subtitle, a body, and a sound: it exposes no click handler, no action button, and no URL, and it posts the notification and returns at once. macOS attributes the notification to Script Editor, so a click activates Script Editor or does nothing and never reaches Pit View. This was checked by posting real "Pit View test" notifications on macOS, which showed that they post, that text with quotes and backslashes arrives intact through `argv`, and that the command exits 0. What a test does assert is that the delivery script is the constant `on run argv` handler using only `display notification` with the title, subtitle, and body, with no click, open, or URL machinery. Settled behavior: clicking a notification does nothing useful, and each notice carries the PR number and title so the owner can find the row. Making a click open the PR would need a native notifier (for example `terminal-notifier`, or a small signed helper app), which is a dependency or an architecture change this section does not take on; it is follow-up work, to be decided by the owner. The Settings hint says as much.
- Configured by the `notifications` key (`{ "enabled": false, "kinds": [...] }`, section 1), off by default, with a Notifications section in Settings (section 6).

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
  "post": { "others": false, "dependabot": false }
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
| top-level `cloneDir` | none; required | The local clone of `repo`, a top-level key since P2.1 because phase 2's manual runs work in it too (section 1). Auto-review never runs a command in it directly: each run gets its own worktree of this clone (Worktrees, below), so the owner's working checkout is never touched. |

Runs are launched the way phase 2 launches them: P2.1's launcher, the installed pit-crew review commands and their deployed prompts, with `--emit-json=<run-dir>`. Runs are single reviews; `--tandem` is not passed.

### Scheduler

- The scheduler lives in the server (`src/autoreview.ts`) and keeps its own clock: a tick every `intervalMinutes` inside active hours. It is separate from and independent of the UI's polling: pages opening, hiding, pausing or going idle never start, stop or move a tick, and neither the header's Pause nor a page's idle state pauses it. Its fetches refresh the cache like any cycle, but never on the UI's schedule.
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
- Phase 2's manual runs do not use these worktrees: P2.1 decided they work in `cloneDir` itself, since a run the owner starts from the drawer may need their checkout and Open session resumes from it (section 8, Launching runs).

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

- **`--no-post`**: a new pit-crew flag, an addition like `--emit-json` (section 8). A command invoked with it does everything it does today, including writing its report to `reportsDir` and, with `--emit-json`, its events and `result.json`, but makes no GitHub write of any kind: no review, approval or comment, no offer to post, and no fix mode, since fix mode pushes commits. The CI wait that exists only to choose the post's form is skipped, since there is no post. Its `post` step event is recorded as skipped, and `result.json` carries `"posted": null` with `"notPostedReason": "noPost"`.
- It only removes writes; it relaxes nothing. Every stop-and-ask point still stops (with `--emit-json`, as `needsInput`). The report is still written to disk first. A `--no-post` run is not a fix attempt, and the report carries the `Fix attempts:` line forward exactly as the prompt's rule says. The single permitted write, the posting forms, the CI gate and the one-attempt bound are untouched for every run that omits the flag.
- **The report is surfaced, never posted by Pit View.** The Agent cell reads, for example, "Changes requested · not posted", and the drawer lists the report under Reports on disk with an Open link. To post it, the owner starts a review from the drawer (phase 2), which posts under the command's own rules. Pit View never posts a report, and an unposted report is never posted later by anything; turning posting on affects only runs that start afterward.
- **Turning posting on** is per kind: `post.others` for others' PRs, and `post.dependabot` for the sweep, whose reviewers approve clean bumps automatically under `review-dependabot.md`. With it on, the run omits `--no-post`, and posting follows the command's own rules unchanged: one post, only after the report file is written, in the form the findings and CI select; for the sweep, everything on its list of things it must never do. Turning a switch on in Settings asks for confirmation, naming what will post and under which login.
- **Own PRs never post and never fix**, posting on or off. `review-pr` already never posts on the author's own PR, so `--no-post` costs nothing there, and it keeps fix mode, the one write `review-pr` makes on the author's PR, out of unattended runs. A fix stays a session the owner starts by hand (P2.6), under fix mode's own rules: authorship confirmed with `gh api user`, the one-attempt bound, and the `Fix attempts:` line.
- **With `--emit-json`**: `result.json` records whether and how a run posted, exactly as in section 8, so the drawer can show "not posted" as distinct from "posted as request changes". `--no-post` without `--emit-json` is also valid (a person may use it by hand).
- **In the sweep**, `--no-post` goes into every reviewer's brief, so the sweep's only GitHub writes, each reviewer's single report post, become none. Its skip-unchanged rule keeps every condition except the one that requires an approval already on the head, which nothing could have posted; the next sweep run without `--no-post` applies the full rule again, so a clean bump then gets reviewed fresh and its approval gets its chance. The escalation re-run posts nothing either. The sweep's `result.json` carries `"notPostedReason": "noPost"`, so a consumer can tell a deliberately unposted sweep from one whose rows simply carry no post (without the flag it is `null`). Under the flag a row reviewed in that sweep, whether by a first review, a retry or an escalated re-run, has `"posted": null`, even when the failed-reviewer recovery rebuilds it from a report whose `Reviewed commit:` line matches an earlier post; only a `reused` row reports a post, the one that already exists.
- **Where it lives in pit-crew**: The flag came first to `review-pr`, because phase 2 starts every review of the viewer's own PR with it to keep fix mode out (section 8, Launching runs); `review-dependabot` and `review-dependabot-sweep` accept it too. The contract goes in one new agent-agnostic prompt, `prompts/review/no-post.md`, which `review-pr.md`, `review-dependabot.md` and `review-dependabot-sweep.md` reference when the flag is present, as they reference `emit-json.md`. Each adds the flag to its argument list without rewording its constraints; the wrappers in `commands/claude/` and `commands/skills/` change only their descriptions, their argument hints, and the paragraph that strips the flag from the target, as they do for `--emit-json`. The same pit-crew rules apply as for phase 2 (section 2).

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

- Endpoints: `GET /api/auto-review/ticks` lists recent ticks; `POST /api/auto-review/run` is Run now. With a server that is always up and can start runs that post, a malicious page in the same browser could otherwise turn on auto-review or posting, so from phase 4 this POST and `PUT /api/config` require the same-origin `Origin` header and per-start token that section 9 specifies for direct actions; the token exists since P2.4 (section 3, HTTP API), so whichever of phase 4 and v3's direct actions lands first only applies it to these endpoints.
- Settings gains an Auto-review section: on and off, interval, active days and hours, the three opt-ins, concurrency, daily limit (a number field, default 10, any whole number of 1 or more, with a note that it caps only auto-review runs), clone folder (with a note that runs use their own worktrees of it, never the checkout itself), the two posting switches with their confirmation, and a note that runs happen whenever the app is running, with or without a page open. The optional start-at-login agent's status (installed or not) is shown beside it as a separate convenience, with a note that auto-review does not need it.

### Report storage (direction, not v1)

A direction to design and refine, not v1 work. v1 stays file-based as built, reading `reportsDir` (section 5), and phases 2 and 4 start that way. The question is whether review reports should move out of the flat reports folder into Pit View's SQLite database, or be used differently. The proposed direction:

- **Others' PRs: GitHub is the source of truth.** The posted review or comment is the record. Pit View reads it from GitHub rather than from files: the viewer's latest review already arrives in `latestReviews` and `latestOpinionatedReviews` with its `commit.oid`; a plain-comment post (the form `review-pr` uses when CI failed) carries no commit, so its reviewed SHA comes from the `Reviewed commit:` line that begins every report. Reading the viewer's comments needs a field added to the open-PR query, settled when this is designed. No local copy of a posted report is kept.
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
| How is access through the reverse proxy authenticated? | Not yet: anyone who reaches the proxy can use the app, starting review runs included (section 3, Hosting, Security behind a proxy). The owner wants sign-in with GitHub OAuth; P2.8 designs and builds it. Until then the proxy must stay LAN-only. |
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
| macOS notifications on state changes? | Not in v1. v3.3 adds them, macOS first, through the built-in `osascript` with no dependency; clicking a notification does nothing, and other platforms deliver nothing yet (section 9). |
| How does the UI load? | Cache first: render from SQLite at once, then update individual elements as GitHub responses arrive (section 3). |
| Machine-readable output from pit-crew's commands: replacement or addition? | Addition, behind `--emit-json`, invoked by Pit View; the human-readable report is unchanged (section 8). |
| When does the UI poll GitHub? | Only while at least one page is visible, not paused and not idle. With no active page the server makes no GitHub calls for the UI; opening or returning to a page shows the cache first, then refreshes when the data is older than 30 seconds (section 3). |
| Stop polling when nobody is using a visible page? | Yes: after `idleMinutes` (default 90, 0 for never) with no pointer, key, wheel, scroll, touch, focus or visibility activity, a page reports itself idle and counts as paused until the next activity. Per page and never persisted (section 6). |
| Pausing: per page or global? | Per page: a header button beside Refresh pauses and resumes polling for that page only. While paused the status reads "paused · updated <age> ago" and Refresh still works as a one-shot (section 6). |
| Automatic reviews on a schedule? | Yes, as phase 4 after v3, movable earlier: a scheduler independent of the UI, every 15 minutes during active hours by default, off until turned on, reusing section 5's rules and phase 2's launcher (section 10). |
| How is the server hosted? | The deployed app is a clone of `master` at `~/app/pit-crew`, run from its `pit-view/` folder by the `com.mickey.pit-view` launchd user agent on port 4791, idling when nobody is looking. The development checkout runs beside it with `pnpm dev` as the `dev` instance on port 4792, with its own config and state folders. Nothing in any phase depends on the agent, and every mode binds loopback only (section 3, Hosting). |
| Does auto-review need the app to start at login? | No. The scheduler runs whenever the app is running, whether or not a page is open; the login agent only saves starting it by hand, and no phase 4 milestone depends on it (sections 3 and 10). |
| Does Pit View's scheduler replace the cron job that lists which PRs need attention every 15 minutes? | Yes. It supersedes that job, and the job is retired once auto-review is in use (P4.8). |
| Auto-review's daily limit? | Configurable, default 10. Ten is only the starting default for auto-reviews; the owner does more than ten reviews a day, and runs started by hand never count (section 10). |
| Where do auto-review runs work? | Each in its own detached git worktree of `cloneDir` under `~/.local/state/pit-view/worktrees/`, named `run-<run-id>`, never in the owner's checkout; removed when the run ends, with a sweep at every tick and at server startup for orphans. The prompts' own throwaway worktrees are left to the prompts (section 10, Worktrees). |
| How does Pit View launch review sessions? | Through `src/launcher.ts`, callable without a page: Claude Code (`claude -p` with stream-json input held open, so a tandem primary hears from its secondary) or Codex (`codex exec` in a workspace-write sandbox), chosen by `agent.runner`; auto permission mode, failing a run on any denial, never bypassed; a `gh` identity check before every start; the run directory under the state folder; Stop by process group; Open session as a copyable resume command (section 8, Launching runs). |
| Where do manual runs work? | In `cloneDir`, now a top-level key shared with phase 4; the commands already review in their own throwaway worktrees, and phase 4's run worktrees stay for unattended runs only (section 8, Launching runs). |
| How many manual runs at once? | One per PR, and one sweep per repository; no overall cap; manual runs never count against phase 4's limits (section 8). |
| How do review sessions avoid fixing code unasked? | Pit View never launches `review-local`, and every `review-pr` of the viewer's own PR passes `--no-post`, brought forward to P2.2 for `review-pr`; only P2.6's Fix session omits it (section 8). |
| How do a command's closing questions surface? | As `needsInput` in `result.json`, answered through Open session; no prompt changes (section 8). |

## 12. Resuming work

1. Read this file, especially sections 3, 4 and 5, then the task in the Pit View project in Dispatch that you are taking. Its body copies the spec text that applies when it was filed; this file is authoritative where they differ.
1. From `pit-crew/pit-view/`, run `pnpm install` (once, for the dev-only type checker), then `pnpm test` and `pnpm check` to confirm the current state, then `pnpm dev` and open http://127.0.0.1:4792 (the deployed app keeps 4791).
1. Before committing, run `git grep -I "$HOME" -- pit-view` and confirm it prints nothing.
1. When work lands, record it as notes on its Dispatch task, and change this file only for behavior changes.
