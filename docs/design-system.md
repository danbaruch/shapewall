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
| `Button`                                                                                  | `variant`: default, secondary, ghost, danger, link, inverse (on a filled chip). `size`: xs, sm, md, touch, icon-xs, icon-sm, icon. `asChild` for links.                                                                                                           |
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
| `Toggle`                                                                                  | An on/off chip (`pressed`, `onPressedChange`); `variant` outline or pill.                                                                                                                                                                                         |
| `Input`, `Textarea`                                                                       | `size` xs, sm, touch (16 px text on touch, so iOS does not zoom). `Input` takes an `icon`.                                                                                                                                                                        |
| `Badge`, `CommentDot`                                                                     | Chips and counters: `tone` neutral, accent, ok, warn, bad, solid; `shape` chip, count, tag.                                                                                                                                                                       |
| `Kbd`, `Separator`, `Spinner`                                                             | Small pieces.                                                                                                                                                                                                                                                     |
| `EmptyState`                                                                              | `icon`, `title`, text as children. Optional `action` (buttons), `details` (technical text behind a Details disclosure, never in the headline), `tone` (`bad` for a failure), `size` (`lg`: a whole screen, centered).                                             |
| `Collapsible` (+ Trigger, Content), `Disclosure`                                          | Show and hide a section in place; replaces native `<details>`. The trigger has a turning chevron and is 44 px below `lg`. `Disclosure` = `title`, `meta`, children, `defaultOpen`; extra props (`data-sw-*`) go on the root.                                      |
| `Skeleton`                                                                                | A loading placeholder shaped like what is coming (`className` sets the size). `aria-hidden`; give the screen one `role="status"` label.                                                                                                                           |

Local installations offer **Workspace Console** from the board profile menu, including when no agent is connected or the agent owner key is absent.
The local Console uses the hosted Console's header, sidebar and card layout with real boards from this installation. Its **Settings** section
covers this browser's appearance, installation details and updates. Agent configuration keeps its existing owner permissions; opening
Console or General settings does not unlock it. Hosted boards also label their workspace-management link **Workspace Console**. Local Console does
not create hosted accounts, workspaces or memberships. Inside Console, Projects and Settings stay in the sidebar; the profile menu
contains identity and appearance rather than duplicate workspace navigation. The earlier `?settings=general` board link remains supported.

The app sidebar (`AppRail`, `components/app-rail.jsx`) is a labelled menu when expanded and a rail of icons when collapsed. Collapsed,
an icon with more behind it (the board's pages tree, the sections of the workspace or account you are in) opens a flyout beside the
rail instead of expanding the sidebar: on hover after 150 ms, closing 250 ms after the pointer leaves both the icon and the panel, so
you can move into it; a click, tap, Enter, Space or ArrowRight opens it pinned and moves focus in. A choice in it, Escape (focus back on
the icon), a click outside or Tab past its end closes it. It is a non-modal `role="dialog"` named after its icon, the expanded
sidebar's width, on the Chrome layer (above the canvas and the comment thread, below dialogs and menus). Icons with nothing behind them
keep their tooltip. Only the panel button and Ctrl/Cmd+B expand the sidebar. The hover timing and height rules are in
`components/rail-flyout.js`.

App-level pieces outside the kit, in `client/src/components/`: `ProfileMenu` (the avatar menu: account items, the console's workspace
switcher, View as in the demo, Appearance, and About Shapewall and updates) and `DemoBanner` (the demo's "viewing as" strip with Reset; in the console header a chip whose Reset is desktop only, on phones Reset the demo is in the profile menu).

Not included on purpose: `Checkbox` and `Switch` (the board has no checkboxes; on/off options are `Toggle`s) and `ScrollArea` (native
scrolling keeps momentum and `scrollIntoView` on phones).

## The website

`website/` is a separate package and does not import the board's kit. Its `src/components/ui.jsx` uses the same component names and
variant names (`Button`, `IconButton`, `ToggleGroup`, `Badge`) in the site's brand colours (`brand/README.md`).

## Layers

One scale for `z-index`, lowest first. Pick the row that says what the thing is; do not invent a value in between.

| Layer     | Class             | What lives there                                                                                |
| --------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| Canvas    | `z-10`/`z-20`     | Pins, card headers and bars, resize handles, presence cursors.                                  |
| On canvas | `z-30`            | Things that belong to the canvas but float over cards: the comment thread and new-comment box,  |
|           |                   | the journey bar, canvas notes, Try this.                                                        |
| Chrome    | `z-40`            | Sticky app headers and the collapsed sidebar's flyouts.                                         |
| Modal     | `z-50`            | Dialogs, sheets, the command palette and their dimmed overlay. A modal covers everything below. |
| Menu      | `z-[60]`          | Dropdown menus, selects and small popovers, so they work inside a dialog.                       |
| Hover     | `z-[65]`/`z-[70]` | Hover cards and tooltips.                                                                       |
| Notice    | `z-[80]`          | Toasts and the skip link: never dimmed or covered.                                              |

The comment thread uses the shared `Popover`, but pinned to `z-30`: it stays open while you work elsewhere, so a confirm dialog opened
from a side panel must be able to cover it.
