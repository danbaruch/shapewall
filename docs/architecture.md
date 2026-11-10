# Architecture

Shapewall is three parts that share one folder of plain files.

```
shapewall.config.json ──► capture (Playwright) ──► .shapewall/<board>/captures/*.png|*.thumb.png|*.html + manifest.json
                                                        │
                    shapewall serve (Express) ◄──────────┘  + comments.json, variants.json, journeys.json, versions/,
                                │                               envs/<env>/captures/, diffs/, status.json, capture.lock
                                │
                     React Flow client (dist/client)
```

| Path                        | Role                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/config.js`             | Loads and validates the config, collecting every problem with its JSON path.                    |
| `src/capture/capture.js`    | Runs captures: browser contexts per viewport, waits, actions, screenshots, live HTML.           |
| `src/capture/actions.js`    | Runs page and setup actions (captures and page checks); step-named failures.                    |
| `src/capture/requests.js`   | The private-host guard, the `block` list and `localStorage` seeds of a capture context.         |
| `src/capture/live.js`       | The in-page DOM snapshot and the Node-side build of one self-contained HTML document.           |
| `src/capture/sanitize.js`   | The allowlist HTML and CSS sanitizer every snapshot goes through.                               |
| `src/lock.js`               | The capture lock (pid + process start time) and a short file lock for JSON writes.              |
| `src/store.js`              | File layout, atomic JSON writes, comments, variants, capture versions, capture state.           |
| `src/links.js`              | Matches the links read from a captured page to configured pages.                                |
| `src/journeys.js`           | Journeys from the config and the board (journeys.json).                                         |
| `src/journey-paths.js`      | Branching journeys: fork validation, the step graph, paths. Shared with the client.             |
| `src/diff.js`               | Pixel diffs between environments (pixelmatch), cached per pair.                                 |
| `src/server/app.js`         | The Express app: API, capture and live files with their headers, the built client.              |
| `src/feedback.js`           | Comments as a work list (`shapewall comments`), for people and agents.                          |
| `src/watch.js`              | `shapewall watch`: claims new comments and hands them to an agent command.                      |
| `src/mcp.js`                | `shapewall mcp`: the stdio MCP server (comments, replies, status, recapture).                   |
| `src/png.js`                | A minimal PNG decoder/encoder, to crop a capture around a pin for the MCP server.               |
| `src/agent/`                | The board chat: config, `/api/agent/*` routes, threads, prompt and quoted data, backends.       |
| `client/src/chat/`          | The chat panel: threads, streaming Markdown, attachments and crops, voice in, read aloud.       |
| `src/hosted/`               | The hosted server (FSL): accounts, workspaces, tenancy, tokens, push, share links, audit.       |
| `client/src/console/`       | Console (second Vite entry, `dist/console`): hosted accounts, or local Projects and Settings.   |
| `src/doctor.js`             | `shapewall doctor`: environment checks and the matching browser download.                       |
| `src/export.js`             | Static, read-only export.                                                                       |
| `client/src/board/`         | Canvas, layout, nodes, arrows, journeys, compare, before/after, the comments panel.             |
| `client/src/components/ui/` | The UI kit (Radix + Tailwind): buttons, selects, menus, dialogs, ... (`docs/design-system.md`). |
| `client/sw.js`              | The board's service worker (app shell only), built into `dist/client/sw.js`.                    |

## Capture

For each page and viewport Shapewall opens a fresh browser context with the viewport size (device scale 1; mobile emulation, touch and a
mobile user agent for `tablet` and `phone`, and for any viewport name that starts with one, such as `phone-landscape`), loads the page,
waits for `load`, then for network idle (bounded by `timeouts.settle`), then for `waitFor`, then runs `actions`, then waits until every
image intersecting the frame has decoded (lazy images in view are switched to eager). After a short pause for late renders it takes two
screenshots of the same fixed frame through the DevTools protocol: full size and a scaled thumbnail (a quarter of the desktop width, half
of the phone width). The frame starts at the page's current scroll position (the clip is in document coordinates), so an action or a
hash link that scrolls the page is shot where it scrolled to. A viewport with `layoutHeight` lays the page out in a window of that height
and shoots the frame's `height` past it.

Board settings shape the context too: a board's `viewports` replace the top-level list for it; `block` patterns are aborted by one
context route (with the private-host guard), and the requests it blocked are left out of the network warnings; `localStorage` seeds go
in through an init script that only writes on the page's own origin; `reducedMotion` defaults to `reduce`. A board `setup` runs once
per viewport, on first use, in its own context (`runSetup`), and its `storageState()` (cookies, localStorage, IndexedDB) is the state
every page in its scope starts from, so a guest entry happens once per capture instead of once per shot. Actions run in
`src/capture/actions.js`, shared with page checks: a failure names the step (`action 3 (click "...") timed out after 45 s`) from the
config only, never from page text or Playwright's call log.

Why fixed frames: comparable cards on one canvas, predictable memory, and headless Chrome's minimum window width does not affect device
emulation through Playwright, so a 390 px phone capture is a real 390 px layout.

Runs are serialized per board by `capture.lock`, created with an exclusive open. A lock counts as held only while its process exists and,
on Linux, started at the recorded time, so a recycled pid reads as stale and a crashed run never blocks the next one. A full run writes to
`captures.next/` and swaps it in at the end; `--only` writes straight into `captures/` and merges its manifest entries.

Links: after the screenshot, the page's `<a href>` and `<area href>` values (as resolved by the browser, at most 2000) are matched to the
board's pages in Node (`links.js`) and only the matching page ids are written to the manifest entry (`links`). Unmatched or malformed
hrefs are dropped there; nothing from them is stored.

Versions: each successful shot gets a version id (its time plus a random suffix) in the manifest. On the default environment, the shot it
replaces is copied to `versions/` first (a full run copies from the old `captures/` after the swap; `--only` copies before the shot and
removes the copy again if the shot fails), then each page and viewport is pruned to the newest `versions` (config).

Environments: `--env ID` captures another environment into `envs/<id>/captures/` (same layout, same lock), then warms the pixel diffs
against the default environment.

## Live HTML

In the page, after the screenshot:

- The document element is cloned. Form values are frozen into attributes (text, checkboxes, selects); password and hidden values are not.
- Stylesheets are walked in cascade order, including `@import`ed sheets and adopted sheets. Rules whose selectors match nothing on the page
  are dropped (bundles are mostly other pages); `@media`, `@supports`, `@layer` and `@container` blocks keep their matching rules.
- Images are redrawn onto a canvas from their decoded pixels at twice their displayed width and exported as WebP, which makes them small
  and guaranteed complete. Canvas and video elements become still images.
- Scripts, frames, objects, `link`, `base`, `template`, `meta http-equiv` and every `on*` attribute are removed before anything leaves the
  page.

In Node:

- Cross-origin stylesheets and images the page could not read are taken from the browser's own response bodies, only when the response was
  a complete 200 (format signature and end marker checked, `Content-Length` compared when the body was not compressed).
- Every `url()` is resolved to a `data:` URI or replaced with `none`. An image budget (3 MB per page) drops the largest images first;
  dropped images become same-size grey placeholders so the layout holds. Identical images are stored once, as a CSS rule.
- The whole document goes through `sanitize.js` (allowlist, see the README), then gets its CSP `<meta>` tag. The file is capped at 5 MB.

On the board, the live document is rendered at the capture's native width inside the frame and scaled down with a CSS transform, so the
layout matches the screenshot. Capture also renders the sanitized document at that native size and writes an element map
(`<page>.<viewport>.elements.json`): selectors, short text, boxes and hit order. The board hit-tests and resolves pins against this map,
so the frame uses `sandbox=""` with an opaque origin. Controls stay inert while text is selected. Only older local captures without a
map keep the DOM path and `allow-same-origin` until recaptured; hosted boards and static exports always use an opaque frame.

### Limits

- The snapshot is a frozen state: menus that only open with JavaScript stay closed, and `:hover` styles apply only while hovering.
- Content inside cross-origin iframes (embedded maps, videos) is dropped.
- Web fonts are inlined up to a budget (1.5 MB); above it the page falls back to system fonts in the live view (the screenshot is exact).
- Shadow DOM content is not cloned.

## Comment anchors

When a comment is made on live HTML, the element under the click is turned into an anchor:

- The element itself, or the nearest interactive ancestor (link, button, input, label, image, ...).
- A selector path from the closest stable hook: a unique `#id`, `[data-testid]` or `[aria-label]`, then `:nth-of-type()` steps. The server
  accepts only this grammar, so a stored selector can never be an arbitrary CSS expression.
- The element's text (first 80 characters) and the click offset inside it.
- The element's size as a share of the page (`w`, `h`), so the pin sits on the element's corner (top right, outside it; top left near
  the right edge, below it near the top) in screenshot mode too, instead of on top of what it is about.

In comment mode the element a click would pin to is outlined while the mouse is over a live page, with the last step of its selector
and its text; a large element (a fifth of the page or more) is dashed and labelled as a whole section.

To place the pin later: the selector is tried first and accepted only if the text still matches; otherwise the first element of the same
tag with exactly that text wins. If neither is found the pin stays at its stored position with a dashed ring ("this moved"). In screenshot
mode pins use the stored position.

## Canvas controls

Figma-style, in `client/src/board/navigation.js` (React Flow's own wheel, Space and zoom-key handling is off; it keeps left-drag and
touch):

| Input                                             | Does                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| Wheel                                             | Pan up and down                                                         |
| Shift+wheel                                       | Pan sideways                                                            |
| Trackpad two-finger scroll                        | Pan in any direction                                                    |
| Ctrl+wheel, Cmd+wheel, trackpad pinch             | Zoom about the cursor (0.02x to 4x; a mouse notch is about 1.3x)        |
| Space+drag, middle-button drag, drag on the board | Pan (Space and middle drag work over pages and in comment mode as well) |
| Touch: one finger, two-finger pinch               | Pan, zoom                                                               |

Space pans while the mouse is over the canvas, except in text fields and on a control reached with the keyboard (Space presses it).
A Space+click never selects a page or starts a comment. Wheel and drag steps move the camera without saving it; the URL camera and the
settled zoom update once it rests (150 ms after the last wheel event, or on mouse up). Safari's trackpad pinch (gesture events) zooms
the same way. Scrolling inside a `nowheel` element (the frame bar, a live page being selected) scrolls it instead.

## Board rendering

- Pages are grouped (config order), each group laid out in rows; groups wrap so the board is roughly screen-shaped. Variants sit to the
  right of their page, joined by a dashed edge.
- Images: thumbnails until a frame is drawn wider on screen than the thumbnail has pixels, then the full PNG. Decided from the zoom once
  the camera has rested, never mid-animation.
- Live HTML: a frame goes live when it is drawn at least 40% of its native width (or half the canvas, whichever is smaller), or when "Open
  live" pinned it. At most two at once, nearest the center first.
- Arrows are a custom React Flow edge that runs border to border between two cards, curving slightly so a -> b and b -> a stay apart.
  Thickness and arrowheads are divided by the zoom, so they read the same at any zoom. Link arrows are opt-in (**Links**), and only
  the hovered or selected card's arrows are drawn once a board has more than 150 links. Links into pages that at least half the pages
  link to (the nav and the footer, `globalTargets`) are hidden until "Show them" (`la=1`). Arrows are not tab stops, and their labels
  use page titles.
- Journeys fade the cards that are not in the journey, put numbered badges on the ones that are, and fly the camera to each step. A
  branching journey is shown one path at a time (`resolvePath` with the branches picked); the other branches' arrows are dashed.
- Compare mode lays two frames per viewport side by side (one per environment) and shows screenshots only, with the cached diff mask
  over the second.
- Each frame's label (viewport, environment, live) sits in a strip between the card header and the frame, never on the captured page.
- The selected card's action bar belongs to one view: switching viewport, compare or a journey, and Fit view, clear the selection, and
  the bar hides while the frame is a thumbnail on screen (its longer side under 160 px). Tapping a thumbnail flies to it first, leaving
  room above the card, so the bar sits above it and never over its title or badges. When the card fills the canvas the bar is one
  button in the card's header. On local boards it has "Capture" (that page only, `POST .../capture { pages: [id] }`).
- "Go to page" fits the page's content, not its whole fixed frame: the lowest row of the thumbnail that differs from the plain
  background below it (`contentExtent.js`).
- A variant made only for viewports the mode does not show (a tablet-only variant in Desktop mode) is a short card that says so, with a
  button to show its viewport.
- Phone-width screens (640 px and narrower) open on the phone viewport when the board has one and the URL names none, on the first
  group at a readable zoom (two cards across), top-aligned. Pins never shrink below their 44 px touch target, and a tap in comment mode
  on a page drawn small zooms to it first, so the next tap can pin to an element.
- The desktop toolbar never truncates: below 1440 px (1600 px with Capture and Agent) Links and Compare drop their labels, below
  1280 px the lists become icons and the capture time moves into a tooltip. Notes over the canvas (comment mode, the tip, the
  viewport switch, the links note) are pills in one stack at its top, so turning comment mode on never moves the canvas. The minimap
  can be turned off and hides while a page is live. Resolve and delete show a toast with Undo (a delete is sent after a few seconds,
  or when the page is left).
- Keyboard: each card is one tab stop; the arrow keys move through its pins and buttons, Esc returns to the card, Enter opens its
  action bar. "Skip to comments" is the first tab stop. After a pick from a toolbar list, focus returns to the canvas, and a closed
  list ignores typed letters (Radix type-ahead), so shortcuts like C keep working. Esc closes a journey.
- URL state: board, viewport mode, comment filter, selected comment, camera, journey, branches and step, links, and compare pair live in the
  query string.
- Overlays (dialogs, the comment sheet, the selected card, comment mode) each own a history entry, so Back closes the topmost one.

## Comments on the board

Comments work like Figma's. Pins are avatar bubbles (the author's initials and colour, a pointed corner on the spot, a count badge
for replies, a dot for news) drawn at screen size; pins closer than about 30 screen pixels on a frame merge into one bubble with a
count, and clicking it zooms in until they part (`clusterPins` in `client/src/board/pins.jsx`). Hovering a pin previews the thread in
a kit `HoverCard`. Resolved threads are hidden by the Open filter, which is the toggle for showing them.

C (or the Comment button) turns comment mode on; a click drops a draft pin and an inline composer (`ComposerPopover`) opens beside
it: Enter posts, Shift+Enter adds a line, Esc cancels and stays in comment mode, @ suggests people. The open thread is a popover at
its pin (`ThreadPopover`): resolve, previous and next (also the arrow keys), and a more menu (copy link, edit, ask agent, GitHub,
history, delete), then the messages with reactions and an inline reply box. Both are Radix popovers anchored to a virtual element
that reads the pin's position every frame, bounded by the canvas, so they follow pan and zoom, flip to stay on screen and hide when
the pin leaves the canvas. On phones the thread and the composer are bottom sheets (`Dialog`) and Back closes them.

The list beside the canvas mirrors the pins: picking a row flies to the pin and opens its thread, hovering a row lights up its pin
and the other way round, and threads with activity since you last opened them carry a dot. "Seen" is per browser
(`localStorage`, `client/src/lib/unread.js`), not stored on the server.

## Storage

All JSON is written to a temporary file, fsynced and renamed over the old one. Comment and variant changes run under
`<file>.lock` (exclusive create, with stale-lock takeover), so concurrent writers never lose an update and never see a partial file.
Comment ids are never reused. Journeys made on the board (`journeys.json`) and the diff cache index use the same writes and locks.

Replies live inside their comment (`replies: [{ id, author, body, createdAt, reactions? }]`), next to `agentStatus` and `agentStatusAt`.
A comment or reply may carry `reactions: [{ emoji, by: [{ name, handle?, user? }] }]` (six emoji in `src/reactions.js`; the API
returns `{ emoji, count, by }`), and `editedAt` once its text is edited. Both are optional, so older files read unchanged; reacting
does not touch `updatedAt`, and the agent views (`shapewall comments`, MCP, the token API) leave reactions out. The hosted store
keeps them in the `reactions` and `edited_at` columns (migration 3). The agent
status is the hand-off between `shapewall watch`, MCP clients and people: a watcher claims a comment by changing `agentStatus` from null to
`queued` inside the same file lock, so the claim is atomic and survives restarts. `<board>/watch.lock` (the capture lock's pid + start
time scheme) keeps one watcher per board; `<board>/agent/` holds the JSON and log of each command it ran.

## The board as an app

The client ships a web app manifest and a service worker, so the board installs on a phone or desktop and opens in its own window. The
worker is generated at build time with the list of files of that build (the page, its hashed assets, icons, manifest) and caches only
those: network first for the page, cache first for the hashed files, and a new cache per build. It never handles `api/` (board data,
images, live HTML) or a static export's `data/`, so captures and comments are always fresh. It registers only in production builds on
secure origins (https or localhost); the board works the same without it.

## Local Console

`shapewall serve` serves `/console` and its `/_console/` assets behind the same Host and remote-access gates as the board.
The shell carries a fixed `shapewall-local-console` marker and a fresh style nonce under a strict CSP. The console entry selects
`LocalConsole`, which reads the existing `/api/info` and `/api/boards` APIs; it never starts a hosted sign-in or creates a hosted session.
Board links preserve the selected board id. General preferences reuse the board settings content, and the existing Agent and update
capabilities still decide whether protected controls can mount or mutate anything. Local API requests are absolute so trailing slashes
and direct Console links work.
