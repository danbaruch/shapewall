# Local Lighthouse navigation audits

Shapewall's Lighthouse runner audits the original application URL. It does not
measure the screenshot viewer, capture duration or PNG size. Audits run only
when explicitly invoked locally or in CI. The hosted server never launches an
audit or fetches an arbitrary submitted URL.

The runner exports `auditCommand(config, positional, flags, out, err)` for the
CLI and `runLighthouseAudits({ config, ...options })` for trusted local tooling.
The CLI integration mounts it under `shapewall audit`. The runner itself
does not change captures or application configuration.

## Runtime and limits

Use Node 22.19 or later and an installed Chrome. The exact runtime dependencies
are Lighthouse 13.6.0, chrome-launcher 1.2.2 and puppeteer-core 25.16.0. No browser
is downloaded. `config.browser.executablePath` selects Chrome explicitly;
otherwise the installed Chrome is discovered. An unsupported browser channel
fails honestly. An optional `--browser-version` requires an exact installed
browser version for reproducible CI comparisons.

Run audits through the machine's capped browser wrapper, for example
`browser-slot node ...` in local tooling. Each navigation gets its own private
browser profile beneath the configured output directory. The runner closes the
browser and removes this profile on success or failure.

Selection flags are `--board`, `--env`, `--only page-a,page-b` and
`--viewports desktop,phone`. The defaults allow at most five pages and ten
navigations. Explicit `--max-pages` and `--max-runs` can raise those caps to 20
pages and 40 navigations. `--samples` defaults to one and cannot exceed ten.
All navigations run serially, with a two-minute hard deadline per navigation.
An oversized selection fails before starting Chrome.

Each repeat is a separate raw report with `sampleCount: 1`, a distinct report
identifier and the same run identifier. Repeats do not silently become a median
or a more confident score. `--json` prints only the bounded report result.
A partial, unsupported or failed audit returns a nonzero command status.

## Measurement profile

The report records the actual Chrome version, a hash of the emulated user
agent, the configured viewport dimensions, device scale, mobile emulation and
the pinned Lighthouse version. Tablet and phone use Lighthouse's mobile user
agent; desktop uses its desktop agent. The emulated user agent is independent
of the installed Chrome version.

Network and CPU conditions use Lighthouse simulation, not field measurements.
Desktop uses 40 ms RTT, 10240 Kbps throughput and a CPU multiplier of one.
Mobile uses 150 ms RTT, 1638.4 Kbps throughput and a CPU multiplier of four.
The exact conditions are persisted in the profile, so unlike profiles must not
be compared as equivalent runs.

Anonymous audits default to `--cache cold`: browser cache and origin storage
are cleared before navigation. `--cache warm` performs an unmeasured initial
navigation before the measured one. Configured authentication requires
`--cache auth-preserved`, which retains authentication storage, cache and
service workers. These conditions are deliberately different profiles.

Set `--production production` or `--production development` to declare the
build mode; the default is `unknown`. Set `--source-build` to an opaque build
identifier when available, such as a Git commit SHA or build hash. Identifiers
accept one to 120 letters, digits, dots, underscores or hyphens. Both checks
runners hash the identifier with the same fingerprint function before storing it. The runner does not infer a production build from
a fast response or a familiar hostname. A capture association and target state
fingerprint identify which existing wall entry was audited, while
`sampledSeparately: true` makes clear that this was a later navigation.

Raw metrics are `largestContentfulPaintMs`, `cumulativeLayoutShift` (unitless),
`firstContentfulPaintMs`, `totalBlockingTimeMs`, `speedIndexMs`,
`transferredResourceBytes` and `observedRequests`. Unknown values remain `null`.
`lighthouseLabScore` and optional `lighthouseSeoLabScore` are secondary scores
from zero to 100. Enable the latter with `--seo`; it is an automated local
check, not a search ranking claim. Navigation audits do not establish field
INP or interaction responsiveness. Configured actions run once during the
navigation window; their presence is recorded as a limitation.

## Authentication and intended state

A Playwright storage file is not passed blindly to Lighthouse. The adapter
reads the configured storage file, or executes the trusted configured
Playwright login script, then deliberately transfers cookies and localStorage
to the prepared Chrome target. It records a hash of the resulting state and
never persists the credentials in a report.

Only bounded cookie and localStorage state is supported. Partitioned cookies,
IndexedDB content and unsupported storage shapes fail as unsupported.
Session storage, browser extensions, custom Playwright selectors and other
browser-only session mechanisms are not translated. Use standard CSS selectors
for ready states and configured actions.

