Shapewall puts every screen of your app on one zoomable wall, on desktop and phone, with the flows between them. You point at
anything and tell your coding agent what to build; the comment is the instruction, and the wall shows you the result in place. These
docs cover installing it, configuring your screens, steering your agents and running it for a team.

![The Shapewall wall with all 146 screens of a demo app, grouped into sections, with instruction pins](/images/board-overview.webp)

## How it works

1. **Capture.** Playwright opens each page in your config at every viewport (by default 1440 x 2200 desktop and 390 x 1800 phone; add a tablet or your own). It
   writes a screenshot, a thumbnail and a live HTML snapshot with every script removed.
2. **The wall.** `shapewall serve` starts a small local server with the board: a canvas with your pages grouped into sections. Zoomed
   out you see thumbnails of everything; zoomed in, a tile turns into the captured page itself. It pans and zooms like a design
   tool: wheel or trackpad to pan, a pinch or Ctrl/Cmd+wheel to zoom at the cursor.
3. **Comments.** Click a page and press **Comment** on its bar (or pick **Comment** in the tools at the bottom of the board), click an element, and type or dictate what should change. On live HTML the comment is anchored to the element
   (a selector plus its text), so it follows that element through the next capture.
4. **The agent loop.** `shapewall comments --open --json`, `shapewall watch` or the MCP server give any coding agent precise,
   structured work. It changes the code, recaptures the pages it touched, replies, and you check before and after on the wall.

## What you need

- Node.js 22.19 or newer, on Linux, macOS or Windows. Linux is the primary tested platform.
- Chromium for captures: Playwright's own (one install command) or a Chrome you already have.
- A running app to point it at: a local dev server, a preview deploy, staging or production.

## Where to go next

- [Getting started](/docs/getting-started): install, write a config, capture and open the board.
- [Config reference](/docs/config): every key in `shapewall.config.json`, and the [CLI reference](/docs/cli): every command and flag.
- [Journeys and links](/docs/journeys) and [before, after and staging](/docs/compare): flows through your pages and comparing versions.
- [The agent workflow](/docs/agent-workflow): hand comments to Claude Code, Codex or any agent, with the
  [images and drawings on a comment](/docs/agent-workflow#images-and-drawings-on-comments) (how to add them:
  [Getting started](/docs/getting-started#images-and-drawings)).
- [Your agent finds the board](/docs/agent-workflow#your-agent-finds-the-board): the `AGENTS.md` section `shapewall init` writes,
  and `shapewall agent setup` for Claude Code and Codex. Or the [Claude Code and Codex plugin](/docs/plugins) (experimental): the
  MCP server plus skills in one install.
- [Links to the board](/docs/agent-workflow#links-to-the-board): `shapewall open` and the links agents hand you, to a page, a comment
  or a before and after, and [follow an agent](/docs/agent-workflow#follow-an-agent) while it works.
- [Chat with an agent](/docs/chat): connect a model or an agent CLI, let it [work on a branch](/docs/chat#work-on-a-branch) and
  [fix several comments at once](/docs/chat#fix-several-comments-at-once). In a shared thread it answers
  [when someone asks it](/docs/chat#when-an-agent-answers).
- [Capture on pull requests](/docs/pull-requests): one comment on each pull request with what changed, before and after.
- [Agent recipes](/docs/agent-recipes): copy-paste commands for Claude Code, Codex, goose, Ollama and chat bots.
- [GitHub connect](/docs/github) and [notifications](/docs/notifications): issues and pull requests from comments, and messages to a
  webhook, Slack, Discord, Telegram or email.
- [Sandboxed starter agent](/docs/starter-agent) (experimental): let an agent work on comments from a shared board, inside a
  container.
- [What an agent can do](/docs/agent-capabilities): what your agent may do on each turn (solo, team, open), its named commands,
  sandboxed shell and throwaway browser, and how to change each line.
- [Agent hardening](/docs/agent-hardening): connect an agent to a shared board safely, with a printable checklist.
- [Security model](/docs/security): why captured pages can never run code.
- [Page checks](/docs/page-checks): reliability, SEO, social images and report comparisons, with
  [Lighthouse audits](/docs/performance) and [interaction flows and accessibility](/docs/interaction-audits) on their own pages.
- [Capture warnings and pacing](/docs/capture-warnings): API failures and rate limits alongside usable screenshots.
- [Local accounts and profile photos](/docs/local-accounts) and [manual updates](/docs/updates).
- [Where to run Shapewall](/docs/where-to-run) and [deployment and self-hosting](/docs/self-hosting): a local board or a team
  server, Docker and static exports.
- [Hosted operator guide](/docs/hosted) (beta): run a team server with passkey accounts, workspaces, roles and share links.
- [Monitoring your server](/docs/monitoring): the health check, logs, opt-in error reports and what to check when something breaks.

## Versions and licenses

These docs describe the current release. [Stability and versioning](/docs/stability) says what stays the same within 1.x and
what is marked experimental. The local tool is open source under Apache 2.0; the self-hosted team server (`shapewall
hosted`) is source-available under the Functional Source License and becomes Apache 2.0 two years after each release. See
[licenses and self-hosting](/open-source).
