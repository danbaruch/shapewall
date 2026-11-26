# Plugins for Claude Code and Codex

**Experimental.** The plugin in `plugins/shapewall/` and the two marketplace files at the repository root are not covered by the
[stability promise](stability.md): their layout, skills and install steps can change in a minor release, with a note in the
changelog. The `shapewall mcp` server they start is covered as usual.

The plugin is an optional extra. `shapewall init` and `shapewall agent setup` already let Claude Code and Codex find and drive the
board with no plugin ([Your agent finds the board](agent-workflow.md#your-agent-finds-the-board)). The plugin adds the same MCP
server in one install, plus skills that know the loop.

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
claude plugin marketplace add danbaruch/shapewall
claude plugin install shapewall@shapewall
```

Inside Claude Code, `/plugin marketplace add danbaruch/shapewall` and `/plugin install shapewall@shapewall` do the same. To try
a checkout without installing: `claude --plugin-dir path/to/shapewall/plugins/shapewall`.

**Codex** (checked with the Codex CLI; the Codex desktop app reads the same `~/.codex`):

```sh
codex plugin marketplace add danbaruch/shapewall
codex plugin add shapewall@shapewall
```

A local checkout works too: `codex plugin marketplace add path/to/shapewall`.

Both install the plugin from the repository's default branch, which matches the latest npm release. To try the plugin's unreleased
changes, add the `staging` branch instead: `claude plugin marketplace add danbaruch/shapewall#staging`, or
`codex plugin marketplace add danbaruch/shapewall --ref staging` (see [Which shapewall it starts](#which-shapewall-it-starts)).

Check it: in the project, `claude mcp list` shows `plugin:shapewall:shapewall ... Connected`.

## Which shapewall it starts

The plugin's launcher (`bin/shapewall-mcp.mjs`, plain Node, no dependencies) starts `shapewall mcp` with the first of:

1. the project's own install, `node_modules/.bin/shapewall`, but only a real npm install: it must resolve to the bin file of
   `node_modules/shapewall`, whose `package.json` is named `shapewall` at the plugin's version or newer; the file must be yours (on
   macOS and Linux); and git must track neither (a repository that commits `node_modules` gives you its code, not an install). If
   git is not there to ask, only a folder outside any repository passes. Anything else is passed over, and `--print` says why;
2. `shapewall` on PATH, when it is the plugin's version or newer. The plugin is installed once for every project, so it skips the
   same PATH folders as an every-project `shapewall agent setup` entry: npx's cache (an `_npx` folder), any folder under a
   `node_modules` folder (npm puts the project's and its parents' `node_modules/.bin` first, and another project's install lives
   there too) and any folder inside the project. Symbolic links are followed before checking;
3. `npx -y shapewall@<the plugin's version>`. The first run downloads it, which can take a while.

It runs in the project folder: the nearest folder at or above where the app works that has a `shapewall.config.json`, up to the
repository root (a folder with `.git`) and never the home folder or above. So an app opened in a subfolder still finds the board.
Outside a repository it looks only in the folder the app works in, and it never uses a folder that belongs to another user.

On Windows it starts `node` with the package's own bin file (or npm's `npx-cli.js` beside `node`) rather than an npm `.cmd` shim, so
no shell reads a path. Only when there is no other way does it go through `cmd.exe`, and then only when the program and its arguments
have no space in the program's path and none of `" % ^ & | < > !`; otherwise it stops with an error.

To see what it would run, in the project: `node <plugin folder>/bin/shapewall-mcp.mjs --print`.

A plugin installed from the `staging` branch can be ahead of npm. While its version is not published, step 3 fails: install a build
of that branch, for example `npm install -g <path to a staging checkout>` (or `npm link` in it), so step 2 finds it.

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

- What it may run from the project is exactly step 1: `node_modules/.bin/shapewall`, when it passes every check there. It reads
  nothing else from a project file: it checks whether `shapewall.config.json` exists and reads `node_modules/shapewall/package.json`
  for the name, version and bin file. A repository you cloned cannot hand it a program by committing one.
- It runs no program to learn a version, and `npx` is pinned to an exact version. The one program it runs before `shapewall` is
  `git ls-files --error-unmatch`, without a shell, with a timeout, from an absolute PATH folder outside the project.
- What it starts is marked as an agent's (`SHAPEWALL_AGENT_RUN=1`, see [agent hardening](agent-hardening.md)), so a comment the agent
  adds with `shapewall comments add` is signed "agent" and never carries the owner's stamp.
- No token or password is in any plugin file or setting; hosted boards use the saved `shapewall login`.
- Comment text stays untrusted: every skill repeats the rule from the server's instructions.

## Buzz agents

Buzz agents get the same tools through MCP: see [Shapewall tools for Buzz agents](buzz.md#shapewall-tools-for-buzz-agents).
