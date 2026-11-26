# Stability and versioning

Shapewall follows [Semantic Versioning](https://semver.org/) from 1.0.0. This page says what that covers: what you can build on
without it changing under you within 1.x, and what is marked experimental or internal and may change in a minor release.

## The promise

Within 1.x we will not remove or rename, or change the meaning of:

- the CLI commands and their flags, and the exit codes;
- the keys of `shapewall.config.json`;
- the `SHAPEWALL_*` environment variables;
- the JSON that `--json`, `watch`, `watch --exec`, `events` and the MCP tools produce;
- the hosted token API under `/api/v1` and the `/mcp` endpoint;
- the webhook payload and its signature, and the GitHub webhook receiver `POST /api/github/webhook`;
- the stable files on disk (below).

New commands, flags, config keys, JSON fields and event types can arrive in any minor release, so read JSON tolerantly and ignore
fields you do not know.

Before something stable is removed, it is deprecated for at least one minor release: it keeps working and prints a one-line
warning on stderr when it is used (`Warning: ... is deprecated and will be removed in Shapewall 2.0; ...`), and it is removed only
in the next major. The [CLI reference](https://shapewall.com/docs/cli#deprecated-spellings) lists the spellings deprecated so far.

Shapewall supports the Node.js versions in active or maintenance LTS from 22.19 on. Dropping one is announced a minor release
ahead.

## Stable

The core of Shapewall:

- the commands `init`, `sitemap`, `capture`, `serve` (its base flags), `comments`, `watch`, `mcp`, `events`, `journeys`, `links`,
  `variant`, `export`, `notify`, `github`, `ci`, `doctor`, `auth record`, `push`, `share`, `login --remote`, `agent connect`
  (except the link policy flags below), `agent status` (its human-readable output is not covered, see Internal), and `hosted`
  (its server flags, `backup` and `restore`);
- the core config keys, including `commands`, `agent.browser.allow`, `agent.fixIn` and `agent.localSession` (1.4.0; its value
  `"own"` is deprecated and goes in 2.0), the comment item JSON, the MCP tools, `/api/v1` (except `/api/v1/agent/*`), `/mcp`, the webhook payload and
  its signature, `events.jsonl`, the environment variables that are not listed as experimental below, the exit codes, and the
  `shapewall` bin name.

## Experimental

Anything marked experimental may change, or go, in a minor release, with a note in the changelog. In the help (`shapewall --help
all`), an experimental command or option ends its first line with `(experimental)`; in these docs, its section or page says
**Experimental** at the top.

- **The sandboxed starter agent:** `shapewall agent sandbox run|watch|doctor|build-image`, the `starterAgent` config key,
  `Dockerfile.agent`, `SHAPEWALL_AGENT_IMAGE`, `SHAPEWALL_AGENT_RUNTIME`, `SHAPEWALL_AGENT_REGISTRY`, `SHAPEWALL_AGENT_EGRESS`,
  `SHAPEWALL_AGENT_KEY_HOSTS`, `SHAPEWALL_SANDBOX` and `SHAPEWALL_EGRESS_*` ([the starter agent](starter-agent.md)).
- **The hosted agent link policy:** `agent connect --approvals`, `--auto`, `--allow-command`, `--allow-path`, `--audience`,
  `--browser-profile` and `--browser-no-sandbox`, `shapewall agent set` and its keys, the output of `agent status --json`,
  `/api/v1/agent/*`, the machine's `agent-policy.json` (version 2 and its capability keys), the `capabilities` entry of a
  project in `agents.json`, and the file `watch --exec` names in `SHAPEWALL_CAPABILITIES_FILE`
  ([what an agent can do](agent-capabilities.md)).
- **Chat internals:** `agent.branchMode`, `agent.branchPrefix`, `agent.batchFixes`, `SHAPEWALL_AGENT_BRANCH_*`,
  `SHAPEWALL_AGENT_ACP_ENV` and the chat's event stream.
- **Tailnet sign-in:** `hosted --tailnet-sign-in`, `--tailnet-passkeys`, `--funnel` and `--funnel-port`, `hosted claim`,
  `shapewall join`, `shapewall admin`, and `--project` on `login` and `agent connect`
  ([tailnet sign-in](hosted.md#tailnet-sign-in)).
- **Local accounts and LAN serving:** `serve --accounts`, `--accounts-origin`, `--lan`, `--tls-cert` and `--tls-key`
  ([local accounts](local-accounts.md)).
- **Page checks:** `shapewall checks` (with `checks lighthouse`, `checks flow` and `checks accessibility`), the `checks` config and
  the report JSON ([page checks](page-checks.md), [Lighthouse audits](performance.md)).
- **The Buzz bridge:** `shapewall buzz-bridge`, `serve --buzz-bridge`, the board's "Existing Buzz conversation" dialog,
  and `SHAPEWALL_BUZZ_SIGNER_CODEX`/`SHAPEWALL_BUZZ_SIGNER_CLAUDE` ([the Buzz bridge](buzz.md)).
- **The Claude Code and Codex plugin:** everything in `plugins/shapewall/` (manifests, skills, the launcher) and the marketplace
  files `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json` ([plugins](plugins.md)). The `shapewall mcp`
  server it starts is covered as usual.
- **Self-update:** `SHAPEWALL_UPDATE_*` and the board's update routes ([updates](updates.md)).
- **Smaller pieces:** the `settings` command (use `serve --open`), `export --browser-comments`, the hosted `quotas.json`, and the
  output of `hosted admin`.

The Dockerfiles (`Dockerfile`, `Dockerfile.hosted`, `Dockerfile.agent`) and `docker-compose.example.yml` are examples you build
yourself: no image is published, and they are not covered by this promise ([in Docker](deployment.md#in-docker)).

## Internal

Never promised, and free to change in any release:

- every HTTP route outside `/api/v1`, `/mcp`, `/api/health` and `/api/github/webhook`: the routes `shapewall serve` uses for its own board page, and the
  hosted console, board pages, `/auth` and presence connections. Agents and scripts use the CLI, the MCP server or `/api/v1`
  ([the agent workflow](agent-workflow.md#which-interface-to-build-on));
- human-readable output: the wording of messages, tables and progress lines (use `--json` to read results);
- the owner MCP tools of the board chat, and the tools of Shapewall's command and browser tool server (`exec-mcp`) that an agent
  session gets;
- files on disk other than the stable ones below.

## Files on disk

Stable:

| File                                                                   | What it is                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `shapewall.config.json`                                                | The config ([config reference](config.md)).                                    |
| `.shapewall-auth/*.auth.json`                                          | Saved sign-ins from `shapewall auth record`.                                   |
| `.shapewall/events.jsonl` (in the configured `outputDir`)              | The shared event log that `shapewall events` reads.                            |
| The file `watch --exec` is handed (`$SHAPEWALL_COMMENT_FILE`)          | The comment as JSON, the same as the command's stdin.                          |
| `$XDG_CONFIG_HOME/shapewall/credentials.json` (`%APPDATA%\shapewall\`) | Saved project tokens for the `--remote` commands; the location stays the same. |

Everything else inside `.shapewall/` (captures, comments, history, reports, locks) and inside the hosted data folder is internal:
its layout can change in any release. Read it through the CLI, the MCP server or the API, and back up the hosted data folder with
`shapewall hosted backup`.
