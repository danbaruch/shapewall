# The sandboxed starter agent

`shapewall agent` takes one board comment at a time and works on it inside a container: it reads the request, edits files in a fresh
checkout of your repo (with no `.git` in it), runs your tests, replies on the comment and leaves the change on a new branch (and, if you ask, a pull request). It is
meant for **shared boards**, where the people writing comments are not all people you would hand a shell to.

The board chat ([agents.md](agents.md)) runs an agent _as you_, on your machine. The starter agent assumes the comment may be hostile and
puts walls around the agent instead: the container, an egress allow list, a fixed set of tools, a trigger gate, budgets and branch-only
output. This page says what each wall does and, as plainly, what it does not.

## Quick start

You need podman or docker, a git repo with a `shapewall.config.json`, and an OpenAI-compatible model endpoint (the same settings as the
chat: `agent.baseUrl` and `agent.model`, or `SHAPEWALL_AGENT_BASE_URL` and `SHAPEWALL_AGENT_MODEL`, with the key in
`SHAPEWALL_AGENT_API_KEY` or the variable `agent.apiKeyEnv` names).

1. Build the agent image once. It is built on your machine from the `Dockerfile.agent` that ships in the package, and never pulled
   or published:

   ```sh
   npx shapewall agent build-image      # --runtime podman|docker, --image NAME (default localhost/shapewall-agent:latest)
   ```

   It builds from a folder holding only what the image needs, with the locked dependency versions (npm never puts
   `package-lock.json` in a package, so the package carries a copy in `dist/agent/`). In a clone of the repository,
   `podman build -f Dockerfile.agent -t localhost/shapewall-agent:latest .` (or `docker build ...`) does the same by hand.

2. Say who may dispatch work, and how to test, in `shapewall.config.json`:

   ```json
   "starterAgent": {
     "trusted": ["robin", "sam"],
     "setupCommand": "npm ci",
     "testCommand": "npm test"
   }
   ```

3. Check the machine and the sandbox:

   ```sh
   npx shapewall agent doctor
   ```

   The doctor starts a container exactly like the agent's (same network, proxy, mounts, user and limits) with a probe in place of the
   agent, and reports each check: not root, no capabilities, no new privileges, read-only root, only the checkout mounted, no home
   folder, SSH keys or runtime socket, no host environment, no direct egress or outside DNS, no way to this machine's own ports, and a
   proxy that refuses hosts off the list and TLS names other than the allowed one.

   `agent run` and `agent watch` start by removing what runs that died left behind (containers, networks and checkout folders whose
   owner process is gone).

4. Run it on a comment, or watch the board:

   ```sh
   npx shapewall agent run --comment 12
   npx shapewall agent watch            # every comment the gate lets through; --once to drain and exit
   ```

The reply on the comment says what changed, the branch, the tests, anything the proxy blocked, and the budget used, for example
`Budget: 6 of 20 turns, 41,200 of 200,000 tokens, 2m 14s of 15m.` The comment's agent status ends as `done` or `needs-human`.

## The trigger gate

Anyone who can comment can write text the agent will act on, so a comment is dispatched only when a trusted member stands behind it:

- a **share link guest's** comment (`authorGuest`) is never dispatched, whoever tags it later, and guest replies are left out of the
  task;
- a comment **written by an agent** is never dispatched, so agents do not feed each other;
- a **trusted member's** own comment is dispatched;
- anyone else's comment **waits** until a trusted member replies with `@agent`. The tag vouches for the text as it was: if the comment
  is edited after the tag, it waits for a new one.

`starterAgent.trusted` is the default list; `starterAgent.boards.<id>.trusted` replaces it for one board; `--trusted NAME` adds to it for
one run. An empty list dispatches nothing. `--trust-comment` runs one comment the gate holds back (never a guest's or an agent's).

Who counts as a member depends on the board:

- **Hosted boards** (`--remote`): the account handle the server attests (`authorHandle`, `reply.handle`). Display names never count.
- **Local boards**: the author name as typed. A local board has no accounts, so this is only as strong as who can reach the board. On
  a board shared through a proxy, anyone who can comment can type a trusted name: put real authentication in front (see
  [deployment.md](deployment.md)) or use a hosted board.

A comment is claimed with a compare-and-set on its agent status, so two runs never take the same comment. `--retry` takes one whose
status is `done` or `needs-human`.

## What the agent can do

A fixed set of tools, nothing else:

