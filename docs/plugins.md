# Plugins for Claude Code and Codex

**Experimental.** The plugin in `plugins/shapewall/` and the two marketplace files at the repository root are not covered by the
[stability promise](stability.md): their layout, skills and install steps can change in a minor release, with a note in the
changelog. The `shapewall mcp` server they start is covered as usual.

The plugin is an optional extra. `shapewall init` and `shapewall agent setup` already let Claude Code and Codex find and drive the
board with no plugin ([Your agent finds the board](agent-workflow.md#your-agent-finds-the-board)). The plugin adds the same MCP
server in one install, plus skills that know the loop.

**Staging only.** Until the next release, the plugin installs from the `staging` branch, and the `shapewall` it starts must be a
staging build (see [Which shapewall it starts](#which-shapewall-it-starts)).

## What you get

- The `shapewall` MCP server: the same tools as `shapewall mcp` ([the tool list](agent-workflow.md#mcp-server-shapewall-mcp)),
  started in your project folder.
- Four skills:

| Skill              | What it does                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `shapewall`        | The loop: find comments, mark one working, change the code, recapture, compare, reply, done                 |
| `shapewall-next`   | Takes the next open comment (optionally on a page, by an author or from a day) through the loop, then stops |
| `shapewall-open`   | A link to the board, a page, a comment or a before and after, and opens it                                  |
| `shapewall-status` | How many comments are waiting, being worked on or need a person, with links; changes nothing                |

In Claude Code, run a skill as `/shapewall:shapewall-next`, or just ask ("take the next Shapewall comment"). Codex lists them as
`shapewall:shapewall-next` and so on; ask for one by name or describe the task.

The skills' text comes from the same source as the MCP server's own instructions, so the two never disagree.

## Use the plugin or `agent setup`, not both

Both register a server called `shapewall`, so with both the agent sees every tool twice. If you ran `shapewall agent setup` (or added
`shapewall` to `~/.claude.json` or `~/.codex/config.toml` by hand), take that out before installing the plugin:

```sh
npx shapewall agent setup --remove
```

## Install

The project needs a `shapewall.config.json` (`npx shapewall init`).

**Claude Code:**

```sh
claude plugin marketplace add danbaruch/shapewall#staging
claude plugin install shapewall@shapewall
```

Inside Claude Code, `/plugin marketplace add danbaruch/shapewall#staging` and `/plugin install shapewall@shapewall` do the same. To try
a checkout without installing: `claude --plugin-dir path/to/shapewall/plugins/shapewall`.

**Codex** (checked with the Codex CLI; the Codex desktop app reads the same `~/.codex`):

```sh
codex plugin marketplace add danbaruch/shapewall --ref staging
codex plugin add shapewall@shapewall
```

A local checkout works too: `codex plugin marketplace add path/to/shapewall`.

Check it: in the project, `claude mcp list` shows `plugin:shapewall:shapewall ... Connected`.

## Which shapewall it starts

The plugin's launcher (`bin/shapewall-mcp.mjs`, plain Node, no dependencies) starts `shapewall mcp` with the first of:

1. the project's own install, `node_modules/.bin/shapewall`;
2. `shapewall` on PATH, when it is the plugin's version or newer. PATH folders that npm puts first for one project or one `npx` run
   (any `node_modules/.bin`, an npm `_npx` cache) and folders inside the project do not count;
3. `npx -y shapewall@<the plugin's version>`. The first run downloads it, which can take a while.

It runs in the project folder: the nearest folder at or above where the app works that has a `shapewall.config.json`, up to the
repository root (a folder with `.git`) and never the home folder or above. So an app opened in a subfolder still finds the board.

To see what it would run, in the project: `node <plugin folder>/bin/shapewall-mcp.mjs --print`.

While the plugin is on staging, its version is not on npm yet, so step 3 fails: install a staging build, for example
`npm install -g <path to a staging checkout>` (or `npm link` in it), so step 2 finds it.

## Hosted boards

The plugin runs `shapewall mcp --remote URL` when it has a hosted board's URL. Sign in once with `shapewall login --remote URL`; the
plugin never holds a token (the server reads the saved login).

- **Claude Code:** set the plugin's `remote_url` option: `claude plugin configure shapewall@shapewall`, `/plugin configure
shapewall@shapewall` inside Claude Code, or `--config remote_url=URL` on install. Leave it empty for the local board.
- **Codex:** set `SHAPEWALL_REMOTE=URL` in the environment Codex starts from; the plugin passes only that variable (and `CODEX_HOME`)
  through.

The URL must be a plain `http` or `https` URL with no user name or password.

## Seeing the board

`board_link` (and `shapewall open --print`) gives a link to the board, a page, a comment or a before and after. The skills tell the
agent: if your app has a browser pane, open the link there; otherwise open it in your browser or hand it to you. Which apps' panes
open a local or a tailnet board, and what they ask you to allow, is not settled yet, so the skills name none.

## How it is put together

| File                                           | For                                                                    |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `.claude-plugin/marketplace.json` (repo root)  | Claude Code's marketplace                                              |
| `.agents/plugins/marketplace.json` (repo root) | Codex's marketplace                                                    |
| `plugins/shapewall/.claude-plugin/plugin.json` | Claude Code: the inline `shapewall` server and the `remote_url` option |
| `plugins/shapewall/.codex-plugin/plugin.json`  | Codex: skills, the server file, how the plugin shows in the app        |
| `plugins/shapewall/.mcp.json`                  | Codex's server entry (generated)                                       |
| `plugins/shapewall/bin/shapewall-mcp.mjs`      | The launcher                                                           |
| `plugins/shapewall/skills/*/SKILL.md`          | The skills (generated)                                                 |

Claude Code also reads a plugin's root `.mcp.json`; its inline server has the same name, so it replaces that entry and only one
server runs. Codex starts a plugin's server in the session's folder and does not resolve the plugin's own path in its arguments, so
its entry loads the launcher from Codex's plugin cache (`$CODEX_HOME/plugins/cache/shapewall/shapewall/<version>/`, where `CODEX_HOME`
defaults to `~/.codex`).

The plugins ship from git, not in the npm package. After a version bump, `node scripts/build-plugin-skills.mjs` rewrites the generated
files and the versions; a unit test fails while they are stale. Check the manifests with `claude plugin validate plugins/shapewall
--strict` and `claude plugin validate . --strict`.

## Safety

- The launcher never takes a command from a project file. In the project it only checks whether `shapewall.config.json` and
  `node_modules/.bin/shapewall` exist, and reads the version in `node_modules/shapewall/package.json`.
- It runs no program to learn a version, and `npx` is pinned to an exact version.
- No token or password is in any plugin file or setting; hosted boards use the saved `shapewall login`.
- Comment text stays untrusted: every skill repeats the rule from the server's instructions.

## Buzz agents

Buzz agents get the same tools through MCP: see [Shapewall tools for Buzz agents](buzz.md#shapewall-tools-for-buzz-agents).
