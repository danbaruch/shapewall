Start with a running site, choose its pages, capture them and open the wall.

## Install

<!-- prelaunch -->

**Private early access:** the GitHub repository is invite only for now, so the commands below need a GitHub account that has been
invited (a GitHub 404 means the signed-in account has no access). The [live demo](/demo/) needs no access.

<!-- /prelaunch -->

Use **Node.js 22.13 or newer**. Basic capture works on any Node 22; local accounts and the team server need 22.13.

Platforms: Shapewall is developed and tested on Linux. macOS should work and is not yet verified by the maintainers. Windows is
untested; the PowerShell lines in these docs are a convenience. If you run it on macOS or Windows, please
[open an issue](https://github.com/danbaruch/shapewall/issues) with what worked and what did not.

### In your project

```sh
npm install --save-dev %INSTALL_PACKAGE%
npx shapewall doctor --install-browser
npx shapewall init --base-url http://localhost:3000
npx shapewall capture
npx shapewall serve --open
```

In an empty folder, run `npm init -y` first. `npx shapewall` runs the copy installed in the project. The rest of these docs shorten
the command to `shapewall`. To try it without adding it to a project, the same `npx shapewall ...` lines work on their own: npx
downloads the package the first time.

### From GitHub

For a build that is not released yet, install from the repository instead: `npm install --save-dev github:danbaruch/shapewall`
(add `#<commit or tag>` to pin one). That takes a minute, because npm clones the repository and builds the board.

### From a clone

```sh
git clone https://github.com/danbaruch/shapewall.git
cd shapewall
npm ci        # installs the locked dependencies and builds the board
npm link      # optional: puts `shapewall` on your PATH
```

Without `npm link`, run `node /absolute/path/to/shapewall/bin/shapewall.js` from your project. A global install straight from GitHub
(`npm install -g github:...`) does not work, because npm cannot build a git package in global mode; use the clone.

### The browser

Captures use Chromium. `shapewall doctor --install-browser` downloads the Playwright build this version needs (no config required);
it does not install Linux system libraries, so on a bare Linux server use the repository's Playwright-based Docker image instead. To
use a Chrome you already have, set `"browser": { "channel": "chrome" }` in the config. `shapewall doctor` then starts the browser and
checks the config, output folder, port and notifications. See [deployment](/docs/self-hosting).

## Console, accounts and updates

`shapewall serve` has a **Workspace Console** at `/console` that lists your local boards; open it from the profile menu. The version
at the bottom of the board opens **About & Updates**. Updates are manual: see [manual updates](/docs/updates).

Accounts are optional. `shapewall serve --accounts` adds a local owner account with a passkey: open the private owner link the server
prints, create the passkey and save the recovery codes, which are shown once. Use the printed `localhost` address, not an IP, because a
passkey is bound to a hostname. The profile menu then has **Account and security**: profile photo, sessions, passkeys and recovery.
Accounts keep your existing captures and comments. See [local accounts and profile photos](/docs/local-accounts).

On a Tailscale account board, agent settings are changed from the Shapewall computer with the **Host agent settings** command the
server prints: [local account setup](/docs/local-accounts#tailscale-account-origin) and
[host-only agent management](/docs/chat#host-only-agent-management).

## Create a config

In the project you want to review:

```sh
shapewall init --base-url http://localhost:3000
```

This writes `shapewall.config.json` in the current folder and adds `.shapewall/` (captures and comments), `shapewall-export/` (static
exports) and `*.auth.json` (login state) to your `.gitignore`. With your site running, `init` finds its pages: `<base URL>/sitemap.xml`
if there is one, else the links on the home page (two levels deep, up to 25 pages, same site only, plain GETs without cookies). If
the site is not up, it writes just the home page and tells you to start it and run `init --force` again. `--sitemap URL|FILE` takes
another sitemap and `--no-discover` skips the lookup. To add or change pages, edit the file:

```json
{
  "title": "My site",
  "baseUrl": "http://localhost:3000",
  "groups": ["Marketing", "App"],
  "pages": [
    { "id": "home", "path": "/", "title": "Home", "group": "Marketing" },
    { "id": "pricing", "path": "/pricing", "title": "Pricing", "group": "Marketing", "waitFor": ".plans" },
    { "id": "settings", "path": "/settings", "title": "Settings", "group": "App", "note": "Sample data" }
  ]
}
```

Each page needs an `id` (lowercase, dashes) and a `path`. `group` decides which section of the wall it sits in, and `note` is shown
on the tile, handy for "signed-out state" or "sample data". `waitFor` is a selector that must be visible before the shot.

The board takes its title from the home page's `<title>` (else the domain of `--base-url`); rename it with `title`. A running `shapewall serve` picks up edits to the
file (title, pages, journeys) on the next refresh of the board, no restart needed.

## Capture

Start your site, then:

```sh
shapewall capture
```

Every page is captured at desktop and phone width. A run prints one line per shot and a summary (with any links on your pages that
lead to an error), and exits with `0` when every shot worked, `2` when some failed and `1` on errors. A failed run keeps your
previous captures. A page that should answer with an error, such as your 404 page, gets `"expectStatus": 404` and is captured like
the rest. In CI, `shapewall capture --json` prints a machine-readable summary.

To recapture only what changed:

```sh
shapewall capture --only pricing --only /settings
```

A shot can succeed while one of the page's API calls failed or was rate limited (HTTP 429). The frame then shows a **Network** badge;
slow captures down with [capture pacing](/docs/capture-warnings) when a site limits requests.

For signed-in pages, run `shapewall auth record`: sign in by hand in the fresh browser it opens, press Enter to save, and add the
`auth.storageState` line it prints to your config. See [auth](/docs/config#auth).

## Open the board

```sh
shapewall serve
```

Open [http://127.0.0.1:4600/](http://127.0.0.1:4600/) (or add `--open` and Shapewall opens it for you). Scroll or drag to pan (Shift+scroll goes sideways, Space+drag and middle-drag work anywhere), Ctrl+scroll (Cmd+scroll on a Mac) or a pinch to zoom. Zoom in on a page and it switches
from a screenshot to live HTML. Click **Comment**, click an element on the page, write what should change.

## Fix a comment with your agent

Put `shapewall.config.json` in the checkout the agent should edit and run `shapewall serve` there: the agent works in the folder the
config is in, shown as **Source folder on the Shapewall computer** in **Settings > Agent**. Every board in that config shares it. For
several repositories, serve one project per checkout and switch between them in the project dropdown.

1. Capture the state you want reviewed. For a signed-in page, run `shapewall auth record` first.
2. Pin a comment to the element that should change, on the desktop or phone frame where you see the problem.
3. Connect your agent: click **Connect** next to the agent CLI the board found, or set up an endpoint in Settings.
4. Press **Fix with agent**, answer its permission requests, and read the diff. The board recaptures the pages it changed.
5. Check before and after in the comment's thread, then resolve it. If the agent's sign-in or model fails, the turn says so and waits.

More in [chat with an agent](/docs/chat#source-folder-and-agent-sign-in).

## Try the demo first

The repository ships a small demo site. From a [clone](#from-a-clone):

```sh
npm ci
node bin/shapewall.js doctor --install-browser
npm run demo
```

The clone has no `shapewall.config.json` of its own (the demo brings one), so `doctor` only installs the browser here and skips the
config check. That captures the demo site (a fictional notes app) and serves its board at the same address. Leave a few comments and try the loop.

## Next steps

- Signed-in pages, menus that need a click first, more viewports: [config reference](/docs/config).
- Hand the comments to your coding agent: [the agent workflow](/docs/agent-workflow).
- Share the board with a team: [deployment and self-hosting](/docs/self-hosting).
