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
//              "registries"), or none ("none"). Never a local port: on
//              Linux each command has its own network namespace, so a dev
//              server one command starts cannot be reached by the next, and
//              a host port it did not bind is the person's. A dev server
//              gets its own sandbox and one bridged port (dev-server.js)
//   hidden     the home folder (every spelling of it), the absolute XDG
//              folders, the shared temp folders (/tmp, $TMPDIR, /var/tmp,
//              /dev/shm), /run/user/<uid>, /mnt, /media and the other fix
//              copies (deniedRoots)
//   limits     per command: processes (Linux), address space (Linux) and
//              file size by ulimit; the session temp is emptied past its cap
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
import { markRunning } from './acp/sandbox.js'

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
  // Set with ulimit inside the sandbox, per command (commandLimits).
  processes: 1024,
  memoryBytes: 8 * 1024 * 1024 * 1024,
  fileBytes: 2 * 1024 * 1024 * 1024,
  // The session temp (caches, HOME): emptied after a command that leaves more.
  tmpBytes: 2 * 1024 * 1024 * 1024,
  // A fix copy that grows past this stops taking commands (Q7 B6).
  copyBytes: 8 * 1024 * 1024 * 1024,
  // Where systemd runs (Linux): the share of CPU a command's scope gets against others (100 is the default).
  cpuWeight: 50,
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
    // The runtime looks for files that must stay unwritable with ripgrep, on Linux.
    else if (!onPath('rg', env)) result = { available: false, reason: 'ripgrep_missing' }
    else {
      const tried = run(bwrap, ['--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', 'true'], {
        stdio: 'ignore',
        timeout: 10_000,
      })
      // The runtime's seccomp helper makes a user namespace inside the sandbox; some
      // systems (Ubuntu's AppArmor userns restriction) allow bubblewrap's own but not that one.
      // -r maps the user, writing setgroups and uid_map, as the helper does.
      const unshare = onPath('unshare', env)
      const nested =
        tried.status !== 0 || !unshare
          ? tried
          : run(
              bwrap,
              [
                '--unshare-all',
                '--die-with-parent',
                '--ro-bind',
                '/',
                '/',
                '--dev',
                '/dev',
                '--proc',
                '/proc',
                unshare,
                '-U',
                '-r',
                'true',
              ],
              {
                stdio: 'ignore',
                timeout: 10_000,
              },
            )
      result =
        tried.status !== 0
          ? { available: false, reason: 'bwrap_blocked' }
          : nested.status !== 0
            ? { available: false, reason: 'userns_restricted' }
            : { available: true, reason: null }
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

// ---- Caps for the whole command (Linux, systemd) ----

// Each sandboxed command in a systemd scope of its own, where this
// machine's user manager makes one: its memory, its number of processes
// and its CPU weight capped for the command and everything it starts
// together (ulimit caps each process alone). The scope goes in the slice
// this process runs in, so a cap set around Shapewall still holds. Where
// there is no systemd user manager (a container, CI, macOS) commands run
// with the ulimit caps only. -> { available, slice }
let scopeProbe = null
export function probeScope({ platform = process.platform, env = process.env, run = spawnSync, cgroup = null, fresh = false } = {}) {
  if (scopeProbe && !fresh) return scopeProbe
  let result = { available: false, slice: null, program: null }
  if (platform === 'linux') {
    const program = onPath('systemd-run', env)
    if (program) {
      const slice = sliceOf(cgroup ?? readCgroup())
      const tried = run(
        program,
        // --expand-environment=no (systemd 254 and later): systemd-run would
        // otherwise read every $NAME in the command as its own variable.
        // Where it is not known, no scope.
        [
          '--user',
          '--scope',
          '--quiet',
          '--collect',
          '--expand-environment=no',
          ...(slice ? [`--slice=${slice}`] : []),
          '-p',
          'MemoryMax=64M',
          '-p',
          'TasksMax=16',
          'true',
        ],
        { stdio: 'ignore', timeout: 10_000, env: scopeEnv(env) },
      )
      if (tried.status === 0) result = { available: true, slice, program }
    }
  }
  if (!fresh) scopeProbe = result
  return result
}
function readCgroup() {
  try {
    return fs.readFileSync('/proc/self/cgroup', 'utf8')
  } catch {
    return ''
  }
}
// The user manager's slice this process is in ("agent-work.slice"), or null.
export function sliceOf(cgroup) {
  const line = String(cgroup || '')
    .split('\n')
    .find((entry) => entry.startsWith('0::'))
  if (!line) return null
  const parts = line.slice(3).split('/')
  const manager = parts.findIndex((part) => /^user@\d+\.service$/.test(part))
  if (manager < 0) return null
  const slices = parts.slice(manager + 1).filter((part) => /^[A-Za-z0-9:_.\\-]+\.slice$/.test(part))
  return slices.at(-1) || null
}
// What systemd-run needs to reach the user manager, and nothing else.
function scopeEnv(env) {
  const out = { PATH: env.PATH || '/usr/bin:/bin' }
  for (const name of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (typeof env[name] === 'string') out[name] = env[name]
  return out
}
// argv inside a scope of its own with the session's caps (probeScope said yes).
export function scopeArgv(argv, { scope, limits = SANDBOX_LIMITS, unit }) {
  return [
    scope.program,
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    '--expand-environment=no',
    `--unit=${unit}`,
    ...(scope.slice ? [`--slice=${scope.slice}`] : []),
    '-p',
    `MemoryMax=${limits.memoryBytes}`,
    '-p',
    'MemorySwapMax=0',
    '-p',
    `TasksMax=${limits.processes}`,
    '-p',
    `CPUWeight=${limits.cpuWeight ?? 50}`,
    '--',
    // The user manager's address is systemd-run's, never the command's.
    'env',
    '-u',
    'XDG_RUNTIME_DIR',
    '-u',
    'DBUS_SESSION_BUS_ADDRESS',
    ...argv,
  ]
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
export function runProcess(
  argv,
  { cwd, env, timeoutMs = SANDBOX_LIMITS.timeoutMs, outputBytes = SANDBOX_LIMITS.outputBytes, signal = null, onStart = () => {} },
) {
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
    // Stopped before it started: it never runs on.
    if (signal?.aborted) onAbort()
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
// The signal listeners the runtime adds (it cleans up on SIGINT and SIGTERM
// but does not end the process): a module that ends the process on a
// signal nobody else handles does not count these (agent-browser.js).
const RUNTIME_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']
const runtimeListeners = new Set()
export const isRuntimeListener = (listener) => runtimeListeners.has(listener)
// The runtime runs only while a session uses it: its proxies and socat
// bridges would keep the process alive (and listening) between fixes.
let sessions = 0
let stopping = null
async function sandboxManager() {
  if (stopping) await stopping
  if (manager) return manager
  starting ||= (async () => {
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime')
    const vendor = runtimeVendorDir()
    const before = Object.fromEntries(RUNTIME_SIGNALS.map((signal) => [signal, new Set(process.listeners(signal))]))
    // The process-wide base: no network (each command brings its list), no
    // writes, the home folder unreadable. Each command's own folders come
    // with the command (customConfig).
    await SandboxManager.initialize({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [os.homedir()], allowRead: vendor ? [vendor] : [], allowWrite: [], denyWrite: [] },
    })
    for (const signal of RUNTIME_SIGNALS)
      for (const listener of process.listeners(signal)) if (!before[signal].has(listener)) runtimeListeners.add(listener)
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
function releaseSandbox() {
  sessions -= 1
  if (sessions > 0) return
  stopping = closeSandbox().finally(() => (stopping = null))
}

// The runtime for a user other than a command session (the agent browser,
// src/agent/agent-browser.js): counted like a session, so it stays up while
// used. -> { box (the SandboxManager), release() }; release once.
export async function acquireSandbox() {
  sessions += 1
  let box
  try {
    box = await sandboxManager()
  } catch (error) {
    releaseSandbox()
    throw error
  }
  let released = false
  return {
    box,
    release() {
      if (released) return
      released = true
      releaseSandbox()
    },
  }
}

// What a session's commands may reach, as srt host patterns: the package
// registries, or nothing. Never a local port: each command has its own
// network namespace on Linux, so a port another command bound is not there,
// and a host port it did not bind is the person's (the Shapewall server,
// a browser's debugging port).
export function networkList(network) {
  return network === 'registries' ? REGISTRY_HOSTS.map((host) => `${host}:443`) : []
}

// The ulimit lines in front of every sandboxed command. Each is tried on
// its own, so a shell or platform without one still runs the command:
// processes only on Linux (inside srt's user namespace the count is the
// sandbox's own; on macOS it would be every process of the person's),
// address space where the kernel enforces it (Linux), file size everywhere.
// dash spells the process limit -p, bash -u.
export function commandLimits(platform = process.platform, limits = SANDBOX_LIMITS) {
  const kb = (bytes) => Math.floor(bytes / 1024)
  const lines = []
  if (platform === 'linux') {
    lines.push(`{ ulimit -u ${limits.processes} || ulimit -p ${limits.processes}; } 2>/dev/null`)
    lines.push(`ulimit -v ${kb(limits.memoryBytes)} 2>/dev/null`)
  }
  // 512-byte blocks in dash and POSIX mode, 1024 in bash: at most twice the cap.
  lines.push(`ulimit -f ${Math.floor(limits.fileBytes / 512)} 2>/dev/null`)
  return lines.join('; ')
}

// What no command may read: the home folder (as $HOME, os.homedir() and
// the account's own entry say it), the person's absolute XDG folders, every
// shared temp folder (other sessions' temps, other programs' sockets and
// files), /run/user/<uid>, removable and mounted disks, and the folder of
// fix copies (the other fixes), and the folder that holds every account's
// home (/home, /Users: other people's homes are not listed either, Q7 B7).
// The session's own folders are allowed back inside these (srt allowRead
// within denyRead), and so are programs on PATH installed in another
// account's home (homebrew on Linux: homesToolchain). -> real paths that exist.
const HOMES = new Set(['/home', '/Users', '/var/home'])
// The folder of every account's home, when this account's home is in one.
export function homesRoot(home = os.homedir()) {
  let real
  try {
    real = realpath(home)
  } catch {
    return null
  }
  const parent = path.dirname(real)
  return HOMES.has(parent) ? parent : null
}
// PATH folders inside another account's home (/home/linuxbrew/.linuxbrew/bin):
// their install prefix stays readable, so the programs there still run.
export function homesToolchain({ env = process.env, home = os.homedir() } = {}) {
  const homes = homesRoot(home)
  if (!homes) return []
  let own = null
  try {
    own = realpath(home)
  } catch {
    /* none */
  }
  const out = []
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue
    let real
    try {
      real = realpath(dir)
    } catch {
      continue
    }
    if (!isInside(homes, real) || (own && isInside(own, real))) continue
    const prefix = path.basename(real) === 'bin' ? path.dirname(real) : real
    // At least two levels below the homes folder: never a whole home.
    if (path.relative(homes, prefix).split(path.sep).length < 2) continue
    if (!out.includes(prefix)) out.push(prefix)
  }
  return out
}
const SYSTEM_DIRS = [
  '/usr',
  '/etc',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/opt',
  '/System',
  '/Library',
  '/nix',
  '/proc',
  '/sys',
  '/dev',
]
export function deniedRoots({ env = process.env, within = null, platform = process.platform } = {}) {
  const wanted = [os.homedir(), env.HOME]
  try {
    wanted.push(os.userInfo().homedir)
  } catch {
    /* no passwd entry */
  }
  for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR'])
    for (const source of [env, process.env]) wanted.push(source[name])
  const tmp = os.tmpdir()
  wanted.push(tmp, '/tmp', '/var/tmp', '/dev/shm', '/mnt', '/media')
  if (typeof process.getuid === 'function') wanted.push(`/run/user/${process.getuid()}`)
  if (platform === 'darwin') {
    // The per-user $TMPDIR (/var/folders/xx/yyyy/T) and its siblings (C: caches).
    try {
      wanted.push(path.dirname(realpath(tmp)))
    } catch {
      /* none */
    }
    wanted.push('/private/tmp', '/private/var/tmp')
  }
  if (within) wanted.push(within)
  wanted.push(homesRoot())
  const out = []
  for (const item of wanted) {
    if (typeof item !== 'string' || !path.isAbsolute(item)) continue
    let real
    try {
      real = realpath(item)
    } catch {
      continue
    }
    if (real === path.parse(real).root) continue
    // A system folder only by a person's odd XDG setting: never hidden (/dev/shm is named above on purpose).
    if (real !== '/dev/shm' && SYSTEM_DIRS.some((dir) => real === dir || isInside(dir, real))) continue
    if (!out.includes(real)) out.push(real)
  }
  return out
}

// The folder Node runs from, when it is inside a denied folder (nvm, volta,
// fnm, asdf in the home folder): readable, never writable. Only Node's own
// install folder, after following links, and only when it is at least three
// levels down (~/.nvm/versions/node/v22): a shared prefix such as ~/.local
// (~/.local/bin/node) or the home folder itself would open everything else
// installed there, so it is refused and commands run without it.
export function toolchainDir({ execPath = process.execPath, denied = [] } = {}) {
  let prefix
  try {
    prefix = path.dirname(path.dirname(realpath(execPath)))
  } catch {
    return { dir: null, refused: null }
  }
  const under = denied.filter((root) => isInside(root, prefix))
  if (!under.length) return { dir: null, refused: null }
  const shallow = under.some((root) => {
    const rel = path.relative(root, prefix)
    return !rel || rel.split(path.sep).length < 3
  })
  return shallow ? { dir: null, refused: prefix } : { dir: prefix, refused: null }
}

// srt's own Unix sockets to its proxies (Linux), which it binds into every
// sandbox inside the system temp.
export function bridgeSockets(box) {
  const out = []
  for (const get of ['getLinuxHttpSocketPath', 'getLinuxSocksSocketPath']) {
    const file = typeof box?.[get] === 'function' ? box[get]() : null
    if (typeof file === 'string' && path.isAbsolute(file) && !out.includes(file)) out.push(file)
  }
  return out
}

// The size of a folder (no links followed), stopping past `limit`.
function sizeOf(dir, limit) {
  let total = 0
  const stack = [dir]
  while (stack.length && total <= limit) {
    const current = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(file)
      else
        try {
          total += fs.lstatSync(file).size
        } catch {
          /* gone */
        }
    }
  }
  return total
}

// One session of sandboxed commands for one fix copy.
//   root      the fix copy: the one writable folder of the project. Refused
//             when it is not `expect` (the fix copy the caller made), is
//             the home folder or holds it, is inside `checkout` (the
//             person's real project), or is the system root.
//   network   "registries" | "none"
//   readOnly  the copy is mounted read only too (hosted chat's QA commands
//             that do not change files)
//   mode      "sandboxed" (srt), "host" (no OS sandbox: only after a card
//             each, without a shell; the open tier's model), or "host-shell"
//             (shell-unsandboxed on: solo only, the owner's loud choice)
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
  // Where the session temp goes: inside the folder of fix copies (denied to
  // every other session), else the system temp.
  tmpParent = null,
  env = process.env,
  denyRead = [],
  // Folders inside the root no command may write (a local board's own
  // checkout: its .git and .shapewall stay read only).
  denyWrite = [],
  limits = SANDBOX_LIMITS,
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
  // The person's own checkout, when the commands run in a copy of it: never
  // the root, and never readable (wherever it is: outside the home folder
  // too, Q7 B3).
  let project = null
  if (checkout) {
    project = checkout
    try {
      project = realpath(checkout)
    } catch {
      /* gone: compared as given */
    }
    if (isInside(project, real) || isInside(real, project))
      throw new SandboxRefusal('bad_root', "The sandbox never writes in the person's own checkout.")
  }
  if (!['sandboxed', 'host', 'host-shell'].includes(mode)) throw new SandboxRefusal('bad_mode', 'Unknown sandbox mode.')
  // Read only and the folders no command may read are the OS sandbox's to
  // keep: without one a command could write and read anything the person
  // can, so a session that promises read only does not start (Q7 B7).
  if (readOnly && mode !== 'sandboxed')
    throw new SandboxRefusal('no_sandbox_read_only', 'Read-only commands need the OS sandbox, and there is none here.')
  if (!['registries', 'none'].includes(network))
    throw new SandboxRefusal('bad_network', 'Commands get the package registries or no network.')
  // Real paths: Seatbelt matches them, and /var is a link to /private/var on macOS.
  const tmp = fs.mkdtempSync(path.join(realpath(tmpParent || within || os.tmpdir()), '.shapewall-cmd-'))
  fs.chmodSync(tmp, 0o700)
  const vendor = runtimeVendorDir()
  const denied = [
    ...new Set([
      home,
      ...deniedRoots({ env, within }),
      ...(project && path.isAbsolute(project) ? [project] : []),
      ...denyRead.filter((dir) => path.isAbsolute(dir)),
    ]),
  ]
  const toolchain = toolchainDir({ denied })
  if (toolchain.refused)
    log(`sandbox: Node runs from ${toolchain.refused}, a shared folder; it stays unreadable, so commands need a Node installed elsewhere`)
  const boxed = mode === 'sandboxed'
  if (boxed) sessions += 1
  let box = null
  try {
    box = boxed ? await sandboxManager() : null
  } catch (error) {
    releaseSandbox()
    fs.rmSync(tmp, { recursive: true, force: true })
    throw error
  }
  const filesystem = () => ({
    denyRead: denied,
    allowRead: [
      real,
      tmp,
      ...(toolchain.dir ? [toolchain.dir] : []),
      ...homesToolchain({ env }),
      ...(vendor ? [vendor] : []),
      // srt's proxy bridge sockets live in the system temp, which is denied.
      ...bridgeSockets(box),
      ...readPaths.filter((dir) => path.isAbsolute(dir)),
    ],
    allowWrite: readOnly ? [tmp] : [real, tmp],
    // A list, or a function asked before each run (a local board's guarded files: command-guard.js).
    denyWrite: (typeof denyWrite === 'function' ? denyWrite() : denyWrite).filter((dir) => typeof dir === 'string' && path.isAbsolute(dir)),
  })
  const list = () => networkList(network)
  // The caps for a whole command (systemd scope), where this machine has them.
  const scope = boxed && process.platform === 'linux' && limits.scope !== false ? probeScope({ env }) : { available: false }
  // A fix copy that grew past its cap takes no more commands.
  let overgrown = false
  let closed = false
  // Run at close, before the temp goes: the session's dev servers (dev-server.js).
  const closers = []
  // The kill of every run still going: close() stops them all, whatever
  // signal their caller holds (a command never outlives its session).
  const live = new Set()
  // A command that left the session temp over its cap: emptied (a fresh HOME).
  function capTmp(result) {
    // A fix copy (not the person's own checkout, not read only) is measured after each run.
    if (within && !readOnly && sizeOf(real, limits.copyBytes) > limits.copyBytes) {
      overgrown = true
      result = {
        ...result,
        output: `${result.output}\n[Shapewall: the fix copy went over ${Math.round(limits.copyBytes / 1024 / 1024 / 1024)} GB; it takes no more commands]`,
      }
    }
    if (sizeOf(tmp, limits.tmpBytes) <= limits.tmpBytes) return result
    for (const name of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, name), { recursive: true, force: true })
    return {
      ...result,
      output: `${result.output}\n[Shapewall: the session temp went over ${Math.round(limits.tmpBytes / 1024 / 1024)} MB and was emptied]`,
    }
  }

  // argv (no shell) or { shell: "..." } (the solo full shell). -> runProcess's result.
  async function run(command, options = {}) {
    if (closed) throw new SandboxRefusal('closed', 'This session has ended.')
    if (overgrown)
      throw new SandboxRefusal(
        'copy_too_big',
        `Not run: the fix copy is over ${Math.round(limits.copyBytes / 1024 / 1024 / 1024)} GB, so it takes no more commands.`,
      )
    let kill = null
    const started = (handle) => {
      kill = handle.kill
      if (closed) handle.kill()
      else live.add(kill)
      options.onStart?.(handle)
    }
    // While it runs, the agent's file access through Shapewall knows (acp/sandbox.js commandRunningIn).
    const done = markRunning(real)
    try {
      return await runInSession(command, { ...options, onStart: started })
    } finally {
      done()
      if (kill) live.delete(kill)
    }
  }
  async function runInSession(command, { timeoutMs = SANDBOX_LIMITS.timeoutMs, extraEnv = {}, signal = null, onStart } = {}) {
    const time = Math.min(Math.max(1000, timeoutMs), SANDBOX_LIMITS.timeoutMaxMs)
    const vars = commandEnv({ env, tmp, extra: extraEnv })
    if (!boxed) {
      // shell-unsandboxed on (solo, the owner's own choice): the shell on this machine itself.
      if (command.shell !== undefined && mode === 'host-shell' && process.platform !== 'win32')
        return capTmp(
          await runProcess(['/bin/sh', '-c', String(command.shell)], { cwd: real, env: vars, timeoutMs: time, signal, onStart }),
        )
      if (command.shell !== undefined) throw new SandboxRefusal('no_shell', 'No shell runs outside the OS sandbox.')
      const argv = resolveArgv(command, { env })
      return capTmp(await runProcess(argv, { cwd: real, env: vars, timeoutMs: time, signal, onStart }))
    }
    const line = command.shell !== undefined ? String(command.shell) : command.map(shellQuote).join(' ')
    const commandId = randomBytes(16).toString('base64url')
    // The environment is set inside, after srt's own proxy variables, so nothing of this process leaks in.
    const assignments = Object.entries(vars)
      .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      .map(([name, value]) => `${name}=${shellQuote(value)}`)
      .join(' ')
    const inner = `cd ${shellQuote(real)} && ${commandLimits(process.platform, limits)}; exec env ${assignments} /bin/sh -c ${shellQuote(line)}`
    const wrapped = await box.wrapWithSandboxArgv(inner, '/bin/sh', { filesystem: filesystem() }, signal || undefined, real, { commandId })
    box.registerCommandNetworkLists(commandId, { allowedDomains: list() })
    try {
      // srt puts its proxy settings in the wrapped command; the host side gets only PATH.
      const argv = scope.available
        ? scopeArgv(wrapped.argv, { scope, limits, unit: `shapewall-cmd-${randomBytes(8).toString('hex')}` })
        : wrapped.argv
      return capTmp(
        await runProcess(argv, {
          cwd: real,
          env: scope.available ? scopeEnv(env) : { PATH: env.PATH || '/usr/bin:/bin' },
          timeoutMs: time,
          signal,
          onStart,
        }),
      )
    } finally {
      box.unregisterCommandNetworkLists(commandId)
      try {
        box.cleanupAfterCommand()
      } catch {
        /* nothing to clean */
      }
    }
  }
  function close() {
    if (closed) return
    closed = true
    for (const kill of [...live])
      try {
        kill()
      } catch {
        /* gone */
      }
    live.clear()
    for (const fn of closers.splice(0))
      try {
        fn()
      } catch {
        /* the next one still runs */
      }
    fs.rmSync(tmp, { recursive: true, force: true })
    if (boxed) releaseSandbox()
  }
  log(`sandbox: ${boxed ? 'OS sandbox' : 'no OS sandbox (a card each)'} in ${real}`)
  const onClose = (fn) => (closed ? fn() : closers.push(fn))
  return { root: real, tmp, mode, network, readOnly, denied, scoped: Boolean(scope.available), run, close, onClose }
}