| Tool                                | What it does                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `list_files`, `read_file`, `search` | Read the checkout. `.git` is refused.                                                                                       |
| `write_file`, `edit_file`           | Change files in the checkout. Paths are resolved after symlinks; anything outside the checkout, or in `.git`, is refused.   |
| `run_tests`                         | Runs `starterAgent.testCommand` (no shell), only when one is set. Needs your approval after the agent changed what it runs. |
| `capture`                           | `shapewall capture --only <page>` in the checkout. Offered only when the site is reachable from the sandbox (see below).    |
| `reply`, `set_status`               | Up to 3 replies on the comment (2,000 characters each), and its agent status.                                               |
| `run_shell`                         | Any command, but only after you approve that exact command on the board (local boards only, see below).                     |

`starterAgent.setupCommand` (for example `npm ci`) runs once before the agent starts, in the container, with the package registry
reachable.

Paths are relative to the repo root. Models often write the container's mount point into them, so `/work/src/app.js`, and
`work/src/app.js` when the repo has no top-level `work`, both mean `src/app.js`. A path that does not exist answers
`path not found: <path>; paths are relative to the repo root`, for reads, listings, searches and edits alike.

`capture` is offered only when the board's `baseUrl` can be reached from the sandbox: its host and port must be on the egress allow list
(`--allow-host`), and it must not be this machine (`localhost`, `127.0.0.1`: in the container that is the container itself) or a
private address you did not allow. A dev server on your machine is not reachable, by design, so with the usual
`http://127.0.0.1:...` baseUrl the agent has no `capture` tool and its prompt says it cannot see the site. If it calls `capture` anyway,
or a capture cannot connect, the answer is `capture is unavailable in the sandbox; skip it`.

### Tests run the agent's code

Be plain about this: `run_tests` runs your test command over files the agent may have just changed, so a test is code the agent wrote,
and it runs with everything the sandbox allows. The walls around the container are what limit it, not the tool list. The approval of
`run_shell` happens inside the agent's own process (the host shows the card and waits for you; the container asks), so it limits what the
model can do through the tools, not what code already running in the sandbox can do.

One rule narrows it: once the agent changed a file that decides what the test command runs (a manifest or lockfile, `.npmrc`, a test,
build or TypeScript config, `Makefile`, `justfile`, `pyproject.toml` and the like, or a file the test command names), or ran an approved
shell command, `run_tests` asks for your approval on the board like `run_shell` does, and is not run where there are no approvals.

### Approving shell commands

When the agent asks for `run_shell`, the comment's chat thread on the board shows a permission card with the exact command and the
agent's reason. The terminal running `agent run` prints the command and a link that opens the board on the comment with its chat
thread (the running `shapewall serve`'s own address when it recorded one, else `SHAPEWALL_BOARD_URL`, `notifications.boardUrl` or the
default). **Run** runs that command once; **Deny**, or no answer within two minutes, is a no. The card can only be answered from
the board on this machine: the request needs the settings token from the link `shapewall serve` prints, must be a direct local request,
same-origin, on a board that is not shared. Nobody at the board means no answer, which is a no. On hosted boards (`--remote`) `run_shell`
is not offered at all.

## Budgets

Each comment gets a budget of model turns, tokens and wall time (defaults 20 turns, 200,000 tokens, 15 minutes; at most 100, 2,000,000 and
120). Set them in `starterAgent.budget` or per run with `--max-turns`, `--max-tokens` and `--max-minutes`.

They are enforced on the host, not by the agent: every model call goes through Shapewall on the host, one at a time, which refuses calls
past the turn or token budget, reserves each call's prompt (estimated at four characters a token) and caps its `max_tokens` at what is
left after that. Tokens are counted from the usage the endpoint reports (or estimated
at four characters a token, and the reply says "estimated"). At the wall time the host asks the agent to stop, and kills the container a
few seconds later. The reply always reports what was used.

Each model call has a time limit to start answering (its response headers): 180 seconds until the model first answers in a run (a
local model loading on a cold start can take minutes), 60 seconds after. `starterAgent.modelTimeoutSeconds` or `--model-timeout SECONDS`
(1 to 900) sets both. A call that times out or cannot connect is tried once more, as the same turn, within the wall time; if that fails
too, the run stops with one plain line, such as `Stopped: the model endpoint failed (could not reach it: timed out after 180 s).`

