# Hosted Shapewall (beta, push-first)

A server for teams: people sign in with passkeys, belong to workspaces, and review boards that were captured somewhere else and
uploaded with `shapewall push`. Agents read and resolve the comments with a project token through `shapewall comments --remote`,
`shapewall watch --remote` or `shapewall mcp --remote`.

License: the server (`src/hosted`) is under the [Functional Source License 1.1, ALv2 future license](../src/hosted/LICENSE.md).
You can run it for yourself or your company; you can't offer it as a competing hosted service. Each release becomes Apache 2.0
two years later. The clients (`push` and the `--remote` commands, in `src/remote`) are Apache 2.0 like the rest of Shapewall.

**Status: beta.** Start with one
invite-only server that the team reaches over Tailscale. Each teammate signs in with their own Shapewall passkey and joins a workspace.
Walk through the [checklist before you invite the team](#before-you-invite-the-team) on your own devices and network first.

`shapewall serve` is the separate, single-owner local tool. Its Tailscale/pairing mode lets that owner use their other devices;
`shapewall hosted` supplies team accounts, roles and collaboration. A public domain or a Shapewall-operated service is not needed
for tailnet multiplayer.

What v0 does not do: capture on the server. The server never opens a browser and never fetches a URL a user gives it, so there is no
SSRF surface. You capture on your machine or in CI (it can reach `localhost` and staging, which a hosted crawler cannot) and push.

## Run it

```sh
shapewall hosted --data /var/lib/shapewall-hosted --origin https://app.example.com --port 4700 --trust-proxy
```

| Flag                    | Env                                | Default                   | What                                                                                                    |
| ----------------------- | ---------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `--data DIR`            | `SHAPEWALL_HOSTED_DATA`            | `./shapewall-hosted-data` | Database, secret, pushed files                                                                          |
| `--origin URL`          | `SHAPEWALL_HOSTED_ORIGIN`          | `http://HOST:PORT`        | The public origin. Passkeys are bound to its host name (the RP ID).                                     |
| `--port`/`--host`       |                                    | `4700` on `127.0.0.1`     | Keep it on loopback behind a reverse proxy                                                              |
| `--signup`              | `SHAPEWALL_HOSTED_SIGNUP`          | `invite`                  | `invite`: only invite links (and the setup link). `open`: anyone                                        |
| `--trust-proxy`         | `SHAPEWALL_HOSTED_TRUST_PROXY=1`   | off                       | Client IPs from `X-Forwarded-For` (only from a proxy on this host)                                      |
|                         | `SHAPEWALL_HOSTED_SECRET`          | `<data>/secret.key`       | Key for signed live-HTML URLs (made on first start, mode 0600)                                          |
|                         | `RESEND_API_KEY`                   | unset                     | With `SHAPEWALL_EMAIL_FROM`: invite emails through Resend                                               |
|                         | `SHAPEWALL_EMAIL_FROM`             | unset                     | Sender for invite emails, e.g. `Shapewall <invites@example.com>`                                        |
| `--previous-origin URL` | `SHAPEWALL_HOSTED_PREVIOUS_ORIGIN` | unset                     | The old origin during a move ([Moving to a new origin](#moving-to-a-new-origin))                        |
| `--report-email ADDR`   | `SHAPEWALL_HOSTED_REPORT_EMAIL`    | unset                     | "Report this board" on public projects opens a mail to this address                                     |
|                         | `SHAPEWALL_TURNSTILE_SITE_KEY`     | unset                     | With `SHAPEWALL_TURNSTILE_SECRET`: a Cloudflare Turnstile check on open sign-up and comment share links |
|                         | `SHAPEWALL_TURNSTILE_SECRET`       | unset                     | Turnstile secret key. Both keys or neither (one alone is a warning and stays off)                       |

It needs Node 22.13 or newer (it uses the built-in `node:sqlite`). Passkeys need a secure context: `https://`, or `http://localhost`
for trying it on your own machine (`--origin http://localhost:4700`; not `127.0.0.1`, which is not a valid passkey RP ID).

**The first account.** On an invite-only server with no accounts, the server makes a one-time setup link (valid 24 hours) and writes it
to `<data>/setup-link` (mode 0600). The start log names only the file and the command, never the link, so journald never holds it.
Print it on the server's machine with `shapewall hosted setup-link --data <dir>` (the same link until it expires or is used; `--new`
makes a new one and voids the old one). Open it, pick a handle and your name, and create a passkey. You get a workspace you own and
ten recovery codes, shown once: save them in a password manager. Using the link deletes the file.

**Bot check.** With both Turnstile keys set, open sign-up (`--signup open`) and opening a comment share link need a passing Turnstile
check (`POST /auth/register/options` and `POST /api/shares/open` take `turnstileToken`). It fails closed: a missing, wrong or
unverifiable token (Cloudflare unreachable, 5 second timeout) is refused with 403 `turnstile_failed`. Invite and setup sign-ups and
view-only links skip it. The console loads the widget from `challenges.cloudflare.com` only then, and only a server with keys adds
that origin to the console CSP. Off by default.

Deployment examples: [examples/hosted/shapewall-hosted.service](../examples/hosted/shapewall-hosted.service)
(systemd, hardened) and [examples/hosted/Caddyfile](../examples/hosted/Caddyfile).

## Accounts

- **Passkeys only.** No email, no passwords. Sign-up and sign-in use discoverable credentials with user verification required, so
  signing in is one button (no username). Where the browser supports it, the sign-in page also offers passkeys in the handle field's
  autofill (WebAuthn conditional UI), renewed before the 5-minute ceremony expires. Add more passkeys (another device, a password
  manager) on the Account page; the last one cannot be removed while you have no unused recovery codes.
- **Passkey labels.** Each passkey says where it lives, from the authenticator's backup flags: "Synced" (backed up by a cloud keychain
  or password manager), "This device only", or "Not synced yet" (can sync, has not), plus how it connects (built in, phone, security
  key). With a single device-only passkey the page suggests adding one on another device. A sign-in from a browser and OS the account
  has not used before is marked "Signed in on a new device" in Account activity.
- **Recovery codes.** Ten one-time codes (about 128 bits each), stored as SHA-256 hashes, shown once. A code plus your handle signs you
  in and ends every other session of the account (a stolen device loses its session). That session is never "fresh": in its first 30
  minutes it can add a passkey, and nothing sensitive. A passkey added that way signs in, but is on hold for 24 hours before it can
  confirm sensitive actions, so someone with one stolen code cannot lock the owner out: the owner's own passkey still removes theirs
  (which ends their sessions) and makes new codes. Making new codes voids the old ones. Lose every passkey and every code and the
  account is gone, but its work is not: projects belong to workspaces, so an admin removes the old member and invites the new account.
  Admins never reset someone else's credentials (that would be a takeover path).
- **Sessions.** A random 32-byte cookie (`__Host-sw_session` on https), HttpOnly, SameSite=Lax, stored as a hash, 30 days sliding and
  90 days at most. Signing in replaces the browser's previous session. The Account page lists your signed-in devices (browser and OS
  from the user agent, IP, last used); sign one out, or "Sign out other devices" for all of them. Removing a passkey also ends the
  other sessions. The list carries a session id, never the cookie or its hash.
- **Admin idle expiry.** For an admin or owner, workspace pages and APIs need a passkey check after 12 hours without using any of
  them (403 `reauth_required`; the console shows "Confirm it's you" and loads again). The session itself stays signed in.
