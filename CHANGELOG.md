# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- `shapewall open`: prints and opens a deep link to a board, a page (`--page`), a comment (`--comment`), a screen size
  (`--viewport`), a page's before and after (`--compare`) or two environments (`--compare A_B`), on a local board or a hosted
  project (`--remote URL`). `--print` and `--json` print without opening.
- Board links take `p=<page>`: the board opens flown to that page. Every link Shapewall makes (notifications, GitHub issues,
  usage rows, `share` and `push` answers, `shapewall open`) now comes from one builder; see "Links to the board" in the agent
  workflow docs.
- MCP `list_comments` filters, on `shapewall mcp`, `mcp --remote` and a hosted server's `/mcp`: `author` (`"me"`, a display name
  or an `@handle`), `since` and `until` (`"today"`, `"yesterday"`, a date or an ISO date-time, in the machine's time zone or
  `timeZone`, stated back as `range`), `q`, `pageName` (several matches return candidates), and paging with `limit` (default 50,
  max 200) and `cursor`. "All comments I left today on the Features page" is one call.
- MCP `board_link`: a link to the board, a page, a comment, a viewport or a page's before and after. Every comment and page result
  carries `link`, and `recapture_pages` answers with a compare link per page and viewport.
- MCP `compare_captures`: a page's current capture against the one before it (or any two versions) as two images, with a pixel
  diff summary and the compare link. It compares for real on hosted boards too.
- Token API `GET /api/v1/boards/:board/pages/:page/versions` (scope `read`): a page's capture history with file URLs.
  `GET /api/v1/project` says which account made the token (`token.createdBy`).
- The MCP servers share one set of instructions: find work with the filters, check the work in your own browser while you work,
  `recapture_pages` publishes the final state as the hand-in, `compare_captures`, then reply with the compare link and set `done`.
- Agents find the board with no plugin: `shapewall init` writes a short Shapewall section into `AGENTS.md` (and a one-line
  `CLAUDE.md` that imports it, when there is none), between `<!-- shapewall:start v1 -->` and `<!-- shapewall:end -->`. The first
  `serve` or `capture` in a project adds it once; a section you removed is never added back. `init --no-agent-docs` and config
  `"agentDocs": false` turn it off; `shapewall agent docs --write | --remove | --print` does it by hand.
- `shapewall agent setup` registers the `shapewall` MCP server with Claude Code (`--scope local` by default, or `user`, `project`)
  and Codex (`~/.codex/config.toml`, with `tool_timeout_sec = 600`). It shows the change and asks first (`--yes`, `--dry-run`),
  backs up each file, touches only the `shapewall` entry, replaces a different one only with `--force`, and `--remove` takes it out.
  It registers the project's own install, else `shapewall` on PATH at this version or newer, else `npx -y shapewall@<version>`.
  `--remote URL` registers `shapewall mcp --remote URL` after `shapewall login`; no token is written.
- Connected agents follow instruction files: `shapewall agent connect` reads the project's `CLAUDE.md` and `.claude/CLAUDE.md`
  (its `AGENTS.md` when neither exists) and the connection's own agent config folder's `CLAUDE.md`, and hands them to each
  session as an appended system prompt, with Shapewall's data rules last. New flags `--instructions all|project|none` and
  `--agent-config DIR|none` (saved per connection; the folder is never created for you). The terminal, the board's Agents panel
  and the console's Agents page list the files by name (the console with short sha256 hashes); their text never leaves the
  machine. A fix reads them from its own copy of the project. They add no powers.

### Changed

- MCP `list_comments` returns at most 50 comments per call by default (`total` counts every match; `cursor` gets the next page).

- GitHub issue links to a comment list their keys in the shared order (`?board=&c=&filter=all`); they open the same view.

### Fixed

- `compare_captures` decodes each capture once, a row at a time, and counts the diff on the images as shown (`diff.scale`), not
  on the full-size captures: two 3840x4166 captures took 1.25 s, now about 0.33 s, and a fraction of the memory.
- `compare_captures` no longer labels the wrong image `current` when a capture or push lands while it reads: it asks to be called
  again (local boards re-check the version; hosted current capture URLs carry `?version=` and answer 409 once it moved).

### Security

- A hosted server's own `/mcp` runs `compare_captures` in its worker threads, one compare at a time per token (another call is
  refused with a "busy, retry" error), with a 16 megapixel cap read from the PNG header before decoding. It used to decode both
  captures at full size on the server's event loop, about 2 s and 550 MB per call, for any read token.
- `compare_captures` refuses a capture over its pixel cap from the PNG header, before decoding it.
- `author: "me"` on a local board goes by a server-side owner stamp (`byOwner`) on the comments the owner makes, which the request
  cannot set: a paired device or LAN visitor signing with the owner's name no longer counts as "me". Older comments without the
  stamp still match by name, and the answer says so (`author.meMatch: "owner+name"`).
