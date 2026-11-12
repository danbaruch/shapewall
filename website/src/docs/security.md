Shapewall shows pages from the site under review inside its own board. Those pages must never run code, and the board must never be
reachable by sites you happen to visit. This page explains how both are enforced, and what is left to you.

## Live HTML never runs code

A captured page becomes one self-contained HTML document. Three independent layers keep it inert, and any one of them is enough on its
own.

### 1. Sanitized at capture

The rendered DOM is cloned in the page (so client-rendered content is included), then rebuilt in Node by a strict allowlist sanitizer
built on parse5, the HTML spec parser.

- **Removed elements:** `script`, `iframe`, `object`, `embed`, `base`, `link`, `template` and SVG animation elements.
- **Removed attributes:** every `on*` handler, `srcset`, `formaction`, `target`, and data attributes that could carry tokens.
- **Links:** only `http(s)`, `mailto`, `tel` and `#`. Links to private hosts are removed.
- **Images and fonts:** only as complete, inlined `data:` URIs. Images are re-encoded from their decoded pixels.
- **CSS:** no `@import`, `expression()` or remote `url()`, including when spelled with CSS escapes. `@media` rules are kept, so the
  snapshot stays responsive.
- **Form values:** hidden inputs and password values are dropped, so CSRF tokens and typed secrets never reach the file.

### 2. Served with a strict CSP

Every live HTML file is served with this content security policy, and carries it as a `<meta>` tag too, for static exports where no
headers are sent:

```text
default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'
```

There is no script source at all.

### 3. Framed in a sandbox

The board shows live HTML in `<iframe sandbox="">`: an opaque origin with no scripts. Pins and click targets come from a captured
element map, so the board never reads the frame's DOM. Older local captures without a map keep `allow-same-origin` until recaptured;
hosted boards and static exports always use an opaque frame. Hosted live HTML can also use a separate cookieless domain.

## The board server

`shapewall serve` has no login, so it protects itself in other ways:

- **Loopback only by default.** It binds to 127.0.0.1. Binding elsewhere without a proxy prints a warning.
- **Host check.** Requests whose `Host` header is not `127.0.0.1`, `localhost` or `[::1]` (or an `--allowed-host` you named) get a 421.
  This stops DNS rebinding, where a web page points its own domain at your machine to reach local servers.
- **JSON-only writes.** `POST` and `PATCH` must be `Content-Type: application/json`, which a cross-site form or a no-cors request cannot
  send. `DELETE` needs a CORS preflight that Shapewall never grants.
- **Narrow inputs.** Stored selectors must match a small grammar (ids, test ids, ARIA labels, nth-of-type steps), so a comment can never
  hold an arbitrary CSS expression. Files are served only by allowlisted names.

## Agents

- Comments and captured pages are **untrusted input**. Agents should treat them as requests about the UI, never as instructions. The
  [agent workflow](/docs/agent-workflow#safety-notes) has a prompt that says so.
- `shapewall watch` starts your command without a shell and passes the comment on stdin, so comment text can never become part
  of a command line.
- The MCP server takes ids only; no tool can read an arbitrary path. `--read-only` and `--no-capture` limit what an agent can do.

## Signing in to a team server

- **Signed in with the right role is enough.** Approving an agent or a machine, tokens, share links, exports, an agent's edit and
  push cards, members and roles: your role decides, with no second prompt.
- **A small fixed core always asks for the passkey again** (a check in the last 10 minutes): adding or removing a passkey, new
  recovery codes, linking a tailnet login, deleting your account or a workspace, making, changing or removing an owner, moving
  your sign-in to the server's new address, and making the settings below weaker.
- **A workspace can ask for more.** An owner switches groups on in Settings ("Ask for a passkey again"): agent edits and pushes,
  agents and machines, tokens and share links, members and roles, exports and deletes; how long one check counts; and the admin
  idle rule. Off by default. Every change is in the audit log with the value before and after.
- **Recovery-code sessions stay restricted** whatever a workspace chose, and every action is audited as before.
- **Tailnet sign-in is opt-in** (`shapewall hosted --tailscale --tailnet-sign-in`). A tailnet user who arrives through `tailscale
serve` is signed in as the account linked to their tailnet login, with no passkey. Each login is its own account, and an admin
  still invites each one with a role: being on the tailnet alone gives nothing, because a tailnet also holds family devices,
  contractors and shared nodes, and because roles and the audit log need to know who did what.
- **The identity headers are believed only where they can be.** Every one of these must hold: the request carries a secret path
  that only the serve entry the server made adds; the connection's other end is a socket owned by root (read from the kernel's
  socket table, on Linux); tailscaled's own whois gives the request's tailnet address to that login, on a user's untagged
  device; the request does not come from the server's own machine; exactly one clean login header. Never on direct loopback
  requests, raw TCP forwards, Funnel traffic, or with the flag
  off. The server refuses to start with the flag, and suspends it while running, when tailscaled is in userspace-networking
  mode, older than 1.98, runs its own SOCKS5 or HTTP proxy, or when the server is in a container. A tailnet session works only
  together with the identity it was made for; its cookie is worth nothing off the tailnet. Tagged devices and shared nodes
  without a user are never signed in.