- **Re-auth.** Creating API tokens or share links, turning share links on, adding or removing a passkey, new recovery codes, deleting
  a project or the workspace, signing out devices, changing or removing an admin or owner, making someone an admin or owner and
  inviting an admin or owner, turning public projects on, making a project public and starting a move of your sign-in to a new origin
  need a passkey check (not on hold) in the last 10 minutes; the console asks for it ("Confirm it's you")
  when needed. In a recovery-code session, which has no passkey to confirm with, it says "Add a passkey first" and links to adding
  one (or lets you use a passkey you still have, which turns the session into a passkey session).
- **Account activity.** The Account page lists your own security events, newest first: sign-ins (passkey or recovery code, with the
  device and IP), passkeys added and removed, new recovery codes, devices signed out (`GET /auth/security-log?before=`). After a
  recovery code was used on your account, the next passkey sign-in shows a banner until you dismiss it ("That was me",
  `POST /auth/security-notice/seen`); `GET /auth/me` carries it as `securityNotice`.
- **Deleting your account.** Account page, "Delete account": a fresh passkey check and your handle typed back
  (`DELETE /auth/me` with `{ confirm, revokeTokens }`; `POST /auth/delete-account/preview` shows the plan first). Workspaces where you
  are the only member are deleted with it; in the others you leave (your pending invites and share links are revoked, and your API
  tokens unless you untick that). It is refused while you are the only owner of a workspace that has other people in it: make one of
  them an owner first. Comments keep the name they were signed with. The account's own security events are deleted; an
  `account_deleted` entry without a user stays.

## Workspaces, roles and invites

Projects belong to a workspace, never to a person. Roles:

| Who                        | Reaches                   | Can                                                                                                                                                                    |
| -------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| viewer                     | every project             | See projects, boards and comments                                                                                                                                      |
| member                     | every project             | + comment, reply, react, resolve, reopen; edit and delete their own comments                                                                                           |
| admin                      | every project             | + projects, API tokens, share links, invite links (up to admin), change and remove members and viewers, delete any comment, the Access overview, the audit log, rename |
| owner                      | every project             | + change or remove admins and owners, invite owners, delete the workspace. A workspace always keeps one owner                                                          |
| API token                  | one project               | Its scopes (below): read, comment, resolve, push. Signed as the token, marked as an agent                                                                              |
| share link guest (view)    | one project, no workspace | See that project's boards and comments. Nothing else: no members, no other projects, no workspace data                                                                 |
| share link guest (comment) | one project, no workspace | + add comments and replies, signed `<name> (guest)`. Never resolve, reopen, edit or delete; agents skip their comments by default                                      |

The console shows this table on **Access, Roles** and next to every role picker.

**Invite links** hold a 32-byte token (stored hashed), a role, an expiry (1, 3, 7, 14 or 30 days; 7 by default), and work once. Opening
one shows the workspace and role; a new person creates an account from it, an existing one joins with a click. The token sits in the
URL fragment (`/invite#<token>`), and the setup link the same way (`/signup#setup=<code>`): browsers never send a fragment, so the token
stays out of access logs and Referer headers. The console reads it, keeps it in session storage for the sign-in round trip, and previews
the invite with `POST /api/invites/preview`. With `RESEND_API_KEY` and `SHAPEWALL_EMAIL_FROM` set, an admin can also have the link
emailed: at most 20 an hour per workspace, 50 a day per person and 500 a day for the whole server, with a fixed subject ("You have an
invite to a Shapewall workspace") and the workspace and inviter names quoted as names they chose, so the operator's sending domain is a
poor tool for phishing. Invite emails are off on a server with `--signup open` (anyone could make an account and send them). The address
is kept on the invite for its history. Without email the console only offers copying the link. At most 100 invites are pending per
workspace; pending ones can be revoked, used and expired ones move to History with who made them and who joined.

**What someone hands out goes with them.** Removing an admin or owner, or their leaving, revokes their pending invites, share links
and API tokens in the same transaction; demoting one below admin does the same, and an owner made admin loses their pending owner
invites. Deleting an account always revokes its tokens. On top of that, an invite works only while its creator can still invite to
that role (admin, or owner for owner invites), a share link only while its creator is still an admin or owner, and an API token only
while its creator is still a member with the admin or owner role, checked again at every use. There are no service tokens: every
token has a creator. An admin removing someone may keep their tokens (`{ revokeTokens: false }`, for CI that cannot stop at once);
kept tokens are `inactive` and refused until the creator is an admin here again, so revoke them and make new ones.

**Share links** let an admin share one project's boards with someone who has no account. They are off for every workspace until an
admin turns them on (Settings, which asks for a passkey check); turning them off stops every link at once, and turning them back on
restores the ones that are not revoked or expired.

- A link reaches exactly one project. It is **view-only** or **comment** (guests give a display name, 1 to 40 characters), expires
  after 1, 7, 30 or 90 days, can have a passcode (4 to 64 characters, stored with scrypt), and is revoked with a click. At most 20
  active links per project. Deleting the project ends its links.
- The link is `/share#<token>`: 32 random bytes in the fragment, stored as SHA-256. The landing page previews it with
  `POST /api/shares/preview`; when there is a passcode, the preview names neither the project nor the workspace until it is right.
  `POST /api/shares/open` checks the passcode (5 wrong tries per 15 minutes per link and IP, 30 an hour per IP, 50 an hour per link
  from anywhere). Each try counts before the passcode is checked and a right one gives its count back, so parallel guesses cannot get
  past the limit. It then starts a guest session: a random 32-byte cookie scoped to `/s/<share id>/` (HttpOnly, SameSite=Strict,
  `__Secure-` on https), stored as SHA-256 in `guest_sessions` with the name, the browser and OS, the IP's /24 (or /48), for at
  most 12 hours and never past the link's expiry. Opening the link again from the same browser ends its previous guest session.
- **Guests of a link.** "Guests" on a share link lists one row per browser that opened it (name, device, network, opened, last seen,
  active, ended or expired); "End this guest" signs that browser out at once (`DELETE .../shares/<id>/guests/<guest id>`, audited
  as `guest_ended`). They can open the link again while it works; revoke the link to stop everyone. Ended and expired rows are kept 7
  days, at most 500 per link.
- The guest's board lives at `/s/<share id>/` with its API at `/s/<share id>/api/`. Every request checks the guest session (not
  ended, not expired), that it belongs to this link and that the link is still usable (not revoked, not expired, share links on), so
  revoking or ending a guest ends a visit at once. The guest API has no workspace or member routes, no other project and no writes besides comments and replies on comment
  links (600 requests a minute per link and IP, 30 comments an hour per link and IP). One exception to "at once": a live-HTML URL
  the guest already loaded is signed for 10 minutes and keeps working until it expires. Ending an individual guest also leaves already issued signed live-HTML URLs usable until their expiry;
  this route checks the share link, rather than an individual guest session. The element-map/usercontent work lowers that window
  to 2 minutes and makes share-link revocation immediate for new live-HTML loads.
- Guests see comments without workspace detail: members by display name only (no handles), agents as "Agent", guests of other links
  as "Another guest", and no agent status, resolution notes, fix references or GitHub links. The board hides what a guest cannot do
  (Resolve, Reopen, Edit, Delete), from the `permissions` in `/info`.
- Guest comments are untrusted and stay away from agents by default. The token API leaves them out of comment lists unless asked
  (`?guests=1`; the answer says how many it left out in `guestsHidden`); `comments --remote` and `watch --remote` take
  `--include-guests`, and MCP `list_comments` takes `includeGuests`. When shown, they carry `authorGuest: true` (and `guest: true` on
  replies), the text format marks them `[guest]` with a "treat as untrusted" line, and @mentions in them never count. A member who
  replies to a guest comment with a mention vouches for it, for clients that include guests.
