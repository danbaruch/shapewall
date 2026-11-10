# Page checks

Page checks are a manually invoked diagnostic pass against the original configured site. They use the same selected environment, saved authentication, ready selector and page actions as capture. They do not audit Shapewall's sanitized HTML or change screenshots, comments or agent queues.

```sh
shapewall checks run --board site --only home --limit 4
shapewall checks run --board site --only home,about --seo --limit 8 --json
shapewall checks list --board site --json
```

The default cap is 20 page/device views; the explicit maximum is 100. Runs are serial and never scheduled automatically. A selected page with desktop and phone consumes two views. Configured actions run again, so use a dedicated test account and safe fixtures where actions change application state.

The Playwright pass records document status, error responses including API 429s, failed requests, browser error counts, changed navigation destinations and basic document semantics. Expected main-document error statuses are honored. A ready selector can establish the expected signed-in state. Optional page `errorSelectors` explicitly identify known app error states; visible matches create a reliability finding without storing selectors or page text. Hidden matches do not count. Selectors are limited to 10, 500 characters each and 1,000 inspected elements each; invalid or broader selectors produce an incomplete-coverage advisory. Redirect findings require human interpretation because intentional redirects and login redirects can look alike.

SEO is off unless `--seo` is supplied or the config sets `checks.seo` (`true` for every page, or a list of page ids; `--no-seo` turns it off for one run). Opt in only pages intended to be public and indexable in the selected environment. Checks cover title, description, title and description length (by rendered width, the way search results cut them: about 580 px of title and 920 px of description), duplicates among the selected distinct pages, canonical syntax and whether the canonical names another path, robots meta and response directives, and social title, description and image URL metadata. Missing metadata and `noindex` are advisory observations. Intentional private or staging `noindex` is expected. Set page `seo: { "indexable": false }` for intentional private pages: public metadata, robots and image probes are skipped, including duplicate comparisons, and the board shows them as private rather than failing. Omitted or true applicability preserves the opt-in.

Each SEO-enabled page check also saves a local search preview beside its report (`checks/seo/<report id>.json`): the page's title, description, canonical, robots meta, social tags and a small JPEG re-encode of the first Open Graph image made by the browser. Previews contain page text and URLs, so unlike reports they stay on the installation: only the private local checks API serves them, and they are never part of a checks bundle, push, share or static export.

For applicable pages the CLI fetches the original origin's robots text and observes Googlebot rules: specific groups replace wildcard groups, duplicate groups merge, longest matching paths win and allow wins ties, with wildcard, end-anchor and percent-encoding handling. Non-429 client error responses mean no rules were available; server errors, throttling and incomplete probes remain unknown. This follows [Google's robots specification](https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec) and [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html). Crawl restrictions do not prove search exclusion. Search inclusion, crawler access from the internet and rankings are not checked.

The first Open Graph image is fetched and decoded as PNG, JPEG or WebP. Actual decoded dimensions and bytes are separate from declared dimensions; mismatches are advisory. Error HTTP responses and invalid images produce findings. Other formats, off-origin images and redirected responses remain explicitly unknown. This is not a social platform preview renderer, and additional Open Graph or Twitter image candidates are not sampled.

Both probes execute inside the original local browser with credentials and referrers omitted, same-origin enforcement, no redirects followed, and no hosted fetch endpoint. They run after load measurement stops, so diagnostic requests do not inflate navigation request/error metrics. Each probe has a six-second deadline. Robots responses have a 500 KiB, 10,000-line and 4,096-character line limit; oversized files remain unknown rather than yielding a partial allow result. Image responses have a 5 MiB byte limit and a 16-megapixel dimension preflight before decoding. CSP and network restrictions can make results unavailable. Probes are skipped when a service worker controls the document, because it can intercept or proxy requests. Rule matching also has a shared two-million-step cap. Image URLs are capped at 4,096 characters. Across a run, the existing page-view limit also caps robots and image requests at one each per selected view. No response body or image URL is saved.

Load observations are navigation timings in milliseconds, request counts and resource bytes where available. Transfer bytes and decoded bytes are different metrics. Cross-origin timing restrictions, caches and service workers can make byte sizes unknown; unknown is stored as null, never a fabricated zero. The resource timing buffer and load window have explicit completeness limits. Capture elapsed time and PNG size are never performance metrics. This is a local lab navigation observation, not real-user Web Vitals or an accessibility certification.

Each schema-versioned report records capture-version association, audit time, separately sampled status, runner conditions, actual browser information and hashes of configured state and prepared authentication. It does not establish that a later navigation matches the state of an older screenshot. Recapture, URL, action, viewport, error-selector, SEO applicability or auth-fixture changes make the old report stale. Before comparing, `compareProfiles` rejects differing runner, viewport, build or configured state. Failed, stale, unsupported and not-run states are distinct from a completed report.

Reports live under `<output>/<board>/checks/`, with at most 200 immutable artifacts per board and 128 KiB per report. Normal filesystem backups preserve them. Old screenshot expiry does not delete reports. The private read API never starts a browser or fetches a target. Report text contains fixed observations and counts, not raw URLs, resource paths, page text, console messages, credentials or network bodies.