- Token API: `GET /api/v1/project` names the token maker (`token.createdBy`) only to tokens with the `read` scope. A claim token
  lists and fetches only the current captures and the versions its dispatched comments were made on; any other read token can
  read every kept version, as `docs/hosted.md` now says.
- Connected agents (`shapewall agent connect`, chat and fix sessions) no longer load or write Claude Code's auto memory. In 1.2.0
  and earlier these hardened sessions still loaded it, so notes Claude Code kept for the project could shape answers that leave
  the machine. It is now off twice over: `autoMemoryEnabled: false` in the session's flag settings and
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in its environment, checked with claude-agent-acp 0.93.0 and 0.106.0
  (docs/agent-hardening.md).
- `CLAUDE.md`, `AGENTS.md`, `CLAUDE.local.md` and `GEMINI.md` are now files that run something: a connected agent's fix cannot
  edit them unless the machine names the file with `--allow-path`, the edit is always asked on the board, and such a fix is
  never pushed.

## 1.2.0 - 2026-11-24

### Added

- `shapewall mcp --remote` now offers `recapture_pages` when it starts in a project folder (or with `--config FILE`) and the token
  has the `push` scope: it captures the pages on your machine, then pushes those pages to the hosted board, so an agent on a hosted
  board can make the change, recapture and resolve without leaving MCP. It refuses a hosted board whose id is not in the config.
  `--read-only` and `--no-capture` leave it out. `mcp --remote` also takes `--board ID` for the board a tool works on by default.
  See [the hosted guide](docs/hosted.md).
