# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## 0.3.2 - 2026-11-11

- A comment or a reply can be a drawing or images with no text. Before, Post and Send stayed off until you typed something, and
  closing the thread threw the drawing away. A comment with no text, no image and no drawing is still refused. Where a line of text
  is needed (the comments list, notifications, `shapewall comments`, what an agent reads) such a comment shows as `(drawing)`,
  `(image)` or `(2 images)`; in `--json` its `body` is `""` and the `drawing` and `files` fields say what it has. The same on the
  hosted server and in the demo.
- A reply you started and did not send (its text, drawing and images) is still there when you close the thread and open it again. It
  is kept in the page only: a reload starts clean, and sending or emptying the reply clears it.
- Resolving a comment ends its agent status, however it is resolved (the board, `shapewall comments resolve`, the API, MCP): `queued`
  and `working` become `done`, and `needs-human` is cleared. Before, `comments resolve` left a comment showing
  `[resolved] [agent: working]`. Resolving such a comment now sends an agent status event after the resolved one. Reopening clears the
  status, as before.
- `shapewall comments add --selector` puts the pin in the middle of the element when the selector finds exactly one element in the
  latest capture, as a click there on the board would. Before, the pin always sat near the top-left corner. Without `--selector`, or
  when the selector finds no element or several, the pin stays near the corner and a note says so.
- New `shapewall comments selectors --page ID [--viewport NAME] [--text WORDS]` lists the selectors `--selector` takes, each with its
  element's text, from the latest capture. The error for a selector in the wrong form (a class, say) now names this command.

## 0.3.1 - 2026-11-10

- Starter agent: the push of the agent's branch no longer follows settings in the repository's Git config that would run another
  program. The transport is limited to https, http, ssh and local paths (no `ext::` or other remote helpers, whatever
  `protocol.*.allow` says), `remote.<name>.receivepack` is ignored, and the push is never signed. Your credential helper and ssh setup
  are still used: that is how the push reaches your remote.
- `shapewall init --ci` gives the comment job `contents: write` when the config has `"ci": { "images": "branch" }`, so the images
  branch can be pushed. Before, the generated workflow always had `contents: read` and the comment fell back to links.

## 0.3.0 - 2026-11-10

- Agent works on a branch: an option, off by default, that runs an ACP agent's fixes and chat turns in a copy of your checkout and
  commits them on a branch of their own. The comment reads "Fix ready on branch", and the chat offers Apply to my checkout, Open
  folder, Copy branch name and Discard. Apply recaptures the page with before and after; a conflict changes nothing. See
  "Work on a branch" in docs/agents.md.
- The Agents page of the Workspace Console has a How fixes run card: the Work on a branch switch with its branch prefix (the same
  setting as the chat's switch), and the batch fixes switch with its limit. A change to either shows in every open view.
- Batch fixes: an option, off by default, to fix several open comments one after another. In the comments panel choose Select, tick
  comments (or Select all, up to the limit) and Fix N with the agent; a dialog lists them first. Each comment is an ordinary fix with
  its own thread, approvals, recapture and Undo, and in branch mode its own branch. A card in the chat and a strip in the comments
  panel show "Fixing 2 of 5" and each comment's state, also after a reload. The batch waits for an approval, stops on Cancel and after
  two failures in a row. Set `"agent": { "batchFixes": { "enabled": true, "max": 5 } }` (at most 20) or use the Agents page. Not on
  the hosted server. See "Fix several comments at once" in docs/agents.md.
- `shapewall doctor` reports agent branches left in the project.
- Capture on pull requests: `shapewall init --ci` writes a GitHub Actions workflow that captures the base branch and the pull request,
  compares every page and screen size with the pixel diff, and keeps one comment on the pull request up to date ("Shapewall: 4 of 23
  pages changed") with the changed share and before, after and diff images. It builds and serves both sides from `ci.start` in the
  config, or captures a deploy preview URL. Pull requests from forks get the summary in the job summary instead. Turn it off by
  deleting the workflow, with `"ci": { "enabled": false }`, or with `[skip shapewall]` in the title. See docs/pull-requests.md.
- New commands: `shapewall ci capture-compare`, `ci capture`, `ci comment`, `ci enabled` and `ci wait`.
- Images on comments and replies: attach up to 4 (PNG, JPEG, WebP or GIF, 5 MB each) with a button, by pasting or by dropping them.
  The server checks each image by its bytes, strips its metadata and serves it only as an image; the thread shows thumbnails that open
  large. The comments list shows how many a thread has.
- Drawing on the page as part of a comment or reply: boxes, arrows and pen strokes in three inks, with Undo and Clear. The drawing
  shows over the page while its thread is open, and over "before" once the page is recaptured. On a phone you draw on the page in a
  full-screen sheet.
- Agents get the images and a picture of the drawing on its screenshot: in `comments --json` (`files.images`, `files.markup`), the MCP
  `get_comment` tool, `watch --exec` and Fix with agent.
- Hosted boards keep comment images in the database, count them against the storage quota and include them in exports and in
  `shapewall share`. Share link guests can draw but not attach images.
- The demo takes images and drawings in the browser and shows example comments with an image and a drawing, one of them with a fix
  ready on a branch. Its Agents page has the How fixes run card, and its scripted agent runs batch fixes.
- While you draw on a page, the collapsed sidebar's flyouts stay closed and the journey bar is hidden, so nothing covers the drawing
  bar.

## 0.2.4 - 2026-11-10

- The top bar's View button is now Views: pick a journey by name there, alongside links, compare and the minimap. An open journey
  shows its name in the top bar with a button to leave it. J and Shift+J step through journeys.
- An open journey's name comes before the search box in the top bar: the search becomes an icon and the name shows in full up to
  about 280 px.
- The sidebar has a Pages | Journeys switch, and collapsed, an icon for each; the Journeys icon shows a dot while a journey is open.
- Agent settings stay in sync everywhere: a change in another tab, the Agents page, `shapewall settings` or the agents file shows up
  in every open view without a reload, and never over unsaved typing.
- The demo's Agents page is the full page, with sample agents in every state.
- Releases are published to npm from CI with provenance.

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
