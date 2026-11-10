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

These are known gaps, stated plainly so you can plan around them.

- **The capture guard checks names, not every load.** When you capture a public site, Shapewall keeps the capture away from private
  addresses by checking each host name before the browser loads it. An internal image reached through a redirect can still appear in a
  screenshot (it is never inlined into the saved live HTML), and DNS can change between the check and the load. Capture sites you
  trust, and do not capture untrusted sites from a machine that can reach sensitive internal services.
- **Your own agent keeps its own tools.** When you connect Claude Code, Codex or goose over ACP, the agent runs with its own tools and
  your permissions. Shapewall only gates the file writes and commands the agent asks Shapewall to make. Run the agent in its restricted
  mode, and use the [sandboxed starter agent](/docs/starter-agent) for shared boards. See [agent hardening](/docs/agent-hardening).
- **Comment text is untrusted input to an agent.** Anyone who can comment can write text that tries to steer the agent. On shared
  boards, only let people you trust dispatch work to an agent.
- **The live view is a snapshot, not a guarantee.** Live HTML is a script-free snapshot behind a strict CSP and an iframe sandbox. That
  removes whole classes of attack, but it cannot promise protection against every browser bug.

- **The sandboxed starter agent has edges.** Its approval rule for running tests covers manifests and configs, not test files or
  installed dependencies, so changing those changes what the tests run without a new approval. A host you allow that sits behind a
  shared CDN may accept domain fronting, and hosts you add with `--allow-host` or `--registry` may resolve to private addresses. The
  image base is pinned by tag, not digest.
- **`shapewall mcp` trusts the agent that calls it.** A local MCP agent can sign replies with any author name, and @mentions in its
  replies wake other agents. In `mcp --remote`, including guest comments is an argument the agent chooses, not an operator setting.
  `list_comments` returns every matching comment and a full-size image is the whole capture: there is no paging. The `files` paths in
  results are absolute local paths the agent reads with its own file access.
- **GitHub issues copy what the comment says.** With GitHub connect on, creating an issue copies the comment text and the screenshot
  link into that repository, which may be public.
- **The Buzz bridge trusts your user account.** Any process running as you can reach its local gateway socket and send as the
  bridge's signers, and it runs the Buzz CLI you installed without verifying it. Everything channel members write is shown on the
  board as plain text.

## Reporting a vulnerability

Please report security issues privately, as described in the
[security policy](https://github.com/danbaruch/shapewall/blob/main/SECURITY.md) (GitHub private vulnerability reporting), not in public
issues.