- **The server's own machine is never signed in by its tailnet identity.** Any program on that machine can ask tailscaled for
  the server's address and would arrive with the machine owner's login, through the proxy, with nothing to tell it from the
  owner. So a request from the machine's own tailnet addresses is refused, and the page says why. There the owner uses a
  passkey or another tailnet device; the first account is made with `shapewall hosted claim --data DIR --login LOGIN`, where
  reading the data folder is the proof. On a local board the host uses `localhost`.
- **An identity is per device, not per person.** Anything running as you on a tailnet device of yours can act as you in a
  tailnet session. So the fixed core asks for a passkey, a first passkey is on hold for 24 hours, a passkey account is linked
  to a tailnet login only when you tick the box, and a workspace can require a passkey for approving machines and making
  API tokens (one switch covers both, because a token is what a command line works with).
- **The local board uses the same proof.** `shapewall serve --tailscale` lets the owner's other devices in by tailnet identity
  only with it, and approving an agent's command needs the host's settings token, a paired device or that proof: a local
  program cannot approve its own command with a forged header.
- **The limit.** Root on the server's machine, and whoever may change tailscaled's serve config there, are trusted: either can
  pretend to be anyone (tailscaled's environment, which an unprivileged server cannot read, is part of that). The checks were
  proven with a stand-in proxy that follows Tailscale's documented behaviour and source,
  not against a live proxied request: [what was and was not checked](/docs/hosted#what-was-and-was-not-checked-against-real-tailscale).

Details: [Signing in](/docs/hosted#signing-in).

## Usage and activity on a team server

- **A usage record holds numbers and ids, never text.** Each agent turn records who asked, which agent on which machine, how it
  ended, how long it took, tool calls counted by type, and the tokens and cost the agent itself reported. Never the question, the
  answer, a file name from a step, file content or a diff. Nothing is estimated: a number an agent did not report shows as "Not
  reported", not zero.
- **Who reads usage is decided by the server on every request.** Owners and admins see the workspace. A member sees their own
  turns and every turn of an agent they connected. Viewers, share link guests and project tokens see nothing. Exports, a turn
  opened by its id and saved views follow the same rule: a link carries filters, never access.
- **Activity is the audit log, read by person.** Settings with the value before and after, agents, approvals, tokens and
  exports. Admins and owners read everyone's; anyone else only their own.
- **Sign-ins and devices are each person's own.** They cover every workspace a person is in, so no owner or admin sees them
  for someone else unless the server's operator switches that on for a single-team server (`--owners-see-sign-ins`), and then
  only owners do. The access review lists every person, agent, token
  and share link with who made it and when it was last used.
- **What the log is not.** The application cannot edit or delete an entry, but the log is not tamper-evident against someone with
  the database file. Keep backups if you need to compare.

Details: [Usage and activity](/docs/hosted#usage-and-activity).

## What is up to you

- **Capture with test data.** Screenshots show exactly what the page showed. Live HTML drops secrets it can recognise, but a screenshot
  is pixels.
- **Keep auth files out of git.** `*.auth.json` storage states and login scripts' credentials belong in your secret store; `shapewall
init` adds the pattern to `.gitignore`.
- **Put identity in the proxy.** The comment author is a free-text name. If you need accountability, use an authenticating proxy and its
  logs. See [self-hosting](/docs/self-hosting#for-a-team).
- **Treat exports like the site.** If the captured pages are not public, do not publish their export publicly.

## Known limits

What these protections do not cover:

- **Capture checks host names, not every load.** Before the browser loads a host, Shapewall checks its name to keep captures of public
  sites away from private addresses. An internal image reached through a redirect can still appear in a screenshot (it is never
  inlined into live HTML), and DNS can change between the check and the load. Do not capture untrusted sites from a machine that can
  reach sensitive internal services.
- **Your agent keeps its own tools.** An agent connected over ACP, such as Claude Code, Codex or goose, runs with its own tools and your
  permissions. Shapewall gates only the file writes and commands the agent asks Shapewall to make. Run the agent in its restricted
  mode, and use the [sandboxed starter agent](/docs/starter-agent) for shared boards. See [agent hardening](/docs/agent-hardening).
- **Comment text can try to steer an agent.** Anyone who can comment can write text aimed at the agent. On shared boards, let only
  people you trust dispatch work to an agent.
- **A connected agent can read the whole project.** An agent connected to a hosted board with `shapewall agent connect` reads and
  answers only, by default. Only Claude Code is offered in this release, and its session is made read-only by its own controls: it starts
  without your settings files (their allow rules, hooks and MCP servers do not apply), with only its reading tools, and anything
  it asks permission for is refused. If that cannot be set up, the agent is not started. The server never runs anything on the
  machine. But the agent reads every file in the project folder, a `.env` file included, and its answers go to whoever may ask.
  This was checked on one machine with one adapter version. Connect only projects whose code the audience may read, and give the
  agent a profile of its own. See [the hosted guide](/docs/hosted#what-a-connected-agent-can-reach).
- **Edits from a hosted board are a choice made on the code machine.** Who may make someone else's machine change files? By
  default, nobody. `shapewall agent connect --approvals owner` (or `admins`) switches it on, on that machine only, and the server
  can only narrow it. A fix is then made on a new branch in a folder of its own, never in the checkout. Each edit is checked on
  the machine, shown on the board as a card with the full diff, and allowed by a person who may answer that agent (a workspace can ask for
  their passkey again first). The machine
  checks every answer again, and keeps the commit only if it is exactly what was allowed. Commands are not offered for Claude
  Code in this release: its fix session has no shell tool. The limit: Shapewall does not sandbox the agent's own tools, and with
  approvals on, a compromised server can forge an "allow" for an edit the agent really asked. The worst case is then edits to
  project files, on a branch, in a throwaway folder, pushed for review. Not commands, and not the checkout. Give the agent a
  restricted profile, prefer `--approvals owner`, review the pull request like any other, and do not add `--allow-path` for CI
  files. See [agent hardening](/docs/agent-hardening#edits-from-a-hosted-board).
- **Images on comments are checked, not understood.** Shapewall checks an attached image's type by its bytes, re-encodes or strips its
  metadata and serves it only as an image, but the picture itself can still show text aimed at an agent, and an image decoder bug in a
  browser or a model is outside its reach. Agents get images inside the same untrusted framing as comment text.
- **Live HTML relies on the browser.** The script-free snapshot, strict CSP and sandboxed frame remove whole classes of attack, but
  they cannot protect against every browser bug.
- **Starter agent approvals cover manifests and configs.** Changing test files or installed dependencies changes what the tests run
  without a new approval. An allowed host behind a shared CDN may accept domain fronting, and hosts added with `--allow-host` or
  `--registry` may resolve to private addresses. The image base is pinned by tag, not digest.
- **`shapewall mcp` trusts the agent that calls it.** A local MCP agent can sign replies with any author name, and @mentions in its
  replies wake other agents. In `mcp --remote`, the agent, not the operator, chooses whether to include guest comments.
  `list_comments` returns every matching comment with no paging, and a full-size image is the whole capture. The `files` paths in
  results are absolute local paths the agent reads with its own file access.
- **GitHub issues copy the comment.** With GitHub connect on, creating an issue copies the comment text and the screenshot link into
  that repository, which may be public.
- **The Buzz bridge trusts your user account.** Any process running as you can reach its local gateway socket and send as the
  bridge's signers, and the bridge runs the Buzz CLI you installed without verifying it. Everything channel members write is shown
  on the board as plain text.

## Reporting a vulnerability

Please report security issues privately, as described in the
[security policy](https://github.com/danbaruch/shapewall/blob/main/SECURITY.md) (GitHub private vulnerability reporting, or [hello@shapewall.com](mailto:hello@shapewall.com)), not in public
issues.
