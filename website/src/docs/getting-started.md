Start with your app running, then capture every screen and open the wall. Four commands get you there.

<!-- prelaunch -->

**Private early access:** the GitHub repository is invite only, so the commands below need a GitHub account with access (a GitHub
404 means the signed-in account has none). The [live demo](/demo/) needs no access.

<!-- /prelaunch -->

## Install

You need:

- **Node.js 22.19 or newer**, on Linux, macOS or Windows. Linux is the primary tested platform. Check with `node -v`.
- **Chromium for captures.** `shapewall doctor --install-browser` downloads the build Shapewall needs. To use a Chrome you already
  have instead, set `"browser": { "channel": "chrome" }` in the config and skip the download.
- **An app to point it at**, already running: your dev server, a preview deploy, staging or production.

### Linux system libraries

A Linux desktop usually has everything Chromium needs. A minimal install (a server, a container, WSL) does not: there
`shapewall doctor` reports "Playwright Chromium does not start". Install the libraries once, as root (put `sudo` in front if you
are not root).

On **Debian and Ubuntu**:

```sh
npx playwright@1.64.1 install-deps chromium
```

1.64.1 is the Playwright version Shapewall uses; `shapewall doctor` prints the same command, version included.

On **Fedora**, that command fails (it needs `apt-get`). Install the libraries with `dnf`:

```sh
dnf install nss atk at-spi2-atk cups-libs libxkbcommon libXcomposite libXdamage libXrandr mesa-libgbm pango alsa-lib
```

On **any other distribution**, the simplest answer is the official Playwright Docker image, which has Chromium and every
library it needs. Capture inside it, in your project folder (the image's version matches Shapewall's Playwright, 1.64.1):

```sh
docker run --rm --ipc=host --network host --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.64.1-noble npx shapewall capture
```

`--user` makes the files in `.shapewall/` yours instead of root's, `HOME=/tmp` gives npm a writable home for that user, and
`--network host` lets the container reach an app on your localhost. With rootless Podman, add `--userns=keep-id`. The wall itself
(`npx shapewall serve`) runs on the host as usual.

Or install the same libraries with the system package manager.

Then run `npx shapewall doctor --install-browser` again. It should say "Playwright Chromium starts".

## Quickstart

With your app running, in its project folder:

```sh
npx shapewall doctor --install-browser
npx shapewall init --base-url http://localhost:3000
npx shapewall capture
npx shapewall serve --open
```

