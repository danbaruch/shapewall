# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- `shapewall capture` and `links` write and read the solo engine's board folders (`.shapewall/.engine/files/`) once the
  engine holds the project, so a capture from the terminal (every environment) shows on the engine's board, with or without
  the engine running. `push` sends from there too.
- On the solo engine, the `author` of the MCP tools `reply_to_comment` and `add_comment`, and `comments reply --author` and
  `comments add --author`, label the agent's text as they do on a 1.x board (it stays marked as an agent's). The engine's
  comment JSON says `byOwner` for comments its owner wrote, as a 1.x board does.

### Changed

- **`shapewall serve` runs the solo engine by default** (2.0.0): the hosted engine for this project, one owner, on this
  machine only, data in `.shapewall/.engine/`. `npx shapewall init && npx shapewall serve` is still a board in seconds with no
  account. The first start in a project with 1.x board data says which boards move, runs `shapewall migrate` (a backup in
  `.shapewall/backup-1x-<time>/` first; a failed run puts the folder back), then starts. Anything that stops the move (a 1.x
  `serve` or `watch` still running, a migration stopped midway, a board the engine cannot take) stops `serve` with the reason
  and changes nothing. See [Upgrading a 1.x project](docs/where-to-run.md#upgrading-a-1x-project).
- The 1.x writers refuse a board the engine holds (409 `board_migrated`): comments and replies, the board chat, the starter
  agent and `capture` into the 1.x folders, also from a `shapewall mcp` or `watch` started before the move.
- `shapewall share --remote` stops on a board the engine holds instead of sending what is left in the 1.x folders. Moving an
  engine board to a hosted server is not in this build yet; `shapewall migrate --rollback` puts the 1.x board back.
- The stable surfaces keep their 1.x shapes on the engine, checked against a committed 1.x snapshot
  (test/contract-1x.test.js): `comments --json`, `watch` and `watch --exec` JSON, the MCP tools and their arguments, and the
  lines of `.shapewall/events.jsonl`. New fields may appear, as docs/stability.md allows.

### Deprecated

- The 1.x board server: `shapewall serve --engine legacy`, or `SHAPEWALL_ENGINE=legacy` for a service or a script. It stays
  through 2.x and goes in 3.0. A flag only the 1.x server takes (`--host`, `--lan`, `--tailscale`, `--tls-cert`, `--tls-key`,
  `--allowed-host`, `--accounts`, `--accounts-origin`, `--agent-acp`, `--allow-remote-agent`, `--buzz-bridge`,
  `--trust-proxy` and the device flags) also runs it, with the same warning, so `serve --host 0.0.0.0` in a container keeps
  working. With `SHAPEWALL_ENGINE=legacy`, `capture` writes the 1.x board folders again.
- Kept through 2.x with a one-line warning on stderr, removed in 3.0: `serve --lan` and `serve --accounts` (also
  `SHAPEWALL_ACCOUNTS=1`), the `devices` command (pair through the tailnet with `serve --tailscale`), and
  `starterAgent.testCommand` (set `commands.test`). The warning now reads "will be removed in Shapewall 3.0".

### Removed

- The spellings deprecated through 1.x. Each now stops with a one-line error that names the replacement
  (`... was removed in Shapewall 2.0; use ...`), not an unknown-command error:
  - `agent run|watch|doctor|build-image`: use `agent sandbox run|watch|doctor|build-image`.
  - `audit`: use `checks lighthouse`; `--production`: use `--build-mode`; the board argument of `checks lighthouse BOARD`: use
    `--board BOARD`.
  - `hosted --setup`: use `hosted setup`. `variant rm`: use `variant remove`. `export --noindex`: use `--no-index`.
    `capture --yes` (`-y`): leave it out, capture never prompts.
  - Config: `versions` (use `keepVersions`), `notifications.boardUrl` and `github.boardUrl` (use the top-level `boardUrl` or
    `SHAPEWALL_BOARD_URL`), and `agent.localSession: "own"` (leave it out: a local board's Claude Code session is always the
    restricted one). The config refuses each with that line.
  - `SHAPEWALL_USERCONTENT_ORIGIN`: rename it to `SHAPEWALL_HOSTED_USERCONTENT_ORIGIN`. A hosted server with only the old name
    stops at start with that line.

## 1.5.0 - 2026-11-27

1.5.0 adds the solo engine, opt-in and experimental: `shapewall serve --engine hosted` runs the hosted server's engine for
one project on your own machine, with the project's agent on the same link protocol a team server's agents use, and
`shapewall migrate` moves an existing `.shapewall/` into it. The plain `shapewall serve` is unchanged and stays the default.
The engine is part of the hosted server (`src/hosted`, Functional Source License 1.1, Apache 2.0 future license); the CLI,
capture, the local board and the migration's planner, backup and rollback stay Apache 2.0. See
[Where to run Shapewall](docs/where-to-run.md#the-solo-engine-experimental).

### Added

- Solo engine (experimental): `shapewall serve --engine hosted` runs the hosted engine for one project on this machine, at
  `http://<project>-<random>.shapewall.localhost:<port>`, with its data in `.shapewall/.engine/` (refused when git tracks it or
  cannot say, but not for a stray `.git` above the project that git does not see; `--skip-git-check` to start anyway). One
  owner, no passkey: `--open` or `--print-owner-link` gives a one-time sign-in page, a private file in the data folder, so
  the one-time code is never on a command line or in the output. It works once, within 60 seconds (5 minutes when printed),
  from this machine (on Linux, your own OS user) and on the engine's own name only; the sign-in cookie is `SameSite=Strict`
  (also when it is renewed) and lasts 24 hours from the last use, 7 days at most. The start prints
  `SHAPEWALL_REMOTE=<address> shapewall agent connect` for agents. Its boards follow `shapewall.config.json`. Flags that
  reach beyond this machine are refused; `--read-only`, `--no-chat` and `--no-capture` apply to the board. The engine is
  the hosted server's code, under its license (FSL-1.1-ALv2), not the core's Apache 2.0. See
  [the solo engine](docs/hosted.md#the-solo-engine-experimental).
- Solo engine (experimental): `serve --engine hosted` runs this project's agent on the link protocol, as
  `shapewall agent connect --as local` with a token the engine makes at start (0600 in `.shapewall/.engine/`, rotated each
  start, retired at stop; the address goes in the environment, never on a command line). The board's chat, Fix with and
  comments sent to the agent go through it, with the same trust tiers and machine policy as on a team server. The agent's
  backend, endpoint, name, icon and tint come from Settings > Agent, and branch mode on a coding agent reads as
  `--approvals owner` while no approvals are saved for the connection (never written, so turning branch mode off takes it
  away). It acts only when asked (the chat, Fix with, Send to agent, an @mention). A stop, by SIGINT or SIGTERM too, stops
  it, and it stops by itself when the engine is killed. Neither it nor what it runs gets the engine's command-line or watch
  tokens. `--no-chat` runs without it. See [the solo engine](docs/hosted.md#the-solo-engine-experimental).
- Solo engine (experimental): "Capture now" on the board and `recapture_pages` on the engine's `/mcp` capture in the engine
  itself, from the live `shapewall.config.json`, straight into the board, with no push. Owner only (the board on this machine,
  or a `push` token the owner made, used on this machine); the capture browser reaches the app's origin only, never the
  engine, its live HTML origin or this machine's LAN and tailnet addresses. `--no-capture` and `--read-only` turn it off.
  Team servers never capture. See [the solo engine](docs/hosted.md#the-solo-engine-experimental).
- Solo engine (experimental): environments and compare. The engine's boards keep the config's `environments`, the board
  compares them as a local board does, `shapewall push` to the engine sends and keeps every environment's
  captures, "Capture now" takes an environment (`env`), and a comment placed on a compare card's side is stored on that
  environment (the `comments.environment` column of migration 24). The token API (`?environment=`) and the hosted MCP
  `list_comments` (`environment`) filter by it, and a vouch for "Send to agent" covers it. Team servers keep one environment
  per board (`default`) and no compare. See [the solo engine](docs/hosted.md#the-solo-engine-experimental).
- Solo engine (experimental): **Run checks** in the board's Checks panel runs the page checks in the engine itself, from the
  live `shapewall.config.json`, and the SEO tab shows that run's search previews, as on a local board. Owner only, on this
  machine; the check browser reaches the app's origin only, like the capture browser. One job at a time on the engine
  (checks and captures wait for each other); `--read-only` and `--no-capture` turn runs off. Team servers never run checks.
  Reports a push brought read as imported, the engine's own runs as its own. A run that does not stop in time is closed
  and ends as stopped, and writes nothing after; a capture that does not stop in time keeps its board, and removing that
  board answers that the engine needs a restart. See [the solo engine](docs/hosted.md#the-solo-engine-experimental).
- Solo engine (experimental): the owner makes, edits and deletes the board's own journeys from the board, as on a local
  board, with the same validation against the config file's pages. They are stored in the board's `journeys.json` in the
  engine's folder; journeys from the config stay read only. Team servers keep journeys read only. See
  [Journeys made on the board](docs/journeys.md#journeys-made-on-the-board).
- Solo engine (experimental): batch fixes on the board's chat, as on a local board: the owner picks open comments
  (Select in the comments panel), and the engine fixes them one after another through the link to the connected agent.
  Each fix is its own turn with its own trust (a comment by someone else never runs solo-tier), its own approval cards and
  its own branch. The engine's owner only, signed in from the terminal on this machine, checked again before each fix.
  Off until `agent.batchFixes` turns it on; team servers have no batch routes. See
  [the solo engine](docs/hosted.md#the-solo-engine-experimental).
- Solo engine (experimental): the engine writes `.shapewall/events.jsonl` in the same line format as the local board and sends
  notifications as `serve` does, so `shapewall events`, bots and notification channels keep working. See
  [the event log](docs/notifications.md#the-event-log).
- Solo engine (experimental): About and updates can check for and apply an installation update, as on a local board: the
  installer's fixed helper only, for the engine's owner on this machine. See
  [Installation updates](docs/updates.md#on-the-solo-engine-experimental).
- Solo engine (experimental): the board's `/info` says `solo: true` and lists the local-only features the engine serves
  (`soloFeatures`). The board turns those on for the engine's owner only (journey editing, checks runs, batch fixes, the
  capture hint in the empty state), each once the engine serves it. Team servers never send `solo` and keep their behaviour.
- `shapewall migrate` (experimental): moves one project's `.shapewall/` into the solo engine (`.shapewall/.engine/`).
  Captures, versions, variants, environments, diffs and journeys move as files; comments (with images, drawings, reactions
  and replies), chat threads and the local `serve --accounts` owner with their passkeys and recovery codes become engine rows.
  `--dry-run` lists the counts and every item that would not come along, with the reason. A hard-link backup goes to
  `.shapewall/backup-1x-<time>/` first, a failed run puts the folder back, a second run does nothing (`MIGRATED-TO-2`), and
  `--rollback` restores every board checked byte for byte, from the backups a run recorded only, linking or copying only
  the backup's own files (each checked by device and inode as it is read). A run that finished but was stopped before it
  removed `MIGRATING-TO-2` counts as finished. It refuses while serve (either engine), capture, watch or an agent runs,
  holds the boards' comment and chat locks for the whole run, and after a run that was stopped midway points at
  `--rollback`. Only comments the board stamped as the owner's become the owner's; others signed with the owner's name come
  in as imported text. Agent settings and keys stay on the machine; sign-in sessions and paired devices do not move (sign in
  and pair again). The planner, backup and rollback are part of the Apache 2.0 core; only the engine database writer
  (`src/hosted/migrate`) is under the server's license. After a run, start the engine with `shapewall serve --engine hosted`.
  See [moving a local project into the engine](docs/hosted.md#moving-a-local-project-into-the-engine-shapewall-migrate).
- `shapewall agent connect --endpoint` (experimental): a model endpoint (Ollama, DeepSeek, OpenAI or any OpenAI-compatible
  server) as a connected agent, read and answer only: no edits, commands, tools, browser or extensions. The key stays in
  its variable and is never printed, logged, saved or sent to the server.

### Changed

- Solo engine (experimental): while `shapewall serve --engine hosted` runs, `shapewall comments`, `watch` and `mcp` in the
  project folder go to the engine instead of the 1.x files in `.shapewall/<board>/`, which before showed comments that were
  not the board's. The engine makes their project tokens at each start (owned by you, private files in `.shapewall/.engine/`,
  a new secret each start, retired at stop); `serve.json` there names the address and the files, never a token. `watch` is
  an agent of its own there, as `watch --remote` is. `comments get` and `comments add` work against a hosted board too.
  `export` is refused while the engine runs unless `--no-comments`. With the engine stopped, the commands say on stderr when
  the engine has kept comments, and refuse a board `shapewall migrate` moved. An explicit `--remote` wins.
- Solo engine (experimental): the commands in the project folder ask the engine to prove it is this start's engine (a
  challenge answered under a key in `serve.json`) before they send a token, and refuse when nothing proves it. A start rotates
  the machine tokens without putting back a scope or an expiry removed in the console. On the engine the token API and `/mcp`
  answer the engine's own name from this machine only (on Linux, your own OS user). A `shapewall` command an agent started
  (`watch --exec` without `--pass-token`, a connected agent's own commands) gets no engine token. Agents never read
  `.shapewall/.engine/`: the agent sandbox refuses it, and Claude Code gets a Read deny rule for it.
- `shapewall serve` and `shapewall watch` do not start while `shapewall migrate` runs or after one stopped midway, and refuse
  the boards a migration moved to the solo engine.
- `--remote` accepts plain `http` to the solo engine's own name (`<project>-<random>.shapewall.localhost`) as it does to
  `localhost` and `127.0.0.1`, and connects straight to 127.0.0.1 for it whatever the system resolver says. Plain `http` to
  those names never goes through a proxy, also with `HTTP_PROXY` and `NODE_USE_ENV_PROXY` set.
- `shapewall hosted claim`, `setup-link`, `move-origin` and `admin` refuse a solo engine's data folder.
- Installation updates: answer folders a stopped server left in the temp folder are removed after a day, and an update helper's
  answer is read only through the file the server made.
- Hosted servers: stopping one while an update is being applied waits for the update to finish (it no longer gives up after
  8 seconds), and exits with the code the update asked for.
- Hosted servers: migration 24 prepares the database for the solo engine. It adds `comments.environment` (every existing comment
  is on `default`), lets `sessions.via` be `local` (a rebuild of `sessions`, like migration 18) and adds the `solo_binding`
  table. Nothing changes on a team server. Stop `shapewall hosted admin` jobs before the first start. Rollback notes:
  [Migration 24 and rollback](docs/hosted.md#migration-24-and-rollback).

### Fixed

- Hosted boards: opening Checks no longer gets a 404 for the SEO tab. The board answers with no search previews (they stay on
  the machine that ran the checks), so the tab shows the pushed reports' SEO issues.
- Solo engine: a whole push no longer drops the board's journeys.json when it cannot be carried (a link, a FIFO or other
  special file, or over 4 MB). The commit is refused with 409 `board_local_unreadable` and the board stays as it was; a FIFO
  is refused at once instead of hanging the commit inside the write lock.
- Solo engine: deleting the workspace the engine serves, or the account that owns it, is refused with 409 (`solo_workspace`,
  `solo_owner`). Deleting either would leave the engine bound to nothing, and a capture or checks run going at that moment
  would write its files back under the removed folder. To start over, stop the engine and move its data folder aside.
- Hosted backups: a capture that takes its board lock while the backup pins board folders (from another process) no longer
  risks a half-renamed pin. The locks are read again after the pin; if one appeared, the pin is dropped and the backup waits
  and pins again.
- Solo engine: "Update now" asks the owner to type the workspace's name first, as the console does for its other
  always-asking actions (passkeys are off on the engine). A check does not ask.

### Security

- Agents: an ACP agent's file reads (`fs/read_text_file`) no longer reach Shapewall's own store (`.shapewall/`: accounts,
  sessions, notification settings, tokens), the recorded logins in `.shapewall-auth/` or the config's `auth.storageState`
  files, through a link either; only writes were refused before. A Claude Code agent also gets `Read` deny rules for those
  paths in its session settings, since it reads files itself (checked against a real Claude Code on Linux: Read, Grep,
  Glob and links into the store are refused). Comments and captures reach agents through Shapewall's tools as before.
  Codex, goose and Gemini CLI read files with their own tools, which take no per-path deny, so on a local board they can
  still read these paths; for a board where people you do not trust write comments, use Claude Code, or a connected agent
  (`shapewall agent connect`), whose commands run in the OS sandbox.
- `shapewall serve --open` and `shapewall settings --open` no longer put the one-time open link's nonce on the browser
  opener's command line (`xdg-open`, `open`, `explorer.exe`), where another user of the machine could read it and open the
  board as its owner first. The browser is opened on a page in the project's `.shapewall/` folder, readable only by you, that
  posts the nonce to `POST /open`; the page is removed once used, when it expires and when the server stops. With no browser,
  the page's path is printed instead of the link. `GET /open/<nonce>` no longer opens anything.
- `POST /open` no longer redirects to `#settings-token=...`: it answers with a page that puts the settings token in the tab's
  session storage and opens the board, so the token never lands in browser history. Open pages a stopped server left behind are
  removed when the next server for the project starts.
- `serve --accounts`: the account session cookie is `SameSite=Strict` on every issue (was `Lax`), so a link or form on another
  site, to any port of the board's host name, never carries it. On a loopback account origin on Linux, a request that carries
  it counts only from a socket of the OS user running `serve`.

## 1.4.0 - 2026-11-26

One capability model for every agent path: who wrote a turn decides its tier (solo, team or open), the machine sets the
ceiling, and the agent runs named commands, a sandboxed shell and a throwaway browser through Shapewall. See
[What an agent can do](docs/agent-capabilities.md).

Known limits in 1.4.0:

- A local board editing in place (Work on a branch off) gives its agent no commands, no shell and no ACP terminal. Turn on
  Work on a branch to get them.
- On macOS, an agent session that edits gets no commands, no shell and no ACP terminal on any tier. The one exception is the
  solo owner's `agent set shell-unsandboxed on` shell, an opt-in that runs outside every check.
- Hosted threads that exist at upgrade become open-tier (migration 23 marks them tainted). Start a new thread to get solo back.
- An agent reply sent with a forged agent header before 1.4.0 carries no unvouched mark and still reads as the agent's.
- On a hosted server, migration 23 adds `chat_threads.tainted`, `taint_authors` and `trust_v`. To roll back, stop the server
  and drop the three columns (see the rollback notes in docs/hosted.md); the older build ignores them.

### Added

- Config `commands`: named commands (`test`, `build`, `dev`, `lint`, ...) an agent may run through Shapewall, each one command line
  run without a shell (`$PORT` is the one variable), with `inputs` (what an approval covers), `mutating`, `args` and `ready` (a dev
  server's loopback URL). `starterAgent.testCommand` still works; `commands.test` wins when both are set. See "Commands" in the
  config docs.
- Config `agent.browser.allow` (extra origins for the agent's throwaway browser, besides every `baseUrl` and `publicUrl`) and
  `agent.fixIn` (`"copy"`, the default, or `"checkout"` for a local owner's own turns).
- One capability model behind every agent path: what a turn may do follows who wrote it (solo, team or open), the machine that
  runs the agent sets the ceiling, and a project's agent policy on a hosted server can only lower it (`maxTier`, `shell: false`,
  `browser: false`, per project and board). Unknown values read as the narrowest. The console card, `agent status` and the agent's
  own instructions show the same lines (one renderer each), and named commands, the sandboxed shell and the throwaway browser all
  follow it. See "What each turn may do" in the agent hardening guide.
- `agent-policy.json` version 2 (experimental): `trustTeam`, `trustTeamShell`, `shell`, `shellNetwork`, `shellUnsandboxed`,
  `commandApproval`, `browser`, `browserAllow`, `browserAuth`, `browserProfile`, `browserProfileTeam`, `extensionsFor`,
  `allowTool` and `handoffHops`; the same keys as a project's `capabilities` entry in `agents.json`.
- A connected agent's hello says what each tier may do on its machine, as on, ask or off per line (no commands, names or paths); the
  console's agent list carries it, a line it cannot read shows as unknown, and a change is an `agent_capabilities_changed` audit
  row naming each line.
- The agent's throwaway browser (`src/agent/agent-browser.js`, internal): a headless Chromium per task, limited to the app's own
  addresses by Shapewall's request routing and a loopback egress proxy (redirects, WebSockets, workers, popups and `file:`, `data:`,
  `blob:` navigations included; service workers blocked; app hostnames pinned to the address they had at start), no CDP port, its
  profile folder removed at close, on a crash, on a signal and by the next start after a kill. A recorded login or a Shapewall-made
  profile only where the turn allows it. On a hosted Fix with whose Browser line is on, the `browser_*` tools are in Shapewall's tool
  host beside the commands, their arguments checked against their schemas, and the browser is disposed when the fix ends.
- On Linux with the OS sandbox, the agent's browser runs inside it: Chromium sees no home folder, writes only its session folder,
  and reaches only the allowed addresses, through Shapewall's egress proxy (pinned addresses) and then the sandbox runtime's proxy,
  whose list holds exactly those address:port pairs. A sandboxed start that fails leaves the browser off for the task (unless the
  machine allows the host start then). macOS, Windows and machines without bubblewrap start it on the host as before.
- "What it can do": each agent on a project's Agents page (and a local board's Agents page, for its owner) has a card with every
  capability line per place and tier, an on, asks first, off or unknown chip, one sentence, and the command that changes it on the
  agent's machine. A line the project's setting holds says so. The board's agent panel shows the main lines for a fix you ask for.
- `shapewall agent status [--remote URL] [--as NAME] [--json]`: the same lines from this machine's own policy, with whether a
  connected agent's link is open. `shapewall agent set KEY VALUE` changes one line without reconnecting.
- API tokens: **Has agent access (claim)** lists tokens that may take comments but are not listed as agents, with **Make this an
  agent** and **Remove claim access** (`agent_made` and `token_claim_removed` audit rows).
- The token API's `/project` says which agent the token is and its state (online while its link is open).

- Commands through Shapewall on a hosted Fix with: the agent gets Shapewall's own tools (`run_named_command`, `run_command`,
  `shapewall_capabilities`, `start_dev_server` and `stop_dev_server`) and never its own
  shell. On Linux (bubblewrap, socat and ripgrep) and macOS (Seatbelt) every command runs in an OS sandbox through
  `@anthropic-ai/sandbox-runtime`: it writes only in the fix copy and its own tmp folder, cannot read the home folder, the XDG
  folders, the shared temp folders, `/run/user`, `/mnt`, `/media` or other fix copies, gets a clean environment, reaches the package
  registries only (or nothing) and runs under process, address-space and file-size limits, with its tmp folder capped. Solo turns
  run named commands without a card and get a sandboxed shell; open turns ask with a card (`command`) every time, and an allow is
  checked again against the machine's rules and the checkout's config line before the command runs. Solo and team approvals in the
  sandbox are recorded on the machine per command line, tier, sandbox mode, network and inputs (the manifests, lockfiles and `.npmrc`
  always among them), and asked again when the agent changes one; answers on open turns or without the sandbox are never recorded.
  Files a command or dev server changed hold the fix for a look. See "Commands through Shapewall" in the agent hardening guide.
- Dev servers in the OS sandbox (Linux): `start_dev_server` runs the `dev` command in a sandbox of its own and bridges exactly one
  loopback port to it, a port Shapewall binds and holds until the server stops (needs `nsenter`, util-linux). That port joins the
  agent browser's allowlist for the session and leaves it at stop; the agent's other commands cannot reach it. Without the sandbox
  the browser gets a dev server's port only when the server's own process group is what listens there. Shapewall's own server port
  is never opened in the agent browser (`denyPorts`). Not in macOS's sandbox, which could only open every loopback port to it.
- The starter agent on the capability model: each run is resolved on the host (path `starter`) from the gate's trust (team when
  every author whose text reaches the model is on the board's trusted list, otherwise open) and the checkout's config. Besides
  `run_tests` (`commands.test` wins over `starterAgent.testCommand`) it gets `run_named_command` for the other names in `commands`
  (`build`, `lint`, ...; the lines come from your checkout, never from the agent's), with the same re-ask rule as `run_tests` (an
  input the agent changed, a file a command changed since the run started, an approved shell command; on an open run every time).
  `dev` starts in the background on a port in the container, and the `browser_*` tools (no screenshot: the model reads text only)
  open that port; Chromium starts without its own sandbox there only on a team run. The prompt ends with the capability block.

- Every agent path on the capability model: a local board's chat (ACP and endpoint), a connected agent's chat, its Fix with, a
  comment sent to it and `watch --exec` resolve what the turn may do, and every prompt carries it after the instruction files.
  Commands, the sandboxed shell, dev servers and the browser come from Shapewall's tool host on each of them. A local board's
  commands run in the OS sandbox in the checkout with its `.git` and `.shapewall` folders read only (`.shapewall` unreadable), its
  own cards are answered on the board by the owner, and solo approvals are kept in `.shapewall/agent/approvals/` under the same rule
  as a connected agent's. A connected agent's chat and comment turns answer only: commands that change no files, on a read only
  view of the checkout, never the shell.
- `watch --exec` passes `SHAPEWALL_CAPABILITIES_FILE`, a `0600` JSON file with the comment's resolved capabilities and the same
  text a board's agent reads (not enforced: the command's own sandbox is the boundary).
- Extensions on trusted turns (Claude Code over ACP): skills (`skills/NAME/SKILL.md`) and stdio MCP servers (the user-scope
  `mcpServers` of `.claude.json`) from an agent config folder the machine names itself (`--agent-config DIR` for a connected agent,
  `shapewall agent set agent-config DIR` for a local board). Never the default folder, `~/.claude`, `$CLAUDE_CONFIG_DIR` or
  anything in the project; the folder must be this user's, not writable by others (nor any folder above it or any skill folder in
  it) and outside temporary folders. Settings, hooks,
  commands, agents and installed plugins in it are skipped and listed. A turn gets them only above the open tier, when everyone who
  wrote it and everyone who ever wrote in its thread is in `extensionsFor`; a server's tools only by exact name (`allowTool`), each
  call checked on the machine. Only Claude Code's restricted session takes them. The card, `agent status` and the prompt block
  show the same Extensions line.
- Thread trust: a thread that ever carried text nobody can vouch for (a share link guest, someone outside the workspace, another
  agent's answer, a move to another agent, a comment by a token or an import, someone else's comment or reply the prompt quotes,
  or a board tool's result with other people's comments) is tainted for good and never gets extensions. A board tool's result
  mid-turn refuses every extension tool and every board write for the rest of the turn and ends the session with it. One
  transition table (`src/agent/thread-trust.js`) for every writer.
- Hosted database, migration 23: `chat_threads.tainted`, `taint_authors` and `trust_v`, for thread trust. Every thread that
  exists at upgrade is marked tainted, and so is a thread an older build wrote in later (rollback notes in docs/hosted.md).

### Changed

- **Upgrading: owners lose solo in threads that existed before 1.4.0.** Those threads are tainted (hosted migration 23; on a
  local board, a thread with messages and no trust record), so every turn in them is open: commands ask on a card, no full
  shell, no extensions. Start a new chat thread to get solo back; the old threads keep working as open ones.
- A local board's Claude Code session is restricted: read and edit tools plus Shapewall's tools, no shell of its own, no settings
  files (`~/.claude` allow rules, hooks, plugins, `.mcp.json`), no auto memory. `agent.localSession: "own"` keeps the 1.2.0
  session, with a deprecation warning, until 2.0. Other ACP adapters keep their own session.
- A local turn is solo only while every word in it is the owner's (a private chat, or a comment the owner wrote on a board only
  the owner can reach); anything else is open, and commands wait for a card. Above the open tier, other people's comments are
  counted in the board context, not quoted.
- A comment picked up by a connected agent without a narrowing from the server is open with no commands, and a running turn asks
  the server for its narrowing again before each command (at most every 5 seconds): a project or board tightened mid-turn applies
  to the commands after it, up to 5 seconds late, and a turn never widens.
- Command cards are allowed in a connected agent's chat and comment turns too (read-style commands only), still never where the
  project or board took commands away.

- The agent browser: an address on the agent's machine (a loopback address in any spelling, `localhost`, a local name such as
  `app.test`) that a committed config names counts below the owner's own turn (team, open, and solo with a browser login) only
  where the machine's `browserAllow` lists that exact origin; the Browser line names what it held back and the command that
  lists it. Persistent agent browser profiles live in `$XDG_STATE_HOME/shapewall/agent-browser-profiles/NAME` (yours, `0700`,
  never a link, out of reach of the agent's commands) and are checked again after Chromium starts; a profile path saved
  elsewhere reads as no profile, with a warning. New machine policy key `browserNoSandbox` (`agent connect --browser-no-sandbox`,
  `agent set browser-no-sandbox on`, default off): the browser may start without Chromium's own sandbox where it cannot start,
  on solo and team turns only, and the Browser line says so. `agent connect --browser-profile NAME` makes and saves a profile.
- Who "the owner" is on a connected agent's turns is pinned on its machine: the handle of the account that approved it (saved
  with the token, or the first one the server names, then saved), not the server's word alone. With `--approvals owner` a card's
  "allow" must name that handle as the one who answered.
- Named commands on Windows run without a shell: `node`, `npm` and `npx` as Node plus their script; a `.cmd` or `.bat` program is
  refused. Without an OS sandbox (Windows, no bubblewrap) there is no full shell, and every named command waits for a card.
- `$PORT` in a command line must be bare: quoted (`'$PORT'`, `"$PORT"`), escaped (`\$PORT`) or as the program it is refused.
- Older claim tokens are no longer made agents just by opening the board or the console: a token becomes one when it calls the
  server. An older watcher nothing was heard from in 90 days is hidden, not deleted (`agent_hidden` audit row), and lists again as
  soon as its token is used.
- A version 1 `agent-policy.json` is read as exactly what it allowed (no shell, no browser, no extensions, a card for every
  command), and the next save writes it back as version 2. A connection with no saved entry, or one 1.3.0 saved without flags,
  still reads and answers only: each wider capability is a key its owner sets. A version 1 entry with `approvals` "owner" (or
  "admins") and exact commands also gets the project's named commands (config `commands`), each behind a card on the board.
- A connected agent whose machine takes no approvals (`approvals: "none"`) gets no commands and no shell on any tier: a full shell
  or a command that changes files counts as an edit.
- `agent.browser.allow` in the config is capped by the machine's `browserAllow`, except on a solo turn of a machine without a
  login for the browser.
- `browserProfile` takes only a folder Shapewall made for the agent (marked, links resolved); any real browser's profile folder,
  a copy of one or a link to one is refused.
- An origin is never a wildcard, and a machine audience it cannot read is "server", not "owner".
- The `agent_policy_changed` audit row says which settings of which board changed, not only how many boards.
- A hello that arrives after a newer one from the same process no longer replaces what the newer one said.

### Fixed

- A connected agent's reply on a long comment answer is cut to the comment limit instead of failing to post.
- A command started through a chat thread's tool relay stops when its turn ends; before, it could keep running (and writing)
  after the turn.
- The agent browser checks again before every step and every start: a browser turned off mid-turn is closed, and a tier or
  `browserNoSandbox` change takes effect at the next start.
- This machine's own LAN and tailnet addresses count as "on this machine" for the browser's held-back config origins and for its
  denied ports; on open turns, private and tailnet addresses the config names open only where the machine lists them.
- Two `start_dev_server` calls at once can no longer both start a server past the limit (and leave one running after the turn).
- A dev server's port let go while the browser started is never let in again.
- Commands cannot read the login files the config records (`auth.storageState`, `auth.loginScript`) anywhere in the folder they
  run in, not only in `.shapewall`.
- An exact command or a shell command allowed on a card is checked again after the answer, and a local card's answer counts only
  while what it asked is still allowed.
- `agent set allow-command` (and `agent set auto commands`) is refused with the same reason `agent connect` gives, instead of
  saving commands that connect then reports as not in effect. The capability lines no longer suggest `agent set allow-command` or
  `agent set handoff-hops` (neither turns anything on in this release), and the unsandboxed shell line names the real setting
  (`agent set shell-unsandboxed on`).
- The approval page no longer promises a connected agent "never runs a command" when its machine allows named commands, and the
  chat's Connect note and the agent settings say Claude Code gets the restricted local session, while Codex, goose and Gemini CLI
  bring their own tools.
- A team turn's commands get no network: the package registries take uploads as well as downloads, so the registries are for the
  owner's own turn only.
- A command line too long to show whole on its approval card is refused instead of cut, and a card's detail is cut only after the
  command line.
- On a team or open turn, the agent browser opens a port on this machine only for an origin the machine lists itself (or a dev server
  of the session); a public name that resolves to an address of this machine is refused.
- The agent browser is made again when its Browser line narrows mid-turn (allowlist, login, profile, `allowNoSandbox`,
  `allowHostLaunch`), and a dev server that exits on its own leaves the browser's allowlist at once.
- Handing work to another agent (`handoff-hops`) is off on every path until it is built: the Hand off line no longer reads on
  for a value above 0, `agent set handoff-hops` takes only 0 ("not available yet"), and a larger value in the policy file reads
  as 0 with a warning at `agent connect`.
- `agent set` on a connected agent reaches a running `agent connect`: a narrower value applies from its next turn (and the board
  is told), a wider one is logged and waits for the next connect.
- The narrowing re-check before a command or browser step asks the server again after a failed answer, instead of skipping 5
  seconds, and steps that run at once wait for the same answer.
- An agent hidden for inactivity that came back and went quiet again is written to the audit log as hidden again.
- A running `agent connect` without edits no longer logs on every turn that its policy file "would widen" approvals: a reload is
  compared with what the file said, not with the link's own "no approvals".
- The unconnected chat's Connect note says which session Claude Code gets on this board: the restricted one, or its own when
  `agent.localSession` is `"own"`.

### Security

- The agent's file tools check the file they opened, not the path again: a link or folder swapped in while a read or write is under
  way can no longer make it read or write outside the project (Linux: the opened descriptor; elsewhere a device and inode check, and
  reads and writes wait while a command runs in the project). Missing folders are made one at a time inside the folder opened
  before them, and a file with a second name (a hard link) is never read.
- On macOS, an agent that edits files gets no commands, no shell and no ACP terminal in 1.4.0, on every tier: Shapewall cannot
  check where a write lands there once a command has run. The one exception is a solo owner's `shell-unsandboxed on` shell
  (an opt-in, with its warning). Read-only sessions keep read-only commands in the OS sandbox. The
  processes a command left behind (those that left its process group included) are killed when it ends.
- An ACP agent working in the checkout itself (no Work on a branch) is offered no terminal, whatever the agent or
  `agent.localSession`.
- A hosted board's Q&A turn makes the recorded logins' folder before its first command, and the folder is denied by path even
  before it exists.
- Commands get `BABEL_CACHE_PATH`, `NX_CACHE_DIRECTORY` and `TURBO_CACHE_DIR` in the session's temp folder, so those caches
  do not try the read-only shared `node_modules`.
- A local board whose edits land in the checkout itself gives the agent no named commands and no shell (they could leave files
  that run later on their own); with Work on a branch, commands run in the branch copy.
- A fix copy without `node_modules` sees the checkout's read only, so a team turn's commands (no network) still run the project's
  tools.
- Every JavaScript or TypeScript `*.config.*` file and the plugin rc files (`.postcssrc`, `.swcrc`, `.parcelrc`, `.eslintrc`,
  `.prettierrc`) are inputs of every named command, so a change to one asks again.
- An approval covers every byte of a command's inputs (no size and time stand-in past 8 MB); a command with more inputs than
  Shapewall checks asks every time and is never remembered.
- The person's own checkout is unreadable to sandboxed commands wherever it is (not only inside the home folder), and so is every
  other account's home (`/home`, `/Users`, `/var/home`); programs on `PATH` installed in another home still run.
- A read-only command session never starts without the OS sandbox.
- On Linux with a systemd user manager each sandboxed command runs in a scope of its own, capped for the command and everything it
  starts together (memory with no swap, processes, CPU weight), in the slice Shapewall runs in; elsewhere the ulimit caps stay. A fix
  copy that grows past 8 GB takes no more commands.
- Recorded logins (`.shapewall-auth`) are unreadable to commands, in the checkout and in the config folder; the folder is made
  before a command session starts so it is hidden from the start, and `shapewall auth record` waits for no agent command to run
  in the project.
- A turn's prompt says what its tool host offers: a command session that did not start offers no commands there, and a read-only
  turn without the OS sandbox gets no commands (said so in the capability lines).
- A recorded login's cookies are never given for a host a session dev server listens on (a cookie has no port).
- On an open turn the agent browser always keeps Chromium's own sandbox: it starts on this machine with it instead of inside the OS
  sandbox without it.
- CI: one AppArmor profile per installed headless shell version, so each binary keeps its exact-path namespace policy.
- Who wrote a turn is one answer for its tier and for its thread's trust. A comment that a message mentions (directly, as an
  element, or among an `@person` mention's open comments) now counts as an author of the turn on a hosted board, so a member can
  no longer bring someone else's comment into a solo or team turn and get that turn's shell. A token's or an imported comment
  counts as an author nobody vouches for. On a local board, a message that mentions someone else's comment makes the turn open.
- A connected agent's machine holds back, on every turn above open, each mentioned comment whose author is not one of the turn's
  authors (number only), and counts an `@person` mention's open comments by others instead of quoting them, whatever the server
  sent.
- A thread keeps what it carried for the tier too: a person whose message was pruned still counts, and a thread tainted by text
  nobody vouches for stays open. An agent session is never reused across tiers or across a thread deleted and started again
  under the same id (`turn.generation` in the job), so an open turn's text cannot carry into a solo or team turn.
- With `audience: owner` on the machine, a turn is refused unless its asker is the account this machine pinned as its owner; the
  server's `owner` label alone no longer passes.
- On a local board, a solo turn's board tools (`list_comments`, `get_comment`, for an endpoint and through the owner MCP server
  for an ACP agent) give the owner's own comments only and count the rest, so other people's text never reaches a solo turn
  that way. A thread is tainted only when someone else's text actually came back, a tainted local thread is open from then on,
  and if other people's text still comes into a turn above open, its commands and browser are off for the rest of that turn.
- A connected agent's open turn that was given the board's other open comments tells the server when it finishes, and the
  server taints the thread: an answer that repeats those comments never reaches a later solo turn there (after `agent set
  audience owner`, a raised ceiling or a team that reconnects).
- The trust block's thread state caps the tier too: a turn in a tainted thread is never above open, whatever its authors say.
- The board write tools (`reply_to_comment`, `set_comment_status`, `resolve_comment`) of a local endpoint agent give back the
  write (id, status, agent status, reply id), never the comment's text, as the MCP tools do. Any tool result that still carries
  someone else's comment taints the thread and, on a turn above open, turns the commands and the browser off for the rest of it.
- On a local board, a reply sent with the agent header from anywhere but the owner's own machine is still an agent's (it wakes
  no agent) but no longer counts as the owner's words, and an edit or a resolution note on the owner's comment by anyone else
  makes the comment no longer the owner's alone. Above open, the owner MCP server and a composer mention show a journey made on
  the board by its pages only (no name, description or fork labels), and on a board others can reach, mentioning one makes
  the turn open. Upgrading: a reply sent with a forged agent header before this release carries no mark and still reads as the
  owner's agent's; check the replies on your own comments on a board others reached, and delete any you did not send.
- A connected agent's answer always says whether its turn was given other people's text (`outsideText`), and a turn whose job
  carried such text taints its thread however it ends unless the answer says it was dropped: a missing field (an older
  machine), a lost link, a revoked agent and a Stop whose answer came too late all taint.

## 1.3.0 - 2026-11-25

### Added

- `shapewall open`: prints and opens a deep link to a board, a page (`--page`), a comment (`--comment`), a screen size
  (`--viewport`), a page's before and after (`--compare`) or two environments (`--compare A_B`), on a local board or a hosted
  project (`--remote URL`). `--print` and `--json` print without opening.
- Board links take `p=<page>`: the board opens flown to that page. Every link Shapewall makes (notifications, GitHub issues,
  usage rows, `share` and `push` answers, `shapewall open`) now comes from one builder; see "Links to the board" in the agent
  workflow docs.
- Follow an agent: with the board open beside an agent, it flies to each comment the agent takes, and after the agent recaptures
  that comment's page it opens the before and after of that screen only; other screens the recapture changed wait in a quiet
  "N more screens changed" menu. Start it with **Follow agent** on the canvas (hosted: **Follow &lt;name&gt;**), a
  `follow=<agent id|any>` link, or `shapewall open --follow [ID]`. Moving the canvas or opening another comment stops it. It reads
  only what the viewer already sees: local boards for any tab, hosted boards for members (never share-link guests or public
  viewers). See "Follow an agent" in the agent workflow docs.

- MCP `list_comments` filters, on `shapewall mcp`, `mcp --remote` and a hosted server's `/mcp`: `author` (`"me"`, a display name or an
  `@handle`), `since` and `until` (`"today"`, `"yesterday"`, a date or an ISO date-time, in the machine's time zone or `timeZone`,
  stated back as `range`), `q`, `pageName` (several matches return candidates), and paging with `limit` (default 50, max 200) and
  `cursor`. "All comments I left today on the Features page" is one call.
- MCP `board_link`: a link to the board, a page, a comment, a viewport or a page's before and after, and with `follow` (`"any"` or an
  agent id) a follow mode link. Every comment and page result carries `link`, and `recapture_pages` answers with a compare link per
  page and viewport.
- MCP `compare_captures`: a page's current capture against the one before it (or any two versions) as two images, with a pixel diff
  summary and the compare link. It compares for real on hosted boards too.
- The MCP servers share one set of instructions: find work with the filters, check the work in your own browser while you work,
  `recapture_pages` publishes the final state as the hand-in, `compare_captures`, then reply with the compare link and set `done`.
- Token API `GET /api/v1/boards/:board/pages/:page/versions` (scope `read`): a page's capture history with file URLs.
  `GET /api/v1/project` says which account made the token (`token.createdBy`).

- `shapewall init` writes a short Shapewall section into `AGENTS.md` (and a one-line `CLAUDE.md` that imports it, when there is
  none), between `<!-- shapewall:start v1 -->` and `<!-- shapewall:end -->`, so an agent finds the board with no plugin. The first
  `serve` or `capture` creates the files only in a project with neither `AGENTS.md` nor `CLAUDE.md` and no `"agentDocs"` in its
  config; an existing file is never edited unasked (serve prints a one-line hint instead). `init --no-agent-docs` and
  `shapewall agent docs --remove` write `"agentDocs": false` into the config, so the choice holds in every clone;
  `shapewall agent docs --write | --remove | --print` does it by hand. Markers in fenced code blocks do not count, a doubled start
  marker is refused, and a newer Shapewall's section is left as it is.
- `shapewall agent setup` registers the `shapewall` MCP server with Claude Code (`--scope local` by default, or `user`, `project`)
  and Codex (`~/.codex/config.toml`, with `tool_timeout_sec = 600`). It shows the change and asks first (`--yes`, `--dry-run`),
  backs up each file (a project's `.mcp.json` outside the project; the newest 3 for `~/.claude.json`), writes through a symbolic
  link to the real file, touches only the `shapewall` entry, updates an older Shapewall's entry, replaces a different one only with
  `--force`, puts the old Claude Code entry back when an update fails, and `--remove` takes it out. It registers the project's own
  install, else `shapewall` on PATH at this version or newer (for every-project entries, never one in a `node_modules` folder, npx's
  cache or the project), else `npx -y shapewall@<version>`; on Windows, `cmd /c` for `.cmd` programs except in a committed
  `.mcp.json`. The Codex edit reads its result back and refuses to write if any other line would change. `--remote URL` registers
  `shapewall mcp --remote URL` after `shapewall login`; no token is written.
- A Claude Code and Codex plugin (experimental), from the repository's own marketplaces (`.claude-plugin/marketplace.json`,
  `.agents/plugins/marketplace.json`): the `shapewall` MCP server plus the skills `shapewall`, `shapewall-next`, `shapewall-open`
  and `shapewall-status`, whose text comes from the MCP server's instructions. Its launcher starts the project's own install, else
  `shapewall` on PATH at the plugin's version or newer (skipping the same PATH folders as an every-project `agent setup` entry:
  npx's cache, any `node_modules` folder and the project), else `npx -y shapewall@<version>`, in the nearest folder with a
  `shapewall.config.json`; a hosted board through the Claude Code `remote_url` option or `SHAPEWALL_REMOTE`. Not in the npm
  package. See docs/plugins.md and https://shapewall.com/docs/plugins.
- Connected agents follow instruction files: `shapewall agent connect` reads the project's `CLAUDE.md` and `.claude/CLAUDE.md`
  (its `AGENTS.md` when neither exists) and the connection's own agent config folder's `CLAUDE.md`, and hands them to each session
  as an appended system prompt, with Shapewall's data rules last. New flags `--instructions all|project|none` and
  `--agent-config DIR|none` (saved per connection; the folder is never created for you). The terminal, the board's Agents panel and
  the console's Agents page list the files by name (the console with short sha256 hashes); their text never leaves the machine. A
  fix reads them from its own copy of the project. They add no powers.
- "Shapewall tools for Buzz agents" in docs/buzz.md: the MCP server for Claude Code, Codex and goose agents in Buzz.

- **Send to agent** in the chat composer of a shared thread (the button beside Send, or Ctrl/Cmd+Enter), and **Answer every
  message** in Chat settings for the person who connected the thread's agent (hosted) or the owner (local). One set of trigger
  rules for every path, `src/agent/triggers.js`; see "When an agent answers" in docs/agents.md.
- `shapewall agent connect --respond thread|mention`: whether this machine honors a shared thread set to answer every message
  ("thread", the default) or answers an @mention and Send to agent only ("mention"), whatever the server says. Saved in
  `agent-policy.json` as `respond`.
- Hosted database, migration 22: `chat_threads.respond_mode`, for the per-thread setting (rollback notes in docs/hosted.md).

- The plugin guide is a page on the site (https://shapewall.com/docs/plugins), and the Features page and docs index cover agent
  setup, links and follow, and shared threads.
- A release text gate (`npm run check:text`, run by CI on the lines a change adds): no en or em dashes or banned phrases
  (`scripts/release-text.config.json`), plus names from a private list kept outside the repository.

### Changed

- **Shared threads answer only when asked, like a chat app.** On a hosted board, the board chat and a comment's chat no longer send
  every message to the agent. A message starts a turn only when it @mentions the agent (`@agent` or its own handle, such as
  `@builder`), when someone presses Send to agent or Fix with, or when the person who connected the agent set that thread to
  answer every message. Every other message is kept and shown to the people in the thread, needs no online agent, and is read by
  the agent with the next message that is for it (only when its author is in the agent's audience, as before). A private chat (New
  chat) still answers every message. The agent's own machine checks the same rule again, and a thread that changes agents goes
  back to mentions only. On a local board only you chat on, nothing changes; on a board shared with `--chat`, the board chat and
  comment threads answer mentions and Send to agent only.
- Text marked as an agent's never starts an agent turn, even when it @mentions an agent or the thread answers every
  message (docs/agent-hardening.md lists what is marked; a header-less HTTP post from a process Shapewall did not start is not, and
  reads as a person's): `watch --mention` (local and `--remote`) and `GET /api/v1/.../comments?mention=` count only mentions people wrote, a
  comment an agent wrote is never handed out by `watch`, a connected agent's comment pickup skips agent comments, and the starter
  agent uses the same rule. Comments made with the MCP `add_comment` tool, or with `comments add` inside an agent's run, are now
  marked `authorAgent` on local boards too.
- On a local board, comments and replies posted through the HTTP API with the `X-Shapewall-Agent: 1` header (given to every
  `watch --exec` command as `SHAPEWALL_AGENT_HEADER`) are marked as an agent's, and so are `watch`'s own "Needs a person" notes.
- An agent session that goes on in a thread now also gets, as quoted data, what people wrote there since its last answer.
- In a shared thread, a message that would wake the agent by its words while it is offline or already answering there is kept,
  with a note saying so, instead of refused; people can post while an answer runs (local boards too). A mention inside a code span
  or block, or on a quoted line, does not count. A hosted agent can no longer be named after a member's handle or "Agent".
- MCP `list_comments` returns at most 50 comments per call by default (`total` counts every match; `cursor` gets the next page).
- GitHub issue links to a comment list their keys in the shared order (`?board=&c=&filter=all`); they open the same view.
- The plugin launcher's PATH rule is now the same code as `agent setup`'s every-project rule: it also skips a PATH folder anywhere
  under a `node_modules` folder (not only `node_modules/.bin`), checks each folder as written and with symbolic links followed,
  and compares Windows paths without case.
- `shapewall mcp --help` says what the server offers, `watch --mention` says that only mentions people wrote count, and
  `open --help` puts its note on a board that is not running on its own line.

### Fixed

- `compare_captures` decodes each capture once, a row at a time, and counts the diff on the images as shown (`diff.scale`), not on
  the full-size captures: two 3840x4166 captures took 1.25 s, now about 0.33 s, and a fraction of the memory.
- `compare_captures` no longer labels the wrong image `current` when a capture or push lands while it reads: it asks to be called
  again (local boards re-check the version; hosted current capture URLs carry `?version=` and answer 409 once it moved).
- `shapewall settings` exits 0 when a second Ctrl-C (or a SIGTERM right after a SIGINT) lands just as its cleanup finishes;
  before, a signal in the last few milliseconds of shutdown ended it by signal.

### Security

- `compare_captures` refuses a capture over its pixel cap (16 megapixels) from the PNG header, before decoding it. A hosted server's
  own `/mcp` runs it in the worker threads that clean pushes, but takes little of them: one compare on the server at a time (and
  one per workspace and per token), its two captures one after the other so a push always has a worker, none while the pool's
  queue is more than half full, and its slot held until both captures are done. Another call is refused with a "busy, retry"
  error. It used to decode both captures at full size on the server's event loop, about 2 s and 550 MB per call, for any read
  token.
- `author: "me"` on a local board goes by a server-side owner stamp (`byOwner`) on the comments the owner makes, which the request
  cannot set: a paired device or LAN visitor signing with the owner's name no longer counts as "me". Older comments without the
  stamp still match by name, and the answer says so (`author.meMatch: "owner+name"`).
- Token API: `GET /api/v1/project` names the token maker (`token.createdBy`) only to tokens with the `read` scope. A claim token
  lists and fetches only the current captures and the versions its dispatched comments were made on; any other read token can read
  every kept version, as `docs/hosted.md` now says.
- Connected agents (`shapewall agent connect`, chat and fix sessions) no longer load or write Claude Code's auto memory. In 1.2.0
  and earlier these hardened sessions still loaded it, so notes Claude Code kept for the project could shape answers that leave the
  machine. It is now off twice over: `autoMemoryEnabled: false` in the session's flag settings and
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in its environment, checked with claude-agent-acp 0.93.0 and 0.106.0
  (docs/agent-hardening.md).
- `CLAUDE.md`, `AGENTS.md`, `CLAUDE.local.md` and `GEMINI.md` are now files that run something, and so is every file the project's
  instruction files import, whether it exists yet or not: a connected agent's fix cannot create or edit them unless the machine
  names the file with `--allow-path`, the edit is always asked on the board, and such a fix is never pushed.
- Instruction file imports never reach `CLAUDE.local.md`, a dotfile or a dot folder (`.env`, `.git`), and the board is told
  instruction file names only (sizes and hashes stay in the console).
- The plugin launcher and `agent setup` start a project's `node_modules/.bin/shapewall` only when it is a real npm install: it
  resolves to the bin file of `node_modules/shapewall`, that package is shapewall at the pinned version or newer, the file is yours
  (macOS and Linux), and git tracks neither. A repository that commits a `node_modules/.bin/shapewall` no longer gets it run when
  an agent session starts; the launcher goes on to PATH or `npx`. git is run without a shell, from an absolute PATH folder outside
  the project.
- The plugin launcher looks for `shapewall.config.json` above the folder the app works in only inside a repository (up to its
  `.git`), never at the file system root, and never in a folder that belongs to another user.
- On Windows, the plugin launcher and `agent setup` start `node` with npm's `npx-cli.js` or the package's own bin file instead of
  an npm `.cmd` shim through a shell, so a space, `&`, `^` or `%` in a path can no longer break the start or run something else.
  Where only `cmd.exe` can start the program, every part must be plain text, or it stops with an error.
- Every agent process Shapewall starts (ACP chat and fix sessions, the starter agent, `watch --exec`, `shapewall mcp` and so the
  plugin launcher and `agent setup` entries) has `SHAPEWALL_AGENT_RUN=1` and `SHAPEWALL_AGENT_HEADER`: `shapewall comments add` in
  it signs "agent", stores the comment as an agent's and never gives it the owner's stamp, so it cannot wake an agent or count as
  "me". A process Shapewall did not start carries no mark, and a header-less HTTP post from it still reads as a person's
  (docs/agent-hardening.md).
- On a hosted board, a member whose handle is an agent's (one who joined later, say) is mentioned as a person: `@handle` no longer
  wakes the agent.
- The release text gate reads the diff by its hunks (an added line starting with `++ ` was taken for a file header and skipped),
  catches the figure dash, horizontal bar and minus sign too, and matches names case-folded with spaces, dashes and underscores
  taken out, so joined and spaced variants of a listed name count.

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

- Avatar initials use only letters and digits: an agent named "Scout (workbench)" shows "SW", not "S(", and a word that is only
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
