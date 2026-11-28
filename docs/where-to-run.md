# Where to run Shapewall

Shapewall has one engine in two shapes: on your machine for one project, or on a server for a team. Start alone, and invite
people when you are ready. Pick by who needs the board and when, not by how big the app is.

| You are                                         | Run                                                          | Who can open it                      | Always on?                 |
| ----------------------------------------------- | ------------------------------------------------------------ | ------------------------------------ | -------------------------- |
| One person, building with an agent              | `npx shapewall serve` in the project, next to its dev server | You, on this machine                 | No: start it when you work |
| The same, with a few people invited             | `npx shapewall serve --team` (or Invite people)              | You, and tailnet users you invite    | No: while it runs          |
| A team, or you and your agents around the clock | `shapewall hosted --tailscale` on a machine that stays on    | Everyone you invite, on your tailnet | Yes                        |
| The same, with no passkeys to set up            | `shapewall hosted --tailscale --tailnet-sign-in`             | Tailnet users you invite by login    | Yes                        |
| A team with people outside your tailnet         | `shapewall hosted` behind your own domain                    | Everyone you invite, from anywhere   | Yes                        |

The first two are the local board: the solo engine, the hosted server's engine run for one project on your own machine, alone
or with the people you invite. The last three are the same hosted server, reached in different ways. Moving between the local
board and a hosted server changes nothing about the project's config: `shapewall push` sends captures to a server. Coming from
1.x? The first `shapewall serve` of 2.0 moves the project's board into the engine, with a backup first
([upgrading from 1.x](upgrading.md)).

## The local board

```sh
npx shapewall doctor --install-browser
npx shapewall init --base-url http://localhost:3000
npx shapewall capture
npx shapewall serve --open
```

It lives in the project folder, runs while you work and stops when you close it, like a dev server. Captures, comments and agent fixes
all happen on this machine. There is no account to make and nothing to host. Details: [Running and sharing a board](deployment.md).