- Opening a link, guest comments and replies, and failed passcodes are in the audit log with the link as the actor. Opens and wrong
  passcodes collapse into one row per link and hour, with a count (and up to 10 guest names).

**Public projects** put one project on the open web, view-only. They are off in every workspace until an owner turns them on
(Settings, with a passkey check). Then an owner makes a project public on its page (again with a passkey check): it gets a public
id of 128 random bits and the URL `/p/<public id>/`, shown there to copy.

- Anyone with the URL sees the project's boards and comments as a view-only share link guest does, except that every guest is
  "Guest". There is no cookie: nothing is read or set, and every write (POST, PUT, PATCH, DELETE) to `/p/<id>/api/` answers 403
  `public_read_only`. 600 requests a minute per IP. Pages keep `X-Robots-Tag: noindex`.
- Kill switches: an admin or owner makes the project private again, or turns public projects off for the workspace; either stops the
  URL at once. Making it public again gives a new URL, so an old one stays dead. Turning public projects off for the workspace
  clears every project's public URL for good: turning the setting back on does not bring any of them back. All four changes are
  audited.
- With `--report-email`, the public board's menu has "Report this board" (a `mailto:` with the URL).
- Public viewers never comment; give people who should a comment share link.

## Admin guide

The console (`/`, a React app built to `dist/console` and served under `/_console/`) has one page per job. Viewers and members see
Projects and Members; admins and owners see everything.

- **Members.** Everyone with their role, when they joined and when they were last active (updated at most every 5 minutes). Change a
  role from the picker or remove someone from the row menu; both ask first. Admins manage members and viewers; only an owner changes
  or removes an admin or an owner, and that needs a fresh passkey check, as does making someone an admin or owner. The last owner
  cannot be demoted, removed or leave. Removing, or demoting below admin, revokes the person's pending invites, share links and API
  tokens (the confirm dialog says so). When the person made API tokens that still work, the remove dialog lists them with "Revoke"
  checked; unchecking it keeps them, inactive (`DELETE /members/:user` with `{ revokeTokens: false }`); the audit entry says whose
  invites, links and tokens went.
- **Invites.** "Invite people": pick the role (up to your own: admins invite up to admin), the expiry, an optional note for whom it is
  (up to 80 characters, shown in the pending list, the history and the audit log; admins only) and optionally an email address. The
  link is shown once, with a copy button. Pending invites can be revoked; History shows used, revoked and expired ones. Someone who
  opens an invite while signed in to an account that is already in the workspace is told so, with a link to it. The invite page keeps
  the token in the tab's session storage until it is used, so a reload or a trip through sign-in does not lose it, and a link that
  lost its code can be pasted back in.
- **Access.** Who reaches what. "By project" is a matrix of people, API tokens and share links against projects (on a phone, pick a
  project). "By person" shows one person's role and what it gives them in each project. "Roles" is the table above. Pending invites
  are counted.
- **API tokens.** Every token in the workspace with its project, scopes, creator, created, last used and expiry. A token whose creator
  has left the workspace or is no longer an admin is `inactive` and flagged: it is refused at every request, so revoke it.
- **Share links.** On each project page (Manage): create, copy, see opens and last use, list and end guests, revoke. They are also
  listed in Access.
- **Public.** On each project page, when the workspace allows it: make the project public (owners) or private (admins), and copy its
  public URL.
- **Audit log.** Filter by who (a person, a token or a share link), by action and by time (24 hours, 7, 30 or 90 days), and search
  (`q`: names, handles, projects, tokens, links, details); 50 a page, newest first, "Load older events" for more. Each entry shows the
  relative and the exact time. "Export CSV" downloads up to 10,000 entries with the same filters (`GET /audit/export`; cells that
  start with `=`, `+`, `-` or `@` get a leading `'` so a spreadsheet does not run them).
- **Settings.** Rename (admins), share links on or off (admins), public projects on (owners) or off (admins), export (admins), leave, and delete the workspace (the owner, with a
  passkey check and the workspace name typed back). Deleting removes every project, board, file, comment, token, invite, share link and
  audit entry, and writes one `workspace_deleted` entry to the account log.
- **Export.** "Download a copy" (admins, with a fresh passkey check; `POST /export`; one at a time per workspace, 409 while one runs,
  and 5 an hour per person) streams a zip: `workspace.json` (the workspace,
  members, projects, tokens without their secrets, share links without theirs), `audit.json`, and per board `board.json`,
  `comments.json` and its files (captures, variants, versions, live HTML). Over 3.5 GB it answers 413 (no zip64 yet). `audit.json` holds
  up to 100,000 entries, newest first, read and written 1,000 at a time.
- A member who opens an admin page (a link, a bookmark) sees "This page needs the admin role" instead of being sent back to Projects.
- An empty project shows a four-step checklist (project, token, push, invite) that ticks itself off. The token dialog shows the
  working command once, with the token in it: `SHAPEWALL_TOKEN=... shapewall push --remote <this server>`.

Console API (cookie session; all under `/api/workspaces/:ws`): `GET /` (workspace, members, projects, `me`, features),
`PATCH /` (rename), `PATCH /settings` (`{ shareLinks }`), `DELETE /` (`{ confirm: name }`), `GET /invites` (`{ pending, history }`),
`POST /invites` (`{ role, expiresInDays, email }`), `DELETE /invites/:id`, `PATCH /members/:user` (`{ role }`),
`DELETE /members/:user` (`{ revokeTokens }`), `GET /access`, `GET /tokens`, `GET /shares`, `GET|POST /projects/:pid/shares`,
`DELETE /projects/:pid/shares/:sid`, `GET /audit?actor=user:<id>|token:<id>|share:<id>&action=&from=&to=&q=&before=&limit=`,
`GET /audit/export` (CSV, same filters), `GET /audit/filters`, `POST /export` (zip). Account: `GET /auth/sessions`,
`DELETE /auth/sessions/:id`, `POST /auth/sessions/revoke-others`, `GET /auth/security-log`, `POST /auth/security-notice/seen`,
`POST /auth/delete-account/preview`, `DELETE /auth/me`. Logins from the CLI: `POST /api/device/lookup|approve|deny` (`{ code, ... }`).

## Projects, tokens and push

An admin creates a project and an **API token** for it (Workspace page, "API tokens"). Tokens look like `swp_` + 43 characters, are
shown once, stored as SHA-256 with a 12-character display prefix, can expire, and are revoked with a click. Each token belongs to one
project and has scopes:

| Scope     | Allows                                                    |
| --------- | --------------------------------------------------------- |
| `read`    | Pages, comments, screenshots and live HTML of the project |
| `comment` | Replies and agent status                                  |
| `resolve` | Resolve and reopen                                        |
| `push`    | Upload captures                                           |