1. `doctor --install-browser` downloads Chromium and checks that it starts. Before `init`, it skips the config check.
2. `init` writes `shapewall.config.json` with the screens it finds in your app.
3. `capture` takes every page at desktop and phone width.
4. `serve --open` starts the board on this machine (port 4600, at the project's own `*.shapewall.localhost` name it prints) and
   opens it in your browser as its owner, the tab that can connect an agent. With no browser on this machine it prints a one-time link instead: open it within 5 minutes.

The first `npx shapewall` asks to download the package ("Ok to proceed? (y)"): answer `y`. To keep one version for everyone on the
project, add it as a dev dependency first:

```sh
npm install --save-dev %INSTALL_PACKAGE%
```

In an empty folder, run `npm init -y` before that. `npx shapewall` then runs the copy installed in the project. The rest of these
docs shorten the command to `shapewall`.

The sections below go through each step in more detail.

## Create a config

In your app's project:

```sh
shapewall init --base-url http://localhost:3000
```

This writes `shapewall.config.json` in the current folder and adds `.shapewall/` (captures and comments), `shapewall-export/` (static
exports) and `*.auth.json` (login state) to your `.gitignore`. With your app running, `init` finds its pages: `<base URL>/sitemap.xml`
if there is one, else the links on the home page (two levels deep, up to 25 pages, same origin only, plain GETs without cookies). If
the app is not up, it writes just the home page and tells you to start it and run `init --force` again. `--sitemap URL|FILE` takes
another sitemap and `--no-discover` skips the lookup. To add or change pages, edit the file:

```json
{
  "title": "My app",
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

Start your app, then:

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
slow captures down with [capture pacing](/docs/capture-warnings) when an app limits requests.

For signed-in pages, run `shapewall auth record`: sign in by hand in the fresh browser it opens, press Enter to save, and add the
`auth.storageState` line it prints to your config. See [auth](/docs/config#auth).

## Open the board

```sh
shapewall serve
```

Open [http://127.0.0.1:4600/](http://127.0.0.1:4600/) (or add `--open` and Shapewall opens it for you). Scroll or drag to pan (Shift+scroll goes sideways, Space+drag and middle-drag work anywhere, and so does the **Hand** tool, H), Ctrl+scroll (Cmd+scroll on a Mac) or a pinch to zoom at the cursor; + and - (with or without Ctrl/Cmd) zoom too, Ctrl/Cmd+0 or Shift+0 goes to 100% and Shift+1 fits the board. Zoom in on a page and it switches
from a screenshot to live HTML. Click a page and press **Comment** on the bar that appears above it, or pick **Comment** in the tools at the bottom of the board (or press C). Then click an element on the page and write what should change.

### Images and drawings

A comment or a reply can show as well as tell:

- **Images.** Attach up to 4 with the image button, or paste or drop them into the comment. PNG, JPEG, WebP or GIF, up to 5 MB each.
  The thread shows them as thumbnails; click one to see it large (Esc closes it).
- **Drawing.** Pick **Box**, **Arrow** or **Pen** in the row along the bottom of the comment box and draw right on the page; pick an ink, **Undo** or **Clear**.
  Or start from the drawing: pick **Draw** in the tools at the bottom of the board and click a page. Either way the drawing is
  part of a comment. Esc stops drawing first, then leaves comment mode. On a phone, **Draw on the page** opens the page full
  screen to draw on with a finger.
- The drawing shows over the page while its thread is open or its pin is hovered. After a recapture it moves to the thread's before
  and after view, over the page as it was when it was drawn.

Your agent gets the images and a picture of the drawing on the screenshot with the comment. On a hosted board, guests on a share link
can draw but not attach images. A static export shows the images and drawings it was exported with; one that keeps comments in the
browser takes neither.

### Dictation

The microphone next to Post (or the send arrow) in the new comment, reply and edit boxes turns speech into text, in Chrome, Edge
and Safari (Firefox has no speech recognition, so there is no microphone there). Press it once and talk: the microphone fills, the
box's border takes the same colour and an empty box reads "Listening...". Nothing around it moves. Then the words appear at the
caret as you speak, or replace the text you selected, and settle as the browser is sure of them. Keep typing whenever you like.
Press it again, or Esc, to stop; posting, closing the comment and switching to another tab stop it too, and so do 30 seconds of
quiet. Nothing is posted until you post it. It listens in your browser's language. If something goes wrong (a blocked or missing
microphone, no speech, no network) a short note appears at the microphone (on a phone, across the top of the sheet) and goes by
itself.

The transcription is done by your browser's own speech service, not by Shapewall: in Chrome the audio goes to Google, in Safari to
Apple. Shapewall never receives or stores the audio, only the text you post. It only starts from a press, and the microphone's
tooltip says who does the transcribing. On a phone, the keyboard's own microphone works as well.

## Let your agent find the board

`shapewall init` writes a short Shapewall section into `AGENTS.md` (and a `CLAUDE.md` that imports it), so a coding agent opened in
the project knows the board is there. To give Claude Code and Codex the board's tools too:

```sh
npx shapewall agent setup
```

It shows what it would register and asks first. Then open Claude Code or Codex in the project and ask: "take the open Shapewall
comments". The agent hands you a link to what it changed; `npx shapewall open --comment 12` opens one yourself, and **Follow agent**
on the board keeps up with it while it works. Details: [your agent finds the board](/docs/agent-workflow#your-agent-finds-the-board)
and [links to the board](/docs/agent-workflow#links-to-the-board).

Prefer a plugin? The [Claude Code and Codex plugin](/docs/plugins) (experimental) installs the same MCP server plus skills. Use the
plugin or `agent setup`, not both.

## Fix a comment with your agent

Put `shapewall.config.json` in the checkout the agent should edit and run `shapewall serve` there: the agent works in the folder the
config is in, shown as **Source folder on the Shapewall computer** in **Settings > Agent**. Every board in that config shares it. For
several repositories, serve one project per checkout and switch between them in the project dropdown.

1. Capture the state you want to work on. For a signed-in page, run `shapewall auth record` first.
2. Pin a comment to the element that should change, on the desktop or phone frame where you see the problem.
3. Open the board as its owner: the tab `serve --open` opened (`shapewall serve --open` again, while it runs, opens a fresh
   one-time sign-in; `--print-owner-link` prints it instead).
4. Connect your agent: click **Connect** next to the agent CLI the board found, or set up an endpoint in Settings.
5. Press **Fix with agent** and read the diff. The board recaptures the pages it changed. The agent runs under its own permission
   settings: in a mode that asks (Claude Code's `default`), its requests show in the panel for you to answer; in one that acts
   without asking (Claude Code's `auto`, which `claude-agent-acp` 0.106.0 starts in when no mode is set), it edits and runs commands
   straight away. The panel names the mode in effect.
6. Check before and after in the comment's thread, then resolve it. If the agent's sign-in or model fails, the turn says so and waits.

More in [chat with an agent](/docs/chat#source-folder-and-agent-sign-in). From the terminal instead, `shapewall comments --open --json`
gives an agent the same comments with their selectors and screenshots, and `shapewall mcp` gives it tools: see
[the agent workflow](/docs/agent-workflow).

## Share the board

`shapewall serve` listens on 127.0.0.1 only and signs you in from the terminal, so at first it is yours alone. Start alone, and
invite people when you are ready:

- **A few people, while you work:** `shapewall serve --team` (or **Invite people** on the console's Members page) puts the same
  board on your tailnet for the people you invite, with tailnet sign-in and nothing copied; `shapewall serve --team off` takes it
  back. See [team mode](/docs/hosted#inviting-people-team-mode).
- **A read-only copy:** `shapewall export` writes a static copy any web host can serve. See [deployment](/docs/self-hosting).
- **A team:** `shapewall hosted` runs a server (beta) with accounts, workspaces, roles, share links and connected agents. Start with
  [where to run Shapewall](/docs/where-to-run), then the [hosted operator guide](/docs/hosted).

## Console, accounts and updates

`shapewall serve` has a **Workspace Console** at `/console` that lists your local boards; open it from the profile menu. The version
at the bottom of the board opens **About & Updates**. Updates are manual: see [manual updates](/docs/updates).

The board has one owner account, yours, made on the first start with your name (`SHAPEWALL_USER_NAME`, else `git config user.name`):
there is nothing to sign up for and no passkey to set up. Coming from 1.x? The first `shapewall serve` of 2.0 moves the project's
board into the engine, with a backup and a rollback, and a `serve --accounts` owner comes along with their passkeys: see
[upgrading from 1.x](/docs/upgrading).

## Other ways to install

### From GitHub

For the latest unreleased build, install from the repository: `npm install --save-dev github:danbaruch/shapewall` (add
`#<commit or tag>` to pin one). npm clones the repository and builds the board, which takes a minute or two.

### From a clone

```sh
git clone https://github.com/danbaruch/shapewall.git
cd shapewall
npm ci        # installs the locked dependencies and builds the board
npm link      # optional: puts `shapewall` on your PATH
```

Without `npm link`, run `node /absolute/path/to/shapewall/bin/shapewall.js` from your project. A global install straight from GitHub
(`npm install -g github:...`) does not work, because npm cannot build a git package in global mode; use the clone.

### In Docker

The repository's `Dockerfile` is based on the official Playwright image, so Chromium and its system libraries are already in it. See
[deployment](/docs/self-hosting).

## Try the demo first

The repository ships a small demo app. From a [clone](#from-a-clone):

```sh
npm ci
node bin/shapewall.js doctor --install-browser
npm run demo
```

The clone has no `shapewall.config.json` of its own (the demo brings one), so `doctor` only installs the browser here and skips the
config check. `npm run demo` captures the demo app (fictional notes software) and serves its board on http://127.0.0.1:4600/. Leave a
few comments and try the loop. `npm run demo -- --full` captures all 26 pages of that notes app; its Status page answers
404 on purpose and is captured as an expected error page (`"expectStatus": 404`), so every shot ends ok. The [live demo](/demo/) shows a bigger fictional app, Brackwell, with 146 screens and eight
journeys (`node scripts/demo-export.js` builds it).

## Next steps

- Signed-in pages, menus that need a click first, more viewports: [config reference](/docs/config).
- Hand the comments to your coding agent: [the agent workflow](/docs/agent-workflow), or the
  [Claude Code and Codex plugin](/docs/plugins).
- Every command and option: [CLI reference](/docs/cli).
- Share the board with a team: [deployment and self-hosting](/docs/self-hosting).