`serve` runs the solo engine: the same engine as the hosted server, for one project and one owner, on this machine only, with its
data in `.shapewall/.engine/` ([the solo engine](#the-solo-engine-experimental)). `serve --open` signs the browser in from the terminal.
`shapewall capture` writes into the engine's board folder, and `comments`, `watch` and `mcp` in the project folder go to the engine
(and start it for themselves when it is not running). When you want other people on the board, turn on
[team mode](#inviting-people-to-the-engine): the same board, nothing copied.

### Upgrading a 1.x project

The first `shapewall serve` of 2.x in a project that has 1.x board data in `.shapewall/` moves that data into the engine, then starts:

1. It says which boards move and where the backup goes.
2. It runs `shapewall migrate`: a full backup in `.shapewall/backup-1x-<time>/` (hard links where it can), then the comments, replies,
   reactions, images, drawings and chat threads become engine rows, and the captures, history, variants, journeys and checks move as
   they are. `.shapewall/MIGRATED-TO-2` records the run. A run that fails puts the folder back as it was.
3. It starts the engine. Later starts find nothing to move.

`shapewall migrate --dry-run` shows the same plan without changing anything, and `shapewall migrate --rollback` puts the folder back
from the backup (run the old version pinned afterwards: `npx shapewall@1 serve`). Paired devices are not moved: they sign in again.
Anything that would stop the move (a 1.x `serve` or `watch` still running for the project, a migration that was stopped midway, a board
the engine cannot take yet) stops `serve` with the reason, and nothing changes.

Once a board has moved, the 1.x writers refuse it: a `shapewall mcp`, `watch` or starter agent started before the move, and the 1.x
server. Once the engine holds the project (after the move, or in a project whose first board was the engine's):

- `comments`, `watch`, `mcp` and `export` go to the engine. When no `shapewall serve` runs, they start the engine for
  themselves, on this machine only and without the project's agent, and stop it when they end, so an agent's `shapewall mcp`
  works with or without `serve` running. A running engine is used, never a second one on the same data.
- `capture`, `links`, `push`, `journeys`, `variant` and `checks` work on the engine's board folders
  (`.shapewall/.engine/files/`), running or not.
- `export` writes the engine's comments and their images (through its token API) next to its captures; `--no-comments` exports
  the captures only.
- `github` opens issues and links pull requests for the engine's comments, as on a 1.x board.
- `share --remote` refuses an engine board. To bring people to it, run `shapewall serve --team`: the same board on your tailnet,
  nothing copied. Moving an engine board to a team server is not in 2.0.
- `comments add --selector` and `comments selectors` read the engine's latest captures.

`SHAPEWALL_ENGINE=legacy` puts every command back on the 1.x files (deprecated).

The stable surfaces keep their 1.x shapes on the engine: the comment JSON of `comments --json`, `watch` and `watch --exec`, the MCP
tools and their arguments (the `author` of `reply_to_comment` and `add_comment`, and `comments reply --author`, label the agent's
text, which stays marked as an agent's), and the lines of `.shapewall/events.jsonl`.

**The 1.x board server** stays through 2.x as a deprecated escape hatch, removed in 3.0: `shapewall serve --engine legacy`, or
`SHAPEWALL_ENGINE=legacy` for a service or a script. A flag only the 1.x server has (`--host`, `--lan`, `--tailscale`, `--tls-cert`,
`--accounts`, `--agent-acp`, `--allowed-host`, `--buzz-bridge` and the device flags) also runs it, with the same warning, so
`serve --host 0.0.0.0` in a container keeps working. With `SHAPEWALL_ENGINE=legacy`, `capture` writes the 1.x board folders again.

`serve --tailscale` (your own other devices, paired once) is one of those 1.x-only flags: it runs the deprecated 1.x server. See
[Your own other devices](deployment.md#your-own-other-devices-local-mode). On the engine, the tailnet way in is team mode.

Working on several projects? Each one has its own board on its own port, and the board switcher switches between the ones that are
running. See [Several local projects](deployment.md#several-local-projects).

## The solo engine (experimental)

**Experimental.** Outside the [stability promise](stability.md): it can change, or go, in a minor release.

```sh
npx shapewall migrate --dry-run         # optional: what an existing 1.x .shapewall/ would bring along
npx shapewall serve --open              # the engine; a 1.x project moves in on the first start
```

`serve` (also `serve --engine hosted`) runs the hosted server's engine for this one project, on this machine, for you alone: one owner with no
passkey (a one-time sign-in page from the terminal), on 127.0.0.1 at `http://<project>-<random>.shapewall.localhost:<port>`, with its
data in `.shapewall/.engine/`. The board is the hosted board, and the work that a team server leaves to your machine happens in the
engine itself: "Capture now", page checks, journeys made on the board, environments and compare, batch fixes and installation
updates. The project's agent runs as a connected agent (`shapewall agent connect --as local`) on the same link a team server's
agents use, so the chat, Fix with and Send to agent go through one protocol whether the board is on your machine or a server. While
it runs, `shapewall comments`, `watch` and `mcp` in the project folder go to it. It has been the default since 2.0 (opt-in in 1.5.0).

`shapewall migrate` (experimental) moves an existing project's `.shapewall/` (captures, versions, environments, journeys,
comments, chat threads, a `serve --accounts` owner) into the engine, after a hard-link backup; `shapewall migrate --rollback` puts
it back. The first `serve` runs it for you. After a migration the 1.x server and the 1.x writers refuse the boards that moved. A
project with no `.shapewall/` yet needs no migration: start the engine and capture.

The engine is the hosted server's code (`src/hosted`), so it is under the hosted server's license, not the core's: the
[Functional Source License 1.1, ALv2 future license](../src/hosted/LICENSE.md). Anyone may use, change and run it, at work too;
what it does not allow is offering it as a competing hosted service, and each release becomes Apache 2.0 two years after it ships.
The CLI, capture, the MCP server, the deprecated 1.x board server and the migration planner, backup and rollback stay Apache 2.0.

### Inviting people to the engine

`shapewall serve --team`, or **Invite people** on the console's Members page, puts the same engine on your tailnet for the people
you invite: `tailscale serve` with tailnet sign-in, the same data, nothing copied, and you stay the owner. `shapewall serve --team
off` (or **Stop sharing**) puts it back on this machine only. Every start prints exactly who can reach the board. It is never on
the public internet: for that, run a team server on your own domain. The board is there only while the engine runs, so a team
that needs it around the clock wants a team server on a machine that stays on.
Details: [team mode](hosted.md#inviting-people-team-mode).

Every detail (sign-in, tokens, the board's own agent, capturing, what it refuses): [the solo engine](hosted.md#the-solo-engine-experimental).

## The hosted server

```sh
shapewall hosted --data ./hosted-data --tailscale
```

One server for all your projects: passkey accounts, workspaces, invites, roles, share links and live presence. It runs on any machine
that stays on: a spare computer at home, a server in the office, a small cloud machine. It needs Node 22.19 or newer and little else:
it stores and serves boards, and runs no browser and no agent. The full guide is [the hosted operator guide](hosted.md).

**Tailscale is the recommended way to reach it.** With `--tailscale` the server gets a private HTTPS address on the machine's tailnet
name, with a real certificate and nothing open to the internet. Add `--funnel` to make only guest share links public while the console
and sign-in stay private. When people outside your tailnet need accounts, put the server behind your own domain instead:
`shapewall hosted setup --domain app.example.com` writes a Docker Compose and Caddy folder for that
([Own domain deployment](hosted.md#own-domain-deployment-mode-2)).

### How people sign in

| How you reach it             | Sign-in                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| Local board                  | From the terminal (`serve --open`), no account to make; team mode: tailnet sign-in         |
| Over an SSH tunnel           | A local board: as if you sat at that machine. A hosted server: a passkey each              |
| Tailnet, `--tailnet-sign-in` | Your Tailscale account, on every tailnet device of yours. No passkey. An admin invites you |
| Own domain                   | A passkey each                                                                             |

On the hosted server, being signed in with the right role is enough for everything in a workspace. A few things always ask
(deleting an account or a workspace, changing owners): for a passkey where passkeys are the sign-in, and for a typed name on
a tailnet sign-in server, where Tailscale is the only sign-in and the tailnet is the trust boundary (anything running as you
on one of your tailnet devices can act as you; lock your devices and keep the tailnet to people and machines you trust). A
tailnet server can also allow passkeys (`--tailnet-passkeys`). Details: [Signing in](hosted.md#signing-in).

### Over SSH

No Tailscale? Tunnel one port over SSH.

```sh
shapewall hosted --data ./hosted-data --port 4700 --origin http://shapewall.localhost:4700   # on the server; loopback, no TLS
ssh -L 4700:127.0.0.1:4700 you@server                                                     # on your machine
# then open http://shapewall.localhost:4700
```

A hosted server reached this way uses passkey accounts. `shapewall.localhost` is a name browsers send to your own machine and
treat as a secure context, so passkeys work, and it keeps the server's cookies to itself; plain `http://localhost:4700` works
too, but there the session cookie is also sent to any other web server on your machine's localhost. Everyone who tunnels in
shares `127.0.0.1` for rate limits and in the audit log. A local board reached this way (`shapewall serve` on the remote
machine, the same kind of tunnel) sees you as the person at that machine: no sign-in, and so not something to tunnel for
other people. More: [Over SSH](hosted.md#over-ssh).

With tailnet sign-in the server believes Tailscale's identity headers only on requests that provably came through the serve
entry it made (a secret path, a connection owned by tailscaled, tailscaled's own whois), never on direct loopback requests,
raw forwards or Funnel traffic, never for a request from the server's own machine (use a passkey or another device there),
and each tailnet login is its own account: being on the tailnet alone puts nobody in a
workspace. It needs Linux, macOS (Standalone Tailscale app) or Windows, Tailscale 1.98 or newer in its normal (TUN) mode, and a
server that is not in a container. A
tailnet identity is per device, not per person: anything running as you on a tailnet device of yours can act as you there.
See [Tailnet sign-in](hosted.md#tailnet-sign-in).

### From your coding agent

On a server with tailnet sign-in, a terminal or a coding agent on a tailnet machine needs no browser: the server knows the
machine's tailnet user.

An owner, from nothing to a first project. On the machine that runs the server (the data folder is the proof; `--login`
says whose server it is):

```sh
shapewall hosted --data ./hosted-data --tailscale --tailnet-sign-in &
shapewall hosted claim --data ./hosted-data --login ada@example.com --workspace-name "Team"   # no browser
```

Then on another tailnet device of the owner's (the server's own machine is never signed in by its tailnet identity):

```sh
shapewall admin projects create "My app" --remote https://board.example.ts.net
shapewall login --remote https://board.example.ts.net                        # no code, no browser
shapewall capture && shapewall push --remote https://board.example.ts.net
shapewall admin invites create --login ben@example.com --role admin --remote https://board.example.ts.net
```

Needs a browser: nothing now. Later, adding a passkey, for the few things that always ask for one (a first passkey can confirm
them 24 hours after it is added, so add it early).

A member, on their own tailnet machine, after an admin invited their login:

```sh
shapewall join --remote https://board.example.ts.net                         # takes the invite; the role is the invite's
shapewall agent connect --remote https://board.example.ts.net --project my-app --name "Builder"
```

Needs a browser: nothing for an admin, unless the workspace switched on "Approve command line logins in the browser" (then the
code, the browser and a passkey). A member or viewer may not connect a machine by themselves: `agent connect` shows a code
for an admin to approve, as on any server.

On a server without tailnet sign-in these commands change nothing: `login` and `agent connect` use the code and the browser,
`join` says an account needs a passkey (made in the browser), and `admin` points at the console. The rules, and every refusal:
[From your coding agent](hosted.md#from-your-coding-agent).

### Where the work happens

The hosted server never captures a page and never edits code. Those happen on a machine that has the project:

```text
  machine with the code                          hosted server
  ---------------------                          -------------
  shapewall capture   ->  shapewall push  ->     stores the board, shows it to everyone
  agent fixes the code  <-  shapewall watch  <-  a comment someone left
  recapture, push, reply  ->                     the thread shows the fix
  agent reads the code  <-  shapewall agent connect  <-  a question in the board's chat
  the answer, as it is written  ->               everyone with the thread open sees it
  agent edits a fresh copy  <-  agent connect --approvals  <-  "Fix with Builder" on a comment
  each edit, as a diff  ->                       a person allows or denies it on the board
  tests, builds, its own browser  ->             a card where the turn needs one
  a new branch, a pull request  ->               the thread shows where the fix is
```

1. **Sign the machine in once.** `shapewall login --remote https://your-server` shows a code; approve it in the console and choose the
   project. Tick **Take agent work** if this machine should pick up comments.
2. **Push the board.** `shapewall capture`, then `shapewall push --remote https://your-server`. Push again after every capture, or
   from CI.
3. **Let an agent pick up comments (optional).** `shapewall watch --remote https://your-server --exec "<your agent command>"` runs
   your command once per new comment, with the comment's JSON on stdin (`{ "board": ..., "comment": ... }`). The command edits the
   code; a wrapper around it recaptures, pushes and replies. [Agent recipes](agent-recipes.md) has commands for Claude Code, Codex and
   goose.

4. **Chat with your coding agent on the board (optional).** `shapewall agent connect --remote https://your-server`, run in the
   project's folder, connects that machine's Claude Code. An admin approves it in the console (a name, an icon, who may use it),
   and members then ask it questions from the board's Agents panel. By default it reads the project and answers; it does not
   change files or run commands from the board. Codex, goose and Gemini CLI are not offered by `agent connect` in this
   release: for them, `watch` is the way. Leave it running, or run it as a service.
   [Connected agents](hosted.md#connected-agents) has the details.

5. **Let it make fixes from the board (optional).** Edits are switched on only on the machine that has the code:
   `shapewall agent connect --remote https://your-server --approvals owner`. **Fix with Builder** on a comment then starts a fix
   there. The work happens on that machine, never on the server and never in the checked-out tree: the agent edits a fresh copy
   of the base commit in a folder outside the project, each edit shows on the board as a card with the full diff that you allow
   or deny, and Shapewall commits what was allowed on a new branch (`shapewall/comment-<n>-...`). The branch is pushed and a pull
   request is opened when that machine has the remote and GitHub connect; otherwise the thread names the branch.
   [Edits from the board](hosted.md#edits-from-the-board-the-trust-decision) has the details.

6. **Let it test its fixes (optional).** The project's named commands (config [`commands`](config.md#commands): `test`,
   `build`, `dev`, `lint`), a sandboxed shell and a throwaway browser are lines the same machine switches on
   (`shapewall agent set shell sandboxed --remote https://your-server`, and `browser on`). They run on that machine through
   Shapewall's own tools, never the agent's shell, in an OS sandbox where there is one (bubblewrap on Linux, Seatbelt on macOS).
   Each command waits for a card on the board; on your own fixes (an agent only you use) they can run without one
   (`agent set command-approval tier`). The server can take
   them away, never add them. [What an agent can do](agent-capabilities.md) has every line.

Each machine that watches or connects is an **agent** of the project, with a name. The board lists them in its Agent panel ("Builder: online",
"Fixer: offline, last seen 2 hours ago") and **Send to agent** on a comment names the one it goes to: the project's default agent on
the button, the others and **Any agent** in its menu. In the console, **Agents** is where an admin names each one, gives it an icon,
picks the default and says who may send it work: a new agent only takes comments from the person who connected it, until they share
it with named members or with everyone the project trusts. [Agents on a hosted board](hosted.md#agents-on-a-hosted-board) has the
whole of it.

While a watching machine is off, comments still save on the server and wait: a comment sent to that agent says "Waiting for Builder
(offline ...)" with **Let any agent take it**. Nothing is lost; nothing is fixed until an agent is back. Chat does not wait: a
connected agent that is offline says so, and takes no message until it is back. A fix cannot be asked of an offline agent either.

### One machine, several projects

`shapewall login` remembers one project for each server. For a second project on the same server, make a token on that project's page
in the console, keep it in a file only you can read, and pass it: `--token-file ~/.config/shapewall/other-project.token` (or
`SHAPEWALL_TOKEN`). A watcher that runs as a service should use a token file of its own, so a later `login` cannot change what it
talks to. Each token is its own agent on its project's board, so one machine can be "Builder" in one project and "Docs bot" in
another; the workspace's **Agents** page lists them all.

`shapewall agent connect` keeps a token of its own for each server, apart from the login, and serves the project whose folder it
runs in. For a second project on the same server, run it in that project's folder with `--as NAME` (its own approval, its own token).
One process holds an agent's link: a second `agent connect` on the same token is refused, unless it is started with `--takeover`.

## Which one should I start with?

Start local. It takes four commands and nothing to maintain. Coming from 1.x, keep the migration's backup until you are sure
(`shapewall migrate --rollback` puts the 1.x board back; [upgrading from 1.x](upgrading.md)). When a few people should see the
board while you work, turn on team mode (`shapewall serve --team`). Move to the hosted server when one of these is true:

- people need the board when your laptop is closed;
- someone outside your tailnet needs an account;
- you want agents on other machines to act on comments around the clock.

`shapewall share --remote https://your-server` moves a 1.x local project's captures, history and comments to a hosted project in
one go ([Move a local project to your team](hosted.md#move-a-local-project-to-your-team)). It refuses a board the solo engine
holds.
