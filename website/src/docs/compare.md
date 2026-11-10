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

On the board, **Compare** shows each page in two environments side by side, with the changed pixels in red over the second one, the
changed share on each card and a **Changed pages only** filter. Diffs are computed with pixelmatch and cached until either capture
changes. A static export (`shapewall export`) includes compare data for every pair of captured environments.

## Which one to use

- **A fix** to an existing page: just resolve the comment and look at before and after.
- **A direction** you are not sure about: a variant, so the original stays.
- **A release**: environments, staging next to production, page by page.
