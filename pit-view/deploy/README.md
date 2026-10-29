# Deploying Pit View to `~/app`

Follows the Ghostwolf hosting convention: `~/dev` is for development, `~/app` holds a separate clone on `master`, and `launchd` supervises the process. The server binds loopback only and by default answers only to its loopback names; to reach it from the LAN, put a reverse proxy in front of it and list the proxy's host name in `allowedHosts` (Serving behind a reverse proxy, below).

The deployed app is a clone of the whole pit-crew repository at `~/app/pit-crew`, running from its `pit-view/` folder. Only `pit-view/` is used there; pit-crew's own `scripts/deploy-reviews.sh` keeps running from the development checkout. A clone under `/Volumes/Hyperspace/app` works the same way, since the service is generated from wherever the clone lives.

The development checkout and the deployed app run side by side and share nothing:

| Instance | Started by | Address | Config | Cache and logs |
| --- | --- | --- | --- | --- |
| App (the default) | the `com.mickey.pit-view` launch agent | http://127.0.0.1:4791 | `~/.config/pit-view/` | `~/.local/state/pit-view/` |
| Dev | `pnpm dev` in `~/dev/pit-crew/pit-view` | http://127.0.0.1:4792 | `~/.config/pit-view-dev/` | `~/.local/state/pit-view-dev/` |

`pnpm dev` is `PIT_VIEW_INSTANCE=dev pnpm start`. A named instance shows its name in the page title and as a small badge in the header; the app shows none. Each port is its own browser origin, so the theme and pause state stay apart too.

## First deployment

Needs Node 26 or later as `node` in the shell that runs the commands, pnpm, and a logged-in `gh`. The changes must be on `master` on GitHub first: `pnpm service:install` refuses a checkout on any other branch.

```bash
git clone git@github.com:MickeyMullin/pit-crew.git ~/app/pit-crew
cd ~/app/pit-crew && git checkout master
cd pit-view
pnpm install --frozen-lockfile
pnpm service:install
pnpm service:status
curl -s http://127.0.0.1:4791/api/instance    # {"name":"","configPath":"~/.config/pit-view/config.json","pid":...}
```

