// The peer check and the facts about tailscaled on Windows and macOS
// (src/tailnet-platform.js). The parsers run here on recorded and built
// answers; the last tests run the real check on a Mac and on Windows (CI runs
// this file on both) and must see this process's own connection.
import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import {
  darwinFacts,
  darwinPeerProof,
  netstatPeerPid,
  parsePcblistN,
  pcblistPeer,
  psRows,
  regEnvironmentNames,
  scQc,
  scQueryEx,
  splitWindowsCommandLine,
  windowsFacts,
  windowsPeerProof,
} from '../src/tailnet-platform.js'
import { createTailnetGate, machineFacts, peerProof, proofSelfTest, tailscaledProblem } from '../src/tailnet-proof.js'

const socket = (remotePort, localPort = 4700, extra = {}) => ({
  remoteFamily: 'IPv4',
  remoteAddress: '127.0.0.1',
  remotePort,
  localAddress: '127.0.0.1',
  localPort,
  ...extra,
})
const status = { TUN: true, Version: '1.104.2-t123' }

// ---- Windows -------------------------------------------------------------------

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1044
  TCP    127.0.0.1:4700         0.0.0.0:0              LISTENING       7000
  TCP    127.0.0.1:4700         127.0.0.1:50001        ESTABLISHED     7000
  TCP    127.0.0.1:50001        127.0.0.1:4700         ESTABLISHED     3120
  TCP    127.0.0.1:4700         127.0.0.1:50002        HERGESTELLT     7000
  TCP    127.0.0.1:50002        127.0.0.1:4700         HERGESTELLT     8888
  TCP    [::1]:4700             [::1]:50001            ESTABLISHED     7000
`.replace(/\n/g, '\r\n')

const queryEx = (state, pid) => `
SERVICE_NAME: Tailscale
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : ${state}  ${state === 4 ? 'RUNNING' : 'STOPPED'}
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)
        SERVICE_EXIT_CODE  : 0  (0x0)
        CHECKPOINT         : 0x0
        WAIT_HINT          : 0x0
        PID                : ${pid}
        FLAGS              :
`
const qc = (binary, account = 'LocalSystem') => `[SC] QueryServiceConfig SUCCESS

SERVICE_NAME: Tailscale
        TYPE               : 10  WIN32_OWN_PROCESS
        START_TYPE         : 2   AUTO_START
        ERROR_CONTROL      : 1   NORMAL
        BINARY_PATH_NAME   : ${binary}
        LOAD_ORDER_GROUP   :
        TAG                : 0
        DISPLAY_NAME       : Tailscale
        DEPENDENCIES       : iphlpsvc
        SERVICE_START_NAME : ${account}
