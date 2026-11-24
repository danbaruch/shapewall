// The peer check (check 2 in src/tailnet-proof.js) and the facts about
// tailscaled, on Windows and macOS. Linux reads both from /proc
// (src/tailnet-proof.js); these do the same job with what each system lets
// an ordinary user read, without native code.
//
// Windows. tailscaled is the `Tailscale` service, run by the Service Control
// Manager as LocalSystem. Serve's proxy dials the server from inside that
// process. `netstat -ano` lists the process id that owns every TCP
// connection (no elevation needed for the id, only for the program's path),
// and `sc.exe queryex Tailscale` says which process id the running service
// has. A connection is tailscaled's when its other end is owned by that
// process id. That id is read when the connection is accepted and again
// before and after the netstat lookup, and all must agree: netstat names the
// process that made a socket even after it exited, so an id freed long ago
// and taken by a restarted service must not make an older connection pass. No other user can start, replace
// or reconfigure a LocalSystem service or open a socket in its process; an
// Administrator can, as root can on Linux.
//
// macOS. The kernel lists every TCP socket with the user id of the process
// that made it in the `net.inet.tcp.pcblist_n` sysctl, which any user may
// read: the same list as /proc/net/tcp. A connection is tailscaled's when
// its other end is owned by root, as on Linux. That holds for the
// Standalone Tailscale app (its network extension runs as root) and for the
// open-source tailscaled. The Mac App Store app runs its network extension
// as the logged-in user, like every other program of that user, so nothing
// tells it apart: it is refused, with the Standalone app as the fix.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const isLoopback = (address) => typeof address === 'string' && /^127\.\d+\.\d+\.\d+$/.test(address)
const loopbackPair = (socket) =>
  Boolean(socket) && socket.remoteFamily === 'IPv4' && isLoopback(socket.remoteAddress) && isLoopback(socket.localAddress)

// Runs a program, never through a shell. Resolves { code, stdout } (stdout a
// Buffer with `binary`), or { code: null } when it could not run.
export function runProgram(file, args, { binary = false, timeout = 5000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        { encoding: binary ? 'buffer' : 'utf8', timeout, maxBuffer, windowsHide: true, shell: false, cwd: os.tmpdir() },
        (error, stdout) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout }),
      )
    } catch {
      resolve({ code: null, stdout: binary ? Buffer.alloc(0) : '' })
    }
  })
}

// ---- Windows -------------------------------------------------------------------

export const WINDOWS_SERVICE = 'Tailscale'
const system32 = (env = process.env) => path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32')

// "127.0.0.1:52344" -> { address, port }; null for anything else.
const windowsEndpoint = (text) => {
  const match = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(String(text))
  return match ? { address: match[1], port: Number(match[2]) } : null
}

// The process id that owns the other end of a loopback connection, from the
// text of `netstat -ano -p TCP`. Rows are matched by the four addresses only:
// the state column is translated on some Windows languages. null when there
// is not exactly one such row.
export function netstatPeerPid(text, { remoteAddress, remotePort, localAddress, localPort }) {
  let pid = null
  let rows = 0
  for (const line of String(text).split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 4 || fields[0].toUpperCase() !== 'TCP') continue
    const theirs = windowsEndpoint(fields[1])
    const ours = windowsEndpoint(fields[2])
    if (!theirs || !ours) continue
    if (theirs.address !== remoteAddress || theirs.port !== Number(remotePort)) continue
    if (ours.address !== localAddress || ours.port !== Number(localPort)) continue
    const last = fields[fields.length - 1]
    if (!/^\d+$/.test(last)) return null
    pid = Number(last)
    rows += 1
  }
  return rows === 1 ? pid : null
}

// `sc.exe queryex <service>`: { running, pid }. The field names are not
// translated.
export function scQueryEx(text) {
  const state = /^\s*STATE\s*:\s*(\d+)/m.exec(String(text))
  const pid = /^\s*PID\s*:\s*(\d+)/m.exec(String(text))
  const running = Boolean(state && Number(state[1]) === 4)
  const number = pid ? Number(pid[1]) : 0
  return { running, pid: running && number > 0 ? number : null }
}

// `sc.exe qc <service>`: { binaryPath, account } or null.
export function scQc(text) {
  const binary = /^\s*BINARY_PATH_NAME\s*:\s*(.+?)\s*$/m.exec(String(text))
  const account = /^\s*SERVICE_START_NAME\s*:\s*(.+?)\s*$/m.exec(String(text))
  if (!binary || !account) return null
  return { binaryPath: binary[1], account: account[1] }
}

