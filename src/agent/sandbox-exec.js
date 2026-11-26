// The OS sandbox every command of a fix runs in on solo and team turns
// (plan section 3.5): bubblewrap on Linux and Seatbelt on macOS, through the
// open-source sandbox runtime (@anthropic-ai/sandbox-runtime, pinned to an
// exact version in package.json: it is a 0.0.x preview, and the escape
// tests in test/sandbox-exec.test.js run again on every bump). Windows has
// none here (the runtime's Windows mode needs an admin install of a sandbox
// account, which Shapewall does not do): commands there wait for a card
// each and run without any shell (resolveArgv).
//
// What a command inside sees:
//   writable   the fix copy and a per-session temp folder, nothing else
//   readable   the system (read only, as srt mounts it), the fix copy, the
//              session temp, the toolchain Node runs from and srt's own
//              helper binaries. Never the home folder: not ~/.ssh,
//              ~/.config, ~/.claude, credentials, the real checkout.
//   network    nothing but what the session allows, through srt's proxies:
//              the package registries by default (`shellNetwork`
//              "registries"), any public host ("open"), or none ("none");
//              plus the session's own dev server, as 127.0.0.1:<port>
//              exactly, never 127.0.0.1 without a port (that would open the
//              Shapewall server and every other local port)
//   unix sockets  none (srt's seccomp filter on Linux)
//
// Honest limit: the sandbox limits what a command touches, not what it
// does. The code being run is code the agent wrote (or changed). And the
// sandbox sees /etc and the other system folders read only, so
// world-readable host config is visible to commands.
//
// One SandboxManager per process (the runtime keeps one), started on first
// use. Each session keeps its own folders and its own network list: the
// list is registered per command under an unguessable id (srt
// registerCommandNetworkLists), so two sessions of one process never share
// what they may reach.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'

const require = createRequire(import.meta.url)

// Package registries a command may reach by default (HTTPS only).
export const REGISTRY_HOSTS = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'index.crates.io',
  'static.crates.io',
  'proxy.golang.org',
  'sum.golang.org',
  'rubygems.org',
  'index.rubygems.org',
]

export const SANDBOX_LIMITS = {
  outputBytes: 64 * 1024,
  timeoutMs: 10 * 60 * 1000,
  timeoutMaxMs: 30 * 60 * 1000,
}

export class SandboxRefusal extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const realpath = (target) => fs.realpathSync.native(target)
const isInside = (parent, child) => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// The folder of srt's own helper binaries (apply-seccomp, the macOS
// helpers). It must stay readable inside the sandbox: when Shapewall runs
// from npx or a global install under the home folder, a denied home would
// otherwise hide them and no sandbox would start (spike S2).
export function runtimeVendorDir() {
  try {
    return path.join(path.dirname(path.dirname(require.resolve('@anthropic-ai/sandbox-runtime'))), 'vendor')
  } catch {
    return null
  }
}

// A program on PATH (absolute entries only), or null.
function onPath(name, env) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue
    const file = path.join(dir, name)
    try {
      fs.accessSync(file, fs.constants.X_OK)
      if (fs.statSync(file).isFile()) return file
    } catch {
      /* next */
    }
  }
  return null
}

let probed = null
// Whether this machine can run commands in the OS sandbox: { available,
// reason }. Linux: bubblewrap and socat installed, and bubblewrap can make
// its namespaces here (Ubuntu's AppArmor can forbid it, so it is tried).
// macOS: sandbox-exec. Anything else: no. Asked once per process; every
// turn and the hello summary read the same answer (capabilities.js
// hostPlatform).
export function probeSandbox({ platform = process.platform, env = process.env, run = spawnSync, fresh = false } = {}) {
  if (probed && !fresh && platform === process.platform) return probed
  let result
  if (!runtimeVendorDir()) result = { available: false, reason: 'runtime_missing' }
  else if (platform === 'linux') {
    const bwrap = onPath('bwrap', env)
    if (!bwrap) result = { available: false, reason: 'bwrap_missing' }
    else if (!onPath('socat', env)) result = { available: false, reason: 'socat_missing' }
    else {
      const tried = run(bwrap, ['--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', 'true'], {
        stdio: 'ignore',
        timeout: 10_000,
      })
      result = tried.status === 0 ? { available: true, reason: null } : { available: false, reason: 'bwrap_blocked' }
    }
  } else if (platform === 'darwin')
    result = fs.existsSync('/usr/bin/sandbox-exec') ? { available: true, reason: null } : { available: false, reason: 'seatbelt_missing' }
  else result = { available: false, reason: 'platform' }
  if (platform === process.platform) probed = result
  return result
}

