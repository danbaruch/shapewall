// The container runtime for the starter agent: docker or podman, and the
// exact arguments every container is started with.
//
// Two containers per run, on a network made for that run:
//
//   agent container  --network <run network> (internal: no route out, no
//                    outside DNS); the fresh worktree mounted read-write at
//                    /work and nothing else; the host user's uid (never root),
//                    read-only root file system, every capability dropped,
//                    no-new-privileges, memory / CPU / process limits, and an
//                    environment of a few fixed names (no host variable, no
//                    key: model calls go through the host). Proxy variables
//                    point at:
//   egress proxy     on the run network and on an ordinary one, passing on
//                    only the allowed host:port pairs (egress-proxy.js).
//
// Never mounted: the home folder, SSH keys, a browser profile, the docker
// or podman socket, the project's own .git. Images are never pulled
// (--pull never): the image is built on this machine (Dockerfile.agent).

import { spawn } from 'node:child_process'
import { findProgram } from '../../watch.js'
import { PROXY_PORT, formatAllowEntry } from './egress-proxy.js'

export const RUNTIMES = ['podman', 'docker']
export const RUNTIME_VAR = 'SHAPEWALL_AGENT_RUNTIME'
export const IMAGE_VAR = 'SHAPEWALL_AGENT_IMAGE'
export const DEFAULT_IMAGE = 'localhost/shapewall-agent:latest'
export const EGRESS_NETWORK = 'shapewall-egress'
export const WORK_DIR = '/work'
export const HOME_DIR = '/tmp/home'
export const RUN_LABEL = 'shapewall.agent.run'
// The pid of the shapewall process that made it: the startup sweep removes what dead runs left.
export const OWNER_LABEL = 'shapewall.agent.owner'
// The agent runs from an execute-only copy of node (not dumpable, see Dockerfile.agent).
export const AGENT_ENTRY = ['/opt/shapewall/node-agent', '/opt/shapewall/bin/shapewall.js', 'agent', 'sandbox']
export const PROXY_ENTRY = ['node', '/opt/shapewall/src/agent/starter/egress-proxy.js']
export const PROBE_ENTRY = ['node', '/opt/shapewall/src/agent/starter/probe.js']
// This machine, as a container reaches it (only for a person's --allow-host).
export const HOST_GATEWAY = { podman: 'host.containers.internal', docker: 'host.docker.internal' }

// disk: the cap on the mounted folder, measured by the host (disk.js).
export const DEFAULT_LIMITS = { memory: '4g', cpus: 2, pids: 512, tmp: '1g', disk: '2g' }
const MEMORY_RE = /^[1-9]\d{0,5}[mg]$/
const IMAGE_RE = /^[a-z0-9][a-z0-9._/:@-]{0,254}$/
const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{3,40}$/

// Which runtime: --runtime, then SHAPEWALL_AGENT_RUNTIME, then podman, then
// docker, whichever is on PATH. { name, bin } or { problem }.
export function detectRuntime({ flag = null, env = process.env, find = findProgram } = {}) {
  const wanted = flag || env[RUNTIME_VAR] || null
  if (wanted && !RUNTIMES.includes(wanted)) return { problem: `--runtime / ${RUNTIME_VAR}: podman or docker (got "${wanted}")` }
  for (const name of wanted ? [wanted] : RUNTIMES) {
    const bin = find(name, env)
    if (bin) return { name, bin }
  }
  return {
    problem: wanted
      ? `${wanted} is not on PATH`
      : 'neither podman nor docker is on PATH: install one (podman runs rootless by default) to use the starter agent',
  }
}

// The image: --image, then SHAPEWALL_AGENT_IMAGE. Never from the config: the
// proxy runs from the same image, so a repo that chose it could choose what
// leaves the sandbox.
export function agentImage({ flag = null, env = process.env } = {}) {
  const image = String(flag || env[IMAGE_VAR] || DEFAULT_IMAGE).trim()
  if (!IMAGE_RE.test(image)) throw new Error(`--image / ${IMAGE_VAR}: "${image.slice(0, 80)}" is not an image name`)
  return image
}

export function checkLimits(limits = {}) {
  const value = { ...DEFAULT_LIMITS, ...limits }
  if (!MEMORY_RE.test(String(value.memory))) throw new Error('memory: a size such as 2g or 1536m')
  if (!MEMORY_RE.test(String(value.tmp))) throw new Error('tmp: a size such as 1g')
  if (!MEMORY_RE.test(String(value.disk))) throw new Error('disk: a size such as 2g or 500m')
  if (!(Number(value.cpus) > 0 && Number(value.cpus) <= 16)) throw new Error('cpus: a number from 0.1 to 16')
  if (!(Number.isInteger(Number(value.pids)) && value.pids >= 32 && value.pids <= 4096)) throw new Error('pids: 32 to 4096')
  return value
}

// A bind mount source as -v takes it: no ":" or "," (they separate options).
function mountSource(dir) {
  if (/[:,\n]/.test(dir)) throw new Error(`the worktree path "${dir}" has ":" or ","; pick another --work-dir`)
  return dir
}

const names = (runId) => {
  if (!RUN_ID_RE.test(runId)) throw new Error('bad run id')
  return { network: `shapewall-agent-${runId}`, agent: `shapewall-agent-${runId}`, proxy: `shapewall-egress-${runId}` }
}
export const runNames = names

export function networkCreateArgs(runId, owner = process.pid) {
  return ['network', 'create', '--internal', '--label', `${RUN_LABEL}=${runId}`, '--label', `${OWNER_LABEL}=${owner}`, names(runId).network]
}

