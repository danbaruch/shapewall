# Running and sharing a board

## Locally (the default)

```sh
shapewall serve            # http://127.0.0.1:4600/
```

The server binds to 127.0.0.1 and has no login. Two protections are always on:

- **Host check.** Requests whose `Host` header is not `127.0.0.1`, `localhost` or `[::1]` get a 421. This stops DNS rebinding, where a
  web page you visit points its own domain at your machine to reach local servers.
- **JSON-only writes.** `POST` and `PATCH` must be `Content-Type: application/json`, which a plain cross-site form or a no-cors request
  cannot send; `DELETE` needs a CORS preflight that Shapewall never grants.

`--read-only` turns off every write; `--no-capture` keeps comments but removes the "Capture now" button (captures then only run from the
CLI).

### Several local projects

Run `shapewall serve` in each project folder, using a different port for each:

```sh
# In the first project:
shapewall serve --port 4600 --open
# In another terminal, in the second project:
shapewall serve --port 4601 --open
```

The site dropdown lists boards in the current project, then **Local projects**. Pick another running project to open its board in the
same tab. Each project keeps its own captures, comments, agent settings and agent working folder. Settings tokens are never copied
between projects. Previously served projects stay in the list when stopped, with a hint to start them in their own folder.

The private index lives at `~/.config/shapewall/projects.json` (or the Shapewall folder under `XDG_CONFIG_HOME` or Windows `APPDATA`). It
contains config paths, with no credentials. Removed folders are ignored. The list is refreshed every 30 seconds and is available only
on direct local requests, never through a shared board or proxy. This is navigation between separate local servers; it does not start
other projects for you.

`127.0.0.1` always means the device opening the link. On a phone it means the phone, even with Tailscale connected. Use the computer's
Tailscale HTTPS link for phone access; the desktop project list is intentionally hidden there. See the team access guidance below.

## For a team

