## Does it work with single-page apps?

Yes. The capture snapshots the rendered DOM after your `waitFor` selector and `actions` run, so client-rendered content is in both the
screenshot and the live HTML. Scripts are removed, so the live HTML is a frozen state, not a running app: menus that only open with
JavaScript stay closed unless an action opens them before the shot.

## Why fixed-height frames instead of full-page screenshots?

Comparable tiles on one canvas, predictable memory, and the top of a page is what reviewers look at first. Make the viewport `height`
larger for long pages, give one page its own `frameHeight`, or add a second page entry with a `scrollTo` action for the part further
down.

## Can it capture pages behind a login?

Run `shapewall auth record`: sign in by hand in the fresh browser it opens, press Enter to save, and add the `auth.storageState` line
it prints to your config. For automation, an `auth.loginScript` that reads credentials from environment variables does the same job.
Use a test account with the least access the pages need, and never commit the saved state. See
[the config reference](/docs/config#auth).

## Are captured pages safe to share?

Live HTML drops hidden inputs, password values, scripts and data attributes that could carry tokens, and links to private hosts are
removed. Screenshots show exactly what the page showed, so capture with test data. Details in [the security model](/docs/security).

## Can I use Firefox or WebKit?

No. Captures use Chromium, and thumbnails depend on a Chromium DevTools call. Use Playwright's Chromium or a Chrome you already have.

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

Any agent that can run a shell command and read JSON, including Claude Code, Codex and goose. Agents that speak MCP can use
`shapewall mcp` instead, and `shapewall watch` starts any command-line agent for each new comment. Shapewall includes no model of
its own. Setups for each agent: [agent recipes](/docs/agent-recipes).

## Can my team use it together?

Yes, on a server you run. The team server (beta), started with `shapewall hosted`, gives your team accounts (a passkey each, or on your tailnet your tailnet login), workspaces with
roles, share links and shared boards. Teammates can also chat on the board with Claude Code, connected from the machine that
has the code (`shapewall agent connect`): by default it reads the project and answers, and does not change files or run commands
from the board. Other agents are not offered for chat in this release; they take comments through `shapewall watch --remote`. [The hosted guide](/docs/hosted) covers setup.

## Can an agent change my code from a hosted board?

Only when the machine that has the code says so. A connected agent reads and answers by default. Edits are switched on there,
with `shapewall agent connect --approvals owner` (the person who connected it allows each edit) or `--approvals admins`. Then
**Fix with** on a comment starts a fix, and each edit the agent asks for is shown on the board as a card with the path and the
full diff, with Allow and Deny. The server cannot switch this on, and chat messages never edit. A connected Claude Code runs no
commands from the board in this release. See [the hosted guide](/docs/hosted#edits-from-the-board-the-trust-decision).

## Where does a fix end up?

On a new branch, never in the checked-out tree. The agent works in a fresh copy of the base commit, in a folder outside the
project on its own machine. Shapewall commits the result on a branch named `shapewall/comment-<n>-<slug>`, and keeps the commit
only if it is exactly what was allowed. The branch is pushed when that machine has the remote and the change touches nothing that
runs on install, build, test or CI and a person saw every edit, and a pull request is opened when [GitHub connect](/docs/github) is set up there. Otherwise the thread says "Fix ready
on branch" with the name to copy. The folder is removed afterwards; the branch stays. You review and merge it like any other.

## Who can approve an agent's edit?

Someone with the agent's answer role (admin by default), who is also in the agent's audience and trusted by the project's agent
policy. When the agent's machine was started with `--approvals owner`, only the person who connected it. Being signed in with
that role is enough; a workspace's owner can switch on "ask for a passkey again" before Allow. Deny never asks. A card waits 2 minutes and is answered once, and the agent's machine checks every
answer again before it counts.

## Do I need a passkey to sign in to a team server?

Not on your tailnet. Start the server with `shapewall hosted --tailscale --tailnet-sign-in` and your tailnet login is the sign-in:
no passkey and no password. An admin still invites each login with a role, so being on the tailnet alone gives nothing. On a
server reached through your own domain, or a tailnet server without that flag, everyone signs in with a passkey. See
[Signing in](/docs/hosted#signing-in).

## How often does it ask for my passkey?

Rarely. Signed in with the right role is enough for the daily work: approving agents, tokens, share links, an agent's edits. A
few things always ask (your passkeys and recovery codes, deleting an account or a workspace, changing owners), and a workspace's
owner can switch on more in Settings.

## Can I set up a team server and join one from my coding agent, without a browser?

Yes, on a server with tailnet sign-in. The owner runs `shapewall hosted claim --login <their tailnet login>` on the server's
machine, then, on another tailnet device, `shapewall admin projects create` and `shapewall login` (the server's own machine is
never signed in by its tailnet identity). A teammate runs `shapewall join` and `shapewall agent connect`. The server knows each
machine's tailnet user, checks their role and writes the audit entry. See
[From your coding agent](/docs/hosted#from-your-coding-agent).

## What does it need to run?

Node.js 22.13 or newer and Chromium, on Linux, macOS or Windows; Linux is the primary tested platform. `shapewall doctor
--install-browser` downloads the Chromium build, or you can use a Chrome you already have. See [install](/docs/getting-started#install).

## How is Shapewall licensed?

The local tool is open source under Apache 2.0. The self-hosted team server is source-available under the Functional Source License
and becomes Apache 2.0 two years after each release. See [licenses and self-hosting](/open-source).

## How do I capture many pages quickly?

Raise `concurrency` (1 to 8, default 2). Each concurrent page is a browser context of roughly 100 to 300 MB: 2 suits a laptop, and a
large machine can do more. Use `--only` to recapture just the pages that changed.

## How is this different from a screenshot or visual-diff tool?

Those show that something changed. Shapewall is for deciding what should change, saying so on the exact element and getting it
built: the whole product on one wall, comments an agent can act on, and before and after where you asked.

## Where do I send a question or a feature request?

Use the [contact form](/contact). Bugs you can reproduce go to GitHub issues, and security reports follow the security policy.