The checkout has a disk cap too (`starterAgent.limits.disk` or `--max-disk`, default `2g`, at most `64g`): a bind mount has no size limit
of its own on podman or docker, so the host measures the folder every few seconds (`du`, one file system, no symlink followed) and
kills the container as soon as it is over. Nothing is committed then, and the reply says how much it took. `/tmp` in the container is a
tmpfs with its own size (`limits.tmp`, default `1g`).

## Output: a branch, never main

The change is committed on a new branch, `shapewall-agent/<board>-<comment>-<id>` (prefix from `starterAgent.branchPrefix`), authored
`Shapewall starter agent <starter-agent@shapewall.invalid>`, with `shapewall:<board>/<comment>` in the message so
[GitHub connect](github.md) links it. Branch names that are, or end in, `main`, `master`, `trunk`, `develop`, `production`, `staging`
or `release` are refused, for the branch and for the push, and the branch is only created if it does not exist.

The commit is made without trusting anything in the folder the container had. That folder has no `.git` (an agent that writes one
changes nothing), and git on the host always names your repository explicitly, with a temporary index outside the folder, no system
config, and hooks, fsmonitor and signing off. Shapewall reads the changed files itself, without following a symlink anywhere in a path
(a symlink is committed as a symlink) and refusing hard-linked files, and writes them with `git hash-object --no-filters`, so no clean
filter, attribute or config from the agent's files runs. `.gitattributes` and `.gitmodules` keep the base's version, and submodules are
left as they were. The reply calls out changes to dot files, package manifests, `Makefile`, `Dockerfile`, `justfile` and
`shapewall.config.json`.

