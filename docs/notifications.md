# Notifications

Shapewall can tell people when something happens to a comment: a signed webhook for your own tools, Slack, Discord, and email through
[Resend](https://resend.com). It is off until you configure a channel. Every message links back to the comment on the board.

## Events

| Event                    | When                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `comment.created`        | A new comment.                                                                     |
| `comment.replied`        | A reply on a comment (from a person, `shapewall comments reply`, MCP or `watch`).  |
| `comment.mentioned`      | Someone is @mentioned in a new comment, a reply, or an edit that adds the mention. |
| `comment.status_changed` | The agent status changes (`queued`, `working`, `done`, `needs-human`, cleared).    |
| `comment.resolved`       | A comment is resolved.                                                             |
| `comment.reopened`       | A resolved comment is reopened.                                                    |

Events come from whatever changes the comment: the board (`shapewall serve`), the CLI (`shapewall comments add|resolve|reopen|reply|status`),
`shapewall watch`, `shapewall mcp` and the starter agent. Every process appends them to a shared event log in the output folder
(`.shapewall/events.jsonl`, see [the event log](#the-event-log)), and exactly one process sends each message:

- **While `shapewall serve` runs, it is the notifier.** It sends every change made from the moment it started, whichever process made
  it, with serve's own environment: a `comments resolve` in another shell needs no `SHAPEWALL_WEBHOOK_SECRET` of its own. It records
  this in `.shapewall/notifier.json` (its pid and a heartbeat every 10 seconds). A second `serve` on the same output folder leaves it to
  the first, and takes over if that one stops. A server starts at the end of the log, so a restart never sends old events again. When
  it stops cleanly (Ctrl+C, SIGTERM) it reads the log one last time before giving the lease back.
- **Without a running server** each command sends the changes it makes itself, and waits up to 15 seconds for its messages before it
  exits. A `notifier.json` whose process is gone, or whose heartbeat is more than a minute old, counts as no server.
- **Nothing twice, nothing lost.** An event that happened after the server took over is the server's; anything earlier, or anything
  that could not be written to the log, is sent by the process that made it. A server that stalls for more than a minute (a suspended
  laptop, a blocked process) counts as gone meanwhile, so other processes send their own changes; when it wakes it skips the events from
  that gap instead of sending them again.
- **The gap left:** a server killed with SIGKILL (or one that crashes) cannot read the log a last time or give the lease back. Changes
  other processes make after its last read, and until its heartbeat is a minute old, are sent by nobody.

`actor` says who made the change: the author of a new comment or reply; for resolve, reopen and agent status changes, `--author` on the
CLI (default `agent`), `agent` from MCP, `shapewall` from `watch`, `github` when a merged pull request resolves it, and the commenter's
name from the board. It is `null` when nobody said. `actor` and comment authors are self-reported, not attested: anyone who can run the
CLI or comment on the board can give any name, so a bot must not treat a name as proof of who acted.

## Config

Secrets never go in `shapewall.config.json`. The config names environment variables (`urlEnv`, `secretEnv`, `apiKeyEnv`) and Shapewall
reads them when it sends, so a config file, an export or a log line never holds a secret. Keys like `secret`, `apiKey` or `token`, and a
Slack or Discord `url` (the URL is the secret), are refused with a pointer to the right key.

```json
{
  "notifications": {
    "boardUrl": "https://shapewall.example.com/",
    "people": {
      "robin": { "email": "robin@example.com", "slack": "U012AB3CD", "discord": "123456789012345678" }
    },
    "channels": [
      { "id": "team", "type": "slack", "urlEnv": "SHAPEWALL_SLACK_WEBHOOK_URL" },
      { "id": "ops", "type": "discord", "events": ["resolved", "reopened"] },
      { "id": "hooks", "type": "webhook", "url": "https://ci.example.com/shapewall", "secretEnv": "SHAPEWALL_WEBHOOK_SECRET" },
      { "id": "mail", "type": "email", "from": "Shapewall <reviews@example.com>" }
    ]
  }
}
```

| Key        | Type        | Default              | Notes                                                                                                                                                                               |
| ---------- | ----------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boardUrl` | http(s) URL | the `serve` address  | Where people open the board, for links in messages. Else the top-level `boardUrl`, the address of a running `shapewall serve`, then port 4600. `$SHAPEWALL_BOARD_URL` overrides it. |
| `people`   | object      | none                 | Mention handle to `{ email, slack, discord }` (any of them). Slack member ids look like `U012AB3CD`.                                                                                |
| `retries`  | 0-10        | `3`                  | Retries after a failed send.                                                                                                                                                        |
| `channels` | Channel[]   | from the environment | Up to 20. Without this key, channels come from environment variables alone (below).                                                                                                 |

### Channel

| Key         | Types                 | Default                                     | Notes                                                                         |
| ----------- | --------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| `id`        | all                   | the type                                    | Used by `shapewall notify test ID`. Lowercase letters, digits, dashes.        |
| `type`      | all                   | required                                    | `webhook`, `slack`, `discord` or `email`.                                     |
| `events`    | all                   | see below                                   | Event names, with or without `comment.`; `"all"` for every one.               |
| `boards`    | all                   | every board                                 | Only these board ids.                                                         |
| `urlEnv`    | webhook/slack/discord | per type, as in the environment table below | The variable holding the webhook URL.                                         |
| `url`       | webhook               | none                                        | A generic webhook may give its URL in the config instead.                     |
| `secretEnv` | webhook               | `SHAPEWALL_WEBHOOK_SECRET`                  | The signing secret. Required: unsigned webhooks are not sent.                 |
| `apiKeyEnv` | email                 | `RESEND_API_KEY`                            | The Resend API key. Must be `RESEND_API_KEY` or a name starting `SHAPEWALL_`. |
| `from`      | email                 | required                                    | `Name <reviews@example.com>`, on a domain you verified with Resend.           |
| `to`        | email                 | none                                        | Addresses for events other than mentions.                                     |
| `fallback`  | email                 | `"none"`                                    | `"outbox"`: with no API key, write `.eml` files instead of sending (below).   |

Default events: webhooks get all six; Slack and Discord get created, replied, resolved and reopened (a mention pings the person inside
that message, so a separate mention message would be a duplicate); email gets `comment.mentioned` only.

### Per-person routing

`people` maps a mention handle to where that person is reached:

- **Slack and Discord**: `@robin` in a comment or reply becomes a real ping (`<@U012AB3CD>`) for mapped people; everyone else stays plain
  text. A `comment.mentioned` message starts with the ping.
- **Email**: a `comment.mentioned` event goes to the mentioned person's `email`. A mention of someone with no email is skipped (logged
  once). Other events go to the channel's `to` list.
- **Webhooks** carry the handle only, never anyone's email or chat ids.

### Channels from the environment

With no `channels` key, these variables set up channels by themselves (ids in brackets):

| Variables                                                                        | Channel                          |
| -------------------------------------------------------------------------------- | -------------------------------- |
| `SHAPEWALL_WEBHOOK_URL` and `SHAPEWALL_WEBHOOK_SECRET`                           | signed webhook (`webhook`)       |
| `SHAPEWALL_SLACK_WEBHOOK_URL`                                                    | Slack incoming webhook (`slack`) |
| `SHAPEWALL_DISCORD_WEBHOOK_URL`                                                  | Discord webhook (`discord`)      |
| `RESEND_API_KEY`, `SHAPEWALL_EMAIL_FROM` and optionally `SHAPEWALL_EMAIL_TO` (,) | email (`email`)                  |

`SHAPEWALL_BOARD_URL` sets the link base; `SHAPEWALL_RESEND_URL` points email at another Resend-compatible endpoint (a proxy, or a stub in
tests).

## Delivery

- **Never in the way.** A change is saved and answered first; its messages are queued and sent in the background, in order per channel.
  A slow or broken endpoint never slows the board or the CLI.
- **Retries.** Network errors, timeouts (10 seconds), `408`, `429` and `5xx` are retried with exponential backoff (1 s, 2 s, 4 s, with
  jitter), honouring `Retry-After` up to a minute. Other answers (`400`, `401`, `404`) are final. A channel queues at most 200 messages;
  past that the oldest is dropped, with a log line.
- **Logs** say which channel, which event and the HTTP status or error code. They never include a URL, a header, a body or a secret.
- **Pings.** Comment text is escaped for each format: a comment cannot write `<!channel>`, `@everyone` or a link of its own. Discord
  messages set `allowed_mentions` to the mapped people only.

## The signed webhook

A `POST` with a JSON body:

```json
{
  "id": "6f0c5d2e-...",
  "type": "comment.created",
  "at": "2026-11-04T18:21:07.512Z",
  "board": { "id": "site", "title": "My site" },
  "text": "Robin commented on Pricing (desktop)",
  "url": "https://shapewall.example.com/?board=site&c=12&filter=all",
  "comment": {
    "id": 12,
    "pageId": "pricing",
    "pageTitle": "Pricing",
    "viewport": "desktop",
    "author": "Robin",
    "body": "The annual toggle hides the monthly price, @sam",
    "status": "open",
    "agentStatus": null,
    "mentions": ["sam"],
    "replyCount": 0,
    "resolution": null,
    "fixRef": null,
    "createdAt": "2026-11-04T18:21:07.512Z",
    "updatedAt": "2026-11-04T18:21:07.512Z"
  },
  "actor": "Robin"
}
```

`comment.replied` adds `reply`, `comment.mentioned` adds `handle` (and `reply` when the mention was in one), `status_changed`,
`resolved` and `reopened` add `previous`. Headers:

| Header                  | Value                                                         |
| ----------------------- | ------------------------------------------------------------- |
| `X-Shapewall-Event`     | The event type.                                               |
| `X-Shapewall-Delivery`  | The event id; the same on every retry, so you can de-dupe.    |
| `X-Shapewall-Timestamp` | Unix seconds when it was signed.                              |
| `X-Shapewall-Signature` | `sha256=` and the hex HMAC-SHA256 of `timestamp + "." + body` |

Verify it before trusting the body, and reject old timestamps:

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function verify(req, rawBody, secret) {
  const timestamp = req.headers['x-shapewall-timestamp']
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false
  const expected = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`
  const given = String(req.headers['x-shapewall-signature'] || '')
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}
```

## The event log

`.shapewall/events.jsonl` holds one JSON line per event, from every process, appended under a file lock (so lines never interleave).
Past 5 MB it is renamed to `events.1.jsonl` (one older file is kept) and a new one starts. Each line is what `shapewall events --json`
prints:

```json
{
  "id": "5b0c...",
  "type": "comment.resolved",
  "at": "2026-11-05T19:09:41.015Z",
  "board": "site",
  "commentId": 2,
  "actor": "review-bot",
  "comment": {
    "id": 2,
    "pageId": "signup",
    "viewport": "phone",
    "author": "sam",
    "body": "the signup button is hard to see on phone",
    "status": "resolved",
    "agentStatus": null,
    "resolution": "Bigger and darker now",
    "fixRef": null,
    "mentions": [],
    "replyCount": 2,
    "element": { "selector": "button[data-testid=\"signup-submit\"]", "text": "Create account" },
    "captureVersion": "20261105T183551624Z-d37e",
    "createdAt": "2026-11-05T18:38:20.614Z",
    "updatedAt": "2026-11-05T19:09:41.015Z"
  },
  "previous": { "status": "open" }
}
```

`comment.replied` and mentions in a reply add `reply` (`{ id, author, body, createdAt }`), `comment.mentioned` adds `handle`, and
`comment.status_changed` adds `agentStatus` beside `previous`. The comment is a summary (no thread, no file paths); `shapewall comments
get ID --json` has the rest. The log is local data in the output folder, like `comments.json`: keep it out of git. Deleting a comment
does not remove it from the log: the bodies and replies of a deleted comment stay in `events.jsonl` (and `events.1.jsonl`) until rotation
pushes them out, after up to two 5 MB files of newer events. To remove them sooner, delete both files while no Shapewall process runs.

## Email without an API key

Email is off without `RESEND_API_KEY` (or the channel's `apiKeyEnv`): there is no SMTP fallback. To see what would be sent, or to hand
messages to a local mail pickup, set `"fallback": "outbox"` on the channel: each message is written to
`<outputDir>/notifications/outbox/` as an `.eml` file (readable only by you) instead.

## Commands

```text
shapewall notify list [--json]                  every channel, its events, and what it still needs (variable names only)
shapewall notify test CHANNEL [--to EMAIL]      send a test message; exit 1 if it fails
shapewall doctor                                includes a notifications line: warn when a channel is missing a variable
shapewall events --follow --json                the same events as JSON lines, for a bot of your own (no webhook needed)
```

`notify test` sends a message marked as a test, through the same path as real ones (retries included), and prints the HTTP status.
For email it goes to the channel's `to` list, or `--to`.
