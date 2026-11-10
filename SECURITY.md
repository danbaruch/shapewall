# Security policy

## Supported versions

Security fixes go into the latest release. Shapewall is pre-1.0; please upgrade to the newest version before reporting.

## Reporting a vulnerability

Please report privately, not in a public issue: use GitHub's **Report a vulnerability** button on the repository's Security tab (private
vulnerability reporting). Include the version, steps to reproduce, and the impact you see. We aim to acknowledge reports within a week and
to agree on a disclosure date with you.

If you cannot use that button, open an issue that asks for a security contact and says nothing else about the problem. A maintainer
will reply with a private channel.

## Scope

Of most interest:

- Anything that makes captured content execute script or load remote resources on the board (sanitizer, CSP, iframe sandbox bypasses).
- Secrets from captured pages (form values, tokens) surviving into live HTML.
- Reading files outside the output folder through the server, or writing to it without the JSON/Host protections.
- Cross-site requests or DNS rebinding against a server on 127.0.0.1.

Also in scope: the self-hosted team server (`shapewall hosted`): accounts, sessions, roles, share links and project tokens.

Out of scope: a local board (`shapewall serve`) exposed beyond localhost without an authenticating proxy (see docs/deployment.md), and
screenshots showing what the captured page showed.