`

test('Windows: the owner of the other end of a loopback connection, from netstat -ano', () => {
  assert.equal(netstatPeerPid(NETSTAT, socket(50001)), 3120)
  assert.equal(netstatPeerPid(NETSTAT, socket(50002)), 8888, 'the state column may be in another language')
  assert.equal(netstatPeerPid(NETSTAT, socket(50003)), null, 'no such row')
  assert.equal(
    netstatPeerPid(`${NETSTAT}  TCP    127.0.0.1:50001        127.0.0.1:4700         ESTABLISHED     3121\r\n`, socket(50001)),
    null,
    'two rows: nobody',
  )
  assert.equal(netstatPeerPid('  TCP    127.0.0.1:50001        127.0.0.1:4700         ESTABLISHED     x\r\n', socket(50001)), null)
})

test('Windows: sc.exe, the service command line and its registry environment', () => {
  assert.deepEqual(scQueryEx(queryEx(4, 3120)), { running: true, pid: 3120 })
  assert.deepEqual(scQueryEx(queryEx(1, 0)), { running: false, pid: null })
  assert.deepEqual(scQueryEx('garbage'), { running: false, pid: null })
  assert.deepEqual(scQc(qc('"C:\\Program Files\\Tailscale\\tailscaled.exe"')), {
    binaryPath: '"C:\\Program Files\\Tailscale\\tailscaled.exe"',
    account: 'LocalSystem',
  })
  assert.equal(scQc('nothing'), null)
  assert.deepEqual(splitWindowsCommandLine('"C:\\Program Files\\Tailscale\\tailscaled.exe" --socks5-server=localhost:1055'), [
    'C:\\Program Files\\Tailscale\\tailscaled.exe',
    '--socks5-server=localhost:1055',
  ])
  assert.deepEqual(splitWindowsCommandLine('a\\\\"b c" d'), ['a\\b c', 'd'])
  assert.deepEqual(splitWindowsCommandLine('a\\b  ""'), ['a\\b', ''])
  assert.deepEqual(
    regEnvironmentNames(
      '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\Tailscale\r\n    Environment    REG_MULTI_SZ    TS_DEBUG_NETSTACK_SUBNETS=1\\0FOO=bar\r\n',
    ),
    ['TS_DEBUG_NETSTACK_SUBNETS', 'FOO'],
  )
  assert.deepEqual(regEnvironmentNames('ERROR: The system was unable to find the specified registry key or value.'), [])
})

// A fake of the programs the Windows check runs. `pids`: the service's process
// id at each sc.exe call, in turn.
function windowsRun({
  pids = [3120],
  netstat = NETSTAT,
  binary = '"C:\\Program Files\\Tailscale\\tailscaled.exe"',
  account,
  reg = null,
  prefs = '{"AdvertiseRoutes":null}',
} = {}) {
  const calls = []
  let at = 0
  const run = async (file, args) => {
    calls.push([file, ...args])
    if (/netstat\.exe$/i.test(file)) return { code: 0, stdout: netstat }
    if (/sc\.exe$/i.test(file) && args[0] === 'queryex') {
      const pid = pids[Math.min(at, pids.length - 1)]
      at += 1
      return pid ? { code: 0, stdout: queryEx(4, pid) } : { code: 0, stdout: queryEx(1, 0) }
    }
    if (/sc\.exe$/i.test(file) && args[0] === 'qc') return { code: 0, stdout: qc(binary, account) }
    if (/reg\.exe$/i.test(file)) return reg ? { code: 0, stdout: reg } : { code: 1, stdout: '' }
    if (file === 'tailscale') return prefs === null ? { code: 1, stdout: '' } : { code: 0, stdout: prefs }
    return { code: null, stdout: '' }
  }
  return { run, calls }
}

test('Windows: only a connection from the running Tailscale service’s own process is tailscaled’s', async () => {
  const env = { SystemRoot: 'C:\\Windows' }
  const fake = windowsRun()
  const proof = windowsPeerProof({ run: fake.run, env })
  // Every connection is seen as it is accepted; one that was not is never tailscaled's.
  const seen = (proof, ...sockets) => {
    for (const item of sockets) proof.accepted(item)
    return sockets[0]
  }
  assert.equal(await proof.trusted(socket(50001)), false, 'not seen when it was accepted')
  const s1 = seen(proof, socket(50001))
  assert.equal(await proof.trusted(s1), true)
  assert.ok(
    fake.calls.every(([file]) => file.startsWith('C:\\Windows\\System32\\')),
    'programs by their full path, never looked up in the current folder',
  )
  assert.equal(await proof.trusted(seen(proof, socket(50002))), false, 'another process')
  assert.equal(await proof.trusted(seen(proof, socket(50003))), false, 'no such connection')
  assert.equal(await proof.trusted(seen(proof, socket(50001, 4700, { remoteAddress: '100.64.0.7' }))), false, 'not loopback')
  assert.equal(await proof.trusted(null), false)
  // pids: the service's process id at accept, before and after the netstat lookup.
  const check = async (pids) => {
    const other = windowsPeerProof({ run: windowsRun({ pids }).run, env })
    return other.trusted(seen(other, socket(50001)))
  }
  assert.equal(await check([3120, 3120, 3120]), true)
  assert.equal(await check([3120, 3120, 4000]), false, 'changed during the lookup: it may have been reused')
  assert.equal(await check([3120, 4000, 3120]), false)
  // The service restarted since the connection was accepted, and its new process got the id netstat still shows
  // for a socket whose maker exited long ago.
  assert.equal(await check([4000, 3120, 3120]), false, 'restarted since the connection was accepted')
  assert.equal(await check([0, 3120, 3120]), false, 'not running when the connection was accepted')
  assert.equal(await check([0]), false, 'not running')
  // watch(server): the connection event is what records it.
  const listeners = []
  const watched = windowsPeerProof({ run: windowsRun().run, env })
  watched.watch({ on: (event, listener) => listeners.push([event, listener]) })
  assert.equal(listeners[0][0], 'connection')
  const s2 = socket(50001)
  listeners[0][1](s2)
  assert.equal(await watched.trusted(s2), true)
  // Connections accepted within a second share one read of the service; later ones read it again.
  let clock = 0
  const counted = windowsRun()
  const shared = windowsPeerProof({ run: counted.run, env, now: () => clock })
  const queries = () => counted.calls.filter(([file, verb]) => /sc\.exe$/.test(file) && verb === 'queryex').length
  for (let index = 0; index < 50; index += 1) shared.accepted(socket(51000 + index))
  assert.equal(queries(), 1)
  clock = 1500
  shared.accepted(socket(52000))
  assert.equal(queries(), 2)
  assert.equal(await proof.ownerOf(socket(50002)), 8888)
  assert.equal(proof.selfOwner(), process.pid)
})

test('Windows: what the Service Control Manager says about tailscaled, and when it cannot be believed', async () => {
  const facts = await windowsFacts({ run: windowsRun().run, env: {}, read: { readFileSync: () => '' } })
  assert.deepEqual(facts.tailscaled, [{ pid: 3120, uid: 0, argv: ['C:\\Program Files\\Tailscale\\tailscaled.exe'], env: [] }])
  assert.equal(tailscaledProblem(status, facts), null)

  const noFile = {
    readFileSync: () => {
      throw Object.assign(new Error('no'), { code: 'EACCES' })
    },
  }
  const problem = async (options, read = noFile) =>
    tailscaledProblem(status, await windowsFacts({ run: windowsRun(options).run, env: {}, read }))
  assert.match(await problem({ account: '.\\someone' }), /does not run as root \(LocalSystem on Windows\)/)
  assert.match(await problem({ binary: '"C:\\Program Files\\Tailscale\\tailscaled.exe" --socks5-server=localhost:1055' }), /SOCKS5/)
  assert.match(
    await problem({ binary: '"C:\\Program Files\\Tailscale\\tailscaled.exe" -outbound-http-proxy-listen=:8080' }),
    /outbound HTTP proxy/,
  )
  assert.match(await problem({ binary: '"C:\\Users\\x\\evil.exe"' }), /cannot be read/, 'not tailscaled.exe')
  assert.match(await problem({ pids: [0] }), /no tailscaled process/)
  assert.match(
    await problem({ reg: '    Environment    REG_MULTI_SZ    TS_DEBUG_NETSTACK_LOOPBACK_PORT=1' }),
    /TS_DEBUG_NETSTACK_LOOPBACK_PORT/,
  )
  assert.match(
    await problem({}, { readFileSync: () => '# comment\r\nTS_DEBUG_NETSTACK_SUBNETS=10.0.0.0/8\r\n' }),
    /TS_DEBUG_NETSTACK_SUBNETS/,
  )
  assert.match(tailscaledProblem({ ...status, TUN: false }, facts), /userspace-networking/)
})

// ---- macOS ---------------------------------------------------------------------

// The answer of `sysctl -b net.inet.tcp.pcblist_n`, built as XNU writes it
// (bsd/netinet/in_pcblist.c, structures packed to 4 bytes, little endian).
function pcblist(sockets, { inpcbLength = 104, socketLength = 104 } = {}) {
  const parts = []
  const header = Buffer.alloc(24)
  header.writeUInt32LE(24, 0)
  header.writeUInt32LE(sockets.length, 4)
  parts.push(header)
  const record = (length, kind, fill) => {
    const buffer = Buffer.alloc((length + 7) & ~7)
    buffer.writeUInt32LE(length, 0)
    buffer.writeUInt32LE(kind, 4)
    fill(buffer)
    parts.push(buffer)
  }
  for (const item of sockets) {
    record(inpcbLength, 0x10, (buffer) => {
      if (buffer.length < 80) return
      buffer.writeUInt16BE(item.remotePort, 16)
      buffer.writeUInt16BE(item.localPort, 18)
      buffer[44] = item.ipv6 ? 0x2 : 0x1
      Buffer.from(item.remoteAddress.split('.').map(Number)).copy(buffer, 60)
      Buffer.from(item.localAddress.split('.').map(Number)).copy(buffer, 76)
    })
    record(socketLength, 0x1, (buffer) => {
      if (buffer.length < 72) return
      // The kernel's handle of the socket; a user-space flow has none.
      if (!item.userland) buffer.writeBigUInt64LE(0xffffff8012345678n, 8)
      buffer.writeUInt32LE(item.uid, 64)
      buffer.writeInt32LE(item.lastPid, 68)
    })
    for (const kind of [0x2, 0x4]) record(32, kind, () => {})
    record(88, 0x8, () => {})
    record(312, 0x20, () => {})
  }
  parts.push(Buffer.from(header))
  return Buffer.concat(parts)
}
const mac = (localPort, remotePort, uid, lastPid, extra = {}) => ({
  localAddress: '127.0.0.1',
  localPort,
  remoteAddress: '127.0.0.1',
  remotePort,
  uid,
  lastPid,
  ...extra,
})
const TABLE = [
  mac(4700, 0, 501, 7000, { remoteAddress: '0.0.0.0' }),
  mac(4700, 50001, 501, 7000),
  mac(50001, 4700, 0, 412),
  mac(4700, 50002, 501, 7000),
  mac(50002, 4700, 501, 9999),
  mac(50003, 4700, 0, 412, { ipv6: true }),
]

test('macOS: every socket and its owner, from the kernel’s pcblist_n', () => {
  const sockets = parsePcblistN(pcblist(TABLE))
  assert.equal(sockets.length, 5, 'IPv6 sockets are left out')
  // A user-space flow's record (no socket handle, every other field zero) names nobody, not root.
  const userland = parsePcblistN(pcblist([...TABLE, mac(50009, 4700, 0, 0, { userland: true })]))
  assert.equal(userland.length, 5)
  assert.equal(pcblistPeer(userland, socket(50009)), null)
  assert.deepEqual(pcblistPeer(sockets, socket(50001)), {
    remotePort: 4700,
    localPort: 50001,
    remoteAddress: '127.0.0.1',
    localAddress: '127.0.0.1',
    uid: 0,
    lastPid: 412,
  })
  assert.equal(pcblistPeer(sockets, socket(50002)).uid, 501)
  assert.equal(pcblistPeer(sockets, socket(50003)), null)
  assert.equal(pcblistPeer([...sockets, ...sockets], socket(50001)), null, 'two rows: nobody')
  // Larger structures in a newer macOS: the fields read are at the same place.
  assert.equal(pcblistPeer(parsePcblistN(pcblist(TABLE, { inpcbLength: 120, socketLength: 112 })), socket(50001)).uid, 0)
  // Not the layout this was written for: nothing.
  assert.equal(parsePcblistN(pcblist(TABLE, { inpcbLength: 64 })), null)
  assert.equal(parsePcblistN(pcblist(TABLE, { socketLength: 40 })), null)
  assert.equal(parsePcblistN(Buffer.from([1, 2])), null)
  assert.equal(parsePcblistN(pcblist(TABLE).subarray(0, 300)), null, 'cut short')
})

test('macOS: only a connection from root’s socket is tailscaled’s', async () => {
  const calls = []
  const run = async (file, args, options) => {
    calls.push([file, ...args, options?.binary])
    return { code: 0, stdout: pcblist(TABLE) }
  }
  const proof = darwinPeerProof({ run })
  assert.equal(await proof.trusted(socket(50001)), true)
  assert.equal(await proof.trusted(socket(50002)), false, 'a user’s program')
  assert.equal(await proof.trusted(socket(50003)), false, 'no such connection')
  assert.equal(await proof.trusted(socket(50001, 4700, { remoteFamily: 'IPv6', remoteAddress: '::1' })), false)
  assert.deepEqual(calls[0], ['/usr/sbin/sysctl', '-b', 'net.inet.tcp.pcblist_n', true])
  assert.equal(await darwinPeerProof({ run: async () => ({ code: 1, stdout: Buffer.alloc(0) }) }).trusted(socket(50001)), false)
})

const PS = (rows) => rows.map(([pid, ids, command]) => `  ${pid}   ${ids.join('   ')} ${command}`).join('\n')
const STANDALONE =
  '/Library/SystemExtensions/0A1B2C3D-0000-1111-2222-333344445555/io.tailscale.ipn.macsys.network-extension.systemextension/Contents/MacOS/io.tailscale.ipn.macsys.network-extension'

function darwinRun(rows, args = {}, prefs = '{"AdvertiseRoutes":null}') {
  return async (file, argv) => {
    if (file === 'tailscale') return prefs === null ? { code: 1, stdout: '' } : { code: 0, stdout: prefs }
    if (argv.includes('args=')) {
      const pid = argv[argv.length - 1]
      return pid in args ? { code: 0, stdout: `${args[pid]}\n` } : { code: 1, stdout: '' }
    }
    return { code: 0, stdout: PS(rows) }
  }
}

test('macOS: which process is tailscaled, and the App Store app refused with the fix', async () => {
  assert.deepEqual(psRows('  1   0   0   0 /sbin/launchd\n  bad\n'), [{ pid: 1, ids: [0, 0, 0], command: '/sbin/launchd' }])
  const facts = async (rows, args) => darwinFacts({ run: darwinRun(rows, args) })

  const standalone = await facts([
    [1, [0, 0, 0], '/sbin/launchd'],
    [412, [0, 0, 0], STANDALONE],
  ])
  assert.equal(standalone.tailscaled.length, 1)
  assert.equal(standalone.tailscaled[0].variant, 'standalone')
  assert.equal(tailscaledProblem(status, standalone), null)

  const openSource = await facts([[300, [0, 0, 0], '/usr/local/bin/tailscaled']], { 300: '/usr/local/bin/tailscaled --state=/var/lib/x' })
  assert.equal(tailscaledProblem(status, openSource), null)
  const socks = await facts([[300, [0, 0, 0], '/usr/local/bin/tailscaled']], {
    300: '/usr/local/bin/tailscaled --socks5-server=localhost:1055',
  })
  assert.match(tailscaledProblem(status, socks), /SOCKS5/)
  const hidden = await facts([[300, [0, 0, 0], '/usr/local/bin/tailscaled']], { 300: '(tailscaled)' })
  assert.match(tailscaledProblem(status, hidden), /command line cannot be read/)

  // A user's program called tailscaled, setuid or not, is not tailscaled.
  const fake = await facts([
    [500, [501, 501, 501], '/Users/x/tailscaled'],
    [501, [0, 501, 0], '/Users/x/tailscaled'],
  ])
  assert.match(tailscaledProblem(status, fake), /no tailscaled process of root/)

  const APP = '/Applications/Tailscale.app/Contents/PlugIns/IPNExtension.appex/Contents/MacOS/IPNExtension'
  const appStore = await facts([[700, [501, 501, 501], APP]])
  assert.match(tailscaledProblem(status, appStore), /Mac App Store version of Tailscale runs as your user.*Standalone/)
  // Beside a root tailscaled too: the tailscale command would talk to the one, the facts describe the other.
  const both = await facts(
    [
      [700, [501, 501, 501], APP],
      [300, [0, 0, 0], '/opt/homebrew/bin/tailscaled'],
    ],
    { 300: '/opt/homebrew/bin/tailscaled' },
  )
  assert.match(tailscaledProblem(status, both), /Mac App Store version/)
  // ps may show another user's App Store extension by its short name: that counts too (it can only switch the feature off).
  const short = await facts([
    [701, [502, 502, 502], 'IPNExtension'],
    [412, [0, 0, 0], STANDALONE],
  ])
  assert.match(tailscaledProblem(status, short), /Mac App Store version/)

  assert.match(
    tailscaledProblem(
      status,
      await facts(
        [
          [412, [0, 0, 0], STANDALONE],
          [300, [0, 0, 0], '/usr/local/bin/tailscaled'],
        ],
        { 300: '/usr/local/bin/tailscaled' },
      ),
    ),
    /more than one tailscaled/,
  )
})

test('on Windows and macOS, not on a subnet router or exit node: tailscaled would dial routed connections itself', async () => {
  const self = { TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'], AllowedIPs: ['100.64.0.1/32', 'fd7a:115c:a1e0::1/128'] }
  const plain = { ...status, Self: self }
  const win = await windowsFacts({ run: windowsRun().run, env: {}, read: { readFileSync: () => '' } })
  const mac = await darwinFacts({ run: darwinRun([[412, [0, 0, 0], STANDALONE]]) })
  for (const facts of [win, mac]) {
    assert.equal(tailscaledProblem(plain, facts), null)
    assert.match(tailscaledProblem({ ...status, Self: { ...self, ExitNodeOption: true } }, facts), /subnet router or exit node/)
    assert.match(tailscaledProblem({ ...status, Self: { ...self, PrimaryRoutes: ['192.168.1.0/24'] } }, facts), /subnet router/)
    assert.match(
      tailscaledProblem({ ...status, Self: { ...self, AllowedIPs: [...self.AllowedIPs, '127.0.0.0/8'] } }, facts),
      /subnet router/,
    )
  }
  // Advertised but not approved: status does not show it, tailscaled's prefs do.
  for (const facts of [
    await windowsFacts({
      run: windowsRun({ prefs: '{"AdvertiseRoutes":["0.0.0.0/0","::/0"]}' }).run,
      env: {},
      read: { readFileSync: () => '' },
    }),
    await darwinFacts({ run: darwinRun([[412, [0, 0, 0], STANDALONE]], {}, '{"AdvertiseRoutes":["10.0.0.0/8"]}') }),
  ])
    assert.match(tailscaledProblem(plain, facts), /subnet router or exit node/)
  // Prefs that cannot be read: whether it routes cannot be told.
  for (const facts of [
    await windowsFacts({ run: windowsRun({ prefs: null }).run, env: {}, read: { readFileSync: () => '' } }),
    await darwinFacts({ run: darwinRun([[412, [0, 0, 0], STANDALONE]], {}, 'not json') }),
  ])
    assert.match(tailscaledProblem(plain, facts), /settings cannot be read/)
  // Linux: tailscaled routes in the kernel unless the debug switches say otherwise (checked apart).
  assert.equal(tailscaledProblem({ ...status, Self: { ...self, ExitNodeOption: true } }, { ...win, platform: undefined }), null)
})

test('macOS: the server must not run as root, where the self test could not catch a misread table', () => {
  const proof = darwinPeerProof({ run: async () => ({ code: 1, stdout: Buffer.alloc(0) }) })
  const root = process.getuid?.() === 0
  assert.equal(proof.problem() === null, !root)
})

// ---- Shared --------------------------------------------------------------------

test('the check for this system, and the facts for it', async () => {
  assert.equal(typeof peerProof({ platform: 'win32' }).selfOwner, 'function')
  assert.equal(peerProof({ platform: 'win32' }).selfOwner(), process.pid)
  assert.equal(typeof peerProof({ platform: 'darwin' }).recognisesSelf, 'function')
  assert.match(peerProof({ platform: 'freebsd' }).problem(), /needs Linux, macOS or Windows/)
  const facts = await machineFacts({ platform: 'win32', run: windowsRun().run, env: {}, read: { readFileSync: () => '' } })
  assert.equal(facts.tailscaled[0].pid, 3120)
  const mac = await machineFacts({ platform: 'darwin', run: darwinRun([[412, [0, 0, 0], STANDALONE]]) })
  assert.equal(mac.tailscaled[0].variant, 'standalone')
})

async function listening() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

test('the self test: a check that cannot say who this process is, or misreads it, is not used', async () => {
  const server = await listening()
  try {
    assert.match(await proofSelfTest(server, { ownerOf: () => 1, selfOwner: () => null }), /cannot say who this process is/)
    assert.match(await proofSelfTest(server, { ownerOf: async () => process.pid + 1, selfOwner: () => process.pid }), /did not recognise/)
    assert.match(
      await proofSelfTest(server, {
        ownerOf: async () => {
          throw new Error('boom')
        },
        selfOwner: () => process.pid,
      }),
      /did not recognise/,
    )
    assert.equal(await proofSelfTest(server, { ownerOf: async () => process.pid, selfOwner: () => process.pid }), null)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('Windows: the self test passes when netstat names this process for its own test connection', async () => {
  const server = await listening()
  let seen = null
  server.on('connection', (accepted) => {
    seen = accepted
  })
  const run = async (file) => {
    if (!/netstat\.exe$/i.test(file) || !seen) return { code: 1, stdout: '' }
    const row = `  TCP    127.0.0.1:${seen.remotePort}   127.0.0.1:${seen.localPort}   ESTABLISHED     ${process.pid}\r\n`
    return { code: 0, stdout: row }
  }
  try {
    assert.equal(await proofSelfTest(server, windowsPeerProof({ run, env: {} })), null)
    const other = async (file) => {
      const answer = await run(file)
      return { ...answer, stdout: String(answer.stdout).replace(String(process.pid), String(process.pid + 1)) }
    }
    assert.match(await proofSelfTest(server, windowsPeerProof({ run: other, env: {} })), /did not recognise/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a suspension while a check is in flight is not undone by the check finishing', async () => {
  let release
  const proof = { trusted: () => new Promise((resolve) => (release = resolve)) }
  const here = { stableId: 'nSELF', addresses: ['100.64.0.1'] }
  const whois = async () => ({ login: 'a@b.c', userId: 'u1', tagged: false, expired: false, stableId: 'nPEER', addresses: ['100.64.0.9'] })
  const gate = createTailnetGate({ secret: 's'.repeat(43), proof, whois, self: () => here, interfaces: () => ({}) })
  const req = {
    url: `/_ts/${'s'.repeat(43)}/`,
    headers: { 'tailscale-user-login': 'a@b.c', 'x-forwarded-for': '100.64.0.9' },
    rawHeaders: ['Tailscale-User-Login', 'a@b.c', 'X-Forwarded-For', '100.64.0.9'],
    socket: { remotePort: 1 },
  }
  const admitted = gate.admit(req)
  await new Promise((resolve) => setImmediate(resolve))
  gate.suspend('test')
  release(true)
  await admitted
  gate.resume()
  assert.equal(gate.identityOf(req), null, 'not believed after resume either')
  // The same, without a suspension: believed.
  const again = { ...req, url: `/_ts/${'s'.repeat(43)}/`, socket: { remotePort: 2 } }
  const second = gate.admit(again)
  await new Promise((resolve) => setImmediate(resolve))
  release(true)
  await second
  assert.equal(gate.identityOf(again)?.login, 'a@b.c')
})

test('the gate waits for an asynchronous check, and asks it once per connection', async () => {
  let asked = 0
  const proof = {
    trusted: async () => {
      asked += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return false
    },
  }
  const gate = createTailnetGate({ secret: 's'.repeat(43), proof, whois: async () => null, self: () => null })
  const connection = { remotePort: 1 }
  const request = () => ({
    url: `/_ts/${'s'.repeat(43)}/`,
    headers: { 'tailscale-user-login': 'a@b.c', 'x-forwarded-for': '100.64.0.9' },
    rawHeaders: ['Tailscale-User-Login', 'a@b.c', 'X-Forwarded-For', '100.64.0.9'],
    socket: connection,
  })
  const [one, two] = [request(), request()]
  await Promise.all([gate.admit(one), gate.admit(two)])
  assert.equal(asked, 1)
  assert.equal(gate.identityOf(one), null)
  assert.equal(gate.identityOf(two), null)
})

// ---- The real thing ------------------------------------------------------------

test('on macOS the real check sees who opened a loopback connection', { skip: process.platform !== 'darwin' }, async () => {
  const server = await listening()
  try {
    assert.equal(await proofSelfTest(server, peerProof()), null, 'pcblist_n is read and parsed as XNU writes it')
    const accepted = new Promise((resolve) => server.once('connection', resolve))
    const client = net.connect(server.address().port, '127.0.0.1')
    const socket = await accepted
    try {
      const proof = peerProof()
      assert.equal(await proof.ownerOf(socket), process.getuid())
      assert.equal(await proof.trusted(socket), process.getuid() === 0)
    } finally {
      client.destroy()
      socket.destroy()
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('on Windows the real check sees who opened a loopback connection', { skip: process.platform !== 'win32' }, async () => {
  const server = await listening()
  try {
    assert.equal(await proofSelfTest(server, peerProof()), null, 'netstat -ano names this process')
    const accepted = new Promise((resolve) => server.once('connection', resolve))
    const client = net.connect(server.address().port, '127.0.0.1')
    const socket = await accepted
    try {
      const proof = peerProof()
      assert.equal(await proof.ownerOf(socket), process.pid)
      assert.equal(await proof.trusted(socket), false, 'this process is not the Tailscale service')
    } finally {
      client.destroy()
      socket.destroy()
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
