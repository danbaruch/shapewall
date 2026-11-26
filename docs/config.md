# Config reference

Shapewall reads `shapewall.config.json` from the current folder (or `--config FILE`, or `$SHAPEWALL_CONFIG`). Relative paths in it are
resolved against the file's folder. `shapewall capture` and `shapewall serve` report every problem at once, with the JSON path of each bad
value.

A running `shapewall serve` watches the file and applies edits to `title`, the pages, groups, journeys, environments and sitemap of
each board (including a board's own `viewports`, `block`, `setup` and `auth`), `viewports`, `concurrency`, `capturePacing`, `timeouts`,
`block`, `reducedMotion`, `keepVersions` and `checks` on the next refresh of the board (a `checks` edit applies to the next **Run checks**). An edit with a problem is reported
in the serve log and the board keeps the last good config. `outputDir`, `boardUrl`, `auth`, `browser`, `liveHtml`, `agent`,
`starterAgent`, `commands`, `notifications` and `github` still need a restart (the log says so).

`ci` is in neither list, so an edit to it is not picked up and the log says nothing about it; `ci` is read by `shapewall ci` in its
own run, so a running board never uses it anyway.

A key Shapewall does not use (a typo like `"viewport"` for `"viewports"`, or a page key such as `waitFor` set at the top level) is
ignored, and `shapewall doctor`, `capture` and `serve` warn about it with the key it most likely meant; the config still loads.
Unknown keys are refused outright only inside `capturePacing`, `checks`, `setup`, `ci`, a named command, `agent.browser`, an action's options and a page's `seo`,
plus the secret, command and sandbox keys that `agent`, `github`, notification channels and `starterAgent` refuse. A required key under the wrong case (`"baseURL"`) is an error that
says to rename it. `$schema` is allowed anywhere.

## Top level

| Key             | Type                  | Default                             | Notes                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | --------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`         | string                | `"Shapewall"`                       | The config's title, on the board and in exports and hosted pushes. In a single-board config the board takes it too; a board with none is titled by its id.                                                                                                                                                                                                  |
| `id`            | string                | `"site"`                            | Board id for single-board configs. Lowercase letters, digits, dashes.                                                                                                                                                                                                                                                                                       |
| `baseUrl`       | http(s) URL           | required                            | Where pages are loaded from. May include a base path: `http://localhost:3000/app`.                                                                                                                                                                                                                                                                          |
| `publicUrl`     | http(s) URL           | none                                | Used for "Open page" links and to rewrite links in live HTML.                                                                                                                                                                                                                                                                                               |
| `outputDir`     | path                  | `.shapewall`                        | Captures, comments, variants and run state.                                                                                                                                                                                                                                                                                                                 |
| `concurrency`   | 1-8                   | `2`                                 | Pages captured in parallel. Each one is a browser context.                                                                                                                                                                                                                                                                                                  |
| `viewports`     | object                | desktop 1440x2200, phone 390x1800   | Keyed by name: `desktop`, `tablet`, `phone` or your own (`phone-landscape`). Width 240-3840, height 240-8000. See [Viewports](#viewports).                                                                                                                                                                                                                  |
| `timeouts`      | `{ page, settle }` ms | `{ "page": 45000, "settle": 8000 }` | `page` bounds navigation, `waitFor` and actions (a page's own `timeout` replaces it); `settle` bounds the network-idle wait.                                                                                                                                                                                                                                |
| `block`         | string[]              | none                                | Requests to abort during capture: URL patterns, or `"analytics"`. Boards add their own. See [Blocking requests](#blocking-requests).                                                                                                                                                                                                                        |
| `reducedMotion` | string or boolean     | `"reduce"`                          | `prefers-reduced-motion` in the capture browser. `"no-preference"` (or `false`) captures motion as players see it. A board may set its own.                                                                                                                                                                                                                 |
| `localStorage`  | object                | none                                | Keys and values set before every page's own scripts run, on its origin. Boards and pages add their own. See [localStorage seeds](#localstorage-seeds).                                                                                                                                                                                                      |
| `setup`         | Action[] or object    | none                                | Single-board configs: actions run once per viewport, whose state the pages reuse. See [Setup](#setup-shared-state).                                                                                                                                                                                                                                         |
| `liveHtml`      | boolean               | `true`                              | `false` captures screenshots only.                                                                                                                                                                                                                                                                                                                          |
| `agentDocs`     | boolean               | not set                             | Not set: the first `serve` or `capture` creates `AGENTS.md` with the Shapewall section in a project that has neither `AGENTS.md` nor `CLAUDE.md`. `false` (written by `init --no-agent-docs` and `agent docs --remove`) or `true`: serve and capture leave the files alone. See [Your agent finds the board](agent-workflow.md#your-agent-finds-the-board). |
| `keepVersions`  | 0-50                  | `5`                                 | Previous captures kept per page and viewport, for before/after. `0` keeps none. (Before 1.0: `versions`, still read, with a warning.)                                                                                                                                                                                                                       |
| `boardUrl`      | http(s) URL           | the running `serve` address         | Where people open the board, for links in notifications and GitHub issues. Without it, links use a running `shapewall serve` for this config, else port 4600.                                                                                                                                                                                               |
| `environments`  | Environment[]         | none                                | The same pages at other base URLs, for compare mode. 1 to 8 of them. See below.                                                                                                                                                                                                                                                                             |
| `journeys`      | Journey[]             | none                                | Named page sequences, which may fork. See [Journeys and links](journeys.md).                                                                                                                                                                                                                                                                                |
| `auth`          | object                | none                                | See below.                                                                                                                                                                                                                                                                                                                                                  |
| `browser`       | object                | Playwright's Chromium               | `{ "channel": "chrome" }` or `{ "executablePath": "/path/to/chrome" }` (absolute, outside the project).                                                                                                                                                                                                                                                     |
| `groups`        | string[]              | order of first use                  | Group order on the board.                                                                                                                                                                                                                                                                                                                                   |
| `pages`         | Page[]                | required (or `boards`)              | See below.                                                                                                                                                                                                                                                                                                                                                  |
| `boards`        | Board[]               | none                                | Several boards in one file, instead of top-level `pages`.                                                                                                                                                                                                                                                                                                   |
| `notifications` | object                | off                                 | Webhook, Slack, Discord, Telegram and email for comment events. See [Notifications](notifications.md).                                                                                                                                                                                                                                                      |
| `github`        | object                | none                                | GitHub connect: `repo`, `boardUrl`, `labels`. See [GitHub](#github) below.                                                                                                                                                                                                                                                                                  |
| `agent`         | object                | none                                | The board chat's model endpoint. See [Agent](#agent) below.                                                                                                                                                                                                                                                                                                 |
| `starterAgent`  | object                | none                                | The sandboxed starter agent: who may dispatch work, tests, budgets. See [Sandboxed starter agent](starter-agent.md).                                                                                                                                                                                                                                        |
| `commands`      | object                | none                                | Named commands (`test`, `build`, `dev`, `lint`, ...) an agent may run through Shapewall. See [Commands](#commands) below.                                                                                                                                                                                                                                   |
| `sitemap`       | URL, file or object   | none                                | Default source for `shapewall sitemap`. See [Sitemap import](#sitemap-import).                                                                                                                                                                                                                                                                              |
| `checks`        | object                | none                                | Defaults for page checks. Only `seo` and `budgets` are accepted. See [Checks SEO](#checks-seo) and [Checks budgets](#checks-budgets) below.                                                                                                                                                                                                                 |
| `ci`            | object                | none                                | Capture on pull requests: threshold, pages, ignore selectors, build and serve commands. See [CI](#ci) below.                                                                                                                                                                                                                                                |

Environment overrides: `SHAPEWALL_BROWSER_CHANNEL`, `SHAPEWALL_BROWSER_PATH`.

`capturePacing` controls bounded spacing between foreground capture starts and a cooldown after observed HTTP 429s. Defaults are
`{ "intervalMs": 250, "rateLimitCooldownMs": 1000 }`; see [capture warnings and pacing](capture-warnings.md).

## Page

| Key              | Type               | Notes                                                                                                                                                                                  |
| ---------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | string             | Unique on the board. Lowercase letters, digits, dashes, up to 64. Used in file names and `--only`.                                                                                     |
| `path`           | string             | Starts with `/`. May carry a query string (`/search?q=shoes`). Joined to `baseUrl` without double `/`.                                                                                 |
| `title`          | string             | Shown on the card. Defaults to the id.                                                                                                                                                 |
| `group`          | string             | Card group on the board. Defaults to `Pages`.                                                                                                                                          |
| `note`           | string             | Up to 200 characters, shown on the card and with its comments: "Sample data", "Signed-out state".                                                                                      |
| `waitFor`        | selector           | Must be visible before the shot.                                                                                                                                                       |
| `actions`        | Action[]           | Run in order after loading, before the shot. At most 30.                                                                                                                               |
| `viewports`      | string[]           | A subset of the configured viewports for this page.                                                                                                                                    |
| `expectStatus`   | number or number[] | An error page captured on purpose, e.g. `404` or `[404, 410]`. It is captured like any page; another status is the failure.                                                            |
| `errorSelectors` | string[]           | Optional known error-state CSS selectors for checks. At most 10 selectors of 500 characters each. Visible matches produce a reliability finding; no page-text guessing.                |
| `seo`            | object             | An object whose only key is a boolean `indexable`. `{ "indexable": false }` skips public SEO diagnostics even with `--seo`; omit it for public pages. SEO is off without `--seo`.      |
| `timeout`        | ms                 | This page's budget for loading, `waitFor` and its actions, 1000-300000. Replaces `timeouts.page` for it, and lets its `wait` and `hold` actions run that long.                         |
| `localStorage`   | object             | Seeds for this page, on top of the board's. See [localStorage seeds](#localstorage-seeds).                                                                                             |
| `frameHeight`    | number or object   | This page's own frame height, 240-8000: one number for all its viewports, or `{ "desktop": 900, "phone": 844 }`. The browser window stays the viewport's. See [Viewports](#viewports). |

A page with `viewports` gets only those frames on the board: a desktop-only page has a narrower card with a "Desktop only" tag, the
cards after it close up, and in Phone mode it shows its desktop frame rather than an empty card.

### Actions

Each action is an object with exactly one action key:

```json
[
  { "click": "button[aria-label='Open menu']" },
  { "fill": ["input[name=q]", "running shoes"] },
  { "press": "Enter" },
  { "hover": ".product-card:first-child" },
  { "waitFor": ".results" },
  { "wait": 500 },
  { "scrollTo": 800 }
]
```

For apps and games there are more:

| Action                                     | Does                                                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `{ "tap": "selector" }`                    | A touch tap. Needs a touch viewport (`tablet`, `phone`, `phone-*`, or `"touch": true`).                                     |
| `{ "mouse": [x, y] }`                      | A mouse click at a point of the viewport, on whatever is on top there (a canvas game's own buttons).                        |
| `{ "hold": ["ArrowLeft", 800] }`           | Holds a key down for that many milliseconds, then lets go (steer a game).                                                   |
| `{ "keyDown": "Shift" }`, `{ "keyUp": … }` | Presses or releases a key and leaves it there, for combinations.                                                            |
| `{ "waitForFunction": "expression" }`      | Waits until a JavaScript expression is truthy in the page, polled every 100 ms: `"window.game?.ready === true"`. See below. |

Any action may also carry:

- `"optional": true`: if it fails (the element is not there), skip it and go on. It gives up after 5 seconds unless it sets its own
  `timeout`. For a dialog that only shows on some layouts: `{ "click": "[aria-label='Skip quick start']", "optional": true }`.
- `"viewports": ["phone"]`: run it only on these viewports, so one page can take a different path per device:
  `{ "click": "text=Computer", "viewports": ["desktop"] }, { "click": "text=Touch", "viewports": ["phone-landscape"] }`.
- `"timeout"`: milliseconds for this action (100-300000) instead of the page's.
- `"force": true` (`click`, `tap`, `hover`, `fill`): skip the checks that the element is visible, still and not covered. A forced
  `click` delivers its pointer, mouse and click events to the element itself, so a canvas or overlay on top cannot swallow it.

`wait` and `hold` last at most 30 seconds, or up to the page's timeout when that is longer (set `timeout` on the page for a long
game state).

The frame is the `height` pixels from where the page is scrolled to: `scrollTo`, or an in-page link that scrolls, changes what is in it.

`waitForFunction` runs your expression inside the captured page, which is how a canvas or WebGL game says it is ready (`networkidle`
means nothing to a render loop). Only whether it became truthy comes back; its value, and the text of any error it throws, never leave
the page. Write it for your own app; the page can see it, like any action.

**When a step fails**, the shot fails with the step's number (from 1), the action and its selector, and why:
`action 3 (click "button:has-text('Play')") timed out after 45 s`. A click on an element under another one adds "another element covers
it" with what to try. A shot that runs out of time says where it was: `timed out after 73 s (during action 5 (waitFor "#hud"))`. The
CLI prints these and the board shows them on the card.

### Capturing an app, not just its landing page

`shapewall init`, a sitemap and the link map only find pages a visitor can reach by following links. In an app or a game, most screens
sit behind a button: **Start**, **Continue as guest**, **Play**, a sign-in, a mode picker. A board built from links alone shows the
marketing site and stops at the door. For anything with an app inside, add the app screens by hand:

1. **Walk the app first.** Open it in a clean browser and list every screen you want on the wall: the entry (guest or demo), every main
   view or tab, settings, key dialogs and menus, empty states, and the end of a flow (results, confirmation). For a game: the menu, mode
   select, a few seconds into play, the pause menu, and the results screen if it is reachable without long play.
2. **Give app screens screen-sized frames.** A tall frame (1440x2200) stretches an app shell and leaves dialogs floating in empty
   space, and a game renders a huge scene slowly. Keep the tall viewports for the marketing and guide pages, and give each app or game
   page its own [`frameHeight`](#viewports) (`{ "desktop": 900, "tablet": 1180, "phone": 844 }`), so one board mixes long pages and
   screen-sized app cards. Set the viewport's `layoutHeight` to the screen too if the app should lay out in a screen-sized window.
   Add a `phone-landscape` viewport (`844x390`) for a landscape-only game.
3. **Do the entry once: `setup`.** A guest entry, a dismissed tutorial or a picked starter kit go in the board's [`setup`](#setup-shared-state),
   scoped to the app's groups. It runs once per viewport and every page in scope starts from the state it left (cookies, localStorage),
   still loading its own `path`. Flags an app reads at start (trailer seen, tutorial done) can be [seeded](#localstorage-seeds) instead.
   Leave pages that change server state (start a session, finish a level) out of the scope so each gets its own fresh entry.
4. **One page per screen, with the clicks from there.** Prefer selectors by role, text or `aria-label`
   (`"button:has-text('Play')"`) over generated class names, and end with a `waitFor` on something only that screen shows, so a click
   that missed fails the shot instead of capturing the wrong screen. One page can differ per device (`"viewports"` on an action) and
   dismiss something that may or may not show (`"optional": true`). For a canvas game: `"force": true` clicks the button under the
   canvas, `mouse` clicks the canvas itself, `hold` steers, and `waitForFunction` waits for the game's own ready flag.
5. **Group and connect them.** Put app screens in their own `group` (`"App"`, `"Game"`), keep the marketing pages, and add a journey
   for the first session (`landing -> guest entry -> main view -> first action`).
6. **Use guest or demo paths, or recorded sign-in.** Never put credentials in actions. For signed-in screens use
   [`shapewall auth record`](#auth) (a board can have its own `auth`). Stop before anything that writes real data (payments, invites,
   emails); capture the dialog, not the result. Add `"block": ["analytics"]` so captures do not count as visits.
7. **Mind the time.** Software-rendered WebGL slows down as the frame grows. Give a long game state its own page `timeout` (a race to
   the finish) instead of raising `timeouts.page` for everything, and `"reducedMotion": "no-preference"` if the game changes with it.
8. **Look at every shot** after the first capture. A landing page, spinner or error where an app screen should be means an action needs
   a better selector or a `waitFor`. A failed shot names the step that stalled.

A board for a guest-first app and a canvas game might read:

```json
{
  "id": "app",
  "baseUrl": "https://app.example.com",
  "viewports": {
    "desktop": { "width": 1440, "height": 2200 },
    "tablet": { "width": 820, "height": 1180 },
    "phone": { "width": 390, "height": 1800 },
    "phone-landscape": { "width": 844, "height": 390 }
  },
  "block": ["analytics", "*/umami/*"],
  "setup": {
    "path": "/",
    "actions": [{ "click": "button:has-text('Continue as guest')" }, { "waitFor": "nav[aria-label='Main']" }],
    "groups": ["App"]
  },
  "pages": [
    { "id": "home", "path": "/", "group": "Site", "viewports": ["desktop", "tablet", "phone"] },
    {
      "id": "today",
      "path": "/today",
      "group": "App",
      "frameHeight": { "desktop": 900, "phone": 844 },
      "waitFor": "h1:has-text('Today')"
    },
    {
      "id": "level-1",
      "path": "/play",
      "group": "Game",
      "viewports": ["desktop", "phone-landscape"],
      "frameHeight": { "desktop": 900 },
      "localStorage": { "tutorialSeen": "1" },
      "timeout": 120000,
      "actions": [
        { "click": "text=Keyboard", "viewports": ["desktop"] },
        { "click": "text=Touch", "viewports": ["phone-landscape"] },
        { "click": "[aria-label='Skip tips']", "optional": true },
        { "click": "#start", "force": true },
        { "waitForFunction": "window.game?.state === 'playing'" },
        { "hold": ["ArrowRight", 1500] }
      ]
    }
  ]
}
```

## Viewports

`viewports` (top level, and per board) is keyed by name. `desktop`, `tablet` and `phone` are built in; a name of your own works too
(`phone-landscape`, `kiosk`), as long as it is lowercase letters, digits and dashes, starts with a letter and is at most 32
characters: `Kiosk` and `4k` are rejected. Up to 8.

| Key            | Notes                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `width`        | 240-3840 CSS pixels.                                                                                                     |
| `height`       | 240-8000. The frame on the board, and by default the browser window too.                                                 |
| `layoutHeight` | Optional browser window height when it should differ from the frame: lay out at 1440x900 but shoot 2200 px from the top. |
| `mobile`       | Mobile emulation (`isMobile`) and a mobile user agent.                                                                   |
| `touch`        | Touch events.                                                                                                            |
| `userAgent`    | A user agent string of your own.                                                                                         |

A name decides the device unless the flags say otherwise: `phone` and `phone-*` are a phone (mobile, touch, iPhone user agent),
`tablet` and `tablet-*` a tablet (iPad user agent), anything else a desktop. `"mobile": true` on another name picks a phone or tablet
user agent by size. The board draws a custom viewport at its device's scale and gives it a toggle ("Phone landscape").

A board's `viewports` replace the top-level ones for that board: an object of its own, or a list of top-level names to keep
(`"viewports": ["desktop", "phone"]`). Page and action `viewports` pick from the board's.

A page can set its own frame height: `"frameHeight": 900` for all its viewports, or `{ "desktop": 900, "phone": 844 }` for some (the
rest keep the viewport's height; names the page does not use are ignored). Only the shot changes: the browser window stays the
viewport's (`layoutHeight`, else `height`), so the page lays out exactly as its neighbours do. A frame shorter than the window shows the
top of it (or wherever an action scrolled to); a taller one reaches past the window, like `layoutHeight`. On the board each card takes
its page's frame heights, so screen-sized app cards and long marketing pages sit on one board; variants of the page use the same
heights.

## Blocking requests

`block` lists requests the capture browser aborts, so captures do not count as visits or trigger beacons:

```json
{ "block": ["analytics", "*/umami/*", "tracker.example.com"] }
```

- A bare host (`tracker.example.com`) blocks that host and its subdomains.
- A pattern with `*` or `/` matches the whole URL; `*` stands for any run of characters: `*/cdn-cgi/rum*`, `https://example.com/api/track*`.
- `"analytics"` is a built-in list: Google Analytics and Tag Manager, Plausible, Umami Cloud, Cloudflare Web Analytics and RUM, Segment,
  Hotjar, Clarity, Mixpanel, Amplitude, PostHog, Heap, FullStory, Fathom, Simple Analytics, GoatCounter, and the Meta, Bing, LinkedIn,
  X, TikTok and HubSpot pixels. A self-hosted analytics endpoint needs its own pattern (`"*/umami/*"`).
- A list holds at most 50 entries, each at most 300 characters and without whitespace.

The top-level list applies to every board; a board's `block` adds to it. Blocked requests are not network failures in the capture
warnings or in page checks. Page checks apply the same list.

## localStorage seeds

`localStorage` (top level, board or page) sets keys before the page's own scripts run, on the page's own origin only:

```json
{ "localStorage": { "game.trailerSeen": "1", "settings": { "music": false } } }
```

Strings are stored as they are; numbers, booleans, objects and arrays as JSON. Each object takes at most 50 keys, a key at most 200
characters and a stored value at most 20000. A page's keys win over its board's, a board's over the top level's. They are set on
every load of that origin in the shot. Use them for flags an app checks at start (a tutorial seen, a saved setting) instead of
clicking through to set them.

## Setup (shared state)

`setup` on a board (or at the top level of a single-board config) runs a list of actions once per viewport before that board's pages,
and the pages in its scope start from the browser state it left: cookies, localStorage and IndexedDB. Each page still opens its own
`path` in a fresh tab. A guest entry, a cookie banner or a first-run picker then happens once per capture, not once per shot.

```json
{
  "setup": {
    "path": "/",
    "actions": [{ "click": "button:has-text('Continue as guest')" }, { "waitFor": "nav[aria-label='Main']" }],
    "groups": ["App"],
    "pages": ["checkout-empty"]
  }
}
```

- `actions` (required): any page actions, including `viewports` guards and `optional`. At most 30, as on a page.
- `path`: where it starts, default `/`.
- `groups` and `pages`: its scope. Without either, every page of the board uses it; with them, only pages in those groups or with
  those ids (marketing pages keep a clean first visit).
- `timeout`: its own budget, else `timeouts.page`.
- A plain array is short for `{ "actions": [...] }`.

It starts from the board's auth state, if any. If it fails, every shot in its scope fails with the step that stalled
(`setup failed: action 1 (click "...") timed out after 45 s`) and the rest of the board is captured as usual. Page checks use it too.
State on the server is shared: pages that change it (start a session, spend a turn) should stay out of the scope and do their own entry.

## Sitemap import

`shapewall sitemap` fills `pages` from a `sitemap.xml` instead of typing them:

```sh
shapewall sitemap https://www.example.com/sitemap.xml --dry-run   # see what it would add
shapewall sitemap https://www.example.com/sitemap.xml --limit 50 --exclude /tag/,/author/
shapewall init --sitemap ./public/sitemap.xml                       # a new config with the sitemap's pages
shapewall init --base-url https://www.example.com --sitemap        # the same, from <base URL>/sitemap.xml
```

`init --base-url URL` without `--sitemap` tries `<base URL>/sitemap.xml` too (and records it when it has pages); without one it follows
the home page's same-site links two levels deep, up to 25 pages, titled from each page's `<title>`. `--no-discover` writes the home
page only.

- A sitemap index is followed into its child sitemaps (up to 50, three levels deep, each read once); gzipped `.xml.gz` sitemaps work.
  A child that fails is reported and skipped.
- One site's URLs are kept: the host of `baseUrl` (or `publicUrl`) if the sitemap uses it, else its most common host. Production URLs
  in a sitemap become paths on your `baseUrl`, and a base path in `baseUrl` (`http://localhost:3000/app`) is taken off.
- Paths already on the board, repeats and `/pricing` vs `/pricing/` count once, so running it again only adds new pages.
- Pages are grouped by their first path segment (`/blog/*` in "Blog") when it has more than one page or the board already has a group
  for it; single top-level pages go in "Pages". `--group NAME` puts them all in one group. Titles come from the last path segment.
- With more than `--limit` pages (default 100, at most 1000), the shallowest are kept, so the top of the site wins over deep archives.
- `--board ID` adds them to one board of a multi-board config. Nothing is captured; run `shapewall capture` next.

To set the source once, add `sitemap` to the config, or, in a multi-board config, to each board inside `boards[]` (a top-level
`sitemap` beside `boards` is an error). `shapewall sitemap` with no argument reads it, and `init --sitemap` records it:

```json
{ "sitemap": { "source": "https://www.example.com/sitemap.xml", "limit": 50, "exclude": ["/tag/"], "group": "Site" } }
```

`"sitemap": "public/sitemap.xml"` (a URL or a file, relative to the config) works too. Options on the command line win over the config.

## Board (multi-board configs)

```json
{
  "baseUrl": "http://localhost:3000",
  "boards": [
    { "id": "marketing", "title": "Marketing site", "pages": [{ "id": "home", "path": "/" }] },
    { "id": "docs", "title": "Docs", "baseUrl": "http://localhost:4000", "groups": ["Guides", "API"], "pages": [] }
  ]
}
```

A board may override `baseUrl`, `publicUrl` and `environments`, and has its own `journeys`. `--board ID` selects one for `capture`,
`comments` and `variant`.

A board may also set its own capture settings, so an app or a game captures differently from the marketing site beside it:

| Key             | Notes                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `viewports`     | Its own viewports (an object), or a list of top-level names. Replaces the top-level list for this board. See [Viewports](#viewports). |
| `block`         | Added to the top-level `block`. See [Blocking requests](#blocking-requests).                                                          |
| `reducedMotion` | Replaces the top-level value for this board.                                                                                          |
| `localStorage`  | Merged over the top-level seeds; pages merge theirs over it.                                                                          |
| `setup`         | Actions run once per viewport; their state is reused by the board's pages. See [Setup](#setup-shared-state).                          |
| `auth`          | Replaces the top-level `auth` for this board (`null` turns it off). See [Auth](#auth).                                                |

## Environments

List the places the same pages run, to compare them on the board:

```json
{
  "environments": [
    { "id": "staging", "title": "Staging", "baseUrl": "https://staging.example.com" },
    { "id": "production", "baseUrl": "https://www.example.com", "publicUrl": "https://www.example.com" }
  ],
  "pages": [{ "id": "home", "path": "/" }]
}
```

| Key         | Type        | Notes                                                    |
| ----------- | ----------- | -------------------------------------------------------- |
| `id`        | string      | Lowercase letters, digits and dashes. Used with `--env`. |
| `baseUrl`   | http(s) URL | Where this environment's pages load from.                |
| `publicUrl` | http(s) URL | Optional, as at the top level.                           |
| `title`     | string      | Shown on the board. Defaults to the id.                  |

The first environment is the default: `shapewall capture` without `--env` captures it, its captures are the ones you comment on, and it
sets the board's `baseUrl` (leave `baseUrl` out, or set it to the same URL). `shapewall capture --env production` captures another one
into `.shapewall/<board>/envs/production/captures/`. Configs without `environments` work as before: one environment, `default`, at
`baseUrl`.

On the board, **Compare** shows each page in two environments side by side, with the changed pixels in red over the second one, the
changed share on each card and a **Changed pages only** filter. Diffs (pixelmatch, anti-aliasing ignored) are computed when you open
compare mode or after an environment capture, and cached in `.shapewall/<board>/diffs/<a>_<b>/` until either capture changes. Compare
works in a static export too: `shapewall export` computes every pair of captured environments.

Comments work in compare mode: a comment placed on one side is on that environment, and its pin stays on that side in every later
compare. Outside compare mode the board shows the default environment, and the thread of a comment left on another one says which.

## Versions

When a page is captured again, the shot it replaces (PNG, thumbnail and live HTML) moves to `.shapewall/<board>/versions/` as
`<page>.<viewport>.<version>.*`, and the newest `keepVersions` (default 5) of each page and viewport are kept. A comment stores the version it
was made on (`captureVersion`), so once it is resolved and the page recaptured, the comments panel shows before and after near the pin.
Versions are kept for the default environment only.

## GitHub

```json
{ "boardUrl": "https://board.example.com/", "github": { "repo": "acme/site", "labels": ["shapewall"] } }
```

`repo` (`owner/name`), `boardUrl` (deprecated: set the top-level `boardUrl` instead; where the board is served, for links from issues; default the top-level `boardUrl`, else a running
`shapewall serve` for this config, else `http://127.0.0.1:4600/`), `labels` (up to
10, put on new issues), `board` (the board that bare `shapewall:<id>` markers mean) and `apiUrl` (GitHub Enterprise Server). Top level
only. The token comes from `SHAPEWALL_GITHUB_TOKEN` or `GITHUB_TOKEN` and the webhook secret from `SHAPEWALL_GITHUB_WEBHOOK_SECRET`; a
`token`, `webhookSecret` or `secret` key here is an error. Environment overrides: `SHAPEWALL_GITHUB_REPO`, `SHAPEWALL_BOARD_URL`,
`SHAPEWALL_GITHUB_API_URL`. See [GitHub connect](github.md).

## CI

Capture on every pull request: what `shapewall ci` and the workflow from `shapewall init --ci` read. See
[Capture on pull requests](pull-requests.md).

```json
{
  "ci": {
    "threshold": 0.00001,
    "pages": ["home", "pricing", "login"],
    "viewports": ["desktop", "phone"],
    "ignore": [".clock", "#ad-slot"],
    "start": { "install": ["npm", "ci"], "build": ["npm", "run", "build"], "serve": ["npm", "start"], "url": "http://127.0.0.1:3000" }
  }
}
```

| Key         | Type     | Default         | Notes                                                                                                                                                                                    |
| ----------- | -------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`   | boolean  | `true`          | `false` turns pull request captures off without deleting the workflow.                                                                                                                   |
| `threshold` | 0-1      | `0.00001`       | Share of pixels below which a shot counts as unchanged (0.00001 is 0.001%). A size change always counts. `--threshold` overrides it.                                                     |
| `pages`     | string[] | every page      | Page ids to compare (an allow-list), in the config's order.                                                                                                                              |
| `viewports` | string[] | each page's own | Viewport names to compare.                                                                                                                                                               |
| `ignore`    | string[] | none            | CSS selectors hidden (`visibility: hidden`) on both sides before each shot: clocks, ads, random content. Up to 50, each at most 300 characters.                                          |
| `images`    | string   | `"links"`       | `"links"`: the comment links to the workflow artifact. `"branch"`: thumbnails committed to a `shapewall-ci` branch and shown inline (public repositories only; needs `contents: write`). |
| `maxPages`  | 1-500    | `50`            | Compare at most this many pages. `--max-pages` overrides it.                                                                                                                             |
| `start`     | object   | none            | Build and serve mode: `install`, `build` and `serve` commands, the `url` serve listens on, and `timeout` in ms (1000 to 1800000, default 180000). With `start`, `serve` is required.     |

`start` commands are argv arrays (`["npm", "run", "build"]`): a program name found on `PATH`, then its arguments, run without a shell.
A string is an error, and so are paths (`./build.sh`, so a config cannot name a program the repository ships), shells and launchers
(`sh`, `bash`, `cmd`, `powershell`, `env`, `sudo`, `xargs` and similar), which would turn the array back into a shell string. `url` must
be a local address (127.0.0.1, localhost or [::1]); without it, the board's `baseUrl` is used and must be local. The commands run only
from `shapewall ci capture --allow-start` inside a CI job (`GITHUB_ACTIONS` or `CI` is `true`), never on your own machine, and without
`GITHUB_TOKEN` and the Actions runtime tokens in their environment.

## Agent

```json
{ "agent": { "baseUrl": "http://127.0.0.1:11434/v1", "model": "llama3.2", "vision": false } }
```

The board chat's endpoint: any OpenAI-compatible chat completions API. `baseUrl` and `model` are required to connect; `apiKeyEnv` (the
variable holding the key, default `SHAPEWALL_AGENT_API_KEY`), `label` (the name shown for it; a connected agent's name and icon are set on the Agents page, see [Chat with an agent](agents.md#name-and-icon)), `vision` (default `true`), `tools` (default `true`), `maxTokens`,
`temperature` (0 to 2) and `backend` are optional. `maxTokens` is a whole number from 1 to 200000. `backend` is
`"openai-compatible"` (the default) or `"acp"`, which chats with an agent CLI over ACP instead; that command comes from
`serve --agent-acp`, `SHAPEWALL_AGENT_ACP` or the host's saved agent settings, never from the config. Top level only. An `apiKey`,
`key`, `token`, `secret` or `password` key here is an error, and so is any key that could name a command to run (`command`, `cmd`,
`exec`, `acp`, `acpCommand`, `program`, `args`, `argv`, `env`), because a committed config would run it on the machine of whoever
chats from that repo. `apiKeyEnv` may only name `SHAPEWALL_AGENT_*` or a `*_API_KEY`
variable. A key goes only to this machine, a known hosted API, or a host confirmed in `SHAPEWALL_AGENT_KEY_HOSTS`.
Environment overrides: `SHAPEWALL_AGENT_BASE_URL`, `SHAPEWALL_AGENT_MODEL`. See [Chat with an agent](agents.md).

How fixes run, both off by default and also on the Agents page of the Workspace Console (saved settings win over these):
`branchMode` (`true` runs an agent CLI's fixes on a branch of their own) with `branchPrefix` (default `"shapewall/"`), see
[Work on a branch](agents.md#work-on-a-branch); and `batchFixes` (`{ "enabled": true, "max": 5 }`, `max` from 1 to 20), see
[Fix several comments at once](agents.md#fix-several-comments-at-once).

What an agent's tools may reach (1.4.0, see [what each turn may do](agent-hardening.md#what-each-turn-may-do)):

- `browser.allow`: origins the agent's throwaway browser may load besides the app's own addresses (every `baseUrl` and `publicUrl`
  of the config, its boards and environments). Up to 40 exact http(s) origins, such as `"https://staging.example.com"`: no path, no
  user or password. The machine has the last word: its own `browser` setting switches the browser off whatever the config says, and
  these extra origins count only on solo turns of a machine without a login for the browser (`browserAuth` or `browserProfile`).
  On every other turn an origin here counts only if the machine's own `browserAllow` names it too. The config is read from your
  checkout, never from the fix copy an agent writes in.
- `fixIn`: `"copy"` (the default, every fix in a fix copy of its own) or `"checkout"`, which lets a local board's owner keep solo
  fixes in this checkout. Every other tier and every hosted path still uses a fix copy.

```json
{ "agent": { "browser": { "allow": ["https://staging.example.com"] }, "fixIn": "copy" } }
```

## Commands

```json
{
  "commands": {
    "test": { "run": "npm test", "inputs": ["package.json", "package-lock.json", "test/**"] },
    "build": "npm run build",
    "dev": { "run": "npm run dev -- --port $PORT", "ready": "http://127.0.0.1:$PORT" },
    "lint": { "run": "npm run lint", "mutating": false }
  }
}
```

The commands an agent may run by name, through Shapewall (never through its own shell). Up to 20, each named with lowercase letters,
digits and dashes. A string is short for `{ "run": "..." }`. Each takes:

| Key        | Type     | Default                                    | Notes                                                                                                                               |
| ---------- | -------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `run`      | string   | required                                   | One command line, run without a shell: no pipes, `;`, `&`, redirects or backticks, and no `$` except `$PORT`. Up to 500 characters. |
| `inputs`   | string[] | manifests, lockfiles, configs, named files | More project-relative paths or globs an approval covers, on top of the manifests, lockfiles and `.npmrc` (always). Up to 50.        |
| `mutating` | boolean  | `true`                                     | `false`: the command only reads (a linter, a type check). Hosted chat runs only these, and only on its owner's turns.               |
| `args`     | boolean  | `false`                                    | `true`: the agent may add arguments to it.                                                                                          |
| `ready`    | URL      | none                                       | For a dev server: the loopback URL that answers once it is up. `$PORT` is the free port Shapewall picks. Not in the OS sandbox.     |

`$PORT` goes bare, as its own word or part of one (`--port $PORT`, `--port=$PORT`): quoted or escaped it is refused, as it would
read as text to a person and as the port to Shapewall, and it is never the program itself. `"args": true` lets the agent add any
arguments: for `npx`, `jest` and similar runners that is any script or package, and the card for it says so. On Windows a line
runs without a shell too: `node`, `npm` and `npx` run as Node plus their own script, and a `.cmd` or `.bat` program is refused.

Whether a command runs at once or waits for a card on the board depends on who wrote the turn and what the machine running the agent
allows, not on this file: see [what each turn may do](agent-hardening.md#what-each-turn-may-do) and
[commands through Shapewall](agent-hardening.md#commands-through-shapewall). The lines are always read from your checkout, never
from the copy an agent edits. `starterAgent.testCommand` still
works; `commands.test` wins when both are set. A change needs a restart of `serve`.

## Auth

A page that needs a sign-in usually redirects to the sign-in page, and without a login a capture is a picture of that page. Each
shot keeps the URL it landed on (`finalUrl` in `capture --json`, with `redirected: true` when it is not the page asked for), the
capture line says "landed on /login/, not /app/", the capture ends with a warning that points here, and the board marks the card
"Redirected". `shapewall checks` prints the same as a warning.

Never put credentials in the config. Two options:

**Guided manual sign-in.** Run this on the desktop that will capture the app:

```sh
shapewall auth record --url https://your-site.example/login
```

Shapewall opens a fresh, isolated Chromium profile using the same `browser.channel` / `browser.executablePath` settings as capture.
Sign in yourself in that window, return to the terminal, and press Enter to save. Shapewall never enters a password, executes a login
script, or reuses your personal browser profile. Type `cancel`, press Ctrl-C, close the browser, or let the timeout expire to discard.
The default timeout is 10 minutes; `--timeout 30m` (or `1800`, in seconds) allows the most, 30 minutes. A terminal and desktop display are required; this is not
a server-side sign-in button or a background service.

The command saves Playwright cookies, localStorage and IndexedDB in `.shapewall-auth/<board>[.<environment>].auth.json`.
That directory is private (0700), contains an ignore-all `.gitignore`, and stays outside capture/export output. State files are 0600.
Existing recordings need explicit `--overwrite`; symlinks, hard links, Git-tracked state and files changed during recording are refused.
A crashed recording can leave `.shapewall-auth/.record.lock`; remove it only after confirming no recording is still open.

Use `--board ID` and `--env ID` to choose a configured target; otherwise the first board/environment is used. `--url` is optional and
defaults to that environment's base URL. The command prints the exact config snippet and next capture command, without changing config:

```json
{ "auth": { "storageState": "./.shapewall-auth/your-board.auth.json" } }
```

The state file contains account credentials. Keep it private and use a test account with only the access needed for the capture.
Authentication and target URLs, cookie values and browser error details are not printed. On a remote capture server without a desktop,
record and capture locally, then use the normal capture-push workflow instead of attempting an interactive sign-in on the server.

**Login script.** An ES module whose default export signs in. It runs once per capture; its cookies and storage are reused for every page.

When the page being captured is loaded from a public host, the capture browser refuses that page's own requests to loopback, private
and internal hosts, including a public name that resolves to one, so a public page cannot make the browser fetch from this machine or
its network (a router page, a local dev server, cloud metadata). The `baseUrl` itself is never refused, and a `baseUrl` that is
already local or private -- the usual dev site -- keeps all of its requests, including those to other hosts on your network. So the
guard bounds what a public page may reach through the capture browser; it is not a check on where a config may point. Read a config
you did not write before you capture with it.

A login script is code: `shapewall capture`, the board's Capture button and page checks run it on your machine, as you, with your
environment. Capture prints a line the first time it runs one. Only use a config with `auth.loginScript` from a repo you trust, and read
the script first if you did not write it. For the same reason a config cannot point `browser.executablePath` at a file inside the
project folder (use an installed browser's absolute path, `browser.channel`, or set `SHAPEWALL_BROWSER_PATH` yourself).

```json
{ "auth": { "loginScript": "./shapewall.login.mjs" } }
```

```js
export default async function login({ page, context, baseUrl }) {
  await page.goto(new URL('/login', baseUrl).toString())
  await page.fill('input[name=email]', process.env.SHAPEWALL_USER)
  await page.fill('input[name=password]', process.env.SHAPEWALL_PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}
```

If both are set, the login script wins. Use a test account with the least access the pages need, and keep `*.auth.json` out of git
(`shapewall init` adds it to `.gitignore`).

**Per board.** `auth` inside a board of `boards[]` replaces the top-level one for that board only, so a signed-in app board and a
signed-out marketing board can share one config; `"auth": null` captures a board signed out. For a guest entry that is a few clicks,
a board [`setup`](#setup-shared-state) is simpler than a login script and is scoped to the pages that need it.

### Checks SEO

Optional `checks.seo` turns SEO checks on by default for `shapewall checks run`, `shapewall checks lighthouse` and the board's **Run checks**:
`true` for every page, `false` to keep them off (the board's Include SEO then starts off), or a list of page ids. `--seo` and
`--no-seo` override it for one run. Pages with `seo: { "indexable": false }` are always treated as private. See
[page checks](page-checks.md).

```json
{ "checks": { "seo": ["home", "pricing", "blog"] } }
```

### Checks budgets

Optional top-level `checks.budgets` declares explicit maximum performance measurements for manual
checks and Lighthouse audits. Omitted means no budgets. Each report keeps its policy snapshot;
unknown measurements do not pass. See [performance budgets and history](performance.md#performance-budgets-and-report-history)
for the supported metric names, units, example and comparison rules.
