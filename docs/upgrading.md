# Upgrading from 1.x to 2.0

Shapewall 2.0 makes the solo engine the local board. `shapewall serve` now runs the same engine as the team server, for one
project and one owner, on this machine only, with its data in `.shapewall/.engine/`. You still start alone with
`npx shapewall init && npx shapewall serve`, with no account to make, and invite people when you are ready
(`shapewall serve --team`).

The upgrade is one command, and it can be undone. Read this page before the first `shapewall serve` of 2.0 in a project you
care about.

## What happens on the first start

The first `shapewall serve` of 2.x in a project that has 1.x board data in `.shapewall/`:

1. Says which boards move and where the backup goes.
2. Runs `shapewall migrate`, which makes a full backup in `.shapewall/backup-1x-<time>/` (hard links where it can) and then
   moves the data (see below). `.shapewall/MIGRATED-TO-2` records the run. A run that fails puts the folder back as it was.
3. Starts the engine. Later starts find nothing to move.

To see the plan first, with every item that would not come along and why, run `npx shapewall migrate --dry-run`. It writes
nothing. A project with no `.shapewall/` yet needs no migration: the engine starts empty and `shapewall capture` fills it.

Anything that would stop the move stops `serve` with the reason, and nothing changes. That covers a 1.x `serve`, `watch`,
capture or starter agent still running for the project, a migration that was stopped midway (`.shapewall/MIGRATING-TO-2` is
left behind; run `shapewall migrate --rollback`, which puts back that run only; never delete the file by hand), and a
board the engine cannot take.

## What moves

| 1.x data in `.shapewall/<board>/`                                   | In 2.0                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------- |
| Captures, versions, variants, environments, diffs, journeys, checks | Moved as files into `.shapewall/.engine/files/`      |
| Comments, replies, reactions, comment images and drawings           | Rows in the engine's database, with their numbers    |
| A comment's GitHub issue and pull request links                     | Kept with the comment on the engine                  |
| Chat threads                                                        | Rows in the engine's database                        |
| A `serve --accounts` owner, with passkeys, recovery codes and photo | The engine's owner (same user id)                    |
| Agent settings (Settings > Agent, in your user config folder)       | Stay where they are; the engine reads them as before |
| `.shapewall/events.jsonl`                                           | Stays where it is; the engine keeps writing it       |
| Sign-in sessions, paired devices                                    | Not moved: sign in again (see below)                 |
| A watcher's claims, its working state, leftover locks and logs      | Not moved; the comment keeps its agent status        |

The backup stays until you delete it. Keep it until you are sure.

## Rolling back

```sh
npx shapewall migrate --rollback --dry-run   # what it would restore
npx shapewall migrate --rollback             # put the 1.x board back
```

`--rollback` restores every board from the backups the runs recorded, checked byte for byte, and the engine folder as it was
before the run. Nothing is deleted on the way: what is there now, including anything made on the engine since the move, goes
aside into `<backup>/replaced-<time>/`. After a migration that was stopped midway, `--rollback` puts back only that run (earlier
finished runs stay on the engine); `--rollback --all` puts back every run. A rollback that is itself stopped midway leaves
`.shapewall/ROLLING-BACK`, and nothing starts until `shapewall migrate --rollback` runs again and finishes it. If a backup
keeps failing, the message names it: fix what it says and run `--rollback` again, or run `shapewall migrate --rollback
--give-up` to end the rollback and keep the folder as it is now. If a stopped run's backup is gone, `--rollback` says so,
and `shapewall migrate --abandon` keeps what the engine has of that run and records it as done. Lines the engine added to
`.shapewall/events.jsonl` after the backup name comments 1.x no longer has, so they move into the same
`<backup>/replaced-<time>/events.jsonl` and the log is as it was; if the log was rotated or edited since, it stays as it is
and the rollback says so. Empty `.shapewall/remote/<engine project>/<board>/agent/` folders that `watch` made on the engine
go too. Rollback is part of the Apache 2.0 core and never needs the engine.

A moved board's 1.x folder keeps only a note (`comments.json` and `status.json` are folders, `chat` is a file), so nothing a
1.x build writes lands beside the moved board. An older Shapewall cannot be changed to know that note. Started on a migrated
project, Shapewall 1.1.0 starts and says it is serving the board, but the board API answers 500 ("Something went wrong")
and `shapewall comments` fails with "Not a regular capture file." Nothing is lost either way: roll back with 2.x first.

## Staying on 1.x

- **Pin the old version.** Roll back with 2.x first (an older Shapewall cannot read a moved project), then run 1.x pinned:
  `npx shapewall@1 serve`, or `npm install --save-dev shapewall@1` in the project.
- **Run the 1.x board server on 2.x.** `shapewall serve --engine legacy`, or `SHAPEWALL_ENGINE=legacy` for a service or a
  script, keeps the 1.x server and puts every command back on the 1.x files. It is deprecated: it stays through 2.x, prints a
  warning, and goes in 3.0. A flag only the 1.x server has (`--host`, `--lan`, `--tailscale`, `--tls-cert`, `--tls-key`,
  `--allowed-host`, `--accounts`, `--accounts-origin`, `--agent-acp`, `--allow-remote-agent`, `--buzz-bridge`,
  `--trust-proxy` and the device flags) also picks it, with the same warning, so `serve --host 0.0.0.0` in a container
  keeps working. A board that already moved is refused by the 1.x server: roll back first.

