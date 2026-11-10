# Local accounts and profile images

Local accounts are opt-in. Ordinary `shapewall serve` keeps its existing access model and does not create an account database.
Use Node 22.13 or newer and start with `shapewall serve --accounts`. On a loopback listener its fixed origin uses `localhost` and
the serving port. Passkeys require a hostname; IP origins are rejected. Existing IP bookmarks redirect to the configured account
hostname. Behind a proxy, pass `--accounts-origin https://wall.example.test` or set `SHAPEWALL_ACCOUNTS_ORIGIN`.
`SHAPEWALL_ACCOUNTS=1` also enables the feature. A non-loopback account origin must use HTTPS. Changing the origin later requires
a deliberate passkey migration; credentials belong to their relying-party hostname.

The database lives at `<outputDir>/.accounts/accounts.sqlite`, in a service-owned directory with mode 0700; the database is mode 0600. Include its SQLite WAL state in a consistent backup. This database stores accounts, passkey public keys, hashed sessions,
hashed recovery codes, account activity and canonical profile images. Existing capture, comment and journey files are not
imported, renamed or rewritten. CLI and MCP commands continue to use their existing plain-file interface.

## First owner

Before the first account is created, existing Host, network and device-pairing gates remain in force. Registration additionally
requires the private owner capability from a direct local `serve --open`, the verified Tailscale owner identity described below,
or a separate operator-configured `SHAPEWALL_ACCOUNT_SETUP_TOKEN`
matched against `X-Shapewall-Account-Setup-Token`. A trusted loopback proxy may inject that header after its existing owner gate;
it must overwrite inbound values. Never put the secret in browser code, configuration exports, request URLs or logs.

Visit the installation's `/signup` page using that owner access. The human must complete the browser's passkey registration
prompt and save the recovery codes shown once. No account or authenticator is created automatically. Both registration steps
require one of these owner-setup proofs, and verification rechecks the first-account condition inside the database transaction. Further
account registration is closed in this initial local mode.

### Tailscale account origin

The operating-system user running Shapewall must already be permitted to configure Tailscale Serve. A `serve config denied`
error is a host permission failure before account enrollment, not a passkey or Tailscale identity failure. Ask the host operator to
complete the existing supported Serve permission/setup process for the intended port, then retry deliberately. Do not run Shapewall
as root, change account origins or relax identity checks to bypass it.

With `shapewall serve --tailscale --accounts --open`, use the printed private HTTPS account origin. The existing Tailscale owner
identity can authorize the first enrollment when the request comes through the loopback Tailscale proxy, its Host exactly matches the
configured node hostname, and its verified owner login matches. `--no-identity` disables that route; device pairing alone does not
authorize account setup. Registration still closes after the first account. The configured origin, WebAuthn checks and human passkey
prompt remain required. Do not change hostnames or weaken the origin gate to enroll.

In this mode, `serve --open` opens the ordinary account board URL. The terminal separately prints a **Host agent settings** command:

```sh
shapewall settings --config /path/to/source/shapewall.config.json --open
```

Run it on the Shapewall computer as the same OS user to configure the agent. It opens a temporary loopback-only management window
with its own private capability and source-folder confirmation. It has no board or chat routes and cannot enroll or sign in an
account. Account sign-in and Tailscale owner identity do not grant remote Agent Settings write access.

After enrolling, sign out and back in, and try a recovery code, on the devices you will use. Shapewall's tests use virtual
authenticators, so phone passkeys, passkey sync and your Tailscale setup are yours to check.

After enrollment, board APIs, captures, live snapshots and installation operations require the account session cookie. Public
application shells and static interface assets can still load to explain sign-in. `/auth/*` implements the actual passkey,
recovery, profile, session and security-log API used by Account and security. The account cookie is HttpOnly and SameSite=Lax,
with Secure and a `__Host-` prefix on HTTPS. Hosted and local account cookies have different names.

Accounts are an additional gate. They do not remove Tailscale/device pairing or grant the separate Agent Settings and managed
update capabilities. Signing out ends account access; it does not revoke a Tailscale login or paired-device credential. The last
local account cannot be deleted, and account deletion never deletes local board data.

## Account and security in the app

After enrollment, open the profile menu and **Account and security** to review signed-in devices, passkeys, recovery tools and account
activity. To add a profile picture, choose **Upload photo** and select a PNG, JPEG or WebP under 5 MB. The browser crops it to a square
and saves the canonical image. **Remove photo** restores initials; a failed upload keeps the previous picture. No account is created
by merely opening the console, and the passkey prompt must be completed by the account owner.

## Profile images

`PUT /auth/me/avatar` accepts JSON `{ "png": "<base64 PNG bytes>" }`. The browser crops and converts the selected picture to a
256 by 256 RGBA8, non-interlaced PNG. The server validates the signature, dimensions, chunk boundaries, CRCs and exact bounded
inflated size, then decodes and reencodes the pixels. Animated images, unsupported formats, trailing data and invalid images are
rejected. Input bytes are capped at 512 KiB, with a separate bounded JSON parser. Original filenames and image metadata are not
stored. Failed uploads leave the existing image unchanged.

PUT and DELETE return `{ "avatarUrl": "..." }` (null after deletion). Refresh `/auth/me` for the complete profile. The
same-origin `GET /auth/me/avatar?v=<content hash>` returns only the signed-in user's canonical PNG, with private no-store caching
and nosniff headers. No arbitrary user ID, remote URL or file path is accepted. Hosted accounts use the same image validator,
storage schema and endpoints. Existing profiles retain initials until an image is uploaded.
