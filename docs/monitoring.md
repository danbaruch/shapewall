# Monitoring your server

For anyone who keeps `shapewall serve` or `shapewall hosted` running on a machine of their own. It covers what Shapewall gives you
for the four usual signals (health, logs, errors, metrics), what it does not, and a short checklist for when something breaks.

Shapewall has no telemetry. Nothing on this page sends anything to the Shapewall team: every option here is off until you turn it
on, and each one points at a tool you run or choose.

## Health

Both servers answer `GET /api/health` (and `HEAD`) with `200` and `{"ok":true}`.

```sh
curl -fsS --max-time 5 http://127.0.0.1:4600/api/health   # shapewall serve (default port 4600)
curl -fsS --max-time 5 http://127.0.0.1:4700/api/health   # shapewall hosted (default port 4700)
```

What it tells you, and what it does not:

- **It is a liveness check.** A `200` means the process is up and its HTTP server answers. It does not open the database, check free
  disk space, start a browser or look at captures. There is no separate readiness endpoint.
- **No sign-in needed.** The hosted server answers it before any session check, also on the Tailscale Funnel listener and on the
  old address during an [origin move](hosted.md#moving-to-a-new-origin). On `shapewall serve --accounts` it answers while signed out.
- **The Host check still applies to `shapewall serve`.** A probe with a Host the board does not accept gets `421 bad_host`. Probe it
  as `127.0.0.1` or `localhost`, or add the name the checker uses with `--allowed-host` or `SHAPEWALL_ALLOWED_HOSTS`
  ([In Docker](deployment.md#in-docker)).

### Docker and Compose

Both images already carry a `HEALTHCHECK` (every 30 seconds, 5 second timeout) that fetches `/api/health` with Node, so
`docker ps` and `docker compose ps` show `healthy` or `unhealthy` without anything added. `shapewall hosted setup --start`
waits for it (`docker compose up --wait`). The images have no `curl`, so if you write your own Compose healthcheck, use Node too:

```yaml
healthcheck:
  test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:4700/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
  interval: 30s
  timeout: 5s
  start_period: 10s
```

Podman drops the image's `HEALTHCHECK` unless you build with `--format docker` ([In Docker](deployment.md#in-docker)).

### systemd

The example unit ([shapewall-hosted.service](../examples/hosted/shapewall-hosted.service)) restarts the server when it exits
(`Restart=on-failure`). It does not notice a process that is still running but no longer answers: Shapewall does not use the
systemd watchdog. To catch that, probe `/api/health` from outside the process, for example with a oneshot unit and a timer of your
own that runs:

```sh
curl -fsS --max-time 5 http://127.0.0.1:4700/api/health
```

and an `OnFailure=` unit that alerts you or restarts the service. Nothing like this ships enabled; it is yours to write and turn on.

### An uptime checker

Any uptime checker that can send an HTTP request and expect a `200` works, for example a self-hosted Uptime Kuma, or Prometheus with
the blackbox exporter (which also records response time). Point it at the address people use (`https://app.example.com/api/health`)
to test the proxy, TLS and the server together, or at the loopback port from the same machine to test the server alone. A probe
from a second device is part of the [checklist before you invite the team](hosted.md#before-you-invite-the-team).

## Logs

Both servers write plain text lines to standard output: no JSON, no timestamps (journald and Docker add their own), and no level or
format setting. Startup lines say what came on (the address, sign-up mode, email, error reports, quotas); configuration problems
start with `Warning:`; a request that failed with a 5xx is logged as a line starting with `error:`. Shapewall writes no per-request
access log of its own.

What is kept out of the logs:

- **Hosted:** a failed request is logged by its error name only (`error: TypeError (request failed; request values omitted)`).
  The first account's setup link is never logged, only the file that holds it. Secrets loaded from files are named, never printed.
- **Local `serve`:** a failed request is logged with its stack trace, since the board and its owner are on the same machine. The
  private owner link is not printed when the output is not a terminal, so a service log does not keep it.
- **The example Caddy config** (written by `shapewall hosted setup`) writes JSON access logs to standard output with `Cookie`,
  `Authorization`, `Set-Cookie` and the signature of live-HTML URLs removed. See
  [Secrets, logs and legal text](hosted.md#secrets-logs-and-legal-text).

Where to read them:

```sh
journalctl -u shapewall-hosted -f           # systemd (the example unit)
docker compose logs -f shapewall            # Docker Compose (add caddy for the access log)
```

A capture started from the board's "Capture now" button writes its own output to `.shapewall/<board>/capture.log` (replaced on each
run).

To keep logs longer or search them, point the log shipper you already use (Vector, Fluent Bit, Grafana Alloy and the like) at
journald or at Docker's log driver. Shapewall needs no setting for that.

## Errors

Off by default. Set `SHAPEWALL_ERROR_DSN` (and optionally `SHAPEWALL_ERROR_ENVIRONMENT`, default `production`) to the DSN of an
error tracker you run or use, anything that accepts a Sentry-style DSN, before the server starts, with `@sentry/node` installed
beside Shapewall (`npm install @sentry/node@11.12.0`; the hosted Docker image has it). The server then reports its own
unhandled errors and failed requests, and the pages it serves report browser errors to the same place. The start log says where
reports go (`Error reports go to https://errors.example.com ...`); a DSN that is not valid is a `Warning:` line and reporting stays
off.

A report holds the error, its stack trace, the URL path, the browser or Node version and the release. It never holds board, page or
comment content, request bodies, cookies, headers other than the user agent, query strings, user identities, local variables or
console output. Details: [Error reports (opt-in)](deployment.md#error-reports-opt-in).

## Metrics and traces

Shapewall has neither today: there is no `/metrics` endpoint, no OpenTelemetry export, and the error reporting sends no performance
traces. What you can use instead:

- **Host metrics:** CPU, memory, disk and network from the host or the container, for example with the Prometheus node exporter or
  cAdvisor. The example unit caps the hosted server at 2 GB of memory (`MemoryMax=2G`) and the example Compose file does
  the same (`mem_limit: 2g`), so watch memory against that limit.
- **Response time and uptime:** from the uptime probe on `/api/health` above.
- **Storage:** a hosted server keeps everything in its data folder ([Data and backups](hosted.md#data-and-backups)), and
  `shapewall hosted admin list --data <dir>` shows each workspace's storage against its quota and its last push
  ([Operator commands and quotas](hosted.md#operator-commands-and-quotas)). A local board keeps captures and comments in the
  project's `.shapewall/` folder: `du -sh .shapewall` shows its size.
- **Backups:** `shapewall hosted backup` exits with status 1 when a backup is incomplete, so a timer that runs it fails visibly.
  `shapewall hosted restore --from <backup> --check` runs a restore drill that ends by starting a server on the copy and checking
  `/api/health` ([Retention, backup and restore](hosted.md#retention-backup-and-restore)).

## When something breaks

1. **Health.** `curl -fsS http://127.0.0.1:<port>/api/health` on the server's machine. No answer: the process is down or hung;
   check the service state (`systemctl status`, `docker compose ps`). `421` on `serve`: the Host is not allowed (see above).
2. **Logs.** Read the last start (`journalctl -u <unit> -b`, `docker compose logs --tail 200`) for `Warning:` and `error:` lines.
   A setting that was meant to switch something on and did not is usually visible in the start lines.
3. **Doctor.** `shapewall doctor` checks Node, the browser, the config, the port, the output folder, notifications and the chat
   agent. It exits 1 when a check fails; `--json` gives a machine-readable report.
4. **Disk space.** `df -h` for the disk that holds `.shapewall/` or the hosted data folder. A full disk stops captures, pushes and
   backups.
5. **Browser.** Captures, "Capture now" and page checks need Chromium: `shapewall doctor --install-browser`, plus the
   [Linux system libraries](deployment.md#linux-system-libraries) on a bare Linux machine. The hosted server never starts a browser.
6. **Error tracker.** With `SHAPEWALL_ERROR_DSN` set, look for new issues in the release that is running.