## What changes for you

- **Sign-in.** The engine has one owner, made on the first start with your name (`SHAPEWALL_USER_NAME`, else
  `git config user.name`), or the `serve --accounts` owner if you had one. `serve --open` signs the browser in from the
  terminal through a one-time page; there is no passkey to set up. The board's address changes to
  `http://<project>-<random>.shapewall.localhost:<port>` (port 4600 by default): update bookmarks.
- **Paired devices** do not move. Other people, and your other devices, reach the engine through team mode
  (`shapewall serve --team`, or **Invite people** on the console's Members page): the same board on your tailnet with
  tailnet sign-in. See [team mode](hosted.md#inviting-people-team-mode).
- **Authorship.** On a 1.x board an author was a typed name. On the engine your comments are the owner account's. A
  plain local 1.x board (no `serve --accounts`) had one person behind it: you, at this machine or on a device you paired.
  So in the move every comment there becomes the owner's, sent to agents as `watch` did on 1.x; only comments marked as an
  agent's or a share guest's are not. With `serve --accounts`, other people could comment, so only comments the 1.x board
  stamped as the owner's become the owner's; others signed with your name come in as imported text, and every other name
  stays a label. Those are not sent to agents until you send them from the board. The dry run counts each kind. The `author` of the MCP tools `reply_to_comment` and `add_comment`, and
  `comments reply --author` and `comments add --author`, still label an agent's text, which stays marked as an agent's.
- **The board's agent** runs as a connected agent of the engine (`shapewall agent connect --as local`), with the settings
  you had. It acts only when asked, as on a 1.x board.
- **Commands in the project folder** (`comments`, `watch`, `mcp`, `export`, `github`) go to the engine. When no
  `shapewall serve` runs, they start the engine for themselves on this machine, without the project's agent, and stop it
  when they end, so an agent's `shapewall mcp` works with or without `serve`. A command an agent started never starts one.
  `capture`, `links`, `push`, `journeys`, `variant` and `checks` work on the engine's board folders, running or not.
  `github issue`, `link` and `sync` work on the engine's comments, with this machine's GitHub token, which never goes to the
  engine. The GitHub webhook stays the 1.x server's: on the engine, `shapewall github sync` picks up merged pull requests.
- **Stable surfaces keep their 1.x shapes**: `comments --json`, the `watch` and `watch --exec` JSON, the MCP tools and their
  arguments, and the lines of `.shapewall/events.jsonl` ([stability](stability.md)).

## Refused on the engine

- **`shapewall share --remote`** refuses a board the engine holds. To bring people to it, use `shapewall serve --team`:
  the same board on your tailnet, nothing copied. Moving an engine board to a team server is not in 2.0; to move a project
  there, roll it back and share the 1.x board.
- **`comments delete`** is not on the engine yet; delete a comment on the board.
- **Flags that reach beyond this machine** (`--host`, `--lan`, `--tailscale`, `--tls-cert`, `--accounts`, `--allowed-host`,
  ...) run the deprecated 1.x server instead (above). For other people use team mode, or a team server on your own domain.

## Removed in 2.0

Each removed spelling stops with a one-line error that names its replacement (`... was removed in Shapewall 2.0; use ...`).

| Removed                                                         | Use instead                                                                            |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `agent run`, `agent watch`, `agent doctor`, `agent build-image` | `agent sandbox run`, `watch`, `doctor`, `build-image`                                  |
| `audit`                                                         | `checks lighthouse`                                                                    |
| `checks lighthouse --production`                                | `--build-mode`                                                                         |
| `checks lighthouse BOARD`                                       | `checks lighthouse --board BOARD`                                                      |
| `hosted --setup`                                                | `hosted setup`                                                                         |
| `variant rm`                                                    | `variant remove`                                                                       |
| `export --noindex`                                              | `export --no-index`                                                                    |
| `capture --yes` (`-y`)                                          | Leave it out: capture never prompts                                                    |
| Config `versions`                                               | `keepVersions`                                                                         |
| Config `notifications.boardUrl`, `github.boardUrl`              | The top-level `boardUrl`, or `SHAPEWALL_BOARD_URL`                                     |
| Config `agent.localSession: "own"`                              | Leave it out: a local board's Claude Code session is always the restricted one         |
| `SHAPEWALL_USERCONTENT_ORIGIN`                                  | `SHAPEWALL_HOSTED_USERCONTENT_ORIGIN` (a server with only the old name stops at start) |

## Deprecated in 2.0, removed in 3.0

These still work through 2.x with a one-line warning on stderr:

- `shapewall serve --engine legacy` and `SHAPEWALL_ENGINE=legacy` (the 1.x board server, above).
- `serve --lan` and the `shapewall devices` command: use the tailnet instead.
- `serve --accounts` and `SHAPEWALL_ACCOUNTS=1`: the engine signs its owner in by itself
  ([local accounts](local-accounts.md)).
- `starterAgent.testCommand`: set [`commands.test`](config.md#commands).

## License

The CLI, capture, the migration planner, the backup and the rollback stay Apache 2.0. The solo engine and the team server
(`src/hosted`) are under the [Functional Source License 1.1, ALv2 future license](../src/hosted/LICENSE.md): free to use and
change, at work too, but not to offer as competing hosting, and each release becomes Apache 2.0 two years after it ships.