// ---- Programs without a shell (every platform) ----

// argv as it is spawned, without any shell, ever. On Windows a `.cmd` or
// `.bat` shim would go through cmd.exe whatever spawn is told (BatBadBut),
// so it is never run: `npm` and `npx` become node plus npm's own script
// beside this Node, `node` is this Node, and any other program must be an
// .exe or .com on PATH. -> argv, or throws SandboxRefusal.
export function resolveArgv(argv, { platform = process.platform, env = process.env, execPath = process.execPath } = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some((part) => typeof part !== 'string' || part.includes('\0')))
    throw new SandboxRefusal('bad_command', 'Not a command.')
  if (platform !== 'win32') return [...argv]
  const [program, ...rest] = argv
  const name = program.toLowerCase().replace(/\.(cmd|bat|exe)$/, '')
  if (name === 'node') return [execPath, ...rest]
  if (name === 'npm' || name === 'npx') {
    const script = path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', `${name}-cli.js`)
    if (!fs.existsSync(script))
      throw new SandboxRefusal(
        'no_npm',
        `${name} was not found beside this Node (${path.dirname(execPath)}), and its .cmd shim is never run.`,
      )
    return [execPath, script, ...rest]
  }
  if (/\.(cmd|bat)$/i.test(program))
    throw new SandboxRefusal(
      'shim',
      'A .cmd or .bat program runs through cmd.exe, so Shapewall does not run it. Name node plus the script.',
    )
  if (/[\\/]/.test(program)) {
    if (!/\.(exe|com)$/i.test(program)) throw new SandboxRefusal('shim', `${program}: only an .exe or .com program runs here.`)
    return [program, ...rest]
  }
  const dirs = String(env.PATH || env.Path || '')
    .split(';')
    .filter((dir) => dir && path.win32.isAbsolute(dir))
  for (const dir of dirs) {
    for (const ext of ['.exe', '.com']) {
      const file = path.win32.join(dir, program.endsWith(ext) ? program : `${program}${ext}`)
      if (fs.existsSync(file)) return [file, ...rest]
    }
    for (const ext of ['.cmd', '.bat'])
      if (fs.existsSync(path.win32.join(dir, `${program}${ext}`)))
        throw new SandboxRefusal('shim', `${program} is a ${ext} shim, which runs through cmd.exe. Shapewall does not run it.`)
  }
  throw new SandboxRefusal('not_found', `${program} was not found on PATH (an .exe or .com).`)
}