// A Windows command line split into arguments (the rules the C runtime uses,
// enough for a service's command line).
export function splitWindowsCommandLine(line) {
  const args = []
  let current = ''
  let quoted = false
  let any = false
  const text = String(line)
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\') {
      let slashes = 0
      while (text[index] === '\\') {
        slashes += 1
        index += 1
      }
      if (text[index] === '"') {
        current += '\\'.repeat(Math.floor(slashes / 2))
        if (slashes % 2) current += '"'
        else {
          quoted = !quoted
        }
        any = true
      } else {
        current += '\\'.repeat(slashes)
        index -= 1
        any = true
      }
      continue
    }
    if (char === '"') {
      quoted = !quoted
      any = true
      continue
    }
    if (!quoted && /\s/.test(char)) {
      if (any) args.push(current)
      current = ''
      any = false
      continue
    }
    current += char
    any = true
  }
  if (any) args.push(current)
  return args
}

// The names set in a service's Environment registry value, from the text of
// `reg.exe query ... /v Environment` (REG_MULTI_SZ, items joined by "\0").
export function regEnvironmentNames(text) {
  const match = /^\s*Environment\s+REG_MULTI_SZ\s+(.*)$/m.exec(String(text))
  if (!match) return []
  return match[1]
    .split('\\0')
    .map((pair) => pair.split('=')[0].trim())
    .filter(Boolean)
}

const LOCAL_SYSTEM = /^(LocalSystem|NT AUTHORITY\\SYSTEM|\.\\LocalSystem)$/i

// proof for Windows: { ownerOf, trusted, problem, selfOwner }. ownerOf and
// trusted are asynchronous (each spawns netstat).
export function windowsPeerProof({ run = runProgram, env = process.env } = {}) {
  const dir = system32(env)
  const netstat = path.win32.join(dir, 'netstat.exe')
  const sc = path.win32.join(dir, 'sc.exe')
  const ownerOf = async (socket) => {
    if (!loopbackPair(socket)) return null
    const result = await run(netstat, ['-ano', '-p', 'TCP'])
    if (result.code !== 0) return null
    return netstatPeerPid(result.stdout, socket)
  }
  const servicePid = async () => {
    const result = await run(sc, ['queryex', WINDOWS_SERVICE])
    return result.code === 0 ? scQueryEx(result.stdout).pid : null
  }
  // The service's process id when each connection was accepted (watch()).
  const atAccept = new WeakMap()
  const accepted = (socket) => {
    if (socket && !atAccept.has(socket)) atAccept.set(socket, loopbackPair(socket) ? servicePid() : Promise.resolve(null))
  }
  return {
    ownerOf,
    // Called with the listening server before anything is put on the tailnet (proofSelfTest).
    watch(server) {
      server.on('connection', accepted)
    },
    accepted,
    async trusted(socket) {
      if (!loopbackPair(socket) || !atAccept.has(socket)) return false
      const then = await atAccept.get(socket)
      const before = await servicePid()
      if (!then || then !== before) return false
      const owner = await ownerOf(socket)
      const after = await servicePid()
      return owner === before && after === before
    },
    // What ownerOf answers for a connection this process opened itself.
    selfOwner: () => process.pid,
    problem: () => null,
  }
}