The CLI takes the token from `$SHAPEWALL_TOKEN` or `--token-file FILE`, never from a flag (other users can read a process's arguments),
and sends it only over https (plain http only to this machine).

```sh
shapewall capture
SHAPEWALL_TOKEN=swp_... shapewall push --remote https://app.example.com
```

**`shapewall login`** gets a token without copying one:

```sh
shapewall login --remote https://app.example.com
shapewall push --remote https://app.example.com    # and comments, watch, mcp --remote
```

It prints a short code (like `BCDF-GHJK`) and opens `/device` in the browser (a URL the CLI builds from `--remote`, never one the
server sends; on Windows through `rundll32 url.dll,FileProtocolHandler`, no shell). Someone with the admin role there types the code,
checks that the page shows the same code, the address the login came from and how long ago it started, picks the workspace,
project, scopes and expiry (30 or 90 days, or none), and approves with a passkey check. The machine name is shown as reported by the
terminal (unchecked), and the page warns when the login came from another address than the approver's. The CLI, polling `POST /api/v1/device/poll` every 3 seconds, receives the token once and saves it
in `$XDG_CONFIG_HOME/shapewall/credentials.json` (or `~/.config/...`): the folder 0700, the file 0600, one entry per server origin.
It never prints the token. The token is named `<machine> (shapewall login)` and listed with the others; revoke it there. A code
expires after 10 minutes, works once, and can be denied. `$SHAPEWALL_TOKEN` and `--token-file` still win over the saved login. The
CLI side is `POST /api/v1/device/start` (`{ name }`, 10 a minute per IP, at most 5 pending per IP (429), at most 500 pending in all,
the oldest dropped to make room) and `/poll` (`{ deviceCode }`: 202 while waiting, 200 with
the token, 403 denied, 410 expired); lookups are limited to 10 a minute per account. Pending logins live in SQLite
(`device_logins`), so a restart keeps them: the row holds the device code's SHA-256, never the code. An approved token is stored
sealed to a key derived from the device code (X25519 and AES-256-GCM), so only the CLI that holds the code can open it, and the row is
deleted when it is picked up. Approving is single-use: two approvals race for one row and one wins.

A refused token (revoked, expired, its creator no longer an admin, or mistyped) gets one message from every `--remote` command:
"This token was revoked, has expired or its maker is no longer an admin there (or it is wrong). Create a new one in the console:
<url>". Names and messages from the server are printed without control characters, so a project name cannot rewrite the terminal.

`push` uploads each board's latest capture, its variants and its kept versions, then commits; the board switches to the new files all at
once. Comments stay. What a push sends about the board is only what the board shows (page ids, paths, titles, groups, notes, viewports,
journeys): never `auth`, storage states, login scripts, `actions` (a `fill` can hold a password), `waitFor`, or local paths.

The server treats every upload as untrusted, even from our CLI:

- File names must be ones the local tool writes, for pages and viewports on the pushed board.
- Live HTML runs through the same sanitizer as a local capture (`sanitizeDocument`, then the CSP meta tag) and the same 5 MB cap, with
  at most 4 MB of CSS per file. The sanitizer's scans run in linear time on any input.
- PNGs are decoded and re-encoded (which drops every chunk but the pixels), after a header check (at most 3840 x 8000, 16 megapixels,
  10 MB). Local viewports can be larger than 16 megapixels; those do not push.
- Cleaning runs in worker threads (2 at once, 32 waiting, 30 seconds and 512 MB each), never on the server's event loop; a token has at
  most 4 uploads in flight.
- The manifest and variants are rebuilt field by field; the board definition is validated by the same code as a local config.
- Limits: 5000 files and 1 GB per push, 500 pages per board, 10 boards per project (checked again at commit), 20 pushes per hour per
  token, and 5 GB per workspace (committed boards plus open pushes). A push is open for an hour; after that it takes no more files and
  a sweep (at start and every 10 minutes) removes its staging folder, staging folders without a push, and board folders a commit left
  behind.

## The board

`/w/<workspace>/p/<project>/` serves the same board client as `shapewall serve`, on an API with the same shape, for members of the
workspace. Comments are signed with the account's name and handle (the server sets them; the board shows the handle beside the name).
A token's replies are signed with the token's name and marked as an agent; the API ignores any `author` it sends. Captures from the board and editing journeys are off on a
hosted board (push again instead). Compare between environments is not hosted yet.

Live HTML is served from `/uc/...` through HMAC-signed URLs that expire after 2 minutes. The board API gives each new frame load a
fresh redirect. Guest URLs are bound to their share link and checked again on every load: revoking the link stops new loads immediately
(an already loaded frame keeps its document). Responses carry a CSP `sandbox` without `allow-same-origin`, no script source, and
`Cache-Control: private, no-store`. Frames use `sandbox=""`. Pins and click targets come from the captured element map on the authenticated
board API, which the server validates field by field on push, including its viewport dimensions (3 MB, at most 8000 elements).

For a separate cookieless domain, run `shapewall hosted --origin https://app.example.com --usercontent-origin https://example-content.net`
(or set `SHAPEWALL_USERCONTENT_ORIGIN`). Point both host names at this server through your TLS proxy, preserving Host. The content origin
serves only signed `/uc/` routes, ignores cookies and never sets one; the app origin refuses `/uc/`. Its CSP permits only the app origin
to frame documents. Use a separate registrable domain for a separate site; a second port or subdomain alone is a different origin, and
the opaque sandbox remains the main boundary. Separate usercontent must be https when the app is https.

The capture's base URL (often `http://localhost:...` on the machine that captured) is never sent to a hosted board, to members or
guests: page links and "open the site" use the board's `publicUrl` when the config has one, and are hidden otherwise. Variant sources
on the capture host become paths; broken links on the site become `publicUrl` links or paths, and the capture host is taken out of
broken-link and failed-shot error messages. (Links inside the pushed live HTML are cleaned at push time, not rewritten on serve.)

The board header links back to the project's console page for members. A viewer sees a note where Comment would be. When access ends
during a visit (a share link revoked or expired, the session ended, the account removed from the workspace), the board shows a banner
at the first refused request instead of failing quietly; opening a board you cannot reach shows the console's "You don't have access to
this board" page (still a 404), with "Sign in as someone else" and "Back to your workspaces". Guests' comments are text only: an
`@agent` in one is not a mention.

Comments and replies can carry up to 4 images (PNG, JPEG, WebP or GIF, 5 MB each) and a drawing (boxes, arrows and pen strokes), as
on a local board. The server checks each image by its bytes and cleans it in the same worker pool as pushed files (PNGs re-encoded,
metadata stripped from the others), then stores it in the database, not in the board folder, so a push never removes it. Images count
against the workspace's storage quota (a comment over it is refused with `quota_exceeded`, and pushes count them too) and are deleted
with their comment, project or workspace. They are served only to people who can see that comment, as images with `nosniff` and a
sandbox CSP, never as a page. Share link guests can draw but cannot attach images. Agents get each image and the drawing rendered on
its capture (`files.images`, `files.markup`) as token API URLs. The workspace export holds the images (`comment-files/`) and lists
them in `comments.json`; `shapewall share` moves a local comment's images (one request each, cleaned and counted like uploads) and
its drawing. Backups hold them, since they are in the database.

## Agents

```sh
export SHAPEWALL_TOKEN=swp_...
shapewall comments --remote https://app.example.com --json          # same JSON as local; files are URLs
shapewall comments reply 4 --body "Fixed in #12" --remote https://app.example.com
shapewall comments resolve 4 --note "Bigger button" --ref https://github.com/acme/site/pull/12 --remote https://app.example.com
shapewall watch --remote https://app.example.com --mention agent --exec "my-agent"
shapewall mcp --remote https://app.example.com
```

- `comments --remote` has every action the local one has (list, resolve, reopen, reply, status). `files.screenshot` and
  `files.liveHtml` are download URLs on the token API.
- Guest comments (from share links) are opt-in everywhere an agent touches them: listing (`--include-guests`, `?guests=1`, the MCP
  `includeGuests` argument) and acting on one (get, reply, status, resolve, reopen answer 403 `guest_comment` without it). The same
  goes for a guest's reply under a member's comment: an agent never receives it unless it runs with `--include-guests`.
- `watch --remote` runs until Ctrl+C (exit 0). A token that is refused, lacks a scope, or a board or project that is gone stops it with
  an error and a non-zero exit; network errors and restarts are retried. It polls every 3 seconds and claims each comment with a compare-and-set on the server, so several watchers on different
  machines never take the same comment. With `--exec`, the comment's screenshot and live HTML are downloaded next to its JSON under
  `.shapewall/remote/<project>/<board>/agent/`, so `SHAPEWALL_SCREENSHOT` is a local path as it is locally.
- `mcp --remote` is the stdio MCP server with the same tools as local minus `recapture_pages`. Tools that write appear only when the
  token has the scope. In an MCP client config:

```json
{
  "mcpServers": {
    "shapewall": {
      "command": "npx",
      "args": ["shapewall", "mcp", "--remote", "https://app.example.com"],
      "env": { "SHAPEWALL_TOKEN": "swp_..." }
    }
  }
}
```

Token API (`Authorization: Bearer swp_...`; cookies are ignored there): `GET /api/v1/project`, `GET /api/v1/boards/:board/pages`,
`GET /api/v1/boards/:board/comments?status=open|resolved|all&page=&mention=&guests=1`, `GET /api/v1/boards/:board/comments/:id`,
`GET /api/v1/boards/:board/files/:kind/:file`, `POST .../comments/:id/replies`, `POST .../comments/:id/agent-status`
(`{ agentStatus, onlyFrom }`), `POST .../comments/:id/resolve` (`{ note, fixRef, agentStatus }`), `POST .../comments/:id/reopen`,
and for push `POST /api/v1/pushes`, `PUT /api/v1/pushes/:id/files/:area/:name`, `POST /api/v1/pushes/:id/commit`.

Emoji reactions are for people: members and up toggle one with `POST /api/boards/:board/comments/:id/reactions`
(`{ emoji, replyId? }`, one of a fixed set of six) from the board. Viewers and guests cannot react (guests see counts only, never who
reacted), tokens have no reactions route and the token API leaves reactions out of what agents read. Reacting does not change a
comment's `updatedAt` or notify anyone.

## Moving to a new origin

Passkeys belong to a host name (the RP ID), so changing the server's address would lock everyone out. To move:

1. On the server's machine: `shapewall hosted move-origin --to https://new.example --data <dir> [--days N]` (1 to 30 days, default
   30). It records the move from the current origin and prints the next steps; `--status` shows it.
