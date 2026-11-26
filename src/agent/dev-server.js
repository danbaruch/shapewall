// The dev server supervisor (plan 3.4, 7 Q4): runs a session's named `dev`
// command and gives Shapewall exactly one loopback port that reaches it, so
// the agent's browser can open the app the agent is changing.
//
// In the OS sandbox (Linux, src/agent/sandbox-exec.js): each sandboxed
// command has its own network namespace and srt 0.0.83 forwards no ports,
// so the server is started in its own long-lived sandbox (the same folders
// and network list as the session's other commands) and bridged:
//
//   agent browser -> 127.0.0.1:PORT  (host; bound by this supervisor and
//                                     held until stop: never a port picked
//                                     and released for another to take)
//     -> a Unix socket in a 0700 folder of this process (host /tmp, which
//        no sandboxed command can read)
//     -> the bridge: this file run as a program, by `nsenter` in the
//        server's network namespace only (its user namespace, for the right
//        to join it; the host's files and processes otherwise). It is not
//        in the sandbox's process tree and never under srt's seccomp
//        filter, which forbids Unix sockets to sandboxed commands.
//     -> 127.0.0.1:PORT (or [::1]:PORT) inside that namespace, where the
//        server listens on the same number ($PORT)
//
// One port per server, nothing else: a port any other command binds is in
// that command's own namespace, unreachable, and never registered with the
// browser. Stop (and session close) kills the sandbox, the bridge, the held
// port and the socket folder.
//
// macOS (Seatbelt, no network namespace): srt's only way to let a command
// listen (allowLocalBinding) also lets it connect to every loopback port of
// the machine (the Shapewall server, debugging ports), so dev servers stay
// off inside the sandbox there (devBridge() says why).
//
// Outside the sandbox (host mode, after a card, or --shell-unsandboxed) the
// server binds a free port itself. Before the browser gets that port the
// supervisor checks that the listener on 127.0.0.1:PORT belongs to the
// server's own process group (ownsPort); where that cannot be checked
// (Windows) the browser does not get it.

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
export const DEV_LIMITS = { namespaceMs: 10_000, bridgeMs: 10_000 }

