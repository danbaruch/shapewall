# Installation updates

The small credit and version below the board and workspace console, and **About Shapewall and updates** in the profile menu, open
**About & Updates**. On a local installation, the profile menu also opens **Workspace Console** at `/console`, with real local board cards and a **Settings** section for appearance preferences, installation details and **About & Updates**. The version includes the source revision,
so two builds of the same package version can still be distinguished. A static export or public demo shows its own build version;
it cannot update a server.

Updates are manual. Opening the panel reads installation details but never contacts a release provider or installs anything. There are
no update timers, automatic downloads or automatic restarts. **Check for updates** asks the installer-provided helper for the latest
prepared release. **Update now** explicitly activates it. After the server restarts, the panel verifies the new running revision and
offers **Reload Shapewall**.

## Ordinary installations

Without an update helper, the panel explains that the installation owner manages updates. Update using the same method used to install
Shapewall, then restart `shapewall serve`. Keep the project's config and `.shapewall/` data. An npm install, a source checkout and a
container image do not share an updater; Shapewall does not guess a command or run `npm update` on your behalf.

- **A clone:** stop your server, `git pull` (or check out the release tag you want), run `npm ci` in the clone, and start the server
  again with the same config.
- **Installed in a project from npm:** run `npm install --save-dev shapewall@latest` (or a version, `shapewall@X.Y.Z`), then
  restart with `npx shapewall serve`.
- **Installed in a project from GitHub:** run `npm install --save-dev github:danbaruch/shapewall` again (add `#<tag>` to pin a
  release tag), then restart with `npx shapewall serve`.
- **A tarball:** `npm install --save-dev /absolute/path/to/shapewall-X.Y.Z.tgz`, then restart.

The source revision in **About & Updates** tells two builds of the same version apart. Before switching, back up the config, captures, comments and account data, and keep the previous build
so you can go back. A server that runs as a service should be updated by replacing its release, not by editing the live folder.

## Managed installations

An operator can provide `SHAPEWALL_UPDATE_HELPER`, an absolute path to a trusted executable. Shapewall invokes that exact executable
with one argument, `check` or `apply`, without a shell. The browser cannot supply commands, paths, download URLs or target revisions.
The helper must serialize changes across processes and preserve the previous release for rollback. The server supplies the actual
running source revision as `SHAPEWALL_RUNNING_REVISION`, overriding inherited values. Compare that revision with the new release,
not only the installation symlink: a previous attempt may have switched the pointer before its server restarted.

On success the helper prints only JSON:

```json
{ "latest": { "version": "X.Y.Z", "revision": "abcdef1234567890abcdef1234567890abcdef1234" }, "updateAvailable": true }
```

An apply operation that needs this server to restart also returns `"restartRequired": true`. Only managed `serve` installations with
`SHAPEWALL_UPDATE_RESTART=1` honor that flag: after acknowledging the request they stop the way they stop on SIGTERM (capture and
checks runs are stopped, the notifier hands its lease over, `serve.json` is cleared) and exit with code 75. The existing service manager must
restart failures. Do not enable this option for an unmanaged terminal process. The UI waits for the advertised revision to run; helper
success alone is not installation success. Failed helpers and checks never restart the app. The helper must not print credentials or
diagnostic logs to stdout; the server returns bounded, generic errors.

Shapewall never interrupts an `apply`. The helper runs in its own process group (Ctrl-C in the server's terminal does not reach it), it
is not stopped with the server's capture and checks runs, and a server asked to stop (SIGINT or SIGTERM) waits for it to finish before
exiting; a second signal makes the server exit at once and leaves the helper running. An `apply` still running after 15 minutes is
reported as failed ("taking too long") but is not killed, and no other update starts until it exits. Give the service manager a stop
timeout longer than your longest apply (systemd: `TimeoutStopSec`), and keep the helper itself atomic: the service manager can still kill
the whole service. A `check` is stopped with the server, and killed after 30 seconds.

### Prepared immutable releases

`scripts/managed-update.py` is a reference helper for Linux services. It does not fetch or build software, execute package managers,
change a service unit or require sudo. An operator first builds, tests and stages a release into a root-owned installation's `releases/`
directory, including `dist/client/build-info.json`. The operator installs the helper root-owned and configures the fixed file
`/etc/shapewall/updater.json`:

```json
{ "installRoot": "/opt/example-shapewall", "pointerRoot": "/var/lib/example-shapewall/install" }
```

The installation root, release directories and metadata must be root-owned and not writable by other users. The pointer directory must
be owned by the app user with mode 0700. Its `current` and `previous` symlinks point at immutable release directories. Start the service
through that `current` pointer, directly or through another fixed symlink. Give the app write permission only to its data and pointer
directory; existing `NoNewPrivileges` and filesystem restrictions can stay enabled.

Publish a prepared release by atomically writing the root-owned `installRoot/update-channel.json`:

```json
{ "release": "release-abcdef1" }
```

Checking reads that file and validates release metadata. Applying takes a file lock, saves `previous`, atomically switches `current`,
and asks the app to restart. Config, captures and comments remain in their data directory. A rollback points `current` at `previous`
and restarts the service. After an update, open the board and try a real flow: a running service can still serve a broken UI. If a
release starts and fails later, roll back by hand.

### Who can update

The local owner link authorizes updates using the existing settings capability, sent in a header. Shared, read-only and unpaired
visitors cannot update. Mutations require same-origin JSON requests and accept an empty object only.

For a service behind a separately authenticated owner-only reverse proxy, an operator can configure `SHAPEWALL_UPDATE_TOKEN` (at least 32 characters, or the server refuses to start) and have
that proxy overwrite `X-Shapewall-Update-Token` with the same secret **only after verifying the installation owner**. Keep the token in
private server/proxy configuration, never browser code, a URL or a public repository. Ten wrong tokens from one address within 15 minutes block requests carrying the header from that address until the window ends. The application listener must remain private;
do not trust a client-supplied header or configure the header on a multi-user board. Shapewall still checks Host, Origin and JSON.

This capability can replace executable app code. Enable it only for the installation owner, independently of comment or board access.

### On the solo engine (experimental)

The solo engine (`shapewall serve --engine hosted`) offers the same About and updates dialog with the same rules: only the
installer's fixed helper runs, an apply is never stopped, and the engine restarts only when the installer opted in. The owner is
the one owner of the workspace the engine serves, signed in on the board of the project it serves, in a browser on this
machine (a loopback address and host, no proxy headers), writing from the board's own page. Owning some other workspace on the
engine is not enough, and an engine with no bound project, or two owners in its workspace, updates for nobody. Other accounts, requests through a proxy or tunnel, and read-only engines see the version only.
**Update now** first asks the owner to type the workspace's name (passkeys are off on the engine, so this is the typed
confirmation the console asks for elsewhere); **Check for updates** does not ask. `SHAPEWALL_UPDATE_TOKEN` works as above, still
needs the owner's session, and skips the typed confirmation. A hosted team server has no update routes; update
it the way it was installed.
