Every command takes `--config FILE` (default `./shapewall.config.json`, or `$SHAPEWALL_CONFIG`). `shapewall --help` prints this list,
`shapewall <command> --help` (or `shapewall help <command>`) prints one command's options, and `shapewall --version` prints the
version.

An option the command does not take is an error, with the closest real one as a hint: `shapewall capture --onyl home` stops with
`unknown option --onyl for "capture" (did you mean --only?)` instead of capturing every page.

Messages that suggest a command (`doctor`, `init`, a missing browser) write it the way you started Shapewall:
`npx shapewall doctor` for a copy installed in a project, or the path of a clone's executable. See
[install](/docs/getting-started#install). The complete help text is [at the end of this page](#every-command-and-option).

## shapewall init

```text
shapewall init [--base-url URL] [--sitemap [URL|FILE]] [--force]
```

Writes a starter `shapewall.config.json` in the current folder and adds `.shapewall/`, `shapewall-export/` and `*.auth.json` to
`.gitignore`.
`--base-url` sets the site to capture (default `http://localhost:3000`). `--force` overwrites an existing config. `--sitemap` takes the
pages from a sitemap instead of the three examples and records it in the config (it accepts the `shapewall sitemap` options too).

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
shapewall auth record [--board ID] [--env ID] [--url URL] [--timeout SECONDS] [--overwrite]
```

Opens a fresh isolated browser for you to sign in manually. Return to the terminal and press Enter to save; `cancel`, Ctrl-C,
browser close or timeout discards. Default timeout is 600 seconds, maximum 1800. `--overwrite` explicitly replaces an existing state.
It saves private `.shapewall-auth/*.auth.json` files outside capture/export output and prints the config snippet to apply.
The config is not changed automatically. A desktop display and terminal are required; no personal browser profile is borrowed.
See [signed-in captures](/docs/config#auth). Never share the saved state, which contains account credentials.

## shapewall capture

```text
shapewall capture [--board ID] [--only ID|PATH ...] [--env ID] [--check-external] [--json] [--yes]
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

For CI, `--json` prints one JSON summary on stdout (`ok`, `total`, `failed`, `expected`, `failedShots`, `shots`, `brokenLinks`, ...)
and sends the progress lines to stderr. `--yes` is accepted so scripts can say "no questions": capture never prompts.

| Exit code | Meaning                                                               |
| --------- | --------------------------------------------------------------------- |
| `0`       | Every shot succeeded (an `expectStatus` page with its status counts). |
| `2`       | Some shots failed; the rest were saved.                               |
| `1`       | An error: bad config, no browser, ...                                 |

## shapewall checks and audit

```sh
shapewall checks run --board site --only home --seo --limit 2
shapewall checks list --board site --json
shapewall audit --board site --only home --viewports phone --samples 1
shapewall checks accessibility --board site --only home --viewport phone
shapewall checks flow --board site --flow-file checkout.audit.json
```

These commands measure original pages locally and save bounded private reports. Lighthouse provides navigation lab metrics; axe audits one page state; explicit flow files run a sequence once. Reports never launch an agent. Configured actions can change the original app, so use safe fixtures. Read [Page checks](/docs/page-checks) for limits, performance budgets, comparison conditions and explicit sharing options.

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

## shapewall serve

```text
shapewall serve [--port 4600] [--host 127.0.0.1] [--open] [--read-only] [--no-capture] [--allowed-host NAME] [--chat | --no-chat]
                [--agent-acp "CMD"] [--allow-remote-agent]
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

## shapewall buzz-bridge

```sh
shapewall buzz-bridge --bridge-config /absolute/private-folder/bridge.json
shapewall serve --config /absolute/path/to/source-folder/shapewall.config.json --buzz-bridge /absolute/private-folder/bridge.json
```

Optional, and only for people who run Buzz, a self-hosted chat where coding agents sit in channels: the gateway lets the board's owner
message those agents. It runs in the foreground on a private Unix socket, and Ctrl-C stops it without touching Buzz. Keep its
configuration and receipts outside source, capture and export folders. See [the Buzz bridge](/docs/buzz).

## shapewall settings

```text
shapewall settings [--config FILE] [--port N] [--open]
```

Starts temporary host-only agent management at `http://127.0.0.1` on a free port (default `--port 0`). `--open` opens its private
one-time link; otherwise use the private link printed in the same terminal. It stays in the foreground until Ctrl-C.

Use the source project's config, the same OS user and the same settings environment as the running board. **Shapewall agent settings**
uses that real source directory's private `agents.json` entry, with owner capability and source-folder/command confirmation.
It exposes no board, capture or chat dispatch routes and does not register another local project or start a notification worker.
Saves, profile changes and tests refuse while project agent work is in progress, including work in another instance; see [agent management](/docs/chat#host-only-agent-management).

For `serve --tailscale --accounts`, the server prints the **Host agent settings** command and `serve --open` opens the ordinary fixed
account origin. The account board's gates and read-only remote settings stay in place. This management command does not create,
enroll or sign in an account. See [local accounts](/docs/local-accounts#tailscale-account-origin).

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
shapewall agent build-image [--runtime podman|docker] [--image NAME]
shapewall agent doctor [--no-egress]
shapewall agent run --comment ID
shapewall agent watch [--once]
```

The sandboxed starter agent is separate from native ACP board chat. Its [guide](/docs/starter-agent) explains the container, model and
trusted-author prerequisites, budgets and approval limits. `shapewall agent --help` lists current run/watch policy flags.

## shapewall comments

```text
shapewall comments [--open|--resolved|--all] [--page ID] [--mention NAME] [--since ID|TIME] [--json]
shapewall comments get ID [--json]
shapewall comments add --page ID --body TEXT [--viewport NAME] [--selector CSS] [--author NAME] [--json]
shapewall comments resolve ID [--note TEXT] [--ref URL|COMMIT] [--author NAME] [--json]
shapewall comments reopen ID [--author NAME] [--json]
shapewall comments reply ID --body TEXT [--author NAME] [--json]
shapewall comments status ID queued|working|done|needs-human|clear [--note TEXT] [--author NAME] [--json]
```

Prints comments as a work list. Plain text is for pasting into a chat; `--json` is for agents, with the page, viewport, selector,
element text, position, file paths, replies, mentions and agent status of each comment. `--page ID` keeps one page and its variants;
`--mention NAME` keeps comments that mention `@NAME` in the text or a reply.

`resolve --ref` records what fixed it (a pull request URL or a commit), shown on the board as "Fixed in". Reopening clears the agent
status. `reply` adds to the comment's thread (the author defaults to `agent`); `status` sets the agent status, and `--note` adds a reply
with it. `--since` keeps comments after that comment id, or created or changed after that ISO time; `get` prints one comment.

`add` makes a comment like the board does (checks, events, mentions, notifications): `--viewport` defaults to the page's first,
`--author` to `agent`, and `--selector` pins it to an element (the selector grammar comments show); without one the pin sits near the
top-left corner. `--author` on `resolve`, `reopen` and `status` names who did it in the events (default `agent`). See
[the agent workflow](/docs/agent-workflow).

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
shapewall watch [--exec "CMD ARGS"] [--concurrency N] [--new-only] [--once] [--timeout MIN] [--mention NAME] [--no-claim]
```

Hands each new open comment to a coding agent, until you press Ctrl+C. With `--exec`, runs the command once per comment with the
comment JSON on stdin (no shell is involved); without it, prints one JSON line per comment. `--mention agent` hands out only comments
that tag `@agent`, so people can discuss a comment first and tag the agent when it is ready. A command that exits `0` must leave a
word: a reply (`shapewall comments reply`) makes the comment `done`, a status it sets itself is kept, and a silent exit `0` makes it
`needs-human` with a note, since nothing says what the agent did. `--no-claim` hands out every open
comment once without claiming it (no agent status, no lock), to run beside another watcher. Details in [the agent workflow](/docs/agent-workflow#shapewall-watch-the-loop-closes-by-itself).

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

A Model Context Protocol server on stdio, for agents that prefer tools over shell commands. `--read-only` offers only the reading
tools; `--no-capture` drops `recapture_pages`. See
[the agent workflow](/docs/agent-workflow#mcp-server-shapewall-mcp).

## shapewall variant

```text
shapewall variant add PAGE (--url URL | --path /p) --title TEXT [--note TEXT] [--source TEXT] [--id ID] [--viewport desktop,phone]
shapewall variant rm ID
shapewall variant list
```

Captures another version of a page (a branch preview, a redesign) and puts it beside the page on the board. `--path` is resolved on
the board's `baseUrl`; `--url` can point anywhere. The variant's id is `--id`, or the title as a slug plus four random characters
(`calmer-hero-3f9a`); `variant add` prints it, and `variant rm` takes it.

## shapewall export

```text
shapewall export [--out shapewall-export] [--no-comments] [--browser-comments] [--noindex]
```

Writes a static, read-only copy of the boards that any static host can serve, with compare data for every pair of captured
environments. `--no-comments` leaves the comments out. `--browser-comments` lets visitors add, resolve and reply to comments that stay
in their own browser (localStorage), never on the host. `--noindex` adds a robots `noindex` tag if the client does not have one.

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
shapewall doctor [--install-browser] [--port 4600] [--agent-acp "CMD"] [--json]
```

Checks Node, the browser (by starting it), the config, the port, the output folder, the notification channels and the chat agent, and
says what to fix. With `--agent-acp` (or `SHAPEWALL_AGENT_ACP`) it prints the agent command, starts the agent, does the ACP handshake
(no prompt) and stops it. `--install-browser` downloads the Chromium build Shapewall's Playwright needs first; it needs no config (a
missing one is a skip, not a FAIL, so it works in the Shapewall clone before the demo). Exits 1 when a check fails, so it works as a
first CI step. A GitHub token that GitHub rejects (401) is a FAIL.

## shapewall login and share

```text
shapewall login --remote URL
shapewall share --remote URL [--board ID] [--dry-run] [--no-comments] [--include-checks]
```

`login` opens the hosted console to get a project token and saves it privately for remote commands. `share` moves local captures,
history, journeys and comments into a shared project. `--dry-run` reports counts without sending; `--no-comments` omits comments.
Private diagnostic reports are excluded unless `--include-checks` is explicitly selected. See [the operator guide](/docs/hosted).

## shapewall push, --remote and hosted

```text
shapewall push --remote URL [--board ID] [--include-checks]
shapewall comments|watch|mcp --remote URL [--board ID] [--token-file FILE]
shapewall hosted [--data DIR] [--origin URL] [--port 4700] [--signup invite|open] [--trust-proxy]
```

```text
  push                      upload the latest captures to a hosted project
      --remote URL          the hosted Shapewall (or $SHAPEWALL_REMOTE)
      --board ID            only this board (default: every board)
  comments | watch | mcp --remote URL
                            the same commands against a hosted board (--board ID picks one)
                            token: $SHAPEWALL_TOKEN or --token-file FILE (a project token, swp_...)
                            watch --exec commands get no token unless --pass-token
                            watch and mcp show on the board as an agent, by the token's name
      --include-guests      comments and watch: also share link guests' comments (untrusted)
  hosted                    run the hosted server (accounts, workspaces, pushed boards)
      --data DIR            default ./shapewall-hosted-data (or $SHAPEWALL_HOSTED_DATA)
      --origin URL          public origin, e.g. https://app.example.com (default http://HOST:PORT)
      --port N | --host ADDR   default 4700 on 127.0.0.1
      --signup invite|open  default invite (read the private setup link with hosted setup-link)
      --trust-proxy         behind a reverse proxy on this host (client IPs from X-Forwarded-For)
```

These are the hosted v0: a server you run yourself with `shapewall hosted` (passkey accounts, workspaces, pushed boards, project
tokens), and the clients that talk to it. Its console covers user management: invites (copy the link, or email it when
`RESEND_API_KEY` and `SHAPEWALL_EMAIL_FROM` are set), members and roles (owner, admin, member, viewer), an access overview of who
reaches which project, API tokens, an audit log, signed-in devices, and share links that give one project's boards to people without
an account (view-only or with guest comments, off until an admin turns them on). There is no hosted Shapewall service to sign up for
yet. The local commands work the same without any of this.

The [hosted operator guide](/docs/hosted) covers `hosted setup-link`, `move-origin`, Tailscale/Funnel and own-domain setup,
`admin`, quotas, retention, `backup` and `restore`, and has a checklist to walk through before you invite a team.
`push --include-checks` explicitly adds private reports; ordinary uploads leave them out.

## Environment variables

| Variable                                                       | Effect                                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `SHAPEWALL_ACCOUNTS`, `SHAPEWALL_ACCOUNTS_ORIGIN`              | Optional local passkey account gate and fixed origin; [guide](/docs/local-accounts).          |
| `SHAPEWALL_UPDATE_HELPER`, `SHAPEWALL_UPDATE_RESTART`          | Operator-managed manual update helper and explicit restart support; [guide](/docs/updates).   |
| `SHAPEWALL_CONFIG`                                             | Config file to use when `--config` is not given.                                              |
| `SHAPEWALL_ALLOWED_HOSTS`                                      | Extra Host names for `serve`, comma-separated.                                                |
| `SHAPEWALL_BROWSER_CHANNEL`                                    | Browser channel, e.g. `chrome`. Overrides the config.                                         |
| `SHAPEWALL_BROWSER_PATH`                                       | Path to a Chromium-based browser. Overrides the config.                                       |
| `SHAPEWALL_BOARD_URL`                                          | Where people open the board, for links in notifications.                                      |
| `SHAPEWALL_SLACK_WEBHOOK_URL`, `SHAPEWALL_DISCORD_WEBHOOK_URL` | A Slack or Discord channel without any config.                                                |
| `SHAPEWALL_WEBHOOK_URL`, `SHAPEWALL_WEBHOOK_SECRET`            | A signed webhook without any config.                                                          |
| `RESEND_API_KEY`, `SHAPEWALL_EMAIL_FROM`, `SHAPEWALL_EMAIL_TO` | Email through Resend without any config.                                                      |
| `SHAPEWALL_GITHUB_TOKEN`, `GITHUB_TOKEN`                       | The GitHub token for GitHub connect (the first one set wins).                                 |
| `SHAPEWALL_GITHUB_REPO`                                        | The GitHub repo, `owner/name`. Wins over the config.                                          |
| `SHAPEWALL_GITHUB_API_URL`                                     | GitHub Enterprise API URL. A config's `github.apiUrl` gets your token only when this matches. |
| `SHAPEWALL_BUZZ_SIGNER_CODEX`, `SHAPEWALL_BUZZ_SIGNER_CLAUDE`  | Signer files for the optional [Buzz bridge](/docs/buzz).                                      |
| `SHAPEWALL_GITHUB_WEBHOOK_SECRET`                              | Turns on the GitHub webhook endpoint, with this secret.                                       |
| `SHAPEWALL_REMOTE`, `SHAPEWALL_TOKEN`                          | Hosted URL and project token for `push` and `--remote`.                                       |
| `SHAPEWALL_HOSTED_DATA`                                        | Data folder for `shapewall hosted`.                                                           |

## Every command and option

What `shapewall --help` prints:

```text
Usage: shapewall <command> [options]

Commands
  buzz-bridge               run a private foreground gateway to existing Buzz agents
      --bridge-config FILE  private operator map outside project/capture data; Ctrl-C stops it
                            no new agent, session, model, or automatic completion (docs/buzz.md)
  settings                  open temporary host-only agent settings (no board or chat)
      --port N             loopback port (default: a free port)
      --open               open the private settings link in your browser
  auth record               open a fresh browser for manual capture sign-in
      --board ID            board to sign in to (default: the first)
      --env ID              environment to sign in to (default: the first)
      --url URL             optional sign-in page (never printed)
      --timeout SECONDS     time to finish (default 600, maximum 1800)
      --overwrite           explicitly replace this board/environment's saved state
                            press Enter to save; Ctrl-C, browser close or timeout discards
                            saves a private .shapewall-auth/*.auth.json; config stays unchanged
  init                      write shapewall.config.json in this folder
      --base-url URL        the site to capture (default http://localhost:3000); finds its
                            pages: <base URL>/sitemap.xml, else links from the home page
                            (2 levels, 25 pages, same site only)
      --sitemap [URL|FILE]  take the pages from this sitemap instead
                            (alone: <base URL>/sitemap.xml)
                            (with --limit, --group, --exclude as for sitemap)
      --no-discover         do not look for pages: write the home page only
      --force               overwrite an existing config
      --ci                  write .github/workflows/shapewall.yml (capture on every pull request) beside
                            the config; an existing config is kept, --force replaces only the workflow
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
      --json                machine-readable summary on stdout (shots, failures, broken links); progress on stderr
      -y, --yes             never ask anything (capture does not prompt; for CI scripts)
                            exit code: 0 all shots ok, 2 some failed (an "expectStatus" page is ok), 1 error
  checks [run|list]         check original pages and save private diagnostic reports
  checks flow --flow-file FILE    run one explicit interaction flow, with an optional final accessibility snapshot
  checks accessibility --only ID [--viewport NAME]    audit one original page state with axe
      --board ID            board to check (default: the first)
      --env ID              environment to check (default: the first)
      --only ID|PATH        only these pages (repeat or comma-separate)
      --seo | --no-seo      include public SEO and social-image checks, or leave them out when the config turns them on
      --limit N             maximum page views to check (default 20)
      --source-build SHA    source revision for report provenance
      --json                machine-readable reports; progress on stderr
  audit [board]             run bounded Chrome Lighthouse lab audits on original pages
      --board ID            board to audit (default: the first)
      --env ID              environment to audit (default: the first)
      --only ID             only these page ids (repeat or comma-separate)
      --viewports NAMES     configured viewport names, comma-separated
      --samples N           repeated samples per view (default 1, maximum 10)
      --max-pages N         explicit page cap (default 5, maximum 20)
      --max-runs N          explicit navigation cap (default 10, maximum 40)
      --cache MODE          cold, warm or auth-preserved
      --production MODE    production, development or unknown
      --source-build SHA    source build identifier for provenance
      --browser-version V   require this installed browser version
      --seo | --no-seo      include optional Lighthouse SEO checks, or leave them out when the config turns them on
      --json                machine-readable reports; progress on stderr
  serve                     serve the board (http://127.0.0.1:4600/ by default)
      --port N              default 4600
      --host ADDR           default 127.0.0.1 (see docs/deployment.md before changing)
      --tailscale[=print]    private HTTPS over Tailscale; =print changes nothing
      --no-identity         pair even devices signed in as the Tailscale owner
      --lan[=IP|INTERFACE]   pair devices on your network (HTTP cookies can be sniffed)
      --tls-cert FILE       with --lan: HTTPS certificate (also --tls-key FILE)
      --no-remote-chat      paired devices cannot use the agent
      --approve-on-host     paired devices cannot approve agent commands
      --open                also open the board in your browser, with agent settings
      --read-only           no comments or captures from the UI
      --accounts            require local passkey accounts after owner setup (Node 22.13+)
      --accounts-origin URL fixed HTTPS origin (default: loopback URL or --tailscale URL)
      --no-capture          comments allowed, captures only from the CLI
      --buzz-bridge FILE    owner-only existing Buzz conversation (private operator map; docs/buzz.md)
      --allowed-host NAME   extra Host header to accept (repeatable; also $SHAPEWALL_ALLOWED_HOSTS, "*" = any)
      --chat | --no-chat    the board chat with your agent (default on, off when shared beyond this machine)
      --agent-acp "CMD"     chat with an agent CLI over ACP, e.g. "claude-agent-acp" (installed globally)
                            (also $SHAPEWALL_AGENT_ACP; never read from the config; docs/agents.md)
      --allow-remote-agent  with --chat on a shared board, let an ACP agent run anyway (anyone reaching it acts as you)
  devices list              paired devices and pending requests for this project [--json]
  devices approve CODE      approve after matching the code on your device
  devices deny CODE         deny a pending request
  devices revoke ID|--all   revoke a device or all devices immediately
  comments [list]           print comments (feedback for you or a coding agent)
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
                            without --exec, print one JSON line per comment
      --concurrency N       commands at once, 1 to 4 (default 1)
      --recapture           recapture the comment page after a successful --exec (local only)
      --new-only            skip comments that exist when the watch starts
      --once                hand out what is open now, wait for the commands, exit
      --timeout MIN         stop a command after this many minutes (default 60)
      --mention NAME        only comments that mention @NAME, e.g. --mention agent
      --no-claim            hand out every open comment once without claiming it (no agent status, beside other watchers)
                            a command that exits 0 must reply or set a status itself, else the
                            comment becomes needs-human (docs/agent-workflow.md)
  agent run --comment ID    the sandboxed starter agent on one comment: a container with only a fresh
                            worktree, egress to the package registry only (the model is called from here), a branch
      --pr                  also push the branch and open a pull request (GitHub connect); not when it
                            touches CI config, manifests or build files unless --allow-ci-push
      --git-remote NAME     the git remote --pr pushes to (default origin; never from the config)
      --fork-remote NAME    push to your fork (a git remote) instead, and open the PR from it
      --retry               take a comment whose agent status is done or needs-human too
      --trust-comment       run a comment the trigger gate holds back (never a guest's)
      --max-turns N | --max-tokens N | --max-minutes N   budget for this comment
      --max-disk SIZE       disk cap on the checkout (default 2g; the run stops over it)
      --model-timeout S     seconds a model call may take to start answering, 1 to 900 (default 180 for
                            the first call, 60 after; tried once more on a timeout)
      --trusted NAME        may dispatch work (repeatable; adds to starterAgent.trusted)
      --runtime podman|docker   --image NAME   --profile openai-compatible
      --allow-host HOST[:PORT]  extra egress host (repeatable)   --registry HOST|none
      --work-dir DIR        where worktrees go (default: the cache folder)
  agent watch               run the starter agent on each comment the trigger gate lets through   [--once]
  agent doctor              check the runtime, image, model, trust lists and the sandbox itself   [--no-egress]
  agent build-image         build the agent's image from this package's Dockerfile.agent
      --runtime podman|docker   --image NAME (default localhost/shapewall-agent:latest)
                            (docs/starter-agent.md; --remote URL works for run and watch)
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
      --fail-on-change      exit 3 when something changed (default: always 0, never fails the pull request)
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
  ci wait --url URL         wait until a deploy preview answers   [--timeout SECONDS (default 600)]
      --board ID | --json   (docs/pull-requests.md)
  mcp                       MCP server on stdio for coding agents
      --read-only | --no-capture
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
  variant rm ID | variant list
  export                    static read-only copy of the boards
      --include-checks      explicitly include private diagnostic reports
      --out DIR             default shapewall-export
      --no-comments         leave comments out
      --browser-comments    visitors may comment; their comments stay in their own browser
      --noindex             ask search engines not to index the export
  share --remote URL        move local captures, history and comments to a shared project
      --include-checks      explicitly include private diagnostic reports
      --board ID            move only this board (default all)
      --dry-run             show counts; sends nothing
      --no-comments         captures, history and journeys only

Hosted Shapewall (docs/hosted.md)
  login --remote URL        get a project token through the browser; saved for the --remote commands
  push                      upload the latest captures to a hosted project
      --include-checks      explicitly include private diagnostic reports
      --remote URL          the hosted Shapewall (or $SHAPEWALL_REMOTE)
      --board ID            only this board (default: every board)
  comments | watch | mcp --remote URL
                            the same commands against a hosted board (--board ID picks one)
                            token: $SHAPEWALL_TOKEN or --token-file FILE (a project token, swp_...)
                            watch --exec commands get no token unless --pass-token
                            watch and mcp show on the board as an agent, by the token's name
      --include-guests      comments and watch: also share link guests' comments (untrusted)
  hosted                    run the hosted server (accounts, workspaces, pushed boards)
      --data DIR            default ./shapewall-hosted-data (or $SHAPEWALL_HOSTED_DATA)
      --origin URL          public origin, e.g. https://app.example.com (default http://HOST:PORT)
      --port N | --host ADDR   default 4700 on 127.0.0.1
      --signup invite|open  default invite (the first account uses the setup link)
      --trust-proxy         behind a reverse proxy on this host (client IPs from X-Forwarded-For)
      --usercontent-origin URL  serve live HTML only from this other origin (or $SHAPEWALL_USERCONTENT_ORIGIN)
      --previous-origin URL while moving to a new origin: the old one (sign-in moves, up to 30 days)
      --report-email ADDR   where "Report this board" on public projects goes
      --tailscale           on your tailnet through tailscale serve (https://<machine>.<tailnet>.ts.net)
      --tailscale-port N    default 443; --funnel: share links public through Tailscale Funnel
                            (share pages only, never the console), on --funnel-port 8443|443|10000
      --quotas FILE         per-workspace quotas (default <data>/quotas.json when it exists)
      --retention-hours N   prune old versions every N hours (default 6, 0 = off); --retention-keep N (2)
  hosted setup-link         print the first account's one-time link (it is not in the log)
      --data DIR | --new    --new: make a new link (the old one stops working)
  hosted move-origin --to URL   move the server to a new origin (passkeys move with a rebind)
      --data DIR | --days N | --status   window 1 to 30 days (default 30)
  hosted --setup --domain HOST   write a Docker Compose + Caddy folder for your own domain
      --usercontent-domain HOST  live HTML on its own domain; --email (TLS); --dir (./shapewall-hosted)
      --source DIR          a Shapewall checkout to build from; --dry-run; --force; --start (build, start, setup link)
  hosted admin list|suspend|resume|delete|export|reports|retention|log   the operator's commands
  hosted backup --to DIR [--keep-days N]   a consistent copy while the server runs
  hosted restore --from BACKUP --data NEW | --from BACKUP --check (the restore drill)

Global
  --config FILE             default ./shapewall.config.json (or $SHAPEWALL_CONFIG)
  -h, --help | -v, --version   (shapewall <command> --help shows one command)
```
