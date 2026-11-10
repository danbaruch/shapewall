# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## 0.2.3 - 2026-11-10

- The agent's model and thinking level are shown on a new chat before the first message, each with its own menu in the composer
  footer. Choices are kept per chat, and each answer shows the model it used.
- Agents has its own section in the workspace console, with connected agents and the chat connection on one page.
- The top bar shows which side panel is open, and the Comment button is filled only while comment mode is on.
- The board sidebar lists Account and security, like the console's.
- A calmer card when an agent is not signed in, with the command to run and a Check again button.
- Security reports can also go to hello@shapewall.com.

## 0.2.2 - 2026-11-10

- The collapsed sidebar opens flyouts: hover or click Pages for the full pages tree, or Workspace and Account for their sections,
  without expanding the whole sidebar.
- A new agent picker shows each connected agent with its state and your default. "Fix with agent" names the agent and, with more
  than one connected, lets you run a fix with another. Settings gains an Agents card to connect agents, pick the default and test them.
- The board's top bar is arranged in three groups: where you are and how you view it on the left, search in the centre, comment and
  panels on the right. It gives up space in a fixed order as the window narrows.
- Fixed: a brief flash of a few oversized cards before the board settled on its starting view.
- The demo has two scripted agents, so the picker can be tried there.
- A Contact link in the profile menu and beside About opens the contact page on shapewall.com.

## 0.2.1 - 2026-11-10

- On npm: `npm install --save-dev shapewall` or `npx shapewall`. Installing from GitHub still works for unreleased builds.
- Fixed: the `shapewall settings` page loads its theme script and icon when Shapewall is installed under a folder whose name starts
  with a dot (such as `~/.local`), so it follows your light or dark preference.
- Website: shapewall.com has a dark mode, with a System, Light and Dark choice.
- Docs: self-hosted multiplayer (`shapewall hosted`) is labelled beta, with what that means; the security docs list known limits.
- Security: a review of the starter agent, the MCP server and the remote client. `push` and `share` no longer follow symlinks out of
  the captures folder, `watch --remote` no longer writes through one, MCP results carry the same untrusted-data framing as
  `comments --json`, answers from a hosted server are size-capped, and the starter agent closes gaps in its limit caps, its
  pull-request guard and its cleanup. The security docs gain a Known limits section.
- The live HTML view keeps the colour scheme it was captured in instead of following the viewer's dark mode.
- Connecting an agent from the Agent panel and from Settings now gives one list of agents; a chat can switch to another connected
  agent when the first is not signed in, and a failed sign-in no longer posts on the comment.
- The comment-mode banner no longer covers the focused page's toolbar.
- Capture and `doctor` say when Chromium is installed but missing system libraries (bare Linux, containers, WSL).
- `init --base-url` finds your site's real pages (its sitemap, else the links on its pages) instead of writing sample pages.
- CI runs lint, unit tests, the build and the package check on every pull request.

## 0.2.0 - 2026-11-09

The first public release. Shapewall is now Apache 2.0 (it was MIT), with the self-hosted team server in `src/hosted` under the
Functional Source License 1.1 (Apache 2.0 after two years).

### Capture

- Your own viewports beside desktop, tablet and phone (`phone-landscape`, ...), with `layoutHeight`, `mobile`, `touch` and
  `userAgent`; a board can have its own set.
- Apps and games, not just landing pages: actions `tap`, `mouse`, `hold`, `keyDown`/`keyUp` and `waitForFunction`; `optional`,
  `viewports`, `timeout` and `force` on any action; a board `setup` that runs once per viewport and whose state the pages reuse;
  `localStorage` seeds; `block` request lists with a built-in `"analytics"` list; `reducedMotion`; per-page `timeout` and `frameHeight`.
- `shapewall auth record`: sign in by hand in a fresh browser and save the session for captures. Boards can have their own `auth`.
- Environments (`capture --env`) and a compare mode with pixel diffs; variants beside a page; previous captures kept per page
  (`versions`) for before and after and for page history.
- `shapewall sitemap` and `init --sitemap` fill the page list from a sitemap.
- Broken-link checks on every capture (`links --broken`, `--check-external`), `"expectStatus"` for pages that should answer with an
  error, `capture --json` for CI, and a named step in every capture failure.
- Capture warnings: API errors and HTTP 429s are counted beside the shots that still worked, and `capturePacing` slows captures down.
- A page scrolled by `scrollTo` or an in-page link is shot where it was scrolled to, not at the top.

### Board

- Journeys, with forks and branches, in the config or made on the board; **Links** draws the links between your pages.
- Page history with a pixel diff, before and after on resolved comments, "Go to page", page search.
- Comments: threads, @mentions, emoji reactions, reopen, search and filters, avatar pins with unread dots.
- Canvas navigation like Figma: wheel pans, Shift+wheel pans sideways, Ctrl/Cmd+wheel or a pinch zooms at the cursor.
- Light and dark themes, keyboard navigation, a phone layout with 44 px targets, installable as an app.
- A project dropdown that switches between the local projects you are serving; config edits apply without a restart.
- A Workspace Console and an About & Updates panel; updates stay manual ([docs/updates.md](docs/updates.md)).
- Optional local owner account with a passkey, recovery codes, sessions and a profile photo (`serve --accounts`).
- Your own other devices: `serve --tailscale` and `serve --lan` with pairing, and `shapewall devices` to approve and revoke.