`pnpm service:install` renders `deploy/com.mickey.pit-view.plist` with the real paths (the home directory, this `pit-view/` folder, the Node binary running the install and the shell's `PATH`, so `gh` resolves under launchd) and writes it to `~/Library/LaunchAgents/com.mickey.pit-view.plist`, never into the repository. It creates `~/.local/state/pit-view/`, boots out an earlier install, bootstraps the agent into `gui/<uid>` and waits until the agent's own process answers on 127.0.0.1:4791. It is safe to rerun. The agent has `RunAtLoad` and `KeepAlive` (restarted after a crash or a failed start, left stopped after a clean exit), works in this `pit-view/` folder, and logs to `~/.local/state/pit-view/server.log` and `server.err.log`.

Register it in `~/app/service-registry.yaml`, writing each `~` as the absolute home path as the other entries do:

```yaml
  pit-view:
    status: deployed
    source_path: ~/dev/pit-crew/pit-view
    deployed_path: ~/app/pit-crew/pit-view
    repository: git@github.com:MickeyMullin/pit-crew.git
    hostname: pit.example.test    # the proxy's real name, as listed in allowedHosts
    port: 4791
    dev_port: 4792
    exposure: lan-only
    runtime: node-typescript
    database: ~/.local/state/pit-view/cache.sqlite
    launchd_label: com.mickey.pit-view
    notes: "PR dashboard. Runs from the pit-view/ folder of a full pit-crew clone. Binds loopback only; Caddy terminates HTTPS for the LAN name and proxies to 127.0.0.1:4791, and the name is in the app config's allowedHosts. No sign-in, so the route must stay LAN-only. The development checkout runs beside it with pnpm dev on 4792, with its own ~/.config/pit-view-dev and ~/.local/state/pit-view-dev, so the two can run at once."
```

### Seeding the app's config

The app starts with no config file of its own, which means the defaults in `config.example.json` and the `gh` login as the viewer. Either set it up in Settings at http://127.0.0.1:4791/settings.html, which writes `~/.config/pit-view/config.json`, or copy the development config and restart, since the server reads its config file at startup:

```bash
mkdir -p ~/.config/pit-view
cp ~/.config/pit-view-dev/config.json ~/.config/pit-view/config.json
cd ~/app/pit-crew/pit-view && pnpm service:restart
```

The cache is not copied; the first open page fills it from GitHub.

## Updating to a new version

```bash
git -C ~/app/pit-crew pull --ff-only origin master
cd ~/app/pit-crew/pit-view
git diff --quiet ORIG_HEAD HEAD -- pnpm-lock.yaml || pnpm install --frozen-lockfile
pnpm service:restart
pnpm service:status
```

`pnpm service:restart` kicks the running agent (`launchctl kickstart -k`) and waits for it to answer again. Run `pnpm service:install` instead when `deploy/com.mickey.pit-view.plist` changed, or after upgrading or moving Node, since the plist pins the Node binary that ran the install.

## Service commands

Run from `~/app/pit-crew/pit-view`:

| Command | Does |
| --- | --- |
| `pnpm service:install` | renders and writes the plist, loads the agent, waits for it to answer; replaces an earlier install |
| `pnpm service:restart` | restarts the loaded agent and waits for it to answer |
| `pnpm service:status` | says whether the plist is installed, whether the agent is loaded and its pid, and whether 127.0.0.1:4791 answers from the agent's own process; exits non-zero otherwise |
| `pnpm service:uninstall` | boots the agent out and removes the plist; the config, cache and logs stay |

With the agent running, a manual `pnpm start` of the default instance exits with the port-taken message; use `pnpm dev` for a second copy.

## Serving behind a reverse proxy

The server always binds 127.0.0.1 and refuses any `Host` it does not know, so a LAN name needs two things. First, list the name in the app's `~/.config/pit-view/config.json` and restart the agent (`pnpm service:restart`), since the server reads the file at startup. If the file does not exist yet, `{ "allowedHosts": ["pit.example.test"] }` alone is enough; every other key takes its default:

```json
"allowedHosts": ["pit.example.test"]
```

Entries are bare host names: no scheme, port or path. With a name listed, the server accepts that `Host` with any port or none, and writes whose `Origin` is `https://` or `http://` on that name.

Second, a proxy on the same machine that terminates HTTPS and passes the `Host` header through, which Caddy's `reverse_proxy` does by default:

```caddyfile
pit.example.test {
	reverse_proxy 127.0.0.1:4791 {
		# the event stream flushes at once; this keeps every other response unbuffered too
		flush_interval -1
	}
}
```

Do not add `encode` to this site: compressing would hold back the event stream. The stream's own headers (`Cache-Control: no-cache, no-store, no-transform`, `X-Accel-Buffering: no`) and its 30-second keepalives keep other proxies from buffering it or timing it out.

Pit View has no sign-in. Anyone who can reach the proxy can use the whole app, Refresh and Settings writes included, and a Settings write can change the repository, the reports folder and `allowedHosts` itself. Limit the proxy to the LAN (for example with a `remote_ip` matcher for the local subnet) and never publish it beyond the network.

## Checks after the first deployment

Run these after the first deployment.

1. `pnpm service:status` exits 0, and opening http://127.0.0.1:4791 fills the dashboard, so `gh auth token` works under launchd.
1. With no page open for an hour, `sqlite3 ~/.local/state/pit-view/cache.sqlite "select count(*) from cycles where started_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour')"` prints 0.
1. `kill -9` of the pid `pnpm service:status` shows brings the agent back with a new pid; after `pnpm service:uninstall` nothing listens on 4791.
1. With the agent running, `pnpm start` in the clone exits with the port-taken message, and `pnpm dev` in the development checkout runs beside it on 4792.
