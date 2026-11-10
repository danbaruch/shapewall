# Buzz bridge

Buzz is a self-hosted team chat built on a Nostr relay, where coding agents such as Claude Code, Codex and goose sit in channels as
members. If you already run Buzz, this optional bridge lets the owner of a local Shapewall board send feedback to those same running
agents from the board. If you do not run Buzz, skip this page: [chat with an agent](agents.md) and
[the agent workflow](agent-workflow.md) need nothing else.

The bridge is off unless you configure it. It is Linux-only, for local boards, and addresses three fixed targets: `codex`, `claude`
and `goose`.

## What it does and does not do

- It posts a signed message to one fixed Buzz channel, mentioning one target agent. The agents keep their own workspace, tools,
  models and permissions; the bridge starts no new agent and changes no provider setting.
- It is a shared conversation, separate from Shapewall's own [chat panel](agents.md). A message can steer work that is already in
  progress in that channel.
- Channel replies are flat, so the bridge cannot tie a reply to a comment, tell when a task is finished, stream tool calls, approve
  commands or stop the agent. After the agent changes the source, recapture and review the board yourself.
- A **Sent** receipt means the relay has the exact signed request. Whether the agent accepted and ran it shows in the channel.
- The source folder you select is sent as context only. The board's project sandbox does not apply to Buzz agents.

## Before you start

Check these on the Buzz host. The bridge never changes any of them for you.

1. The relay URL, channel id, owner public key and the three agent public keys in your bridge configuration match your Buzz
   installation. The owner, the transport signer and the target agent are all members of the channel. If a target has
   `channel_add_policy=owner_only`, that agent's own owner has to add it; a channel owner's signature is not enough.
2. Each transport signer's latest kind-0 profile carries a valid owner-signed NIP-OA `auth` attestation. The receiving agent service
   checks the profile, so an `auth` tag on the message alone does not pass.
3. If a profile needs repair, publish it with your normal Buzz tooling, keeping its content and unrelated tags. Buzz caches a
   rejected signer for the life of the receiving process, so restart that agent service after the repair (it interrupts its sessions).

Then send one small request and watch the channel for the agent's answer.

## Configuration

The bridge configuration is a JSON file. The values below are placeholders; use the public keys and channel from your own
installation.

```json
{
  "version": 1,
  "relayUrl": "wss://relay.example",
  "ownerPubkey": "<owner public key: 64 lowercase hex characters>",
  "channel": { "id": "<channel UUID>", "name": "your-channel" },
  "agents": [
    { "id": "codex", "name": "Codex", "pubkey": "<public key>" },
    { "id": "claude", "name": "Claude Code", "pubkey": "<public key>" },
    { "id": "goose", "name": "goose", "pubkey": "<public key>" }
  ],
  "signerFiles": {
    "codex": "/absolute/path/to/codex.env",
    "claude": "/absolute/path/to/claude.env"
  },
  "projects": [{ "root": "/absolute/path/to/source-folder", "name": "Your project", "boards": ["your-board-id"] }],
  "socketPath": "/absolute/private-folder/buzz.sock",
  "stateDir": "/absolute/private-folder/receipts"
}
```

Keep this file, the socket and the receipt journal outside every source project, capture output, export and web root. The file must
be owned by you with mode `0600`, and its folder and the socket and journal folders `0700`. Symlinked paths are refused.

### Signer files

A request to one agent is signed by a sibling agent's existing Buzz identity:

| Target      | Signed by   | Signer file          |
| ----------- | ----------- | -------------------- |
| Codex       | Claude Code | `signerFiles.claude` |
| Claude Code | Codex       | `signerFiles.codex`  |
| goose       | Codex       | `signerFiles.codex`  |

`signerFiles` names the two EnvironmentFiles your Buzz agent services already use (absolute paths). Each holds `BUZZ_PRIVATE_KEY`,
`BUZZ_AUTH_TAG` and `BUZZ_RELAY_URL`. You can set `SHAPEWALL_BUZZ_SIGNER_CODEX` and `SHAPEWALL_BUZZ_SIGNER_CLAUDE` instead; the file
wins when both are set. There is no default: without both paths the bridge stays off and says which one is missing.

Do not copy keys into the bridge configuration or the Shapewall config. An isolated signer process reads those three variables from
the file without running a shell, and before every publish it checks the signer's identity, its owner attestation, the relay and
channel membership. No private key reaches Shapewall, the browser, a receipt or a command line. Shapewall and the gateway also drop
any inherited Buzz credential variables at startup.

The gateway runs the Buzz CLI at `~/.local/bin/buzz`.

## Run it

Keep the gateway in its own terminal:

```sh
shapewall buzz-bridge --bridge-config /absolute/private-folder/bridge.json
```

Then start the board with the same file:

```sh
shapewall serve --config /absolute/path/to/source-folder/shapewall.config.json \
  --buzz-bridge /absolute/private-folder/bridge.json --open
```

Neither process installs a background service. Ctrl-C stops the one you started and leaves your Buzz services alone. Only one
gateway can own a receipt journal and socket.

## Using the panel

Open **Existing Buzz conversation** in the board's profile menu. The panel shows the channel, the target, the signer and the source
context before you send. Choose the target and press **Send to Buzz**; only that agent is mentioned. Expand **Exact transmitted
envelope** to read the payload: it says the text came from the Shapewall owner, and it never claims the signer wrote it.

Who can use it: the verified Tailscale owner, or a local browser holding the server's private owner token. A paired device or an
account session alone cannot, and account-enabled boards still need the passkey session first. Read-only, shared and hosted boards
have no bridge, and static exports contain none of its data.

**Refresh shared conversation** fetches a bounded recent view of the channel. Every event shown has passed its Nostr hash and
signature check, belongs to the configured channel and was written by the owner or one of the three agents. It is displayed as plain
text and never triggers a message, a notification or a comment change. It is not the full channel history.

Each request has a durable receipt. Sending the same request again returns its receipt without publishing twice. An interrupted
publish shows **Delivery unknown** and is never resent by itself; refresh settles it only by finding the exact outgoing message.
Receipts survive gateway restarts and stay on the host. The journal holds 500 requests: archive it by hand, with the gateway stopped,
before sending more.

## Sent, but the agent is silent

Use the request's event id and channel to trace it on the Buzz host.

- **`inbound_author_gate` rejection**: the agent service discarded the request before queuing it. Check the signer's profile
  attestation (step 2 above) and restart the receiving service if it cached the rejection. Resending does not help.
- **Missing member, or a denied channel add**: a setup problem. Have the target agent's owner add it; do not make the channel public
  or relax its policy.
- **Admitted, no reply yet**: the agent may be busy. Look at its queue and session before assuming a failure.
- **Delivery unknown**: check the relay and the channel before you create a new request.

A discarded request is not picked up later. Once the cause is fixed, and after checking that the original did not run, send a new
request.

## Limits

The automated tests use fixtures: signatures, attestation, mention isolation, private paths, owner checks, exports, receipts and
deduplication. Your relay, channel membership and agent logins are yours to check with one real request.
