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
  the machine, shown on the board as a card with the full diff, and allowed by a person with a recent passkey check. The machine
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
