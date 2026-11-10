# shapewall.com

The Shapewall marketing site and docs. React + Vite + Tailwind, prerendered to one static HTML file per route, so every page is real
HTML before any JavaScript runs. It has its own `package.json` and is not part of the published npm package.

```sh
cd website
npm ci
npm run build     # dist/: static files, ready for any static host
npm run preview   # serves dist/ with clean URLs at http://127.0.0.1:4700/
npm run dev       # Vite dev server (no prerender, no service worker)
npm test          # builds each state and checks titles, descriptions, canonicals, share images, robots and every internal link
```

## Build-time settings

| Variable             | Default | Effect                                                                                                         |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `SHAPEWALL_STEALTH`  | `1`     | `1`: every page gets `noindex,nofollow` and `robots.txt` is `Disallow: /`. `0`: indexable, sitemap advertised. |
| `SHAPEWALL_LAUNCHED` | `0`     | `0`: private early access (no install command, GitHub marked invite only). `1`: launched. See the runbook.     |
| `SHAPEWALL_UMAMI_ID` | empty   | Umami website id (a uuid). Empty: no analytics script at all.                                                  |

The two switches are independent: `SHAPEWALL_LAUNCHED` decides what the pages say, `SHAPEWALL_STEALTH` decides whether search engines
may index them. `/demo`, the fictional demo site, the 404 page and the `/legal/*` operator templates are never indexed.

With `SHAPEWALL_UMAMI_ID` set, each page carries a tiny loader that, only on the `shapewall.com` hostname, adds the cookieless Umami
tracker from the same-origin path `/umami/script.js` (with `data-domains="shapewall.com"` and `data-do-not-track="true"`). The host must
reverse-proxy `/umami/` to the Umami instance. Custom events: `get-started`, `live-demo`, `copy-install-command`, `docs-search` (no query text).

## Launch runbook

Everything launch-dependent on the site reads one module, `src/launch.js`. Before launch (`SHAPEWALL_LAUNCHED=0`, the default) the
hero badge and the install box say "Private early access", GitHub links read "GitHub (invite only)", there is no install command, no
Offer in the structured data, and no links to files in the repository. Launched, the pages show
`npm install --save-dev shapewall`, plain GitHub links, Changelog and Security policy links, "Edit on GitHub" on the docs, and a
free Offer.

To launch:

1. Make the GitHub repository public and turn on private vulnerability reporting (Settings > Code security), which `SECURITY.md`
   relies on.
2. Publish the package to npm (`NPM_PUBLISHED` in `src/launch.js` is already `true`, so do not deploy the site before the package
   is on the registry), then check the install a stranger will run, in an empty folder:
   `npm init -y && npm install --save-dev shapewall && npx shapewall --version`.
3. Build and check locally: `SHAPEWALL_LAUNCHED=1 SHAPEWALL_STEALTH=0 npm test` runs every state; then
   `SHAPEWALL_LAUNCHED=1 SHAPEWALL_STEALTH=0 SHAPEWALL_UMAMI_ID=<id> npm run build && npm run preview` to look at it.
4. Release: `SHAPEWALL_LAUNCHED=1 SHAPEWALL_STEALTH=0 SHAPEWALL_UMAMI_ID=<id> website/deploy/deploy.sh` from the repository root.
   To open the site without being indexed yet, leave `SHAPEWALL_STEALTH` out (it defaults to `1`) and deploy again with `0` later.
5. Check the live site: the hero shows the install command, `https://shapewall.com/robots.txt` allows crawling and names the
   sitemap, and the footer's Changelog link opens.

To go back: `website/deploy/deploy.sh rollback` swaps to the previous release.

`NPM_PUBLISHED` in `src/launch.js` decides whether the marketing pages and the Getting started page install `shapewall` from the
registry (`true`) or from GitHub (`false`). The root `README.md` and `docs/` write the registry install, with GitHub as the
alternative for unreleased builds.

## Hosting

`dist/` uses clean URLs: `/features` is `features.html`, `/docs/config` is `docs/config.html`, and `/docs` is `docs.html` (beside the
`docs/` folder). Serve `404.html` with status 404. With Caddy:

```caddyfile
shapewall.com {
  root * /srv/shapewall/current
  encode zstd gzip
  @assets path /assets/*
  header @assets Cache-Control "public, max-age=31536000, immutable"
  header /sw.js Cache-Control "no-cache"
  try_files {path}.html {path}
  file_server
  handle_errors 404 {
    rewrite * /404.html
    file_server
  }
}
```

## Live demo

`deploy/deploy.sh` also builds the live demo into `dist/demo/` (`npm run build && npm run build:demo` in the root, then
`node ../scripts/demo-export.js dist/demo --publish dist`; skip with `SHAPEWALL_DEMO=0`). It needs the root package installed and Playwright's Chromium. `deploy/shapewall.Caddyfile` serves it at
`/demo/` with the board's own CSP, lets it frame its live HTML, and sends `X-Robots-Tag: noindex`.

`--publish dist` also writes the fictional site the board shows (Lumen Notes), so its page links open a real page: production as
`/lumen` (`dist/lumen.html` + `dist/lumen/`), staging as `/lumen-staging` (`../scripts/demo-publish.js`). Pages are one `.html` file
each, like the site's own, so the Caddyfile serves them as it is; root-absolute links are rewritten to the prefix. Every page gets a
fixed "fictional demo site" banner linking back to `/demo/`, `noindex`, and forms that send nothing. The board's captures are taken
before that, from the clean copies. `robots.txt` disallows both prefixes even with stealth off, and the sitemap never lists them
(`DEMO_SITE_PATHS` in `src/routes.js`).