2. Point the new host name at the server and restart it with `--origin https://new.example --previous-origin https://old.example`.
   Passkeys made before the move keep their old RP ID (stored per passkey since migration 5).
3. On the old address, signed-in people see "This server is moving". "Move my sign-in" (after a passkey check) makes a one-time move
   link for their own account and opens `https://new.example/rebind#<token>`, where they create a passkey for the new host name and
   are signed in. The token is 32 random bytes in the URL fragment (never in a log), stored as SHA-256, works once, only for the
   account that made it, for 24 hours (never past the move's end), and a newer one voids it. Made in a fresh passkey session, the
   new passkey has no 24-hour hold. Admins never move anyone else's sign-in.
4. Someone who missed it signs in on the new address with their handle and a recovery code (codes have no host name) and adds a
   passkey; the normal 24-hour hold applies.
5. Best effort: the old address serves `/.well-known/webauthn` listing the new origin (WebAuthn Related Origin Requests), and the new
   sign-in page offers "Use a passkey from old.example". Browsers that support it let an old passkey sign in on the new address;
   the move link is the guarantee.

During the move the old address serves only sign-in, re-auth, the move page, the move link, the related-origins file, `/api/health`
and the token API (so CI tokens keep working); other writes answer 409 `server_moved` and every other page redirects (308) to the
same path on the new address. After the move ends it redirects reads; API and auth writes answer 409 `server_moved`.
Update `--remote` to the new address before the window ends. The CLI never forwards bearer tokens across an origin redirect.
Old-host passkeys show "For old.example" on the Account page.

## Security model

- **Tenancy.** Every tenant row (workspaces, memberships, invites, projects, boards, comments, tokens, share links, pushes, audit) has
  `workspace_id`, and every query on those tables goes through `tenant(db, workspaceId)` in `src/hosted/tenancy.js`. The handle binds
  `:ws` itself, refuses SQL whose WHERE does not start with `workspace_id = :ws` or that has `OR`, `UNION` or a second statement (or
  an INSERT that does not write `:ws`), and refuses missing parameters (which SQLite would otherwise bind as NULL). The only lookups that start without a workspace (a token or invite by its hash, a user's
  workspaces) live in that file; a test fails if any other hosted module queries tenant tables through the raw handle. A workspace or
  project you cannot see answers 404, never 403. Tests cover two workspaces with the same board id across the console API, the board
  API, signed URLs and tokens.
- **CSRF.** Cookie-authenticated writes need JSON and an `Origin` (or `Sec-Fetch-Site: same-origin`) equal to the configured origin,
  on top of SameSite=Lax. The token API ignores cookies.
- **Rate limits** (in memory, per process): passkey ceremonies 30 a minute per IP; wrong recovery codes 5 per 15 minutes per handle and
  IP, and 30 an hour per IP (right codes do not count, and nobody can use up another address's attempts); invite lookups 30 a minute
  per IP; bad tokens 20 a minute per IP; 1200 requests a minute per token; 20 pushes an hour per
  token; share link previews and opens 30 a minute per IP, wrong passcodes as above for recovery codes, 600 guest requests a minute
  per link, 30 guest comments an hour per link and IP; 600 public-project requests a minute per IP; 20 invite emails an hour per
  workspace.
- **Audit log.** Account events (sign-up, sign-in by passkey or recovery code, failures, passkeys, recovery codes, sessions, deleted
  workspaces) and workspace events (members, roles, invites, projects, tokens, share links and their guests, settings, pushes,
  resolved and deleted comments), with the user, token or share link and IP. Admins read the workspace log in the console.
- **Headers.** `nosniff`, `no-referrer`, COOP same-origin, `X-Robots-Tag: noindex`, HSTS on https, a strict CSP on the console and the
  board shell, `frame-ancestors 'none'` except for live HTML. The console has no inline script; its only inline styles are the ones
  Radix adds for dialogs and menus, allowed by a per-response nonce (`style-src 'self' 'nonce-...'`). It renders every value as text
  (React, no `dangerouslySetInnerHTML`).
- **DOM clobbering.** Live HTML keeps no `name` attributes (except `<meta name>`) and no `id` that matches a document or form method or
  a document property the board reads; the board calls `Document.prototype` methods on the frame's document through `.call`.
- **Agents.** `watch --remote --exec` does not pass `SHAPEWALL_TOKEN` to the command (it reads untrusted comment text) unless you add
  `--pass-token`, and checks project, board and comment ids before they become file names.
- **Behind a proxy.** `shapewall hosted` warns when the origin is https, it listens on loopback and `--trust-proxy` is off (rate limits
  would see every client as the proxy).

## Data and backups

```
<data>/shapewall.db            SQLite (WAL): accounts, workspaces, comments, tokens, audit
<data>/secret.key              HMAC key for signed URLs
<data>/setup-link              the first account's setup link (0600), until it is used
<data>/files/<ws>/<project>/<board>/   pushed captures, in the local layout
<data>/staging/<push>/         pushes in progress (swept after an hour)
```

Use the operator commands below for a consistent database and file copy. Copying the SQLite file alone, or copying files after an
unlocked database snapshot, is not a complete backup of a board.

**Migrations** run at start (`src/hosted/db.js`, `PRAGMA user_version`); each is additive. Back up before upgrading.

- **4** (hosted QA fixes): `invites.note TEXT` (the invite's note) and `users.security_seen_at TEXT` (when the account last dismissed
  the recovery-code notice). Rollback: an older build ignores both columns, so the simplest rollback is to run the older build on the
  same file and set `PRAGMA user_version = 3` (it then skips nothing it knows). To drop them as well (SQLite 3.35+):
  `ALTER TABLE invites DROP COLUMN note; ALTER TABLE users DROP COLUMN security_seen_at; PRAGMA user_version = 3;`. Notes and the
  "seen" time are lost; nothing else depends on them.
- **5** (hosted access): tables `device_logins` (pending `shapewall login` codes, hashed, results sealed), `guest_sessions` (one row
  per share link guest), `rebind_tokens` (move links, hashed) and `server_state` (the origin and a recorded move); columns
  `workspaces.public_projects`, `projects.public_id` (unique), `public_at`, `public_by`, `passkeys.rp_id` (filled with the current
  host name on first start) and `sessions.admin_seen_at`. Rollback: back up first. An older build ignores the new tables and columns,
  but its guest cookies are a different format (guests open their link again), pending device logins are lost, and public projects
  stop answering (their routes do not exist there). Run the older build on the same file while keeping `user_version = 5`;
  lowering it without removing migration 5 would make the next upgrade try to add its schema twice. To drop
  everything as well (SQLite 3.35+): `DROP TABLE device_logins; DROP TABLE guest_sessions; DROP TABLE rebind_tokens; DROP TABLE
server_state; DROP INDEX projects_public_id; ALTER TABLE projects DROP COLUMN public_id; ALTER TABLE projects DROP COLUMN
public_at; ALTER TABLE projects DROP COLUMN public_by; ALTER TABLE workspaces DROP COLUMN public_projects; ALTER TABLE passkeys
DROP COLUMN rp_id; ALTER TABLE sessions DROP COLUMN admin_seen_at; PRAGMA user_version = 4;`. Do not roll back during an origin
  move: the old build cannot serve the old address.

**Why SQLite through `node:sqlite`.** One host, one process, small metadata (images are files), so SQLite fits. `node:sqlite` ships with
Node, so the npm package stays free of native addons for the many people who only use the CLI; `better-sqlite3` would download or build a
binary for every install. The cost is Node 22.13+ for the hosted server and an ExperimentalWarning on Node 22, which `shapewall hosted`
hides.

## Before you invite the team

Try these on the real server, at its real address, before the team depends on it:

1. **Reach the same HTTPS server from two team devices.** Tailscale grants network access; Shapewall accounts and workspace roles
   grant application access. Keep sign-up invite-only, and allow only the intended peers in the tailnet policy. Leave Funnel off
   for a private team pilot.
2. **Create the owner account privately.** Read the one-time setup link locally, create a passkey and save recovery codes. Invite a
   second person as a member and another as a viewer; verify the member can comment and the viewer cannot. Neither can administer
   members or tokens. Test sign-out and return sign-in on the real desktop and phone, including any installed home-screen app.
3. **Move and work on a real project.** Capture locally, use `shapewall share` or `login` plus `push`, then see comments and cursor
   updates between two independently signed-in browsers. Check live HTML pins, follow/unfollow, mobile background/resume, and
   re-capture plus push. The local project picker is desktop-only navigation, not a phone hub or a team workspace.
4. **Verify the agent boundary.** Use a project-scoped token on the developer machine or CI. Confirm trusted dispatch and shell
   approval work, imported/guest comments stay inert, and revocation ends access. The hosted server does not run your agent or capture browser.
5. **Check operation and recovery.** Give the server a lifecycle independent of an interactive shell or coding-agent session. The
   foreground command stops when its process stops; example service/Compose files need deliberate operator setup. Probe `/api/health`
   from a second device, choose monitoring and backup arrangements, and restore a backup to a separate folder before relying on it.
   Do not start two hosted processes against one data directory. Record the data and immutable release to use for rollback.
6. **Try the passkeys your team uses.** Shapewall's tests use virtual authenticators, so check iCloud, Google or password-manager
   sync, hardware keys and phone autofill yourself, whichever the team will rely on. Origin migration is optional
   until the address changes, but preserve the old origin and recovery codes before attempting it.

A private tailnet server needs no separate usercontent domain and no public sign-up. Live HTML still uses an opaque sandbox and
signed, short-lived URLs. Decide retention and access before sharing sensitive work; the legal templates in `examples/hosted/legal`
are drafts for you to adapt, not terms anyone has agreed to.

## Before public hosting

These are additional operator tasks when exposing the service beyond the private team:

- Configure a separate, cookieless registrable domain with `--usercontent-origin` for live HTML.
- Configure Turnstile when sign-up is open or comment links are widely distributed; keep invite-only sign-up until then.
- Set quotas, test suspension, and provision storage for the expected workload. Agent claim budgets are already implemented separately.
- Review and adopt the draft legal text with the actual operator, contacts, regions and retention periods. Workspace export is capped at 3.5 GB.
- Set up backups, monitoring and restore drills for the public deployment. Commands and disabled timer examples are supplied, not enabled automatically.
- Record an independent security review and HTTPS real-device passkey checks for the chosen public origin and proxy.

MCP over Streamable HTTP, SSE events, quotas and the workspace kill switch are already implemented. Object storage is a later scaling
option when one disk no longer fits. Signed live HTML URLs are bearer links for up to two minutes; revoking a share stops new loads,
while ending one guest session may leave an already-issued URL valid for the remainder of that window. Rate limits are per process.

## Tailnet deployment (mode 1)

```sh
shapewall hosted --data ./hosted-data --tailscale --tailscale-port 8443
# Alternative invocation with optional public guest access (not a second server):
shapewall hosted --data ./hosted-data --tailscale --tailscale-port 8443 --funnel --funnel-port 443
```

These commands change Tailscale Serve/Funnel configuration. Run them only when you intend to expose this server. Install Tailscale,
connect the machine, enable MagicDNS and HTTPS certificates, and authorize your unprivileged user as a Tailscale operator first.
The console and passkey origin come from this machine's `*.ts.net` hostname. Do not also pass `--origin` or a non-loopback `--host`.
An occupied HTTPS port is refused, including an existing mapping to the same target. SIGINT/SIGTERM removes mappings this process
added only while they still match; after a crash inspect `tailscale serve status` and remove the stale mapping explicitly.

Funnel uses a second loopback listener and a different HTTPS port. It serves guest share pages, guest APIs, signed live HTML,
static assets, legal/report routes and health only. Console, sign-in, signup, device login, invitations, member APIs and token APIs
answer 404. Member session/ceremony cookies are discarded at that listener. Share links still require the secret in the link and
any passcode configured by the workspace. Funnel makes those guest paths public. Ports are not cookie boundaries, so never add
member routes to this listener. Tailscale policy/ACL configuration remains the operator's responsibility.

## Own domain deployment (mode 2)

```sh
shapewall hosted --setup --domain app.example.com \
  --usercontent-domain usercontent.example.net --dir ./deployment --source ./shapewall
```

This writes Compose, Caddy and a private `.env` file; it does not start containers or modify DNS. `--dry-run` previews the plan and
checks DNS. Point the names at the server, install Docker Engine and Compose, then review `.env` and Caddyfile. `--start` explicitly
builds and starts the Compose services and reads the first setup link privately from `/data/setup-link`. Never copy that link into
logs or monitoring. Manual equivalent: `docker compose up -d --build --wait`, then `docker compose exec shapewall cat /data/setup-link`.
W6's `hosted setup-link` command can rotate an expired link; use it locally with `--data /data` in the container.

The image is built from a checkout using `Dockerfile.hosted`. It contains no installed capture browser: users push captures from
local machines or CI. Data and backups are separate private mounts. Only Caddy publishes ports; the app trusts forwarded addresses
from the private Compose network. Review network access and secrets before production. The setup command needs a checkout with the
Dockerfile, client and lockfile; a packed npm installation must pass `--source` pointing to one.

Use a separate registrable domain for live HTML, not another subdomain of the app's domain. The usercontent Caddy site forwards
only `/uc/*`, discards incoming Cookie/Authorization and strips Set-Cookie. `--usercontent-origin` /
`SHAPEWALL_USERCONTENT_ORIGIN` support is required to issue URLs for that site; the template alone does not isolate same-origin HTML.
Staging stays gated and noindex; the commented Caddy gate example leaves guest routes outside the console gate intentionally.

## Operator commands and quotas

Run these on the machine that holds the data, as the data owner:

```sh
shapewall hosted admin list --data ./hosted-data
shapewall hosted admin suspend ws_ID --reason "Investigating an abuse report" --data ./hosted-data
shapewall hosted admin resume ws_ID --data ./hosted-data
shapewall hosted admin export ws_ID --out ./workspace.zip --data ./hosted-data
shapewall hosted admin reports --data ./hosted-data
shapewall hosted admin reports close rp_ID --note "Reviewed" --data ./hosted-data
shapewall hosted admin log --data ./hosted-data
# Destructive, requires the workspace's exact name:
shapewall hosted admin delete ws_ID --confirm "Workspace name" --data ./hosted-data
```

Suspension immediately refuses existing API tokens, new device approvals, invitations and guest links. Members can read and export
but writes return `workspace_suspended`. Resume restores the previous grants. Operator actions, including listing workspaces/reports and reading the log, are recorded in the
operator log; suspension/resume also enter the workspace audit log. The CLI is privileged filesystem access, not a web-admin role.
Do not give an untrusted workspace owner shell access to it. Reports remain private to the server operator.

`--quotas FILE`, or `<data>/quotas.json`, controls storage, projects, boards per project, members, active share links per project and
pushes per token per hour. Defaults: 5 GiB, 20 projects, 10 boards/project, 100 members, 20 links/project and 20 pushes/hour/token.
Valid edits reload within 5 seconds; invalid edits preserve the previous limits and log a validation error. Example:

```json
{
  "default": { "projects": 20, "storageGB": 5 },
  "workspaces": { "ws_000000000000000000000000": { "storageGB": 10, "members": 25 } }
}
```

Lowering a quota blocks new growth; it does not delete existing data. `storageGB` is binary GiB (1024 cubed bytes). Agent claims/day
limits belong to the agent policy, not this config. Rate limits are in-memory and reset on process restart: the console and board
APIs 1200 requests a minute per account (6000 for captures and other files), session requests 600/minute, device polling 60/minute,
plus the limits listed above. Run one hosted process per data folder.

## Retention, backup and restore

Current captures stay. By default retention keeps the newest two historical captures per page and viewport plus every historical
capture a comment references, open or resolved. Variants are left alone. It runs at start and every 6 hours in-process when the
operator starts the hosted server. `--retention-hours 0` disables it; `--retention-keep N` changes the default. To preview or run it:

```sh
shapewall hosted admin retention --run --dry-run --data ./hosted-data
shapewall hosted admin retention --run --data ./hosted-data
shapewall hosted admin retention ws_ID --keep 4 --data ./hosted-data
shapewall hosted admin retention ws_ID --keep default --data ./hosted-data
shapewall hosted backup --data ./hosted-data --to ./backups --keep-days 30
shapewall hosted restore --from ./backups --check
shapewall hosted restore --from ./backups --data ./restored-new-folder
```

Backup holds a SQLite write lock only for a `VACUUM INTO` snapshot and the list of board folders; captures are copied after it is
released, so reads and writes continue. A board pushed again while it is copied is copied again; boards and files deleted meanwhile
are skipped and listed under `files.skipped` in `backup.json`. The backup includes account data, passkey
public keys, captures, comments, audit records, signing key and default-path quota config. If the HMAC key is supplied as a systemd
credential or environment variable, give the backup command the same credential. Back up an external quota config separately.
Backup folders are mode 0700, files 0600, and checksums cover database/capture/key files. Treat them as sensitive as the live server,
encrypt offsite copies and test that you can recover them. Staging uploads and one-time setup links are excluded.

`--keep-days 30` deletes only recognizable older backup folders in the destination; it does not schedule anything. The example
backup service/timer is disabled until the operator explicitly installs and enables it. Installation never starts a backup timer.
A monthly manual restore drill should be logged by the operator. `restore --check` creates a scratch copy beside the backup, verifies
checksums, row counts, board folders and health, then stops its temporary server and removes the scratch copy. Automated tests also
sign in to a restored fixture with its software passkey; that does not verify real phones or hardware authenticators.

Restore refuses a nonempty target. Keep the original origin (passkeys depend on it), inspect the restored copy, then change the
runtime data pointer during an operator-approved maintenance window. Retain the previous release and data backup for rollback.
Project/workspace deletion removes active files immediately after database deletion; backup copies age out only under the chosen
backup policy. Operators must replay deletion requests after restoring an older backup.

### Migration 7 and rollback

Migration 7 adds workspace suspension/retention columns, operator log and abuse reports. A `schema_migrations` ledger records each
actually-applied migration so reserved 5/6 can land later without being skipped by a higher `user_version`. Legacy versions 1-4
are adopted into the ledger. Empty reservations are never marked applied. Back up before any upgrade and do not run a build that
uses empty migration placeholders against retained data.

For rollback, prefer the pre-upgrade backup in a fresh data folder and the previous immutable release. Merely running an older build
on the new database ignores additive columns but also removes suspension enforcement: keep affected workspaces blocked externally
until upgraded again. Do not drop the operator log or reset the ledger casually. Test rollback on a copy first.

## Secrets, logs and legal review

`SHAPEWALL_HOSTED_SECRET_FILE` and `RESEND_API_KEY_FILE` read private secret files. systemd `LoadCredential=shapewall-secret:...` and
`LoadCredential=resend-api-key:...` are read from `$CREDENTIALS_DIRECTORY`; explicit environment values take precedence. Setup links
are written to `<data>/setup-link` (0600) and not journaled. Caddy deletes Cookie, Authorization, Set-Cookie and signed `s` query
values from access logs. Invite/setup/share fragments are never sent in HTTP requests. App errors omit request values; email logs
contain status only. Do not enable debug request-body logging. Review any proxy/hosting logs outside these examples independently.

Fill `SHAPEWALL_HOSTED_TERMS_URL`, `_PRIVACY_URL`, `_AUP_URL`, `_SUBPROCESSORS_URL` and `_ABUSE_EMAIL` before inviting users. These
appear on sign-in/signup and guest pages, plus `/report`. The legal templates deliberately require an operator, contact, actual
hosting region, provider list and retention policy. Dan's review and any required counsel review remain release gates. No legal
text, Compose stack, Tailscale mapping, timer or staging deployment is activated by adding these files.

### Scoped hosted agents

The server never runs a model or an agent process. Capture and execution stay
on the developer's machine or CI. In a project's console, **Agent policy**
sets trusted workspace roles or handles, board overrides, `onlyMentions`,
claims per UTC day (50 by default), and open claims (3 by default). Zero stops
new claims. Policy changes require a fresh passkey. Removed members and changed
trust policy invalidate vouches immediately.

Use project tokens with `read, reply, status, claim` for runners. `reply` posts
agent replies, `status` changes their status, and `claim` takes dispatched work.
`resolve` separately allows resolving/reopening; `push` uploads captures;
`import` is reserved for the local-to-shared bridge. Old `comment` tokens map
to `reply,status`, without acquiring `claim`. Give CI only `push` when it does
not need to read the project.

A trusted member's new comment is vouched for automatically. **Send to agent**
vouches for the exact current text and anchor. Editing clears it, and both
**Send to agent** and **Approve agent run** refuse a comment that was edited
after you opened it: reload and read it again. Only admins set an agent status
from the board. Approvals and denials of an agent's commands are in the audit
log. Non-admin
requests need **Approve agent run**, with a trusted admin's fresh passkey, by
default. Guest and agent-written comments can never be dispatched, including
with `--include-guests`. Imported comments start inert and need an explicit
trusted vouch. Claim tokens see only dispatched comments, including direct-id
reads; guest replies are removed from their responses. Read tokens without
`claim` may inspect untrusted comments with the existing guest opt-in.

Claims use an atomic per-project budget and compare-and-set. Exceeding a budget
returns HTTP 429 `agent_budget`; another token cannot take over a live claim.
An operator suspension, token revocation, membership loss, changed trust or an
edited comment prevents subsequent requests. Shell approvals bind one exact
command and one claim generation, expire after two minutes and need a trusted
admin's fresh passkey. They cannot be reused on a later run of identical text.

`shapewall watch --remote` uses bearer-authenticated SSE at `/api/v1/events`,
with bounded polling fallback when a proxy does not support streams. Events
contain project/board identifiers, never comment text. Revoking a token through
the server closes its streams immediately; out-of-process database changes are
rechecked at the 15-second heartbeat. Streams are process-local and have no
replay log, so clients always refetch authoritative state.

MCP clients can use Streamable HTTP at `/mcp` with an `Authorization: Bearer`
project token, supplied from a secret store or environment. Never put it in a
URL. This stateless endpoint refuses Cookie headers and foreign Origin headers;
there is no shared MCP session or account authority. The same scoped tool set
as `shapewall mcp --remote` is available. A project selector cannot override the
token's project. Rotate/revoke tokens from the project's console.

### Move a local project to your team

Run `shapewall share --remote https://review.example.com` from the local project, or use **Profile > Share with your team...** through the
host's private settings link. Sign in on the destination's `/device` page, choose or create a project, and explicitly select **Import local
comments once**. Only workspace admins and owners can approve this grant. It starts unchecked and is removed when the move commits.
`shapewall share --remote URL --dry-run` reports counts without contacting the server. It cannot discover remote conflicts without a request.
Use `--board ID` for one board or `--no-comments` to push only captures, variants, history and journeys.

The move pushes the same stripped definition and capture allowlist as `push`, including board-created journeys. It imports comment and
reply history with remapped ids, anchors, state, agent status, resolution notes and reaction counts. Local display names receive an
`(imported)` label. They are plain text, never an attested account or handle; imported agent statuses and replies remain inert until a
trusted teammate explicitly sends the comment to an agent. Comments whose page disappeared remain stored as orphans with the reason
`page no longer on the board`. No agent settings, chat threads, keys, notification/GitHub configuration, paired devices, browser auth,
login scripts or page actions move.

Imports use batches of at most 200 comments and 1.8 MB below the endpoint's 2 MiB wire cap. Each batch and its idempotent retry result is
committed atomically. A final commit consumes the grant after all selected boards; retrying a lost final response is safe. Already imported
comments are skipped. A changed local comment updates an untouched remote copy. If the remote copy changed or was deleted, its version is
kept and the CLI lists the local ids and exits 2. It never merges text or silently overwrites a teammate's edits. Imports from two folders
remain distinct because only an opaque hash of the real project directory, board, local id and creation time identifies the source.

Finish or stop local agent/watch runs before a CLI move. The hosted copy preserves old `working` statuses as history; they do not represent an active hosted run. The host UI refuses a move while a local owner fix is running. Do not start a new local agent run while a move is in progress.

The local folder saves a private `remote/<origin-hash>/map.json` under its output directory (0600), containing ids and content hashes,
never credentials. Corrupt, unowned, publicly readable or symlinked maps are refused. Comments freeze under their normal write lock during
the move; failures restore the preceding local choice. A successful move displays the destination URL and defaults to read-only local
comments. The host can choose **Keep commenting here** to maintain an independent local copy. Captures and journeys stay writable, and
future captures continue through `shapewall push --remote URL`. This is a one-way move, not ongoing synchronization.

Reconnect the agent explicitly with `shapewall watch --remote URL --exec '<your-agent-command>'` or `shapewall mcp --remote URL`. Local agent
settings are never copied. Keep the remaining token scoped to the work that agent needs.

Migration 8 adds `device_logins.purpose`, the `import_author_kind`, `imported_by`, `imported_at`, `import_orphan`, `imported_reactions` comment columns, and the
`import_sessions`, `import_batches`, `comment_imports` tenant tables. Rollback requires restoring the pre-upgrade backup with the previous
release; do not discard imported comments or run an older server against the upgraded database.

## Live presence

Hosted boards show who is viewing, cursors in canvas coordinates and an avatar button to follow another viewer's camera. Move your own
canvas or press **Stop following** to leave follow mode. Phone controls keep 44-pixel targets. A share-link visitor is always shown as
**Guest** in presence, regardless of the name on their comments. Public boards show a viewer count only: no names, cursors, camera
positions or comment events. Counts represent open connections, including multiple tabs.

Presence uses Yjs awareness over the same host's WebSocket, with no shared document or persisted cursor history. The server assigns
awareness ids, names and colours. Clients can send only bounded cursor/camera coordinates, viewport mode and an open-comment id; they
cannot send arbitrary awareness updates, choose an identity or join a different room. Rooms bind workspace, project and board. Member
sockets require a live account-session cookie; share sockets require that share's live guest cookie. API tokens do not authenticate.
The handshake requires the exact application Origin and Host. Usercontent and the previous-origin listener cannot join these sockets.

The limits are 30 incoming messages/second, 1 KB/frame and 50 connections/board and 500 connections across the shared server hub, with a 60-second idle timeout and a bounded send buffer.
Clients send coordinate updates at most 20 times/second. Each incoming frame rechecks the session, membership, project, board and
share/public switches. All connections are rechecked every five seconds, and recipients of comment invalidations are checked again
before delivery. Thus a revoked silent connection may receive cursor updates for at most five seconds; its next frame is refused
immediately. Recipient authorization is cached between sweeps for cursor fan-out, avoiding a database lookup for every recipient of
every pointer movement. Comment notifications carry only ids and make the client refetch through its normal authorized API.

The primary server and a configured Funnel guest listener share one in-process room hub and event bus. The guest listener accepts
only share-cookie sockets, and cannot upgrade a console/member/public route. Shutdown removes listeners, sockets and awareness timers.
Caddy and Tailscale Serve must forward WebSocket upgrades. Actual proxies, physical phones and background-mobile behavior still need
an operator smoke test. Cursor tracking pauses over an opaque live iframe while its text-selection interaction owns the pointer.