export function egressNetworkArgs() {
  return ['network', 'create', '--label', 'shapewall.agent.egress=1', EGRESS_NETWORK]
}

// The proxy container, created on the egress network (then connected to the
// run network, then started attached so its log lines reach us).
export function proxyCreateArgs({ runtime, runId, image, allow, owner = process.pid }) {
  const { proxy } = names(runId)
  const args = [
    'create',
    '--pull',
    'never',
    '--name',
    proxy,
    '--network',
    EGRESS_NETWORK,
    '--label',
    `${RUN_LABEL}=${runId}`,
    '--label',
    `${OWNER_LABEL}=${owner}`,
    '--user',
    '65534:65534',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    '256m',
    '--cpus',
    '0.5',
    '--pids-limit',
    '64',
    '--init',
    '--env',
    `SHAPEWALL_EGRESS_ALLOW=${allow.map(formatAllowEntry).join(',')}`,
    '--env',
    `SHAPEWALL_EGRESS_PORT=${PROXY_PORT}`,
  ]
  // Docker needs to be told the host's name; podman adds host.containers.internal itself.
  if (runtime === 'docker' && allow.some((entry) => entry.host === HOST_GATEWAY.docker)) {
    args.push('--add-host', `${HOST_GATEWAY.docker}:host-gateway`)
  }
  args.push(image, ...PROXY_ENTRY)
  return args
}

// The fixed environment of the agent container: where home and caches are,
// and the proxy. Nothing from the host.
export function agentEnv(runId) {
  const proxy = `http://${names(runId).proxy}:${PROXY_PORT}`
  return {
    HOME: HOME_DIR,
    TMPDIR: '/tmp',
    CI: '1',
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    NO_PROXY: '',
    no_proxy: '',
    // Node's fetch and http honour the proxy variables only with this.
    NODE_USE_ENV_PROXY: '1',
    npm_config_cache: '/tmp/npm-cache',
    npm_config_update_notifier: 'false',
    PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    SHAPEWALL_SANDBOX: '1',
  }
}

// The agent container. `uid`/`gid` are the host user's (the worktree's
// owner), so files the agent writes are yours; with podman, keep-id maps
// them one to one in a rootless user namespace.
// `loginVolume` (the claude-code and codex profiles, not available yet)
// would mount a named volume as the home folder for the CLI's login.
export function agentRunArgs({
  runtime,
  runId,
  image,
  worktree,
  uid,
  gid,
  limits = {},
  loginVolume = null,
  entry = AGENT_ENTRY,
  owner = process.pid,
}) {
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error('the host uid and gid are needed')
  if (uid === 0) throw new Error('refusing to run the starter agent as root: run shapewall as your own user')
  const limit = checkLimits(limits)
  const { network, agent } = names(runId)
  const args = [
    'run',
    '--rm',
    '-i',
    '--pull',
    'never',
    '--name',
    agent,
    '--hostname',
    'shapewall-agent',
    '--network',
    network,
    '--label',
    `${RUN_LABEL}=${runId}`,
    '--label',
    `${OWNER_LABEL}=${owner}`,
  ]
  if (runtime === 'podman') args.push('--userns', 'keep-id')
  args.push(
    '--user',
    `${uid}:${gid}`,
    '--read-only',
    '--tmpfs',
    `/tmp:rw,nosuid,nodev,size=${limit.tmp}`,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    limit.memory,
    '--memory-swap',
    limit.memory,
    '--cpus',
    String(limit.cpus),
    '--pids-limit',
    String(limit.pids),
    '--shm-size',
    '256m',
    '--ipc',
    'private',
    // No --init: the agent itself is pid 1. An init process would hold the
    // line protocol's stdout too, and unlike the agent (see Dockerfile.agent)
    // anything running as the same user could open it through /proc.
    '--stop-timeout',
    '5',
    '-v',
    `${mountSource(worktree)}:${WORK_DIR}:rw,Z`,
  )
  if (loginVolume) {
    if (!/^shapewall-agent-[a-z-]{1,40}$/.test(loginVolume)) throw new Error('bad login volume name')
    args.push('-v', `${loginVolume}:/home/agent:rw`)
  }
  args.push('--workdir', WORK_DIR)
  for (const [name, value] of Object.entries(agentEnv(runId))) args.push('--env', `${name}=${value}`)
  args.push(image, ...entry)
  return args
}

// A thin wrapper around the runtime's CLI. `exec` runs one command and
// collects its output; `spawn` starts a long one (the containers). The CLI
// itself gets the host environment it needs to find its socket or rootless
// state (XDG_RUNTIME_DIR, DOCKER_HOST, ...); containers do not.
export function createRuntime({ name, bin, env = process.env, spawnImpl = spawn }) {
  const childEnv = { ...env }
  return {
    name,
    bin,
    exec(args, { input = null, timeoutMs = 60000 } = {}) {
      return new Promise((resolve) => {
        let child
        try {
          child = spawnImpl(bin, args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true })
        } catch (error) {
          resolve({ code: null, stdout: '', stderr: error.message })
          return
        }
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
        child.stdout.on('data', (chunk) => (stdout = (stdout + chunk).slice(-200000)))
        child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-20000)))
        child.stdin.on('error', () => {})
        child.stdin.end(input ?? undefined)
        child.once('error', (error) => {
          clearTimeout(timer)
          resolve({ code: null, stdout, stderr: stderr || error.message })
        })
        child.once('close', (code) => {
          clearTimeout(timer)
          resolve({ code, stdout, stderr })
        })
      })
    },
    spawn(args) {
      return spawnImpl(bin, args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true })
    },
  }
}