// What Windows says about tailscaled, in the shape hostFacts gives on Linux:
// { tailscaled: [{ pid, uid, argv, env }], unreadable, container }. uid 0
// stands for LocalSystem (the account that is root's equal here).
export async function windowsFacts({ run = runProgram, env = process.env, read = fs } = {}) {
  const facts = { tailscaled: [], unreadable: 0, container: null, platform: 'win32' }
  const dir = system32(env)
  const sc = path.win32.join(dir, 'sc.exe')
  const query = await run(sc, ['queryex', WINDOWS_SERVICE])
  if (query.code !== 0) return facts // no such service, or not allowed to ask: nothing to believe
  const { pid } = scQueryEx(query.stdout)
  if (!pid) return facts
  const config = await run(sc, ['qc', WINDOWS_SERVICE])
  const parsed = config.code === 0 ? scQc(config.stdout) : null
  if (!parsed) {
    facts.unreadable += 1
    return facts
  }
  const argv = splitWindowsCommandLine(parsed.binaryPath)
  if (!argv.length || !/(^|[\\/])tailscaled\.exe$/i.test(argv[0])) {
    facts.unreadable += 1
    return facts
  }
  // tailscaled's debug switches, from the service's registry environment
  // (readable by every user) and tailscaled's env file under ProgramData
  // (admin-only; unreadable is trusted configuration, as on Linux).
  let names = []
  const reg = await run(path.win32.join(dir, 'reg.exe'), [
    'query',
    `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${WINDOWS_SERVICE}`,
    '/v',
    'Environment',
  ])
  if (reg.code === 0) names = regEnvironmentNames(reg.stdout)
  try {
    const programData = env.ProgramData || 'C:\\ProgramData'
    const file = read.readFileSync(path.win32.join(programData, 'Tailscale', 'tailscaled-env.txt'), 'utf8')
    for (const line of file.split(/\r?\n/)) {
      const name = line
        .replace(/^\s*(export\s+)?/, '')
        .split('=')[0]
        .trim()
      if (name && !name.startsWith('#')) names.push(name)
    }
  } catch {
    /* absent, or only Administrators may read it */
  }
  const switches = ['TS_DEBUG_NETSTACK_LOOPBACK_PORT', 'TS_DEBUG_NETSTACK_SUBNETS'].filter((name) => names.includes(name))
  facts.tailscaled.push({ pid, uid: LOCAL_SYSTEM.test(parsed.account) ? 0 : -1, argv, env: switches })
  return facts
}

// ---- macOS ---------------------------------------------------------------------

const XSO_SOCKET = 0x001
const XSO_INPCB = 0x010
const XINPCB_N_MIN = 80 // through the local address
const XSOCKET_N_MIN = 72 // through so_last_pid
const roundUp8 = (value) => (value + 7) & ~7

const ipv4At = (buffer, offset) => `${buffer[offset]}.${buffer[offset + 1]}.${buffer[offset + 2]}.${buffer[offset + 3]}`

// Every TCP socket in the raw answer of `sysctl -b net.inet.tcp.pcblist_n`
// (XNU bsd/netinet/in_pcblist.c get_pcblist_n): [{ localAddress, localPort,
// remoteAddress, remotePort, uid, lastPid }] for IPv4 sockets, or null when
// the answer is not in the expected layout. The answer is an xinpgen header,
// then per socket an xinpcb_n, xsocket_n and more records, each starting
// with its length and kind and padded to 8 bytes, then a closing xinpgen.
// Offsets are of the structures as packed (#pragma pack(4)), little endian
// (every Mac).
export function parsePcblistN(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null
  const headerLength = buffer.readUInt32LE(0)
  if (headerLength < 8 || headerLength > 64) return null
  const sockets = []
  let offset = roundUp8(headerLength)
  let current = null
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset)
    // The closing xinpgen: same length as the header, and the very end. An
    // answer without it was cut short: nothing is read from it.
    if (length === headerLength && offset + roundUp8(length) === buffer.length) return sockets
    if (length < 8 || offset + length > buffer.length) return null
    const kind = buffer.readUInt32LE(offset + 4)
    if (kind === XSO_INPCB) {
      if (length < XINPCB_N_MIN) return null
      const vflag = buffer[offset + 44]
      current =
        vflag & 0x1 // INP_IPV4
          ? {
              remotePort: buffer.readUInt16BE(offset + 16),
              localPort: buffer.readUInt16BE(offset + 18),
              remoteAddress: ipv4At(buffer, offset + 60),
              localAddress: ipv4At(buffer, offset + 76),
              uid: null,
              lastPid: null,
            }
          : null
    } else if (kind === XSO_SOCKET) {
      if (length < XSOCKET_N_MIN) return null
      // A record the kernel did not fill from a socket (a user-space flow,
      // a pcb without a socket) has no handle and a uid of 0 that means
      // nothing: that socket's owner is unknown.
      const handle = buffer.readBigUInt64LE(offset + 8)
      if (current && current.uid === null && handle !== 0n) {
        current.uid = buffer.readUInt32LE(offset + 64)
        current.lastPid = buffer.readInt32LE(offset + 68)
        sockets.push(current)
      }
      current = null
    }
    offset += roundUp8(length)
  }
  return null
}

