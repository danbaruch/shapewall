# Shapewall guides

Every file in this folder is listed below. Most of them are the text the website shows: [shapewall.com/docs](https://shapewall.com/docs)
reads them from here, so there is one source and no second copy to keep in step. The groups below are that sidebar's groups. The last
two are for people changing the code and are not on the website.

Five guides exist only on the website, because they are written for the site rather than for the repository:

- [Getting started](https://shapewall.com/docs/getting-started): install, write a config, capture, open the board.
- [CLI reference](https://shapewall.com/docs/cli): every command and flag. The same help text is in this repository's
  [README](../README.md#cli), so a reader who never leaves the repository is not stuck.
- [FAQ](https://shapewall.com/docs/faq): single-page apps, signed-in pages, where the data lives, teams, licenses.
- [Security model](https://shapewall.com/docs/security): why captured HTML can never run code.
- [Before, after and staging](https://shapewall.com/docs/compare): resolved comments before and after, variants, staging against
  production.

## Start here

[config.md](config.md) is the only guide of this group that lives here: every key in `shapewall.config.json`, from pages and viewports
to actions, setup, signed-in pages, boards, CI and the environment variables. Getting started and the CLI reference are on the website,
above.

## Workflows

| Guide                                          | What it covers                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [agent-workflow.md](agent-workflow.md)         | The three ways to hand comments to a coding agent: JSON, `shapewall watch`, the MCP server.          |
| [agent-recipes.md](agent-recipes.md)           | Copy-paste commands for Claude Code, Codex, goose, Ollama and chat bots.                             |
| [agents.md](agents.md)                         | The board's chat panel: connect a model or an agent CLI, work on a branch, images and voice.         |
| [starter-agent.md](starter-agent.md)           | `shapewall agent`: one comment at a time in a container, with a trigger gate, budgets and a branch.  |
| [journeys.md](journeys.md)                     | Link arrows drawn from the real links between pages, and named paths you step through.               |
| [pull-requests.md](pull-requests.md)           | Capture every page on each pull request and keep one comment up to date with what changed.           |
| [page-checks.md](page-checks.md)               | `shapewall checks`: reliability, SEO and social images against the original site, and the panel.     |
| [performance.md](performance.md)               | `shapewall audit`: local Lighthouse runs, measurement profiles, budgets and report history.          |
| [interaction-audits.md](interaction-audits.md) | `shapewall checks flow` and `checks accessibility`: the flow file, supported actions, axe snapshots. |

## Run it

| Guide                                      | What it covers                                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| [where-to-run.md](where-to-run.md)         | Local board or hosted server: who can reach each, and where the work happens.                      |
| [deployment.md](deployment.md)             | Run the board, share it behind an authenticating proxy, export a static copy, capture on CI.       |
| [capture-warnings.md](capture-warnings.md) | Reading the network summary beside a screenshot, and the pacing settings that slow a capture down. |
| [local-accounts.md](local-accounts.md)     | The optional local owner account: passkeys, recovery codes, sessions, profile images.              |
| [updates.md](updates.md)                   | Which version is running, updating a clone or a project install, the optional update helper.       |
| [hosted.md](hosted.md)                     | Operating a team server: accounts, workspaces, roles, quotas, retention, backups, restore.         |
| [agent-hardening.md](agent-hardening.md)   | Prompt injection through comments, the built-in defenses, least privilege, a sandbox checklist.    |

## Integrations

| Guide                                | What it covers                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| [github.md](github.md)               | A comment as a GitHub issue, the pull requests that fix it, resolving on merge.    |
| [notifications.md](notifications.md) | Comment events to a signed webhook, Slack, Discord or email, with mentions routed. |
| [buzz.md](buzz.md)                   | Optional bridge to coding agents that already sit in a self-hosted Buzz channel.   |

## Contributor docs (this repository only)

These two are not user guides and are not on the website. They describe how the code is put together, for anyone changing it.

| Guide                                | What it covers                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [architecture.md](architecture.md)   | The three parts and the files they share: capture, live HTML and its limits, anchors, the board.       |
| [design-system.md](design-system.md) | The board's UI kit in `client/src/components/ui/`: components, tokens and the rules for a new control. |
