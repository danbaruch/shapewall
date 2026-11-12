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

**Renaming a token.** An agent that watches a hosted board signs its comments and replies with its token's name (for a terminal
login, "laptop (shapewall login)"). **Rename** on the token lists (the project page and **API tokens**) gives it a human name:
`PATCH /api/workspaces/:ws/projects/:pid/tokens/:tid` with `{ "name": "..." }`, 1 to 60 characters, for the same people who may revoke
it (admins and owners). The secret, the scopes and the expiry do not change; what the token already wrote keeps the old name; a
revoked token is not renamed; the audit log records `token_renamed` with both names. A token that may take work is an agent with an
icon, a state and rules of its own: see [Agents on a hosted board](#agents-on-a-hosted-board).

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
  `comments.json` and its files (captures, variants, versions, live HTML), and `chats.json` when the board has chat with a
  [connected agent](#connected-agents): the threads every member reads (the board's and each comment's) with their messages. A
  member's own chats are not in the copy; the file says how many there are. Over 3.5 GB it answers 413 (no zip64 yet). `audit.json` holds
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
- **Which agents are online?** A comment sent to an agent is only picked up while some machine runs `shapewall watch --remote` (or
  an MCP client) with a token of the project that has the `claim` scope. Each such token is an agent
  ([Agents on a hosted board](#agents-on-a-hosted-board)). The server remembers, in memory, when each one last called the API or held
  its event stream open; for 90 seconds after that the agent is online. Members who can send comments to an agent see every agent
  by name with its state in the board's Agent panel (the Agent button in the top bar; on a phone, **Agents** in the More menu), in
  the button's tooltip ("Builder online, Fixer offline") and on the thread. Only names, faces and times are told, never a token, and
  never to share link guests or public viewers. After a restart every agent reads offline, with the last time it was seen, until
  its next call.
- **Removing a board.** A board pushed by mistake, or one you retired, comes off the server on the project page: "Remove board"
  on its row in the Boards list, for the same people who may delete the project (admins and owners, with a fresh passkey check).
  It deletes that board's captures, page history, variants, checks, comments, replies and comment images, and frees their storage;
  the project, its other boards, its tokens and its share links stay. A later push of the same board id starts a new board: the
  captures are back, the comments are not. The audit log records who removed which board, and people who have the board open are
  told at once (`board.removed` on the event stream). API: `DELETE /api/workspaces/:ws/projects/:pid/boards/:bid`.
- Limits: 5000 files and 1 GB per push, 500 pages per board, 10 boards per project (checked again at commit), 20 pushes per hour per
  token, and 5 GB per workspace (committed boards plus open pushes). A push is open for an hour; after that it takes no more files and
  a sweep (at start and every 10 minutes) removes its staging folder, staging folders without a push, and board folders a commit left
  behind.

## The board

`/w/<workspace>/p/<project>/` serves the same board client as `shapewall serve`, on an API with the same shape, for members of the
workspace. Comments are signed with the account's name and handle (the server sets them; the board shows the handle beside the name).
A token's replies are signed with the token's name and marked as an agent, with its agent's icon beside them; the API ignores any `author` it sends. Captures from the board and editing journeys are off on a
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

### Agents on a hosted board

Every project API token with the `claim` scope is an **agent**: a named thing the board lists, that people choose when they send a
comment, with a state and rules about who may use it. Nothing changes on the machine that runs it: `shapewall watch --remote` and
`shapewall mcp --remote` work as before, with the same token, and need no new flag. The server still never runs an agent.

- **Name and face.** The agent's name is its token's name. In the console (**Agents**, then the project) **Edit** changes the name
  (1 to 40 characters, one line), picks one of the built-in icons and a colour, and says what runs behind it (Claude Code, Codex,
  goose, Gemini CLI, another program, or an unknown watcher). A known program shows its mark until you pick an icon; a watcher
  whose command is unknown shows its initials. The agent's replies on a thread wear its face. A token made with `shapewall login`
  keeps the machine's name as a label.
- **State.** Online (heard from in the last 90 seconds; a [connected agent](#connected-agents): while its link is open), working
  (online and holding a comment it took, or answering in a chat), offline (with the last time it was seen) or revoked (its token was
  revoked or expired, or its maker is no longer an admin).
- **Sending a comment to one agent.** **Send to agent** on a thread is a split button: the main part names the project's default
  agent, the caret lists every agent with its state, and **Any agent** hands the comment to whichever takes it first (what every
  comment did before 0.4.0). A comment sent to one agent can only be taken by that agent's token. The other tokens of the project do
  not see it at all: not in lists, not by id, not through MCP.
- **The default agent.** An admin or owner picks it on the project's Agents page (**Make default**). It is what the main part of
  Send to agent names, and where a trusted member's new comment goes (such a comment is sent as it is written). Without a default,
  and for people the default does not take work from, comments go to any agent. A project starts with no default.
- **An agent that is offline.** The comment waits for it, and the thread and the Agent panel say so: "Waiting for Builder (offline,
  last seen 2 hours ago)". Nothing is lost: when the agent is back it takes what was sent to it. **Let any agent take it** hands the
  comment to whichever agent is free; **Choose another** sends it to a different one. Revoking an agent sends what waited for it to
  any agent.
- **Who may send it work (the audience).** Work sent to an agent runs on the machine of the person who connected it, so each agent
  says whose work it takes:

  | Audience                                    | Takes work from                                                               |
  | ------------------------------------------- | ----------------------------------------------------------------------------- |
  | Only the person who connected it            | That person. **The default for every agent made from 0.4.0 on**               |
  | Named members                               | That person and the members you choose                                        |
  | Everyone this project's agent policy trusts | The team case: whoever may send work to an agent here at all may use this one |

  The audience only narrows: the project's **Agent policy** still decides who may send work to an agent at all. The server checks it
  twice, when the comment is sent (and when an admin approves someone else's run) and again when the agent's token takes it, against
  the person whose approval stands on the comment. The audience also decides whose replies the agent reads: a reply from someone it
  does not take work from never reaches its token, however trusted they are by the agent policy. An audience governs new work: a
  comment the agent already holds stays its own until it finishes, even if the audience is narrowed meanwhile, and sending a comment
  again while an agent works on it changes nothing. On the board, an agent you may not use is listed, greyed, with the reason ("Only
  Ada can send work to Builder. Ask them, or an admin, to share it."). Changing an audience asks for a fresh passkey check.
  **Tokens that already had the `claim` scope before 0.4.0 keep the behaviour they had**: everyone the agent policy trusts. The
  console marks them "kept from before 0.4.0".

- **Approvals.** Each agent has an approval rule and two roles: who may answer its approvals, and who may change the rule (admins and
  owners, or owners only; only an owner changes those two). The rule in effect is **Ask every time** unless the agent's own machine
  says otherwise: what an agent asks to do waits for a person with that role and a fresh passkey check. **Allow without asking** is
  listed as not available until the agent's own machine names what may go without asking (`shapewall agent connect --approvals
owner --auto edits`, on that machine). It is never the default and is never possible on the server's say alone. A
  [connected agent](#connected-agents) reads and answers only until its machine switches edits on
  ([Edits from the board](#edits-from-the-board-the-trust-decision)).
- **Revoke.** Revoking an agent revokes its token (and revoking the token on the Tokens page revokes the agent). What it was working
  on loses its "working" status and goes to any agent, with what waited for it; its usage records close as "revoked"; the project
  loses it as default. The same happens when an agent stops working by another road (its token expired, its maker was removed or is
  no longer an admin), the next time it would be seen. The audit log has one `agent_queue_released` entry per comment.
- **The workspace overview.** **Agents** in the workspace menu (admins and owners) lists every agent of the workspace: the project
  it serves, its state, when it was last seen, who may send it work and who connected it, with a link to manage each. An agent
  belongs to one project; a machine that works on two projects has two tokens and so two agents.
- **Audit.** `agent_created`, `agent_first_seen`, `agent_renamed`, `agent_identity_changed`, `agent_default_changed`,
  `agent_audience_changed`, `agent_approval_rule_changed`, `agent_revoked` and `agent_queue_released` are in the workspace's audit log
  with what it was before and after.
- **Usage records.** For every comment an agent takes, the server writes one row: who asked, which agent, project, board and comment,
  when it started, when it ended and how (done, needs a person, resolved, released). No comment text and no answers. This is the
  groundwork of a usage page; there is nothing to look at yet, and the rows go with their project.

There are two ways to connect one, on the machine that has the code. An agent members **chat with** (it reads the project and
answers; when its machine says so, it also makes a fix on a branch, each edit allowed on the board;
[Connected agents](#connected-agents)):

```sh
shapewall agent connect --remote https://wall.example.com   # approve in the console: name it, choose the project and who may use it
```

An agent that **fixes comments by itself** (a watcher: it runs your command once for each comment sent to it):

```sh
shapewall login --remote https://wall.example.com     # approve in the console, choose the project, tick "Take agent work"
shapewall watch --remote https://wall.example.com --exec "<your agent command>"
```

Either appears on the project's Agents page as online. Give it a name and an icon there, and choose who may send it work.
[Agent recipes](agent-recipes.md) has the commands for Claude Code, Codex and goose. One machine can run both, each with its own
token.

Console API (admins and owners): `GET /api/workspaces/:ws/agents`, `GET /api/workspaces/:ws/projects/:pid/agents`,
`PATCH .../agents/:aid` (`{ name, icon, tint, kind }`), `PUT .../agents/:aid/audience` (`{ audience: "owner" | "members" | "trusted",
users }`), `PUT .../agents/:aid/approval` (`{ rule, changeRole, answerRole }`), `PUT .../default-agent` (`{ agentId }`, `null` for
none) and `DELETE .../agents/:aid`. Board API (members): `GET /api/boards/:board/agents`, `POST .../comments/:id/send-to-agent` takes
`agentId` (an agent's id, `null` for any agent; left out, the default agent) and `POST .../comments/:id/release-agent` lets any agent
take a comment that waits for one.

## Connected agents

A **connected agent** is a coding agent on a machine that has the project's code, joined to a hosted project so that members can
chat with it on the board. In this release that agent is Claude Code ([which agents](#which-agents-can-be-connected)). One command
connects it:

```sh
cd ~/projects/site                                   # the project's folder, on the machine that has the code
shapewall agent connect --remote https://wall.example.com
```

1. **The first run asks for an approval.** The command prints a short code and the address of the server's `/device` page. An admin
   or owner of the workspace opens it, types the code, and sees "Connect an agent": the machine's name, the address it asked from,
   and which agent it says it runs. They give the agent a name and an icon, choose the project, and choose who may use it. **Only
   me** is the default. Approving asks for a fresh passkey check.
2. **The machine gets the agent's own token.** It is saved on that machine and never printed. The next run of the same command needs
   no approval.
3. **The agent comes online.** It shows in the board's Agents panel and on the project's Agents page for as long as the command
   runs: its state comes from its open link to the server, not from a timer. Ctrl+C disconnects it.
4. **Members chat with it.** The Agent button on the board opens the Agents panel. **Chat** on a connected agent opens a chat with
   it in the same panel a local board has: the answer streams in, with the agent's steps.

**By default a connected agent reads and answers. It does not change files and it runs no commands.** The machine that runs it
enforces this, whatever the server sends, in two ways. The agent's own controls are set so that it cannot act: its session starts
without your settings files and with only its reading tools
([read-only by the agent's own controls](#read-only-by-the-agents-own-controls)). And Shapewall offers it no way to write a file
or open a terminal, and refuses every permission request it makes on the spot. The answer then shows what was refused ("Refused:
read and answer only"), and nobody is asked. If the session cannot be made read-only, the agent is not started. When a change is
needed, the agent says what to change and where.

**Edits are switched on only on the machine that has the code** (Shapewall 0.6.0). Started with `--approvals owner` or
`--approvals admins`, the agent can make a fix for a comment: on a new branch, in a folder of its own, never in the checkout, and
each edit is a card with the full diff that a person allows or denies on the board
([Edits from the board](#edits-from-the-board-the-trust-decision)). Chat stays read and answer only either way. A connected Claude
Code runs no commands from the board in this release. `shapewall watch --remote --exec` is unchanged, and stays the way for an
agent that fixes comments with nobody in between.

The server still never runs an agent. It stores the conversation and passes messages between the browser and the agent's machine.

### Which agents can be connected

Only **Claude Code** is offered by `agent connect` in this release. An agent is offered when its own controls were shown, with its
real adapter, to keep a read-only session from editing, running commands and reading outside the project. Refusing what an agent
asks for is not enough when it does not ask.

| Agent       | `agent connect`         | Why                                                                                                                                                                                                    |
| ----------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code | Yes                     | Started with only its reading tools and none of your settings files, it created no file, ran no command, and asked before reading outside the project                                                  |
| Codex       | Refused, with a message | Started in its read-only sandbox it changed no file in our check, but it still ran shell commands and read a file outside the project without asking. What it reads can leave the machine in an answer |
| goose       | Refused, with a message | Its chat-only mode could not be verified on the test machine                                                                                                                                           |
| Gemini CLI  | Refused, with a message | It was not installed to verify                                                                                                                                                                         |

The same rule holds for an agent saved on the machine: it can be connected only when its command starts Claude Code. For Codex,
goose and Gemini CLI, `shapewall watch --remote` stays the way to work on a hosted board. How the check was done is in
[agent-hardening.md](agent-hardening.md#connected-agents).

The same test decided what a fix session gets. A Claude Code session for a fix has its reading tools and its editing tools, and
no shell tool: started with the shell tool, Claude Code ran commands it takes to be read-only (`ls`, `cat`) without asking anyone,
and those can read outside the project. So commands from the board are not offered for Claude Code in this release
([Commands](#commands-are-not-offered-for-claude-code)).

### The connect command

| Flag                              | Default                                           | Meaning                                                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--agent NAME`                    | This project's agent, else Claude Code when found | `claude`, or the id of an agent saved on this machine that runs Claude Code. Never a command from the server                                                                                                                       |
| `--name "Builder"`                | The agent's own name                              | The name to suggest on the approval page. The approver has the last word, and an admin can rename it later                                                                                                                         |
| `--as NAME`                       | `default`                                         | A second connection from this machine, with a token of its own                                                                                                                                                                     |
| `--audience owner\|server`        | `server`                                          | `owner`: the server is asked to keep it to the person who connected it even if its audience there is widened, and this machine refuses a job the server labels as someone else's. `server`: its audience on the server             |
| `--approvals none\|owner\|admins` | `none`                                            | Edits from the board. `none`: never, the agent reads and answers only. `owner`: the person who connected it may allow each edit. `admins`: whoever the server lets answer (admins by default)                                      |
| `--auto none\|edits`              | `none`                                            | What the server's "Allow without asking" rule may apply to. `none`: every request waits for a person. Needs `--approvals owner` or `admins`                                                                                        |
| `--allow-path FILE`               | None                                              | A file that runs something, which the agent may ask to edit (a dotfile, `package.json`, a `Makefile`, a `Dockerfile`, CI config). Such an edit is refused on the machine otherwise. Adds one file per run; `none` empties the list |
| `--base BRANCH`                   | `head`                                            | The branch a fix starts from. `head`: the commit the checkout is on, and then only while the checkout has no uncommitted changes to tracked files                                                                                  |
| `--git-remote NAME`               | `origin`                                          | Where a finished fix is pushed. `none`: never pushed                                                                                                                                                                               |
| `--takeover`                      |                                                   | Close the link another process holds for this agent, and take its place                                                                                                                                                            |
| `--concurrency N`                 | 2                                                 | Answers at once, 1 to 4                                                                                                                                                                                                            |
| `--token-file FILE`               |                                                   | For a service: the agent's own token from a file, no browser                                                                                                                                                                       |

`--approvals`, `--auto`, `--allow-path`, `--base` and `--git-remote` are saved for the connection, so the next run without them
keeps what was set. They are explained under [Switching edits on](#switching-edits-on). `--allow-command` is listed by
`shapewall --help` and is refused for Claude Code ([Commands](#commands-are-not-offered-for-claude-code)).

- **Which program runs** is the machine's choice: an agent saved for this project on that machine, or Claude Code found on its
  `PATH` with its ACP adapter, the same detection a local board uses ([agents.md](agents.md)). Codex, goose, Gemini CLI, a saved
  agent that runs one of them, a program Shapewall does not know and a model endpoint are all refused with a message. Nothing the
  server sends names a command, an argument, a folder or an environment variable.
- **`--audience owner` trusts the server's label.** The machine cannot check who really asked: it sees only what the server says
  about a job. So this setting holds against a later change of the audience on the server, and does not protect against a
  compromised server.
- **One link per agent.** One `agent connect` process holds an agent's link. A second one on the same token is refused by the
  server, and the command exits with an error that names the machine already connected and since when. `--takeover` closes the
  other link first; the process that lost it prints that another connect took over, and exits 0.
- **The folder it reads** is the one the command runs in (the folder of `shapewall.config.json` when there is one). The agent
  process starts with a small environment and never gets `SHAPEWALL_TOKEN` or any other `SHAPEWALL_*` variable.
- **The token** comes from `SHAPEWALL_TOKEN`, then `--token-file`, then the one saved by an earlier approval. It must be a connected
  agent's token: the login saved by `shapewall login` is never used, and a plain project token is refused with a message.
- **Files on the machine.** The token is kept in `credentials.json` in Shapewall's config folder (`$XDG_CONFIG_HOME/shapewall`, by
  default `.config/shapewall` in your home folder), under `agents`, by server and `--as` name, apart from the login `push` and
  `watch` use. What the machine allows (`--audience`, `--approvals` and the flags that go with it) is remembered in
  `agent-policy.json` beside it, one entry per server and `--as` name. Both files are readable by you only (0600), are outside
  every repository, and the server cannot change either.
- **Ending.** Ctrl+C or SIGTERM stops the answers in progress, closes the agent and exits 0. A token the server refuses (revoked,
  expired, or its maker is no longer an admin) ends the command with exit 1; a saved token is then removed, so the next run asks for
  a new approval.

One connection serves one project. A machine that works on two projects connects twice, each in its own folder (`--as docs` for the
second on the same server). Connecting one agent to every project of a workspace in one step is not in this release; the workspace's
**Agents** page lists every agent and the project it serves.

### What a connected agent's token may do

Approving a connection makes a project token with a fixed set of scopes: `read`, `reply`, `status`, `claim` and `agent`. It reads
comments sent to it, replies as itself, sets agent statuses, takes work and holds the link. It never has `resolve` or `push`,
whatever the approval asks for.

The `agent` scope opens the link routes and nothing else. It cannot be ticked on an ordinary token in the console or at
`shapewall login`; it comes from approving `shapewall agent connect`. A token with `claim` but without `agent` (a `watch --remote`
watcher) is an agent as before, with no link and no chat.

### Chat with a connected agent

- **Threads.** The **board chat** and the chat of each comment are shared: every member of the workspace reads them. A chat you
  start with **Chat** (or **New chat**) is yours alone: nobody else reads it, lists it, writes in it or stops it, an admin included.
  Agent transcripts can quote source code, so viewers, share link guests and public visitors have no chat at all.
- **Who may ask.** A member the project's agent policy trusts, who is in the audience of the thread's agent, while that agent is
  online. Everyone else can read a shared thread, and sees why they cannot write in it ("Only Ada can use Scout").
- **One answer at a time** in a thread. A second message while one is being answered is refused; the panel queues it for you.
- **Stop** ends the answer. The person who asked, the person who connected the agent, and admins may stop it.
- **A turn outlives the tab that started it.** Reload, or open the same shared thread as a second person: the running answer is
  replayed from its start, in order, and then followed live. A viewer whose stream drops resumes from the last event it has and
  misses nothing. Closing the tab does not stop the agent; Stop does.
- **A thread stays with its agent.** The chip in the chat's header lists the project's connected agents with where each runs, or
  why you cannot use it. You can point a thread only at an agent you may use yourself, and a thread never moves to another agent
  by itself. Switching a thread that has messages adds a line to it: who switched it, from which agent to which. Only then does
  the other agent get the thread: the messages of people it takes work from, and none of the first agent's answers.
- **History** is kept on the server: the person's messages and the agent's answers with their steps. It counts against the
  workspace's storage quota, is in backups, and goes when its board or project is deleted. Rename, archive and delete your own
  chats from the chat history; a shared thread is cleared only by an admin. A thread keeps its newest 200 messages.
- **"@" mentions and text files** work as on a local board: a page, a comment, an element, a journey or a person, and up to three
  text files with a message. Images are not sent to a connected agent yet. Editing a sent message, asking again for an answer, answer
  ratings and the model and effort menus are not on hosted boards yet either.
- **A chat message never edits.** Whatever a message says, and whatever the agent's machine allows, a chat turn is read and answer
  only. Only **Fix with** on a comment starts a turn that may edit ([Fix with an agent](#fix-with-an-agent)).

### Who may use a connected agent

The audience rules of [Agents on a hosted board](#agents-on-a-hosted-board) apply to chat exactly as they do to comments, and the
project's agent policy still decides who may use any agent at all. On top of them:

- **The machine can narrow it.** Started with `--audience owner`, the agent's machine asks the server to keep the agent to the
  person who connected it, even if its audience there is widened later. The server refuses everyone else, the machine refuses a
  job the server labels as someone else's, and the board says what is in effect: "Only Ada (set on the agent's own machine)". The
  machine cannot check that label, so this does not protect against a compromised server.
- **A shared thread is not a way around an audience.** What reaches an agent is only what people in its audience wrote, and its own
  earlier answers. A message by someone outside its audience stays in the thread for people to read and is never sent to that
  agent; nor are another agent's answers. The same goes for replies on a comment.
- **Comments follow the audience too.** The board context an agent gets with a question holds a comment only when the person
  asking wrote it, or the agent holds it, or its author is in the agent's audience and the comment was sent to an agent and not
  to another one. That is what the token API would show that agent's token. The same rule decides the comment of a comment's
  thread and what an "@" mention of a comment carries: a mention of a comment the agent may not read keeps only its number.
- **A share link guest's text never reaches a connected agent**: not their comments, not their replies, and not through a
  mention.

### Comments sent to a connected agent

A comment sent to a connected agent **by name** (Send to agent, or the project's default agent) is read and answered by it: it
takes the comment, answers in the comment's chat thread where everyone can watch, posts the answer as a reply signed with its name,
and sets the agent status to done. It never resolves a comment, and Send to agent never edits. When it cannot answer, it says so
in a reply and marks the comment as needing a person. For a change to the code, press **Fix with** on the comment
([Fix with an agent](#fix-with-an-agent)), when the agent's machine takes edits.

A comment sent to **any agent** is left alone by connected agents: it stays with the `watch --remote --exec` watchers that fix
comments by themselves. So do not make a connected agent the project's default agent while you rely on watchers to fix new
comments: every trusted member's new comment would go to an agent that answers it and waits for someone to press Fix.

### Edits from the board: the trust decision

A fix runs on someone's machine, with their login, for a comment other people wrote. So the question is: **who may make someone
else's machine change files?** By default, nobody. Even the person who connected the agent cannot allow an edit from the board
until they said so on that machine.

| Level                                                           | Where it is set                                                                   | Default                              | What the board can cause                                                                                                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Audience "only the person who connected it", `--approvals none` | The audience at the approval; `--audience owner` pins it from the machine         | Yes                                  | That person asks. The agent reads the project and answers                                                                                                                |
| Audience: named members, or everyone the agent policy trusts    | On the server: the approval page, or the Agents page                              | Opt-in                               | Those members may ask too. Still read and answer only                                                                                                                    |
| `--approvals owner`                                             | On the machine                                                                    | Opt-in                               | A fix on a new branch. Each edit waits for the person who connected the agent                                                                                            |
| `--approvals admins`                                            | On the machine                                                                    | Opt-in                               | A fix on a new branch. Each edit waits for someone with the agent's answer role (admin by default), in its audience and trusted                                          |
| "Allow without asking"                                          | On the machine (`--auto edits`), and then the agent's approval rule on the server | Opt-in, twice                        | Edits to ordinary source files go into the fix without a person. The fix stays on the machine: it is pushed only after a person allows "Push this fix" on its whole diff |
| Commands                                                        | On the machine (`--allow-command`)                                                | Not offered for Claude Code in 0.6.0 | Nothing: a fix session of Claude Code has no shell tool                                                                                                                  |

The machine's choice is the ceiling. The server can only narrow it: an audience, an answer role, a rule that asks. It can never
widen it.

### Switching edits on

On the machine that has the code, in the project's folder:

```sh
shapewall agent connect --remote https://wall.example.com --approvals owner     # the person who connected it allows each edit
shapewall agent connect --remote https://wall.example.com --approvals admins    # whoever the server lets answer
shapewall agent connect --remote https://wall.example.com --approvals none      # back to read and answer only
```

- **`--approvals owner`** takes an "allow" only from the person who connected the agent. The server enforces it, and the machine
  checks it again on every answer.
- **`--approvals admins`** takes it from whoever the server lets answer: the agent's answer role (admin by default; an owner can
  make it owner), who is also in the agent's audience and trusted by the project's agent policy.
- **The choice is saved** for this connection in `agent-policy.json` on the machine, beside the saved token. A service that runs
  the plain command keeps it. `--approvals none` switches it off again.
- **`--auto edits`** names what the server's "Allow without asking" rule may apply to. Without it every request waits for a
  person ([Allow without asking](#allow-without-asking)).
- **`--allow-path FILE`** lets the agent ask to edit one file that runs something. Without it, an edit to such a file is refused
  on the machine and never becomes a question ([Files that run something](#files-that-run-something)). Each run adds one file;
  `--allow-path none` empties the list. `.git` and Shapewall's own store can never be named. An allowed path always gets a card
  a person answers, whatever the approval rule says, and a fix that changes it is not pushed from the machine.
- **`--base BRANCH`** is where a fix starts. Without it a fix starts from the commit the checkout is on, and a checkout with
  uncommitted changes to tracked files refuses the fix, because the fix would silently leave them out. `--base main` always starts
  from that branch, whatever the checkout holds. `--base head` goes back to the default.
- **`--git-remote NAME`** is where a finished fix is pushed (`origin` by default). `--git-remote none`: never pushed.

`agent connect` prints what is in effect when it starts. The console's Agents page and the board's Agents panel say which mode an
agent is in: "Reads and answers", "Edits on a branch, each allowed by the person who connected it" (or "an admin", or "an
owner"), or "Edits on a branch, allowed without asking".

### Commands are not offered for Claude Code

The link and the machine's policy file know a third thing an agent could ask: to run one exact command from the machine's own
list, each run allowed on the board (`--allow-command`). **This is not available for Claude Code in Shapewall 0.6.0, and Claude
Code is the only agent `agent connect` offers.** So no connected agent runs a command from the board in this release.

The reason was found with the real adapter. Started with its shell tool, Claude Code runs commands it takes to be read-only
(`ls`, `cat`) without asking anyone, and those can read outside the project. A list of allowed commands does not help when the
agent does not ask. So:

- a fix session of Claude Code gets no shell tool at all;
- `--allow-command` is refused for it, with that explanation;
- commands written by hand into `agent-policy.json` are not in effect, and `agent connect` says so when it starts.

### Fix with an agent

On a hosted comment, **Fix with Builder** is offered when Builder's machine takes edits and you may use Builder. The agent must be
online: a fix cannot be queued for an offline agent (Send to agent still queues). For an agent that reads and answers only the
button is not offered, and one line says why: "Builder reads and answers only. Edits are switched on on its own machine".

Pressing it takes the comment in the agent's name and opens a turn in the comment's chat thread, where everyone can watch. The
rules are the ones for sending a comment to an agent, unchanged:

- a trusted member vouches for the text they saw (a comment that changed since you opened it is refused: read it again);
- a non-admin's run still needs an admin's **Approve agent run** where the agent policy says so. Fix makes that one flow: an
  admin's Fix is also their approval (with their passkey) and starts at once; a member's Fix sends the comment for approval,
  where admins see **Approve agent run** on it, and says to press Fix again once it is approved;
- the agent's audience decides whose comment it takes;
- the project's daily runs and its open-claims limit count a fix like any other claim;
- one agent at a time: a comment that is already with an agent is refused.

The agent reads the comment as quoted, untrusted data, as always. Stop ends the fix, and cancels any card that waits.

### Where a fix is made

**Never in the checked-out tree.** The checkout is only read (`git status`, `git rev-parse`).

1. **A fresh copy of the base commit**, with no `.git` in it, in a folder outside the project: under your state folder,
   `$XDG_STATE_HOME/shapewall/agent-fixes/` (by default `.local/state/shapewall/agent-fixes/` in your home folder). It is made by
   the same code as a local board's [Work on a branch](agents.md#work-on-a-branch). That folder is never inside the project: when
   it would be (the project is your home folder, say), `agent connect` and the fix refuse and say to set `XDG_STATE_HOME` to a
   folder outside it. A relative `XDG_STATE_HOME` is ignored.
2. **The agent edits that copy**, one allowed edit at a time ([Permission cards](#permission-cards)).
3. **Shapewall itself commits the result** on a new branch, `shapewall/comment-<n>-<slug>`, with the repository's own author. No
   hook, filter or attribute runs. The comment's text in the commit subject is made inert first: no "@name" pings anyone and no
   "Fixes #12" closes anything.
4. **The commit is kept only if it is exactly what was allowed.** Every changed file must have had an allowed edit and must hold
   exactly the bytes that were shown, with the file mode it had (a new file is not executable). Every allowed file must be in the
   commit. Nothing may be removed. A changed edit, an extra file, a mode change, a deletion, an allowed file Git left out: the
   branch is taken back and the thread says "Nothing was committed", with the files.
5. **The branch is pushed** to the machine's remote when three things hold: the machine has that remote, the change touches no
   file that runs something ([Files that run something](#files-that-run-something)), and a person saw every edit. Otherwise it
   stays on the machine and the thread says why: "Not pushed", or, for a fix with an edit that went without asking, a
   **Push this fix** card ([Allow without asking](#allow-without-asking)).
6. **A pull request is opened** when [GitHub connect](github.md) is set up on that machine. Otherwise the thread and the comment
   say "Fix ready on branch" with the name to copy. The link is shown as a link only when it is a pull request URL on github.com;
   on another GitHub host it is shown as text.
7. **The folder is removed.** The branch stays.

A fix is refused before it starts, with a clear sentence in the thread and on the comment, when the project folder is not a Git
repository, has no commit yet, has a merge in progress, or has uncommitted changes and no `--base`. A fix whose edits were all
denied leaves no branch and no folder, and the comment is marked as needing a person.

**Stop stops all of it.** Stop is honoured between every step: after it nothing is committed, nothing is pushed, no pull request
is opened, and the agent's reply on the comment says the fix was stopped, not "Fix ready". A fix that was waiting for
"Push this fix" is taken back, branch and all. The one thing Stop cannot undo is a push that had already finished: then the
thread says the branch exists on the remote, and no pull request follows.

**Copies a dead process left behind are swept.** When `agent connect` starts, and around every fix, the copies whose process is
gone are removed with their records, so their branch names are free again. Ctrl+C during a fix removes its copy on the way out.

If files in the person's own checkout changed while the fix ran, the thread says so: "Files in the agent's own checkout changed
during this fix. Check git status on its machine." Shapewall does not sandbox the agent's own tools
([agent-hardening.md](agent-hardening.md#connected-agents)).

### Files that run something

Some files of a project run something once they change: on install, on build, in a test run, in CI, or the moment a branch is
pushed. Shapewall keeps one list of them, used both when an edit is asked and before a push:

- dotfiles and everything in a dot folder (`.env`, `.npmrc`, `.github/`, `.husky/`, editor and agent settings);
- dependency manifests and lockfiles (`package.json`, `package-lock.json`, `pnpm-lock.yaml`, `requirements*.txt`, `go.mod`,
  `Cargo.toml` and the like);
- build, task and tool configuration (`Makefile`, `GNUmakefile`, `*.config.js` / `.ts` / `.mjs` / `.cjs`, `tsconfig*.json`, the
  jest, vitest, vite, webpack, rollup, babel, eslint and prettier files, `shapewall.config.json`);
- scripts a package runs (`scripts/`, `bin/`, `tools/`, install hooks, `*.sh`);
- container files (`Dockerfile*`, compose files) and CI files;
- test files (`*.test.*`, `*.spec.*`, `test/`, `tests/`, `__tests__/`, `e2e/`): CI runs them.

For a connected agent's fix:

- an edit to one of them is **refused on the machine** unless the machine named that file with `--allow-path`;
- a named one is **always asked**: it gets a card a person answers, even when the rule is "Allow without asking";
- a fix that changes one is **never pushed from the machine**. The branch stays there for review.

Three more kinds are never part of a fix, named or not, because Shapewall's own commit leaves them out: files Git ignores,
anything under `node_modules`, and `.gitattributes` / `.gitmodules`. An edit to one is refused when it is asked, with that reason.
It is never allowed and then silently dropped.

### Permission cards

Each edit the agent asks for is checked on the machine first. It becomes a question only when all of this holds:

- the file is inside the fix's folder, after resolving symlinks;
- it is not in `.git` and not in Shapewall's store;
- it is not a file that runs something, unless the machine named it with `--allow-path`, and not a file Git would leave out of
  the commit ([Files that run something](#files-that-run-something));
- the whole resulting file can be worked out, and the diff is small enough to show in full.

What fails is refused there, with the reason in the answer ("Refused on the agent's machine: ..."), and nobody is asked. What
passes is shown in the comment's chat thread as a card:

- **The path and the full diff**, with **Allow** and **Deny**, in the machine's own words ("Edit src/app.css", "Create
  src/new.css"). The agent's own title for the request is never shown.
- **A hash ties the answer to the card.** The card carries a hash of the turn, the card, the path, the whole diff and how long it
  waits. An answer must send that hash back. An answer for other content, another card or another turn is not this card's
  answer.
- **A card waits 2 minutes** ("Push this fix": 10). That is a length of time, not a moment: the machine and the server each count
  it on their own clock, so the two clocks need not agree. No answer is a no. The machine's count is the one that decides: when
  it did not take an answer (it came too late there), the card shows as expired, never as "Allowed by", and is counted as not
  allowed.
- **Who reads the diff.** The diff is a piece of the project's code. It is shown, live and in the stored thread, to the people
  the agent works for: those in its audience whom the project trusts, whoever may answer its cards, and whoever asked for the
  fix. Everyone else who can open the thread reads that the agent asked to edit a file, which file, and how that ended.
- **A card is answered once.** Stop cancels the cards that wait.
- **Everyone with the thread open sees the state change live**: waiting, allowed and by whom, denied, expired, cancelled. The strip
  above the board lists the cards that wait for you, and opens the comment's chat, where the diff is.
- **Allow needs a passkey check in the last 10 minutes.** The browser asks for it. Deny does not: it only ever stops something.

**Who may answer.** Someone with the agent's answer role (admin by default), who is also in the agent's audience and trusted by
the project's agent policy. When the agent's machine says `--approvals owner`: only the person who connected it. Everyone else
sees the card and who it waits for.

**The machine checks every answer again.** It counts an "allow" only for a card it asked and still waits on, with the same hash,
not expired, once, and from the connecting person when it said "owner". A failed "allow" is a deny. An answer for a card it never
asked is ignored. In the other direction, the server never takes "approved" from the machine: only a person's answer on the board
makes a card allowed.

### Allow without asking

Each agent has an approval rule, in the console's approvals dialog on the project's Agents page: **Ask every time** or **Allow
without asking**.

- **Only when the agent's own machine named a kind** with `--auto` (`--auto edits`). Otherwise the option is listed as not
  available, with the command to run on that machine.
- **Who may switch it on.** When the machine says `--approvals owner`: only the person who connected the agent, nobody else,
  whatever their role. An admin cannot take that person out of the loop; the server refuses, and the machine itself only goes
  without asking when the server says the rule is that person's own. When the machine says `--approvals admins`: the role in the
  agent's "who may change the rule" setting (admin by default; an owner can make it owner).
- **Only for the kinds the machine named, and only for ordinary source files.** A file that runs something
  ([Files that run something](#files-that-run-something)) always waits for a person, named or not.
- **It never widens what may be edited.** The machine's checks above run on every edit all the same. The fix is still made on a
  branch, and the commit is still kept only when it is exactly what was allowed.
- **Nothing reaches a remote without a person having seen the diff.** A fix with an edit that went without asking is committed
  on its branch on the machine and held there. It is not pushed and no pull request is opened. The thread shows one
  **Push this fix** card with the whole changed-files diff. Someone who may answer the agent's cards allows it, with a fresh
  passkey, under the same rules as any card (the hash, once, the machine's own recheck); it waits 10 minutes. Denied or not
  answered, the fix stays on the machine and the result offers **Push this fix** again, as often as needed. A fix too large to
  show in full cannot be pushed from the board at all.
- **If the machine connects again without it**, the stored rule is set back to "ask" at once, and that is in the audit log.

An edit that went without asking is still a card in the thread, marked "Allowed automatically", and is counted and audited.

### What the machine enforces whatever the server says

- **The command is the machine's.** The server cannot name, change or add a command, an argument, a folder, an environment
  variable or an MCP server.
- **No edits unless this machine said so.** With `--approvals none`, nobody's answer is taken and no fix starts.
- **A fix is never made in the checkout.** A fresh copy, a new branch, a folder that is removed afterwards.
- **Every edit is checked here first**: inside the fix's folder, not `.git`, not Shapewall's store, not a file that runs something
  unless named with `--allow-path`, not a file Git would leave out, the whole diff shown.
- **A file that runs something is never allowed without asking**, and a fix that changes one is never pushed.
- **The policy file fails narrow.** A value in `agent-policy.json` that this version does not know (a typo, `false`, `""`, a
  wrong type) reads as the narrowest setting for that key, never as the default: no approvals, only the person who connected it,
  never pushed, nothing without asking. `agent connect` names each such key when it starts. The file must be yours and not
  writable by others, which is checked before it is read.
- **Every answer is checked here again**: a card this machine asked, the same hash, in time, once, and from the connecting person
  under `--approvals owner`.
- **"Allow without asking" only for what `--auto` named**, and under `--approvals owner` only when the server says the
  connecting person set that rule themself.
- **The commit is exactly what was allowed**, byte for byte and mode for mode, or there is no commit.
- **Nothing is pushed that runs something, or that no person has seen.**
- **After Stop, nothing more happens**: no commit, no push, no pull request.
- **No commands for Claude Code.** Its fix session has no shell tool.
- **The agent never holds its token.** Its process gets a small environment with no `SHAPEWALL_*` variable.

What the machine cannot do is in [agent-hardening.md](agent-hardening.md#connected-agents): it does not sandbox the agent's own
tools, and with approvals on, a server that was broken into can forge an "allow" for an edit the agent really asked.

### When a connected agent is offline

- **Chat is refused.** The composer gives way to "Builder is offline. Chat needs it online; a comment sent to it waits until it is
  back." A conversation that silently queues is worse than a clear no.
- **A fix cannot be asked.** Fix with an agent needs the agent online, and is not queued.
- **The thread does not move by itself.** A thread whose agent is offline, or was revoked, stays with it. When another agent you
  may use is online, the panel offers **Ask Scout instead**. Choosing it switches the thread in the open, with the line described
  under [Chat with a connected agent](#chat-with-a-connected-agent).
- **Comments wait**, as for any agent: "Waiting for Builder (offline, last seen 2 hours ago)", with **Let any agent take it**. The
  agent takes what was sent to it when it is back.

### When the link drops

- **The link reconnects by itself**, waiting 1 to 60 seconds between tries. After every reconnect the machine asks the server what
  is open and picks up from there. A batch of an answer the server did not hear is sent again; a repeat is dropped.
- **The machine goes away mid-answer.** After 45 seconds without a word and without a link, the turn ends as interrupted, with what
  the agent had written so far: "The agent's machine went away before it finished. Ask again."
- **The server restarts.** Answers in progress are over. Every turn a stop left queued or running is ended as interrupted when
  the server starts, with its usage record, whether or not anyone opens its thread again. Stored messages are untouched.
- **The agent is revoked** (on the Agents page, or its token on the Tokens page). Its link closes at once, what it was answering ends
  with "Builder was revoked before it finished.", and the command on its machine exits.
- **A second connect.** Refused while the first holds the link, or it takes over with `--takeover`
  ([the connect command](#the-connect-command)). After a hard crash the server may still believe the old link is open for a short
  while, and refuses a restart until it notices.
- **A link that flaps** does not flood anything. Boards are told that an agent came or went at most once every 3 seconds per
  agent, and the audit log gets at most one connected and one disconnected entry a minute per agent. A revoked or taken-over link
  is always written.

### Limits of chat

| What                                | Limit                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Messages one person sends           | 20 a minute                                                                                                  |
| Chat turns in a project             | 200 a day (`dailyTurns` in the agent policy)                                                                 |
| Answers one agent gives at once     | `--concurrency` (1 to 4), plus 5 waiting; after that it answers "busy"                                       |
| A message                           | 8,000 characters, 8 mentions, 3 text files of 100 KB                                                         |
| An answer                           | 100,000 characters                                                                                           |
| What the machine sends at once      | 256 KB and 100 events in a batch                                                                             |
| What the machine fetches for a turn | 2 MB                                                                                                         |
| Links one agent token holds         | 1 (a second is refused, or takes over with `--takeover`)                                                     |
| Link opens by one agent token       | 6 a minute                                                                                                   |
| Chats of your own on one board      | 50 (the shared threads are apart)                                                                            |
| A permission card                   | Waits 2 minutes ("Push this fix": 10); the whole diff must fit in the card; counts against the storage quota |
| Cards one fix may ask               | 60, and 5 waiting at the same time                                                                           |

The daily budget is counted from the usage records, so deleting a thread gives no turns back. `dailyTurns` is part of the
project's agent policy. The console's form has no field for it yet (and keeps the value when you save
the form): read the policy with `GET /api/workspaces/:ws/projects/:pid/agent`, set `dailyTurns` (0 to 100000; 0 stops chat turns)
and `PUT` the whole policy back. The link has its own request budget on the token API, so a streamed answer does not use up the
agent's budget for comments.

### Running a connected agent as a service

Run the command once by hand in the project's folder and approve it: the token is saved. A service then runs the same command and
finds it. Shapewall installs nothing; this is a systemd user unit you write yourself (`systemctl --user enable --now
shapewall-agent`):

```ini
# ~/.config/systemd/user/shapewall-agent.service
[Unit]
Description=Shapewall connected agent (Builder)
After=network-online.target

[Service]
WorkingDirectory=%h/projects/site
ExecStart=/usr/bin/env shapewall agent connect --remote https://wall.example.com --takeover
Restart=on-failure
RestartSec=10
# A clean environment: only what the agent needs to find its programs and its own login.
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin

[Install]
WantedBy=default.target
```

- `--takeover` is there so a restart is not refused: after a hard crash the server may still count the old link as open for a short
  while. It also means this service takes the link from any other process that holds it for this agent.
- With the token in a file of its own (a secret store, another user), add `--token-file /path/to/token`. The file holds the agent's
  token and nothing else.
- SIGTERM is a clean stop (exit 0), so `systemctl --user stop` does not count as a failure. A revoked token exits 1; the unit then
  restarts and fails again until you approve a new connection by hand.
- Give the service its own agent profile ([what it can read](#what-a-connected-agent-can-reach)).

### What a connected agent can reach

- **The server cannot make the machine act.** Every request goes out from the machine, to the one server you named. A turn's job is
  data: the conversation and the board around it. Nothing in it names a command, a tool, a file to write or a variable, and fields
  the machine does not know are dropped.
- **Board text is quoted on the machine.** Comments, replies, page titles, mentions and attached files reach the agent as
  `<shapewall-data trust="untrusted">`, built on the machine itself, with the same rules the local chat gives an agent. Only the
  person's own message is outside the quotes.
- **It can read the project, and its answers leave the machine.** The agent reads with its own tools: every file in the project
  folder that those tools can read, a `.env` file included. Its instructions say not to quote secrets, and the machine removes the
  agent's own token from anything it sends; neither is a guarantee. Connect only a project whose code the agent's audience may
  read, and keep secrets out of the folder or out of the agent's reach.
- **It cannot act, by its own controls.** The session has only its reading tools and none of your settings files, and it is not
  started when that cannot be set up ([read-only by the agent's own controls](#read-only-by-the-agents-own-controls)). A fix
  session, on a machine that switched edits on, also has its editing tools, in a folder of its own.
- **What leaves the machine when edits are on**, beyond the answers: the diffs on edit cards (bounded: a diff too large to show
  in full is refused), the file paths and line counts of a fix, the branch name and the pull request link. Still not the agent's
  token, which is never in the agent's environment, and not absolute paths.
- **What the machine sends back** is cleaned by the server field by field before anything is shown or stored. A stolen agent token
  can pose as the agent (read what was sent to it, post answers); it cannot reach the machine.

### Read-only by the agent's own controls

Refusing what an agent asks for is not enough: a tool it is set up to run without asking never asks. So a connected Claude Code
session is started in a way that leaves it nothing to act with, and anything that cannot be set up that way stops the start
(fail closed).

- **No settings files.** Your `~/.claude/settings.json` and the project's `.claude/settings.json` and
  `.claude/settings.local.json` are left out of the session. Their allow rules, hooks, default mode and plugins do not apply.
  When one of them holds such rules, `agent connect` says so: "Left out of this session".
- **No MCP servers** from `.mcp.json` or from settings.
- **Only its reading tools:** Read, Grep and Glob. Bash, Edit, Write, MultiEdit, NotebookEdit, WebFetch, WebSearch, Task/Agent and
  Skill are removed from the session, and bypassing permissions is switched off.
- **A mode that asks.** The session's mode must be "default" or "plan". Any other is switched to "default", or the agent is not
  started. An agent that reports no session mode at all is not started read-only. An agent that switches itself to another mode
  mid-answer is stopped.
- **Reading outside the project asks**, and the request is refused like every other.
- **Managed settings cannot be left out.** When `/etc/claude-code/managed-settings.json` allows acting tools (Bash, Edit, Write,
  MultiEdit, NotebookEdit, WebFetch, WebSearch, Task, `mcp__*`, or Read of absolute or home paths) or runs hooks, `agent connect`
  refuses to start and says why. It no longer only warns.
- **What this costs you.** Settings that live in those files, such as an `apiKeyHelper` or `env`, do not apply to the connected
  session either. The login itself is not in those files.

**A fix session** (a machine started with `--approvals owner` or `admins`) is set up the same way, with one difference: it keeps
Edit, Write and MultiEdit beside Read, Grep and Glob. It has no settings files, no MCP servers, no Bash, no web tools and no
bypass. Each edit it makes asks first, and the request goes through the machine's checks and a card
([Permission cards](#permission-cards)). Chat turns on the same machine keep the read-only session.

This was shown on one machine with one adapter version ([agent-hardening.md](agent-hardening.md#connected-agents) says how). It
is still a good idea to give a connected agent a profile of its own: a separate config folder, logged in for this purpose.

### Chat usage records and the audit log

Every chat turn writes one usage record: who asked, which agent, the board and thread (or comment), when it started and ended, and
how it ended (answered, stopped, failed, interrupted). The model, the effort and the token counts are kept only when the agent
reports them, and a cost only when the agent itself reports one: nothing is estimated, and "not reported" is not zero. A record
never holds a message or an answer. There is no page for them yet.

A fix is one usage record of kind "fix": its steps, how it ended (fix ready, answered, stopped, failed, interrupted), and how many
requests it asked and how many were allowed and denied.

The audit log gains `agent_connected` (who approved which agent, on which machine, for whom), `agent_link_connected` and
`agent_link_disconnected` (with the reason; at most one of each a minute per agent, except a revoked or taken-over link, which is
always written), `chat_thread_created`, `chat_thread_deleted`, `chat_thread_agent_changed` (who switched a thread from which agent
to which), `agent_turn_started` and `agent_turn_stopped` (who, which agent, which board and thread). No entry holds message text.

For edits (Shapewall 0.6.0) it gains:

| Entry                                                  | What it records                                                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `agent_edit_mode_changed`                              | What the agent's machine allows changed (approvals, how many commands, what may go without asking), before and after |
| `agent_turn_started` with kind "fix"                   | Who pressed Fix, for which agent, board and comment thread                                                           |
| `agent_permission_asked`                               | A card arrived: the agent, the thread, the path, the card's hash                                                     |
| `agent_permission_approved`, `agent_permission_denied` | Who answered, the path, the card's hash                                                                              |
| `agent_permission_expired`                             | Nobody answered in time                                                                                              |
| `agent_permission_auto`                                | An edit went without asking, under the agent's rule                                                                  |
| `agent_permission_not_taken`                           | The machine did not take a person's "allow" (it came too late there): who answered, and what the card became         |
| `agent_fix_branch_ready`                               | The branch name and how many files, as the agent's machine reported them                                             |
| `agent_branch_pushed`, `agent_pull_request_opened`     | The remote, or the pull request's link, as the agent's machine reported them                                         |
| `agent_approval_rule_changed`                          | The rule or its roles changed, by a person, or reset to "ask" because the machine no longer allows "without asking"  |

A command would be recorded only as a hash. No entry ever holds file content or a diff. The server sees no repository: what it
writes about a branch, a push or a pull request is the machine's own account.

### The link and chat APIs

The link is on the token API, scope `agent`: `POST /api/v1/agent/hello`, `GET /api/v1/agent/link` (server-sent events: `work`,
`cancel`, `change`, a keepalive every 15 seconds), `GET /api/v1/agent/work`, `GET /api/v1/agent/turns/:id`,
`POST /api/v1/agent/turns/:id/events` (`{ seq, events }`), `POST /api/v1/agent/turns/:id/finish` (`{ seq, message }`) and
`POST /api/v1/agent/turns` (`{ board, comment }`, for a comment the agent holds). Every route derives the project and the agent from
the token; another agent's turn answers 404.

Chat is on the board API for members and up (`/w/:ws/p/:pid/api`): `GET agent/status`, `GET agent/boards/:board/threads`,
`GET|PATCH|DELETE agent/boards/:board/threads/:thread`, `POST .../threads/:thread/messages` (answers with server-sent events),
`GET .../threads/:thread/events?after=<n>` (a running turn, for a second viewer), `POST .../threads/:thread/stop` and
`POST .../threads/:thread/profile` (`{ profileId }`: the thread's agent). The board's agent list (`GET /api/boards/:board/agents`)
says for each agent whether it is connected, whether it chats, and whether you may chat with it now. It also says which edit mode
the agent is in, and whether you may press Fix and answer its cards, with the reason when not.

Fix with an agent is `POST .../threads/comment-<n>/messages` with `{ fix: true }` (and `agentId` for an agent other than the
thread's, `dispatchHash` for the text you saw). A card is answered with `POST .../threads/:thread/permissions/:id`
(`{ optionId: "allow" | "deny", hash }`), and `GET agent/boards/:board/permissions` lists the cards that wait for you.

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
- **12** (agents, 0.4.0): tables `agents` and `agent_runs`, columns `projects.default_agent_id`, `comments.agent_id` and
  `agent_claims.agent_id`, and a backfill that turns every token with the `claim` scope into an agent that behaves as before. What a
  rollback loses is in [Migration 12 and rollback](#migration-12-and-rollback).

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
   On the project's Agents page, check each agent's audience: a teammate outside it should see the agent greyed on the board with
   the reason, and a comment sent to one agent should run only on that machine.
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

### Migration 12 and rollback

Migration 12 (0.4.0) makes agents first-class ([Agents on a hosted board](#agents-on-a-hosted-board)). It is additive and runs once:

- tables `agents` (one row per token with the `claim` scope: kind, icon, tint, machine label, audience, approval rule and its two
  roles, who created it, when it was last seen) and `agent_runs` (the usage record of each comment an agent took);
- columns `projects.default_agent_id`, `comments.agent_id` (the agent a comment was sent to; empty means any agent) and
  `agent_claims.agent_id`;
- a backfill: every token that already has the `claim` scope becomes an agent of kind "watcher" with the audience "everyone the
  agent policy trusts", which is what it did before. Open claims are linked to their agent. No project gets a default agent and no
  comment gets an address, so every comment stays open to any agent, as before.

A token with the `claim` scope that has no agent row (made while an older build ran on the upgraded database) becomes an agent the
first time it calls the server, with the same audience. Back up before upgrading.

For rollback, prefer the pre-upgrade backup in a fresh data folder with the previous release. Running 0.3.4 on the upgraded database
also works, since it ignores the new tables and columns, but it loses what they held:

- **Routing.** A comment sent to one agent can be taken by any watcher, and an agent takes work from everyone the agent policy
  trusts, whatever audience it was given. Tighten the project's Agent policy first if that matters.
- **Agents made after the upgrade** (audience "only the person who connected it") behave like every other token there.
- Default agents, icons, audiences, approval roles and usage records are not shown, and are still there when you upgrade again.

To remove the schema as well (SQLite 3.35+), with the server stopped: `DROP TABLE agent_runs; DROP TABLE agents; ALTER TABLE projects
DROP COLUMN default_agent_id; ALTER TABLE comments DROP COLUMN agent_id; ALTER TABLE agent_claims DROP COLUMN agent_id; DELETE FROM
schema_migrations WHERE version = 12; PRAGMA user_version = 11;`. The next upgrade then backfills again from the tokens. Never reset
the ledger any other way. Test a rollback on a copy first.

### Migration 13 and rollback

Migration 13 (0.5.0) adds chat with [connected agents](#connected-agents). It is additive and runs once:

- tables `chat_threads` (a thread of a board, the agent it talks to, and for a private chat its owner), `chat_messages` (the
  person's messages and the agent's answers) and `chat_turns` (one question on its way through an agent, and how it ended);
- column `device_logins.meta` (what a machine that asks to connect says it runs, for the approval page).

Nothing existing is rewritten: no token gains a scope, no agent changes its audience, and `watch --remote` and `mcp --remote` work
with the same tokens. The usage records of chat turns go in `agent_runs`, the table migration 12 made. Back up before upgrading.

For rollback, prefer the pre-upgrade backup in a fresh data folder with the previous release. Running 0.4.0 on the upgraded database
also works, since it ignores the new tables, but:

- **Chat is gone from the board**, and the threads are not shown. They are still there when you upgrade again.
- **Connected agents show as ordinary agents** with no chat. Their tokens keep working on the token API, so a comment sent to one
  can still be read and answered through it; 0.4.0 shows the `agent` scope on such a token and gives it no meaning.
  Revoke the connected agents first if that is not what you want.
- A machine still running `shapewall agent connect` gets 404 from the link routes and keeps retrying. Stop it.

To remove the schema as well (SQLite 3.35+), with the server stopped: `DROP TABLE chat_turns; DROP TABLE chat_messages; DROP TABLE
chat_threads; ALTER TABLE device_logins DROP COLUMN meta; DELETE FROM schema_migrations WHERE version = 13; PRAGMA user_version =
12;`. Never reset the ledger any other way. Test a rollback on a copy first.

### Migration 14 and rollback

Migration 14 (0.6.0) adds approvals and edits from a hosted board
([Edits from the board](#edits-from-the-board-the-trust-decision)). It is additive and runs once:

- table `chat_permissions` (one row per permission card a connected agent asked during a fix: what it asked, as hashed, its
  state, who answered and when);
- columns `agent_runs.approvals_asked`, `agent_runs.approvals_allowed` and `agent_runs.approvals_denied` (how many requests a
  fix asked and how they ended).

Nothing existing is rewritten: no token gains a scope, no agent changes its audience or its approval rule, and a connected agent
reads and answers only until its own machine says more. `watch --remote` and `mcp --remote` work with the same tokens. Back up
before upgrading.

For rollback, prefer the pre-upgrade backup in a fresh data folder with the previous release. Running 0.5.0 on the upgraded
database also works, since it ignores the new table and columns, but:

- **A fix cannot be started.** 0.5.0 has no Fix with an agent on hosted comments and relays no cards. Connected agents chat and
  answer comments as they did in 0.5.0.
- **Cards and their answers are not shown.** They are still there when you upgrade again, and the audit entries stay in the
  audit log.
- **A machine started with `--approvals`** keeps its own setting in its policy file. It takes no edits while the server is
  0.5.0, because that server never asks for a fix.

To remove the schema as well (SQLite 3.35+), with the server stopped: `DROP TABLE chat_permissions; ALTER TABLE agent_runs DROP
COLUMN approvals_asked; ALTER TABLE agent_runs DROP COLUMN approvals_allowed; ALTER TABLE agent_runs DROP COLUMN
approvals_denied; DELETE FROM schema_migrations WHERE version = 14; PRAGMA user_version = 13;`. Never reset the ledger any other
way. Test a rollback on a copy first.

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
`import` is reserved for the local-to-shared bridge; `agent` is the link of a
[connected agent](#connected-agents), granted only by approving
`shapewall agent connect`. Old `comment` tokens map
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

A claim token is an agent ([Agents on a hosted board](#agents-on-a-hosted-board)), and two more rules apply to it on every route:
it sees and takes only comments sent to it or to any agent, and only when the person whose approval stands on the comment is in its
audience. A comment sent to another agent answers 404 `unknown_comment`, exactly like one that was never dispatched: lists, direct
reads, replies, statuses, approvals, comment files and the MCP tools. The events stream still carries ids only. On a comment it
may work on, it reads only the replies of people in its audience. The token that holds a comment keeps all of this for that comment
until it finishes.

**Tokens without `claim` are not agents and are not routed.** A token with `read` (and `reply` or `status`) but no `claim` sees every
comment of the project, including the ones sent to one agent, exactly as before 0.4.0: it is for scripts, CI and reporting, cannot take
work, and is not listed on the board. Give `claim` to what should behave as an agent, and leave it off anything that only needs to read.

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
