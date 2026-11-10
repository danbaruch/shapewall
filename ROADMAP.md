# Roadmap

Where Shapewall stands. "Done" is what the code in this repository does today; "Now", "Next" and "Later" are plans in priority order,
not promises. Ideas and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).

Shapewall has two tracks. **Local** is a single-player tool on your machine: your dev server, your agent, no account. **Multiplayer**
is `shapewall hosted`: passkey accounts, workspaces and a scoped agent on a server you run. The local tool never needs an account.

Multiplayer is in **beta**: it works and is tested with automated browsers, but it has not yet had a real multi-person team on it or
real phone passkeys verified, so run it for people you trust and keep backups.

## Done

### Both

- On npm: `npm install --save-dev shapewall`, or `npx shapewall` with no install.
- Capture: Chromium at desktop, tablet, phone or your own viewports; fixed-frame PNG, thumbnail and sanitized live HTML (allowlist
  sanitizer, strict CSP, sandboxed frame); waits, actions, shared setup, signed-in pages, partial recaptures, run lock.
- Board: zoomable canvas by section, variants, phone layout, URL state, page search, installable (PWA), static export.
- Comments pinned to elements, threads, @mentions, reactions, resolve and reopen, search and filters, page history, before and after,
  journeys with branches, environment compare with pixel diffs, sitemap import.
- Page checks: opt-in reliability, SEO and social metadata probes, Lighthouse lab samples, accessibility and interaction audits,
  report comparisons, performance budgets and scoped sharing of reports on a hosted server. [Guide](docs/page-checks.md).
- Capture warnings: counts of API and HTTP errors and 429s beside the shots that still worked, with capture pacing.
- Agent loop: `comments --json`, `watch --exec` (exactly once), `shapewall mcp`.

### Local

- Chat with your own agent on the board: OpenAI-compatible endpoints, or Claude Code, Codex, goose and Gemini CLI over ACP, with
  per-command approval and project-only file access. The board finds installed agent CLIs and connects them with one click.
- Fix a comment with the local agent, recapture the changed pages and see before and after in its thread.
- Sandboxed starter agent (`shapewall agent`), GitHub connect, notifications (webhook, Slack, Discord, email).
- Optional local passkey owner account with recovery codes, sessions and a profile photo.
- `shapewall auth record`: sign in by hand in a fresh browser and save the session for captures.
- `serve --tailscale` and `serve --lan` for your own other devices, with pairing and revocation.
- Sitemap and title defaults, config reload without a restart, a dropdown to move between local projects.

### Multiplayer (self-hosted, beta)

- `shapewall hosted`: passkeys and recovery codes, workspaces with roles, invitations, an access overview, audit log, export and
  deletion.
- View and comment share links with expiry and passcodes, per-guest sessions, opt-in public projects, moving the server to a new
  origin.
- Live HTML in an opaque frame with element-map pins, and an optional separate origin for captured content.
- Project-scoped agents with trusted dispatch, budgets and passkey approvals; remote CLI, MCP over HTTP and live events.
- Tailscale-first setup, optional guest-only Funnel, Compose and Caddy files generated for your own domain, quotas, retention, backup
  and restore commands.
- `shapewall share` moves local captures, comments and history into a workspace; presence shows viewers, cursors and follow.

## Now

1. Verify macOS and Windows: run the local tool end to end on both and fix what breaks. Reports from either are welcome.
2. A real team trial of multiplayer, including passkey sign-in, home-screen sessions and live presence on iOS and Android phones, to
   take it out of beta.
3. Firefox and WebKit captures, beside Chromium.

## Next

- A shorter path from a comment to changed code on a local checkout: fewer steps to connect a native agent, and clearer messages
  when its sign-in or model is the problem.
- Pull requests from the board: have the agent's fix arrive as a branch and a PR you review, then recapture from its preview.
- Easier operations for a hosted server: backups and a health check set up as part of `hosted --setup`.

## Later

- Shapewall hosted on shapewall.com, for teams that would rather not run a server.
- A tunnel mode: your server, our URL.
- Captures on the server for verified sites, and managed sandboxed agents.
- A GitHub App in place of a personal token.
- Full-page captures.

## Not planned

- Running page JavaScript in the live view. A frozen, script-free snapshot is what makes it safe to frame.
- Bundling or calling a specific AI model in the local tool. Shapewall stays vendor neutral.
