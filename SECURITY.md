# Security policy

## Supported versions

Shapewall follows [Semantic Versioning](https://semver.org/) from 1.0.0 ([stability and versioning](docs/stability.md)).

| Version            | Security fixes                                                           |
| ------------------ | ------------------------------------------------------------------------ |
| Latest 1.x minor   | Yes                                                                      |
| Older 1.x minors   | No: upgrade to the latest 1.x minor, which needs no changes on your side |
| 0.x (before 1.0.0) | No                                                                       |

A fix ships as a patch release of the latest 1.x minor. Please check that the problem is still there on the latest 1.x release
before you report it.

## Reporting a vulnerability

Please report privately, not in a public issue:

1. **GitHub private vulnerability reporting** (preferred): the **Report a vulnerability** button on the repository's
   [Security tab](https://github.com/danbaruch/shapewall/security).
2. **Email** if you cannot use GitHub: [hello@shapewall.com](mailto:hello@shapewall.com), with "Security" in the subject.

Include:

- the Shapewall version (`shapewall --version`) and how you run it (`serve`, `hosted`, the starter agent, an export);
- steps to reproduce, ideally with a minimal config or page;
- what an attacker gains, and what they need first (a comment on a shared board, a page you capture, a link you open).

Shapewall has one maintainer. Expect an acknowledgement within a few days and a first assessment soon after. We will agree on a
disclosure date with you before anything is made public.

## Scope

Of most interest:

- Anything that makes captured content execute script or load remote resources on the board (sanitizer, CSP, iframe sandbox bypasses).
- Secrets from captured pages (form values, tokens) surviving into live HTML.
- Reading files outside the output folder through the server, or writing to it without the JSON/Host protections.
- Cross-site requests or DNS rebinding against a server on 127.0.0.1.
- The self-hosted team server (`shapewall hosted`, in beta): accounts, sessions, roles, share links and project tokens.
- The starter agent sandbox, the MCP server and connected agents escaping the limits their docs describe.

Out of scope: a local board (`shapewall serve`) exposed beyond localhost without an authenticating proxy (see
[docs/deployment.md](docs/deployment.md)), screenshots showing what the captured page showed, and the
[known limits](https://shapewall.com/docs/security#known-limits) the security docs already list.