A configured signed-in audit must declare `waitFor` with a selector visible
only in the intended signed-in state. The original origin, path and query state
must match before and after readiness checks and actions. An authentication
redirect, missing ready selector or unexpected document status produces a
failed report with unknown metrics. A login page never counts as a successful
measurement of the intended application.

Login scripts are existing trusted local configuration, not code submitted by
a hosted user. They can have application side effects. Use a dedicated test
account and the same deliberate fixture discipline as capture automation.

## Reports and privacy

Reports use the shared bounded checks schema and retain at most 200 reports per
board. They contain raw numeric metrics, a measurement profile, completeness
limitations and a capped set of static actionable performance findings.
Only audited, applicable opportunities from an allowlist become findings.
Resource URLs, private paths, query values, headers, cookies, response bodies,
DOM snippets, raw Lighthouse logs and traces are not written to reports.
Failures also use fixed safe messages rather than raw browser errors.

A complete report requires all four primary navigation metrics: LCP, CLS, FCP
and TBT. Missing metrics produce `partial`; failures and unsupported conditions
produce no trustworthy numeric measurements. Never substitute zero for missing
data or mix these reports with capture timings.

Reference: [Lighthouse authentication guidance](https://github.com/GoogleChrome/lighthouse/blob/main/docs/authenticated-pages.md),
[Lighthouse programmatic usage](https://github.com/GoogleChrome/lighthouse/blob/main/docs/readme.md).

## Performance budgets and report history

Checks keeps up to 200 reports per board. In the Checks panel, expand **History and comparison**,
choose an after report and a baseline, then inspect raw measurements and finding changes. History
remains usable when its screenshot has expired. Reports stay separated by runner, page, environment
and device; repeat samples are individually selectable, not silently averaged.

The comparison requires the same recorded runner version, browser, authentication state, configured
page state, viewport, device emulation, cache, throttling, observation coverage and service worker
state. Older reports missing browser/device/throttling evidence explain why comparison is unavailable.
Different declared builds can be compared only by explicitly choosing **Allow declared build as the
changed variable**. Both runs must have a build fingerprint; this choice never relaxes other conditions.
Build identifiers are stored as fingerprints, not raw labels. Undeclared builds remain labelled unknown.

Missing or failed measurements show **Unknown**, never zero. Deltas use the metric's units. Movement
below either 5 percent or the display floor (50 ms, 1024 bytes, 0.01 layout shift, otherwise 1) is labelled
small; these are display rules, not statistical confidence or regression detection. An increase alone
is not proof of a regression. Finding changes require two complete comparable runs and unchanged budget
policy; absence in a later run is only “no longer observed,” not proof of a fix.

Set optional explicit maximums in the top-level configuration. No performance budgets are enabled by
default. Choose values appropriate to the app, device and lab setup; the following is an example, not
an enforced universal target:

```json
{
  "checks": {
    "budgets": {
      "largestContentfulPaintMs": 2500,
      "totalBlockingTimeMs": 200,
      "cumulativeLayoutShift": 0.1,
      "transferredResourceBytes": 1500000,
      "loadMs": 3000
    }
  }
}
```

Each newly run report records the exact configured thresholds and policy version. A known measurement
above its maximum produces a performance warning with the observation and next action; equality is
within budget. Missing metrics, including metrics belonging to another runner, remain unknown. Failed
and unsupported runs never pass budgets. Importing or viewing an old report does not recompute it
against a newer configuration.

Supported metrics are `ttfbMs`, `loadMs`, `domContentLoadedMs`, `documentTransferBytes`,
`resourceTransferBytes`, `resourceDecodedBytes`, `requestCount`, `largestContentfulPaintMs`,
`firstContentfulPaintMs`, `totalBlockingTimeMs`, `cumulativeLayoutShift`, `transferredResourceBytes`,
`observedRequests` and `speedIndexMs`. Values are finite nonnegative maxima in the named units. These
budgets apply to explicit local `checks` and `audit` runs; they do not schedule scans or measure field vitals.

**Problems first** prioritizes failed/unsupported runners, warnings, stale results and partial runs.
**Performance findings** narrows to observed performance warnings. **Slowest LCP first** orders the
latest Lighthouse value per page/device view, placing unknown and failed values last. Use the device
selector to narrow the list. It never combines device scores, and this triage ordering does not make
runs with different conditions comparable.
