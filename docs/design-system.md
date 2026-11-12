# Design system

The board's UI kit lives in `client/src/components/ui/`: one file per component, built on [Radix](https://www.radix-ui.com/) primitives
(the `radix-ui` package) and styled shadcn-style with Tailwind and `class-variance-authority`. Import from the barrel:

```js
import { Button, IconButton, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui'
```

Rules:

- No native OS controls on the board: no `<select>`, no `title=` tooltips on controls, no browser dialogs. Every picker, menu and tooltip
  is a kit component, so it looks the same on desktop, iOS and Android.
- Touch targets are at least 44 px below the `lg` breakpoint (the board's phone layout). Components take `size="touch"` (or `icon`) there;
  list items in selects and menus are 44 px tall below `lg` on their own.
- Overlays that can be open on a phone (dialogs, selects, menus, popovers) own a history entry while open, so Android Back closes the
  topmost one first (`useOverlayEntry` in `client/src/lib/hooks.js`).
- Keep the `data-sw-*` hooks on the component you render; tests and tools find controls by them. Select and toggle-group items carry
  `data-sw-option="<value>"`.

## Tokens

Defined once in `client/src/styles.css` as CSS variables, one set per theme and mode (see Themes), and mapped to Tailwind colours with
`@theme inline`:

| Token                                                      | Use                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `surface`, `surface-2`                                     | Panels and cards; hover and track backgrounds                                                                                                                                                                             |
| `sunken`                                                   | The canvas behind the board                                                                                                                                                                                               |
| `line`                                                     | Borders and dividers                                                                                                                                                                                                      |
| `line-strong`                                              | Borders that must show on the canvas: group frames, strong dividers                                                                                                                                                       |
| `fg`, `muted`, `faint`                                     | Text: primary, secondary, hints and placeholders                                                                                                                                                                          |
| `accent`, `accent-fg`                                      | Primary actions, focus rings, selection; text on the accent                                                                                                                                                               |
| `ok`, `warn`, `bad`                                        | Resolved, needs a person or a journey, errors and deletes                                                                                                                                                                 |
| `shadow-card`, `shadow-pop`                                | Resting controls; floating panels, popovers, sheets                                                                                                                                                                       |
| `shadow-lift`, `shadow-thumb`                              | A clickable card on hover; the inset hairline around page thumbnails                                                                                                                                                      |
| `animate-fade-in`, `animate-pop-in`, `animate-sheet-in`    | Overlay enter animations                                                                                                                                                                                                  |
| `animate-fade-out`, `animate-pop-out`, `animate-sheet-out` | Exit animations, opt-in (`data-[state=closed]:animate-*-out`). Kit tooltips and hover cards use them; dialogs, menus, popovers and selects unmount at once, so a closed one never lingers in the DOM or under the pointer |
| `animate-rise-in`, `animate-pulse-ring`, `animate-shimmer` | Content arriving; something new or at work (3 soft rings); skeletons                                                                                                                                                      |

### Type scale

Four steps for UI text plus a display size, as Tailwind `text-*` utilities (each sets its line height and tracking). Body copy stays
`text-sm` (14 px); counts and times add `tabular-nums`.

| Utility        | Size  | Use                                                         |
| -------------- | ----- | ----------------------------------------------------------- |
| `text-caption` | 11 px | Meta lines, badges, technical details, keyboard hints       |
| `text-ui`      | 13 px | Dense UI: list rows, menu items, panel controls             |
| `text-title`   | 15 px | Panel and section titles (`font-semibold`), list item names |
| `text-heading` | 20 px | Dialog and empty-state headlines, console section headers   |
| `text-display` | 28 px | Console page titles (one per page)                          |

### Motion

Easing: `ease-standard` (most transitions), `ease-emphasized` (things arriving: sheets, camera moves), `ease-exit` (things leaving).
Durations are variables: `duration-(--motion-fast)` 120 ms (hover, press, chevrons), `--motion-base` 180 ms (panels, sheets, a camera
jump), `--motion-slow` 280 ms (large layout changes). Exits are shorter than entrances. Keep `translate`/`scale` animations off containers of controls that tests or layout code measure right after mounting (use `animate-fade-in` there; a transform mid-flight makes a 44 px button measure 43.99). Every animation drops to 1 ms with
`prefers-reduced-motion`, and skeletons stop sweeping.

Radius: `rounded-md` for controls, `rounded-lg` for popovers and cards, `rounded-xl` for desktop dialogs, `rounded-t-2xl` for sheets.

## Themes

The profile menu (top right on the board and in the console) picks a mode and a theme. Both apply to the board and the console and are
saved in this browser (`localStorage` key `shapewall.appearance`, `{ "mode": "system", "theme": "default" }`).

- **Mode:** Light, Dark or System (follows the device and changes with it).
- **Theme:** Default (teal), Ocean (blue), Forest (green) and High contrast (black and white, 7:1 text, strong borders).

The choice is two attributes on `<html>`: `data-mode="light|dark"` (System already resolved) and `data-theme="default|ocean|forest|contrast"`.
Token blocks in `styles.css` are `:root` (Default light), `:root[data-mode='dark']`, `:root[data-theme='ocean']` and
`:root[data-theme='ocean'][data-mode='dark']`, and so on. Every block defines the full set of colour tokens.

No flash: `client/public/theme-boot.js` is a small classic script in the `<head>` of both shells, before the CSS and the bundle (the CSP
allows only same-origin scripts, so it cannot be inline). It reads the saved choice and sets the attributes before the first paint.
`client/src/lib/theme.js` takes over in the app: `useAppearance()`, `setAppearance({ mode, theme })`, and it follows the system setting
and other tabs. It also updates `<meta name="theme-color">`.

Adding a theme: add it to `THEMES` in `theme.js` and to the list in `theme-boot.js`, add a light and a dark block to `styles.css` and a
`.sw-swatch-<id>` for its menu tile. `test/theme.test.js` checks that every theme defines every colour token and that text and status
colours meet WCAG AA on `surface` and `surface-2` (7:1 for High contrast), in light and dark.

## Components

| Component                                                                                 | Notes                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                                                                                  | `variant`: default, soft (the primary action at rest: accent text on a light tint, same box as default), secondary, ghost, danger, link, inverse (on a filled chip). `size`: xs, sm, md, touch, icon-xs, icon-sm, icon. `asChild` for links.                      |
| `IconButton`                                                                              | Icon-only `Button` with `label` (its `aria-label`) shown as a tooltip; `tooltip` overrides the tip text.                                                                                                                                                          |
| `Tooltip`, `TooltipProvider`                                                              | `<Tooltip content="...">` around any kit control. One provider at the app root. Mouse and keyboard only.                                                                                                                                                          |
| `Select` (+ Trigger, Value, Content, Item, Group, Label, Separator)                       | A popover list on every screen, never the OS picker. Items cannot be `""`: use `placeholder` with `value=""`, or a sentinel. `SelectTrigger` takes `size` (xs, sm, touch) and `tone` (default, active).                                                           |
| `DropdownMenu` (+ Trigger, Content, Item, Label, Separator, Group, RadioGroup, RadioItem) | Menus of actions. `DropdownMenuRadioItem` picks one value (`indicator={false}` for tiles that show their own state). Used by the profile menu.                                                                                                                    |
| `Avatar`                                                                                  | Initials in a circle: `name`, `size` (xs, sm, md, lg), `person` (a stable colour from `colorKey` or the name, out of `PERSON_COLORS`, white initials at AA) or `agent` (a bot glyph). `initials(name)` and `personColor(key)` for the pieces.                     |
| `Popover` (+ Trigger, Anchor, Content)                                                    | Floating panels. `history={false}` for popovers that follow typing, like the mention list.                                                                                                                                                                        |
| `HoverCard` (+ Trigger, Content)                                                          | A preview on hover or keyboard focus (pin previews). Mouse and keyboard only: on touch the tap opens the real thing.                                                                                                                                              |
| `Dialog`                                                                                  | `open`, `onClose`, `title`, `description` (one line; `wrapDescription` for a full sentence), `footer`, `size` (sm, md, lg). A bottom sheet on phones, centered from `sm` up. Focuses the first field, or the element marked `data-autofocus`.                     |
| `Tabs` (+ List, Trigger, Content)                                                         | A choice that swaps the panel below (before/after on phones). `TabsList variant`: segmented (default) or underline (text-width tabs on a hairline, the active one underlined, the row scrolls sideways when it does not fit; every choice inside Checks uses it). |
| `ToggleGroup`                                                                             | One value out of a few (`options: [{ id, label, count? }]`); replaces the old `Segmented`. `variant`: segmented (default) or underline, the same two looks as `Tabs`.                                                                                             |
| `Toggle`                                                                                  | An on/off chip (`pressed`, `onPressedChange`); `variant` outline, pill or flat (a borderless toolbar button, pressed = the selected chip).                                                                                                                        |
| `Input`, `Textarea`                                                                       | `size` xs, sm, touch (16 px text on touch, so iOS does not zoom). `Input` takes an `icon`.                                                                                                                                                                        |
| `Badge`, `CommentDot`                                                                     | Chips and counters: `tone` neutral, accent, ok, warn, bad, solid; `shape` chip, count, tag.                                                                                                                                                                       |
| `Kbd`, `Separator`, `Spinner`                                                             | Small pieces.                                                                                                                                                                                                                                                     |
| `EmptyState`                                                                              | `icon`, `title`, text as children. Optional `action` (buttons), `details` (technical text behind a Details disclosure, never in the headline), `tone` (`bad` for a failure), `size` (`lg`: a whole screen, centered).                                             |
| `Collapsible` (+ Trigger, Content), `Disclosure`                                          | Show and hide a section in place; replaces native `<details>`. The trigger has a turning chevron and is 44 px below `lg`. `Disclosure` = `title`, `meta`, children, `defaultOpen`; extra props (`data-sw-*`) go on the root.                                      |
| `Skeleton`                                                                                | A loading placeholder shaped like what is coming (`className` sets the size). `aria-hidden`; give the screen one `role="status"` label.                                                                                                                           |

Local installations offer **Workspace Console** from the board profile menu, including when no agent is connected or the agent owner key is absent.
The local Console uses the hosted Console's header, sidebar and card layout with real boards from this installation. Its **Agents** section
holds everything about agents (the Agents card, the connection details and the endpoint form); its **Settings** section covers this
browser's appearance, installation details and updates. Agent configuration keeps its existing owner permissions; opening Console,
Agents or General settings does not unlock it. Hosted boards also label their workspace-management link **Workspace Console**. Local Console does
not create hosted accounts, workspaces or memberships. Inside Console, Projects, Agents and Settings stay in the sidebar; the profile menu
contains identity and appearance rather than duplicate workspace navigation. The earlier `?settings=general` board link remains supported.

The app sidebar (`AppRail`, `components/app-rail.jsx`) is a labelled menu when expanded and a rail of icons when collapsed. Collapsed,
an icon with more behind it (the board's Pages and Journeys, the sections of the workspace or account you are in) opens a flyout beside the
rail instead of expanding the sidebar: on hover after 150 ms, closing 250 ms after the pointer leaves both the icon and the panel, so
you can move into it; a click, tap, Enter, Space or ArrowRight opens it pinned and moves focus in. A choice in it, Escape (focus back on
the icon), a click outside or Tab past its end closes it. It is a non-modal `role="dialog"` named after its icon, the expanded
sidebar's width, on the Chrome layer (above the canvas and the comment thread, below dialogs and menus). Icons with nothing behind them
keep their tooltip. Only the panel button and Ctrl/Cmd+B expand the sidebar. The hover timing and height rules are in
`components/rail-flyout.js`. A rail icon can carry a dot (`dot`): the Journeys icon has one while a journey is open. On the board the
expanded sidebar puts a segmented `Tabs` switch, "Pages 26 | Journeys 6" with the counts as quiet text, where a single heading would
be, and shows the board's search field over the page tree or the journeys list (filter "Filter journeys", only past eight); the tab is
kept per browser (`board/SidebarNav.jsx`).

App-level pieces outside the kit, in `client/src/components/`: `ProfileMenu` (the avatar menu: account items, the console's workspace
switcher, View as in the demo, Appearance, and About Shapewall and updates) and `DemoBanner` (the demo's "viewing as" strip with Reset; in the console header a chip whose Reset is desktop only, on phones Reset the demo is in the profile menu).

Not included on purpose: `Checkbox` and `Switch` (the board has no checkboxes; on/off options are `Toggle`s) and `ScrollArea` (native
scrolling keeps momentum and `scrollIntoView` on phones).

## The board toolbar

On desktop the toolbar has two zones with the room between them, the way canvas tools lay it out. Left, identity: the board
switcher with the capture status dot (its tooltip says when the pages were captured); then, after a hairline, the view controls: the
screen-size switch, Views (the journeys and what the canvas shows) and, on a local board, Capture with its status. Right, open
panels: the viewer note, then the Comments, Agent and Checks toggles on one track (`Toggle variant="segment"`: the open panel's
toggle is the raised chip, exactly like the chosen screen size, none while the panel is closed), then Agent settings. The toolbar
holds what you look at; what you do to the board is in the board tools (below). One look for every control but the name: a quiet
32 px box with the same radius, hairline and tint, either a single button or a track whose chosen option is the raised chip.
Comments carries its count as a pill at its right end, and Agent carries the board's agent activity in the same place and size: a
dot for one agent, a count for more, accent while working (a slow `breathe`, the same as a working pin, never outside the button),
the attention colour when an agent needs a person, green for a moment when the last one finishes.

### The board tools

The tools you use on the board float at the bottom centre of the canvas, the way FigJam, Miro and tldraw do it
(`client/src/board/BoardTools.jsx`, their state in `tools.js`): **Select** (V, the default pointer: a click selects a page or
opens a pin, a drag on empty canvas pans), **Hand** (H: a drag anywhere pans, a click opens nothing; desktop only), a hairline,
then **Comment** (C), **Draw** (click a page to draw on it; with a comment or a reply open it draws on that comment's page)
and, on desktop when the board has live pages, **Select text**. One tool is in use at a time (`aria-pressed`): Comment, Draw
and Select text are the filled accent button, because they change what a click does; Select and Hand in use are quiet, the
neutral fill of a chosen segment (`bg-surface-2` with an inset hairline). Esc goes back a step at a time and ends on Select. The pill is the zoom controls' pill (`rounded-lg border border-line bg-surface/95 p-0.5 shadow-pop
backdrop-blur`, 32 px icon buttons), a labelled `role="toolbar"` with one tab stop: the arrow keys, Home and End move between
the tools, and each has a tooltip with its shortcut. A person who may not comment has no Comment or Draw tool, and with only
Select left there is no toolbar (a viewer on a phone). On a desktop they keep Select and Hand, and Select text while a page
is live.

The note for the tool in use sits just above the tools, one at a time: the comment hint ("Click a page to comment ..."),
"Commenting on ..." while the composer is open, the drawing bar, or the select-text note. Select has none. The tools, their note,
an open journey's bar and the toast are one column (the tool dock), so they never overlap. The tools are centred on the canvas,
not the window, and never sit over the zoom controls (bottom left) or the minimap (bottom right): on a narrow canvas they shift
off centre, then the zoom controls compact to out, level and in, then the minimap steps aside (`toolDock.js`, unit-tested). On a
phone the tools are the bottom bar: 44 px targets above the safe-area inset, hidden while a sheet or the keyboard is up.

Search is not in the toolbar. It is the field at the top of the expanded sidebar ("Search the board" with its
Ctrl/Cmd+K hint) and an icon in the collapsed rail; both open the command palette, as the shortcut does from anywhere. So the bar
keeps its shape whatever is open: an open journey shows as the state of the Views button in place (its name, truncated past 240 px,
and a clear button), and nothing else moves or collapses for it. When it gets narrow, `client/src/board/toolbarFit.js` drops words
in a fixed order (the panel toggles, Views (an open journey's name shortens first), then the screen-size toggle to icons with
tooltips, where the hairlines go too) and the board name truncates a little at each step, never below about 8 characters.
Accessible names, shortcuts and tooltips never change.
While a side panel is open its toggles are the panel's header: their track is exactly as wide as the panel under it, inside the
bar's 12 px padding on both sides (the panel's own inset), the three sharing the width, and it follows the panel's drag handle with
no transition (`sidePanelWidth.js` carries the width from the panel to the bar). Everything else in the right zone (the viewer
note, Agent settings) stays to their left. The left zone drops words sooner to make the room; when no step fits, the toggles keep
their own width. The panel is never narrower than its toggles need (`SIDE_PANEL` in `toolbarFit.js`: 384 px by default, 368 px at
least, 560 px or 40% of the window at most).
`test/toolbar-fit.test.js` checks the order and that nothing overlaps from a 1024 px window with the widest sidebar up. The phone
toolbar is a separate compact bar. `ToggleGroup` options take a `tooltip` for icon-only labels.

## The website

`website/` is a separate package and does not import the board's kit. Its `src/components/ui.jsx` uses the same component names and
variant names (`Button`, `IconButton`, `ToggleGroup`, `Badge`) in the site's brand colours (`brand/README.md`).

## Layers

One scale for `z-index`, lowest first. Pick the row that says what the thing is; do not invent a value in between.

| Layer     | Class             | What lives there                                                                                |
| --------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| Canvas    | `z-10`/`z-20`     | Pins, card headers and bars, resize handles, presence cursors.                                  |
| On canvas | `z-30`            | Things that belong to the canvas but float over cards: the comment thread and new-comment box,  |
|           |                   | the board tools and their note, the journey bar, canvas notes, Try this.                        |
| Chrome    | `z-40`            | Sticky app headers and the collapsed sidebar's flyouts.                                         |
| Modal     | `z-50`            | Dialogs, sheets, the command palette and their dimmed overlay. A modal covers everything below. |
| Menu      | `z-[60]`          | Dropdown menus, selects and small popovers, so they work inside a dialog.                       |
| Hover     | `z-[65]`/`z-[70]` | Hover cards and tooltips.                                                                       |
| Notice    | `z-[80]`          | Toasts and the skip link: never dimmed or covered.                                              |

The comment thread uses the shared `Popover`, but pinned to `z-30`: it stays open while you work elsewhere, so a confirm dialog opened
from a side panel must be able to cover it.