- `shapewall push --page ID[,ID]` and a page mode of the hosted push API upload only some pages' captures to a board already
  pushed. Every other page on the hosted board stays as it is there, so two machines pushing one board no longer put back each
  other's newer captures, and the server refuses a push that would replace a newer capture with an older one (`stale_capture`).
  The capture a page push replaces is kept as a version, so comments made on it still show it. `recapture_pages` of
  `mcp --remote` pushes this way. See [Pushing a few pages](docs/hosted.md#pushing-a-few-pages).
- A `get_page_capture` MCP tool, in `shapewall mcp` and `shapewall mcp --remote`: a page's current capture at one viewport as an
  image, scaled down to at most 1600 px wide, with when it was captured and its size; `crop` shows a part of it at full size. It
  only reads, so `--read-only` keeps it. See [the agent workflow](docs/agent-workflow.md#mcp-server-shapewall-mcp).
- `shapewall mcp --remote` now has `add_comment`, with a token that has the `reply` scope: it pins a new comment on a page of the
  hosted board, on an element from `list_selectors` or near the top-left corner. It is signed with the token's name, marked as an
  agent's and never sent to an agent. Behind it is a new token API route, `POST /api/v1/boards/:board/comments`, audited as
  `token_commented`, at most 120 new comments an hour per token. The token pages route also says when each page's viewports were captured (`capturedAt`).

### Fixed

- Avatar initials use only letters and digits: an agent named "Harry (ibuypower)" shows "HI", not "H(", and a word that is only
  an emoji or punctuation is skipped.
- Hosted: agent cards on the board no longer end with "(As before 0.4.0.)". The console's agent card says in plain words that the
  agent keeps a setting from an older version.
- Hosted: a connected agent asked in the board chat to change something no longer says nobody can approve it. It says the chat
  reads and answers, and that a change is made with "Fix with" and its name on a comment, each edit allowed on the board. On a
  machine that takes no edits from the board, it says so and how to turn them on (`shapewall agent connect --approvals owner`).

## 1.1.0 - 2026-11-24

### Added

- Tailnet sign-in (`shapewall hosted --tailscale --tailnet-sign-in`) and the local board's owner check under
  `serve --tailscale` now work with the server on macOS (Standalone Tailscale app or open-source `tailscaled`) and Windows,
  not only Linux. Each system's own socket table proves that a request came from tailscaled; the Mac App Store version of
  Tailscale is refused with the Standalone app as the fix. See [On macOS and Windows](docs/hosted.md#on-macos-and-windows).

## 1.0.1 - 2026-11-23

### Fixed

- The comment composer's tools no longer run under Post in a narrow comment card: the row wraps, and Post moves to its own line
  when the tools need the room. On phones the "Draw on the page" label shortens instead of running under the microphone.
- Hosted: editing a comment that an agent has already taken (queued or working) takes it back from that agent, so it can be sent
  again as edited. Before, the edit left it stuck as queued until the stale-claim sweep.

## 1.0.0 - 2026-11-23

Shapewall shows your whole app on one wall: every screen on desktop and phone, the flows between them, and comments your coding
agent reads as instructions and builds from, over JSON, `shapewall watch` or MCP. 1.0.0 starts the Semantic Versioning promise:
what stays stable within 1.x, what is experimental and which files on disk you can rely on are in
[Stability and versioning](docs/stability.md).

### Upgrading from 0.x

The agent contract is settled. Scripts and agents that read Shapewall's JSON need these updates:

- **One comment shape.** Every comment write and `comments get --json` (local and `--remote`), the `watch` line, the
  `watch --exec` stdin and `$SHAPEWALL_COMMENT_FILE`, and the MCP `get_comment` and `add_comment` results print
  `{ trust, note, board, comment }`, with the comment in the item shape of `comments --json`. `comments reply --json` adds
  `reply`; `comments delete --json` prints `{ board, deleted }`.
- **`board` is always an object**, `{ id, title, baseUrl }`, in agent JSON, event log lines and `events --json`. `board.dir` is
  gone.
- **Trust fields** (`trust: "untrusted"` and `note`) come with comment text everywhere an agent reads it: the `watch` line, the
  `--exec` stdin and file, `comments add|selectors --json`, `events --json` and the MCP results.
- **Replies match comments:** `guest`, `handle` and `agent` are `authorGuest`, `authorHandle` and `authorAgent`, and `images` and
  `markup` sit under `files`. MCP `reply_to_comment` returns `comment.replyCount`; `set_comment_status` adds `changed`, and a
  refused move says why (`refused`, `note`).
- **One done rule for `watch --exec`**, local and `--remote`: exit 0 plus a reply from the command is `done`, anything else is
  `needs-human`. `watch --remote` without `--pass-token` no longer takes a silent exit 0 as `done`.
- **Events:** `comment.status_changed` is `comment.agent_status_changed` (a channel filter with the old name still works, with a
  warning). Hosted `/api/v1/events` use the local event names. Webhook bodies and event log records carry `version: 1`; the
  webhook signature is unchanged.
- **MCP:** new tools `add_comment` (local) and `list_selectors`; `mcp --remote` adds `list_journeys`, reports the server's error
  code on a refused call, and its `get_comment` matches the local one.
- **`capture --json`** reports its counts as `totals: { shots, ok, failed, expected }`.
- **Exit codes** are one table (`shapewall --help`): `audit` exits 2 when some views were partial or failed, a stopped `checks`
  exits 130 or 143, and `init` exits 0 with a warning when the app did not answer.
- **Default author:** comments and replies written on a local board or from the CLI without `--author` are signed with your name
  (`SHAPEWALL_USER_NAME`, git's `user.name`, else the system user) instead of `agent`. Commands an agent runs still sign as
  `agent`.
- Capture version ids are opaque strings: compare them, never parse them.

Command line, config and install:

- **Lighthouse and `@sentry/node` are optional:** `npm install lighthouse@13.6.0` for `checks lighthouse`, and
  `npm install @sentry/node@11.12.0` for opt-in error reports (`SHAPEWALL_ERROR_DSN`). `doctor --install-browser` downloads only
  the headless Chromium; the full one is fetched the first time `auth record` opens a sign-in window.
- **The sandboxed starter agent** moved under `agent sandbox run|watch|doctor|build-image` and is experimental. `agent connect` is
  unchanged.
- **The local `serve` HTTP API is internal.** Agents use the CLI, the MCP server or the hosted `/api/v1`.
- Durations on the command line take `s`, `m` or `h` (`90s`, `10m`, `2h`); a number alone keeps its old unit.
- Agent worktrees and `watch --remote` downloads follow the config's `outputDir`. On Windows, `shapewall login` keeps its
  credentials in `%APPDATA%\shapewall\`.
- Node.js 22.19 or later is required everywhere (`package.json` already said so).
- Hosted servers run migrations 20 and 21 at start. Back up first;
  [Upgrading from older versions](docs/hosted.md#upgrading-from-older-versions) in the hosted guide has the rollback notes.

Deprecated, still working through 1.x with a one-line warning, removed in 2.0: `hosted --setup` (use `hosted setup`), `variant rm`
(`variant remove`), `export --noindex` (`--no-index`), `audit` (`checks lighthouse`; also `audit --production` and `audit BOARD`),
`agent run|watch|doctor|build-image` (`agent sandbox ...`), `capture --yes`, the config keys `versions` (`keepVersions`),
`notifications.boardUrl` and `github.boardUrl` (the top-level `boardUrl`), and `SHAPEWALL_USERCONTENT_ORIGIN`
(`SHAPEWALL_HOSTED_USERCONTENT_ORIGIN`).

Removed: `agent run --profile claude-code` and `--profile codex` (they were placeholders), the unused `X-Shapewall-Client`
request header, and the legacy hosted token scope `comment`: stored tokens are rewritten to `reply` and `status`, which is what
the scope always meant, and creating one with `comment` is refused.

Earlier 0.x releases were previews.