Use `shapewall hosted` for multiplayer: one server, each person's passkey account, workspace roles, invitations, comments, scoped
agents and live presence. Start with [Tailscale deployment](hosted.md#tailnet-deployment-mode-1), then walk through the
[checklist before you invite the team](hosted.md#before-you-invite-the-team). Capture on your machine and push, or move an existing local project
with `shapewall share`. The server does not need a public domain for a private tailnet team.

`shapewall serve --tailscale` below is for the local owner's other devices. Pairing another device does not create a separate
teammate account or role.

### Legacy local-board proxy access

For an intentionally shared local board without individual accounts, keep Shapewall on 127.0.0.1 and put a reverse proxy with authentication in front of it. Pass the public host name so the Host check accepts
it:

```sh
shapewall serve --port 4600 --allowed-host board.example.com
```

Caddy with basic auth, as an example:

```caddyfile
board.example.com {
  basic_auth {
    reviewer $2a$14$...   # caddy hash-password
  }
  reverse_proxy 127.0.0.1:4600
}
```

Any proxy works (nginx with `auth_basic`, an SSO proxy such as oauth2-proxy, a Tailscale or Cloudflare Access policy). Things to know:

- Anyone who can reach the board can read every capture and comment and, unless you pass `--read-only` or `--no-capture`, add comments
  and start captures.
- The board chat spends your model key, so it is off on a shared board unless you pass `--chat` (with a rate limit, a cap on answers at
  once and a storage quota per board). See [agents.md](agents.md#sharing-a-board).
- The comment author is a free-text name, not an identity. If you need accountability, put identity in the proxy and its logs.
- Binding to a non-loopback address (`--host 0.0.0.0`) without a proxy exposes the board unauthenticated; Shapewall prints a warning. With
  a non-loopback `--host` and no allowed host names, the Host check is off.
- With GitHub connect, anyone who can use the board can open issues with the server's token. A GitHub webhook
  (`POST /api/github/webhook`, only when `SHAPEWALL_GITHUB_WEBHOOK_SECRET` is set) must reach the board without the proxy's login; it is
  protected by its signature instead. See [github.md](github.md#webhook).
- `SHAPEWALL_ALLOWED_HOSTS` (comma-separated) adds names the same way as `--allowed-host`, and keeps the Host check on for a non-loopback
  `--host`. The value `*` turns the check off on purpose, for when the proxy in front already restricts the Host.

## In Docker

The repository has a `Dockerfile` based on the official Playwright image (Chromium and its system libraries included), pinned to the
Playwright version Shapewall is locked to, and running as the image's unprivileged `pwuser`. The image is large (about 2.6 GB, nearly all of
it the browser base image).

```sh
docker build -t shapewall .

# In your project folder (the one with shapewall.config.json):
docker run --rm -it -p 127.0.0.1:4600:4600 -v "$PWD:/work" --user "$(id -u):$(id -g)" shapewall          # serve
docker run --rm -it -v "$PWD:/work" --user "$(id -u):$(id -g)" shapewall capture                         # capture
docker run --rm -it -v "$PWD:/work" --user "$(id -u):$(id -g)" shapewall doctor
```

- The project folder is the volume `/work`; captures and comments land in its `.shapewall/` as usual. `--user` makes them yours; without it
  the container runs as `pwuser` (uid 1001), which usually cannot write a bind-mounted folder (`shapewall doctor` reports it). With rootless
  Podman add `--userns=keep-id`.
- Podman builds OCI images by default, which drop the `HEALTHCHECK` (it warns "HEALTHCHECK is not supported for OCI image format").
  Build with `podman build --format docker -t shapewall .` to keep it.
- The default command is `serve --host 0.0.0.0 --port 4600`, so the board is reachable through the published port. The Host check stays
  on: the image sets `SHAPEWALL_ALLOWED_HOSTS=localhost,127.0.0.1`. Add the name you reach it by (`-e
SHAPEWALL_ALLOWED_HOSTS=board.example.com`), or `*` only behind an authenticating proxy. Publish the port on `127.0.0.1` as above unless
  the proxy runs elsewhere.
- Inside the container `localhost` is the container. To capture a dev server on your machine, set `"baseUrl":
"http://host.docker.internal:3000"` and add `--add-host host.docker.internal:host-gateway` (or run with `--network host` on Linux).
- The board's "Capture now" button works in the container too: the browser is in the image.

[`docker-compose.example.yml`](../docker-compose.example.yml) sets all of this up (`init`, user, port on 127.0.0.1, the volume, the host
gateway).

## As static files

```sh
shapewall export --out shapewall-export
```

The folder holds the client, board data, captures and comments, read-only. Serve it from any static host or open it with a local static
server. Live HTML files carry their CSP as a `<meta>` tag because static hosts do not send the header, and the board still frames them with
`sandbox=""` (an opaque origin, with pins placed from the element map). Add `--no-comments` to leave comments out. Compare data (every pair of captured environments, with
the diff masks) is computed at export time.

`--browser-comments` makes a public demo out of it: visitors can add, resolve, reply to and delete comments, but those live in their own
browser's localStorage (seeded from the exported comments) and never reach the host; the comments panel says so and has a Reset. Journeys
stay read-only.

The demo on shapewall.com goes further: `node scripts/demo-export.js` exports with the demo client (`npm run build:demo`, into
`dist/demo-app`), which bundles the board and the hosted console with an in-browser backend (`client/src/demo/`). Visitors get a
fictional workspace with people in every role, invites, share links, tokens, an audit log and a scripted agent in the chat, switch
roles with View as, and keep their changes in localStorage. Nothing is sent to a server.

Serve the board from its folder with the trailing slash (`/demo/`, not `/demo`): its URLs are relative. If the host sends
`X-Frame-Options` or a `frame-ancestors` policy, let the board frame its own `data/**/*.html` files (same origin).

Treat an export like the site itself: if the captured pages are not public, do not publish the export publicly either.

## Updates

The small version below the UI opens **About & Updates**. Updates are manual: update the same way you installed, or give the board an
owner-only update helper. See [Installation updates](updates.md) for both, and for rollback.

## Captures on CI

`shapewall capture` exits 0 when every shot succeeded, 2 when some failed, 1 on errors. A typical job starts the app (or uses a preview URL
as `baseUrl`), runs `npx shapewall doctor --install-browser` (plus `npx playwright install-deps chromium` on a bare Linux runner, or use
the Playwright container image), then `shapewall capture`, and uploads `.shapewall/` or a `shapewall export` as an artifact.
`shapewall doctor` exits 1 when a check fails, so it also works as a first CI step.

## Resource use

Each concurrent page is a browser context (roughly 100 to 300 MB with Chromium). The default concurrency of 2 suits a laptop; raise it on
a large machine. Live HTML files are capped at 5 MB each; screenshots are usually 50 to 300 KB.

## Your own other devices (local mode)

Local mode has one owner; optional `--accounts` adds that owner's local passkey gate. Use it for your own phone and computers.
Use `shapewall hosted` for other people and workspaces.

### Tailscale (recommended)

```sh
shapewall serve --tailscale --port 4600
shapewall serve --tailscale=print --port 4600  # inspect the command without changing Serve
shapewall serve --tailscale --no-identity     # require pairing for every remote browser
```

Install Tailscale and sign in first. Shapewall keeps its listener on loopback,
checks the node's DNS name and owner with `tailscale status --json` and
`tailscale whois --json`, then prints a private HTTPS URL. It configures only the
chosen port with `tailscale serve --bg --https=4600 http://127.0.0.1:4600`. A port
already configured is refused, even if its target matches. Funnel on that port
is refused: a local owner board must not be public. A normal shutdown removes
only Shapewall's unchanged mapping; it never resets the node's Serve settings.
After a crash, inspect `tailscale serve status` and remove only that port with
`tailscale serve --https=4600 off` before starting again.

The operating-system user running Shapewall must already be permitted to configure Tailscale Serve. A `serve config denied`
error is a host permission failure before account enrollment, not a passkey or Tailscale identity failure. Ask the host operator to
complete the existing supported Serve permission/setup process for the intended port, then retry deliberately. Do not run Shapewall
as root, change account origins or relax identity checks to bypass it.

A Tailscale request gets owner access only if its immediate peer is loopback,
its Host is exactly this node's `*.ts.net` name, and `Tailscale-User-Login` equals
the node owner's login. Other users, shared-in devices, tagged nodes, and
missing or mismatched identity headers must pair. `--no-identity` disables
header trust altogether. The node owner is determined at server start; restart
Shapewall after changing the node's owner.

This relies on Tailscale Serve stripping client-supplied identity headers and
setting its own values. Keep Tailscale current. See the
[Tailscale identity-header documentation](https://tailscale.com/docs/features/tailscale-serve#identity-headers)
and its [proxy header implementation](https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go).
A process already running on the host can forge loopback requests and headers;
that process is inside the host trust boundary. Do not proxy another service to
this listener. For an unverified proxy or client version, use `--no-identity`
until you have checked a forged owner header from a different tailnet user is
replaced or rejected. Shapewall's tests cover its own request handling, not
your Tailscale daemon or tailnet ACLs.

### Tailscale with a local account

`shapewall serve --tailscale --accounts --open` uses one fixed HTTPS account origin. The existing verified Tailscale owner identity
can authorize only its first owner enrollment; a paired device alone cannot. Finish the passkey prompt yourself and keep the account
origin stable. `--no-identity` disables identity-based enrollment. See [local accounts](local-accounts.md#tailscale-account-origin).

The browser opens the ordinary account board URL, while the terminal prints a **Host agent settings** command for the Shapewall
computer: `shapewall settings --config /path/to/source/shapewall.config.json --open`. This foreground loopback-only window shares the
source-keyed private agent settings, with explicit source-folder/command confirmation. It has no board, capture or chat routes and
closes with Ctrl-C. Remote settings remain read-only; the account and device gates on the board are unchanged. See
[host-only agent management](agents.md#host-only-agent-management), including refusals while project agent work is in progress.

### LAN pairing

```sh
shapewall serve --lan
shapewall serve --lan=eth0
shapewall serve --lan=192.168.1.20
shapewall serve --lan --tls-cert ./cert.pem --tls-key ./key.pem
```

`--lan` binds all IPv4 interfaces; an interface or address narrows the listener.
A separate loopback listener remains available for host management with an
explicit interface. Loopback names, the machine's hostname, `hostname.local`
and local interface IPs pass the Host guard; a wildcard Host is refused.
The settings link printed in the host terminal remains private and host-only.
Use that link for the Devices panel, or manage devices from your terminal.

An unpaired browser sees only the pairing page and public app assets. It names
its device and receives an eight-character code. Compare that code on the host,
then approve or deny in Devices on the host board, or run:

```sh
shapewall devices list
shapewall devices approve BCDF-GHJK
shapewall devices deny BCDF-GHJK
shapewall devices revoke DEVICE_ID
shapewall devices revoke --all
```

Codes expire in five minutes. There are at most five pending requests (a sixth
replaces the oldest), and at
most ten pairing attempts per minute per socket peer IP. Through Tailscale,
peers share the loopback rate limit. The code alone never grants access: the
browser must also hold its random HttpOnly pairing challenge. Approval grants a
separate device capability cookie with `HttpOnly; SameSite=Strict; Path=/` and
`Secure` over TLS or Tailscale HTTPS. Only token hashes live in
`$XDG_CONFIG_HOME/shapewall/devices.json` (or the normal platform config folder),
keyed by the real project path. The folder must be private, owned by you and
0700; the file must be 0600. Symlinked files are refused. Device cookies expire
after 30 idle days, refreshed on activity at most hourly, with a hard 90-day
limit. Revocation denies cookie-based access on the next server request,
including old pairing challenges. It does not revoke automatic access from
the owner's Tailscale identity; use `--no-identity` when every remote browser
must have a separately revocable pairing. Previously downloaded captures are
not erased from the browser.

**Plain HTTP on Wi-Fi exposes the cookie to sniffing and replay.** Prefer
Tailscale HTTPS, or supply a certificate trusted by the device (for example,
mkcert with the hostname, LAN IP and loopback address). Plain LAN HTTP has no
service worker and installs only as a bookmark. On iOS, an installed home-screen
app has a separate cookie jar from Safari: install first, then pair inside it.

### Device permissions

| Action                                                           | Host with settings link | Owner device                    | Unpaired            |
| ---------------------------------------------------------------- | ----------------------- | ------------------------------- | ------------------- |
| View, history, compare                                           | yes                     | yes                             | pairing screen only |
| Comments, replies, reactions, resolve, edits, deletion           | yes                     | yes                             | no                  |
| Capture and recapture                                            | yes                     | yes                             | no                  |
| Chat with connected agent                                        | yes                     | yes, unless `--no-remote-chat`  | no                  |
| Approve permission cards                                         | yes                     | yes, unless `--approve-on-host` | no                  |
| View effective agent settings                                    | yes                     | read-only                       | no                  |
| Change agent command, key variable, key host, or test connection | yes                     | no                              | no                  |
| Approve, deny or revoke devices                                  | yes                     | revoke itself only              | no                  |

Permission-card history records the answering device name. Device names are
owner-assigned display text, not a second user identity. Settings tokens never
become remote capabilities, including when copied to a paired browser. Normal
local `--host`/proxy sharing stays available with its existing warning; it does
not automatically enable owner pairing. Shared-board agent limits remain in
place there; paired owner devices use the local owner's existing chat limits.