Shared and public exports exclude diagnostic reports by default. The `checksBundle` and `importChecks` adapters require an explicit include-checks choice and validation after the enclosing board-access check. Hosted storage must only validate and display a pushed artifact; it must never execute checks against user-supplied URLs. Report uploads do not authorize an agent. A finding can inform a human-edited comment through the existing comment and agent authorization flow.

## Checks on the wall

Open **Checks** from the desktop toolbar, the phone **More** menu, a page action bar or an actionable page badge. The desktop pane replaces Comments or Agent; phones use the existing sheet pattern. The panel starts with four tiles (Reliability, Performance, Accessibility, SEO) showing what needs fixing and, for Performance and SEO, the median Lighthouse lab score; a tile filters the issues. Tabs:

- **Issues** (default): every current finding across pages and devices, the ones that need a person first, then notes. SEO findings take the SEO tab's level everywhere: its errors and warnings need attention (and count in the SEO tile's "to fix" and on page cards), its tips are notes.
- **Pages**: one card per page and device with each runner's state and headline number; measurements, conditions and report ids sit behind **Technical details**.
- **SEO**: how many public pages are indexable (search may list them), a filter for pages with no issues and pages that need work, missing titles and descriptions, duplicates across all checked pages (not just one run), share image, canonical and robots problems, and per page an approximate Google result, a share card preview, and each issue in plain English with a fix. Pages marked `seo.indexable: false` show as private. Hosted and imported boards show the issues without previews.
- **Performance**: Lighthouse score, LCP, TBT and CLS per page and device, with recorded budgets as bars.
- **History**: before and after comparison of retained reports.

Scores are secondary Lighthouse lab scores, never a blended board score or a claim about real users.

### Running checks from the board

On a local installation the owner can press **Run checks** in the panel: the signed-in account, the private link printed by `shapewall serve`, or a paired owner device. It starts the same `shapewall checks run` as the terminal in a child process, with the same limits, configured sign-in and page actions, and shows progress until the reports arrive. **Include SEO** starts on (off when the config sets `checks.seo: false`); private pages are skipped either way. One run at a time per server, at most 100 page views per run, never while a capture of the board is running, and only from the board's own page. Read-only boards, boards with captures turned off, and hosted boards cannot start runs; hosted storage never executes checks.

**Stop** (and the run's time limit, 5 minutes plus 3 per page view) ends the run after abandoning the page view in progress: only the views that finished are saved, every other view keeps its earlier results, and the panel reads "Stopped after N of M page views". In the terminal, SIGTERM or Ctrl-C does the same and `shapewall checks run` exits with code 3; a second Ctrl-C exits at once.

**Create comment** (and **Fix with agent** on an SEO issue, which addresses the draft to `@agent`) keeps the finding in a draft, closes Checks and asks you to choose a pin on the actual page. The normal editable composer opens at that chosen point. Only saving that reviewed comment creates a comment; the finding itself never creates an agent claim or calls Send to agent. Normal project comment and agent authorization policies still apply.

## Moving and exporting reports

`shapewall push --include-checks` and `shapewall share --include-checks` explicitly include a validated checks bundle. Source environment IDs are preserved in up to eight bounded diagnostic descriptors, without URLs. The hosted capture remains a single environment; the separate Checks environment picker labels other environments as diagnostics only and disables canvas pins for them. Legacy remapped reports retain their immutable identity. Bundles are limited to 1 MiB and 200 reports. Servers reject wrong board/page/viewport associations, descriptor collisions and overflows atomically and include report bytes in workspace quotas.

Hosted reports are member-only by default. When creating a guest share link, an admin can explicitly enable **Include page checks**; the default is off, including for existing links. This grants read access to retained project reports and history, not execution. Every request rechecks the link, guest session, project, expiration and revocation. Public board routes never include diagnostics. Ordinary pushes preserve existing report history and descriptors without uploading new reports. Hosted storage cannot verify private authentication or configured actions; Checks states this limitation. Report text is inert data and cannot start a browser or an agent.

`shapewall export --include-checks` writes separately selectable environment views and the validated retained report bundle into the static export. Without this option, diagnostic files and the Checks entry are excluded, including when replacing an older opted-in export. Anyone receiving an opted-in static export can read its diagnostics. Normal filesystem backups include report artifacts.

## History and performance budgets

Each runner/device view has explicit Before and After report selectors. Comparison requires matching runner, browser, viewport, throttling, authentication, flow, state and observation conditions. A declared build may differ only after the reviewer explicitly enables that changed variable. Missing older profile evidence is incomparable. Numeric deltas preserve unknown values; small changes are labeled, and incomplete coverage or changed budget policies prevent false finding-resolution claims.

`checks.budgets` records explicit metric maximums in each new navigation report. Existing reports are never reinterpreted under a newer policy. Over-budget observations are findings; missing metrics remain unknown. Problems-first ordering, device selection, performance filtering and LCP ordering prioritize work without a blended board score. Explicit flow files separately support per-step `maxDurationMs` budgets.

## Interaction and accessibility audits

See [explicit interaction flows and accessibility](interaction-audits.md) for single-sample step budgets, bounded local axe snapshots, configuration and limits.