class DevRefusal extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function onPath(name, env = process.env) {
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

// Whether a sandboxed session can bridge a dev server here: { available, reason }.
export function devBridge({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'darwin') return { available: false, reason: 'seatbelt_loopback' }
  if (platform !== 'linux') return { available: false, reason: 'platform' }
  if (!fs.existsSync('/proc/self/ns/net')) return { available: false, reason: 'no_proc' }
  return onPath('nsenter', env) ? { available: true, reason: null } : { available: false, reason: 'nsenter_missing' }
}
export const DEV_BRIDGE_WHY = {
  seatbelt_loopback:
    "macOS's sandbox can let a server listen only by opening every loopback port of the machine to it, so dev servers do not run in the OS sandbox there.",
  platform: 'Dev servers do not run in the OS sandbox on this platform.',
  no_proc: 'Dev servers in the OS sandbox need /proc on this machine.',
  nsenter_missing: 'Dev servers in the OS sandbox need nsenter (util-linux) on this machine.',
}

// ---- Who listens on a port (host mode) ----

// The hex address forms of /proc/net/tcp{,6} that serve 127.0.0.1.
const V4_OK = new Set(['0100007F', '00000000'])
const V6_OK = new Set(['00000000000000000000000000000000', '0000000000000000FFFF00000100007F'])
function linuxListenerInodes(port, read = (file) => fs.readFileSync(file, 'utf8')) {
  const inodes = new Set()
  for (const [file, ok] of [
    ['/proc/net/tcp', V4_OK],
    ['/proc/net/tcp6', V6_OK],
  ]) {
    let lines = []
    try {
      lines = read(file).split('\n').slice(1)
    } catch {
      continue
    }
    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 10 || parts[3] !== '0A') continue
      const [address, hexPort] = parts[1].split(':')
      if (parseInt(hexPort, 16) === port && ok.has(address.toUpperCase())) inodes.add(parts[9])
    }
  }
  return inodes
}
function linuxGroupPids(pgid) {
  const out = []
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (Number(fields[2]) === pgid) out.push(Number(name))
    } catch {
      /* gone */
    }
  }
  return out
}
// Whether the listener that serves 127.0.0.1:port belongs to process group
// `pgid` (the server's, spawned as its own group). False when someone else
// listens there too, when nobody does, or when it cannot be told.
export function ownsPort(port, pgid, { platform = process.platform, run = spawnSync } = {}) {
  if (!Number.isInteger(port) || !Number.isInteger(pgid) || pgid <= 1) return false
  if (platform === 'linux') {
    const inodes = linuxListenerInodes(port)
    if (!inodes.size) return false
    const mine = new Set()
    for (const pid of linuxGroupPids(pgid)) {
      let fds = []
      try {
        fds = fs.readdirSync(`/proc/${pid}/fd`)
      } catch {
        continue
      }
      for (const fd of fds) {
        try {
          const link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`)
          const match = /^socket:\[(\d+)\]$/.exec(link)
          if (match) mine.add(match[1])
        } catch {
          /* closed meanwhile */
        }
      }
    }
    return [...inodes].every((inode) => mine.has(inode))
  }
  if (platform === 'darwin') {
    const lsof = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pn'], { encoding: 'utf8', timeout: 5000 })
    if (lsof.status !== 0 && !lsof.stdout) return false
    const pids = new Set()
    let pid = null
    for (const line of String(lsof.stdout || '').split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1))
      else if (line.startsWith('n') && pid) {
        const name = line.slice(1)
        if (name === `127.0.0.1:${port}` || name === `*:${port}` || name === `[::ffff:127.0.0.1]:${port}`) pids.add(pid)
      }
    }
    if (!pids.size) return false
    for (const one of pids) {
      const ps = run('ps', ['-o', 'pgid=', '-p', String(one)], { encoding: 'utf8', timeout: 5000 })
      if (Number(String(ps.stdout || '').trim()) !== pgid) return false
    }
    return true
  }
  return false
}

// ---- The sandbox's network namespace (Linux) ----

const children = (pid) => {
  try {
    return fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number)
  } catch {
    return []
  }
}
const nsOf = (pid, kind) => {
  try {
    return fs.readlinkSync(`/proc/${pid}/ns/${kind}`)
  } catch {
    return null
  }
}
// The first process below `root` in another network and user namespace
// than this one: bubblewrap's child, the sandbox's first process. -> { pid, net } | null
export function sandboxNamespace(root) {
  const ownNet = nsOf('self', 'net')
  const ownUser = nsOf('self', 'user')
  const queue = [root]
  const seen = new Set()
  while (queue.length) {
    const pid = queue.shift()
    if (seen.has(pid)) continue
    seen.add(pid)
    const netNs = nsOf(pid, 'net')
    const userNs = nsOf(pid, 'user')
    if (netNs && userNs && netNs !== ownNet && userNs !== ownUser) return { pid, net: netNs }
    queue.push(...children(pid))
  }
  return null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Holds 127.0.0.1:0 for the whole life of one server. -> { port, server }
export function holdPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer({ pauseOnConnect: true })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, server }))
  })
}
// A free port the server binds itself (host mode only; checked with ownsPort after).
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

// The port a server will get, before its command line is made (its $PORT):
// held at once in the sandbox, picked for host mode. -> { port, bridged, release() }
export async function reserveDevPort(session) {
  if (session.mode === 'sandboxed') {
    const why = devBridge()
    if (!why.available) throw new DevRefusal('no_dev_bridge', DEV_BRIDGE_WHY[why.reason] || 'No dev servers in the OS sandbox here.')
    const held = await holdPort()
    let released = false
    return {
      port: held.port,
      bridged: true,
      held,
      release() {
        if (released) return
        released = true
        held.server.close()
      },
    }
  }
  return { port: await freePort(), bridged: false, held: null, release() {} }
}

// Starts `command` (argv, already holding the port) in `session` on the
// reserved port. -> server { port, bridged, done (the run's result), exited,
// output(), owned(), stop() }. `track(start)` wraps the run (the tool host's
// changed-files snapshot); it gets a function that starts it and returns its promise.
export async function startDevServer({ session, reserved, command, extraEnv = {}, timeoutMs, track = (start) => start(), log = () => {} }) {
  const { port } = reserved
  const server = { port, bridged: reserved.bridged, exited: false, done: null, stop: null, owned: null, last: '' }
  let kill = () => {}
  let pgid = null
  let started
  const startedAt = new Promise((resolve) => (started = resolve))
  let bridge = null
  let dir = null
  const conns = new Set()
  let stopped = false
  const cleanup = () => {
    if (stopped) return
    stopped = true
    try {
      kill()
    } catch {
      /* gone */
    }
    if (bridge && bridge.exitCode === null && bridge.signalCode === null) bridge.kill('SIGKILL')
    for (const conn of conns) conn.destroy()
    reserved.release()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
  server.done = track(() =>
    session.run(command, {
      timeoutMs,
      extraEnv: { ...extraEnv, PORT: String(port) },
      onStart: (info) => {
        kill = info.kill
        pgid = info.child?.pid ?? null
        started(info)
      },
    }),
  ).then(
    (run) => {
      server.exited = true
      server.last = run.output
      cleanup()
      return run
    },
    (error) => {
      server.exited = true
      cleanup()
      throw error
    },
  )
  const ended = server.done.then(
    () => null,
    () => null,
  )
  server.stop = async () => {
    cleanup()
    await server.done.catch(() => {})
  }
  server.output = () => server.last
  // Host mode: the listener on 127.0.0.1:port must be the server's own.
  server.owned = () => !server.exited && !reserved.bridged && Number.isInteger(pgid) && ownsPort(port, pgid)
  session.onClose?.(() => cleanup())
  // Every connection to the held port goes to the bridge once it is up;
  // before that (and after stop) it is closed at once.
  let socket = null
  reserved.held?.server.on('connection', (conn) => {
    if (stopped || !socket) return conn.destroy()
    const inner = net.connect(socket)
    conns.add(conn)
    conns.add(inner)
    const drop = () => {
      conn.destroy()
      inner.destroy()
      conns.delete(conn)
      conns.delete(inner)
    }
    conn.on('error', drop).on('close', drop)
    inner.on('error', drop).on('close', drop)
    inner.once('connect', () => {
      conn.pipe(inner)
      inner.pipe(conn)
      conn.resume()
    })
  })
  const info = await Promise.race([startedAt, ended])
  if (!info) return server
  if (!reserved.bridged) return server

  // ---- The bridge (sandbox, Linux) ----
  try {
    let found = null
    const until = Date.now() + DEV_LIMITS.namespaceMs
    while (!found && !server.exited && Date.now() < until) {
      found = sandboxNamespace(info.child.pid)
      if (!found) await sleep(25)
    }
    if (!found) throw new Error('the sandbox has no network namespace of its own')
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-dev-'))
    fs.chmodSync(dir, 0o700)
    const file = path.join(dir, 'b')
    const nsenter = onPath('nsenter')
    bridge = spawn(
      nsenter,
      ['-t', String(found.pid), '-U', '-n', '--preserve-credentials', process.execPath, SELF, 'bridge', file, String(port)],
      { stdio: ['pipe', 'pipe', 'pipe'], env: {}, shell: false },
    )
    let said = ''
    bridge.stdout.setEncoding('utf8')
    bridge.stderr.setEncoding('utf8')
    bridge.stderr.on('data', (chunk) => (said = (said + chunk).slice(-500)))
    const ready = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), DEV_LIMITS.bridgeMs)
      bridge.stdout.on('data', (chunk) => {
        if (chunk.includes('ready')) {
          clearTimeout(timer)
          resolve(true)
        }
      })
      bridge.once('exit', () => {
        clearTimeout(timer)
        resolve(false)
      })
    })
    if (!ready) throw new Error(`the bridge did not start${said ? `: ${said.trim()}` : ''}`)
    // The bridge must sit in that very namespace (a pid can be reused).
    if (nsOf(bridge.pid, 'net') !== found.net || nsOf(found.pid, 'net') !== found.net)
      throw new Error('the bridge is not in the sandbox namespace')
    socket = file
    bridge.once('exit', () => {
      if (!stopped) log(`dev server: the bridge to port ${port} stopped; the server is stopped too`)
      cleanup()
    })
  } catch (error) {
    log(`dev server: ${error.message}`)
    server.bridgeError = server.exited ? 'it stopped before it could be reached' : error.message
    await server.stop()
  }
  return server
}

// ---- The bridge (this file run as a program, inside the namespace) ----

function runBridge(socket, port) {
  const target = Number(port)
  const server = net.createServer((conn) => {
    conn.pause()
    const tryConnect = (hosts) => {
      const inner = net.connect({ host: hosts[0], port: target })
      let joined = false
      inner.once('connect', () => {
        joined = true
        if (conn.destroyed) return inner.destroy()
        inner.on('error', () => conn.destroy())
        inner.on('close', () => conn.destroy())
        conn.on('close', () => inner.destroy())
        conn.pipe(inner)
        inner.pipe(conn)
        conn.resume()
      })
      // Not there (IPv4 first, then IPv6: `localhost` is ::1 on many systems).
      inner.once('error', () => {
        if (joined) return
        inner.destroy()
        if (hosts.length > 1 && !conn.destroyed) tryConnect(hosts.slice(1))
        else conn.destroy()
      })
    }
    conn.on('error', () => conn.destroy())
    tryConnect(['127.0.0.1', '::1'])
  })
  const oldMask = process.umask(0o077)
  server.listen(socket, () => {
    process.umask(oldMask)
    fs.chmodSync(socket, 0o600)
    process.stdout.write('ready\n')
  })
  server.on('error', (error) => {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  })
  // Gone with the supervisor: its end of stdin closes.
  process.stdin.on('end', () => process.exit(0))
  process.stdin.on('close', () => process.exit(0))
  process.stdin.resume()
}

if (process.argv[1] === SELF && process.argv[2] === 'bridge') runBridge(process.argv[3], process.argv[4])

export const _test = { linuxListenerInodes, DevRefusal }
