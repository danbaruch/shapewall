// Help text: every command's section, the full help and one command's help.

import fs from 'node:fs'
import { CONFIG_FILE, SITEMAP_LIMIT_DEFAULT } from '../config.js'
import { AUTH_HELP } from '../auth/record.js'
import { AGENT_STATUSES } from '../store.js'
import { DEFAULT_PORT } from '../serve-state.js'

export const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version

// Each command's help, printed by `shapewall --help` (all of them) and by
// `shapewall <command> --help` (that one).
export const SECTIONS = {
  'buzz-bridge': `  buzz-bridge               run a private foreground gateway to existing Buzz agents
      --bridge-config FILE  private operator map outside project/capture data; Ctrl-C stops it
                            no new agent, session, model, or automatic completion (docs/buzz.md)`,
  settings: `  settings                  open temporary host-only agent settings (no board or chat)
      --port N             loopback port (default: a free port)
      --open               open the private settings link in your browser`,
  auth: AUTH_HELP,
  init: `  init                      write ${CONFIG_FILE} in this folder
      --base-url URL        the site to capture (default http://localhost:3000); finds its
                            pages: <base URL>/sitemap.xml, else links from the home page
                            (2 levels, 25 pages, same site only)
      --sitemap [URL|FILE]  take the pages from this sitemap instead
                            (alone: <base URL>/sitemap.xml)
                            (with --limit, --group, --exclude as for sitemap)
      --no-discover         do not look for pages: write the home page only
      --force               overwrite an existing config
      --ci                  write .github/workflows/shapewall.yml (capture on every pull request) beside
                            the config; an existing config is kept, --force replaces only the workflow`,
  sitemap: `  sitemap [URL|FILE]        add the pages of a sitemap.xml (or sitemap index) to the config
                            (default: the board's "sitemap" setting)
      --limit N             at most N new pages, the shallowest first (default ${SITEMAP_LIMIT_DEFAULT})
      --group NAME          put them all in one group (default: by first path segment)
      --exclude /PREFIX     leave out paths starting with this (repeat or comma-separate)
      --board ID            board to add them to (default: the first)
      --dry-run             show what would be added, change nothing
      --json                machine-readable result`,
  capture: `  capture                   capture every page (desktop + phone, PNG + live HTML) and check its links
      --board ID            board to capture (default: the first)
      --only ID|PATH        only these pages (repeat or comma-separate)
      --env ID              capture this environment (default: the first)
      --check-external      also check links to other sites (default: same-site links only)
      --json                machine-readable summary on stdout (shots, failures, broken links); progress on stderr
      -y, --yes             never ask anything (capture does not prompt; for CI scripts)
                            exit code: 0 all shots ok, 2 some failed (an "expectStatus" page is ok), 1 error`,
  checks: `  checks [run|list]         check original pages and save private diagnostic reports
  checks flow --flow-file FILE    run one explicit interaction flow, with an optional final accessibility snapshot
  checks accessibility --only ID [--viewport NAME]    audit one original page state with axe
      --board ID            board to check (default: the first)
      --env ID              environment to check (default: the first)
      --only ID|PATH        only these pages (repeat or comma-separate)
      --seo | --no-seo      include public SEO and social-image checks, or leave them out when the config turns them on
      --limit N             maximum page views to check (default 20)
      --source-build SHA    source revision for report provenance
      --json                machine-readable reports; progress on stderr`,
  audit: `  audit [board]             run bounded Chrome Lighthouse lab audits on original pages
      --board ID            board to audit (default: the first)
      --env ID              environment to audit (default: the first)
      --only ID             only these page ids (repeat or comma-separate)
      --viewports NAMES     configured viewport names, comma-separated
      --samples N           repeated samples per view (default 1, maximum 10)
      --max-pages N         explicit page cap (default 5, maximum 20)
      --max-runs N          explicit navigation cap (default 10, maximum 40)
      --cache MODE          cold, warm or auth-preserved
      --production MODE    production, development or unknown
      --source-build SHA    source build identifier for provenance
      --browser-version V   require this installed browser version
      --seo | --no-seo      include optional Lighthouse SEO checks, or leave them out when the config turns them on
      --json                machine-readable reports; progress on stderr`,
  serve: `  serve                     serve the board (http://127.0.0.1:4600/ by default)
      --port N              default ${DEFAULT_PORT}
      --host ADDR           default 127.0.0.1 (see docs/deployment.md before changing)
      --tailscale[=print]    private HTTPS over Tailscale; =print changes nothing
      --no-identity         pair even devices signed in as the Tailscale owner
      --lan[=IP|INTERFACE]   pair devices on your network (HTTP cookies can be sniffed)
      --tls-cert FILE       with --lan: HTTPS certificate (also --tls-key FILE)
      --no-remote-chat      paired devices cannot use the agent
      --approve-on-host     paired devices cannot approve agent commands
      --open                also open the board in your browser, with agent settings
      --read-only           no comments or captures from the UI
      --accounts            require local passkey accounts after owner setup (Node 22.13+)
      --accounts-origin URL fixed HTTPS origin (default: loopback URL or --tailscale URL)
      --no-capture          comments allowed, captures only from the CLI
      --buzz-bridge FILE    owner-only existing Buzz conversation (private operator map; docs/buzz.md)
      --allowed-host NAME   extra Host header to accept (repeatable; also $SHAPEWALL_ALLOWED_HOSTS, "*" = any)
      --chat | --no-chat    the board chat with your agent (default on, off when shared beyond this machine)
      --agent-acp "CMD"     chat with an agent CLI over ACP, e.g. "claude-agent-acp" (installed globally)
                            (also $SHAPEWALL_AGENT_ACP; never read from the config; docs/agents.md)
      --allow-remote-agent  with --chat on a shared board, let an ACP agent run anyway (anyone reaching it acts as you)`,
  devices: `  devices list              paired devices and pending requests for this project [--json]
  devices approve CODE      approve after matching the code on your device
  devices deny CODE         deny a pending request
  devices revoke ID|--all   revoke a device or all devices immediately`,
  comments: `  comments [list]           print comments (feedback for you or a coding agent)
      --open | --resolved | --all   which ones (default --open)
      --page ID             only comments on this page
      --mention NAME        only comments that mention @NAME (in the text or a reply)
      --since ID|TIME       only comments after this comment id, or created or changed after this ISO time
      --json                machine-readable, with selectors, file paths and replies
      --for-agent           each comment quoted as untrusted data (<shapewall-data>), for an agent to read
  comments get ID           one comment, everything about it   [--json] [--for-agent]
  comments add              add a comment   --page ID --body TEXT [--viewport NAME (default the page's first)]
                            [--selector CSS (pin it to that element)] [--author NAME (default agent)] [--json]
  comments resolve ID       mark a comment resolved   [--note TEXT] [--ref URL|COMMIT] [--author NAME] [--json]
  comments reopen ID        reopen a comment   [--author NAME] [--json]
  comments reply ID         add a reply   --body TEXT [--author NAME (default agent)] [--json]
  comments status ID S      agent status: ${AGENT_STATUSES.join(', ')} or clear   [--note TEXT] [--author NAME] [--json]
      --board ID            board (default: the first); --remote URL for a hosted board (see push)`,
  events: `  events                    comment events from every process (the shared log); never claims anything
      --follow              keep printing new events until Ctrl+C
      --since ID|TIME       after this event id (from --json) or ISO time
      --limit N             without --follow or --since: the last N (default 20)
      --json                one JSON line per event   [--board ID]`,
  journeys: `  journeys [list]           print the board's journeys, with every fork and branch
      --json                machine-readable: steps (forks included), pages and every path`,
  links: `  links                     links between the board's pages, from the last capture
      --broken              only links that lead to an error (4xx/5xx or no answer)
      --board ID | --env ID | --json`,
  watch: `  watch                     hand each new open comment to an agent (runs until Ctrl+C)
      --exec "CMD ARGS"     run this command per comment (comment JSON on stdin; no shell)
                            without --exec, print one JSON line per comment
      --concurrency N       commands at once, 1 to 4 (default 1)
      --recapture           recapture the comment page after a successful --exec (local only)
      --new-only            skip comments that exist when the watch starts
      --once                hand out what is open now, wait for the commands, exit
      --timeout MIN         stop a command after this many minutes (default 60)
      --mention NAME        only comments that mention @NAME, e.g. --mention agent
      --no-claim            hand out every open comment once without claiming it (no agent status, beside other watchers)
                            a command that exits 0 must reply or set a status itself, else the
                            comment becomes needs-human (docs/agent-workflow.md)`,
  agent: `  agent run --comment ID    the sandboxed starter agent on one comment: a container with only a fresh
                            worktree, egress to the package registry only (the model is called from here), a branch
      --pr                  also push the branch and open a pull request (GitHub connect); not when it
                            touches CI config, manifests or build files unless --allow-ci-push
      --git-remote NAME     the git remote --pr pushes to (default origin; never from the config)
      --fork-remote NAME    push to your fork (a git remote) instead, and open the PR from it
      --retry               take a comment whose agent status is done or needs-human too
      --trust-comment       run a comment the trigger gate holds back (never a guest's)
      --max-turns N | --max-tokens N | --max-minutes N   budget for this comment
      --max-disk SIZE       disk cap on the checkout (default 2g; the run stops over it)
      --model-timeout S     seconds a model call may take to start answering, 1 to 900 (default 180 for
                            the first call, 60 after; tried once more on a timeout)
      --trusted NAME        may dispatch work (repeatable; adds to starterAgent.trusted)
      --runtime podman|docker   --image NAME   --profile openai-compatible
      --allow-host HOST[:PORT]  extra egress host (repeatable)   --registry HOST|none
      --work-dir DIR        where worktrees go (default: the cache folder)
  agent watch               run the starter agent on each comment the trigger gate lets through   [--once]
  agent doctor              check the runtime, image, model, trust lists and the sandbox itself   [--no-egress]
  agent build-image         build the agent's image from this package's Dockerfile.agent
      --runtime podman|docker   --image NAME (default localhost/shapewall-agent:latest)
                            (docs/starter-agent.md; --remote URL works for run and watch)`,
  github: `  github issue ID           open a GitHub issue from a comment (or show the one it has)
  github link ID PR         link a pull request (12, #12 or its URL) to a comment
  github sync               link pull requests that name a comment; resolve comments whose PR merged
                            (repo: "github.repo" in the config; token: $SHAPEWALL_GITHUB_TOKEN or $GITHUB_TOKEN,
                            else a signed-in GitHub CLI ("gh auth token"))`,
  ci: `  ci capture-compare        capture before and after, compare every page and viewport, write a result
                            folder: summary.json, summary.md (the comment), images of changed shots
      --base-url URL        before (default: the board's baseUrl)   --head-url URL   after
      --base-dir DIR        or compare two capture folders   --head-dir DIR
      --out DIR             the result folder (default shapewall-ci)
      --threshold RATIO     share of pixels below which a shot is unchanged (default ci.threshold, 0.001)
      --max-pages N         compare at most N pages (default ci.maxPages, 50)
      --fail-on-change      exit 3 when something changed (default: always 0, never fails the pull request)
  ci capture --out DIR      capture one side into a folder, from --url URL, or with --allow-start
      --allow-start         run ci.start (install, build, serve; argv arrays, no shell) in --checkout DIR
                            and capture its url; only inside a CI job (GITHUB_ACTIONS or CI is "true")
  ci comment                post or update the one pull request comment from a result folder
      --dir DIR             the result folder (default shapewall-ci)
      --artifact-url URL    link to the workflow artifact with the images
      --repo OWNER/NAME | --pull N   default: from the pull_request event
                            token: $GITHUB_TOKEN; a fork's pull request gets the job summary instead
  ci enabled                is it on for this pull request (ci.enabled, [skip shapewall] in the title)?
                            writes enabled=true|false to $GITHUB_OUTPUT
  ci wait --url URL         wait until a deploy preview answers   [--timeout SECONDS (default 600)]
      --board ID | --json   (docs/pull-requests.md)`,
  mcp: `  mcp                       MCP server on stdio for coding agents
      --read-only | --no-capture`,
  notify: `  notify list               notification channels, their events and what each still needs   [--json]
  notify test CHANNEL       send a test message to one channel   [--to EMAIL for email channels]`,
  doctor: `  doctor                    check Node, the browser, the config, the port, the output folder, notifications and chat
      --install-browser     download the Chromium this Shapewall needs first (no config needed for this)
      --port N              port to check (default ${DEFAULT_PORT})
      --no-launch           find the browser and the ACP agent without starting them
      --agent-acp "CMD"     the ACP agent to check: starts it, does the handshake, stops it (also $SHAPEWALL_AGENT_ACP)
      --json                machine-readable report`,
  variant: `  variant add PAGE          capture another version of a page beside it
      --url URL | --path /p the version to capture (path is on the board's baseUrl)
      --title TEXT          [--note TEXT] [--source TEXT] [--id ID] [--viewport desktop,phone]
                            the id is --id, else the title as a slug plus 4 random characters
  variant rm ID | variant list`,
  export: `  export                    static read-only copy of the boards
      --include-checks      explicitly include private diagnostic reports
      --out DIR             default shapewall-export
      --no-comments         leave comments out
      --browser-comments    visitors may comment; their comments stay in their own browser
      --noindex             ask search engines not to index the export`,
  share: `  share --remote URL        move local captures, history and comments to a shared project
      --include-checks      explicitly include private diagnostic reports
      --board ID            move only this board (default all)
      --dry-run             show counts; sends nothing
      --no-comments         captures, history and journeys only`,
  login: `  login --remote URL        get a project token through the browser; saved for the --remote commands`,
  push: `  push                      upload the latest captures to a hosted project
      --include-checks      explicitly include private diagnostic reports
      --remote URL          the hosted Shapewall (or $SHAPEWALL_REMOTE)
      --board ID            only this board (default: every board)
  comments | watch | mcp --remote URL
                            the same commands against a hosted board (--board ID picks one)
                            token: $SHAPEWALL_TOKEN or --token-file FILE (a project token, swp_...)
                            watch --exec commands get no token unless --pass-token
      --include-guests      comments and watch: also share link guests' comments (untrusted)`,
  hosted: `  hosted                    run the hosted server (accounts, workspaces, pushed boards)
      --data DIR            default ./shapewall-hosted-data (or $SHAPEWALL_HOSTED_DATA)
      --origin URL          public origin, e.g. https://app.example.com (default http://HOST:PORT)
      --port N | --host ADDR   default 4700 on 127.0.0.1
      --signup invite|open  default invite (the first account uses the setup link)
      --trust-proxy         behind a reverse proxy on this host (client IPs from X-Forwarded-For)
      --usercontent-origin URL  serve live HTML only from this other origin (or $SHAPEWALL_USERCONTENT_ORIGIN)
      --previous-origin URL while moving to a new origin: the old one (sign-in moves, up to 30 days)
      --report-email ADDR   where "Report this board" on public projects goes
      --tailscale           on your tailnet through tailscale serve (https://<machine>.<tailnet>.ts.net)
      --tailscale-port N    default 443; --funnel: share links public through Tailscale Funnel
                            (share pages only, never the console), on --funnel-port 8443|443|10000
      --quotas FILE         per-workspace quotas (default <data>/quotas.json when it exists)
      --retention-hours N   prune old versions every N hours (default 6, 0 = off); --retention-keep N (2)
  hosted setup-link         print the first account's one-time link (it is not in the log)
      --data DIR | --new    --new: make a new link (the old one stops working)
  hosted move-origin --to URL   move the server to a new origin (passkeys move with a rebind)
      --data DIR | --days N | --status   window 1 to 30 days (default 30)
  hosted --setup --domain HOST   write a Docker Compose + Caddy folder for your own domain
      --usercontent-domain HOST  live HTML on its own domain; --email (TLS); --dir (./shapewall-hosted)
      --source DIR          a Shapewall checkout to build from; --dry-run; --force; --start (build, start, setup link)
  hosted admin list|suspend|resume|delete|export|reports|retention|log   the operator's commands
  hosted backup --to DIR [--keep-days N]   a consistent copy while the server runs
  hosted restore --from BACKUP --data NEW | --from BACKUP --check (the restore drill)`,
}

const LOCAL_COMMANDS = Object.keys(SECTIONS).filter((name) => !['login', 'push', 'hosted'].includes(name))

const GLOBAL_HELP = `Global
  --config FILE             default ./${CONFIG_FILE} (or $SHAPEWALL_CONFIG)
  -h, --help | -v, --version   (shapewall <command> --help shows one command)`

export const HELP = `shapewall ${VERSION} -- every page of your site on one zoomable wall

Usage: shapewall <command> [options]

Commands
${LOCAL_COMMANDS.map((name) => SECTIONS[name]).join('\n')}

Hosted Shapewall (docs/hosted.md)
${SECTIONS.login}
${SECTIONS.push}
${SECTIONS.hosted}

${GLOBAL_HELP}
`

export function commandHelp(command) {
  if (!SECTIONS[command]) return HELP
  return `Usage: shapewall ${command} [options]\n\n${SECTIONS[command]}\n\n${GLOBAL_HELP}\n`
}
