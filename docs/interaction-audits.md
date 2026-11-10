# Explicit interaction flows and accessibility

```sh
shapewall checks flow --flow-file checks/checkout.json --json
shapewall checks accessibility --only checkout --viewport phone --json
```

The packaged [example definition](../examples/audits/interaction.audit.json) uses fictional checkout selectors; adapt its page and selectors to a configured safe fixture. Flow definitions are separate local JSON files. They do not execute visual board journeys, and ordinary capture, hosted uploads and opening Checks never run them. One explicit invocation selects one configured page and viewport, runs each step once and saves a timespan report. It does not replay `page.actions`, navigate twice for a warmup, repeat samples or retry the whole flow. A flow can mutate the original application; use deliberate test fixtures and accounts.

```json
{
  "schemaVersion": 1,
  "pageId": "checkout",
  "viewport": "desktop",
  "accessibility": true,
  "steps": [
    {
      "action": { "click": "button.cart" },
      "ready": "section.cart",
      "maxDurationMs": 1500
    },
    {
      "action": { "fill": ["input.quantity", "2"] },
      "ready": "button.update"
    }
  ]
}
```

Supported actions are `click`, `fill`, `press`, `hover`, `waitFor`, `wait` and `scrollTo`. Files are limited to 32 KiB and 20 steps; selectors to 500 characters, fill values to 2,000 characters, key combinations to 80 characters and explicit waits to five seconds. Optional `maxDurationMs` is a one-to-20,000 millisecond budget for that successful step. Values and selectors are never written into reports. Store sensitive flow files privately, just like authentication fixtures.

Timings include browser automation and the configured visible ready selector. They measure elapsed lab steps, not field INP, user-perceived responsiveness or a Lighthouse performance score. Reports retain `step1DurationMs` through the configured step count, `flowDurationMs`, `completedSteps` and `configuredSteps`. A failed step keeps its timing and the total unknown; completed steps retain their observations. Budget findings are local evidence requiring interpretation. Changing the normalized flow changes its profile hash, preventing silent comparison of different sequences.

The engine runs in a private Chromium execution world, so application globals cannot replace the audit engine or fake its results. The optional final accessibility snapshot runs [axe-core](https://github.com/dequelabs/axe-core) 4.14.0, pinned locally. It checks WCAG 2.0 A/AA, 2.1 A/AA and 2.2 AA tags on the final document, with frames and external asset preloading disabled. This is a separate `axe` snapshot report, not an interaction score. Standalone `checks accessibility` selects exactly one page and one viewport, uses its configured ready state and runs its configured page actions once before the snapshot. The default viewport is desktop when configured, otherwise the first configured viewport.

The engine preflight stops above 10,000 document elements, including reachable open shadow trees. Closed shadow roots and frames remain untested. A run records bounded rule identifiers, numeric counts and fixed guidance; raw DOM, selectors, text, resource addresses, traces, credentials and engine HTML are never saved. Up to 60 violation rules become findings; incomplete rules and truncation explicitly remain partial. A clean automated report is not accessibility certification. Verify keyboard operation, focus order and assistive technology separately. Engine behavior follows the [axe API](https://github.com/dequelabs/axe-core/blob/v4.14.0/doc/API.md).

Both commands use the selected board/environment and the existing storage-state or trusted login-script mechanism once. Configured authentication requires a visible `waitFor` marker for the intended signed-in state. Initial redirects to another route fail before steps; flows may move within the original origin. Main-document redirects are intercepted before each outgoing hop. Off-origin document navigations and all popups fail the audit before later actions can run. This restricts automated top-level navigation, not the application’s ordinary resource requests. A source build can be supplied with `--source-build`. Authentication content is hashed for comparison and never stored in reports.

Each step and accessibility inspection has a 20-second maximum; navigation uses the lower of that maximum and the configured page timeout. The entire invocation has a deadline of at most two minutes, including browser authentication operations. Trusted login scripts remain local code; browser deadlines cannot preempt arbitrary host-language work in those scripts. Prefer a saved storage state for tightly bounded CI runs. Interrupting the command closes its contexts and preserves a failed report where possible. The library also accepts an abort signal. Failed or cancelled flows do not replay earlier mutations. These manual commands create no schedules and do not dispatch agent work.
