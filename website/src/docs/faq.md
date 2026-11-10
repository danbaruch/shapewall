## Does it work with single-page apps?

Yes. The capture snapshots the rendered DOM after your `waitFor` selector and `actions` run, so client-rendered content is in both the
screenshot and the live HTML. Scripts are removed, so the live HTML is a frozen state, not a running app: menus that only open with
JavaScript stay closed unless an action opens them before the shot.

## Why fixed-height frames instead of full-page screenshots?

Comparable tiles on one canvas, predictable memory, and the top of a page is what reviewers look at first. Make the viewport `height`
larger for long pages, give one page its own `frameHeight`, or add a second page entry with a `scrollTo` action for the part further
down.

## My site needs a login.

Run `shapewall auth record`: sign in by hand in the fresh browser it opens, press Enter to save, and add the `auth.storageState` line
it prints to your config. For automation, an `auth.loginScript` that reads credentials from environment variables does the same job.
Use a test account with the least access the pages need, and never commit the saved state. See
[the config reference](/docs/config#auth).

## Are captured pages safe to share?

Live HTML drops hidden inputs, password values, scripts and data attributes that could carry tokens, and links to private hosts are
removed. Screenshots show exactly what the page showed, so capture with test data. Details in [the security model](/docs/security).

## Can I use Firefox or WebKit?

Not yet. Captures currently use Chromium, and thumbnails depend on a Chromium DevTools call.

## Where is my data?

In `outputDir` (default `.shapewall/`): PNGs, HTML snapshots, `manifest.json`, `comments.json`, `variants.json`, `journeys.json`,
earlier captures in `versions/`, other environments in `envs/`, cached diffs in `diffs/` and `agent/` (what `shapewall watch` ran).
Board files use atomic writes. Optional [local accounts](/docs/local-accounts) also store account data in SQLite under
`outputDir/.accounts`. A [self-hosted team server](/docs/hosted) keeps SQLite account/workspace data and uploaded files in its
configured data directory; follow its operator backup procedure.

## Does Shapewall send anything anywhere?

Not by itself. Shapewall runs on your machine and has no telemetry and no account. Captures and checks load your configured pages
and their resources. What you connect receives what you send it: an agent endpoint gets the chat and the comments you hand it,
notifications go to your webhook, Slack, Discord or email, GitHub connect talks to GitHub, and `push` or `share` upload to the team
server you chose. Setup can also download a browser, and the natural read-aloud voices download a model once. See the
[privacy page](/privacy) for how this website differs from the tool.

## Which coding agents does it work with?

Any agent that can run a shell command and read JSON: Claude Code, Codex, and others. Agents that speak MCP can use `shapewall mcp`
instead, and `shapewall watch` can start any command-line agent for each new comment.

## Is there a hosted version?

You can host it yourself today: `shapewall hosted` gives a team passkey sign-in, workspaces, roles and shared boards on a server you
run. It is in beta: it works and is tested with automated browsers, but it has not yet had a real multi-person team on it or real
phone passkeys verified, so run it for people you trust and keep backups. [The hosted guide](/docs/hosted) covers setup. A service run by us on shapewall.com is planned and has not launched.

## How do I capture many pages quickly?

Raise `concurrency` (1 to 8, default 2). Each concurrent page is a browser context of roughly 100 to 300 MB, so a laptop is happy at 2
and a large machine can do more. Use `--only` to recapture just the pages that changed.

## How is this different from a screenshot or visual-diff tool?

Those tell you that something changed. Shapewall is for deciding what should change, saying so on the exact element, and getting it
built: the whole product on one wall, comments an agent can act on, and before and after where you asked.
