# Shapewall guides

Shapewall captures every screen of your app on desktop and phone, maps the flows between them, and lets you point at anything and tell
your coding agent what to build. These guides are listed in the order a newcomer needs them. Most of them are also the pages of
[shapewall.com/docs](https://shapewall.com/docs), which reads them from this folder, so there is one source.

A few pages are written for the site and live only there; they are linked below where they fit.

## 1. Getting started

| Guide                                                         | What it covers                                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [Getting started](https://shapewall.com/docs/getting-started) | Install, write a config, capture every screen, open the wall. (On the site.)               |
| [where-to-run.md](where-to-run.md)                            | Local board or a team server: who can reach each, and where the work happens.              |
| [upgrading.md](upgrading.md) | Upgrading a 1.x project to 2.0: what moves, the backup, rollback, staying on 1.x, what was removed. |
| [deployment.md](deployment.md#linux-system-libraries)         | Linux system libraries for Chromium, and capturing inside the Playwright image.            |
| [FAQ](https://shapewall.com/docs/faq)                         | Single-page apps, signed-in screens, where the data lives, teams, licenses. (On the site.) |

## 2. Capture your app

| Guide                                                             | What it covers                                                                                              |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [config.md](config.md)                                            | Every key in `shapewall.config.json`: pages, viewports, actions before a shot, signed-in pages, boards, CI. |
| [config.md](config.md#capturing-an-app-not-just-its-landing-page) | Screens behind sign-in, a start button or app state: `shapewall auth record` and page `actions`.            |
| [capture-warnings.md](capture-warnings.md)                        | Reading the network summary beside a screenshot, and the pacing settings that slow a capture down.          |

## 3. The wall

| Guide                                                           | What it covers                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [journeys.md](journeys.md)                                      | The flows between screens: link arrows from the real links, and named journeys you step through. |
| [Before, after and staging](https://shapewall.com/docs/compare) | Before and after on every change, variants beside the original, staging against production.      |
| [pull-requests.md](pull-requests.md)                            | Capture every screen on each pull request and keep one comment up to date with what changed.     |

## 4. Steering agents

| Guide                                                             | What it covers                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [agent-workflow.md](agent-workflow.md)                            | Comments as instructions: the loop, the JSON an agent reads, `shapewall watch` and the MCP server.           |
| [agent-workflow.md](agent-workflow.md#your-agent-finds-the-board) | How an agent finds the board: the `AGENTS.md` section from `init`, and `shapewall agent setup`.              |
| [agent-workflow.md](agent-workflow.md#links-to-the-board)         | Links to a page, a comment or a before and after (`shapewall open`), and following an agent.                 |
| [plugins.md](plugins.md)                                          | The Claude Code and Codex plugin: the MCP server plus skills in one install (experimental).                  |
| [agent-recipes.md](agent-recipes.md)                              | Copy-paste commands for Claude Code, Codex, goose, Ollama and chat bots.                                     |
| [agents.md](agents.md)                                            | The board's chat panel: connect a model or an agent CLI, work on a branch, images and voice.                 |
| [agents.md](agents.md#when-an-agent-answers)                      | When an agent answers in a shared thread: @mentions, Send to agent, and agent text that never starts a turn. |
| [starter-agent.md](starter-agent.md)                              | `shapewall agent sandbox` (experimental): one comment at a time in a container, budgets, a branch.           |
| [agent-capabilities.md](agent-capabilities.md)                    | What an agent may do on each turn: solo, team and open, named commands, the sandboxed shell, the browser.    |
| [agent-hardening.md](agent-hardening.md)                          | Prompt injection through comments, the built-in defenses, least privilege, a sandbox checklist.              |

## 5. Teams and self-hosting

| Guide                                  | What it covers                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [deployment.md](deployment.md)         | Run the board, reach it from your other devices, Docker, a static export, captures on CI.        |
| [hosted.md](hosted.md)                 | The team server (beta): accounts, workspaces, roles, connected agents, quotas, backups, restore. |
| [local-accounts.md](local-accounts.md) | The optional local owner account: passkeys, recovery codes, sessions, profile images.            |
| [updates.md](updates.md)               | Which version is running, updating a clone or a project install, the optional update helper.     |
| [monitoring.md](monitoring.md)         | The health check for uptime probes, where the logs go, opt-in error reports, a triage checklist. |

## 6. Reference

| Guide                                                 | What it covers                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [CLI reference](https://shapewall.com/docs/cli)       | Every command and flag. `shapewall --help all` prints the list, `shapewall <command> --help` one. |
| [config.md](config.md)                                | The config reference, including the environment variables.                                        |
| [Security model](https://shapewall.com/docs/security) | Why captured HTML can never run code. (On the site.)                                              |
| [stability.md](stability.md)                          | Stability and versioning: what 1.x keeps stable, what is experimental, which files are internal.  |
| [page-checks.md](page-checks.md)                      | `shapewall checks`: reliability, SEO and social images against the original pages, and the panel. |
| [performance.md](performance.md)                      | `shapewall checks lighthouse`: local Lighthouse runs, profiles, budgets and report history.       |
| [interaction-audits.md](interaction-audits.md)        | `shapewall checks flow` and `checks accessibility`: the flow file, actions, axe snapshots.        |

## 7. Integrations

| Guide                                | What it covers                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| [github.md](github.md)               | A comment as a GitHub issue, the pull requests that fix it, resolving on merge.                         |
| [notifications.md](notifications.md) | Comment events to a signed webhook, Slack, Discord, Telegram or email, with mentions routed.            |
| [buzz.md](buzz.md)                   | Optional bridge to coding agents in a self-hosted Buzz channel, and the board's tools for those agents. |

## Contributor docs (this repository only)

These two are not user guides and are not on the site. They describe how the code is put together, for anyone changing it.

| Guide                                | What it covers                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [architecture.md](architecture.md)   | The three parts and the files they share: capture, live HTML and its limits, anchors, the board.       |
| [design-system.md](design-system.md) | The board's UI kit in `client/src/components/ui/`: components, tokens and the rules for a new control. |