## Layout

- `src/routes.js`: every route with its title, description and share card. Add a page here first.
- `src/launch.js`: the launch switch and what depends on it (install command, GitHub label, license wording).
- `src/pages/`, `src/components/`: the pages.
- Docs: markdown turned into HTML at build time (`scripts/markdown.mjs`). Pages written for the site are `src/docs/*.md`. Guides that
  also ship in the repository and the npm package are read straight from `../docs/*.md` (a route with `repo` in `src/routes.js`), so
  there is one copy: their relative links become site routes or GitHub links on the way in. `<!-- launched -->` and
  `<!-- prelaunch -->` blocks in a site page are kept or dropped by the launch switch.
- `scripts/prerender.mjs`: writes the HTML per route, `robots.txt`, `sitemap.xml` and `sw.js` (from `scripts/sw.template.js`).
- `public/`: icons, `manifest.webmanifest`, share cards (`og/`) and docs images.

## Regenerating art (dev only)

These need Playwright (installed by the CLI package at the repo root) and ImageMagick; their output is committed.

- `node scripts/brand.mjs`: wordmark and logos in `../brand/`, favicons and PWA icons in `public/`.
- `node scripts/imagery.mjs`: product screenshots in `src/assets/shots/` and `public/images/`, from the demo site. The hero
  (`board-overview`) is the live demo board, built with `../scripts/demo-export.js`.
- `node scripts/og.mjs`: the 1200x630 share cards in `public/og/`.
- `node scripts/pdf.mjs`: the agent hardening guide as a PDF in `public/downloads/` (from `../docs/agent-hardening.md`), and its
  source hash in `scripts/pdf-sources.json`; `npm test` fails when the guide changed and the PDF was not printed again.
- `node scripts/shots.mjs <dir>`: every built page at 390 and 1440 px, with console errors and overflow reported.

## Contact form

`/contact` posts JSON with `fetch` to `/api/contact` on the same origin (the page CSP keeps `connect-src 'self'` and
`form-action 'none'`). `contact/server.mjs` is a single-file Node service (built-ins only: `node:http`, `node:sqlite`) that validates
each message, stores it in SQLite and sends it to Telegram as plain text. It binds `127.0.0.1` only. Tests: `contact/server.test.mjs`,
part of `npm test`.

| Variable                     | Default                    | Effect                                                                                  |
| ---------------------------- | -------------------------- | --------------------------------------------------------------------------------------- |
| `PORT`                       | `4131`                     | Port on 127.0.0.1.                                                                      |
| `DATABASE_PATH`              | `./data/contact.sqlite`    | The SQLite file (its folder is created).                                                |
| `CONTACT_ALLOWED_ORIGIN`     | `https://shapewall.com`    | The only `Origin` accepted.                                                             |
| `CONTACT_TELEGRAM_BOT_TOKEN` | empty                      | The bot token. Keep it in a root-only environment file, never in the repo.              |
| `CONTACT_OPENCLAW_CONFIG`    | empty                      | Alternative: path of a JSON file with the token at `channels.telegram.botToken`.        |
| `CONTACT_TELEGRAM_CHAT_ID`   | empty                      | The chat that receives messages. Without a token and chat id, messages are stored only. |
| `CONTACT_TELEGRAM_THREAD_ID` | empty                      | Optional forum topic id.                                                                |
| `CONTACT_TELEGRAM_API_BASE`  | `https://api.telegram.org` | Point at a local stub for testing.                                                      |

What it enforces: `POST` only, `Content-Type: application/json`, a 16 KB body limit, the exact `Origin`, a hidden honeypot field
(filled: answered with success and dropped), at least 3 seconds between the form appearing and being sent, a kind of `feedback`,
`feature`, `bug` or `other`, a message of 10 to 4,000 characters and an optional valid email. Rate limits: 5 messages per hour and 20
per day per sender, 200 per day in total, kept in memory and rebuilt from the database on start. Each row stores the time, kind,
message, email, a salted hash of the IP (the salt is random per database; the raw IP is never stored), the user agent cut to 200
characters, and whether Telegram accepted it. A Telegram failure is logged (without the token) and the sender still sees success.
Errors are fixed codes; the response never echoes input. `GET /api/contact/health` answers `{"ok":true}`.

To deploy: copy `contact/server.mjs` to a release folder on the host, install `deploy/shapewall-contact.service.example` as a systemd
unit (fill in its placeholders), and keep the `handle /api/contact*` block in `deploy/shapewall.Caddyfile` ahead of the static
handlers:

```caddyfile
handle /api/contact* {
  reverse_proxy 127.0.0.1:4131 {
    header_up X-Real-IP {client_ip}
  }
}
```

The service rate limits by `X-Real-IP`, which Caddy sets from `{client_ip}` (only Caddy can reach the port, so the header is trusted;
without it the socket address is used). Behind a CDN, list the CDN's ranges in Caddy's global `servers { trusted_proxies ... }` option
(and its client IP header in `client_ip_headers`) so that address is the visitor's and not the CDN's.
