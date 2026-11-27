# What an agent can do on a board

Every turn an agent takes on a board is decided by one set of rules on the machine that runs the agent: which tools it gets,
whether a command runs at once or waits for a person, whether it has a shell and a browser. The same rules cover a local board's
chat, a connected agent's chat and Fix with on a hosted board, a comment it picks up, `watch --exec` and the starter agent. This
page is how they work and how to change each line. The threat detail behind them is in the
[agent hardening guide](agent-hardening.md#what-each-turn-may-do).

Three things hold everywhere:

- **Who wrote the turn decides the tier**, not whether the board is local or hosted.
- **The machine sets the ceiling.** A hosted server's project setting can lower it, never raise it.
- **Unknown means narrowest.** A setting this version cannot read, a missing trust block or a missing sandbox reads as the
  narrowest choice for that line.

## Three tiers

| Tier     | Who wrote the text that reaches the turn                                               | How a turn gets it                                                                                        |
| -------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **solo** | Only you: the person who connected the agent, or a local board's owner                 | The agent's audience is only you (**Only me** on the server, or `--audience owner`), and you wrote it all |
| **team** | Only people on your machine's trusted list, and you                                    | Your machine names a team (`trust-team`), and every author is on it                                       |
| **open** | Anyone else, a share-link guest, or a turn the server's trust block does not vouch for | Every other turn                                                                                          |

The tier is worked out for each turn from the authors the server names (from stored account ids, never display names), and the
machine checks them against its own lists. An author is everyone whose text reaches the turn: the people who wrote its messages,
the thread's comment and its replies, and every comment a message mentions (an `@comment`, an element, or the open comments an
`@person` mention brings in). Mention someone else's comment in your own chat and that turn is theirs too, so it is not solo. The
tier and the thread's own trust (below, under Extensions) are worked out from that same list, so the two cannot disagree.

A thread keeps what it carried: an author whose message was later pruned or removed still counts, and a thread that once carried
text nobody can vouch for (another agent's answer, a move to another agent, a token's or an imported comment, a thread from before
1.4.0) is open from then on. Deleting the thread starts a new one, and the machine starts the agent's session afresh for it; a
session is also never reused across tiers, so an open turn's text never carries into a solo or team turn.

On solo and team turns, comments by people outside the tier are counted in the board context, not quoted, so one quoted comment
cannot steer a shell. The machine checks mentions itself too: on a turn above open, a mentioned comment by anyone the tier was not
worked out from is shown by its number only, and an `@person` mention's open comments by others are counted, never quoted.
Captured page text is still quoted as untrusted data.

Solo on a connected agent needs the agent's audience to be only you. With `--audience server` (the default) the machine takes that
audience from the server, and every author must still be the account this machine pinned as yours when it connected: the
server's word alone never makes someone else's turn solo. `--audience owner` makes it this machine's own rule as well, and the
machine then refuses any turn whose asker is not that pinned account, whatever the server labels it.

