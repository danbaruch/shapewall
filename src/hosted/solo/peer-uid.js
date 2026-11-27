// Which OS user is on the other end of a loopback connection (Linux), for the
// solo engine's sign-in gate (src/hosted/solo/signin.js): the engine is one
// person's, and a loopback peer may be another user on the same machine.
//
// The kernel lists every TCP socket in /proc/net/tcp and /proc/net/tcp6 with
// the uid that owns it. For a connection the engine accepted (local port S,
// peer port P), the peer's own socket is the row whose local port is P and
// whose remote port is S, on a loopback address. Its uid must be ours.
//
// Fails closed: no such row, two rows that disagree, or a table that cannot
// be read means "not this user". The answer is kept per socket (a keep-alive
// connection keeps its peer), so the tables are read once per connection.
// On other systems there is no such table; `sameUserPeer` returns null there
// and the gate relies on the unguessable host name and the one-time link.
import fs from 'node:fs'

const TABLES = ['/proc/net/tcp', '/proc/net/tcp6']
const cache = new WeakMap()

// IPv4 127.0.0.0/8 (little-endian hex: the last byte first), IPv6 ::1, and
// IPv4-mapped 127.x in the tcp6 table.
function loopbackHex(hex) {
  const value = hex.toUpperCase()
  if (value.length === 8) return value.endsWith('7F')
  if (value === '00000000000000000000000001000000') return true
  return value.length === 32 && value.startsWith('0000000000000000FFFF0000') && value.endsWith('7F')
}

// The uids that own the socket at local port `peerPort` connected to remote port `serverPort`, from table texts.
export function peerUids(tables, { peerPort, serverPort }) {
  const uids = new Set()
  for (const text of tables) {
    for (const line of String(text || '')
      .split('\n')
      .slice(1)) {
      const fields = line.trim().split(/\s+/)
      if (fields.length < 8) continue
      const [localAddr, localPort] = fields[1].split(':')
      const [remoteAddr, remotePort] = fields[2].split(':')
      if (parseInt(localPort, 16) !== peerPort || parseInt(remotePort, 16) !== serverPort) continue
      if (!loopbackHex(localAddr) || !loopbackHex(remoteAddr)) continue
      const uid = Number(fields[7])
      if (Number.isInteger(uid)) uids.add(uid)
    }
  }
  return uids
}

// Whether the peer of this accepted socket is the user this process runs as.
// null where the system has no socket table (not Linux).
export function sameUserPeer(
  socket,
  { platform = process.platform, uid = process.getuid?.(), read = (file) => fs.readFileSync(file, 'utf8') } = {},
) {
  if (platform !== 'linux' || !Number.isInteger(uid)) return null
  if (!socket) return false
  if (cache.has(socket)) return cache.get(socket)
  let answer = false
  try {
    const peerPort = socket.remotePort
    const serverPort = socket.localPort
    if (Number.isInteger(peerPort) && Number.isInteger(serverPort)) {
      const tables = []
      for (const file of TABLES) {
        try {
          tables.push(read(file))
        } catch (error) {
          // No IPv6 on this kernel: tcp6 is missing, which is fine; anything else is not.
          if (!(file.endsWith('6') && error?.code === 'ENOENT')) throw error
        }
      }
      const uids = peerUids(tables, { peerPort, serverPort })
      answer = uids.size === 1 && uids.has(uid)
    }
  } catch {
    answer = false
  }
  cache.set(socket, answer)
  return answer
}
