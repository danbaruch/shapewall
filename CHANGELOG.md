# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

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
