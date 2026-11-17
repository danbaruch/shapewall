Checking a change should take a second, on the page where it was asked for. Shapewall gives you three ways to compare.

## Variants

A variant is another version of a page, captured from any URL and placed beside the page on the board, joined by a dashed edge.
Use it for a branch preview, a redesign, or an agent's take on "try a calmer hero".

```sh
shapewall variant add pricing --url http://localhost:5174/pricing --title "Yearly toggle" --note "Billing switch, clearer Plus card" --id yearly-toggle
shapewall variant list
shapewall variant rm yearly-toggle
```

Without `--id`, the id is the title as a slug plus four random characters (`yearly-toggle-3f9a`); `variant add` prints it, and
`variant list` shows them all.

![A pricing page with its variant beside it](/images/variant.webp)

Reviewers comment on the variant like on any page.

## Before and after on resolved comments

A recapture keeps the shot it replaces (the newest 5 per page and viewport by default, see `versions` in the
[config](/docs/config#versions)), and every comment remembers the capture it was made on. Once a comment is resolved and its page
recaptured, open the comment: the panel shows before and after around the pin, side by side on a desktop and one at a time on a phone.
If the fix was recorded with `shapewall comments resolve ID --ref URL`, the pull request or commit is linked as "Fixed in".

| Before                                                     | After                                                    |
| ---------------------------------------------------------- | -------------------------------------------------------- |
| ![The pricing page before the change](/images/before.webp) | ![The pricing page after the change](/images/after.webp) |

If the change is not right, reopen the comment with a note; the agent picks it up again.

## Page history

Every kept capture of a page and viewport is in its history (the clock badge on a card, or History on a selected frame). Pick an
earlier one to see it beside the current capture, with the changed pixels in red over the current one and the changed share, as in
compare mode. **Diff overlay** turns the red off. The diff is computed in your browser, so it works in a static export too.

## Staging beside production

List the environments a board can capture. The pages stay the same; only the base URL changes.

```json
{
  "environments": [
    { "id": "staging", "baseUrl": "https://staging.example.com" },
    { "id": "production", "baseUrl": "https://www.example.com" }
  ],
  "pages": [
    { "id": "home", "path": "/" },
    { "id": "pricing", "path": "/pricing" }
  ]
}
```

The first environment is the default; capture the others with `--env`:

```sh
shapewall capture                    # staging, the default
shapewall capture --env production
```

On the board, **Compare** (in **Views**, or in the board menu on a phone) shows each page in two environments side by side, with the
changed pixels in red over the second one, the changed share on each card and a **Changed pages only** filter. Pick the two
environments in the compare bar, and swap them with the arrows between. Diffs are computed with pixelmatch and cached until either
capture changes. A static export (`shapewall export`) includes compare data for every pair of captured environments.

## Comments while comparing

Comments work in compare mode, on either side of a card. Pick **Comment** (or press C), click the Staging or the Production side of a
page and write as usual: images, drawing and dictation all work there. The comment is left on the environment you clicked:

![Pricing on staging beside production, the changed pixels in red, and a comment thread marked Left on Production](/images/compare-comment.webp)

- **The pin stays with its environment.** It is on that side in every later compare, swapped too, and it sticks to that side's
  elements. A drawing goes on that side's capture.
- **The thread says where it was left**, for example "Left on Production". Outside compare mode the board shows the default
  environment; a comment left on another one keeps its pin there, and its thread names the environment.
- **On a phone** the compare bar is one row: the two environments, swap, and the options (with the number of changed pages on the
  button). The thread sheet keeps its full height and the pin lands on screen above it.
- **Esc** leaves compare once nothing else is open: a thread, the comment box, a menu or comment mode closes first.

Agents see it too: in `shapewall comments --json` a comment left on another environment than the default carries that
environment's id in `environment`, and its files are that environment's capture. Only the default environment keeps capture
versions, so before and after on a resolved comment is for comments left on the default environment.

## Which one to use

- **A fix** to an existing page: just resolve the comment and look at before and after.
- **A direction** you are not sure about: a variant, so the original stays.
- **A release**: environments, staging next to production, page by page, with comments on either side.