A local board has no team tier. A turn there is solo only while every word in it is the owner's (the owner is whoever holds
the settings link, a paired device or the tailnet owner): a private chat, or a comment the owner wrote on a board only the owner
can reach. A message that mentions a comment someone else wrote (or one that got someone else's reply since) makes the turn
open. On a solo turn the agent's board tools list and read only the owner's own comments and count the rest. A thread that ever
carried someone else's text is open from then on, and so is a thread from before 1.4.0: start a new chat to get solo back. Anything else is open, including other signed-in local accounts and share visitors. A display name never counts.

## What each tier gets

What each tier may get once the machine allows it. On a local board these are the defaults; a connected agent starts with none of
them ([below](#a-local-board-and-a-connected-agent)).

| Line                                                  | solo                                                          | team                                           | open              |
| ----------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------- | ----------------- |
| Instructions (`CLAUDE.md`, `AGENTS.md`)               | on                                                            | on                                             | on                |
| Read tools                                            | on                                                            | on                                             | on                |
| Edits                                                 | in a fix copy, each checked on the machine                    | the same                                       | the same          |
| Named commands (config `commands`)                    | run, asked again when the command or its inputs change        | the same                                       | each after a card |
| Shell                                                 | a full shell in the fix copy, inside an OS sandbox            | no full shell, unless `trust-team-shell` is on | no full shell     |
| Browser                                               | a throwaway headless one, limited to the app's own addresses  | the same                                       | the same          |
| Logged-in browser (`browser-auth`, `browser-profile`) | opt-in                                                        | opt-in (`browser-profile-team`)                | never             |
| Extensions (Claude Code's restricted session only)    | on if there is an agent config folder and the thread is clean | only if every author is in `extensions-for`    | never             |
| Memory                                                | automatic memory off; a memory tool only by its exact name    | off                                            | off               |
| Push and pull requests                                | a card                                                        | a card                                         | a card            |
| Editing its own instructions, your own Chrome         | never                                                         | never                                          | never             |

Two rules sit on top of the table:

- **A full shell, or a command that changes files, is an edit power.** Neither is on where edits are off. A connected agent whose
  machine takes no edits (`--approvals none`, the default) reads and answers only, on every tier.
- **Without an OS sandbox there is no full shell.** On Windows, or Linux without bubblewrap, every named command waits for a card,
  and the Shell line says why.

## Where the rules apply

| Path                                 | What it gets                                                                                                                                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A local board's chat, Claude Code    | A restricted session: read and edit tools plus Shapewall's tools for commands, the shell and the browser. No shell of its own, no `~/.claude` settings, hooks, plugins or `.mcp.json`, no auto memory                       |
| A local board's chat, other ACP CLIs | Their own session and tools, as in 1.2.0 ([restrict the agent's own tools](agents.md#restrict-the-agents-own-tools))                                                                                                        |
| A local board's chat, an endpoint    | Shapewall's tools for commands and the browser beside the board tools                                                                                                                                                       |
| A connected agent's chat             | Answers only: no edits, no shell; on solo turns, commands marked `"mutating": false` and the browser                                                                                                                        |
| A comment sent to a connected agent  | Answers only: commands that change no files (on a read-only view of the checkout) and the browser                                                                                                                           |
| Fix with on a connected agent        | Edits in a fix copy, named commands, the shell and the browser, per tier                                                                                                                                                    |
| `watch --exec`                       | `SHAPEWALL_CAPABILITIES_FILE`, a `0600` JSON file with the comment's capabilities. Not enforced: your command's own sandbox is the boundary ([agent workflow](agent-workflow.md#shapewall-watch-the-loop-closes-by-itself)) |
| The starter agent                    | Team or open from the trigger gate; named commands and the browser inside its container ([starter agent](starter-agent.md))                                                                                                 |

`agent.localSession: "own"` (a local board's 1.2.0 Claude Code session, with its own full tool set) was removed in 2.0: the config
refuses it with a one-line error. Leave the key out.

## A local board and a connected agent

**A local board** reads its settings from the project's entry in `agents.json` (Settings > Agents, or `shapewall agent set` in the
project folder). With nothing set, solo turns get the sandboxed shell, named commands without a card and the browser; open turns
get a card for each command. Its owner answers its cards on the board.

**A connected agent** reads `agent-policy.json` on its machine, one entry per server and `--as` name. A key the entry does not name
reads as what 1.3.0 allowed: no shell, no browser, a card for every command. Each wider line is a key you set. For a connected agent
that runs your project's tests in the OS sandbox on your own fixes, without a card:

```sh
shapewall agent connect --remote https://wall.example.com --audience owner --approvals owner   # once: solo turns, edits on
shapewall agent set shell sandboxed --remote https://wall.example.com
shapewall agent set command-approval tier --remote https://wall.example.com
shapewall agent set browser on --remote https://wall.example.com
shapewall agent connect --remote https://wall.example.com                                       # connect again to use them
```

Then add the commands to `shapewall.config.json` ([Commands](config.md#commands)). A turn someone else wrote stays open: each
command there waits for a card.

## Named commands

The config's `commands` names what an agent may run: `test`, `build`, `dev`, `lint` and up to 20 of your own, each one command
line run without a shell. The agent runs one with `run_named_command { name }` (and `args` only where the line says
`"args": true`); it never gets the line from its own copy of the project, only from your checkout.

```json
{
  "commands": {
    "test": { "run": "npm test", "inputs": ["package.json", "package-lock.json", "test/**"] },
    "dev": { "run": "npm run dev -- --port $PORT", "ready": "http://127.0.0.1:$PORT" },
    "lint": { "run": "npm run lint", "mutating": false }
  }
}
```

- **Solo and team, in the OS sandbox:** a command runs without a card while it and its inputs are as you approved them. The
  approval is kept on the machine for that exact line, the tier, the sandbox mode, the network and the content of its inputs (the
  manifests, lockfiles, `.npmrc` and every `*.config.*` file always among them, every byte of each). When the agent changes an
  input, or the line changes, the next run asks again. A command with more inputs than Shapewall checks asks every time.
- **A local board in place** (edits land in your checkout itself) gets no commands, no shell and no ACP terminal: turn on Work
  on a branch, and commands run in the branch copy.
- **On macOS, an agent that edits cannot run commands in 1.4.0:** no commands, no shell and no ACP terminal on any tier, since
  Shapewall cannot check there where a file write lands once a command has run. The one exception is a solo owner's
  `agent set shell-unsandboxed on` shell, an opt-in that already runs outside every check, with its warning. Read-only turns
  keep their read-only commands in the OS sandbox.
- **Network:** a command gets the package registries (where `shell-network` says so) on your own solo turns only; on team turns
  it gets no network, since a registry takes uploads too.
- **Open turns, or no OS sandbox:** each run waits for a card. That answer is for one run and is never kept.
- **`command-approval always`** makes every run on every tier wait for a card.
- **`dev`** starts with `start_dev_server { name }` on a free port (`$PORT`), checked at its `ready` URL, stopped with
  `stop_dev_server` or when the turn ends. Its port joins the agent's browser for that session only.
- **Files a command changed** (a formatter, a snapshot update) hold the fix on the machine until someone sees its whole diff.

Every key of a command line is in the [config reference](config.md#commands).

## The shell

On solo turns (and team turns with `trust-team-shell on`) the agent gets `run_command { command, reason }`: a shell command line
in the fix copy, inside the OS sandbox. On other turns `run_command` takes only one of the machine's exact commands, each after a
card. Exact commands are not offered in this release: `--allow-command` and `agent set allow-command` are refused (only `none`,
which empties a saved list, is taken), so there it takes none.

The OS sandbox is bubblewrap on Linux and Seatbelt on macOS, through the open-source sandbox runtime. A command in it writes only
in the fix copy and its own tmp folder, cannot read your home folder, `~/.ssh`, `~/.config` or your agent's settings, gets a clean
environment with no `SHAPEWALL_*` tokens, reaches only the package registries on solo turns (nothing on team turns), and stops
after 10 minutes with its output capped at 64 KB. On Linux with a systemd user manager each command runs in a scope of its own,
capped for memory, processes and CPU together. A card shows the whole command line; one too long to show whole is refused. On Linux it needs `bubblewrap`, `socat` and `ripgrep` (and `nsenter` for dev servers). The full list of
what it holds is in [commands through Shapewall](agent-hardening.md#commands-through-shapewall).

| Setting             | Values                         | What it does                                                                                      |
| ------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `shell`             | `sandboxed`, `commands`, `off` | `sandboxed`: the full shell on solo turns. `commands`: named and exact commands only. `off`: none |
| `shell-network`     | `registries`, `none`           | Where commands may connect: the package registries, or nowhere                                    |
| `trust-team-shell`  | `on`, `off`                    | The full shell on team turns too                                                                  |
| `shell-unsandboxed` | `on`, `off`                    | Solo only: a full shell where there is no OS sandbox. The Shell line says so                      |
| `command-approval`  | `tier`, `always`               | `tier`: as in the table above. `always`: a card for every run                                     |

**Tests run the agent's code.** The sandbox limits what a command touches. The code it runs may be code the agent wrote: `npm test` runs the
project's tests, and the agent can edit those. Read the result as the agent's, and review the fix before it leaves your machine.

## The browser

With the Browser line on, the agent checks its work in its own headless Chromium: `browser_navigate`, `browser_screenshot`,
`browser_click`, `browser_type`, `browser_text`, `browser_console` and `browser_close`. Shapewall starts it on first use and
removes it, profile and all, when the task ends.

- **It opens only the app's addresses:** every `baseUrl` and `publicUrl` in your config, the origins the machine allows
  (`browser-allow`, and the config's `agent.browser.allow` where the machine allows them too), and the session's own dev server.
  Every request and connection is checked by Shapewall, not by the model.
- **An address on your machine** that a committed config names (loopback, `localhost`, a local name such as `app.test`, this
  machine's LAN or tailnet address) counts below your own solo turn only where `browser-allow` lists that exact origin, or it is
  the session's dev server. A public name that resolves to this machine is refused there. The Browser line names what it held
  back and the command that lists it.
- **No debugging port,** no service workers, no downloads, no `file:` or `data:` pages, and never your own Chrome or its profile.
- **A login** only where the tier allows it: a recorded one (`browser-auth NAME`, from `shapewall auth record`) or a profile
  Shapewall made for the agent (`--browser-profile NAME`, kept in `$XDG_STATE_HOME/shapewall/agent-browser-profiles/`). A recorded
  login's cookies never go to the host the session's dev server listens on.
- **On Linux with the OS sandbox,** the browser runs inside it too. Where Chromium's own sandbox cannot start, the browser stays off
  unless you allow it without (`browser-no-sandbox on`, solo and team turns only). On open turns Chromium's own sandbox is
  required, so there the browser starts on your machine with it instead of inside the OS sandbox without it.
- **A narrower line mid-turn** (a shorter allowlist, a login or profile taken away) closes the browser; the next step gets one
  made from the line as it is now.

| Setting                | Values                              | What it does                                                                    |
| ---------------------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| `browser`              | `on`, `off`                         | The throwaway browser at all                                                    |
| `browser-allow`        | origins, comma separated, or `none` | Extra exact origins, up to 40. Replaces the list: name the ones you keep        |
| `browser-auth`         | a recorded auth name, or `none`     | A recorded login, on solo turns (and team with `browser-profile-team`)          |
| `browser-profile`      | a name, or `none`                   | A saved agent profile, made the first time; never a real browser's profile      |
| `browser-profile-team` | `on`, `off`                         | Team turns get the login too                                                    |
| `browser-no-sandbox`   | `on`, `off`                         | Start without Chromium's own sandbox where it cannot start (solo and team only) |

The full rules, with what the browser cannot cover, are in [the agent's throwaway browser](agent-hardening.md#the-agents-throwaway-browser).

## Extensions

An agent can have skills and MCP servers of your own, from a folder that is only for it, never your `~/.claude`. Name the folder
with `agent connect --agent-config DIR` for a connected agent, or `shapewall agent set agent-config DIR` in the project folder for
a local board. It must be outside the project, never Claude Code's own folder (or `$CLAUDE_CONFIG_DIR`), not in a temporary
folder and not writable by other users; Shapewall never creates it. Shapewall reads it and passes on only:

- skills: `DIR/skills/<name>/SKILL.md` and the files beside it, copied into a plugin Shapewall makes in its own state folder;
- MCP servers: the stdio servers in the user-scope `mcpServers` of `DIR/.claude.json`, each with only the environment its entry
  names plus `PATH` and `HOME`.

Settings, hooks, commands, agents, `bin/`, output styles and installed plugins are skipped (copy a plugin's skill into
`DIR/skills` to use it, its MCP server into `.claude.json`), and `agent connect` lists what it skipped. The folder's settings
(allow rules, hooks, default mode) never apply. Only Claude Code's restricted session takes extensions: another agent shows the line off.

Extensions are used only on turns above the open tier where every author is in the machine's extension set (`extensions-for`,
`owner` by default), and only in a clean thread: everyone who ever wrote in it is in that set too, and it never carried text
nobody can vouch for. A thread is tainted for good by a share-link guest's or a non-member's text, another agent's answer, a move
to another agent, a comment by a token or an import, someone else's comment that the prompt quotes, and a board tool whose result
is other people's comments (`list_comments`, `get_comment`). Taking that text away never makes it clean again, and threads from
before 1.4.0 count as tainted. When a board tool taints a turn that had extensions, every extension tool and every board write
(`reply_to_comment`, `set_comment_status`, `resolve_comment` and the rest) is refused for the rest of the turn, and the session
ends with it: a skill's text stays readable to the model once loaded, so the turn may no longer act on the board.

A tool call from an extension runs only when its exact name (`mcp__server__tool`, no wildcards) is on the machine's `allow-tool`
list, up to 20; any other is refused on the machine, and nobody is asked. An extension tool's own result (a server that fetches a
web page, say) can still bring in outside text without tainting the thread, so allow only tools whose results you trust. The full
rules are in [the agent hardening guide](agent-hardening.md#what-each-turn-may-do).

```sh
shapewall agent connect --remote https://wall.example.com --agent-config ~/agents/builder
shapewall agent set allow-tool mcp__issues__search --remote https://wall.example.com
shapewall agent set extensions-for owner,ada --remote https://wall.example.com
```

## Memory

Claude Code's automatic memory is off in every session Shapewall starts: nothing it noted elsewhere shapes an answer, and it
writes no new notes. A memory tool is an extension tool: an MCP server's tool with "memory" in its name, allowed by its exact name
in `allow-tool`, and only on solo turns with extensions on: one injected page could otherwise plant a note that every later session reads. An agent never edits its
own `CLAUDE.md`, `AGENTS.md` or agent config folder.

## See what it can do

Three places show the same lines, from one renderer:

- **The console.** A project's Agents page has a **What it can do** card per agent: per place (in chat, in Fix with) and per
  tier, each line with an on, asks first, off or unknown chip, one sentence, and the command that changes it on the agent's
  machine. A local board shows the same card to its owner under **Agents**, and the board's agent panel shows the main lines.
- **`shapewall agent status`** on the agent's machine: every line per tier, why each off line is off, and the command under it.
  `--remote URL` (and `--as NAME`) for a connected agent, with whether its link is open; without it, the local board in this
  project. `--json` prints the console card's data.
- **The agent.** Ask it "what can you do here?": its instructions end with the same block, and its `shapewall_capabilities` tool
  returns it.

## Change a line

`shapewall agent set KEY VALUE` changes one line without reconnecting. It checks the value the way `agent connect` does and
refuses one it does not know.

```sh
shapewall agent set browser off                                   # this project's local board, read by the next turn
shapewall agent set trust-team ada,bo --remote https://wall.example.com
shapewall agent set shell commands --remote https://wall.example.com --as docs
```

With `--remote URL` (and `--as NAME`) it changes a connected agent's entry. A running `agent connect` reads the file again before
each turn: a narrower value applies from that turn (and the board is told), a wider one is logged and waits until you restart
`shapewall agent connect`, so a change to the file never widens a link that is already running. Without `--remote`, the
project's local board, read by its next turn. The keys: `trust-team` (`none`, `members` or handles), `trust-team-shell`, `shell`, `shell-network`,
`shell-unsandboxed`, `command-approval`, `browser`, `browser-allow`, `browser-auth`, `browser-profile`, `browser-profile-team`,
`browser-no-sandbox`, `extensions-for`, `allow-tool` and `handoff-hops`, plus the connection's own `audience`, `approvals`,
`instructions`, `agent-config`, `allow-command`, `allow-path`, `auto`, `base`, `respond` and `git-remote` (those need
`--remote`, except `agent-config`, which a local board takes for its extensions). `allow-command` is refused in this release.
Handing work to another agent is not built yet: `handoff-hops` takes only `0`, a larger value in the policy file reads as `0`
(and `agent connect` says so), and the Hand off line is off on every path.

**The server can only lower it.** A project's agent policy on a hosted server takes `maxTier` (`"solo"`, `"team"` or `"open"`),
`shell: false` and `browser: false`, for the project and per board, and a board's setting can only narrow the project's. In the
console's **Agent policy**, the board overrides box takes them per board (`{"site": {"shell": false}}`). The machine applies the
narrower of its own policy and the server's, at hello and on every turn, and a running turn asks again before each command or
browser step (at most every 5 seconds). A line the project holds says "Limited by this project's setting" on the card, with no
command: only an admin changes it.
