# Pit View

A local dashboard for the pull requests in one GitHub repository: which PRs need your attention, which of your own are blocked or ready, and what closed today. The design, the rules it follows and the progress checklist are in [DESIGN.md](DESIGN.md).

## Requirements

- Node 26 or later. Node runs the TypeScript sources directly; there is no build step and no runtime dependency.
- pnpm, only to run the scripts and install the dev-only type checker.
- The GitHub CLI, `gh`, logged in to an account that can read the repository. Pit View asks `gh auth token` for a token at startup and never stores it.

## Running

From this folder:

```sh
pnpm install   # once, for the type checker
pnpm test      # node:test, against invented fixtures only
pnpm check     # tsc --noEmit
pnpm start     # the dashboard on http://127.0.0.1:4791 (PIT_VIEW_PORT to change); Settings at /settings.html
```

## Configuration

Settings live in `~/.config/pit-view/config.json`. Without that file Pit View uses the defaults in [config.example.json](config.example.json) and your `gh` login as the viewer; an empty `viewer` also means the `gh` login. Copy the example to start your own, and keep your real Jira site URL and key pattern there rather than in this repository. Every key is described in section 1 of DESIGN.md. The Settings page edits the same file and checks it before saving.

A person entry looks like this; `avatar` is `initials`, `github`, or an image path under `~`:

```json
{ "login": "octo-friend", "alias": "Friend", "initials": "OF", "color": "#0F766E", "avatar": "github" }
```

The cache is kept in `~/.local/state/pit-view/cache.sqlite`. Review reports are read from `reportsDir` (default `~/agents/output`) and never written.

## Tests

Tests use `node:test` with injected dependencies: a fake `gh` runner that replays the JSON under `test/fixtures/`, and temporary directories. They never run the real `gh` or touch the real config, cache or reports folder. The fixtures are invented; `test/fixtures/scenario.ts` describes the world they share and what each PR in them exercises.
