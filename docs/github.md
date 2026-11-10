# GitHub connect

Connect a board to a GitHub repository: turn a comment into a GitHub issue, link the pull requests that fix comments, and have a comment
resolve itself when its pull request merges. Everything runs from your own Shapewall (the CLI, `shapewall serve`, `shapewall mcp`); there is
no GitHub App and no Shapewall account. Calls go straight to the GitHub REST API with a token you provide.

## Set it up

1. Name the repository in `shapewall.config.json`:

   ```json
   {
     "github": {
       "repo": "acme/site",
       "boardUrl": "https://review.example.com/",
       "labels": ["feedback"]
     }
   }
   ```

2. Give Shapewall a token in the environment, as `SHAPEWALL_GITHUB_TOKEN` or `GITHUB_TOKEN` (the first one set wins). A fine-grained
   personal access token for that one repository with **Issues: read and write** and **Pull requests: read** is enough. In GitHub Actions
   the built-in `GITHUB_TOKEN` works. With neither variable set, Shapewall asks a signed-in GitHub CLI (`gh auth token`), for
   github.com only (never for another `apiUrl`); the token is used for the request and never printed, logged or stored.
   `shapewall doctor` checks the token: one GitHub rejects (401 Bad credentials) is a FAIL.

3. Check it: `shapewall doctor` reports the repo, which variable the token came from, whether the token can see the repo, and whether a
   webhook secret is set.

The token and the webhook secret are read from the environment only. A `token` or `webhookSecret` key in the config is an error, they are
never written to `.shapewall/`, never exported, never sent to the board, and error messages name the variable, not its value.

| Key               | What it does                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github.repo`     | `owner/name`. Also `$SHAPEWALL_GITHUB_REPO`, which wins over the config.                                                                                                                                                                                      |
| `github.boardUrl` | Where people open the board, for the link back from an issue and the screenshot link. Default: the top-level `boardUrl`, else a running `shapewall serve` for this config, else `http://127.0.0.1:4600/`; `$SHAPEWALL_BOARD_URL` overrides it.                |
| `github.labels`   | Labels put on new issues (up to 10). They should exist in the repo.                                                                                                                                                                                           |
| `github.board`    | The board that bare `shapewall:<id>` markers mean (default: the first board).                                                                                                                                                                                 |
| `github.apiUrl`   | GitHub Enterprise Server: `https://HOST/api/v3`. Your token is only sent there once `$SHAPEWALL_GITHUB_API_URL` is set to the same URL in your environment, so a cloned config cannot redirect it. Must be https (plain http only on 127.0.0.1 or localhost). |

## Issues from comments

- **On the board:** select a comment and press **GitHub issue**. The button shows when the server has a repo and a token; once the issue
  exists, the comment shows a link to it instead.
- **CLI:** `shapewall github issue 12` (add `--board ID` on a multi-board config, `--json` for the result as JSON).
- **API:** `POST /api/boards/:id/comments/:cid/github/issue` (201 with `{ comment, issue, created: true }`, or 200 with the existing one).
- **MCP:** the `create_github_issue` tool.

A comment gets one issue: asking again returns the one it has. The issue holds the comment text (quoted; reviewers' `@mentions` are kept
from pinging GitHub accounts of the same name), the author, the page and its URL, the viewport, the element selector and text, the pin
position, a link to the screenshot on the board with the part around the pin (the same crop `get_comment` gives agents), the capture version
and a link that opens the board with the comment selected. It ends with the marker to put in a pull request.

The issue number and URL are stored on the comment (`github.issue`) and show in `shapewall comments`, `comments --json`, the API, MCP and
static exports.

## Pull requests

A comment is linked to a pull request in any of these ways:

- **In the PR description or title:** `shapewall:12`, `Fixes shapewall#12`, or `shapewall:<board>/12` on a multi-board config.
- **By closing the comment's issue:** a PR that says `Fixes #45`, where #45 is the issue made from the comment.
- **By hand:** `shapewall github link 12 34` (also `#34` or the PR URL), `POST /api/boards/:id/comments/:cid/github/link` with
  `{ "pr": 34 }`, or the MCP `link_pull_request` tool.

Links found in descriptions are picked up by `shapewall github sync` or the webhook (below). The board shows each linked PR with its state:
open, closed or merged.

**When a linked PR merges**, Shapewall resolves the comment once: status resolved, the resolution note "Merged in pull request #34 (its
title).", the PR URL as the fix reference, and a reply from `github` with the link. The comment keeps the capture it was made on, so
before and after works as for any fixed comment once the page is recaptured. If someone reopens the comment later, the same merge never
resolves it again. A comment that was already resolved keeps its note and only gets the reply (and the PR as its fix, if it had none).

## Sync without a webhook

```sh
shapewall github sync
```

Reads the repo's pull requests, most recently updated first, links the ones that name a comment, records merges, and refreshes linked PRs
that are still open. It remembers when it last ran (`.shapewall/github-sync.json`) and next time only reads what changed since (up to 250
pull requests per run). Run it by hand, after a merge in CI, or on whatever schedule you like; Shapewall does not schedule it for you.

## Webhook

With a public board you can let GitHub tell Shapewall instead of polling:

1. Pick a random secret and start the server with it: `SHAPEWALL_GITHUB_WEBHOOK_SECRET=... shapewall serve`. Without the secret the
   endpoint does not exist (404).
2. In the repo: Settings, Webhooks, Add webhook. Payload URL `https://review.example.com/api/github/webhook`, content type
   `application/json`, the same secret, and the **Pull requests** event.

Every delivery must carry a valid `X-Hub-Signature-256` for the secret (checked in constant time), otherwise it gets 401 and changes
nothing. `ping` answers 200; `pull_request` events of the configured repo link and resolve as above; other events and other repos are
acknowledged and ignored. The webhook needs no token: the event carries the pull request. A `--read-only` server refuses deliveries.

The board's Host check still applies, so add the public name with `--allowed-host` (see [deployment.md](deployment.md)). If an
authenticating proxy sits in front of the board, let `POST /api/github/webhook` through without the login; the signature is what protects
it.

## Safety notes

- Anyone who can use the board can make issues with the server's token (as they can start captures). Use `--read-only` for boards you only
  show, and give the token access to one repository only.
- Comment text goes into public issues if the repo is public. Shapewall never posts to GitHub on its own: an issue is only made when
  someone asks for it.
- PR descriptions are untrusted input. Shapewall reads only the markers and the merge state from them; it never runs anything from a PR.