// The socket at the other end of a loopback connection, from parsed
// pcblist_n: exactly one, or null.
export function pcblistPeer(sockets, { remoteAddress, remotePort, localAddress, localPort }) {
  if (!Array.isArray(sockets)) return null
  const rows = sockets.filter(
    (item) =>
      item.localAddress === remoteAddress &&
      item.localPort === Number(remotePort) &&
      item.remoteAddress === localAddress &&
      item.remotePort === Number(localPort),
  )
  return rows.length === 1 ? rows[0] : null
}

// proof for macOS: { ownerOf, trusted, problem, selfOwner, recognisesSelf }.
// ownerOf answers the uid; the self test also matches the process id, so a
// layout this parser misreads cannot pass it.
export function darwinPeerProof({ run = runProgram } = {}) {
  const peer = async (socket) => {
    if (!loopbackPair(socket)) return null
    const result = await run('/usr/sbin/sysctl', ['-b', 'net.inet.tcp.pcblist_n'], { binary: true, maxBuffer: 64 * 1024 * 1024 })
    if (result.code !== 0) return null
    return pcblistPeer(parsePcblistN(result.stdout), socket)
  }
  const ownerOf = async (socket) => (await peer(socket))?.uid ?? null
  return {
    ownerOf,
    trusted: async (socket) => (await ownerOf(socket)) === 0,
    selfOwner: () => (typeof process.getuid === 'function' ? process.getuid() : null),
    async recognisesSelf(socket) {
      const found = await peer(socket)
      return Boolean(found && found.uid === process.getuid() && found.lastPid === process.pid)
    },
    // As root the self test would expect the very uid that is trusted, and could not catch a misread table.
    problem: () =>
      typeof process.getuid === 'function' && process.getuid() === 0
        ? 'on macOS the server must not run as root: run it as an ordinary user.'
        : null,
  }
}

// `ps -axww -o pid=,uid=,ruid=,svuid=,comm=` rows: [{ pid, ids: [uid, ruid, svuid], command }].
export function psRows(text) {
  const rows = []
  for (const line of String(text).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (match) rows.push({ pid: Number(match[1]), ids: match.slice(2, 5).map(Number), command: match[5] })
  }
  return rows
}

const STANDALONE = /^\/Library\/SystemExtensions\/.+\/io\.tailscale\.ipn\.macsys\.network-extension$/
const OPEN_SOURCE = /(^|\/)tailscaled$/
const APP_STORE = /^\/Applications\/Tailscale\.app\/Contents\/PlugIns\/IPNExtension\.appex\/Contents\/MacOS\/IPNExtension$/

// What macOS says about tailscaled, in hostFacts' shape, plus `appStore`:
// the Mac App Store app's extension runs (as a user). While it runs the
// feature is refused, also beside a root tailscaled: the `tailscale`
// command would then talk to one daemon and the facts describe another. Which process is
// tailscaled: the Standalone app's network extension (installed under
// /Library/SystemExtensions) or a process named tailscaled, and in both cases
// only one that is root in its user, real and saved ids.
export async function darwinFacts({ run = runProgram } = {}) {
  const facts = { tailscaled: [], unreadable: 0, container: null, appStore: false, platform: 'darwin' }
  const list = await run('/bin/ps', ['-axww', '-o', 'pid=,uid=,ruid=,svuid=,comm='])
  if (list.code !== 0) {
    facts.unreadable += 1
    return facts
  }
  for (const row of psRows(list.stdout)) {
    const root = row.ids.every((id) => id === 0)
    if (APP_STORE.test(row.command) && !root) facts.appStore = true
    if (!root) continue
    if (STANDALONE.test(row.command)) {
      // The app's extension takes no proxy flags; its command line is its path.
      facts.tailscaled.push({ pid: row.pid, uid: 0, argv: [row.command], env: null, variant: 'standalone' })
    } else if (OPEN_SOURCE.test(row.command)) {
      const args = await run('/bin/ps', ['-ww', '-o', 'args=', '-p', String(row.pid)])
      const text = String(args.stdout || '').trim()
      // ps shows "(tailscaled)" when it may not read the process's arguments.
      if (args.code !== 0 || !text || /^\(.*\)$/.test(text)) {
        facts.unreadable += 1
        continue
      }
      facts.tailscaled.push({ pid: row.pid, uid: 0, argv: text.split(/\s+/), env: null, variant: 'open-source' })
    }
  }
  return facts
}
