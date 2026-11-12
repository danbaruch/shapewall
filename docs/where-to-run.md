# Where to run Shapewall

Shapewall has two shapes. Pick by who needs the board and when, not by how big the site is.

| You are                                         | Run                                                          | Who can open it                      | Always on?                 |
| ----------------------------------------------- | ------------------------------------------------------------ | ------------------------------------ | -------------------------- |
| One person, reviewing your own project          | `npx shapewall serve` in the project, next to its dev server | You, on this machine                 | No: start it when you work |
| One person, also on your phone or second laptop | `npx shapewall serve --tailscale`                            | Your own devices on your tailnet     | No                         |
| A team, or you and your agents around the clock | `shapewall hosted --tailscale` on a machine that stays on    | Everyone you invite, on your tailnet | Yes                        |
| The same, with no passkeys to set up            | `shapewall hosted --tailscale --tailnet-sign-in`             | Tailnet users you invite by login    | Yes                        |
| A team with people outside your tailnet         | `shapewall hosted` behind your own domain                    | Everyone you invite, from anywhere   | Yes                        |

The first two are the same local board. The others are the same hosted server, reached in different ways. Nothing about a project changes
when you move between them: the config, the captures and the comments are the same files.

## The local board

```sh
npx shapewall doctor --install-browser
npx shapewall init --base-url http://localhost:3000
npx shapewall capture
npx shapewall serve --open
```

It lives in the project folder, runs while you work and stops when you close it, like a dev server. Captures, comments and agent fixes
all happen on this machine. There is no account and nothing to host. Details: [Running and sharing a board](deployment.md).

To use the same board from your phone, add `--tailscale`: Shapewall asks Tailscale to serve it at this machine's private HTTPS name,
and your other devices pair once. See [Your own other devices](deployment.md#your-own-other-devices-local-mode).

Working on several projects? Each one has its own board on its own port, and the site dropdown switches between the ones that are
running. See [Several local projects](deployment.md#several-local-projects).

## The hosted server

```sh
shapewall hosted --data ./hosted-data --tailscale
```

One server for all your projects: passkey accounts, workspaces, invites, roles, share links and live presence. It runs on any machine
that stays on: a spare computer at home, a server in the office, a small cloud machine. It needs Node 22.13 or newer and little else:
it stores and serves boards, and runs no browser and no agent. The full guide is [the hosted operator guide](hosted.md).

**Tailscale is the recommended way to reach it.** With `--tailscale` the server gets a private HTTPS address on the machine's tailnet
name, with a real certificate and nothing open to the internet. Add `--funnel` to make only guest share links public while the console
and sign-in stay private. When people outside your tailnet need accounts, put the server behind your own domain instead:
`shapewall hosted --setup --domain app.example.com` writes a Docker Compose and Caddy folder for that
([Own domain deployment](hosted.md#own-domain-deployment-mode-2)).

### How people sign in

| Where it runs                | Sign-in                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| Local board                  | None. It is yours, on your machine                                                    |
| Tailnet, `--tailnet-sign-in` | Your tailnet login. No passkey, no password. An admin invites each login, with a role |
| Tailnet, passkeys            | A passkey each                                                                        |
| Own domain                   | A passkey each                                                                        |

On the hosted server, being signed in with the right role is enough for everything in a workspace. A few things always ask for a
passkey (your passkeys and recovery codes, deleting an account or a workspace, changing owners, moving the server), and a
workspace's owner can switch on more in Settings. Details: [Signing in](hosted.md#signing-in).

With tailnet sign-in the server believes Tailscale's identity headers only on requests that provably came through the serve
entry it made (a secret path, a connection owned by tailscaled, tailscaled's own whois), never on direct loopback requests,
raw forwards or Funnel traffic, never for a request from the server's own machine (use a passkey or another device there),
and each tailnet login is its own account: being on the tailnet alone puts nobody in a
workspace. It needs Linux, Tailscale 1.98 or newer in its normal (TUN) mode, and a server that is not in a container. A
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
shapewall admin projects create "My site" --remote https://board.example.ts.net
shapewall login --remote https://board.example.ts.net                        # no code, no browser
shapewall capture && shapewall push --remote https://board.example.ts.net
shapewall admin invites create --login ben@example.com --role admin --remote https://board.example.ts.net
```

Needs a browser: nothing now. Later, adding a passkey, for the few things that always ask for one (a first passkey can confirm
them 24 hours after it is added, so add it early).

A member, on their own tailnet machine, after an admin invited their login:

```sh
shapewall join --remote https://board.example.ts.net                         # takes the invite; the role is the invite's
shapewall agent connect --remote https://board.example.ts.net --project my-site --name "Builder"
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
   request is opened when that machine has the remote and GitHub connect; otherwise the thread names the branch. A connected
   Claude Code runs no commands from the board, so a fix is not built, tested or recaptured for you: `watch --exec` stays the way
   for that. [Edits from the board](hosted.md#edits-from-the-board-the-trust-decision) has the details.

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

Start local. It takes four commands and nothing to maintain. Move to the hosted server when one of these is true:

- someone else needs to comment, and a share link or a screenshot is not enough;
- you want to leave comments from anywhere and have an agent on another machine act on them;
- the board should be there when your laptop is closed.

`shapewall share --remote https://your-server` moves a local project's captures, history and comments to a hosted project in one go
([Move a local project to your team](hosted.md#move-a-local-project-to-your-team)).