### Agents

- `shapewall watch` hands each new comment to an agent exactly once; `shapewall mcp` gives agents tools; `comments add`, `reply`,
  `status`, `resolve` and `events --follow` cover shell-only agents and chat bots. `--for-agent` quotes comments as untrusted data.
- Chat on the board with your own agent: any OpenAI-compatible endpoint, or Claude Code, Codex, goose and Gemini CLI over ACP, with
  one-click connect for the CLIs found on your machine, approval cards with diffs, images, voice in and read aloud.
- Fix with agent: the agent changes the code in your checkout, the board recaptures the pages and shows before and after.
- A chat composer with `@` mentions, `/` commands, file attachments and queued follow-ups.
- The sandboxed starter agent for shared boards (`shapewall agent run|watch|doctor|build-image`): a container with one checkout, an
  egress allow list, budgets and a branch or pull request as its output.
- `shapewall settings`: change agent settings from the Shapewall computer without opening the board.
- Guides: [agent workflow](docs/agent-workflow.md), [recipes](docs/agent-recipes.md) and [hardening](docs/agent-hardening.md).

### Team server (self-hosted)

- `shapewall hosted`: passkey accounts with recovery codes, workspaces with four roles, invitations, an audit log, export and deletion.
- Share links for people without an account (view or comment, expiry, passcode), opt-in public projects, live presence and cursors.
- `shapewall share` moves a local project to the server; `login` and `push` upload captures; `comments`, `watch` and `mcp` take
  `--remote`; project-scoped agents with trusted dispatch, budgets and passkey approvals.
- Tailscale setup in one flag, optional Funnel for share links, `hosted --setup` for your own domain (Compose and Caddy), quotas,
  retention, `hosted backup` and `restore`, and moving the server to a new origin.

### Integrations

- GitHub connect: an issue from a comment, pull requests linked by `shapewall:12`, comments resolved when the PR merges.
- Notifications: signed webhook, Slack, Discord and email, with mentions routed per person.
- Page checks: reliability, SEO and social image probes (`shapewall checks`), Lighthouse lab audits (`shapewall audit`),
  accessibility and interaction audits, report comparisons and budgets ([docs/page-checks.md](docs/page-checks.md)).
- An optional bridge to agents in a Buzz chat channel ([docs/buzz.md](docs/buzz.md)).

### CLI and packaging

- `shapewall <command> --help`; unknown options are errors with a "did you mean" hint; errors name the bad value.
- `shapewall doctor` checks Node, the browser, the config, the port, notifications and the agent; `--install-browser` gets Chromium.
- `shapewall export` includes compare data and can let visitors comment in their own browser (`--browser-comments`).
- Runtime dependencies are pinned to exact versions, so an install from GitHub or a tarball gets what was tested.
- A Docker image on the pinned Playwright base, and `docker-compose.example.yml`.

### Security

- Comment JSON is marked `trust: "untrusted"`; board text reaches agents as quoted data, never as instructions.
- Local agent: a board opened without the private owner link can no longer chat with an ACP agent or approve its command cards.
- Config from a cloned repository is trusted less: `browser.executablePath` cannot point inside the project folder, capture prints a
  notice before it runs a login script named in the config, an email channel's `apiKeyEnv` must be `RESEND_API_KEY` or `SHAPEWALL_*`,
  and a `github.apiUrl` only receives your token when `SHAPEWALL_GITHUB_API_URL` is set to the same URL.
- Capture refuses a public hostname that resolves to a private address.
- Buzz bridge: no built-in signer file paths. It stays off until `signerFiles` (or `SHAPEWALL_BUZZ_SIGNER_CODEX` and
  `SHAPEWALL_BUZZ_SIGNER_CLAUDE`) names both files.
- Device pairing keeps at most five pending requests; a sixth replaces the oldest.
- Team server: an API token works only while its creator is still an admin or owner. **Send to agent** and **Approve agent run**
  refuse a comment edited since you opened it. Agents never receive share-link guests' replies unless run with `--include-guests`.
  Command approvals and denials are in the audit log. Only admins set an agent status from the board. Turning public projects off
  clears every public URL for good. The console and board APIs are rate limited per account (1200 requests a minute, 6000 for files).
- The live HTML sanitizer's CSS scans are linear in the input size.

## 0.1.0 - 2026-11-03

First version.

- `shapewall init`, `capture`, `serve`, `comments`, `variant` and `export` commands.
- Playwright capture at configurable desktop, tablet and phone viewports: fixed-frame PNG, thumbnail, and sanitized live HTML with
  inlined CSS (responsive rules kept), images and fonts.
- Three-layer live HTML sandbox: allowlist sanitizer, strict CSP (header and meta tag), `sandbox="allow-same-origin"` frame.
- React Flow board: groups, desktop/phone/both modes, thumbnails when zoomed out, live HTML when zoomed in or opened, minimap.
- Comments pinned to elements on live HTML (selector + text fallback), resolve, reopen, delete, filters, per-page notes.
- Variants beside their page.
- Phone layout with 44 px targets, a comments sheet, and Back closing the topmost overlay.
- Capture lock with stale-lock takeover; atomic JSON storage with a file lock for concurrent writers.
- Agent-friendly `shapewall comments --json` with selectors, positions and screenshot paths.
- Bundled demo site, unit and end-to-end tests, CI workflow.
