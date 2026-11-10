Shapewall puts every page of your product on one zoomable wall. You point at what should change, a coding agent makes the change,
and the wall shows you the result in place. These docs cover installing it, configuring your pages, the agent workflow and running it
for a team.

![The Shapewall board with the pages of a demo product, grouped, at desktop and phone width](/images/board-overview.webp)

## How it works

1. **Capture.** Playwright opens each page in your config at every viewport (by default 1440 x 2200 desktop and 390 x 1800 phone; add a tablet or your own). It
   writes a screenshot, a thumbnail and a live HTML snapshot with every script removed.
2. **The wall.** `shapewall serve` starts a small local server with the board: a canvas with your pages grouped into sections. Zoomed
   out you see thumbnails of everything; zoomed in, a tile turns into the captured page itself.
3. **Comments.** Click **Comment**, click an element, write what should change. On live HTML the comment is anchored to the element
   (a selector plus its text), so it follows that element through the next capture.
4. **The agent loop.** `shapewall comments --open --json`, `shapewall watch` or the MCP server give any coding agent precise,
   structured work. It changes the code, recaptures the pages it touched, replies, and you check before and after on the wall.

## What you need

- Node.js 22 or newer (22.13 for local accounts and the team server).
- Chromium for captures: Playwright's own (one install command) or a Chrome you already have.
- A site to point it at: a local dev server, a preview deploy, staging or production.

## Where to go next

- [Getting started](/docs/getting-started): install, write a config, capture and open the board.
- [Config reference](/docs/config): every key in `shapewall.config.json`.
- [Journeys](/docs/journeys) and [before, after and staging](/docs/compare): flows through your pages and comparing versions.
- [The agent workflow](/docs/agent-workflow): hand comments to Claude Code, Codex or any agent.
- [Agent recipes](/docs/agent-recipes): exact, tested commands for Claude Code, Codex, goose, Ollama and chat bots.
- [GitHub connect](/docs/github) and [notifications](/docs/notifications): issues and pull requests from comments, and messages to a
  webhook, Slack, Discord or email.
- [Sandboxed starter agent](/docs/starter-agent): let an agent work on comments from a shared board, inside a container.
- [Security model](/docs/security): why captured pages can never run code.
- [Page checks and performance](/docs/page-checks): reliability, SEO, social images, Lighthouse, accessibility and report comparisons.
- [Capture warnings and pacing](/docs/capture-warnings): API failures and rate limits alongside usable screenshots.
- [Local accounts and profile photos](/docs/local-accounts), [manual updates](/docs/updates) and the [hosted operator guide](/docs/hosted).

## Versions and licenses

These docs describe the current release. The local tool is open source under Apache 2.0; the self-hosted team server (`shapewall
hosted`) is source-available under the Functional Source License and becomes Apache 2.0 two years after each release. See
[licenses and self-hosting](/open-source).
