# Notifications

Shapewall can tell people when something happens to a comment: a signed webhook for your own tools, Slack, Discord, Telegram, and email
through [Resend](https://resend.com). It is off until you configure a channel. Every message links back to the comment on the board.

## Events

| Event                          | When                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `comment.created`              | A new comment.                                                                     |
| `comment.replied`              | A reply on a comment (from a person, `shapewall comments reply`, MCP or `watch`).  |
| `comment.mentioned`            | Someone is @mentioned in a new comment, a reply, or an edit that adds the mention. |
| `comment.agent_status_changed` | The agent status changes (`queued`, `working`, `done`, `needs-human`, cleared).    |
| `comment.resolved`             | A comment is resolved.                                                             |
| `comment.reopened`             | A resolved comment is reopened.                                                    |

`comment.agent_status_changed` was called `comment.status_changed` before 1.0. A channel's `events` list may still say
`comment.status_changed` (or `status_changed`): it is read as the new name, with one deprecation warning on stderr. Event log lines
written before 1.0 read back with the new name too.

Events come from whatever changes the comment: the board (`shapewall serve`), the CLI (`shapewall comments add|resolve|reopen|reply|status`),
`shapewall watch`, `shapewall mcp` and the starter agent. Every process appends them to a shared event log in the output folder
(`.shapewall/events.jsonl`, see [the event log](#the-event-log)), and exactly one process sends each message:

- **While `shapewall serve` runs, it is the notifier.** It sends every change made from the moment it started, whichever process made
  it, with serve's own environment: a `comments resolve` in another shell needs no `SHAPEWALL_WEBHOOK_SECRET` of its own. It records
  this in `.shapewall/notifier.json` (its pid and a heartbeat every 10 seconds). A second `serve` on the same output folder leaves it to
  the first, and takes over if that one stops. A server starts at the end of the log, so a restart never sends old events again. When
  it stops cleanly (Ctrl+C, SIGTERM) it reads the log one last time before giving the lease back.
- **Without a running server** each command sends the changes it makes itself, and waits for its messages before it exits (up to
  15 seconds; `watch` up to 5 when it stops). The starter agent (`shapewall agent sandbox run|watch`) on a local board sends its own
  changes the same way. A `notifier.json` whose process is gone, or whose heartbeat is more than a minute old, counts as no server.
- **Nothing twice, nothing lost.** An event that happened after the server took over is the server's; anything earlier, or anything
  that could not be written to the log, is sent by the process that made it. A server that stalls for more than a minute (a suspended
  laptop, a blocked process) counts as gone meanwhile, so other processes send their own changes; when it wakes it skips the events from
  that gap instead of sending them again.
- **The gap left:** a server killed with SIGKILL (or one that crashes) cannot read the log a last time or give the lease back. Changes
  other processes make after its last read, and until its heartbeat is a minute old, are sent by nobody.

**The solo engine (experimental)** writes the same `events.jsonl` lines and is the notifier for its project folder in the same way,
for changes made on the board, through the token API and over MCP. Two differences: `actor` is `null` for resolve, reopen, edits and
agent status changes (the engine does not record who made them yet), and a share link guest's text never makes a `comment.mentioned`
event, as on a hosted board.

`actor` says who made the change: the author of a new comment or reply; for resolve, reopen and agent status changes, `--author` on the
CLI (default `agent`), `agent` from MCP, `shapewall` from `watch`, `github` when a merged pull request resolves it, and the commenter's
name from the board. It is `null` when nobody said. `actor` and comment authors are self-reported, not attested: anyone who can run the
CLI or comment on the board can give any name, so a bot must not treat a name as proof of who acted.

## Config

Secrets never go in `shapewall.config.json`. The config names environment variables (`urlEnv`, `secretEnv`, `apiKeyEnv`) and Shapewall
reads them when it sends, so a config file, an export or a log line never holds a secret. Keys like `secret`, `apiKey` or `token`, and a
Slack or Discord `url` (the URL is the secret), are refused with a pointer to the right key. A Telegram bot token is read from
`tokenEnv` the same way, and its chat from `chatIdEnv`.

```json
{
  "boardUrl": "https://shapewall.example.com/",
  "notifications": {
    "people": {
      "robin": { "email": "robin@example.com", "slack": "U012AB3CD", "discord": "123456789012345678", "telegram": "123456789" }
    },
    "channels": [
      { "id": "team", "type": "slack", "urlEnv": "SHAPEWALL_SLACK_WEBHOOK_URL" },
      { "id": "ops", "type": "discord", "events": ["resolved", "reopened"] },
      { "id": "phones", "type": "telegram", "chatIdEnv": "SHAPEWALL_TELEGRAM_CHAT_ID" },
      { "id": "hooks", "type": "webhook", "urlEnv": "SHAPEWALL_WEBHOOK_URL", "secretEnv": "SHAPEWALL_WEBHOOK_SECRET" },
      { "id": "mail", "type": "email", "from": "Shapewall <notify@example.com>" }
    ]
  }
}
```

| Key        | Type        | Default              | Notes                                                                                                                                                                                                                                                          |
| ---------- | ----------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boardUrl` | http(s) URL | the `serve` address  | Deprecated (it still works, with a warning): set the top-level `boardUrl`. Where people open the board, for links in messages. Else the top-level `boardUrl`, the address of a running `shapewall serve`, then port 4600. `$SHAPEWALL_BOARD_URL` overrides it. |
| `people`   | object      | none                 | Mention handle to `{ email, slack, discord, telegram }` (any of them). Slack member ids look like `U012AB3CD`; Discord and Telegram user ids are digits.                                                                                                       |
| `retries`  | 0-10        | `3`                  | Retries after a failed send.                                                                                                                                                                                                                                   |
| `channels` | Channel[]   | from the environment | Up to 20. Without this key, channels come from environment variables alone (below).                                                                                                                                                                            |

### Channel

| Key         | Types                 | Default                                     | Notes                                                                         |
| ----------- | --------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| `id`        | all                   | the type                                    | Used by `shapewall notify test ID`. Lowercase letters, digits, dashes.        |
| `type`      | all                   | required                                    | `webhook`, `slack`, `discord`, `telegram` or `email`.                         |
| `events`    | all                   | see below                                   | Event names, with or without `comment.`; `["all"]` for every one.             |
| `boards`    | all                   | every board                                 | Only these board ids.                                                         |
| `urlEnv`    | webhook/slack/discord | per type, as in the environment table below | The variable holding the webhook URL.                                         |
| `secretEnv` | webhook               | `SHAPEWALL_WEBHOOK_SECRET`                  | The signing secret. Required: unsigned webhooks are not sent.                 |
| `tokenEnv`  | telegram              | `SHAPEWALL_TELEGRAM_BOT_TOKEN`              | The bot token. Or `SHAPEWALL_TELEGRAM_<NAME>_BOT_TOKEN` for a second bot.     |
| `chatIdEnv` | telegram              | `SHAPEWALL_TELEGRAM_CHAT_ID`                | The variable holding the chat: a numeric id (`-1001234567890`) or `@channel`. |
| `chatId`    | telegram              | none                                        | The chat written in the config instead (not with `chatIdEnv`); see below.     |
| `apiKeyEnv` | email                 | `RESEND_API_KEY`                            | The Resend API key. Must be `RESEND_API_KEY` or a name starting `SHAPEWALL_`. |
| `from`      | email                 | required                                    | `Name <notify@example.com>`, on a domain you verified with Resend.            |
| `to`        | email                 | none                                        | Addresses for events other than mentions.                                     |
| `fallback`  | email                 | `"none"`                                    | `"outbox"`: with no API key, write `.eml` files instead of sending (below).   |

Set webhook, Slack, Discord and Telegram destinations in the process environment. For more than one destination of a type, insert a name before the final `_URL`, `_SECRET`, `_BOT_TOKEN` or `_CHAT_ID` of the default variable, for example `SHAPEWALL_WEBHOOK_CI_URL` with `SHAPEWALL_WEBHOOK_CI_SECRET`, `SHAPEWALL_SLACK_WEBHOOK_OPS_URL` or `SHAPEWALL_TELEGRAM_OPS_BOT_TOKEN` with `SHAPEWALL_TELEGRAM_OPS_CHAT_ID`; other names are refused. A Telegram `chatId` written in the config still works, but the config is usually committed: `shapewall notify list` and `shapewall doctor` warn about it, so move it to `chatIdEnv`. Move older inline webhook URLs and custom variables to these names before upgrading.

Default events: webhooks get all six; Slack, Discord and Telegram get created, replied, resolved and reopened (a mention pings the person inside
that message, so a separate mention message would be a duplicate); email gets `comment.mentioned` only.

### Per-person routing

`people` maps a mention handle to where that person is reached:

- **Slack and Discord**: `@robin` in a comment or reply becomes a real ping (`<@U012AB3CD>`) for mapped people; everyone else stays plain
  text. A `comment.mentioned` message starts with the ping.
- **Telegram**: `@robin` becomes a mention of the mapped Telegram user id, which notifies them when they are in the chat (or have
  messaged the bot). Everyone else stays plain text, and a comment cannot mention a Telegram username of its own.
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
| `SHAPEWALL_TELEGRAM_BOT_TOKEN` and `SHAPEWALL_TELEGRAM_CHAT_ID`                  | Telegram bot (`telegram`)        |
| `RESEND_API_KEY`, `SHAPEWALL_EMAIL_FROM` and optionally `SHAPEWALL_EMAIL_TO` (,) | email (`email`)                  |

`SHAPEWALL_BOARD_URL` sets the link base; `SHAPEWALL_RESEND_URL` points email at another Resend-compatible endpoint (a proxy, or a stub in
tests), and `SHAPEWALL_TELEGRAM_API_URL` does the same for the Telegram Bot API. The bot token is part of that URL's path, so it must
be `https://`, or `http://` only to this machine (`localhost`, `127.0.0.1`, `[::1]`); anything else is not sent to.

## Delivery

- **Never in the way.** A change is saved and answered first; its messages are queued and sent in the background, in order per channel.
  A slow or broken endpoint never slows the board or the CLI.
- **Retries.** Network errors, timeouts (10 seconds), `408`, `429` and `5xx` are retried with exponential backoff (1 s, 2 s, 4 s, with
  jitter), honouring `Retry-After` (or Telegram's `retry_after`) up to a minute. Other answers (`400`, `401`, `404`) are final. A channel queues at most 200 messages;
  past that the oldest is dropped, with a log line.
- **Logs** say which channel, which event and the HTTP status or error code. They never include a URL, a header, a body or a secret. A Telegram bot token is part of
  the request URL, so it is never logged; Telegram's own error text (`chat not found`) is, with any token cut out.
- **Pings.** Comment text is escaped for each format: a comment cannot write `<!channel>`, `@everyone` or a link of its own. Discord
  messages set `allowed_mentions` to the mapped people only. Telegram messages are sent as HTML with the comment text escaped, and
  stay under Telegram's 4096-character limit (the quote is clipped at 500 characters).

## Telegram

Telegram messages come from a bot you create, through the Bot API's `sendMessage`. Each one has the event in bold, the comment quoted,
and an "Open on the board" link to the comment. Telegram refuses links to addresses it cannot reach, so when the board URL is
`localhost`, a loopback, private or `.local` address, or a bare host name, the link is sent as plain text instead (set `boardUrl` to
the address people open the board at to get a tappable link).

1. **Create the bot.** In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and pick a name and a username. It
   replies with a token like `123456789:AA...`. Treat it like a password.
2. **Add the bot to the chat.** Add it to the group (or as an admin of the channel) that should get the messages. In a group, the bot
   needs to be allowed to post; it does not need to read messages.
3. **Find the chat id.** Send any message in the group, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and
   look for `"chat":{"id":...}`. Group and channel ids are negative (`-1001234567890`). A public channel can use `"@channelname"`
   instead. For a direct chat with the bot, message it first and use your own user id from the same response.
4. **Set the token in the environment** of the process that sends (usually `shapewall serve`):

   ```sh
   export SHAPEWALL_TELEGRAM_BOT_TOKEN=123456789:AA...
   ```

5. **Add the channel** to `shapewall.config.json`:

   ```json
   {
     "notifications": {
       "people": { "robin": { "telegram": "123456789" } },
       "channels": [{ "id": "phones", "type": "telegram" }]
     }
   }
   ```

   and set the chat beside the token: `export SHAPEWALL_TELEGRAM_CHAT_ID=-1001234567890` (a second chat: `chatIdEnv`
   `SHAPEWALL_TELEGRAM_<NAME>_CHAT_ID`). Or skip the config: the token and `SHAPEWALL_TELEGRAM_CHAT_ID` set up a `telegram` channel
   by themselves.

6. **Test it:** `shapewall notify test phones` (or `notify test telegram` for the environment-only channel). A failure prints
   Telegram's reason, for example `HTTP 400 (Bad Request: chat not found)`; if a group became a supergroup it also prints the new
   chat id.

`people.<handle>.telegram` is the person's numeric Telegram user id (the `from.id` in the same `getUpdates` response). Usernames are
not used: an id mention reaches the person even if they change their username.

## The signed webhook

A `POST` with a JSON body:

```json
{
  "version": 1,
  "id": "6f0c5d2e-...",
  "type": "comment.created",
  "at": "2026-11-04T18:21:07.512Z",
  "board": { "id": "site", "title": "My app", "baseUrl": "http://localhost:3000" },
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

`version` is the payload shape's version (1); a change that breaks it gets a new number, and the signature scheme below is separate
from it. `comment.replied` adds `reply`, `comment.mentioned` adds `handle` (and `reply` when the mention was in one),
`agent_status_changed`, `resolved` and `reopened` add `previous`. Headers:

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
Past 5 MB it is renamed to `events.1.jsonl` (one older file is kept) and a new one starts. Each line is a record like this one;
`shapewall events --json` prints the same with `trust: "untrusted"` and a `note` first, as `comments --json` does, since the comment
text and names in it come from whoever commented:

```json
{
  "version": 1,
  "id": "5b0c...",
  "type": "comment.resolved",
  "at": "2026-11-05T19:09:41.015Z",
  "board": { "id": "site", "title": "My app", "baseUrl": "http://localhost:3000" },
  "commentId": 2,
  "actor": "relay-bot",
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
`comment.agent_status_changed` adds `agentStatus` beside `previous`. `captureVersion` is an opaque string: compare it, never parse it. The comment is a summary (no thread, no file paths); `shapewall comments
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