`--pr` also pushes the branch to `--git-remote NAME` (default `origin`, explicit refspec, `--no-verify`) and opens a pull request into
`starterAgent.prBase` (default: the remote's default branch) through GitHub connect, then links it to the comment. The token is GitHub
connect's (`SHAPEWALL_GITHUB_TOKEN` or `GITHUB_TOKEN`) and never enters the container. Nothing is ever pushed to main.

A pushed branch runs CI with the repository's secrets before anyone reviews it. So `--pr` does not push a change to CI config
(`.github/`, `.gitlab-ci.yml`, `.circleci/` and the like), dependency manifests and lockfiles, or build and task files (`Makefile`,
`Dockerfile`, ...): the branch stays local and the reply says why. `--allow-ci-push` pushes it anyway, for that run. Better still, pass
`--fork-remote NAME` with a git remote of your fork: the branch goes there and the pull request comes from
`<owner>:<branch>`, so the main repository's workflows treat it as a fork's (no secrets, unless a workflow uses `pull_request_target`; the CI-file rule above still applies). Even a change to plain source files can do
harm in a job that runs tests with secrets on push to any branch: prefer a fork, or CI that gives branch pushes no secrets.

The checkout lives under `~/.cache/shapewall/starter-agent/` (or `--work-dir`) and is removed after the run; the branch stays.

A run that only added new files and changed no existing one says so in the reply ("check it edited the right place"): a small model
that cannot find the file behind a page often makes a new one the site never uses.

The run's log is kept next to the board (`<board>/agent/starter-<comment>-<run>.log`, hosted runs: in the work folder). It starts with
a line naming the comment, model, endpoint host and budget, and ends with the outcome (status, why it stopped, the branch, the budget
used), failures and timeouts included. In between: which tools were offered, each turn's answer text (up to 4,000 characters a turn),
each tool call with its arguments (long values cut) and result, every approval asked and answered with the command's text and its
SHA-256, model endpoint retries, egress refusals and the container's stderr. The key is removed from every line, and no request header
is logged.

## Configuration

`starterAgent` in `shapewall.config.json` (usually committed) may only choose what stays inside the sandbox:

| Key                   | Default                                            | Notes                                                    |
| --------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| `trusted`             | `[]`                                               | Who may dispatch work, on every board.                   |
| `boards.<id>.trusted` |                                                    | Replaces `trusted` for one board.                        |
| `testCommand`         | none                                               | One program and its arguments, no shell.                 |
| `setupCommand`        | none                                               | Runs once before the agent, with the registry reachable. |
| `budget`              | `{ turns: 20, tokens: 200000, minutes: 15 }`       |                                                          |
| `modelTimeoutSeconds` | 180 for the first call, then 60                    | Time for a model call to start answering, 1 to 900.      |
| `limits`              | `{ memory: "4g", cpus: 2, pids: 512, disk: "2g" }` | Memory up to `16g`, CPUs up to 8, disk up to `64g`.      |
| `branchPrefix`        | `shapewall-agent/`                                 | Lowercase, ending in `/`.                                |
| `prBase`              | the remote's default branch                        | The base branch of `--pr`.                               |

What decides what leaves the sandbox comes only from you, never from the repo: a config with `image`, `runtime`, `registry`, `egress`,
`allowHosts`, `network`, `apiKey`, `env` or `mounts` under `starterAgent` is refused, and so is `remote` or `forkRemote` (where the
branch is pushed is a flag: `--git-remote`, `--fork-remote`).

| Flag                       | Environment                                | What                                                                                                   |
| -------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `--runtime`                | `SHAPEWALL_AGENT_RUNTIME`                  | `podman` or `docker` (default: whichever is installed, podman first).                                  |
| `--image`                  | `SHAPEWALL_AGENT_IMAGE`                    | Default `localhost/shapewall-agent:latest`.                                                            |
| `--registry HOST`, `none`  | `SHAPEWALL_AGENT_REGISTRY`                 | Default `registry.npmjs.org:443`.                                                                      |
| `--allow-host HOST[:PORT]` | `SHAPEWALL_AGENT_EGRESS` (comma-separated) | Extra egress hosts (port 443 if none given).                                                           |
| `--profile`                |                                            | `openai-compatible` (the default). `claude-code` and `codex` are reserved and say "not available yet". |
| `--max-disk SIZE`          |                                            | The disk cap on the checkout for this run (default `2g`).                                              |
| `--model-timeout SECONDS`  |                                            | Time for a model call to start answering, 1 to 900 (overrides `starterAgent.modelTimeoutSeconds`).     |
| `--work-dir`               |                                            | Where checkouts go.                                                                                    |
| `--allow-ci-push`          |                                            | With `--pr`: push even when the change touches CI config, manifests or build files.                    |
| `--git-remote NAME`        |                                            | With `--pr`: the remote to push to (default `origin`).                                                 |
| `--fork-remote NAME`       |                                            | With `--pr`: push to this remote (your fork) and open the pull request from it.                        |
| `--remote URL`             |                                            | A hosted board instead of the local one (`run` and `watch`).                                           |

The model endpoint and key follow the chat's rules ([agents.md](agents.md)): a config cannot send your key to a host you did not
confirm. The starter agent always uses the OpenAI-compatible endpoint, never the chat's ACP agent.

## Threat model

The starting assumption: the comment, the page text and the repo can all be hostile, and the model may do whatever they talk it into.

### The container

Every run gets its own network and two containers, both from the local image (`--pull never`):

- **The agent container:** on the run's internal network (no route out, no outside DNS). The fresh checkout is mounted read-write at
  `/work`, and nothing else: not your home folder, SSH keys, browser profile, the docker or podman socket, or your repository's `.git`
  (the checkout has none). It runs as your
  uid (never root; `--userns keep-id` on podman), with a read-only root file system and a small `/tmp`, every capability dropped,
  `no-new-privileges`, memory, CPU and process limits, and an environment of a few fixed names: no host variable, and no key. The
  agent is the container's first process (no init) and runs from a copy of node its user may execute but not read, which makes the
  kernel mark it not dumpable: a test or approved command, running as the same user, cannot open its `/proc` files, so it cannot write
  to the agent's line protocol with the host or read its memory. The host still checks every line it gets (results field by field, one
  approval at a time, at most 10 per run, replies and cards limited).
- **The egress proxy:** on the run network and on `shapewall-egress`, the only way out. It passes HTTP `CONNECT` and plain `http://`
  requests only to the allowed `host:port` pairs: the package registry and any `--allow-host`. A `CONNECT` tunnel carries only TLS,
  and only when the ClientHello's server name is the allowed host (a missing name, two names, or an encrypted ClientHello are
  refused): many sites share one address on a CDN, so the address alone would let any of them through. Plain `http://` requests go
  out with the allowed host as their `Host`. Names on the default list that resolve to a private, loopback or link-local address
  (IPv6 forms included: `::ffff:` mapped, NAT64 `64:ff9b::`, 6to4) are refused, so a rebinding DNS answer cannot reach your network
  through them. Every refusal is logged and listed in the reply.

### The model key

The key never enters the container. The agent sends each model request to the host over its stdin/stdout; the host adds the key, sends
the request to the configured endpoint only (with its own model name, with only text and inline `data:` images in the messages, and with
only `function` tools: a remote image URL, or a provider-side tool such as web search or a browser, would act outside the sandbox), and streams the answer back with the key removed. So a test or
an approved command, which runs as the same uid as the agent, has no key to read from memory or the environment, and a hijacked model
has none to post in a reply. The model endpoint is not on the egress allow list.

