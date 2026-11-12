# Where to run Shapewall

Shapewall has two shapes. Pick by who needs the board and when, not by how big the site is.

| You are                                         | Run                                                          | Who can open it                      | Always on?                 |
| ----------------------------------------------- | ------------------------------------------------------------ | ------------------------------------ | -------------------------- |
| One person, reviewing your own project          | `npx shapewall serve` in the project, next to its dev server | You, on this machine                 | No: start it when you work |
| One person, also on your phone or second laptop | `npx shapewall serve --tailscale`                            | Your own devices on your tailnet     | No                         |
| A team, or you and your agents around the clock | `shapewall hosted --tailscale` on a machine that stays on    | Everyone you invite, on your tailnet | Yes                        |
| A team with people outside your tailnet         | `shapewall hosted` behind your own domain                    | Everyone you invite, from anywhere   | Yes                        |

The first two are the same local board. The last two are the same hosted server, reached two ways. Nothing about a project changes
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

### Where the work happens

The hosted server never captures a page and never edits code. Those happen on a machine that has the project:

```text
  machine with the code                          hosted server
  ---------------------                          -------------
  shapewall capture   ->  shapewall push  ->     stores the board, shows it to everyone
  agent fixes the code  <-  shapewall watch  <-  a comment someone left
  recapture, push, reply  ->                     the thread shows the fix
```

1. **Sign the machine in once.** `shapewall login --remote https://your-server` shows a code; approve it in the console and choose the
   project. Tick **Take agent work** if this machine should pick up comments.
2. **Push the board.** `shapewall capture`, then `shapewall push --remote https://your-server`. Push again after every capture, or
   from CI.
3. **Let an agent pick up comments (optional).** `shapewall watch --remote https://your-server --exec "<your agent command>"` runs
   your command once per new comment, with the comment's JSON on stdin (`{ "board": ..., "comment": ... }`). The command edits the
   code; a wrapper around it recaptures, pushes and replies. [Agent recipes](agent-recipes.md) has commands for Claude Code, Codex and
   goose.

Each machine that watches is an **agent** of the project, with a name. The board lists them in its Agent panel ("Builder: online",
"Fixer: offline, last seen 2 hours ago") and **Send to agent** on a comment names the one it goes to: the project's default agent on
the button, the others and **Any agent** in its menu. In the console, **Agents** is where an admin names each one, gives it an icon,
picks the default and says who may send it work: a new agent only takes comments from the person who connected it, until they share
it with named members or with everyone the project trusts. [Agents on a hosted board](hosted.md#agents-on-a-hosted-board) has the
whole of it.

While a watching machine is off, comments still save on the server and wait: a comment sent to that agent says "Waiting for Builder
(offline ...)" with **Let any agent take it**. Nothing is lost; nothing is fixed until an agent is back.

### One machine, several projects

`shapewall login` remembers one project for each server. For a second project on the same server, make a token on that project's page
in the console, keep it in a file only you can read, and pass it: `--token-file ~/.config/shapewall/other-project.token` (or
`SHAPEWALL_TOKEN`). A watcher that runs as a service should use a token file of its own, so a later `login` cannot change what it
talks to. Each token is its own agent on its project's board, so one machine can be "Builder" in one project and "Docs bot" in
another; the workspace's **Agents** page lists them all.

## Which one should I start with?

Start local. It takes four commands and nothing to maintain. Move to the hosted server when one of these is true:

- someone else needs to comment, and a share link or a screenshot is not enough;
- you want to leave comments from anywhere and have an agent on another machine act on them;
- the board should be there when your laptop is closed.

`shapewall share --remote https://your-server` moves a local project's captures, history and comments to a hosted project in one go
([Move a local project to your team](hosted.md#move-a-local-project-to-your-team)).
