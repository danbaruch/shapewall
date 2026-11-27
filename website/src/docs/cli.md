Every command takes `--config FILE` (default `./shapewall.config.json`, or `$SHAPEWALL_CONFIG`). `shapewall --help` prints the core commands, `shapewall --help all`
prints every command (the list at the end of this page),
`shapewall <command> --help` (or `shapewall help <command>`) prints one command's options, and `shapewall --version` prints the
version.

An option the command does not take is an error, with the closest real one as a hint: `shapewall capture --onyl home` stops with
`unknown option --onyl for "capture" (did you mean --only?)` instead of capturing every page.

Messages that suggest a command (`doctor`, `init`, a missing browser) write it the way you started Shapewall:
`npx shapewall doctor` for a copy installed in a project, or the path of a clone's executable. See
[install](/docs/getting-started#install). The complete help text is [at the end of this page](#every-command-and-option).

## shapewall init

```text
shapewall init [--base-url URL] [--sitemap [URL|FILE] [--limit N] [--group NAME] [--exclude /PREFIX ...]] [--no-discover]
               [--force] [--ci] [--no-agent-docs]
```

Writes a starter `shapewall.config.json` in the current folder and adds `.shapewall/`, `shapewall-export/` and `*.auth.json` to
`.gitignore`.
`--base-url` sets the app to capture (default `http://localhost:3000`) and finds its pages: `<base URL>/sitemap.xml`, else the links
from the home page (two levels, up to 25 pages, same site); without `--base-url` the config gets three example pages. When the app
does not answer, init writes the home page only, prints a warning and exits 0: start the app and run it again with `--force`. When
something answers but not with a page (a 404, a redirect away), the address looks wrong: init writes the home page only and exits 2.
`--force` overwrites an existing config. `--sitemap` takes the pages from
a sitemap instead and records it in the config (it accepts the `shapewall sitemap` options too). `--no-discover` (with `--base-url`)
skips the lookup and writes the home page only. `--ci` also writes `.github/workflows/shapewall.yml` beside
the config, so pull requests are captured ([pull requests](/docs/pull-requests)); an existing config is kept, and `--force` with
`--ci` replaces only the workflow. init also adds a short Shapewall section to `AGENTS.md` (and a `CLAUDE.md` that imports it), so a
coding agent opened in the project finds the board; `--no-agent-docs` leaves it out (see `shapewall agent docs` below).

## shapewall sitemap

```text
shapewall sitemap [URL|FILE] [--limit N] [--group NAME] [--exclude /PREFIX ...] [--board ID] [--dry-run] [--json]
```

Adds the pages of a `sitemap.xml` to the config. Sitemap indexes are followed into their child sitemaps and `.xml.gz` works. It keeps one
site's URLs (your `baseUrl` host if the sitemap uses it), skips paths already on the board and repeats, groups pages by their first path
segment and titles them from the last one. With more than `--limit` pages (default 100) the shallowest are kept. `--group` puts them all
in one group, `--exclude /tag/,/author/` leaves paths out, `--dry-run` only shows what it would add. With no source it reads the board's
`sitemap` setting. Nothing is captured: run `shapewall capture` next. Details: [Config](/docs/config#sitemap-import).

## shapewall auth record

```text
shapewall auth record [--board ID] [--env ID] [--url URL] [--timeout DURATION] [--overwrite]
```

Opens a fresh isolated browser for you to sign in manually. Return to the terminal and press Enter to save; `cancel`, Ctrl-C,
browser close or timeout discards. The timeout is 10 minutes unless `--timeout` says otherwise (`90s`, `10m`; a number alone is
seconds), at most 30 minutes. `--overwrite` explicitly replaces an existing state. `doctor --install-browser` downloads only the
headless Chromium that captures use, so the first sign-in window downloads the full Chromium once.
It saves private `.shapewall-auth/*.auth.json` files outside capture/export output and prints the config snippet to apply.
The config is not changed automatically. A desktop display and terminal are required; no personal browser profile is borrowed.
See [signed-in captures](/docs/config#auth). Never share the saved state, which contains account credentials.

## shapewall capture

```text
shapewall capture [--board ID] [--only ID|PATH ...] [--env ID] [--check-external] [--json]
```

Captures every page at every viewport: a PNG, a thumbnail and a live HTML snapshot each. `--board` picks a board in a multi-board
config (default: the first). `--only` limits the run to some pages, by id or path; repeat it or comma-separate. `--env` captures one
of the board's [environments](/docs/compare#staging-beside-production) (default: the first). A recapture keeps the shot it replaces as
a version, for before and after.

A full run is written to a staging folder and swapped in at the end, so a failed run keeps the previous captures. Runs on one board
never overlap. Successful shots can include bounded aggregate network warnings; inspect the **Network** badge or JSON
`networkSummary`. [Capture pacing](/docs/capture-warnings) reduces bursts without retrying actions or starting background work.

A page that answers 4xx or 5xx is a failed shot, unless the page says it is an error page on purpose with
[`expectStatus`](/docs/config#page) (`"expectStatus": 404`): then it is captured like any other page, and a different status (a 200
where a 404 was expected) is the failure.

After the shots, the links on the pages are checked: a link to the same site that answers 4xx/5xx or not at all is a **broken link**.
A link to a page on the board takes that page's capture result; any other is requested once (at most 300). `--check-external` checks
links to other sites too (at most 100). The summary lists them, [`shapewall links --broken`](#shapewall-links) prints them later, and
the board shows a count on its **Links** button. Broken links do not change the exit code.

For CI, `--json` prints one JSON summary on stdout and sends the progress lines to stderr: `ok`, `totals` (`shots` planned, `ok`,
`failed`, and `expected`: the ok shots of `expectStatus` pages), `failedShots`, `redirectedShots`, `shots`, `brokenLinks`, ... Capture
never prompts.

| Exit code | Meaning                                                               |
| --------- | --------------------------------------------------------------------- |
| `0`       | Every shot succeeded (an `expectStatus` page with its status counts). |
| `2`       | Some shots failed; the rest were saved.                               |
| `1`       | An error: bad config, no browser, ...                                 |

## shapewall checks

**Experimental**, `checks lighthouse` included: these commands, their reports and the `checks` config can change in a minor
release ([stability](/docs/stability)).

```sh
shapewall checks run --board site --only home --seo --limit 2
shapewall checks list --board site --json
shapewall checks lighthouse --board site --only home --viewports phone --samples 1
shapewall checks accessibility --board site --only home --viewport phone
shapewall checks flow --board site --flow-file checkout.audit.json
```

These commands measure original pages locally and save bounded private reports. Lighthouse provides navigation lab metrics; axe audits one page state; explicit flow files run a sequence once. Reports never launch an agent. Configured actions can change the original app, so use safe fixtures. Read [Page checks](/docs/page-checks) for limits, performance budgets, comparison conditions and explicit sharing options.

Lighthouse is not installed with Shapewall: `checks lighthouse` says how when it is missing (`npm install lighthouse@13.6.0` beside Shapewall,
with `-g` for a global install). `--build-mode production|development|unknown` records how the app was built. Both commands exit `0`
when every page view passed, `2` when some failed (or, for `checks lighthouse`, were partial; the reports are still saved) and `1` on an error;
`checks` stopped with Ctrl+C exits `130`, and `143` when stopped by SIGTERM (the board's Stop).

## shapewall links

```text
shapewall links [--broken] [--board ID] [--env ID] [--json]
```

Prints the links between the board's pages from the last capture (`home -> pricing, about`). `--broken` prints the links that led to
an error instead, with the status and the pages they are on, and exits with `2` when there are any:

```text
3 broken links on "site" (capture of 2026-11-05T18:40:12.000Z):
  404  /missing  (from about, home)
  500  /oops  (from home)
  fail https://elsewhere.example/x  (from home): getaddrinfo ENOTFOUND
```

## shapewall open

```text
shapewall open [--board ID] [--page ID|TITLE] [--comment N] [--viewport NAME] [--compare [A_B]] [--follow [AGENT]] [--print] [--json]
               [--remote URL]
```

Prints a deep link to the board and opens it in your browser: the board flown to a page (`--page`), opened on a comment at its
screen size (`--comment`, which wins over `--page`), at one screen size (`--viewport`), with the page's before and after
(`--compare` alone, which opens its history: the latest capture beside the one before it), or two environments side by side
(`--compare staging_prod`). `--follow` opens it following an agent: the board flies to each comment the agent takes and shows the
before and after of that comment's screen when the agent recaptures it (`--follow` alone: any agent; on a hosted board `--follow ID`
follows one agent; see [Follow an agent](/docs/agent-workflow#follow-an-agent)). `--print` only prints the link; `--json` prints
`{ url, board, page, comment, viewport, compare, follow, running }` and opens nothing, for agents. A local board uses the running `shapewall serve` (or `SHAPEWALL_BOARD_URL`); when nothing is
serving it, the link is printed with a reminder to run `shapewall serve`. With `--remote URL` it links to the hosted project the
token belongs to. Links carry ids only, never a token. The link format is described in
[the agent workflow](/docs/agent-workflow#links-to-the-board).

```text
$ shapewall open --comment 12 --print
http://127.0.0.1:4600/?board=site&c=12&filter=all&vp=phone
```

## shapewall serve

```text
shapewall serve [--port 4600] [--host 127.0.0.1] [--open] [--read-only] [--no-capture] [--allowed-host NAME] [--chat | --no-chat]
                [--agent-acp "CMD"] [--allow-remote-agent] [--tailscale[=print]] [--lan[=IP|INTERFACE]] [--no-identity]
                [--no-remote-chat] [--approve-on-host] [--tls-cert FILE] [--tls-key FILE] [--accounts] [--accounts-origin URL]
                [--buzz-bridge FILE]
```

Serves the board and its API. Listens on 127.0.0.1 by default and refuses requests whose `Host` header is not local. While it runs,
links that other commands make (notifications from `comments resolve`, `watch` and `mcp`, GitHub issues) point at its real port,
unless the config sets [`boardUrl`](/docs/config#top-level).

On a board served to this machine, it says which agent CLIs it found on `PATH` (Connect them in the Agent panel:
[chat](/docs/chat#connect-in-one-click)). Comments you make on a local board are signed with your name: `SHAPEWALL_USER_NAME` when set, else
`git config user.name` as seen from the project (the profile avatar shows its initials). To sign with another name, set
`SHAPEWALL_USER_NAME` before `shapewall serve`, or type a name on a comment (the board remembers it in this browser). Without either,
the board asks on the first comment. A board shared beyond this machine never sends it.

| Flag                   | Effect                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `--port`               | Port to listen on. Default 4600.                                                                         |
| `--open`               | Open the board; direct local mode uses its owner link, fixed-origin account mode uses the account URL.   |
| `--host`               | Address to bind. Read [self-hosting](/docs/self-hosting) before changing it.                             |
| `--read-only`          | No comments or captures from the board.                                                                  |
| `--no-capture`         | Comments allowed; captures only from the CLI.                                                            |
| `--allowed-host`       | An extra Host header to accept, for a reverse proxy. Repeatable. `*` = any.                              |
| `--chat`               | The board chat on even when shared beyond this machine ([chat](/docs/chat)).                             |
| `--no-chat`            | The board chat off.                                                                                      |
| `--agent-acp`          | Chat with an agent CLI over ACP ([chat](/docs/chat)). Also `SHAPEWALL_AGENT_ACP`; never from the config. |
| `--allow-remote-agent` | With `--chat` on a shared board, allow an ACP agent anyway (anyone who reaches the board acts as you).   |

That table is the everyday subset, not the whole list. The flags for reaching the board from another device
(`--tailscale`, `--lan`, `--tls-cert`, `--tls-key`, `--no-identity`, `--no-remote-chat`, `--approve-on-host`) are in
[self-hosting](/docs/self-hosting), `--accounts` and `--accounts-origin` in [local accounts](/docs/local-accounts), and the
experimental `--buzz-bridge` in [the Buzz bridge](/docs/buzz). `shapewall serve --help` prints every one of them.

`serve --open` also opens the board's agent settings: it opens the board with its private owner link. With a fixed account origin
(`serve --tailscale --accounts`) the browser opens the account board instead, and the terminal prints the one command that opens the
host-only agent settings on this computer ([local accounts](/docs/local-accounts#tailscale-account-origin)). That command,
`shapewall settings`, still works but is no longer listed in the help.

## shapewall buzz-bridge

**Experimental.** Outside the [stability promise](/docs/stability): it can change, or go, in a minor release.

```sh
shapewall buzz-bridge --bridge-config /absolute/private-folder/bridge.json
shapewall serve --config /absolute/path/to/source-folder/shapewall.config.json --buzz-bridge /absolute/private-folder/bridge.json
```

Optional, and only for people who run Buzz, a self-hosted chat where coding agents sit in channels: the gateway lets the board's owner
message those agents. It runs in the foreground on a private Unix socket, and Ctrl-C stops it without touching Buzz. Keep its
configuration and receipts outside source, capture and export folders. See [the Buzz bridge](/docs/buzz).

## shapewall devices

```text
shapewall devices list [--json]
shapewall devices approve CODE
shapewall devices deny CODE
shapewall devices revoke ID|--all
```

Manage the single owner's paired devices and pending requests. Match the code on the device before approval. These commands are
for local `serve --tailscale` or `serve --lan`, separate from hosted workspace accounts and roles. See [other devices](/docs/self-hosting#your-own-other-devices-local-mode).

## shapewall agent

```text
shapewall agent setup [--claude] [--codex] [--scope local|user|project] [--remote URL] [--force] [--dry-run] [--yes]
                      [--remove] [--json]
shapewall agent docs [--write | --remove | --print]
shapewall agent connect --remote URL [--agent claude|ID] [--name NAME] [--as NAME]
                        [--audience owner|server] [--approvals none|owner|admins] [--auto none|edits|commands|edits,commands]
                        [--allow-path FILE] [--base BRANCH] [--git-remote NAME]
                        [--instructions all|project|none] [--agent-config DIR|none] [--respond thread|mention]
                        [--browser-profile NAME|none] [--browser-no-sandbox]
                        [--takeover] [--concurrency N] [--token-file FILE]
                        [--project SLUG [--workspace NAME] [--used-by owner|trusted] [--icon NAME] [--tint NAME]]
shapewall agent status [--remote URL] [--as NAME] [--json]
shapewall agent set KEY VALUE [--remote URL] [--as NAME]
shapewall agent sandbox build-image [--runtime podman|docker] [--image NAME]
shapewall agent sandbox doctor [--no-egress]
shapewall agent sandbox run --comment ID
shapewall agent sandbox watch [--once]
```

`agent setup` registers the `shapewall` MCP server with Claude Code and Codex (each one found on PATH, or the one named with
`--claude` or `--codex`), so an agent opened in the project has the board's tools. It shows what it would change and asks first
(`--yes` skips the question, `--dry-run` only shows); it backs up each file before changing it
(`<file>.shapewall-backup-<time>`; the newest 3 for `~/.claude.json`; a project's `.mcp.json` is backed up outside the project, in
`~/.local/state/shapewall/backups`) and touches only the `shapewall` entry. A symbolic link to the file stays a link. Running it
again changes nothing. An entry from an older Shapewall is updated; a `shapewall` entry that is different is shown and replaced only
with `--force`. Claude Code's `--scope`: `local` (default) is this project, only you, in `~/.claude.json`; `user` is every project
of yours; `project` writes `.mcp.json` for everyone, and Claude Code asks each person to approve it the first time. Codex has no
scope: the entry goes in `~/.codex/config.toml` (`$CODEX_HOME`) for every Codex project, with `tool_timeout_sec = 600`. The command
it registers is the project's own `node_modules/.bin/shapewall` (local scope, only a real npm install that git does not track), else `shapewall` on PATH when it is this version or
newer, else `npx -y shapewall@<this version>`. `--remote URL` registers `shapewall mcp --remote URL` for a hosted board, after
`shapewall login`; no token is written. `--remove` takes the entries out again.

`agent docs` says where the Shapewall section for coding agents is. The section sits between `<!-- shapewall:start v1 -->` and
`<!-- shapewall:end -->` in `AGENTS.md` (or `CLAUDE.md` when only that exists); Shapewall never changes text outside the markers,
never writes through a symbolic link, and leaves a section from a newer Shapewall as it is. `--write` puts it in or refreshes it,
`--remove` takes it out (and deletes an `AGENTS.md` or `CLAUDE.md` Shapewall made that has nothing else in it) and sets
`"agentDocs": false` in the config, so it stays out in every clone; `--print` prints it. `init` writes it (`--no-agent-docs` writes
`"agentDocs": false` instead). The first `serve` or `capture` only creates the files, in a project that has neither `AGENTS.md` nor
`CLAUDE.md` and no `"agentDocs"` in its config; an `AGENTS.md` or `CLAUDE.md` that is already there is never edited unasked, and
serve prints one line naming `agent docs --write` instead.

`agent connect` makes Claude Code on this machine an agent of a project on a
[team server](/docs/hosted#connected-agents). Run it in the project's folder. The first run prints a code that an admin approves in
the server's console, where they name the agent and choose who may use it; its token is saved privately and never printed. Members
then chat with it from the board's Agents panel. By default it reads the project and answers: it does not change files or run
commands from the board. Ctrl+C disconnects it. On a server with tailnet sign-in, `--project` (and `--workspace`) connects from a
tailnet machine with no browser; your tailnet user approves it.

Only Claude Code is offered in this release, because its own controls were shown to keep a session read-only. Codex, goose and
Gemini CLI are refused with a message; use `shapewall watch --remote` for them. The session starts without your Claude Code
settings files and with only its reading tools. One process holds an agent's link: a second `agent connect` for the same agent is
refused and names the machine already connected, and `--takeover` closes that link first. `--audience owner` asks the server to
keep the agent to the person who connected it, and the machine refuses a job the server labels as someone else's; the machine
cannot check that label, so this does not protect against a compromised server.

Edits from the board are switched on only here, on the machine that has the code. `--approvals owner` lets the person who
connected the agent allow each edit on the board. `--approvals admins` takes the answer from whoever the server lets answer: the
agent's answer role (admin by default), in its audience and trusted by the project. `--approvals none` switches it off again. The
choice is saved for this connection in the machine's own policy file (`agent-policy.json` beside the saved token, readable by you
only, outside every repository). It is the ceiling: the server can only narrow it. With edits on, **Fix with** on a hosted comment
starts a fix on this machine. The agent works in a fresh copy of the base commit in a folder outside the project, never in this
checkout. Each edit is checked here, then shown on the board as a card with the full diff, and Shapewall commits only what was
allowed on a new branch, `shapewall/comment-<n>-<slug>`. Chat messages never edit.

The flags that go with it, each saved for the connection:

- `--auto none|edits|commands|edits,commands`: what the server's "Allow without asking" rule may apply to. The default is `none`:
  every request waits for a person. `commands` is refused unless at least one `--allow-command` is already saved, so today, with no
  agent that may run commands, only `none` and `edits` can be set.
- `--allow-path FILE`: a file that runs something, which the agent may ask to edit. Dotfiles, `package.json` and lockfiles,
  build and tool configuration, package scripts, container and CI files, makefiles and test files are refused otherwise. A
  named one is always answered by a person, and a fix that changes one is never pushed from the machine.
- `--base BRANCH`: where a fix starts. The default is the commit the checkout is on, and then a checkout with uncommitted changes
  to tracked files refuses the fix, because the fix would silently leave them out.
- `--git-remote NAME|none`: where a finished fix is pushed (default `origin`). A fix that touches dependency manifests or CI
  config is not pushed. A pull request is opened when [GitHub connect](/docs/github) is set up on this machine.
- `--instructions all|project|none`: the instruction files each session gets as an appended system prompt. `project` is the
  project's `CLAUDE.md` and `.claude/CLAUDE.md` (its `AGENTS.md` when neither exists); `all` (the default) adds the `CLAUDE.md` in
  the connection's agent config folder. Never `~/.claude` or `CLAUDE.local.md`. The board shows the file names, never their text,
  and they add no powers.
- `--agent-config DIR|none`: that folder (default `agent-config/<--as name>` beside `agent-policy.json`, read only when it exists;
  Shapewall never creates it). It must be outside the project.
- `--respond thread|mention`: in a shared thread the agent answers an @mention of it and **Send to agent**. `thread` (the
  default) also answers every message of a thread the person who connected it set to answer everything; `mention` never does,
  whatever the server says. See [when an agent answers](/docs/chat#when-an-agent-answers).
- `--browser-profile NAME|none`: a saved profile of the agent browser's own, for test or staging logins, made in
  `$XDG_STATE_HOME/shapewall/agent-browser-profiles/NAME`. Never a real browser's profile.
- `--browser-no-sandbox`: let the agent browser start without Chromium's own sandbox where it cannot start, on solo and team
  turns only.

Connected Claude Code sessions never load or write Claude Code's auto memory.

`--allow-command` is in the help text and is not available for Claude Code in this release. Started with its shell tool, Claude
Code runs commands it takes to be read-only (`ls`, `cat`) without asking anyone, and those can read outside the project. So a fix
session of Claude Code gets no shell tool, and the flag (and `agent set allow-command`) is refused with that explanation; only
`none`, which empties a saved list, is taken. A fix runs the project's named commands
(config `commands`) through Shapewall's own tools instead, in an OS sandbox where the machine has one
([commands through Shapewall](/docs/agent-hardening#commands-through-shapewall)). The whole of it, with the trust table: [the hosted guide](/docs/hosted#edits-from-the-board-the-trust-decision).

`agent status` lists what the agent can do on this machine, line by line and per tier (solo, team, open): the same lines as the
console's **What it can do** card and the block the agent reads. Each line that is off says why and the command that changes it.
`--remote URL` (with `--as NAME`) shows a connected agent's lines, for chat and for Fix with, and whether its link is open;
without it, the local board in this project. `--json` prints the console card's data.

`agent set KEY VALUE` changes one line without reconnecting: `agent set browser off`, `agent set shell sandboxed --remote URL`,
`agent set trust-team ada,bo --remote URL`. With `--remote` it is read at the next `agent connect`; without it, by the local
board's next turn. The keys and their values: [what an agent can do](/docs/agent-capabilities#change-a-line).

The sandboxed starter agent (`agent sandbox`) is **experimental** ([stability](/docs/stability)) and separate from native ACP board
chat. Its [guide](/docs/starter-agent) explains the container, model and trusted-author prerequisites, budgets and approval limits.
`shapewall agent --help` lists current run/watch policy flags.

## shapewall comments

```text
shapewall comments [--open|--resolved|--all] [--page ID] [--mention NAME] [--since ID|TIME] [--json] [--for-agent]
shapewall comments get|show ID [--json] [--for-agent]
shapewall comments add --page ID --body TEXT [--viewport NAME] [--selector CSS] [--author NAME] [--json]
shapewall comments selectors --page ID [--viewport NAME] [--text WORDS] [--json]
shapewall comments resolve ID [--note TEXT] [--ref URL|COMMIT] [--author NAME] [--json]
shapewall comments reopen ID [--author NAME] [--json]
shapewall comments reply ID --body TEXT [--author NAME] [--json]
shapewall comments status ID queued|working|done|needs-human|clear [--note TEXT] [--author NAME] [--json]
shapewall comments delete ID [--yes] [--json]
```

Prints comments as a work list. Plain text is for pasting into a chat; `--json` is for agents, with the page, viewport, selector,
element text, position, file paths, replies, mentions and agent status of each comment. `--page ID` keeps one page and its variants;
`--mention NAME` keeps comments that mention `@NAME` in the text or a reply. `--for-agent` quotes each comment as untrusted data
(`<shapewall-data>`), for an agent to read.

`resolve --ref` records what fixed it (a pull request URL or a commit), shown on the board as "Fixed in". Reopening clears the agent
status (a fix still waiting on its branch keeps it). `reply` adds to the comment's thread; `status` sets the agent status, and `--note` adds a reply
with it. `--since` keeps comments after that comment id, or created or changed after that ISO time; `get` (also spelled `show`) prints
one comment.

`add` makes a comment like the board does (checks, events, mentions, notifications): `--viewport` defaults to the page's first,
`--author` to the person at this machine (`SHAPEWALL_USER_NAME`, git's `user.name`, else the system user; `agent` when an agent
runs the command), and `--selector` pins it to an element (the selector grammar comments show); without one the pin sits near the
top-left corner. `comments selectors` prints the selectors `--selector` takes for a page, with each element's text, from the latest
capture, sturdiest first (`#id`, `data-testid`, `aria-label`, then short paths; `--text WORDS` keeps the elements whose text has
them, the one holding the words first). A selector that finds no element in the latest capture is still
saved: the command says so, the pin sits at that corner until the board finds the element, and the thread says it is pinned to "a
selector the capture did not have" rather than naming an element. `--author` on `resolve`, `reopen` and `status` names who did it
in the events (the same default as `add`). Every `--json` write prints `{ trust, note, board, comment }`. See
[the agent workflow](/docs/agent-workflow).

`delete` takes a comment back, like **Delete thread** on the board: the comment, its replies and its images go for good. It asks
first; `--yes` skips the question, and without a terminal to ask in (a script, an agent) it is required.

## shapewall events

```text
shapewall events [--follow] [--since EVENT_ID|TIME] [--board ID] [--limit N] [--json]
```

Prints comment events from the shared event log (`.shapewall/events.jsonl`): every change from every process, with who made it. It
never claims a comment or sets a status, so a chat bot can run it beside `watch` and the starter agent. Without `--follow`, the last 20
(`--limit`) and exit; `--follow` keeps going until Ctrl+C; `--since` starts after that event id (from `--json`) or time. The format is in
[notifications](/docs/notifications).

## shapewall journeys

```text
shapewall journeys [--board ID] [--json]
```

Prints the board's journeys, from the config and made on the board, one step per line, with each fork's branches indented under it.
`--json` gives `{ board, journeys }`: each journey's `steps` as written (forks included), `pages` (every page on any branch) and `paths`
(every way through the forks, with the branches taken). See [journeys](/docs/journeys).

## shapewall watch

```text
shapewall watch [--exec "CMD ARGS"] [--concurrency N] [--new-only] [--once] [--timeout DURATION] [--mention NAME] [--no-claim]
                [--recapture]
```

Hands each new open comment to a coding agent, until you press Ctrl+C. With `--exec`, runs the command once per comment with the
comment JSON on stdin (no shell is involved); without it, prints one JSON line per comment and marks it `queued`, so it is never
handed out twice. Whatever reads those lines moves each one on (`shapewall comments status ID working`, then `done` or
`needs-human`), or `status ID clear` hands it out again; `--no-claim` marks nothing. `--mention agent` hands out only comments
that tag `@agent`, so people can discuss a comment first and tag the agent when it is ready. Only mentions people wrote count, and a
comment an agent wrote is never handed out, so agents cannot set each other off. A command that exits `0` must leave a
word: a reply (`shapewall comments reply`) makes the comment `done`, a status it sets itself is kept, and a silent exit `0` makes it
`needs-human` with a note, since nothing says what the agent did. `--no-claim` hands out every open
comment once without claiming it (no agent status, no lock), to run beside another watcher. `--recapture` recaptures the comment's
page after a successful `--exec` (local boards only). `--timeout` stops a command that runs longer (default `60m`; `90s`, `30m`, `2h`;
a number alone is minutes). Details in [the agent workflow](/docs/agent-workflow#shapewall-watch-the-loop-closes-by-itself).

## shapewall github

```text
shapewall github issue ID | github link ID PR | github sync   [--json]
```

```text
  github issue ID           open a GitHub issue from a comment (or show the one it has)
  github link ID PR         link a pull request (12, #12 or its URL) to a comment
  github sync               link pull requests that name a comment; resolve comments whose PR merged
                            (repo: "github.repo" in the config; token: $SHAPEWALL_GITHUB_TOKEN or $GITHUB_TOKEN,
                            else a signed-in GitHub CLI ("gh auth token"))
```

`issue` makes one issue per comment; asking again shows the one it has. `link` takes the pull request as `12`, `#12` or its URL. `sync`
reads the repo's pull requests, links the ones that say `shapewall:<id>` or `Fixes shapewall#<id>` (or close the comment's issue), and
resolves a comment once when its pull request merges. `--board ID` picks a board for `issue` and `link`; `--json` prints the result as
JSON. The token is read from the environment only, or, when neither variable is set and the API is github.com, from
`gh auth token` (never printed or stored). Setup, the webhook and safety notes: [GitHub connect](/docs/github).

## shapewall mcp

```text
shapewall mcp [--read-only] [--no-capture]
```

A Model Context Protocol server on stdio, for agents that prefer tools over shell commands. `shapewall agent setup` registers it
with Claude Code and Codex, or install the [Claude Code and Codex plugin](/docs/plugins). `list_comments` filters by author
(`"me"`), date (`since`, `until`, `"today"`), text and page name, and pages through results 50 at a time; `board_link` gives a link
to a page, a comment or a before and after; `compare_captures` shows a page's current capture beside the one before it, with a
pixel diff. `--read-only` offers only the reading
tools; `--no-capture` drops `recapture_pages`. With `--remote URL` (and `--board ID` to pick the default board) it works on a
hosted board. Started in a project folder (or with `--config FILE`) and with a token that has the `push` scope, `mcp --remote`
also offers `recapture_pages`: it captures the pages on your machine, then pushes only those pages to the hosted board.
`get_page_capture` hands the agent a page's current capture as an image (scaled down to at most 1600 px wide; `crop` for a detail),
locally and on a hosted board, and `--read-only` keeps it. On a hosted board `add_comment` needs a token with the `reply` scope. See
[the agent workflow](/docs/agent-workflow#mcp-server-shapewall-mcp).

## shapewall variant

```text
shapewall variant add PAGE (--url URL | --path /p) --title TEXT [--note TEXT] [--source TEXT] [--id ID] [--viewport desktop,phone]
shapewall variant remove ID
shapewall variant list
```

Captures another version of a page (a branch preview, a redesign) and puts it beside the page on the board. `--path` is resolved on
the board's `baseUrl`; `--url` can point anywhere. The variant's id is `--id`, or the title as a slug plus four random characters
(`calmer-hero-3f9a`); `variant add` prints it, and `variant remove` takes it.

## shapewall export

```text
shapewall export [--out shapewall-export] [--no-comments] [--browser-comments] [--no-index] [--include-checks]
```

Writes a static, read-only copy of the boards that any static host can serve, with compare data for every pair of captured
environments. Serve the folder to look at it (`npx serve shapewall-export`, or any static web server): opened from disk (`file://`)
the browser refuses its scripts, and the page says so. The comments are included by default, with their authors and replies, and the
summary says how many; `--no-comments` leaves them out. `--browser-comments` lets visitors add, resolve and reply to comments that
stay in their own browser (IndexedDB). `--no-index` adds a robots `noindex` tag if the client does not have one. An export leaves the
private diagnostic reports out unless `--include-checks` explicitly asks for them, and the chat's read-aloud voice files out unless
`--browser-comments` is given.

## shapewall notify

```text
shapewall notify list [--json]
shapewall notify test CHANNEL [--to EMAIL]
```

`notify list` shows each notification channel, the events it sends, and what it still needs (environment variable names, never their
values). `notify test` sends a message marked as a test to one channel through the same path as real ones, retries included, and exits
1 if it fails. Email channels send the test to their `to` list, or `--to`. While `shapewall serve` runs, it sends the notifications for
changes from every process with its own environment; without it, each command sends its own.

## shapewall doctor

```text
shapewall doctor [--install-browser] [--port 4600] [--no-launch] [--agent-acp "CMD"] [--json]
```

Checks Node, Shapewall's own dependencies, the config (and warns about keys it does not know, with the one most likely meant), the
browser (by starting it), the output folder, the port (the one `serve` last used for this project, and only suggests a free one),
whether the app in `baseUrl` answers, the board client, the notification channels, the chat agent and GitHub connect, and says what
to fix. It ends "Ready." or "Ready, with N warnings above."; a FAIL line says what to run next. With `--agent-acp` (or `SHAPEWALL_AGENT_ACP`) it prints the agent command, starts the agent, does the ACP handshake
(no prompt) and stops it. `--no-launch` finds the browser and the ACP agent without starting either. `--install-browser` downloads
the headless Chromium build Shapewall's Playwright needs first (the full Chromium for a sign-in window comes with the first
`auth record`), with progress bars only on a terminal; it needs no config (a missing one is a skip, not a FAIL, so it works in the
Shapewall clone before the demo). Exits 1 when a check fails, so it works as a first CI step. A GitHub token that GitHub rejects (401) is a FAIL.

## shapewall login and share

```text
shapewall login --remote URL [--project SLUG] [--workspace NAME]
shapewall share --remote URL [--board ID] [--dry-run] [--no-comments] [--include-checks]
```

`login` opens the hosted console to get a project token and saves it privately for remote commands (on a server with tailnet
sign-in, `--project` signs in from a tailnet machine without a browser; experimental, like all of tailnet sign-in). `share` moves local captures,
history, journeys and comments into a shared project. `--dry-run` reports counts without sending; `--no-comments` omits comments.
Private diagnostic reports are excluded unless `--include-checks` is explicitly selected. See [the operator guide](/docs/hosted).

## shapewall push, --remote and hosted

```text
shapewall push --remote URL [--board ID] [--page ID[,ID]] [--include-checks]
shapewall comments|watch|mcp --remote URL [--board ID] [--token-file FILE]
shapewall hosted [--data DIR] [--origin URL] [--port 4700] [--signup invite|open] [--trust-proxy]
```

```text
  push                      upload the latest captures to a hosted project
      --include-checks      explicitly include private diagnostic reports
      --remote URL          the hosted Shapewall (or $SHAPEWALL_REMOTE)
      --board ID            only this board (default: every board)
      --page ID[,ID]        only these pages' captures, to a board already pushed; other pages
                            there stay as they are, and a newer capture there is never replaced
  comments | watch | mcp --remote URL
                            the same commands against a hosted board (--board ID picks one)
                            token: $SHAPEWALL_TOKEN or --token-file FILE (a project token, swp_...)
                            watch --exec commands get no token unless --pass-token
                            watch and mcp show on the board as an agent, by the token's name
                            mcp --remote in a project folder, with the "push" scope, also has
                            recapture_pages: it captures here, then pushes those pages;
                            add_comment needs the "reply" scope
      --include-guests      comments and watch: also share link guests' comments (untrusted)
  hosted                    run the hosted server (accounts, workspaces, pushed boards)
      --data DIR            default ./shapewall-hosted-data (or $SHAPEWALL_HOSTED_DATA)
      --origin URL          public origin, e.g. https://app.example.com (default http://HOST:PORT)
      --port N | --host ADDR   default 4700 on 127.0.0.1
      --signup invite|open  default invite (the first account uses the setup link)
      --trust-proxy         behind a reverse proxy on this host (client IPs from X-Forwarded-For)
```

These are the hosted v0: a server you run yourself with `shapewall hosted` (passkey accounts, workspaces, pushed boards, project
tokens), and the clients that talk to it. Its console covers user management: invites (copy the link, or email it when
`RESEND_API_KEY` and `SHAPEWALL_EMAIL_FROM` are set), members and roles (owner, admin, member, viewer), an access overview of who
reaches which project, API tokens, an audit log, signed-in devices, and share links that give one project's boards to people without
an account (view-only or with guest comments, off until an admin turns them on). `shapewall agent connect --remote URL` connects
Claude Code for chat on a hosted board, and for fixes on a branch when its machine says so ([shapewall agent](#shapewall-agent)). There is no hosted Shapewall service to sign up for
yet. The local commands work the same without any of this.

The [hosted operator guide](/docs/hosted) covers `hosted setup-link`, `move-origin`, Tailscale/Funnel and own-domain setup,
`admin`, quotas, retention, `backup` and `restore`, and has a checklist to walk through before you invite a team.
`push --include-checks` explicitly adds private reports; ordinary uploads leave them out.

## shapewall ci, join and admin

Three commands have their prose elsewhere. `shapewall ci` captures a pull request and comments on it; the workflow
`shapewall init --ci` writes is what calls it, and its subcommands, flags and config are in [pull requests](/docs/pull-requests).
`shapewall join --remote URL` joins a workspace on a hosted server with tailnet sign-in, from a tailnet machine, with the invite an
admin made for your tailnet login (`--invite LINK` takes a link or its code instead). `shapewall admin` runs a few admin commands
(`projects`, `members`, `agents`, `invites`) against such a server as your tailnet user, which the server checks against your role.
Both of those are in [the hosted operator guide](/docs/hosted), and `shapewall <command> --help` lists their options. `join`,
`admin` and the rest of tailnet sign-in are **experimental** ([stability](/docs/stability)).

## Environment variables

| Variable                                                       | Effect                                                                                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `SHAPEWALL_ACCOUNTS`, `SHAPEWALL_ACCOUNTS_ORIGIN`              | Optional local passkey account gate and fixed origin; [guide](/docs/local-accounts).                                        |
| `SHAPEWALL_UPDATE_HELPER`, `SHAPEWALL_UPDATE_RESTART`          | Operator-managed manual update helper and explicit restart support; [guide](/docs/updates).                                 |
| `SHAPEWALL_CONFIG`                                             | Config file to use when `--config` is not given.                                                                            |
| `SHAPEWALL_ALLOWED_HOSTS`                                      | Extra Host names for `serve`, comma-separated.                                                                              |
| `SHAPEWALL_BROWSER_CHANNEL`                                    | Browser channel, e.g. `chrome`. Overrides the config.                                                                       |
| `SHAPEWALL_BROWSER_PATH`                                       | Path to a Chromium-based browser. Overrides the config.                                                                     |
| `SHAPEWALL_BOARD_URL`                                          | Where people open the board, for links in notifications and GitHub issues (wins over `boardUrl`).                           |
| `SHAPEWALL_ERROR_DSN`, `SHAPEWALL_ERROR_ENVIRONMENT`           | Opt-in error reports to your own error tracker; [monitoring](/docs/monitoring).                                             |
| `SHAPEWALL_USER_NAME`                                          | The name your comments on a local board are signed with, instead of `git config user.name`.                                 |
| `SHAPEWALL_AGENT_ACP`                                          | The agent CLI to chat with over ACP, as `--agent-acp`. Never read from the config.                                          |
| `SHAPEWALL_AGENT_ACP_ENV`                                      | Extra variables (comma-separated names) passed to the ACP agent, such as its login token; [chat with an agent](/docs/chat). |
| `SHAPEWALL_AGENT_BASE_URL`, `SHAPEWALL_AGENT_MODEL`            | The board chat's endpoint and model. Each wins over the config's `agent`.                                                   |
| `SHAPEWALL_AGENT_API_KEY`, `SHAPEWALL_AGENT_KEY_HOSTS`         | The chat model's key (the default variable), and the extra hosts a key may be sent to.                                      |
| `SHAPEWALL_SLACK_WEBHOOK_URL`, `SHAPEWALL_DISCORD_WEBHOOK_URL` | A Slack or Discord channel without any config.                                                                              |
| `SHAPEWALL_TELEGRAM_BOT_TOKEN`, `SHAPEWALL_TELEGRAM_CHAT_ID`   | A Telegram bot channel without any config.                                                                                  |
| `SHAPEWALL_WEBHOOK_URL`, `SHAPEWALL_WEBHOOK_SECRET`            | A signed webhook without any config.                                                                                        |
| `RESEND_API_KEY`, `SHAPEWALL_EMAIL_FROM`, `SHAPEWALL_EMAIL_TO` | Email through Resend without any config.                                                                                    |
| `SHAPEWALL_GITHUB_TOKEN`, `GITHUB_TOKEN`                       | The GitHub token for GitHub connect (the first one set wins).                                                               |
| `SHAPEWALL_GITHUB_REPO`                                        | The GitHub repo, `owner/name`. Wins over the config.                                                                        |
| `SHAPEWALL_GITHUB_API_URL`                                     | GitHub Enterprise API URL. A config's `github.apiUrl` gets your token only when this matches.                               |
| `SHAPEWALL_GITHUB_GH`                                          | `0` drops the `gh auth token` fallback, so only the token variables above are used.                                         |
| `SHAPEWALL_GITHUB_WEBHOOK_SECRET`                              | Turns on the GitHub webhook endpoint, with this secret.                                                                     |
| `SHAPEWALL_REMOTE`, `SHAPEWALL_TOKEN`                          | Hosted URL and project token for `push` and `--remote`.                                                                     |
| `SHAPEWALL_HOSTED_DATA`                                        | Data folder for `shapewall hosted`.                                                                                         |
| `SHAPEWALL_BUZZ_SIGNER_CODEX`, `SHAPEWALL_BUZZ_SIGNER_CLAUDE`  | Signer files for the optional, experimental [Buzz bridge](/docs/buzz).                                                      |
| The other `SHAPEWALL_HOSTED_*`                                 | Settings for `shapewall hosted` (several flags have one); [the hosted guide](/docs/hosted).                                 |

## Exit codes

Every command exits with one of these. A command that has its own meaning for one says so in its section.

| Code         | Meaning                                                                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`          | Done. `init` also exits 0 when the app did not answer and it wrote the home page only (with a warning).                                                                                   |
| `1`          | An error stopped the command: a bad flag or config, no browser, a failed request. Nothing was finished.                                                                                   |
| `2`          | Partial: some shots (`capture`), page views (`checks`, `checks lighthouse`) or broken links (`links --broken`) failed, and the rest was saved; or `init`'s address answered with no page. |
| `3`          | `ci capture-compare --fail-on-change`: something changed.                                                                                                                                 |
| `4`          | `ci capture-compare --fail-on-change`: not everything could be compared.                                                                                                                  |
| `130`, `143` | Stopped by Ctrl+C (SIGINT) or SIGTERM before the work was done.                                                                                                                           |

## Deprecated spellings

These 0.x spellings still work through 1.x, each with a one-line warning on stderr, and go away in 2.0: `hosted --setup` (use
`hosted setup`), `variant rm` (`variant remove`), `export --noindex` (`--no-index`), `audit` (`checks lighthouse`), `audit
--production` (`--build-mode`), `audit BOARD` (`--board BOARD`), `agent run|watch|doctor|build-image` (`agent sandbox run|watch|doctor|build-image`),
`capture --yes` (capture never prompts; leave it out), `versions`, `notifications.boardUrl` and `github.boardUrl` in the config
(`keepVersions` and the top-level `boardUrl`), and `SHAPEWALL_USERCONTENT_ORIGIN` (`SHAPEWALL_HOSTED_USERCONTENT_ORIGIN`).

Commands and options marked `(experimental)` in the help, and the pages of these docs marked experimental, are outside the
[stability promise](/docs/stability).

## Every command and option

What `shapewall --help all` prints:

```text
Usage: shapewall <command> [options]

Commands
  auth record               open a fresh browser for manual capture sign-in
      --board ID            board to sign in to (default: the first)
      --env ID              environment to sign in to (default: the first)
      --url URL             optional sign-in page (never printed)
      --timeout DURATION    time to finish, e.g. 90s or 10m (default 10m, maximum 30m; a number alone is seconds)
      --overwrite           explicitly replace this board/environment's saved state
                            press Enter to save; Ctrl-C, browser close or timeout discards
                            saves a private .shapewall-auth/*.auth.json; config stays unchanged
                            the first sign-in window downloads the full Chromium (doctor installs only the headless one)
  init                      write shapewall.config.json in this folder
      --base-url URL        the app to capture (default http://localhost:3000); finds its
                            pages: <base URL>/sitemap.xml, else links from the home page
                            (2 levels, 25 pages, same site only)
      --sitemap [URL|FILE]  take the pages from this sitemap instead
                            (alone: <base URL>/sitemap.xml)
                            (with --limit, --group, --exclude as for sitemap)
      --no-discover         do not look for pages: write the home page only
      --force               overwrite an existing config
      --ci                  write .github/workflows/shapewall.yml (capture on every pull request) beside
                            the config; an existing config is kept, --force replaces only the workflow
      --no-agent-docs       do not add the Shapewall section to AGENTS.md, and write "agentDocs": false
                            into the config so serve and capture do not either (see agent docs)
                            exit code: 0 config written (a warning when the app did not answer: home page only),
                            2 the address answered but not with a page (check --base-url), 1 error
  sitemap [URL|FILE]        add the pages of a sitemap.xml (or sitemap index) to the config
                            (default: the board's "sitemap" setting)
      --limit N             at most N new pages, the shallowest first (default 100)
      --group NAME          put them all in one group (default: by first path segment)
      --exclude /PREFIX     leave out paths starting with this (repeat or comma-separate)
      --board ID            board to add them to (default: the first)
      --dry-run             show what would be added, change nothing
      --json                machine-readable result
  capture                   capture every page (desktop + phone, PNG + live HTML) and check its links
      --board ID            board to capture (default: the first)
      --only ID|PATH        only these pages (repeat or comma-separate)
      --env ID              capture this environment (default: the first)
      --check-external      also check links to other sites (default: same-site links only)
      --json                machine-readable summary on stdout (totals, failures, broken links); progress on stderr
                            exit code: 0 all shots ok, 2 some failed (an "expectStatus" page is ok), 1 error
  checks [run|list]         check original pages and save private diagnostic reports (experimental)
  checks flow --flow-file FILE    run one explicit interaction flow, with an optional final accessibility snapshot
  checks accessibility --only ID [--viewport NAME]    audit one original page state with axe
      --board ID            board to check (default: the first)
      --env ID              environment to check (default: the first)
      --only ID|PATH        only these pages (repeat or comma-separate)
      --seo | --no-seo      include public SEO and social-image checks, or leave them out when the config turns them on
      --limit N             maximum page views to check (default 20)
      --source-build SHA    source revision for report provenance
      --json                machine-readable reports; progress on stderr
                            exit code: 0 all passed, 2 some failed, 130 or 143 stopped (Ctrl+C, SIGTERM) before every view, 1 error
  checks lighthouse         run bounded Chrome Lighthouse lab audits on original pages (experimental)
                            (needs Lighthouse beside Shapewall: npm install lighthouse@13.6.0)
                            --board, --env, --source-build, --seo | --no-seo and --json as above
      --only ID             only these page ids (repeat or comma-separate)
      --viewports NAMES     configured viewport names, comma-separated
      --samples N           repeated samples per view (default 1, maximum 10)
      --max-pages N         explicit page cap (default 5, maximum 20)
      --max-runs N          explicit navigation cap (default 10, maximum 40)
      --cache MODE          cold, warm or auth-preserved
      --build-mode MODE     the app's build: production, development or unknown (default)
      --browser-version V   require this installed browser version
                            exit code: 0 every view complete, 2 some partial or failed, 1 error
  serve                     serve the board (http://127.0.0.1:4600/ by default)
      --port N              default 4600
      --host ADDR           default 127.0.0.1 (see https://shapewall.com/docs/self-hosting before changing)
      --tailscale[=print]    private HTTPS over Tailscale; =print changes nothing
      --no-identity         pair even devices signed in as the Tailscale owner
      --lan[=IP|INTERFACE]   pair devices on your network (HTTP cookies can be sniffed)
      --tls-cert FILE       with --lan: HTTPS certificate (also --tls-key FILE)
      --no-remote-chat      paired devices cannot use the agent
      --approve-on-host     paired devices cannot approve agent commands
      --open                also open the board in your browser, with agent settings
      --print-owner-link    print the private owner link in full (also $SHAPEWALL_PRINT_OWNER_LINK=1)
      --read-only           no comments or captures from the UI
      --accounts            require local passkey accounts after owner setup (Node 22.19+)
      --accounts-origin URL fixed HTTPS origin (default: loopback URL or --tailscale URL)
      --no-capture          comments allowed, captures only from the CLI
      --buzz-bridge FILE    owner-only existing Buzz conversation (private operator map; https://shapewall.com/docs/buzz) (experimental)
      --allowed-host NAME   extra Host header to accept (repeatable; also $SHAPEWALL_ALLOWED_HOSTS, "*" = any)
      --chat | --no-chat    the board chat with your agent (default on, off when shared beyond this machine)
      --agent-acp "CMD"     chat with an agent CLI over ACP, e.g. "claude-agent-acp" (installed globally)
                            (also $SHAPEWALL_AGENT_ACP; never read from the config; https://shapewall.com/docs/chat)
      --allow-remote-agent  with --chat on a shared board, let an ACP agent run anyway (anyone reaching it acts as you)
  devices list              paired devices and pending requests for this project [--json]
  devices approve CODE      approve after matching the code on your device
  devices deny CODE         deny a pending request
  devices revoke ID|--all   revoke a device or all devices immediately
  comments [list]           print comments (instructions for your coding agent)
      --open | --resolved | --all   which ones (default --open)
      --page ID             only comments on this page
      --mention NAME        only comments that mention @NAME (in the text or a reply)
      --since ID|TIME       only comments after this comment id, or created or changed after this ISO time
      --json                machine-readable, with selectors, file paths and replies
      --for-agent           each comment quoted as untrusted data (<shapewall-data>), for an agent to read
  comments get ID           one comment, everything about it   [--json] [--for-agent]
  comments add              add a comment   --page ID --body TEXT [--viewport NAME (default the page's first)]
                            [--selector CSS (pin it to that element)] [--author NAME (default agent)] [--json]
  comments selectors        the selectors --selector takes, with each element's text, from the latest capture
                            --page ID [--viewport NAME] [--text WORDS (only elements whose text has them)] [--json]
  comments resolve ID       mark a comment resolved   [--note TEXT] [--ref URL|COMMIT] [--author NAME] [--json]
  comments reopen ID        reopen a comment   [--author NAME] [--json]
  comments reply ID         add a reply   --body TEXT [--author NAME (default agent)] [--json]
  comments status ID S      agent status: queued, working, done, needs-human or clear   [--note TEXT] [--author NAME] [--json]
  comments delete ID        delete a comment, its replies and its images for good; asks first
                            [--yes (do not ask; needed without a terminal)] [--json]
      --board ID            board (default: the first); --remote URL for a hosted board (see push)
  events                    comment events from every process (the shared log); never claims anything
      --follow              keep printing new events until Ctrl+C
      --since ID|TIME       after this event id (from --json) or ISO time
      --limit N             without --follow or --since: the last N (default 20)
      --json                one JSON line per event   [--board ID]
  journeys [list]           print the board's journeys, with every fork and branch
      --json                machine-readable: steps (forks included), pages and every path
  links                     links between the board's pages, from the last capture
      --broken              only links that lead to an error (4xx/5xx or no answer)
      --board ID | --env ID | --json
  watch                     hand each new open comment to an agent (runs until Ctrl+C)
      --exec "CMD ARGS"     run this command per comment (comment JSON on stdin; no shell)
                            without --exec, print one JSON line per comment and mark it queued
                            (the reader sets its status with "comments status"; --no-claim marks none)
      --concurrency N       commands at once, 1 to 4 (default 1)
      --recapture           recapture the comment page after a successful --exec (local only)
      --new-only            skip comments that exist when the watch starts
      --once                hand out what is open now, wait for the commands, exit
      --timeout DURATION    stop a command after this long, e.g. 90s, 30m or 2h (default 60m; a number alone is minutes)
      --mention NAME        only comments that mention @NAME, e.g. --mention agent (mentions people wrote;
                            text an agent wrote never counts)
      --no-claim            hand out every open comment once without claiming it (no agent status, beside other watchers)
                            a command that exits 0 must reply or set a status itself, else the
                            comment becomes needs-human (https://shapewall.com/docs/agent-workflow)
  agent setup               register the shapewall MCP server with Claude Code and Codex (each one on PATH),
                            so an agent opened in this project has the board's tools. Shows what changes and
                            asks first; backs up each file it changes; touches only the shapewall entry
      --claude | --codex    only this app
      --scope local|user|project  Claude Code: local (default) this project, only you; user every project
                            of yours; project .mcp.json, committed (Claude Code asks each person to approve it).
                            Codex has no scope: ~/.codex/config.toml, every project, tool_timeout_sec 600
      --remote URL          a hosted board: registers "shapewall mcp --remote URL" (needs shapewall login first;
                            no token is written)
      --force               replace a shapewall entry that is different (an older Shapewall's entry
                            is updated without it)
      --dry-run             show the changes, write nothing      --yes   write without asking
      --remove              take the shapewall entries out       --json  machine-readable
  agent status              what the agent can do here, line by line and per tier (solo, team, open): the same
                            lines the console shows under What it can do, and the agent's own instructions.
                            Each line that is off says why, and the command that changes it
      --remote URL          a connected agent (its agent-policy.json entry, and whether its link is open);
                            without it, the local board in this project
      --as NAME             which connection (default "default")   --json  machine-readable
  agent set KEY VALUE       change one line without reconnecting, for example: agent set browser off,
                            agent set shell commands, agent set trust-team ada,bo. With --remote URL (and --as NAME)
                            a connected agent's setting (narrower: from its next turn); without it, this project's
                            local board, read by the next turn. "agent status" lists the keys under each line.
                            Extensions: agent set agent-config DIR (a local board's skills and MCP servers),
                            agent set extensions-for owner,HANDLE, agent set allow-tool mcp__SERVER__TOOL
  agent docs                where the Shapewall section for coding agents is (AGENTS.md, CLAUDE.md)
      --write | --remove | --print   put it in (or refresh it), take it out (and set "agentDocs": false
                            in the config, so it stays out in every clone), print it. The first serve or
                            capture creates both files only in a project with neither and no "agentDocs"
                            in the config; an existing AGENTS.md or CLAUDE.md is never edited unasked
  agent connect             make this machine's coding agent an agent of a hosted project: members chat with it
                            on the board, and it reads this folder and answers. Read and answer only unless this
                            machine says more (--approvals). The first run is approved in the browser by an admin.
                            --remote URL
      --agent NAME          which agent: claude, or a saved agent's id that runs Claude Code (default: this
                            project's agent, else Claude Code when found). Codex, goose and Gemini CLI are not
                            offered in this release. Never a command from the server
      --name "Builder"      the name to suggest on the approval page (the approver has the last word)
      --project SLUG        on a server with tailnet sign-in, run on a tailnet machine (experimental)
                            no browser, your tailnet user approves it. --project (and --workspace NAME) pick the
                            project when there are several; --used-by owner|trusted who may send it work (default owner: only you);
                            --icon NAME and --tint NAME as on the approval page
      --as NAME             a second connection from this machine (its own token; default "default")
      --audience owner|server  "owner": the server keeps it to the person who connects it even if its audience
                            there is widened, and this machine refuses a job the server says is someone else's
                            (no protection from a server that lies); "server" (default): its audience on the server
      --approvals none|owner|admins  edits from the board. "none" (default): never. "owner": the person who
                            connected it may allow each edit on the board. "admins": whoever the server lets
                            answer (admins by default). A fix is made on a new branch in a folder of its own,
                            never in this checkout. Saved for this connection; the server cannot widen it
      --allow-command "CMD" refused in this release ("none" empties a saved list; agent set allow-command
                            too): exact commands would need Claude Code's own shell tool, which runs read-only
                            commands without asking. The project's named commands run through Shapewall instead
      --auto none|edits|commands|edits,commands  what the server's "allow without asking" rule may apply to
                            (default none). Never a file that runs something. Such a fix stays on this machine:
                            it is pushed only after a person allows "Push this fix" on its whole diff. With
                            --approvals owner, only the person who connected it can switch the rule on
      --allow-path FILE     a file that runs on install, build, test or CI (a dotfile, package.json, a Makefile,
                            a *.config.js, a script, a test, CI config) the agent may ask to edit; such edits are
                            refused otherwise, a named one is always asked, and a fix that changes one is never
                            pushed (adds to the list; "none" empties it)
      --base BRANCH         the branch a fix starts from (default "head": the commit this checkout is on, and
                            then only while it has no uncommitted changes)
      --git-remote NAME     where a finished fix is pushed (default origin; "none": never pushed). A pull request
                            is opened when GitHub connect is set up here (https://shapewall.com/docs/github)
      --instructions all|project|none  instruction files each session gets as an appended system prompt: the
                            project's CLAUDE.md and .claude/CLAUDE.md (AGENTS.md when neither exists) and, with "all"
                            (default), the agent config folder's CLAUDE.md. Never ~/.claude or CLAUDE.local.md. Names
                            and hashes show on the board, never the text. They add no powers. Saved for this connection
      --agent-config DIR|none  this agent's own folder for its CLAUDE.md (default: agent-config/<--as name> beside
                            agent-policy.json, read only when it exists; never created). Outside the project.
                            A folder named here also gives skills (skills/NAME/SKILL.md) and stdio MCP servers
                            (.claude.json mcpServers) to trusted turns on clean threads (extensions-for, allow-tool)
      --respond thread|mention  in a shared thread (the board chat, a comment's) it answers an @mention of it or
                            Send to agent; "thread" (default) also every message of a thread the person who
                            connected it set to answer everything, "mention" never. A private chat answers every
                            message; a message an agent wrote never starts a turn. Saved for this connection
      --browser-profile NAME|none  a saved profile of the agent browser's own (test or staging logins), made
                            in $XDG_STATE_HOME/shapewall/agent-browser-profiles/NAME; never a browser's own profile
      --browser-no-sandbox  let the agent browser start without Chromium's own sandbox where it cannot start
                            (solo and team turns only; pages then run with less isolation). Saved for this connection
      --takeover            close the link another machine holds for this agent, and take its place
      --concurrency N       answers at once, 1 to 4 (default 2)
      --token-file FILE     for a service: the agent's own token, no browser (https://shapewall.com/docs/hosted)
  agent sandbox run --comment ID   (experimental)
                            the sandboxed starter agent on one comment: a container with only a fresh
                            worktree, egress to the package registry only (the model is called from here), a branch
      --pr                  also push the branch and open a pull request (GitHub connect); not when it
                            touches CI config, manifests or build files unless --allow-ci-push
      --git-remote NAME     the git remote --pr pushes to (default origin; never from the config)
      --fork-remote NAME    push to your fork (a git remote) instead, and open the PR from it
      --retry               take a comment whose agent status is done or needs-human too
      --trust-comment       run a comment the trigger gate holds back (never a guest's)
      --max-turns N | --max-tokens N | --max-minutes N   budget for this comment
      --max-disk SIZE       disk cap on the checkout (default 2g; the run stops over it)
      --model-timeout DURATION  time a model call may take to start answering, 1s to 15m (default 180s for the
                            first call, 60s after; tried once more on a timeout; a number alone is seconds)
      --trusted NAME        may dispatch work (repeatable; adds to starterAgent.trusted)
      --runtime podman|docker   --image NAME   --profile openai-compatible (the only profile)
      --allow-host HOST[:PORT]  extra egress host (repeatable)   --registry HOST|none
      --work-dir DIR        where worktrees go (default: the cache folder)
  agent sandbox watch       run the starter agent on each comment the trigger gate lets through   [--once]
  agent sandbox doctor      check the runtime, image, model, trust lists and the sandbox itself   [--no-egress]
  agent sandbox build-image build the agent's image from this package's Dockerfile.agent
      --runtime podman|docker   --image NAME (default localhost/shapewall-agent:latest)
                            (https://shapewall.com/docs/starter-agent; --remote URL works for run and watch)
  github issue ID           open a GitHub issue from a comment (or show the one it has)
  github link ID PR         link a pull request (12, #12 or its URL) to a comment
  github sync               link pull requests that name a comment; resolve comments whose PR merged
                            (repo: "github.repo" in the config; token: $SHAPEWALL_GITHUB_TOKEN or $GITHUB_TOKEN,
                            else a signed-in GitHub CLI ("gh auth token"))
  ci capture-compare        capture before and after, compare every page and viewport, write a result
                            folder: summary.json, summary.md (the comment), images of changed shots
      --base-url URL        before (default: the board's baseUrl)   --head-url URL   after
      --base-dir DIR        or compare two capture folders   --head-dir DIR
      --out DIR             the result folder (default shapewall-ci)
      --threshold RATIO     share of pixels below which a shot is unchanged (default ci.threshold, 0.00001)
      --max-pages N         compare at most N pages (default ci.maxPages, 50)
      --fail-on-change      exit 3 when something changed, 4 when not everything could be compared (default: always 0)
  ci capture --out DIR      capture one side into a folder, from --url URL, or with --allow-start
      --allow-start         run ci.start (install, build, serve; argv arrays, no shell) in --checkout DIR
                            and capture its url; only inside a CI job (GITHUB_ACTIONS or CI is "true")
  ci comment                post or update the one pull request comment from a result folder
      --dir DIR             the result folder (default shapewall-ci)
      --artifact-url URL    link to the workflow artifact with the images
      --repo OWNER/NAME | --pull N   default: from the pull_request event
                            token: $GITHUB_TOKEN; a fork's pull request gets the job summary instead
  ci enabled                is it on for this pull request (ci.enabled, [skip shapewall] in the title)?
                            writes enabled=true|false to $GITHUB_OUTPUT
  ci wait --url URL         wait until a deploy preview answers   [--timeout DURATION (default 600s, at most 1h;
                            a number alone is seconds)]
      --board ID | --json   (https://shapewall.com/docs/pull-requests)
  open                      print and open a deep link: a board, a page, a comment, a screen size, a before and after
      --board ID            the board (default: the first)
      --page ID|TITLE       fly to this page
      --comment N           open on this comment, at its screen size (wins over --page)
      --viewport NAME       desktop, phone, any viewport of the board, or all
      --compare [A_B]       alone: the page's before and after (needs --page or --comment);
                            A_B: two environments side by side
      --follow [AGENT]      follow an agent: fly to each comment it takes, before and after when it
                            recaptures that screen (alone: any agent; hosted: an agent id)
      --print               print the link only, do not open a browser
      --json                { url, board, page, comment, viewport, compare, follow, running }; opens nothing
      --remote URL          a hosted project instead of the local board (with --token-file, --include-guests)
                            When the local board is not running, it prints the link and says to run shapewall serve
  mcp                       MCP server on stdio for coding agents: find comments, reply, recapture, compare
                            before and after, and links to the board. shapewall agent setup registers it
      --read-only | --no-capture   only the reading tools | everything but recapture_pages
  notify list               notification channels, their events and what each still needs   [--json]
  notify test CHANNEL       send a test message to one channel   [--to EMAIL for email channels]
  doctor                    check Node, the browser, the config, the port, the output folder, notifications and chat
      --install-browser     download the Chromium this Shapewall needs first (no config needed for this)
      --port N              port to check (default 4600)
      --no-launch           find the browser and the ACP agent without starting them
      --agent-acp "CMD"     the ACP agent to check: starts it, does the handshake, stops it (also $SHAPEWALL_AGENT_ACP)
      --json                machine-readable report
  variant add PAGE          capture another version of a page beside it
      --url URL | --path /p the version to capture (path is on the board's baseUrl)
      --title TEXT          [--note TEXT] [--source TEXT] [--id ID] [--viewport desktop,phone]
                            the id is --id, else the title as a slug plus 4 random characters
  variant remove ID | variant list
  export                    static read-only copy of the boards, for any static web server
                            (view it with "npx serve shapewall-export"; opening index.html from disk does not work)
      --include-checks      explicitly include private diagnostic reports
      --out DIR             default shapewall-export
      --no-comments         leave comments (their text, authors and replies) out
      --browser-comments    visitors may comment; their comments stay in their own browser
      --no-index            ask search engines not to index the export
  share --remote URL        move local captures, history and comments to a shared project
      --include-checks      explicitly include private diagnostic reports
      --board ID            move only this board (default all)
      --dry-run             show counts; sends nothing
      --no-comments         captures, history and journeys only
  migrate                   move this project's .shapewall/ into the solo engine (.shapewall/server/) (experimental)
                            captures, comments, chat and the local account; a backup goes to
                            .shapewall/backup-1x-<time>/ first. Refuses while serve, capture, watch or an agent runs
      --dry-run             counts, and every item that would not come along; writes nothing
      --board ID            only this board (default: every board)
      --rollback            put every migration back from its backup (checked byte for byte)
      --json                machine-readable result
                            exit code: 0 done or nothing to do, 1 refused or failed (the folder is put back)
  buzz-bridge               run a private foreground gateway to existing Buzz agents (experimental)
      --bridge-config FILE  private operator map outside project/capture data; Ctrl-C stops it
                            no new agent, session, model, or automatic completion (https://shapewall.com/docs/buzz)

Hosted Shapewall (https://shapewall.com/docs/hosted)
  login --remote URL        get a project token through the browser; saved for the --remote commands
      --project SLUG        on a server with tailnet sign-in, run on a tailnet machine (experimental)
                            no code and no browser; your tailnet user approves it (if its role may). --project, and --workspace NAME
                            when you are in several, pick the project; with one project neither is needed
  join --remote URL         join a workspace on a server with tailnet sign-in (experimental)
                            from a tailnet machine: takes the invite an admin made for your tailnet login. The
                            role is the invite's
      --invite LINK         an invite link (or its code) instead
  admin projects list|create NAME | members list | agents list | invites create   (experimental)
                            a few admin commands on a server with tailnet sign-in, as your tailnet user (the
                            server checks your role). --remote URL; --workspace NAME when you are in several
      --login LOGIN         invites create: for one tailnet login (ada@example.com); or --link for a link
      --role ROLE           viewer, member (default), admin or owner; --days N until it expires; --name; --json
  push                      upload the latest captures to a hosted project
      --include-checks      explicitly include private diagnostic reports
      --remote URL          the hosted Shapewall (or $SHAPEWALL_REMOTE)
      --board ID            only this board (default: every board)
      --page ID[,ID]        only these pages' captures, to a board already pushed; other pages
                            there stay as they are, and a newer capture there is never replaced
  comments | watch | mcp --remote URL
                            the same commands against a hosted board (--board ID picks one)
                            token: $SHAPEWALL_TOKEN or --token-file FILE (a project token, swp_...)
                            watch --exec commands get no token unless --pass-token
                            watch and mcp show on the board as an agent, by the token's name
                            mcp --remote in a project folder, with the "push" scope, also has
                            recapture_pages: it captures here, then pushes those pages;
                            add_comment needs the "reply" scope
      --include-guests      comments and watch: also share link guests' comments (untrusted)
  hosted                    run the hosted server (accounts, workspaces, pushed boards)
      --data DIR            default ./shapewall-hosted-data (or $SHAPEWALL_HOSTED_DATA)
      --origin URL          public origin, e.g. https://app.example.com (default http://HOST:PORT)
      --port N | --host ADDR   default 4700 on 127.0.0.1
      --signup invite|open  default invite (the first account uses the setup link)
      --trust-proxy         behind a reverse proxy on this host (client IPs from X-Forwarded-For)
      --usercontent-origin URL  serve live HTML only from this other origin (or $SHAPEWALL_HOSTED_USERCONTENT_ORIGIN)
      --previous-origin URL while moving to a new origin: the old one (sign-in moves, up to 30 days)
      --report-email ADDR   where "Report this board" on public projects goes
      --owners-see-sign-ins workspace owners see their members' sign-ins and devices in Activity
                            (off: each person sees only their own; for a server with one team)
      --tailscale           on your tailnet through tailscale serve (https://<machine>.<tailnet>.ts.net)
      --tailscale-port N    default 443
      --funnel              share links public through Tailscale Funnel (experimental)
                            (share pages only, never the console), on --funnel-port 8443|443|10000
      --tailnet-sign-in     with --tailscale: sign tailnet users in by their tailnet login (experimental)
                            a tailnet user is signed in as the account linked to their tailnet login, no passkey (or $SHAPEWALL_HOSTED_TAILNET_SIGN_IN=1). An admin still decides
                            who is in a workspace. Needs Linux, macOS or Windows and Tailscale 1.98+ in TUN mode, not
                            in a container; refuses to start where it cannot prove that a request came through
                            tailscale serve. An identity is per device: what runs as you there can act as you.
                            Tailscale is then the only sign-in: no passkeys, and the few things that always ask
                            take a typed confirmation
      --tailnet-passkeys    with --tailnet-sign-in: also allow passkeys (experimental)
                            ($SHAPEWALL_HOSTED_TAILNET_PASSKEYS=1, or hosted admin passkeys on|off). An account that adds one confirms with it
      --quotas FILE         per-workspace quotas (default <data>/quotas.json when it exists)
      --retention-hours N   prune old versions every N hours (default 6, 0 = off); --retention-keep N (2)
  hosted setup-link         print the first account's one-time link (it is not in the log)
  hosted claim --data DIR --login LOGIN   (experimental)
                            with --tailnet-sign-in: make the first account on the server's own machine, no
                            browser. Whoever can read the data folder says whose server it is: --login is the
                            owner's tailnet login (ada@example.com); --workspace-name NAME. From another tailnet
                            device: hosted claim --setup-link URL (the server then sees who asks)
      --data DIR | --new    --new: make a new link (the old one stops working)
  hosted move-origin --to URL   move the server to a new origin (passkeys move with a rebind)
      --data DIR | --days N | --status   window 1 to 30 days (default 30)
  hosted setup --domain HOST    write a Docker Compose + Caddy folder for your own domain
      --usercontent-domain HOST  live HTML on its own domain; --email (TLS); --dir (./shapewall-hosted)
      --source DIR          a Shapewall checkout to build from; --dry-run; --force; --start (build, start, setup link)
  hosted admin list|suspend|resume|delete|export|reports|retention|log   the operator's commands
  hosted admin members|invites|projects|passkeys ...   who is in a workspace and how people sign in, from the
                            server's own machine (shapewall hosted admin help lists them)
  hosted backup --to DIR [--keep-days N]   a consistent copy while the server runs
  hosted restore --from BACKUP --data NEW | --from BACKUP --check (the restore drill)

Global
  --config FILE             default ./shapewall.config.json (or $SHAPEWALL_CONFIG)
  -h, --help | -v, --version   (shapewall <command> --help shows one command)
  exit codes: 0 ok, 1 error, 2 partial (some shots, checks or Lighthouse views failed, or init's address
  answered with no page), 3 and 4 a ci comparison that asked to fail on a change, 130 or 143 stopped
  (Ctrl+C, SIGTERM)
  (experimental): may change in a minor release; not covered by https://shapewall.com/docs/stability
```