// POSIX single quoting: the shell inside the sandbox reads exactly argv.
export const shellQuote = (part) => `'${String(part).replace(/'/g, `'\\''`)}'`

// ---- Environment ----

// The small environment of a command: where programs are, the locale, and
// the session's own home, temp and package caches. Never Shapewall's own
// variables but the agent mark, never the person's tokens or settings
// (the agent's environment rules, acp/command.js agentEnv, are narrower
// still here: no HOME, no XDG folders, no proxies of the person's).
export function commandEnv({ env = process.env, tmp, extra = {} }) {
  const out = {}
  for (const name of ['PATH', 'LANG', 'LANGUAGE', 'TZ', 'SystemRoot', 'windir', 'PATHEXT', 'COMSPEC'])
    if (typeof env[name] === 'string') out[name] = env[name]
  for (const [name, value] of Object.entries(env)) if (name.startsWith('LC_') && typeof value === 'string') out[name] = value
  const home = path.join(tmp, 'home')
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  Object.assign(out, {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CACHE_HOME: path.join(tmp, 'cache'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    npm_config_cache: path.join(tmp, 'npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    CI: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
    // What runs here is an agent's (src/agent-run.js).
    SHAPEWALL_AGENT_RUN: '1',
    ...extra,
  })
  return out
}

// ---- Running one command ----

function collect(stream, budget, sink) {
  stream?.on('data', (chunk) => {
    if (budget.left <= 0) {
      budget.cut += chunk.length
      return
    }
    const take = chunk.subarray(0, budget.left)
    budget.left -= take.length
    budget.cut += chunk.length - take.length
    sink.push(take)
  })
}

// Spawns argv (already wrapped or not) in its own process group and waits.
// -> { code, signal, output, cut, timedOut, stopped, ms }
export function runProcess(argv, { cwd, env, timeoutMs = SANDBOX_LIMITS.timeoutMs, outputBytes = SANDBOX_LIMITS.outputBytes, signal = null, onStart = () => {} }) {
  return new Promise((resolve) => {
    const began = Date.now()
    let child
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
    } catch (error) {
      resolve({ code: null, signal: null, output: `Could not start: ${error.message}`, cut: 0, timedOut: false, stopped: false, ms: 0 })
      return
    }
    const parts = []
    const budget = { left: outputBytes, cut: 0 }
    collect(child.stdout, budget, parts)
    collect(child.stderr, budget, parts)
    let timedOut = false
    let stopped = false
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        /* gone */
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)
    const onAbort = () => {
      stopped = true
      kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    onStart({ child, kill })
    const done = (code, sig, error = null) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // The group too: a command that left children behind does not keep them.
      kill()
      resolve({
        code,
        signal: sig,
        output: (error ? `Could not start: ${error.message}\n` : '') + Buffer.concat(parts).toString('utf8'),
        cut: budget.cut,
        timedOut,
        stopped,
        ms: Date.now() - began,
      })
    }
    child.once('error', (error) => done(null, null, error))
    child.once('close', (code, sig) => done(code, sig))
  })
}

// ---- Sessions ----

let manager = null
let starting = null
async function sandboxManager() {
  if (manager) return manager
  starting ||= (async () => {
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime')
    const vendor = runtimeVendorDir()
    // The process-wide base: no network (each command brings its list), no
    // writes, the home folder unreadable. Each command's own folders come
    // with the command (customConfig).
    await SandboxManager.initialize({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [os.homedir()], allowRead: vendor ? [vendor] : [], allowWrite: [], denyWrite: [] },
    })
    manager = SandboxManager
    return manager
  })()
  try {
    return await starting
  } catch (error) {
    starting = null
    throw error
  }
}

// Stops the runtime's proxies and helpers (its socat bridges keep a process
// alive): at the end of `agent connect`, and in tests.
export async function closeSandbox() {
  const was = manager || (starting ? await starting.catch(() => null) : null)
  manager = null
  starting = null
  if (was) await was.reset().catch(() => {})
}

// What a session's commands may reach, as srt host patterns.
export function networkList(network, ports = []) {
  const list = network === 'open' ? ['*'] : network === 'registries' ? REGISTRY_HOSTS.map((host) => `${host}:443`) : []
  for (const port of ports) if (Number.isInteger(port) && port > 0 && port < 65536) list.push(`127.0.0.1:${port}`, `localhost:${port}`)
  return list
}

// The folders Node and its tools run from, when they are in the home
// folder (nvm, volta, fnm): readable, never writable.
function toolchainDirs(home) {
  const out = []
  const node = path.dirname(path.dirname(process.execPath))
  if (isInside(home, node) && node !== home) out.push(node)
  return out
}

// One session of sandboxed commands for one fix copy.
//   root      the fix copy: the one writable folder of the project. Refused
//             when it is not `expect` (the fix copy the caller made), is
//             the home folder or holds it, is inside `checkout` (the
//             person's real project), or is the system root.
//   network   "registries" | "open" | "none"
//   readOnly  the copy is mounted read only too (hosted chat's QA commands
//             that do not change files)
//   mode      "sandboxed" (srt), "host" (no OS sandbox: only after a card
//             each, without a shell; the open tier's model), or "host-shell"
//             (--shell-unsandboxed: solo only, the owner's loud choice)
export async function createCommandSession({
  root,
  expect,
  checkout = null,
  // The folder Shapewall keeps its fix copies in: the root must be inside it.
  within = null,
  network = 'none',
  readOnly = false,
  mode = 'sandboxed',
  readPaths = [],
  tmpParent = os.tmpdir(),
  env = process.env,
  denyRead = [],
  log = () => {},
}) {
  if (!root || !expect || !path.isAbsolute(root)) throw new SandboxRefusal('bad_root', 'The sandbox needs the fix copy as its folder.')
  let real
  try {
    real = realpath(root)
    if (realpath(expect) !== real) throw new Error('not the fix copy')
  } catch {
    throw new SandboxRefusal('bad_root', 'The sandbox starts only in the fix copy Shapewall made for this turn.')
  }
  const home = (() => {
    try {
      return realpath(os.homedir())
    } catch {
      return os.homedir()
    }
  })()
  if (real === path.parse(real).root || isInside(real, home))
    throw new SandboxRefusal('bad_root', 'The sandbox never gets the home folder, or a folder that holds it, as its writable folder.')
  if (within) {
    let parent = within
    try {
      parent = realpath(within)
    } catch {
      throw new SandboxRefusal('bad_root', 'The sandbox starts only inside the folder Shapewall keeps fix copies in.')
    }
    if (parent === real || !isInside(parent, real))
      throw new SandboxRefusal('bad_root', 'The sandbox starts only inside the folder Shapewall keeps fix copies in.')
  }
  if (checkout) {
    let project = checkout
    try {
      project = realpath(checkout)
    } catch {
      /* gone: compared as given */
    }
    if (isInside(project, real) || isInside(real, project))
      throw new SandboxRefusal('bad_root', "The sandbox never writes in the person's own checkout.")
  }
  if (!['sandboxed', 'host', 'host-shell'].includes(mode)) throw new SandboxRefusal('bad_mode', 'Unknown sandbox mode.')
  const tmp = fs.mkdtempSync(path.join(tmpParent, 'shapewall-cmd-'))
  fs.chmodSync(tmp, 0o700)
  const ports = new Set()
  // commandId -> network list, for the commands that run now.
  const live = new Map()
  const vendor = runtimeVendorDir()
  const boxed = mode === 'sandboxed'
  const box = boxed ? await sandboxManager() : null
  const filesystem = () => ({
    denyRead: [home, ...denyRead],
    allowRead: [real, tmp, ...toolchainDirs(home), ...(vendor ? [vendor] : []), ...readPaths.filter((dir) => path.isAbsolute(dir))],
    allowWrite: readOnly ? [tmp] : [real, tmp],
    denyWrite: [],
  })
  const list = () => networkList(network, [...ports])
  let closed = false

  // argv (no shell) or { shell: "..." } (the solo full shell). -> runProcess's result.
  async function run(command, { timeoutMs = SANDBOX_LIMITS.timeoutMs, extraEnv = {}, signal = null, onStart } = {}) {
    if (closed) throw new SandboxRefusal('closed', 'This session has ended.')
    const time = Math.min(Math.max(1000, timeoutMs), SANDBOX_LIMITS.timeoutMaxMs)
    const vars = commandEnv({ env, tmp, extra: extraEnv })
    if (!boxed) {
      // --shell-unsandboxed (solo, the owner's own choice): the shell on this machine itself.
      if (command.shell !== undefined && mode === 'host-shell' && process.platform !== 'win32')
        return runProcess(['/bin/sh', '-c', String(command.shell)], { cwd: real, env: vars, timeoutMs: time, signal, onStart })
      if (command.shell !== undefined) throw new SandboxRefusal('no_shell', 'No shell runs outside the OS sandbox.')
      const argv = resolveArgv(command, { env })
      return runProcess(argv, { cwd: real, env: vars, timeoutMs: time, signal, onStart })
    }
    const line = command.shell !== undefined ? String(command.shell) : command.map(shellQuote).join(' ')
    const commandId = randomBytes(16).toString('base64url')
    // The environment is set inside, after srt's own proxy variables, so nothing of this process leaks in.
    const assignments = Object.entries(vars)
      .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      .map(([name, value]) => `${name}=${shellQuote(value)}`)
      .join(' ')
    const inner = `cd ${shellQuote(real)} && exec env ${assignments} /bin/sh -c ${shellQuote(line)}`
    const wrapped = await box.wrapWithSandboxArgv(inner, '/bin/sh', { filesystem: filesystem() }, signal || undefined, real, { commandId })
    box.registerCommandNetworkLists(commandId, { allowedDomains: list() })
    live.set(commandId, true)
    try {
      // srt puts its proxy settings in the wrapped command; the host side gets only PATH.
      return await runProcess(wrapped.argv, { cwd: real, env: { PATH: env.PATH || '/usr/bin:/bin' }, timeoutMs: time, signal, onStart })
    } finally {
      live.delete(commandId)
      box.unregisterCommandNetworkLists(commandId)
      try {
        box.cleanupAfterCommand()
      } catch {
        /* nothing to clean */
      }
    }
  }
  // The session's dev server joins what its commands may reach, from the next connection on.
  function allowPort(port) {
    ports.add(port)
    if (box) for (const id of live.keys()) box.registerCommandNetworkLists(id, { allowedDomains: list() })
  }
  function dropPort(port) {
    ports.delete(port)
    if (box) for (const id of live.keys()) box.registerCommandNetworkLists(id, { allowedDomains: list() })
  }
  function close() {
    closed = true
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  log(`sandbox: ${boxed ? 'OS sandbox' : 'no OS sandbox (a card each)'} in ${real}`)
  return { root: real, tmp, mode, network, readOnly, run, allowPort, dropPort, ports: () => [...ports], close }
}
