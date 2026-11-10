# Capture network warnings and pacing

A saved screenshot can still show an application whose API was rate limited.
Ordinary captures now retain a small `networkSummary` alongside the screenshot
status. A usable screenshot stays `status: "ok"`; a failed navigation keeps the
existing failure behavior. These observations are part of that capture, not a
separate Page checks or Lighthouse run.

The summary contains only integer counts: observed responses, unexpected 4xx
and 5xx responses, API errors, HTTP 429 responses, API 429 responses and failed
requests. API means the browser classified the request as fetch or XHR. It
contains no resource URL, query value, body, headers, cookie, console message
or browser failure text. Collection stops after the screenshot and thumbnail,
before live HTML resource processing or context shutdown. It is bounded to
10000 observed response or failed-request events; `capped` means the counts
are lower bounds. Requests occurring later are not assessed.

`expectStatus` continues to apply only to the main document. For example, an
intentional 404 document succeeds and does not add a network warning by
itself. An API 429 on that same page still adds a warning. An unexpected main
document 429 still fails capture. A warning is a pointer, not a verdict: it
does not mean the whole application is broken, or that every request was seen.

The wall's **Network** badge opens a custom, keyboard-accessible popover with
per-device counts. Close, Escape, outside click or Android Back dismiss it.
CLI progress reports the safe aggregate warning, and `capture --json` includes
it in each shot. The same bounded metadata survives local API reads, ordinary
static exports and hosted pushes. Invalid summaries are dropped; unknown
fields are discarded at these boundaries.

## Polite foreground pacing

Capture navigation starts are spaced across the configured concurrent workers.
The default is 250 milliseconds between starts. When a shot observes an
unexpected 429, future shots receive a one-second cooldown; in-flight shots
continue. The setting applies to the foreground board capture run. It does
not retry navigation, repeat configured actions, schedule later work or
create a background job.

```json
{
  "concurrency": 2,
  "capturePacing": {
    "intervalMs": 250,
    "rateLimitCooldownMs": 1000
  }
}
```

`intervalMs` accepts whole milliseconds from 0 to 5000 and
`rateLimitCooldownMs` from 0 to 30000. Zero explicitly disables that part of
pacing. Unknown settings and out-of-range values fail configuration validation.
Changes reload for subsequent captures in a running local server. A cooldown
cannot extend one admission indefinitely: after reaching the front of the
queue it waits at most the configured interval plus cooldown. Server
`Retry-After` values do not trigger arbitrary waits. This pacing reduces bursts;
it cannot guarantee that the application will never return 429.
