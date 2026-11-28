// Help text: every command's section, the full help and one command's help.

import fs from 'node:fs'
import { CONFIG_FILE, SITEMAP_LIMIT_DEFAULT } from '../config.js'
import { AUTH_HELP } from '../auth/record.js'
import { AGENT_STATUSES } from '../store.js'
import { DEFAULT_PORT } from '../serve-state.js'

export const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version

// The marker on a command or option that the 1.x stability promise does not
// cover (https://shapewall.com/docs/stability): always this suffix, at the
// end of the line that names it.
export const EXPERIMENTAL = ' (experimental)'

// Each command's help, printed by `shapewall --help` (all of them) and by
// `shapewall <command> --help` (that one).
export const SECTIONS = {
  settings: `  settings                  open temporary host-only agent settings (no board or chat)
      --port N             loopback port (default: a free port)
      --open               open the private settings link in your browser`,
  auth: AUTH_HELP,
  init: `  init                      write ${CONFIG_FILE} in this folder
      --base-url URL        the app to capture (default http://localhost:3000); finds its
                            pages: <base URL>/sitemap.xml, else links from the home page
                            (2 levels, 25 pages, same site only)
      --sitemap [URL|FILE]  take the pages from this sitemap instead
                            (alone: <base URL>/sitemap.xml)
                            (with --limit, --group, --exclude as for sitemap)
      --no-discover         do not look for pages: write the home page only
      --force               overwrite an existing config
      --ci                  write .github/workflows/shapewall.yml (capture on every pull request) beside
                            the config; an existing config is kept, --force replaces only the workflow
      --no-agent-docs       do not add the Shapewall section to AGENTS.md, and write "agentDocs": false
                            into the config so serve and capture do not either (see agent docs)
                            exit code: 0 config written (a warning when the app did not answer: home page only),
                            2 the address answered but not with a page (check --base-url), 1 error`,
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
      --json                machine-readable summary on stdout (totals, failures, broken links); progress on stderr
                            exit code: 0 all shots ok, 2 some failed (an "expectStatus" page is ok), 1 error`,
  checks: `  checks [run|list]         check original pages and save private diagnostic reports${EXPERIMENTAL}
  checks flow --flow-file FILE    run one explicit interaction flow, with an optional final accessibility snapshot
  checks accessibility --only ID [--viewport NAME]    audit one original page state with axe
      --board ID            board to check (default: the first)
      --env ID              environment to check (default: the first)
      --only ID|PATH        only these pages (repeat or comma-separate)
      --seo | --no-seo      include public SEO and social-image checks, or leave them out when the config turns them on
      --limit N             maximum page views to check (default 20)
      --source-build SHA    source revision for report provenance
      --json                machine-readable reports; progress on stderr
                            exit code: 0 all passed, 2 some failed, 130 or 143 stopped (Ctrl+C, SIGTERM) before every view, 1 error
  checks lighthouse         run bounded Chrome Lighthouse lab audits on original pages${EXPERIMENTAL}
                            (needs Lighthouse beside Shapewall: npm install lighthouse@13.6.0)
                            --board, --env, --source-build, --seo | --no-seo and --json as above
      --only ID             only these page ids (repeat or comma-separate)
      --viewports NAMES     configured viewport names, comma-separated
      --samples N           repeated samples per view (default 1, maximum 10)
      --max-pages N         explicit page cap (default 5, maximum 20)
      --max-runs N          explicit navigation cap (default 10, maximum 40)
      --cache MODE          cold, warm or auth-preserved
      --build-mode MODE     the app's build: production, development or unknown (default)
      --browser-version V   require this installed browser version
                            exit code: 0 every view complete, 2 some partial or failed, 1 error`,
  serve: `  serve                     serve the board on this machine (the solo engine; port 4600 by default)
      --port N              default ${DEFAULT_PORT}
      --host ADDR           default 127.0.0.1 (see https://shapewall.com/docs/self-hosting before changing)
      --tailscale[=print]    private HTTPS over Tailscale; =print changes nothing
      --no-identity         pair even devices signed in as the Tailscale owner
      --lan[=IP|INTERFACE]   pair devices on your network (HTTP cookies can be sniffed; deprecated: use --tailscale)
      --tls-cert FILE       with --lan: HTTPS certificate (also --tls-key FILE)
      --no-remote-chat      paired devices cannot use the agent
      --approve-on-host     paired devices cannot approve agent commands
      --open                also open the board in your browser, with agent settings
      --print-owner-link    print the private owner link in full (also $SHAPEWALL_PRINT_OWNER_LINK=1)
      --read-only           no comments or captures from the UI
      --accounts            require local passkey accounts after owner setup (Node 22.19+; deprecated: the solo
                            engine signs its owner in by itself)
      --accounts-origin URL fixed HTTPS origin (default: loopback URL or --tailscale URL)
      --no-capture          comments allowed, captures only from the CLI
      --buzz-bridge FILE    owner-only existing Buzz conversation (private operator map; https://shapewall.com/docs/buzz)${EXPERIMENTAL}
      --allowed-host NAME   extra Host header to accept (repeatable; also $SHAPEWALL_ALLOWED_HOSTS, "*" = any)
      --chat | --no-chat    the board chat with your agent (default on, off when shared beyond this machine)
      --agent-acp "CMD"     chat with an agent CLI over ACP, e.g. "claude-agent-acp" (installed globally)
                            (also $SHAPEWALL_AGENT_ACP; never read from the config; https://shapewall.com/docs/chat)
      --allow-remote-agent  with --chat on a shared board, let an ACP agent run anyway (anyone reaching it acts as you)
      --engine hosted       the default from 2.0: the hosted engine for this project, on this machine only: one
                            owner, signed in by a one-time page (--open), data in .shapewall/.engine/; the first
                            start in a 1.x project runs shapewall migrate (backup first); takes --port, --open,
                            --print-owner-link, --read-only, --no-chat, --no-capture, --skip-git-check
                            (start even when git cannot say whether it tracks .engine/); while it runs,
                            comments, watch and mcp in this folder go to it, and it runs this project's
                            agent (a coding agent or a model endpoint) on the link; --no-chat without one
      --team [on|off]       hosted engine: put this board on your tailnet (tailscale serve, tailnet sign-in) for
                            the people you invite: the same data, nothing copied, you stay the owner. off: this
                            machine only again. Kept in .shapewall/.engine/, so the next serve starts the way it
                            was left; each start prints who can reach it. While the engine runs it switches
                            there. Invite people in the console does the same
      --team-port N         with --team: the HTTPS port on your tailnet (default 443)
      --engine legacy       the 1.x board server (deprecated, removed in 3.0; also $SHAPEWALL_ENGINE=legacy);
                            --host, --lan, --tailscale, --accounts, --agent-acp and the other 1.x-only flags pick it too`,
  devices: `  devices list              paired devices and pending requests for this project [--json]
                            (deprecated: use the tailnet instead, see shapewall serve --help)
  devices approve CODE      approve after matching the code on your device
  devices deny CODE         deny a pending request
  devices revoke ID|--all   revoke a device or all devices immediately`,
  comments: `  comments [list]           print comments (instructions for your coding agent)
      --open | --resolved | --all   which ones (default --open)
      --page ID             only comments on this page
      --mention NAME        only comments that mention @NAME (in the text or a reply)
      --since ID|TIME       only comments after this comment id, or created or changed after this ISO time
      --json                machine-readable, with selectors, file paths and replies
      --for-agent           each comment quoted as untrusted data (<shapewall-data>), for an agent to read
  comments get ID           one comment, everything about it   [--json] [--for-agent]
  comments add              add a comment   --page ID --body TEXT [--viewport NAME (default the page's first)]
                            [--selector CSS (pin it to that element)] [--author NAME (default agent)] [--json]
  comments selectors        the selectors --selector takes, with each element's text, from the latest capture
                            --page ID [--viewport NAME] [--text WORDS (only elements whose text has them)] [--json]
  comments resolve ID       mark a comment resolved   [--note TEXT] [--ref URL|COMMIT] [--author NAME] [--json]
  comments reopen ID        reopen a comment   [--author NAME] [--json]
  comments reply ID         add a reply   --body TEXT [--author NAME (default agent)] [--json]
  comments status ID S      agent status: ${AGENT_STATUSES.join(', ')} or clear   [--note TEXT] [--author NAME] [--json]
  comments delete ID        delete a comment, its replies and its images for good; asks first
                            [--yes (do not ask; needed without a terminal)] [--json]
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
                            without --exec, print one JSON line per comment and mark it queued
                            (the reader sets its status with "comments status"; --no-claim marks none)
      --concurrency N       commands at once, 1 to 4 (default 1)
      --recapture           recapture the comment page after a successful --exec (local only)
      --new-only            skip comments that exist when the watch starts
      --once                hand out what is open now, wait for the commands, exit
      --timeout DURATION    stop a command after this long, e.g. 90s, 30m or 2h (default 60m; a number alone is minutes)
      --mention NAME        only comments that mention @NAME, e.g. --mention agent (mentions people wrote;
                            text an agent wrote never counts)
      --no-claim            hand out every open comment once without claiming it (no agent status, beside other watchers)
                            a command that exits 0 must reply or set a status itself, else the
                            comment becomes needs-human (https://shapewall.com/docs/agent-workflow)`,
  agent: `  agent setup               register the shapewall MCP server with Claude Code and Codex (each one on PATH),
                            so an agent opened in this project has the board's tools. Shows what changes and
                            asks first; backs up each file it changes; touches only the shapewall entry
      --claude | --codex    only this app
      --scope local|user|project  Claude Code: local (default) this project, only you; user every project
                            of yours; project .mcp.json, committed (Claude Code asks each person to approve it).
                            Codex has no scope: ~/.codex/config.toml, every project, tool_timeout_sec 600
      --remote URL          a hosted board: registers "shapewall mcp --remote URL" (needs shapewall login first;
                            no token is written)
      --force               replace a shapewall entry that is different (an older Shapewall's entry
                            is updated without it)
      --dry-run             show the changes, write nothing      --yes   write without asking
      --remove              take the shapewall entries out       --json  machine-readable
  agent status              what the agent can do here, line by line and per tier (solo, team, open): the same
                            lines the console shows under What it can do, and the agent's own instructions.
                            Each line that is off says why, and the command that changes it
      --remote URL          a connected agent (its agent-policy.json entry, and whether its link is open);
                            without it, the local board in this project
      --as NAME             which connection (default "default")   --json  machine-readable
  agent set KEY VALUE       change one line without reconnecting, for example: agent set browser off,
                            agent set shell commands, agent set trust-team ada,bo. With --remote URL (and --as NAME)
                            a connected agent's setting (narrower: from its next turn); without it, this project's
                            local board, read by the next turn. "agent status" lists the keys under each line.
                            Extensions: agent set agent-config DIR (a local board's skills and MCP servers),
                            agent set extensions-for owner,HANDLE, agent set allow-tool mcp__SERVER__TOOL
  agent docs                where the Shapewall section for coding agents is (AGENTS.md, CLAUDE.md)
      --write | --remove | --print   put it in (or refresh it), take it out (and set "agentDocs": false
                            in the config, so it stays out in every clone), print it. The first serve or
                            capture creates both files only in a project with neither and no "agentDocs"
                            in the config; an existing AGENTS.md or CLAUDE.md is never edited unasked
  agent connect             make this machine's coding agent an agent of a hosted project: members chat with it
                            on the board, and it reads this folder and answers. Read and answer only unless this
                            machine says more (--approvals). The first run is approved in the browser by an admin.
                            --remote URL
      --agent NAME          which agent: claude, or a saved agent's id that runs Claude Code (default: this
                            project's agent, else Claude Code when found). Codex, goose and Gemini CLI are not
                            offered in this release. Never a command from the server
      --endpoint            a model endpoint instead (experimental): Ollama, DeepSeek, OpenAI-compatible, from
                            this project's agent.baseUrl and agent.model, Settings > Agent or SHAPEWALL_AGENT_BASE_URL
                            and SHAPEWALL_AGENT_MODEL; the key stays in its variable. Answers only: no edits, no
                            commands, no tools
      --name "Builder"      the name to suggest on the approval page (the approver has the last word)
      --project SLUG        on a server with tailnet sign-in, run on a tailnet machine (experimental)
                            no browser, your tailnet user approves it. --project (and --workspace NAME) pick the
                            project when there are several; --used-by owner|trusted who may send it work (default owner: only you);
                            --icon NAME and --tint NAME as on the approval page
      --as NAME             a second connection from this machine (its own token; default "default")
      --audience owner|server  "owner": the server keeps it to the person who connects it even if its audience
                            there is widened, and this machine refuses a job the server says is someone else's
                            (no protection from a server that lies); "server" (default): its audience on the server
      --approvals none|owner|admins  edits from the board. "none" (default): never. "owner": the person who
                            connected it may allow each edit on the board. "admins": whoever the server lets
                            answer (admins by default). A fix is made on a new branch in a folder of its own,
                            never in this checkout. Saved for this connection; the server cannot widen it
      --allow-command "CMD" refused in this release ("none" empties a saved list; agent set allow-command
                            too): exact commands would need Claude Code's own shell tool, which runs read-only
                            commands without asking. The project's named commands run through Shapewall instead
      --auto none|edits|commands|edits,commands  what the server's "allow without asking" rule may apply to
                            (default none). Never a file that runs something. Such a fix stays on this machine:
                            it is pushed only after a person allows "Push this fix" on its whole diff. With
                            --approvals owner, only the person who connected it can switch the rule on
      --allow-path FILE     a file that runs on install, build, test or CI (a dotfile, package.json, a Makefile,
                            a *.config.js, a script, a test, CI config) the agent may ask to edit; such edits are
                            refused otherwise, a named one is always asked, and a fix that changes one is never
                            pushed (adds to the list; "none" empties it)
      --base BRANCH         the branch a fix starts from (default "head": the commit this checkout is on, and
                            then only while it has no uncommitted changes)
      --git-remote NAME     where a finished fix is pushed (default origin; "none": never pushed). A pull request
                            is opened when GitHub connect is set up here (https://shapewall.com/docs/github)
      --instructions all|project|none  instruction files each session gets as an appended system prompt: the
                            project's CLAUDE.md and .claude/CLAUDE.md (AGENTS.md when neither exists) and, with "all"
                            (default), the agent config folder's CLAUDE.md. Never ~/.claude or CLAUDE.local.md. Names
                            and hashes show on the board, never the text. They add no powers. Saved for this connection
      --agent-config DIR|none  this agent's own folder for its CLAUDE.md (default: agent-config/<--as name> beside
                            agent-policy.json, read only when it exists; never created). Outside the project.
                            A folder named here also gives skills (skills/NAME/SKILL.md) and stdio MCP servers
                            (.claude.json mcpServers) to trusted turns on clean threads (extensions-for, allow-tool)
      --respond thread|mention  in a shared thread (the board chat, a comment's) it answers an @mention of it or
                            Send to agent; "thread" (default) also every message of a thread the person who
                            connected it set to answer everything, "mention" never. A private chat answers every
                            message; a message an agent wrote never starts a turn. Saved for this connection
      --browser-profile NAME|none  a saved profile of the agent browser's own (test or staging logins), made
                            in $XDG_STATE_HOME/shapewall/agent-browser-profiles/NAME; never a browser's own profile
      --browser-no-sandbox  let the agent browser start without Chromium's own sandbox where it cannot start
                            (solo and team turns only; pages then run with less isolation). Saved for this connection
      --takeover            close the link another machine holds for this agent, and take its place
      --concurrency N       answers at once, 1 to 4 (default 2)
      --token-file FILE     for a service: the agent's own token, no browser (https://shapewall.com/docs/hosted)
  agent sandbox run --comment ID   (experimental)
                            the sandboxed starter agent on one comment: a container with only a fresh
                            worktree, egress to the package registry only (the model is called from here), a branch
      --pr                  also push the branch and open a pull request (GitHub connect); not when it
                            touches CI config, manifests or build files unless --allow-ci-push
      --git-remote NAME     the git remote --pr pushes to (default origin; never from the config)
      --fork-remote NAME    push to your fork (a git remote) instead, and open the PR from it
      --retry               take a comment whose agent status is done or needs-human too
      --trust-comment       run a comment the trigger gate holds back (never a guest's)
      --max-turns N | --max-tokens N | --max-minutes N   budget for this comment
      --max-disk SIZE       disk cap on the checkout (default 2g; the run stops over it)
      --model-timeout DURATION  time a model call may take to start answering, 1s to 15m (default 180s for the
                            first call, 60s after; tried once more on a timeout; a number alone is seconds)
      --trusted NAME        may dispatch work (repeatable; adds to starterAgent.trusted)
      --runtime podman|docker   --image NAME   --profile openai-compatible (the only profile)
      --allow-host HOST[:PORT]  extra egress host (repeatable)   --registry HOST|none
      --work-dir DIR        where worktrees go (default: the cache folder)
  agent sandbox watch       run the starter agent on each comment the trigger gate lets through   [--once]
  agent sandbox doctor      check the runtime, image, model, trust lists and the sandbox itself   [--no-egress]
  agent sandbox build-image build the agent's image from this package's Dockerfile.agent
      --runtime podman|docker   --image NAME (default localhost/shapewall-agent:latest)
                            (https://shapewall.com/docs/starter-agent; --remote URL works for run and watch)`,
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
      --threshold RATIO     share of pixels below which a shot is unchanged (default ci.threshold, 0.00001)
      --max-pages N         compare at most N pages (default ci.maxPages, 50)
      --fail-on-change      exit 3 when something changed, 4 when not everything could be compared (default: always 0)
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
  ci wait --url URL         wait until a deploy preview answers   [--timeout DURATION (default 600s, at most 1h;
                            a number alone is seconds)]
      --board ID | --json   (https://shapewall.com/docs/pull-requests)`,
  open: `  open                      print and open a deep link: a board, a page, a comment, a screen size, a before and after
      --board ID            the board (default: the first)
      --page ID|TITLE       fly to this page
      --comment N           open on this comment, at its screen size (wins over --page)
      --viewport NAME       desktop, phone, any viewport of the board, or all
      --compare [A_B]       alone: the page's before and after (needs --page or --comment);
                            A_B: two environments side by side
      --follow [AGENT]      follow an agent: fly to each comment it takes, before and after when it
                            recaptures that screen (alone: any agent; hosted: an agent id)
      --print               print the link only, do not open a browser
      --json                { url, board, page, comment, viewport, compare, follow, running }; opens nothing
      --remote URL          a hosted project instead of the local board (with --token-file, --include-guests)
                            When the local board is not running, it prints the link and says to run shapewall serve`,
  mcp: `  mcp                       MCP server on stdio for coding agents: find comments, reply, recapture, compare
                            before and after, and links to the board. shapewall agent setup registers it
      --read-only | --no-capture   only the reading tools | everything but recapture_pages`,
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
  variant remove ID | variant list`,
  export: `  export                    static read-only copy of the boards, for any static web server
                            (view it with "npx serve shapewall-export"; opening index.html from disk does not work)
      --include-checks      explicitly include private diagnostic reports
      --out DIR             default shapewall-export
      --no-comments         leave comments (their text, authors and replies) out
      --browser-comments    visitors may comment; their comments stay in their own browser
      --no-index            ask search engines not to index the export`,
  share: `  share --remote URL        move local captures, history and comments to a shared project
      --include-checks      explicitly include private diagnostic reports
      --board ID            move only this board (default all)
      --dry-run             show counts; sends nothing
      --no-comments         captures, history and journeys only`,
  migrate: `  migrate                   move this project's .shapewall/ into the solo engine (.shapewall/.engine/)${EXPERIMENTAL}
                            captures, comments, chat and the local account; a backup goes to
                            .shapewall/backup-1x-<time>/ first; the solo engine serves it after. Refuses while
                            serve (either engine), capture, watch or an agent runs
      --dry-run             counts, and every item that would not come along; writes nothing
      --board ID            only this board (default: every board)
      --rollback            put every migration back from its backup (checked byte for byte)
      --json                machine-readable result
                            exit code: 0 done or nothing to do, 1 refused or failed (the folder is put back)`,
  'buzz-bridge': `  buzz-bridge               run a private foreground gateway to existing Buzz agents${EXPERIMENTAL}
      --bridge-config FILE  private operator map outside project/capture data; Ctrl-C stops it
                            no new agent, session, model, or automatic completion (https://shapewall.com/docs/buzz)`,
  login: `  login --remote URL        get a project token through the browser; saved for the --remote commands
      --project SLUG        on a server with tailnet sign-in, run on a tailnet machine (experimental)
                            no code and no browser; your tailnet user approves it (if its role may). --project, and --workspace NAME
                            when you are in several, pick the project; with one project neither is needed`,
  join: `  join --remote URL         join a workspace on a server with tailnet sign-in (experimental)
                            from a tailnet machine: takes the invite an admin made for your tailnet login. The
                            role is the invite's
      --invite LINK         an invite link (or its code) instead`,
  admin: `  admin projects list|create NAME | members list | agents list | invites create   (experimental)
                            a few admin commands on a server with tailnet sign-in, as your tailnet user (the
                            server checks your role). --remote URL; --workspace NAME when you are in several
      --login LOGIN         invites create: for one tailnet login (ada@example.com); or --link for a link
      --role ROLE           viewer, member (default), admin or owner; --days N until it expires; --name; --json`,
  push: `  push                      upload the latest captures to a hosted project
      --include-checks      explicitly include private diagnostic reports
      --remote URL          the hosted Shapewall (or $SHAPEWALL_REMOTE)
      --board ID            only this board (default: every board)
      --page ID[,ID]        only these pages' captures, to a board already pushed; other pages
                            there stay as they are, and a newer capture there is never replaced
  comments | watch | mcp --remote URL
                            the same commands against a hosted board (--board ID picks one)
                            token: $SHAPEWALL_TOKEN or --token-file FILE (a project token, swp_...)
                            watch --exec commands get no token unless --pass-token
                            watch and mcp show on the board as an agent, by the token's name
                            mcp --remote in a project folder, with the "push" scope, also has
                            recapture_pages: it captures here, then pushes those pages;
                            add_comment needs the "reply" scope
      --include-guests      comments and watch: also share link guests' comments (untrusted)`,
  hosted: `  hosted                    run the hosted server (accounts, workspaces, pushed boards)
      --data DIR            default ./shapewall-hosted-data (or $SHAPEWALL_HOSTED_DATA)
      --origin URL          public origin, e.g. https://app.example.com (default http://HOST:PORT)
      --port N | --host ADDR   default 4700 on 127.0.0.1
      --signup invite|open  default invite (the first account uses the setup link)
      --trust-proxy         behind a reverse proxy on this host (client IPs from X-Forwarded-For)
      --usercontent-origin URL  serve live HTML only from this other origin (or $SHAPEWALL_HOSTED_USERCONTENT_ORIGIN)
      --previous-origin URL while moving to a new origin: the old one (sign-in moves, up to 30 days)
      --report-email ADDR   where "Report this board" on public projects goes
      --owners-see-sign-ins workspace owners see their members' sign-ins and devices in Activity
                            (off: each person sees only their own; for a server with one team)
      --tailscale           on your tailnet through tailscale serve (https://<machine>.<tailnet>.ts.net)
      --tailscale-port N    default 443
      --funnel              share links public through Tailscale Funnel (experimental)
                            (share pages only, never the console), on --funnel-port 8443|443|10000
      --tailnet-sign-in     with --tailscale: sign tailnet users in by their tailnet login (experimental)
                            a tailnet user is signed in as the account linked to their tailnet login, no passkey (or $SHAPEWALL_HOSTED_TAILNET_SIGN_IN=1). An admin still decides
                            who is in a workspace. Needs Linux, macOS or Windows and Tailscale 1.98+ in TUN mode, not
                            in a container; refuses to start where it cannot prove that a request came through
                            tailscale serve. An identity is per device: what runs as you there can act as you.
                            Tailscale is then the only sign-in: no passkeys, and the few things that always ask
                            take a typed confirmation
      --tailnet-passkeys    with --tailnet-sign-in: also allow passkeys (experimental)
                            ($SHAPEWALL_HOSTED_TAILNET_PASSKEYS=1, or hosted admin passkeys on|off). An account that adds one confirms with it
      --quotas FILE         per-workspace quotas (default <data>/quotas.json when it exists)
      --retention-hours N   prune old versions every N hours (default 6, 0 = off); --retention-keep N (2)
  hosted setup-link         print the first account's one-time link (it is not in the log)
  hosted claim --data DIR --login LOGIN   (experimental)
                            with --tailnet-sign-in: make the first account on the server's own machine, no
                            browser. Whoever can read the data folder says whose server it is: --login is the
                            owner's tailnet login (ada@example.com); --workspace-name NAME. From another tailnet
                            device: hosted claim --setup-link URL (the server then sees who asks)
      --data DIR | --new    --new: make a new link (the old one stops working)
  hosted move-origin --to URL   move the server to a new origin (passkeys move with a rebind)
      --data DIR | --days N | --status   window 1 to 30 days (default 30)
  hosted setup --domain HOST    write a Docker Compose + Caddy folder for your own domain
      --usercontent-domain HOST  live HTML on its own domain; --email (TLS); --dir (./shapewall-hosted)
      --source DIR          a Shapewall checkout to build from; --dry-run; --force; --start (build, start, setup link)
  hosted admin list|suspend|resume|delete|export|reports|retention|log   the operator's commands
  hosted admin members|invites|projects|passkeys ...   who is in a workspace and how people sign in, from the
                            server's own machine (shapewall hosted admin help lists them)
  hosted backup --to DIR [--keep-days N]   a consistent copy while the server runs
  hosted restore --from BACKUP --data NEW | --from BACKUP --check (the restore drill)`,
}

// Commands that still work but are left out of the help lists: `settings` (serve --open opens the same settings).
export const HIDDEN = ['settings']

const LOCAL_COMMANDS = Object.keys(SECTIONS).filter((name) => ![...HIDDEN, 'login', 'join', 'admin', 'push', 'hosted'].includes(name))

const GLOBAL_HELP = `Global
  --config FILE             default ./${CONFIG_FILE} (or $SHAPEWALL_CONFIG)
  -h, --help | -v, --version   (shapewall <command> --help shows one command)
  exit codes: 0 ok, 1 error, 2 partial (some shots, checks or Lighthouse views failed, or init's address
  answered with no page), 3 and 4 a ci comparison that asked to fail on a change, 130 or 143 stopped
  (Ctrl+C, SIGTERM)
  (experimental): may change in a minor release; not covered by https://shapewall.com/docs/stability`

const TAGLINE = `shapewall ${VERSION} -- every screen of your app on one wall; steer your coding agents from it`

// Every command and every option: `shapewall --help all` (and `shapewall help all`).
// README.md and the website's CLI page carry this text (test/docs-help.test.js).
export const HELP = `${TAGLINE}

Usage: shapewall <command> [options]

Commands
${LOCAL_COMMANDS.map((name) => SECTIONS[name]).join('\n')}

Hosted Shapewall (https://shapewall.com/docs/hosted)
${SECTIONS.login}
${SECTIONS.join}
${SECTIONS.admin}
${SECTIONS.push}
${SECTIONS.hosted}

${GLOBAL_HELP}
`

// What `shapewall`, `shapewall --help` and `shapewall help` print: the commands a
// newcomer runs, in the order they run them, then the rest by name only.
const CORE = ['doctor', 'init', 'capture', 'serve', 'comments', 'watch', 'mcp']
// The rest, roughly by how soon someone needs them; any command not named here goes last.
const ADVANCED_ORDER = ['sitemap', 'variant', 'journeys', 'links', 'open', 'checks', 'export', 'notify', 'github', 'ci', 'events']
const ADVANCED = [
  ...ADVANCED_ORDER,
  ...Object.keys(SECTIONS).filter((name) => !CORE.includes(name) && !ADVANCED_ORDER.includes(name) && !HIDDEN.includes(name)),
]

export const SHORT_HELP = `${TAGLINE}

Usage: shapewall <command> [options]

Start here (with your app running)
  doctor --install-browser  download Chromium and check that everything works
  init --base-url URL       write ${CONFIG_FILE} with your app's pages
  capture                   capture every page, desktop and phone
  serve --open              open the board and point at what to change

Hand comments to your coding agent
  comments --open --json    the open comments, with page, element and screenshot
  watch                     hand each new comment to your agent (runs until Ctrl+C)
  mcp                       MCP server with the same tools, for agents that speak MCP

Advanced
${wrapNames(ADVANCED)}

"shapewall <command> --help" shows one command in full; "shapewall --help all" shows every command.
`

function wrapNames(names, width = 100) {
  const lines = []
  let line = ' '
  for (const [index, name] of names.entries()) {
    const word = ` ${name}${index < names.length - 1 ? ',' : ''}`
    if (line.length + word.length > width) {
      lines.push(line)
      line = ' '
    }
    line += word
  }
  lines.push(line)
  return lines.join('\n')
}

export function commandHelp(command) {
  if (!SECTIONS[command]) return SHORT_HELP
  return `Usage: shapewall ${command} [options]\n\n${SECTIONS[command]}\n\n${GLOBAL_HELP}\n`
}