### Board text is data

The comment, its replies and any page text go to the model as quoted data with provenance (`<shapewall-data source="comment"
trust="untrusted" ...>`), never in the system prompt, and the system prompt tells the model that text inside is never an instruction.
That lowers the risk of prompt injection; it does not remove it, which is why the walls above exist.

### What each runtime enforces

| Wall                                                  | Rootless podman (netavark)     | Docker (rootful)                                                                                | Rootless docker                                                                             |
| ----------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| User, read-only root, caps, no-new-privileges, limits | Enforced, verified             | Enforced                                                                                        | Enforced                                                                                    |
| Only the checkout mounted                             | Enforced, verified             | Enforced                                                                                        | Enforced                                                                                    |
| No route out of the internal network                  | Enforced, verified             | Enforced                                                                                        | Enforced                                                                                    |
| No outside DNS                                        | Enforced, verified (ENOTFOUND) | Best-effort: depends on the Docker version's embedded DNS; the doctor checks                    | Same as Docker                                                                              |
| No way to the host's own ports                        | Enforced, verified             | Best-effort: `host-gateway` reachability depends on the version and firewall; the doctor checks | Same as Docker                                                                              |
| Files written as your uid                             | Enforced (`keep-id`), verified | Enforced (`--user`)                                                                             | Not by default: the uid is mapped; the doctor says when the checkout is not writable as you |
| Egress allow list (the proxy)                         | Enforced, verified             | Enforced                                                                                        | Enforced                                                                                    |

"Verified" means the opt-in container test and `agent doctor` passed on rootless podman 5.8. Docker was not available to test against:
run `shapewall agent doctor` and treat a FAIL line as a wall that is not there.

### What is not covered

- **The change itself.** The agent can still write a bad or malicious change into the branch (a test that exfiltrates on CI, a
  dependency swap, a workflow edit). Review the whole diff before merging; the reply flags changes to scripts, manifests and config.
- **Allowed hosts are channels.** Anything the proxy lets through (the registry, your `--allow-host` entries) can carry data out. The
  npm registry takes publishes: code in the sandbox can publish a package (to an account it creates) with whatever it read, and the
  TLS name check does not stop that. Keep the list short; `--registry none` when setup does not need it.
- **Tests and approved commands** run code the agent may have written (see [Tests run the agent's code](#tests-run-the-agents-code)).
- **What your model provider sees**: the comment, the files the agent reads, and the tool output.
- **Local author names are not authenticated** (see [The trigger gate](#the-trigger-gate)).
- **Commands you approve** run in the sandbox with the same walls as the agent, but they run: read them.
- **`capture`** works only for a site the sandbox can reach, and is not offered otherwise. A dev server on your machine is not
  reachable, by design.
- **The `claude-code` and `codex` profiles** are reserved names, not implementations: those CLIs would need their own login inside the
  sandbox, which this version does not do.
- **Container escapes** through kernel or runtime bugs. Keep podman or docker up to date.

### Hosted boards

Run the starter on your own machine with a local repository and configuration:
`shapewall agent run --remote https://board.example --board site --comment 12`.
Supply the project token through `SHAPEWALL_TOKEN`, a protected token file, or
`shapewall login`; it needs `read,reply,status,claim`. Hosted trust comes only
from the server's Agent policy and hash-bound Send to agent action. Local
`starterAgent.trusted`, `--trusted` and `--trust-comment` cannot bypass it.
Guest and agent comments never start work; imports require a trusted vouch.

Shell requests create permission cards at the top of the hosted board. A
trusted admin checks the exact command and approves once with a fresh passkey.
No answer within two minutes means no execution. Editing the comment, ending
the claim, changing policy, or losing token authority invalidates the card.
The hosted server never executes the command; the developer's sandbox does.

`--pr` also works with a hosted source when the local repository has GitHub
connect configured. The existing push guard still blocks CI/workflow-sensitive
changes unless explicitly allowed by the runner. The GitHub credential remains
on the runner; it is never uploaded with the board or given to the sandbox.
Comments and captures are untrusted text. A shell-capable agent with a readable
token remains a prompt-injection risk: read [agent-hardening.md](agent-hardening.md)
and keep both server claim budgets and per-run turns/tokens/minutes limits.
