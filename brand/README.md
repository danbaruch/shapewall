# Shapewall brand

The mark is a wall of page tiles with one tile picked out in amber: the page you are shaping right now. It is drawn on a 32 px grid
(a pixel-aligned 16 px version exists for favicons), so it stays readable in a browser tab.

## Files

| File                           | Use                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `shapewall-mark.svg`           | The mark, full colour. App icons, favicons, avatars. 32 px grid.                       |
| `shapewall-mark-16.svg`        | Pixel-aligned mark for 16 px favicons only.                                            |
| `shapewall-mark-mono.svg`      | One colour (`currentColor`), tiles knocked out. For single-colour print or UI chrome.  |
| `shapewall-mark-maskable.svg`  | Full-bleed square for PWA maskable icons and Apple touch icons (content in safe zone). |
| `shapewall-wordmark.svg`       | "Shapewall" in Inter Bold, outlined. Ink on light backgrounds.                         |
| `shapewall-wordmark-white.svg` | The same in white, for dark backgrounds.                                               |
| `shapewall-logo.svg`           | Mark + wordmark, horizontal lockup. The default logo.                                  |
| `shapewall-logo-white.svg`     | Lockup with a white wordmark, for dark backgrounds.                                    |

The wordmark and lockups are generated from the mark by `website/scripts/brand.mjs` (which also writes the site's favicons and PWA
icons). The board's icons (`client/public/favicon.svg` and `client/public/icons/`) are copies of the mark and of those PNGs, under
the names the board's manifest uses. Edit the mark SVGs by hand, rerun the script, then copy the icons again.

## Colours

| Name      | Hex       | Use                                                                     |
| --------- | --------- | ----------------------------------------------------------------------- |
| Wall teal | `#0f766e` | Primary. The mark's ground, buttons, links. Same as the board's accent. |
| Deep teal | `#115e59` | Hover and pressed states, text on teal tints.                           |
| Teal tint | `#ccfbf1` | Highlights, selection, soft badges.                                     |
| Pin amber | `#f59e0b` | The highlighted tile, comment pins, one accent per view at most.        |
| Amber ink | `#b45309` | Amber text on light backgrounds (AA contrast).                          |
| Ink       | `#18181b` | Text, the wordmark.                                                     |
| Slate     | `#52525b` | Secondary text.                                                         |
| Line      | `#e4e4e7` | Borders, dividers.                                                      |
| Paper     | `#fafaf9` | Page background.                                                        |
| Night     | `#0c1312` | Dark sections and dark mode ground.                                     |

On dark backgrounds use the bright teal `#2dd4bf` for accents (the board's dark-mode accent).

## Type

Inter (variable) for everything, JetBrains Mono for code. The wordmark is Inter Bold with -2.5% tracking.

## Usage

- Keep clear space around the mark of at least a quarter of its width.
- Do not recolour the tiles, rotate the mark, or put the full-colour mark on a teal background (use the mono mark).
- Generated art and share cards carry no text except the wordmark.
