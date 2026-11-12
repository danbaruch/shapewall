// Tailnet sign-in (`shapewall hosted --tailscale --tailnet-sign-in`): the
// identity headers are believed only on requests that came through the serve
// proxy, each tailnet login is its own account, and an admin still decides
// who is in a workspace. There is no tailnet here: test/tailnet-helpers.js
// stands in for tailscaled's proxy and for the proof of where a connection
// came from; the server is the real one.

import assert from 'node:assert/strict'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import test, { after } from 'node:test'
import { startHosted } from '../src/hosted/server.js'
import { reachesLocalPort, serveProblem } from '../src/hosted/tailscale.js'
import {
  cleanTailnetLogin,
  createTailnetGate,
  decodeHeaderValue,
  forwardedTailnetAddress,
  hostFacts,
  parseIdentity,
  peerOwner,
  procAddress,
  procPeerProof,
  tailscaledProblem,
  whoisAnswer,
} from '../src/hosted/tailnet-identity.js'
import { selfFromStatus } from '../src/tailnet-proof.js'
import { handleFromLogin } from '../src/hosted/tailnet.js'
import { createProject, invite, reauth, signUp } from './hosted-helpers.js'
import { tempDir } from './helpers.js'
import { TAILNET_HOST, TAILNET_ORIGIN, fakeTailscale, me, plainFacts, qEncode, startTailnet } from './tailnet-helpers.js'

const servers = []
after(async () => {
  for (const server of servers) await server.close()
})
async function tailnet(name, options) {
  const server = await startTailnet(name, options)
  servers.push(server)
  return server
}
const ADA = { login: 'ada@example.com', name: 'Ada Lovelace' }
const BEN = { login: 'ben@example.com', name: 'Ben' }
const CYD = { login: 'cyd@example.com', name: 'Cyd' }
const call = (browser, method, url, body) => browser.call(method, url, body === undefined ? {} : { body })

// The first account: the setup link, opened through the tailnet, with a passkey, and "Also sign me in from this tailnet login" ticked.
async function claimWithPasskey(server, device, handle = 'ada') {
  return signUp(server.as(device), { handle, displayName: handle, linkTailnet: true })
}
// A tailnet login joins by an invite made for it; returns its browser.
async function joinByInvite(server, owner, device, role = 'member') {
  const made = await owner.browser.post(`/api/workspaces/${owner.workspaceId}/invites`, { role, tailnetLogin: device.who.login })
  assert.equal(made.status, 201, made.text)
  const browser = device.browser()
  const joined = await browser.post('/auth/tailnet/join', {})
  assert.equal(joined.status, 201, joined.text)
  return { browser, user: joined.json.user, invite: made.json }
}

// ---- The headers as values ------------------------------------------------------

test('header values: plain ASCII, RFC 2047 encoded words in UTF-8, and nothing else', () => {
  assert.equal(decodeHeaderValue('ada@example.com'), 'ada@example.com')
  assert.equal(decodeHeaderValue(qEncode('Adá Lövelace')), 'Adá Lövelace')
  assert.equal(decodeHeaderValue('=?UTF-8?Q?Ad=C3=A1?= =?utf-8?q?_L?='), 'Adá L', 'several words are one text')
  assert.equal(decodeHeaderValue(`=?utf-8?b?${Buffer.from('Adá').toString('base64')}?=`), 'Adá')
  assert.equal(decodeHeaderValue(''), '')
  for (const bad of [
    '=?iso-8859-1?q?Ad=E1?=', // another character set
    '=?utf-8?q?Ad=ZZ?=', // a broken escape
    '=?utf-8?q?Ad=C3?=', // not UTF-8
    '=?utf-8?q?ada?= trailing', // encoded and plain mixed
    '=?utf-8?x?ada?=',
    '=?utf-8?b?!!!?=',
    'Adá', // raw non-ASCII
    'ada\u0000@example.com',
    undefined,
    42,
  ])
    assert.equal(decodeHeaderValue(bad), null, String(bad))
})

test('a login is user@domain in plain ASCII; a handle is made from it', () => {
  assert.equal(cleanTailnetLogin(' Ada@Example.COM '), 'ada@example.com')
  assert.equal(cleanTailnetLogin('ben@github'), 'ben@github')
  for (const bad of [
    '',
    'ada',
    '@example.com',
    'ada@',
    'ada @example.com',
    'ada@exa mple.com',
    'a,b@example.com',
    'ada@example.com, ben@example.com',
    `${'a'.repeat(80)}@example.com`,
    'adá@example.com',
    null,
  ])
    assert.equal(cleanTailnetLogin(bad), null, String(bad))
  assert.equal(handleFromLogin('ada.lovelace@example.com'), 'ada-lovelace')
  assert.equal(handleFromLogin('7up@example.com'), 'u-7up')
  assert.equal(handleFromLogin('a@example.com'), 'axx')
})

const fakeRequest = (pairs) => {
  const headers = {}
  const rawHeaders = []
  for (const [name, value] of pairs) {
    rawHeaders.push(name, value)
    const key = name.toLowerCase()
    headers[key] = key in headers ? `${headers[key]}, ${value}` : value
  }
  return { headers, rawHeaders }
}

test('identity headers name a person only when there is exactly one clean login and no Funnel mark', () => {
  assert.deepEqual(
    parseIdentity(
      fakeRequest([
        ['Tailscale-User-Login', 'Ada@example.com'],
        ['Tailscale-User-Name', qEncode('Adá')],
      ]),
    ),
    {
      login: 'ada@example.com',
      name: 'Adá',
    },
  )
  assert.equal(parseIdentity(fakeRequest([['Tailscale-User-Login', 'ada@example.com']])).name, 'ada', 'no name: the login says it')
  const problem = (pairs) => parseIdentity(fakeRequest(pairs)).problem
  assert.equal(problem([]), 'absent')
  assert.equal(problem([['Tailscale-User-Login', '']]), 'empty')
  assert.equal(problem([['Tailscale-User-Login', '   ']]), 'empty')
  assert.equal(
    problem([
      ['Tailscale-User-Login', 'ada@example.com'],
      ['tailscale-user-login', 'ada@example.com'],
    ]),
    'repeated',
    'even the same value twice',
  )
  assert.equal(
    problem([
      ['Tailscale-User-Login', 'ada@example.com'],
      ['Tailscale-User-Login', 'ben@example.com'],
    ]),
    'repeated',
  )
  assert.equal(problem([['Tailscale-User-Login', 'ada@example.com, ben@example.com']]), 'not_a_login')
  assert.equal(problem([['Tailscale-User-Login', '=?iso-8859-1?q?ada?=']]), 'encoding')
  assert.equal(problem([['Tailscale-User-Login', 'tagged-devices']]), 'not_a_login')
  assert.equal(
    problem([
      ['Tailscale-User-Login', 'ada@example.com'],
      ['Tailscale-Funnel-Request', '?1'],
    ]),
    'funnel',
  )
  // Tailscale strips the underscore spelling too; here it is simply another header.
  assert.equal(problem([['Tailscale_User_Login', 'ada@example.com']]), 'absent')
})

// ---- Whose connection it is ---------------------------------------------------------

const PROC_TABLE = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:125C 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0000000000000000 100 0 0 10 0
   1: 0100007F:C350 0100007F:125C 01 00000000:00000000 00:00000000 00000000     0        0 22222 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:C351 0100007F:125C 01 00000000:00000000 00:00000000 00000000  1001        0 33333 1 0000000000000000 20 4 30 10 -1
   3: 0100007F:125C 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 44444 1 0000000000000000 20 4 30 10 -1`

test('the peer of a loopback connection: its owner comes from /proc/net/tcp, by the four addresses of the connection', () => {
  assert.equal(procAddress('127.0.0.1', 4700, 'LE'), '0100007F:125C')
  assert.equal(procAddress('127.0.0.1', 4700, 'BE'), '7F000001:125C')
  assert.equal(procAddress('not an address', 1), null)
  const ours = { localAddress: '127.0.0.1', localPort: 4700, remoteAddress: '127.0.0.1' }
  assert.equal(peerOwner(PROC_TABLE, { ...ours, remotePort: 0xc350 }, 'LE'), 0, 'opened by root (tailscaled)')
  assert.equal(peerOwner(PROC_TABLE, { ...ours, remotePort: 0xc351 }, 'LE'), 1001, 'opened by another user of the machine')
  assert.equal(peerOwner(PROC_TABLE, { ...ours, remotePort: 0xc352 }, 'LE'), null, 'no such socket: nobody')
  assert.equal(peerOwner(`${PROC_TABLE}\n${PROC_TABLE.split('\n')[2]}`, { ...ours, remotePort: 0xc350 }, 'LE'), null, 'two rows: nobody')

  const socket = (remotePort, more = {}) => ({ remoteFamily: 'IPv4', ...ours, remotePort, ...more })
  const proof = procPeerProof({ read: () => PROC_TABLE, platform: 'linux' })
  assert.equal(proof.problem(), null)
  // The table above is little-endian; skip the lookups on a big-endian machine.
  if (procAddress('127.0.0.1', 1) === '0100007F:0001') {
    assert.equal(proof.trusted(socket(0xc350)), true)
    assert.equal(proof.trusted(socket(0xc351)), false, 'a local program of another user')
    assert.equal(proof.trusted(socket(0xc352)), false)
  }
  assert.equal(proof.trusted(socket(0xc350, { remoteFamily: 'IPv6' })), false)
  assert.equal(proof.trusted(socket(0xc350, { remoteAddress: '100.64.0.7' })), false, 'not loopback: never')
  assert.equal(proof.trusted(null), false)
  const unreadable = procPeerProof({
    read: () => {
      throw Object.assign(new Error('no'), { code: 'EACCES' })
    },
    platform: 'linux',
  })
  assert.match(unreadable.problem(), /cannot be read \(EACCES\)/)
  assert.equal(unreadable.trusted(socket(0xc350)), false)
  assert.match(procPeerProof({ platform: 'darwin' }).problem(), /needs Linux/)
  assert.match(procPeerProof({ read: () => 'something else', platform: 'linux' }).problem(), /does not list socket owners/)
})

test('on Linux the real check sees who opened a loopback connection', { skip: process.platform !== 'linux' }, async () => {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const accepted = new Promise((resolve) => server.once('connection', resolve))
  const client = net.connect(server.address().port, '127.0.0.1')
  const socket = await accepted
  try {
    const mine = process.getuid()
    assert.equal(procPeerProof().ownerOf(socket), mine, 'this process opened it')
    // Only root's sockets are tailscaled's: there is no way to name another user.
    assert.equal(procPeerProof().trusted(socket), mine === 0, 'a local program of an ordinary user is not believed')
  } finally {
    client.destroy()
    socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('the gate: the secret, a connection from tailscaled, tailscaled’s own whois and clean headers, all of them, or nobody', async () => {
  const secret = 's'.repeat(43)
  const tailscaled = { remotePort: 1 }
  const local = { remotePort: 2 }
  const lines = []
  const asked = []
  let clock = 0
  const owners = new Map([
    ['100.64.0.7', { login: 'ada@example.com', tagged: false, stableId: 'nADA', addresses: ['100.64.0.7'] }],
    ['100.64.0.8', { login: 'ben@example.com', tagged: false, stableId: 'nBEN', addresses: ['100.64.0.8'] }],
    ['100.64.0.9', { login: 'ada@example.com', tagged: true, stableId: 'nTAG', addresses: ['100.64.0.9'] }],
    // The server's own node, under an address the server did not list, and a node that also holds one of its addresses.
    ['100.64.0.20', { login: 'ada@example.com', tagged: false, stableId: 'nSELF', addresses: ['100.64.0.20'] }],
    [
      '100.64.0.21',
      { login: 'ada@example.com', tagged: false, stableId: 'nOTHER', addresses: ['100.64.0.21', 'fd7a:115c:a1e0:0:0:0:0:1'] },
    ],
    ['100.64.0.22', { login: 'ada@example.com', tagged: false, stableId: null, addresses: [] }],
    ['100.64.0.1', { login: 'ada@example.com', tagged: false, stableId: 'nSELF', addresses: ['100.64.0.1'] }],
    ['fd7a:115c:a1e0::1', { login: 'ada@example.com', tagged: false, stableId: 'nSELF', addresses: [] }],
  ])
  let here = { stableId: 'nSELF', addresses: ['100.64.0.1', 'fd7a:115c:a1e0:0:0:0:0:1'] }
  const gate = createTailnetGate({
    secret,
    proof: { trusted: (socket) => socket?.remotePort === 1 },
    whois: async (address) => {
      asked.push(address)
      if (address === '100.64.0.66') throw new Error('tailscale is not answering')
      return owners.get(address) || null
    },
    self: () => here,
    log: (line) => lines.push(line),
    now: () => clock,
  })
  assert.throws(() => createTailnetGate({ secret: 'short', proof: {}, whois: async () => null }), /serve secret/)
  const request = (socket, url, pairs) => ({ ...fakeRequest(pairs), socket, url })
  const ada = (address = '100.64.0.7') => [
    ['Tailscale-User-Login', 'ada@example.com'],
    ['X-Forwarded-For', address],
  ]
  const who = async (req) => {
    assert.equal(await gate.admit(req), true)
    return gate.identityOf(req)
  }
  const through = `/_ts/${secret}`
  // Everything in place: believed, and the secret is gone from the path the application sees.
  const good = request(tailscaled, `${through}/auth/me?x=1`, ada())
  assert.deepEqual(await who(good), { login: 'ada@example.com', name: 'ada' })
  assert.equal(good.url, '/auth/me?x=1')
  const root = request(tailscaled, through, ada())
  await who(root)
  assert.equal(root.url, '/', 'the mount point itself is the root')
  // 1. No secret: a raw TCP forward that tailscaled itself dialled, or any direct request. Never asked who it is.
  const forwarded = request(tailscaled, '/auth/me', ada())
  assert.equal(await who(forwarded), null)
  assert.equal(forwarded.url, '/auth/me')
  // 2. The secret, from a socket that is not tailscaled's: a local user who read the serve config.
  assert.equal(await who(request(local, `${through}/auth/me`, ada())), null)
  assert.equal(await who(request(undefined, `${through}/auth/me`, ada())), null)
  // 3. tailscaled does not vouch: another person's device, a tagged device, an unknown address,
  //    no address, two addresses, an address outside the tailnet, or tailscaled not answering.
  for (const [label, pairs] of [
    ['the address is ben’s device', ada('100.64.0.8')],
    ['a tagged device', ada('100.64.0.9')],
    ['nobody’s address', ada('100.64.0.10')],
    ['whois fails', ada('100.64.0.66')],
    ['no X-Forwarded-For', [['Tailscale-User-Login', 'ada@example.com']]],
    ['two X-Forwarded-For', [...ada(), ['X-Forwarded-For', '100.64.0.7']]],
    ['a list in X-Forwarded-For', ada('100.64.0.7, 100.64.0.7')],
    ['not a tailnet address', ada('127.0.0.1')],
    ['not a tailnet address (public)', ada('203.0.113.9')],
  ])
    assert.equal(await who(request({ ...tailscaled, proven: label }, `${through}/x`, pairs)), null, label)
  // 5. THIS MACHINE. A program on the server's machine asks for the serve URL itself: tailscaled's own
  //    listener answers, the source is the machine's own tailnet address, whois names its owner, serve
  //    sets the owner's login and dials loopback as root with the secret. Everything above passes.
  for (const [label, address] of [
    ['its own IPv4 address', '100.64.0.1'],
    ['its own IPv6 address', 'fd7a:115c:a1e0::1'],
    ['its own IPv6 address, spelled out', 'FD7A:115C:A1E0:0:0:0:0:1'],
    ['an address whois gives to this very node', '100.64.0.20'],
    ['a node that holds one of this machine’s addresses', '100.64.0.21'],
    ['a node whois gives no id for', '100.64.0.22'],
  ]) {
    const fromHere = request({ remotePort: 1, label }, `${through}/x`, ada(address))
    assert.equal(await who(fromHere), null, label)
    assert.equal(gate.ownMachine(fromHere), !label.includes('no id'), label)
  }
  assert.equal(gate.ownMachine(good), false)
  // When this node cannot be determined, nobody is believed.
  here = null
  assert.equal(await who(request({ remotePort: 1 }, `${through}/x`, ada())), null, 'fail closed')
  here = { stableId: 'nSELF', addresses: ['100.64.0.1', 'fd7a:115c:a1e0:0:0:0:0:1'] }
  assert.ok(await who(request({ remotePort: 1 }, `${through}/x`, ada())))
  const bare = createTailnetGate({ secret, proof: { trusted: () => true }, whois: async (address) => owners.get(address) })
  const unknownSelf = request({ remotePort: 1 }, `${through}/x`, ada())
  assert.equal(await bare.admit(unknownSelf), true)
  assert.equal(bare.identityOf(unknownSelf), null, 'a gate that was not told which node this is believes nobody')
  // 4. The headers: twice, with a Funnel mark.
  assert.equal(await who(request(tailscaled, `${through}/x`, [...ada(), ['Tailscale-User-Login', 'ada@example.com']])), null)
  assert.equal(await who(request(tailscaled, `${through}/x`, [...ada(), ['Tailscale-Funnel-Request', '?1']])), null)
  assert.equal(await who(request(tailscaled, `${through}/x`, [])), null, 'no identity headers: anonymous, quietly')
  assert.equal(gate.identityOf(null), null)
  assert.equal(gate.identityOf(request(tailscaled, `${through}/x`, ada())), null, 'a request that was never admitted is nobody')
  // A wrong secret is answered 404 and nothing more; no line anywhere holds the real one.
  for (const url of [`/_ts/${'x'.repeat(43)}/auth/me`, `/_ts/${secret}x/auth/me`, `/_ts/${secret.slice(1)}`, '/_ts/', '/_ts/x?y']) {
    const answer = { status: 0, body: '' }
    const res = { writeHead: (status) => (answer.status = status), end: (body) => (answer.body = body) }
    assert.equal(await gate.admit(request(tailscaled, url, ada()), res), false, url)
    assert.deepEqual(answer, { status: 404, body: 'Not found' })
  }
  let destroyed = false
  assert.equal(await gate.admit({ ...request(tailscaled, '/_ts/nope', ada()), socket: { destroy: () => (destroyed = true) } }), false)
  assert.equal(destroyed, true, 'an upgrade with a wrong secret is dropped')
  assert.ok(lines.length >= 1 && lines.length <= 2, 'ignored headers are logged, once a minute at most')
  assert.ok(lines.every((line) => !line.includes(secret)))
  // whois is asked once per connection and address for a minute, then again.
  const before = asked.filter((address) => address === '100.64.0.7').length
  await who(request(tailscaled, `${through}/a`, ada()))
  assert.equal(asked.filter((address) => address === '100.64.0.7').length, before)
  clock += 61_000
  owners.delete('100.64.0.7')
  assert.equal(
    await who(request(tailscaled, `${through}/a`, ada())),
    null,
    'the device left the tailnet: not believed on the open connection either',
  )
  owners.set('100.64.0.7', { login: 'ada@example.com', tagged: false, stableId: 'nADA', addresses: ['100.64.0.7'] })
  clock += 61_000
  // Suspended: nobody, also for a request admitted before.
  const earlier = request(tailscaled, `${through}/a`, ada())
  assert.ok(await who(earlier))
  gate.suspend('a raw TCP forward')
  assert.equal(gate.identityOf(earlier), null)
  assert.equal(await who(request(tailscaled, `${through}/a`, ada())), null)
  assert.equal(gate.suspended(), 'a raw TCP forward')
  gate.resume()
  assert.ok(gate.identityOf(earlier))
})

test('a tailscaled whose connections cannot be believed: userspace networking, an old version, its own proxies, a container, or one that cannot be read', () => {
  const status = { TUN: true, Version: '1.104.2-t1' }
  const facts = (argv = [], more = {}) => ({
    ...plainFacts(),
    tailscaled: [{ pid: 9, uid: 0, argv: ['/usr/sbin/tailscaled', ...argv] }],
    ...more,
  })
  assert.equal(tailscaledProblem(status, plainFacts()), null)
  assert.equal(tailscaledProblem(status, facts(['--tun=tailscale0', '--socket=/run/tailscale/tailscaled.sock'])), null)
  assert.equal(tailscaledProblem({ ...status, Version: '1.98.0' }, plainFacts()), null)
  assert.equal(tailscaledProblem({ ...status, Version: '2.1.0' }, plainFacts()), null)
  for (const [label, problem, pattern] of [
    ['status says no TUN', tailscaledProblem({ ...status, TUN: false }, plainFacts()), /userspace-networking/],
    ['status says nothing about TUN', tailscaledProblem({ Version: status.Version }, plainFacts()), /userspace-networking/],
    ['--tun=userspace-networking', tailscaledProblem(status, facts(['--tun=userspace-networking'])), /userspace-networking/],
    ['--tun userspace-networking', tailscaledProblem(status, facts(['--tun', 'userspace-networking'])), /userspace-networking/],
    ['-tun=userspace-networking', tailscaledProblem(status, facts(['-tun=userspace-networking'])), /userspace-networking/],
    ['1.96', tailscaledProblem({ ...status, Version: '1.96.4' }, plainFacts()), /Tailscale 1\.96 is too old: before 1\.98/],
    ['0.x', tailscaledProblem({ ...status, Version: '0.100.0' }, plainFacts()), /too old/],
    ['no version', tailscaledProblem({ TUN: true }, plainFacts()), /version cannot be read/],
    ['--socks5-server', tailscaledProblem(status, facts(['--socks5-server=localhost:1055'])), /SOCKS5 proxy/],
    ['--socks5-server VALUE', tailscaledProblem(status, facts(['--socks5-server', 'localhost:1055'])), /SOCKS5 proxy/],
    [
      '--outbound-http-proxy-listen',
      tailscaledProblem(status, facts(['--outbound-http-proxy-listen=localhost:1055'])),
      /outbound HTTP proxy/,
    ],
    [
      'not root',
      tailscaledProblem(status, { ...plainFacts(), tailscaled: [{ pid: 9, uid: 1000, argv: ['tailscaled'] }] }),
      /does not run as root/,
    ],
    ['none visible', tailscaledProblem(status, { ...plainFacts(), tailscaled: [] }), /no tailscaled process of root is visible/],
    [
      'a debug switch',
      tailscaledProblem(status, facts([], { tailscaled: [{ pid: 9, uid: 0, argv: ['tailscaled'], env: ['TS_DEBUG_NETSTACK_SUBNETS'] }] })),
      /TS_DEBUG_NETSTACK_SUBNETS set/,
    ],
    [
      'two',
      tailscaledProblem(status, { ...plainFacts(), tailscaled: [...plainFacts().tailscaled, ...plainFacts().tailscaled] }),
      /more than one tailscaled/,
    ],
    ['unreadable', tailscaledProblem(status, facts([], { unreadable: 1 })), /cannot be read in \/proc/],
    ['a container', tailscaledProblem(status, facts([], { container: 'it runs in a container' })), /cannot tell whose "root"/],
  ])
    assert.match(String(problem), pattern, label)

  // What the machine says, read from a /proc that is given here.
  const files = {
    '/proc/1/comm': 'systemd\n',
    '/proc/40/comm': 'tailscaled\n',
    '/proc/40/cmdline': '/usr/sbin/tailscaled\0--state=/var/lib/tailscale/tailscaled.state\0--port=41641\0',
    '/proc/77/comm': 'node\n',
    '/proc/self/uid_map': '         0          0 4294967295\n',
    '/proc/1/cgroup': '0::/init.scope\n',
  }
  const fakeFs = (overrides = {}, uid = 0) => {
    const all = { ...files, ...overrides }
    const missing = (file) => Object.assign(new Error(`ENOENT ${file}`), { code: 'ENOENT' })
    return {
      readdirSync: () => ['1', '40', '77', 'self', 'net'],
      readFileSync(file) {
        if (all[file] === undefined || all[file] === null) throw missing(file)
        return all[file]
      },
      statSync(file) {
        if (file === '/proc/40') return { uid }
        if (file === '/proc/90') return { uid: 1000 }
        if (file === '/usr/sbin/tailscaled') return { uid: all['exe-owner'] ?? 0 }
        if (all[file] === undefined || all[file] === null) throw missing(file)
        return { uid: 0 }
      },
      // The executable of root's process: not readable by an ordinary user.
      readlinkSync(file) {
        if (all[`${file}->`] === undefined) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return all[`${file}->`]
      },
    }
  }
  assert.deepEqual(hostFacts({ read: fakeFs(), env: {} }), {
    tailscaled: [
      { pid: 40, uid: 0, argv: ['/usr/sbin/tailscaled', '--state=/var/lib/tailscale/tailscaled.state', '--port=41641'], env: null },
    ],
    unreadable: 0,
    container: null,
  })
  // Anyone can run a program called tailscaled. One that is not root's is ignored: it is not a second
  // tailscaled, not an unreadable one, and cannot switch tailnet sign-in off for everyone.
  const impostor = { '/proc/90/comm': 'tailscaled\n', '/proc/90/cmdline': null }
  const withImpostor = { ...fakeFs(impostor), readdirSync: () => ['1', '40', '77', '90'] }
  assert.deepEqual(
    hostFacts({ read: withImpostor, env: {} }).tailscaled.map((item) => item.pid),
    [40],
  )
  assert.equal(hostFacts({ read: withImpostor, env: {} }).unreadable, 0)
  assert.equal(tailscaledProblem(status, hostFacts({ read: withImpostor, env: {} })), null)
  assert.deepEqual(hostFacts({ read: fakeFs({}, 1000), env: {} }).tailscaled, [], 'a tailscaled that is not root’s does not count at all')
  // Where the executable can be read (this server is root): it must be a file called tailscaled that root owns.
  assert.equal(hostFacts({ read: fakeFs({ '/proc/40/exe->': '/usr/sbin/tailscaled' }), env: {} }).tailscaled.length, 1)
  assert.equal(hostFacts({ read: fakeFs({ '/proc/40/exe->': '/usr/sbin/tailscaled (deleted)' }), env: {} }).tailscaled.length, 1)
  assert.equal(hostFacts({ read: fakeFs({ '/proc/40/exe->': '/usr/bin/python3' }), env: {} }).tailscaled.length, 0)
  assert.equal(hostFacts({ read: fakeFs({ '/proc/40/exe->': '/usr/sbin/tailscaled', 'exe-owner': 1000 }), env: {} }).tailscaled.length, 0)
  // Its environment, where it can be read: the debug switches that make it forward to loopback.
  const withEnv = (text) => hostFacts({ read: fakeFs({ '/proc/40/environ': text }), env: {} })
  assert.deepEqual(withEnv('PATH=/usr/bin\0LANG=C\0').tailscaled[0].env, [])
  assert.deepEqual(withEnv('PATH=/usr/bin\0TS_DEBUG_NETSTACK_LOOPBACK_PORT=4700\0').tailscaled[0].env, ['TS_DEBUG_NETSTACK_LOOPBACK_PORT'])
  assert.match(
    tailscaledProblem(status, withEnv('TS_DEBUG_NETSTACK_SUBNETS=1\0TS_DEBUG_NETSTACK_LOOPBACK_PORT=1\0')),
    /TS_DEBUG_NETSTACK_LOOPBACK_PORT and TS_DEBUG_NETSTACK_SUBNETS set/,
  )
  assert.equal(tailscaledProblem(status, withEnv('PATH=/usr/bin\0')), null)
  assert.equal(
    hostFacts({ read: fakeFs(), env: {} }).tailscaled[0].env,
    null,
    'not readable (the usual case): root’s configuration is trusted',
  )
  assert.equal(
    hostFacts({ read: fakeFs({ '/proc/40/cmdline': null }), env: {} }).unreadable,
    1,
    'its command line is hidden: cannot be determined',
  )
  assert.equal(hostFacts({ read: fakeFs({ '/proc/40/cmdline': '' }), env: {} }).unreadable, 1)
  assert.deepEqual(hostFacts({ read: fakeFs({ '/proc/40/comm': 'bash\n' }), env: {} }).tailscaled, [])
  for (const [label, read, env] of [
    ['a user namespace', fakeFs({ '/proc/self/uid_map': '         0     100000      65536\n' }), {}],
    ['no uid_map', fakeFs({ '/proc/self/uid_map': null }), {}],
    ['/.dockerenv', fakeFs({ '/.dockerenv': '' }), {}],
    ['/run/.containerenv', fakeFs({ '/run/.containerenv': '' }), {}],
    ['container=', fakeFs(), { container: 'podman' }],
    ['kubernetes', fakeFs(), { KUBERNETES_SERVICE_HOST: '10.0.0.1' }],
    ['a docker cgroup', fakeFs({ '/proc/1/cgroup': '0::/docker/abc\n' }), {}],
  ])
    assert.ok(hostFacts({ read, env }).container, label)
  // tailscaled's own answer about an address.
  assert.deepEqual(
    whoisAnswer(
      JSON.stringify({
        Node: { ID: 1, StableID: 'nADA', Addresses: ['100.64.0.7/32', 'FD7A:115C:A1E0::7/128'] },
        UserProfile: { LoginName: 'Ada@Example.com' },
      }),
    ),
    {
      login: 'ada@example.com',
      tagged: false,
      stableId: 'nADA',
      addresses: ['100.64.0.7', 'fd7a:115c:a1e0:0:0:0:0:7'],
    },
  )
  assert.deepEqual(
    selfFromStatus({ Self: { ID: 'nSELF', TailscaleIPs: ['100.64.0.1'] }, TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'] }),
    {
      stableId: 'nSELF',
      addresses: ['100.64.0.1', 'fd7a:115c:a1e0:0:0:0:0:1'],
    },
  )
  for (const unknown of [
    {},
    { Self: {} },
    { Self: { ID: 'nSELF' } },
    { Self: { TailscaleIPs: ['100.64.0.1'] } },
    { Self: { ID: 7, TailscaleIPs: ['100.64.0.1'] } },
    null,
  ])
    assert.equal(selfFromStatus(unknown), null)
  assert.deepEqual(whoisAnswer(JSON.stringify({ Node: { ID: 1 }, UserProfile: { LoginName: 'Ada@Example.com' } })), {
    login: 'ada@example.com',
    tagged: false,
    stableId: null,
    addresses: [],
  })
  assert.equal(
    whoisAnswer(JSON.stringify({ Node: { ID: 1, Tags: ['tag:ci'] }, UserProfile: { LoginName: 'ada@example.com' } })).tagged,
    true,
  )
  assert.equal(whoisAnswer(JSON.stringify({ Node: { ID: 1, Tags: ['tag:ci'] }, UserProfile: { LoginName: 'tagged-devices' } })), null)
  assert.equal(whoisAnswer(JSON.stringify({ UserProfile: { LoginName: 'ada@example.com' } })), null, 'no node')
  assert.equal(whoisAnswer('peer not found'), null)
  assert.equal(forwardedTailnetAddress(fakeRequest([['X-Forwarded-For', '100.100.1.2']])), '100.100.1.2')
  assert.equal(forwardedTailnetAddress(fakeRequest([['X-Forwarded-For', 'FD7A:115C:A1E0::1']])), 'fd7a:115c:a1e0::1')
  for (const bad of ['100.63.0.1', '100.128.0.1', '10.0.0.1', '100.64.0.1, 100.64.0.2', '100.64.0.256', 'fd7a:115c:a1e1::1', ''])
    assert.equal(forwardedTailnetAddress(fakeRequest([['X-Forwarded-For', bad]])), null, bad)
})

test('the serve config must be the one entry this server added: a TCP forward, another entry or Funnel is a problem', () => {
  const at = { dnsName: TAILNET_HOST, httpsPort: 443, localPort: 4700 }
  const ours = {
    TCP: { 443: { HTTPS: true } },
    Web: { [`${TAILNET_HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4700' } } } },
  }
  assert.equal(serveProblem(ours, at), null)
  const share = { Handlers: { '/': { Proxy: 'http://127.0.0.1:4701' } } }
  assert.equal(
    serveProblem({ ...ours, Web: { ...ours.Web, [`${TAILNET_HOST}:8443`]: share }, AllowFunnel: { [`${TAILNET_HOST}:8443`]: true } }, at),
    null,
    'the Funnel listener for share links is another port, to another local port',
  )
  assert.match(serveProblem({}, at), /gone or was changed/)
  assert.match(
    serveProblem({ ...ours, TCP: { ...ours.TCP, 9000: { TCPForward: '127.0.0.1:4700' } } }, at),
    /raw TCP forward on tailnet port 9000/,
  )
  assert.match(
    serveProblem({ ...ours, TCP: { ...ours.TCP, 9000: { TCPForward: 'localhost:4700', TerminateTLS: TAILNET_HOST } } }, at),
    /raw TCP forward/,
  )
  assert.equal(
    serveProblem({ ...ours, TCP: { ...ours.TCP, 9000: { TCPForward: '127.0.0.1:5000' } } }, at),
    null,
    'a forward to something else',
  )
  assert.match(serveProblem({ ...ours, AllowFunnel: { [`${TAILNET_HOST}:443`]: true } }, at), /Funnel is on/)
  assert.match(
    serveProblem(
      { ...ours, Web: { ...ours.Web, [`${TAILNET_HOST}:8443`]: { Handlers: { '/x': { Proxy: 'http://localhost:4700' } } } } },
      at,
    ),
    /another tailscale serve entry/,
  )
  assert.match(serveProblem({ ...ours, Foreground: { abc: { TCP: { 9000: { TCPForward: '127.0.0.1:4700' } } } } }, at), /raw TCP forward/)
  assert.match(
    serveProblem({ ...ours, Web: { [`${TAILNET_HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4700/sub' } } } } }, at),
    /another tailscale serve entry|gone or was changed/,
  )
  // With tailnet sign-in the entry is the one with the secret path, exactly.
  const secret = { ...at, target: 'http://127.0.0.1:4700/_ts/abc' }
  assert.match(serveProblem(ours, secret), /another tailscale serve entry/, 'an entry without the secret is not ours')
  assert.equal(
    serveProblem({ ...ours, Web: { [`${TAILNET_HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4700/_ts/abc' } } } } }, secret),
    null,
  )
  // Every spelling of "this machine's loopback, this port" counts as reaching the server.
  for (const spelled of [
    '127.0.0.1:4700',
    'http://127.0.0.1:4700',
    'http://localhost:4700/x',
    'https+insecure://localhost:4700',
    'LOCALHOST:4700',
    'localhost.:4700',
    'app.localhost:4700',
    '127.0.0.2:4700',
    '127.1:4700',
    '[::1]:4700',
    'http://[::1]:4700/',
    'http://[0:0:0:0:0:0:0:1]:4700',
    'http://[::ffff:127.0.0.1]:4700',
    '0.0.0.0:4700',
    'http://[::]:4700',
    ':4700',
    '4700',
    'tcp://127.0.0.1:4700',
    'http://0x7f.0.0.1:4700',
    'http://2130706433:4700',
    'http://this-machine:4700',
  ]) {
    assert.equal(reachesLocalPort(spelled, 4700), true, spelled)
    assert.match(serveProblem({ ...ours, TCP: { ...ours.TCP, 9000: { TCPForward: spelled } } }, at), /raw TCP forward/, spelled)
  }
  for (const other of [
    '127.0.0.1:4701',
    'http://localhost:47000',
    'http://10.0.0.5:4700',
    'http://192.168.1.9:4700',
    'http://[fd7a::2]:4700',
    'http://localhost',
    'unix:/run/app.sock',
    '',
    '80',
  ])
    assert.equal(reachesLocalPort(other, 4700), false, other)
  assert.equal(reachesLocalPort('http://localhost', 80), true, 'the default port of the scheme')
  assert.equal(reachesLocalPort('https://localhost', 443), true)
})

// ---- Refusing to turn on -------------------------------------------------------------

test('the feature refuses to turn on, and says why, when it cannot prove where a request came from', async () => {
  const base = () => ({ dataDir: tempDir('tailnet-refuse'), port: 0, env: {}, out: () => {}, exitOnStop: false, tailnetFacts: plainFacts })
  await assert.rejects(startHosted({ ...base(), tailnetSignIn: true }), /--tailnet-sign-in goes with --tailscale/)
  const ts = () => ({ httpsPort: 443, funnel: null, run: fakeTailscale().run, watchMs: 0 })
  await assert.rejects(
    startHosted({ ...base(), tailscale: ts(), tailnetSignIn: true, tailnetProof: procPeerProof({ platform: 'darwin' }) }),
    /Tailnet sign-in stays off, and the server did not start: this needs Linux/,
  )
  // A check that does not see this process's own connection as its own cannot tell anyone apart.
  await assert.rejects(
    startHosted({
      ...base(),
      tailscale: ts(),
      tailnetSignIn: true,
      tailnetProof: { problem: () => null, ownerOf: () => null, trusted: () => true },
    }),
    /did not recognise a test connection from this process/,
  )
  // Something else already reaches the port (a raw TCP forward): not on.
  const fake = fakeTailscale()
  const run = async (command, args) => {
    const result = await fake.run(command, args)
    if (args[0] === 'serve' && args.includes('--bg')) {
      const port = /127\.0\.0\.1:(\d+)/.exec(args.at(-1))[1]
      fake.state.config.TCP[9000] = { TCPForward: `127.0.0.1:${port}` }
    }
    return result
  }
  await assert.rejects(
    startHosted({
      ...base(),
      tailscale: { httpsPort: 443, funnel: null, run, watchMs: 0 },
      tailnetSignIn: true,
      tailnetProof: { trusted: () => true },
    }),
    /raw TCP forward on tailnet port 9000/,
  )
  assert.ok(fake.state.calls.includes('serve --https=443 off'), 'and what it added to tailscale serve is removed again')
  // tailscaled itself: userspace networking, too old, its own proxy, a container. Nothing is put on the tailnet.
  const trusting = { trusted: () => true }
  for (const [pattern, change] of [
    [/userspace-networking mode/, (fake) => (fake.state.status.TUN = false)],
    [/Tailscale 1\.96 is too old/, (fake) => (fake.state.status.Version = '1.96.1')],
  ]) {
    const fake = fakeTailscale()
    change(fake)
    await assert.rejects(
      startHosted({
        ...base(),
        tailscale: { httpsPort: 443, funnel: null, run: fake.run, watchMs: 0 },
        tailnetSignIn: true,
        tailnetProof: trusting,
      }),
      pattern,
    )
    assert.ok(!fake.state.calls.some((call) => call.startsWith('serve --bg')), 'refused before anything was served')
  }
  for (const [pattern, facts] of [
    [/SOCKS5 proxy/, () => ({ ...plainFacts(), tailscaled: [{ pid: 1, uid: 0, argv: ['tailscaled', '--socks5-server=localhost:1055'] }] })],
    [/cannot tell whose "root"/, () => ({ ...plainFacts(), container: 'it runs in a container' })],
    [/no tailscaled process of root is visible/, () => ({ ...plainFacts(), tailscaled: [] })],
  ])
    await assert.rejects(
      startHosted({ ...base(), tailscale: ts(), tailnetSignIn: true, tailnetProof: trusting, tailnetFacts: facts }),
      pattern,
    )
  // There is no way to name another user for tailscaled any more.
  const fake2 = fakeTailscale()
  const started = await startHosted({
    ...base(),
    tailscale: { httpsPort: 443, funnel: null, run: fake2.run, watchMs: 0 },
    tailnetSignIn: true,
    tailnetProof: trusting,
    env: { SHAPEWALL_TAILSCALED_UID: String(process.getuid?.() ?? 1000) },
  })
  try {
    // The serve entry carries a secret path, new at each start, and no output line holds it.
    const target = fake2.state.config.Web[`${TAILNET_HOST}:443`].Handlers['/'].Proxy
    assert.match(target, /^http:\/\/127\.0\.0\.1:\d+\/_ts\/[A-Za-z0-9_-]{43}$/)
  } finally {
    await started.stop()
  }
})

// ---- Signing in ------------------------------------------------------------------------

test('the first owner claims with the setup link, which links their login; from then on the tailnet signs them in', async () => {
  const server = await tailnet('tailnet-owner')
  assert.ok(server.lines.some((line) => /^Tailnet sign-in: on\./.test(line)))
  const laptop = await server.device(ADA)
  const ada = await claimWithPasskey(server, laptop)
  const first = await me(ada.browser)
  assert.equal(first.json.via, 'passkey')
  assert.deepEqual(
    { here: first.json.tailnet.here, linked: first.json.tailnet.linked },
    { here: 'ada@example.com', linked: 'ada@example.com' },
    'signing up through the tailnet linked the login',
  )
  // Another browser on a device of the same person: signed in, no passkey, no code.
  const phone = (await server.device(ADA)).browser()
  const arrived = await me(phone)
  assert.equal(arrived.json.user.handle, 'ada')
  assert.equal(arrived.json.via, 'tailnet')
  assert.equal(arrived.json.fresh, false)
  assert.equal((await phone.get(`/api/workspaces/${ada.workspaceId}`)).json.role, 'owner')
  // Marked as such: the session list, the account's log, and what it does in the workspace.
  const sessions = (await phone.get('/auth/sessions')).json.sessions
  assert.deepEqual(sessions.map((item) => item.via).sort(), ['passkey', 'tailnet'])
  const log = (await phone.get('/auth/security-log')).json.events
  const signedIn = log.find((event) => event.action === 'signed_in')
  assert.equal(signedIn.detail.via, 'tailnet')
  assert.equal(signedIn.detail.tailnet, 'ada@example.com')
  assert.equal((await phone.post(`/api/workspaces/${ada.workspaceId}/projects`, { name: 'Site' })).status, 201)
  const made = server.db.prepare("SELECT detail FROM audit_log WHERE action = 'project_created'").get()
  assert.equal(JSON.parse(made.detail).signedInBy, 'tailnet')
  const activity = await phone.get(`/api/workspaces/${ada.workspaceId}/activity`)
  assert.equal(activity.status, 200)
  assert.equal(activity.json.entries.find((entry) => entry.action === 'project_created').tailnetSession, true)
})

test('an unknown login sees who to ask and is listed for the admins; invited by login, it joins with that role', async () => {
  const server = await tailnet('tailnet-visitor')
  const ada = await claimWithPasskey(server, await server.device(ADA))
  const ws = ada.workspaceId
  const benDevice = await server.device(BEN)
  const ben = benDevice.browser()
  const asked = await me(ben)
  assert.equal(asked.json.user, null)
  assert.deepEqual(
    {
      state: asked.json.tailnet.state,
      login: asked.json.tailnet.login,
      name: asked.json.tailnet.name,
      invites: asked.json.tailnet.invites,
    },
    { state: 'unknown', login: 'ben@example.com', name: 'Ben', invites: [] },
  )
  assert.equal(asked.json.tailnet.suggested.handle, 'ben')
  // Being on the tailnet gives nothing: no workspace, no account, no way to make one.
  assert.equal((await ben.get(`/api/workspaces/${ws}`)).status, 401)
  const refused = await ben.post('/auth/tailnet/join', {})
  assert.equal(refused.status, 403)
  assert.equal(refused.json.error.code, 'invite_required')
  assert.match(refused.json.error.message, /invite ben@example.com/)
  assert.equal((await ben.post('/auth/tailnet/sign-in', {})).json.error.code, 'no_account')
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1)

  // The admins see who arrived.
  const visitors = await ada.browser.get(`/api/workspaces/${ws}/tailnet-visitors`)
  assert.equal(visitors.json.enabled, true)
  assert.deepEqual(
    visitors.json.visitors.map((visitor) => [visitor.login, visitor.name]),
    [['ben@example.com', 'Ben']],
  )
  assert.equal((await ada.browser.get(`/api/workspaces/${ws}`)).json.features.tailnetSignIn, true)
  // Admitting one is an invite for that login, with a role.
  const bad = await ada.browser.post(`/api/workspaces/${ws}/invites`, { role: 'member', tailnetLogin: 'not a login' })
  assert.equal(bad.json.error.code, 'invalid_login')
  const invited = await ada.browser.post(`/api/workspaces/${ws}/invites`, { role: 'viewer', tailnetLogin: 'Ben@Example.com' })
  assert.equal(invited.status, 201, invited.text)
  assert.equal(invited.json.invite.tailnetLogin, 'ben@example.com')
  assert.deepEqual((await ada.browser.get(`/api/workspaces/${ws}/tailnet-visitors`)).json.visitors, [], 'invited: off the list')
  assert.equal((await ada.browser.get(`/api/workspaces/${ws}/invites`)).json.pending[0].tailnetLogin, 'ben@example.com')

  const again = await me(ben)
  assert.equal(again.json.tailnet.state, 'invited')
  assert.equal(again.json.tailnet.invites.length, 1)
  assert.equal(again.json.tailnet.invites[0].role, 'viewer')
  // The role is the invite's: nothing in the request can change it.
  const joined = await ben.post('/auth/tailnet/join', { role: 'owner', displayName: 'Ben B', workspaceId: ws })
  assert.equal(joined.status, 201, joined.text)
  assert.equal(joined.json.user.handle, 'ben')
  assert.equal(joined.json.user.displayName, 'Ben B')
  const detail = await ben.get(`/api/workspaces/${ws}`)
  assert.equal(detail.json.role, 'viewer')
  assert.equal((await me(ben)).json.via, 'tailnet')
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n, 1, 'no passkey was made for ben')
  const account = server.db
    .prepare("SELECT detail FROM audit_log WHERE action = 'account_created' AND user_id = ?")
    .get(joined.json.user.id)
  assert.deepEqual({ via: JSON.parse(account.detail).via, signIn: JSON.parse(account.detail).signIn }, { via: 'invite', signIn: 'tailnet' })
  // A second join changes nothing, and an account cannot be made twice.
  assert.deepEqual((await ben.post('/auth/tailnet/join', {})).json.joined, [])
  const fresh = benDevice.browser()
  fresh.jar.set('__Host-sw_tailnet_out', '1')
  assert.equal((await fresh.post('/auth/tailnet/join', {})).json.error.code, 'has_account')
  // A visitor an admin does not want listed can be taken off the list.
  const cyd = (await server.device(CYD)).browser()
  await me(cyd)
  const gone = await ada.browser.call('DELETE', `/api/workspaces/${ws}/tailnet-visitors/${encodeURIComponent('cyd@example.com')}`)
  assert.equal(gone.status, 200, gone.text)
  assert.deepEqual((await ada.browser.get(`/api/workspaces/${ws}/tailnet-visitors`)).json.visitors, [])
  assert.equal((await ben.get(`/api/workspaces/${ws}/tailnet-visitors`)).status, 403, 'a viewer does not see the list')
})

test('signing out of a tailnet session stays signed out until "Continue as"', async () => {
  const server = await tailnet('tailnet-signout')
  const ada = await claimWithPasskey(server, await server.device(ADA))
  const benDevice = await server.device(BEN)
  const { browser: ben } = await joinByInvite(server, ada, benDevice)
  const out = await ben.post('/auth/logout', {})
  assert.equal(out.status, 200)
  assert.equal(out.json.tailnet, 'ben@example.com', 'the console can say: arriving again signs you back in')
  const after = await me(ben)
  assert.equal(after.json.user, null)
  assert.deepEqual({ state: after.json.tailnet.state, login: after.json.tailnet.login }, { state: 'signed_out', login: 'ben@example.com' })
  assert.equal((await ben.get(`/api/workspaces/${ada.workspaceId}`)).status, 401)
  const back = await ben.post('/auth/tailnet/sign-in', {})
  assert.equal(back.status, 200, back.text)
  assert.equal((await me(ben)).json.user.handle, 'ben')
  // Another browser of the same person was never signed out.
  assert.equal((await me(benDevice.browser())).json.user.handle, 'ben')
})

// ---- What must never work ---------------------------------------------------------------

test('forged identity headers are ignored on direct loopback requests, on Funnel traffic, and with the feature off', async () => {
  const server = await tailnet('tailnet-forged', { funnel: true })
  const ada = await claimWithPasskey(server, await server.device(ADA))
  const forged = { 'Tailscale-User-Login': 'ada@example.com', 'Tailscale-User-Name': 'Ada', 'Sec-Fetch-Site': 'same-origin' }
  const nobody = async (browser, label) => {
    const asked = await browser.get('/auth/me', { headers: forged })
    assert.equal(asked.json.user, null, label)
    assert.notEqual(asked.json.tailnet?.state, 'signed_out', `${label}: not even recognised`)
    const signIn = await browser.post('/auth/tailnet/sign-in', {}, { headers: forged })
    assert.equal(signIn.status, 403, `${label}: ${signIn.text}`)
    assert.equal(signIn.json.error.code, 'tailnet_required', label)
    assert.equal((await browser.post('/auth/tailnet/join', {}, { headers: forged })).status, 403, label)
    assert.equal((await browser.get(`/api/workspaces/${ada.workspaceId}`, { headers: forged })).status, 401, label)
  }
  // 1. A program on the server's machine, straight to the port.
  await nobody(server.direct(), 'direct loopback')
  // 1b. A raw TCP forward that tailscaled itself dialled (userspace networking, `serve --tcp`, the
  //     LocalAPI dial): the connection is tailscaled's, the bytes are the attacker's. No serve secret: nobody.
  const forwardDevice = await server.device({}, { forward: true })
  server.tailscale.state.whois.set(forwardDevice.address, ADA)
  await nobody(forwardDevice.browser(), 'a raw forward dialled by tailscaled')
  const withAddress = await forwardDevice
    .browser()
    .get('/auth/me', { headers: { ...forged, 'X-Forwarded-For': (await server.device(ADA)).address } })
  assert.equal(withAddress.json.user, null, 'also when it names the victim’s real tailnet address')
  // 1c. A local user who read the secret from `tailscale serve status`: it has the path, its socket is its own.
  const secretPath = new URL(server.tailscale.state.config.Web[`${TAILNET_HOST}:443`].Handlers['/'].Proxy).pathname
  assert.match(secretPath, /^\/_ts\/[A-Za-z0-9_-]{43}$/)
  const adaAddress = (await server.device(ADA)).address
  const insider = await server.direct().get(`${secretPath}/auth/me`, { headers: { ...forged, 'X-Forwarded-For': adaAddress } })
  assert.equal(insider.status, 200)
  assert.equal(insider.json.user, null, 'the secret alone is not enough')
  // 1d. A wrong secret: a plain 404, whoever asks.
  const wrong = await server.direct().get(`/_ts/${'x'.repeat(43)}/auth/me`, { headers: forged })
  assert.equal(wrong.status, 404)
  assert.equal(wrong.text, 'Not found')
  // 1e. Through the real proxy path, but tailscaled's whois says the address is someone else's, tagged, or nobody's.
  for (const [label, who] of [
    ['another person’s address', BEN],
    ['a tagged device’s address', { tagged: true }],
    ['an address tailscaled does not know', null],
  ]) {
    const lying = await server.device(ADA)
    if (who) server.tailscale.state.whois.set(lying.address, who)
    else server.tailscale.state.whois.delete(lying.address)
    const asked = await me(lying.browser())
    assert.equal(asked.json.user, null, label)
    assert.equal(asked.json.tailnet.state, 'none', label)
  }
  // No output line of the server holds the secret.
  assert.ok(server.lines.every((line) => !line.includes(secretPath.slice(5))))
  // 2. Through tailscaled, as Funnel traffic: the proxy drops what the client sent and marks the request.
  await nobody((await server.device({ funnel: true })).browser(), 'funnel on the tailnet port')
  // 3. A Funnel mark together with identity headers (a proxy that did not strip): still nobody.
  const marked = (await server.device({}, { raw: true })).browser()
  const asked = await marked.get('/auth/me', { headers: { ...forged, 'Tailscale-Funnel-Request': '?1' } })
  assert.equal(asked.json.user, null)
  // 4. The public share listener (--funnel): no console, no sign-in, whatever the headers say.
  const sharePort = server.shareServer.address().port
  const share = await fetch(`http://127.0.0.1:${sharePort}/auth/me`, { headers: { ...forged, Host: `${TAILNET_HOST}:8443` } })
  assert.deepEqual(await share.json(), { user: null, signup: 'invite' })
  const shareSignIn = await fetch(`http://127.0.0.1:${sharePort}/auth/tailnet/sign-in`, {
    method: 'POST',
    headers: { ...forged, 'Content-Type': 'application/json', Origin: `https://${TAILNET_HOST}:8443` },
    body: '{}',
  })
  assert.equal(shareSignIn.status, 404)
  // 5. A tagged device, through the real proxy path: no headers, nobody; forged ones are stripped.
  await nobody((await server.device({ tagged: true })).browser(), 'tagged device')
  assert.equal((await me((await server.device({ tagged: true })).browser())).json.tailnet.state, 'none')

  // 6. The same server without --tailnet-sign-in: the headers mean nothing, even through the proxy.
  const plain = await tailnet('tailnet-off', { signIn: false })
  const owner = await signUp(plain.as(), { handle: 'ada' })
  const through = (await plain.device(ADA)).browser()
  const off = await me(through)
  assert.equal(off.json.user, null)
  assert.equal('tailnet' in off.json, false)
  assert.equal((await through.post('/auth/tailnet/sign-in', {})).json.error.code, 'tailnet_required')
  assert.equal((await through.post('/auth/tailnet/join', {})).json.error.code, 'tailnet_required')
  assert.equal((await through.post('/auth/tailnet/sign-in', {})).json.error.message, 'Tailnet sign-in is off on this server.')
  assert.equal((await me(owner.browser)).json.tailnet, null)
  const noTarget = await owner.browser.post(`/api/workspaces/${owner.workspaceId}/invites`, {
    role: 'member',
    tailnetLogin: 'ben@example.com',
  })
  assert.equal(noTarget.json.error.code, 'tailnet_off')
  assert.equal((await owner.browser.get(`/api/workspaces/${owner.workspaceId}/tailnet-visitors`)).json.enabled, false)
  assert.equal((await owner.browser.post('/auth/tailnet/link', {})).json.error.code, 'tailnet_required')
})

test('duplicate, conflicting, empty and oddly encoded headers name nobody, even on a connection that is believed', async () => {
  const server = await tailnet('tailnet-headers')
  await claimWithPasskey(server, await server.device(ADA))
  // A proxy that passes headers through as they are (what a raw forward would do), on a believed connection.
  const rawDevice = await server.device({}, { raw: true })
  server.tailscale.state.whois.set(rawDevice.address, ADA)
  const raw = rawDevice.browser()
  const ask = async (headers) => (await raw.get('/auth/me', { headers: { 'Sec-Fetch-Site': 'same-origin', ...headers } })).json
  assert.equal(
    (await ask({ 'Tailscale-User-Login': 'ada@example.com' })).user.handle,
    'ada',
    'the control: one clean header is believed here',
  )
  for (const [label, headers] of [
    ['the same login twice', { 'Tailscale-User-Login': ['ada@example.com', 'ada@example.com'] }],
    ['two logins', { 'Tailscale-User-Login': ['ben@example.com', 'ada@example.com'] }],
    ['two logins in one header', { 'Tailscale-User-Login': 'ada@example.com, ben@example.com' }],
    ['empty', { 'Tailscale-User-Login': '' }],
    ['spaces', { 'Tailscale-User-Login': '   ' }],
    ['another character set', { 'Tailscale-User-Login': '=?iso-8859-1?q?ada=40example.com?=' }],
    ['a broken escape', { 'Tailscale-User-Login': '=?utf-8?q?ada=4?=' }],
    ['not a login', { 'Tailscale-User-Login': 'ada' }],
    ['a login with a line break encoded in it', { 'Tailscale-User-Login': '=?utf-8?q?ada=0A=40example.com?=' }],
    ['the underscore spelling', { Tailscale_User_Login: 'ada@example.com' }],
  ]) {
    const answer = await ask(headers)
    assert.equal(answer.user, null, label)
    assert.equal(answer.tailnet.state, 'none', label)
  }
  // Encoded as Tailscale encodes: the login is still the login, the name is decoded.
  const ok = await ask({ 'Tailscale-User-Login': '=?utf-8?q?ada=40example.com?=', 'Tailscale-User-Name': qEncode('Adá') })
  assert.equal(ok.user.handle, 'ada')
  // Another login than the one tailscaled says owns that address: nobody.
  const other = await ask({ 'Tailscale-User-Login': 'dee@example.com', 'Tailscale-User-Name': 'Dee' })
  assert.equal(other.tailnet.state, 'none')
  const deeDevice = await server.device({}, { raw: true })
  server.tailscale.state.whois.set(deeDevice.address, { login: 'dee@example.com' })
  const visitor = (
    await deeDevice.browser().get('/auth/me', {
      headers: {
        'Sec-Fetch-Site': 'same-origin',
        'Tailscale-User-Login': 'dee@example.com',
        'Tailscale-User-Name': qEncode('Dée Ünïcode'),
      },
    })
  ).json
  assert.equal(visitor.tailnet.name, 'Dée Ünïcode')
  assert.ok(server.lines.some((line) => /tailnet identity: ignored identity headers/.test(line)))
})

test('one tailnet login cannot become another account: a session counts only with the identity it was made for', async () => {
  const server = await tailnet('tailnet-bound')
  const adaDevice = await server.device(ADA)
  const ada = await claimWithPasskey(server, adaDevice)
  const ws = ada.workspaceId
  const benDevice = await server.device(BEN)
  const { browser: ben } = await joinByInvite(server, ada, benDevice, 'member')
  const adaTailnet = adaDevice.browser()
  assert.equal((await me(adaTailnet)).json.via, 'tailnet')
  const cookie = '__Host-sw_session'
  // Ben takes Ada's tailnet session cookie to his own device: it is worth nothing there.
  const thief = benDevice.browser()
  thief.jar.set(cookie, adaTailnet.jar.get(cookie))
  thief.jar.set('__Host-sw_tailnet_out', '1')
  assert.equal((await thief.get(`/api/workspaces/${ws}`)).status, 401)
  assert.equal((await thief.post(`/api/workspaces/${ws}/invites`, { role: 'member' })).status, 401)
  // Nor off the tailnet (the server's own port), nor from a tagged device, nor with forged headers.
  const off = server.direct()
  off.jar.set(cookie, adaTailnet.jar.get(cookie))
  assert.equal((await off.get(`/api/workspaces/${ws}`)).status, 401)
  assert.equal((await off.get(`/api/workspaces/${ws}`, { headers: { 'Tailscale-User-Login': 'ada@example.com' } })).status, 401)
  const tagged = (await server.device({ tagged: true })).browser()
  tagged.jar.set(cookie, adaTailnet.jar.get(cookie))
  assert.equal((await tagged.get(`/api/workspaces/${ws}`)).status, 401)
  // On Ada's own device it works, and Ben is still Ben.
  assert.equal((await adaTailnet.get(`/api/workspaces/${ws}`)).json.role, 'owner')
  assert.equal((await ben.get(`/api/workspaces/${ws}`)).json.role, 'member')
  // A passkey session is not bound: it is the passkey's, as on any server.
  const passkeyAnywhere = server.direct()
  passkeyAnywhere.jar.set(cookie, ada.browser.jar.get(cookie))
  assert.equal((await passkeyAnywhere.get(`/api/workspaces/${ws}`)).status, 200)

  // Ben cannot link his login to Ada's account, nor take a login that is linked.
  assert.equal((await ben.post('/auth/tailnet/link', {})).json.error.code, 'passkey_required', 'linking is part of the fixed core')
  const cydDevice = await server.device(CYD)
  const cyd = await signUp(server.as(), { handle: 'cyd', invite: await invite(ada, ws, 'member') })
  // Cyd (a passkey account, not linked) arrives on Ben's device: Ben's login is taken.
  const cydOnBens = benDevice.browser()
  cydOnBens.jar.set(cookie, cyd.browser.jar.get(cookie))
  cydOnBens.jar.set('__Host-sw_tailnet_out', '1')
  await reauth({ browser: cydOnBens, authenticator: cyd.authenticator })
  assert.equal((await cydOnBens.post('/auth/tailnet/link', {})).json.error.code, 'tailnet_login_taken')
  // On Cyd's own device, one click (the passkey was just checked).
  const cydHome = cydDevice.browser()
  cydHome.jar.set(cookie, cyd.browser.jar.get(cookie))
  const linked = await cydHome.post('/auth/tailnet/link', {})
  assert.equal(linked.status, 200, linked.text)
  assert.equal(linked.json.linked, 'cyd@example.com')
  assert.equal((await me(cydDevice.browser())).json.via, 'tailnet')
  const events = (await cydHome.get('/auth/security-log')).json.events.map((event) => event.action)
  assert.ok(events.includes('tailnet_linked'))
})

test('linking needs a fresh passkey check; unlinking ends the tailnet sessions; an account with no passkey cannot unlink', async () => {
  const server = await tailnet('tailnet-link')
  const adaDevice = await server.device(ADA)
  // A passkey account made off the tailnet, so not linked yet.
  const ada = await signUp(server.as(), { handle: 'ada' })
  assert.equal((await me(ada.browser)).json.tailnet.linked, null)
  const home = adaDevice.browser()
  home.jar.set('__Host-sw_session', ada.browser.jar.get('__Host-sw_session'))
  assert.equal((await me(home)).json.tailnet.here, 'ada@example.com')
  server.db.prepare("UPDATE sessions SET verified_at = '2000-01-01T00:00:00.000Z'").run()
  const stale = await home.post('/auth/tailnet/link', {})
  assert.equal(stale.json.error.code, 'reauth_required')
  assert.equal(stale.json.error.stepUp, 'always')
  await reauth({ browser: home, authenticator: ada.authenticator })
  assert.equal((await home.post('/auth/tailnet/link', {})).status, 200)
  // Off the tailnet there is nothing to link to.
  assert.equal((await ada.browser.post('/auth/tailnet/link', {})).json.error.code, 'tailnet_required')
  const phone = adaDevice.browser()
  assert.equal((await me(phone)).json.via, 'tailnet')
  // Unlink: the passkey again, then the tailnet session is gone and arriving signs nobody in.
  server.db.prepare("UPDATE sessions SET verified_at = '2000-01-01T00:00:00.000Z'").run()
  assert.equal((await home.call('DELETE', '/auth/tailnet/link')).json.error.code, 'reauth_required')
  await reauth({ browser: home, authenticator: ada.authenticator })
  const unlinked = await home.call('DELETE', '/auth/tailnet/link')
  assert.equal(unlinked.status, 200, unlinked.text)
  assert.deepEqual(unlinked.json, { linked: null, signedOut: false })
  assert.equal((await phone.get(`/api/workspaces/${ada.workspaceId}`)).status, 401, 'the tailnet session ended')
  assert.equal((await me(adaDevice.browser())).json.tailnet.state, 'unknown')
  assert.equal((await home.get(`/api/workspaces/${ada.workspaceId}`)).status, 200, 'the passkey session goes on')

  // An account that only the tailnet signs in cannot unlink: it would be locked out.
  const { browser: ben } = await joinByInvite(server, ada, await server.device(BEN))
  const refused = await ben.call('DELETE', '/auth/tailnet/link')
  assert.equal(refused.status, 403)
  assert.equal(refused.json.error.code, 'passkey_required', 'the fixed core: a passkey first')
  assert.equal((await me(ben)).json.tailnet.linked, 'ben@example.com')
})

test('an invite for one login is that login’s alone: by link, by join, by passkey sign-up, and by an account linked to another login', async () => {
  const server = await tailnet('tailnet-invite')
  const ada = await claimWithPasskey(server, await server.device(ADA))
  const ws = ada.workspaceId
  const made = await ada.browser.post(`/api/workspaces/${ws}/invites`, { role: 'admin', tailnetLogin: 'ben@example.com' })
  const token = new URL(made.json.url).hash.slice(1)
  const cydDevice = await server.device(CYD)
  const cyd = cydDevice.browser()
  // Cyd has the link (someone forwarded it): it reads as invalid, and none of the ways in takes it.
  assert.equal((await cyd.post('/api/invites/preview', { token })).json.error.code, 'invalid_invite')
  assert.equal((await cyd.post('/auth/tailnet/join', { invite: token })).json.error.code, 'invalid_invite')
  assert.equal((await cyd.post('/auth/tailnet/join', {})).json.error.code, 'invite_required')
  assert.equal(
    (await cyd.post('/auth/register/options', { handle: 'cyd', displayName: 'Cyd', invite: token })).json.error.code,
    'invalid_invite',
  )
  // Off the tailnet, with the link: the same.
  assert.equal((await server.direct().post('/api/invites/preview', { token })).json.error.code, 'invalid_invite')
  assert.equal(
    (await server.direct().post('/auth/register/options', { handle: 'eve', displayName: 'Eve', invite: token })).json.error.code,
    'invalid_invite',
  )
  // An existing member with another login cannot accept it either.
  const dee = await joinByInvite(server, ada, await server.device({ login: 'dee@example.com', name: 'Dee' }), 'viewer')
  // (dee is a member already, so use a second workspace's invite to see the login check itself)
  const other = await ada.browser.post('/api/workspaces', { name: 'Second' })
  const second = await ada.browser.post(`/api/workspaces/${other.json.workspace.id}/invites`, {
    role: 'admin',
    tailnetLogin: 'ben@example.com',
  })
  const secondToken = new URL(second.json.url).hash.slice(1)
  assert.equal((await dee.browser.post('/api/invites/accept', { token: secondToken })).json.error.code, 'invalid_invite')
  assert.equal((await ada.browser.post('/api/invites/accept', { token: secondToken })).json.error.code, 'invalid_invite')
  assert.equal(
    server.db.prepare("SELECT COUNT(*) AS n FROM invites WHERE used_at IS NOT NULL AND tailnet_login = 'ben@example.com'").get().n,
    0,
  )
  // Ben, arriving as Ben: both workspaces, with the roles the invites gave.
  const ben = (await server.device(BEN)).browser()
  assert.equal((await ben.post('/api/invites/preview', { token })).json.role, 'admin')
  const joined = await ben.post('/auth/tailnet/join', {})
  assert.equal(joined.status, 201, joined.text)
  const mine = (await me(ben)).json.workspaces
  assert.deepEqual(mine.map((item) => item.role).sort(), ['admin', 'admin'])
  // A later invite for a login that has an account shows on /auth/me and is taken with one request.
  const third = await ada.browser.post('/api/workspaces', { name: 'Third' })
  await ada.browser.post(`/api/workspaces/${third.json.workspace.id}/invites`, { role: 'viewer', tailnetLogin: 'ben@example.com' })
  assert.deepEqual((await me(ben)).json.tailnet.invites, [{ workspace: 'Third', role: 'viewer' }])
  assert.deepEqual((await ben.post('/auth/tailnet/join', {})).json.joined, [third.json.workspace.id])
  // Already a member: an invite for that login is refused when it is made.
  const dup = await ada.browser.post(`/api/workspaces/${ws}/invites`, { role: 'member', tailnetLogin: 'ben@example.com' })
  assert.equal(dup.json.error.code, 'already_member')
})

test('the cross-origin rules are unchanged: the identity alone never acts on a request from another site', async () => {
  const server = await tailnet('tailnet-csrf')
  const adaDevice = await server.device(ADA)
  const ada = await claimWithPasskey(server, adaDevice)
  const ws = ada.workspaceId
  // A page on another site makes Ada's browser send requests: the proxy adds her identity to each.
  const victim = adaDevice.browser()
  const cross = await victim.get('/auth/me', { headers: { 'Sec-Fetch-Site': 'cross-site' } })
  assert.equal(cross.json.user, null, 'GET /auth/me from another site signs nobody in')
  assert.equal(cross.headers['set-cookie'], undefined)
  assert.equal((await victim.get('/auth/me')).json.user, null, 'nor a request that does not say where it is from')
  assert.equal((await victim.get(`/api/workspaces/${ws}`)).status, 401, 'reads need the session cookie as before')
  for (const pathname of ['/auth/tailnet/sign-in', '/auth/tailnet/join', '/auth/tailnet/link']) {
    const evil = await victim.call('POST', pathname, { body: {}, headers: { Origin: 'https://evil.example' } })
    assert.equal(evil.status, 403, pathname)
    assert.equal(evil.json.error.code, 'bad_origin', pathname)
    const none = await victim.call('POST', pathname, { body: {}, sendOrigin: false })
    assert.equal(none.json.error.code, 'bad_origin', pathname)
    const form = await victim.call('POST', pathname, { body: 'a=b', headers: { 'Content-Type': 'text/plain' } })
    assert.equal(form.status, 415, pathname)
  }
  // With a tailnet session: writes from another site are refused as for any session.
  const signedIn = adaDevice.browser()
  await me(signedIn)
  const write = await signedIn.call('POST', `/api/workspaces/${ws}/projects`, {
    body: { name: 'X' },
    headers: { Origin: 'https://evil.example' },
  })
  assert.equal(write.json.error.code, 'bad_origin')
  // Nothing was noted for a cross-site visitor either.
  const stranger = (await server.device(CYD)).browser()
  await stranger.get('/auth/me', { headers: { 'Sec-Fetch-Site': 'cross-site' } })
  assert.deepEqual((await ada.browser.get(`/api/workspaces/${ws}/tailnet-visitors`)).json.visitors, [])
})

test('workspaces stay apart: a tailnet member of one sees nothing of another', async () => {
  const server = await tailnet('tailnet-isolation', { signup: 'open' })
  const ada = await claimWithPasskey(server, await server.device(ADA))
  const project = await createProject(ada, ada.workspaceId, 'Site')
  const { browser: ben } = await joinByInvite(server, ada, await server.device(BEN), 'admin')
  const second = await ada.browser.post('/api/workspaces', { name: 'Private' })
  const other = second.json.workspace.id
  const secret = await createProject(ada, other, 'Secret')
  assert.equal((await ben.get(`/api/workspaces/${ada.workspaceId}/projects/${project.id}/tokens`)).status, 200)
  for (const url of [
    `/api/workspaces/${other}`,
    `/api/workspaces/${other}/audit`,
    `/api/workspaces/${other}/tailnet-visitors`,
    `/api/workspaces/${other}/projects/${secret.id}/tokens`,
    `/api/workspaces/${ada.workspaceId}/projects/${secret.id}/tokens`,
  ]) {
    const answer = await ben.get(url)
    assert.equal(answer.status, 404, url)
  }
  assert.equal((await ben.post(`/api/workspaces/${other}/invites`, { role: 'member', tailnetLogin: 'cyd@example.com' })).status, 404)
  assert.equal((await ben.get(`/w/${other}/p/${secret.id}/api/info`)).status, 404)
  // With open sign-up a tailnet login may make its own account and workspace; it is still in nobody else's.
  const cyd = (await server.device(CYD)).browser()
  const own = await cyd.post('/auth/tailnet/join', {})
  assert.equal(own.status, 201, own.text)
  assert.equal((await cyd.get(`/api/workspaces/${ada.workspaceId}`)).status, 404)
  assert.equal((await me(cyd)).json.workspaces.length, 1)
})

// ---- The fixed core without a passkey, and the CLI's device approval ---------------------------

test('a tailnet account with no passkey: everything in the workspace, a passkey first for the fixed core, and the first passkey is on hold for a day', async () => {
  const server = await tailnet('tailnet-core')
  const ada = await claimWithPasskey(server, await server.device(ADA))
  const ws = ada.workspaceId
  const benDevice = await server.device(BEN)
  const { browser: ben, user } = await joinByInvite(server, ada, benDevice, 'owner')
  const project = (await ben.post(`/api/workspaces/${ws}/projects`, { name: 'Site' })).json.project
  // `shapewall login` and `agent connect`: the browser approval works with no passkey.
  const started = await (
    await fetch(`http://127.0.0.1:${server.localPort}/api/v1/device/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'laptop', purpose: 'agent', agent: { kind: 'claude', name: 'Builder' } }),
    })
  ).json()
  const approved = await ben.post('/api/device/approve', {
    code: started.userCode,
    workspaceId: ws,
    projectId: project.id,
    agent: { name: 'Builder' },
  })
  assert.equal(approved.status, 200, approved.text)
  assert.equal((await ben.post(`/api/workspaces/${ws}/projects/${project.id}/tokens`, { name: 'ci', scopes: ['read'] })).status, 201)
  assert.equal(
    (await ben.call('PATCH', `/api/workspaces/${ws}/step-up`, { body: { group: 'tokens', on: true } })).status,
    200,
    'stronger: no passkey needed',
  )
  // The fixed core: told to add a passkey first, never let through, never asked for a passkey it does not have.
  for (const [method, url, body] of [
    ['DELETE', `/api/workspaces/${ws}`, { confirm: 'x' }],
    ['POST', `/api/workspaces/${ws}/invites`, { role: 'owner' }],
    ['PATCH', `/api/workspaces/${ws}/step-up`, { group: 'tokens', on: false }],
    ['POST', '/auth/recovery-codes', {}],
    ['DELETE', '/auth/me', { confirm: 'ben' }],
    // And a group the workspace switched on.
    ['POST', `/api/workspaces/${ws}/projects/${project.id}/tokens`, { name: 'ci2', scopes: ['read'] }],
  ]) {
    const refused = await call(ben, method, url, body)
    assert.equal(refused.status, 403, `${method} ${url}: ${refused.text}`)
    assert.equal(refused.json.error.code, 'passkey_required', `${method} ${url}`)
    assert.match(refused.json.error.message, /Add a passkey in Account and security/)
  }
  // With no passkey on the account this session is as strong as the account gets: it may end the others.
  assert.equal((await ben.post('/auth/sessions/revoke-others', {})).status, 200)
  // Adding the first passkey needs no check: the tailnet identity is all the account has.
  const { createAuthenticator } = await import('./hosted-helpers.js')
  const authenticator = createAuthenticator({ origin: TAILNET_ORIGIN })
  const options = await ben.post('/auth/passkeys/options', {})
  assert.equal(options.status, 200, options.text)
  const added = await ben.post('/auth/passkeys/verify', { response: authenticator.register(options.json.options), nickname: 'Laptop' })
  assert.equal(added.status, 201, added.text)
  // It signs in at once, but it is on hold for 24 hours for the fixed core: a tailnet identity is per
  // device, and whatever runs as ben on one of his devices could have added it.
  assert.ok(Date.parse(added.json.passkeys[0].onHoldUntil) > Date.now() + 23 * 3_600_000, 'on hold for 24 hours')
  const event = (await ben.get('/auth/security-log')).json.events.find((entry) => entry.action === 'passkey_added')
  assert.deepEqual(event.detail, { viaRecovery: false, viaTailnet: true, onHold: true })
  const laptop = (await import('./hosted-helpers.js')).createBrowser(server.localPort, TAILNET_ORIGIN)
  const start = await laptop.post('/auth/login/options', {})
  const signedIn = await laptop.post('/auth/login/verify', { response: authenticator.assert(start.json.options) })
  assert.equal(signedIn.status, 200, 'the new passkey signs in')
  assert.equal((await call(laptop, 'DELETE', `/api/workspaces/${ws}`, { confirm: 'x' })).json.error.code, 'reauth_required')
  // The core asks for the passkey, and that passkey cannot confirm yet; a second passkey needs it too.
  const asked = await call(ben, 'DELETE', `/api/workspaces/${ws}`, { confirm: 'x' })
  assert.equal(asked.json.error.code, 'reauth_required')
  assert.equal((await ben.post('/auth/passkeys/options', {})).json.error.code, 'reauth_required')
  const early = await ben.post('/auth/reauth/options', {})
  const held = await ben.post('/auth/reauth/verify', { response: authenticator.assert(early.json.options) })
  assert.equal(held.json.error.code, 'passkey_on_hold')
  assert.equal((await call(ben, 'DELETE', `/api/workspaces/${ws}`, { confirm: 'x' })).json.error.code, 'reauth_required')
  // With a passkey on the account, ending the other sessions needs that passkey once.
  assert.equal((await ben.post('/auth/sessions/revoke-others', {})).json.error.stepUp, 'sessions')
  // A day later the hold is over.
  server.db.prepare("UPDATE passkeys SET recovery_added_at = '2000-01-01T00:00:00.000Z' WHERE recovery_added_at IS NOT NULL").run()
  await reauth({ browser: ben, authenticator })
  assert.equal((await ben.post('/auth/sessions/revoke-others', {})).status, 200)
  assert.equal((await me(ben)).json.via, 'tailnet', 'still a tailnet session, now with a fresh passkey check')
  assert.equal((await me(ben)).json.fresh, true)
  assert.equal((await ben.post('/auth/recovery-codes', {})).status, 200)
  assert.equal((await call(ben, 'PATCH', `/api/workspaces/${ws}/step-up`, { group: 'tokens', on: false })).status, 200)
  // The session is still bound to the tailnet identity after the passkey check.
  const off = server.direct()
  off.jar.set('__Host-sw_session', ben.jar.get('__Host-sw_session'))
  assert.equal((await off.get(`/api/workspaces/${ws}`)).status, 401)
  assert.ok(user.id)
})

test('while the serve config is not as this server made it, nobody is signed in by tailnet identity', async () => {
  const server = await tailnet('tailnet-watch')
  const adaDevice = await server.device(ADA)
  const ada = await claimWithPasskey(server, adaDevice)
  const phone = adaDevice.browser()
  assert.equal((await me(phone)).json.via, 'tailnet')
  // Someone adds a raw TCP forward to the server's port.
  server.tailscale.state.config.TCP[9000] = { TCPForward: `127.0.0.1:${server.localPort}` }
  await server.tailnetWatch()
  assert.ok(server.lines.some((line) => /^Tailnet sign-in is suspended: a raw TCP forward/.test(line)))
  assert.equal((await phone.get(`/api/workspaces/${ada.workspaceId}`)).status, 401, 'tailnet sessions stop counting')
  assert.equal((await me(adaDevice.browser())).json.user, null)
  assert.equal((await ada.browser.get(`/api/workspaces/${ada.workspaceId}`)).status, 200, 'passkey sessions are not affected')
  delete server.tailscale.state.config.TCP[9000]
  await server.tailnetWatch()
  assert.ok(server.lines.some((line) => /^Tailnet sign-in is back/.test(line)))
  assert.equal((await phone.get(`/api/workspaces/${ada.workspaceId}`)).status, 200)
})

// ---- After the security review -----------------------------------------------------------------

test('signing up with a passkey through the tailnet does not link the login unless the person asks', async () => {
  const server = await tailnet('tailnet-signup-link')
  const adaDevice = await server.device(ADA)
  // The setup link, a passkey, the box not ticked.
  const ada = await signUp(server.as(adaDevice), { handle: 'ada' })
  const mine = await me(ada.browser)
  assert.deepEqual({ here: mine.json.tailnet.here, linked: mine.json.tailnet.linked }, { here: 'ada@example.com', linked: null })
  assert.equal((await me(adaDevice.browser())).json.tailnet.state, 'unknown', 'arriving again signs nobody in')
  assert.equal(server.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'tailnet_linked'").get().n, 0)
  // Ticked: linked, and said so in the account's log.
  const benDevice = await server.device(BEN)
  const ben = await signUp(server.as(benDevice), { handle: 'ben', invite: await invite(ada, ada.workspaceId, 'member'), linkTailnet: true })
  assert.equal((await me(ben.browser)).json.tailnet.linked, 'ben@example.com')
  const events = (await ben.browser.get('/auth/security-log')).json.events
  assert.deepEqual(events.find((event) => event.action === 'tailnet_linked').detail, { tailnet: 'ben@example.com', atSignUp: true })
  assert.equal((await me(benDevice.browser())).json.via, 'tailnet')
  // Asked for where there is no identity, or for a login that is taken: refused before any passkey is made.
  const token = await invite(ada, ada.workspaceId, 'member')
  const off = await server.direct().post('/auth/register/options', { handle: 'cyd', displayName: 'Cyd', invite: token, linkTailnet: true })
  assert.equal(off.json.error.code, 'tailnet_required')
  const taken = await benDevice
    .browser()
    .post('/auth/register/options', { handle: 'cyd', displayName: 'Cyd', invite: token, linkTailnet: true })
  assert.equal(taken.json.error.code, 'tailnet_login_taken')
  // The login is the one the sign-up was started with: finishing from another person's device links nothing.
  const cydDevice = await server.device(CYD)
  const { createAuthenticator } = await import('./hosted-helpers.js')
  const browser = cydDevice.browser()
  const start = await browser.post('/auth/register/options', { handle: 'cyd', displayName: 'Cyd', invite: token, linkTailnet: true })
  assert.equal(start.status, 200, start.text)
  const elsewhere = (await server.device({ login: 'dee@example.com', name: 'Dee' })).browser()
  for (const [name, value] of browser.jar) elsewhere.jar.set(name, value)
  const done = await elsewhere.post('/auth/register/verify', {
    response: createAuthenticator({ origin: TAILNET_ORIGIN }).register(start.json.options),
  })
  assert.equal(done.status, 201, done.text)
  assert.equal(server.db.prepare("SELECT tailnet_login FROM users WHERE handle = 'cyd'").get().tailnet_login, null)
})

test('"Approve command line logins in the browser" is decided by the server: a session that only a tailnet identity stands behind cannot approve, whatever it sends', async () => {
  const server = await tailnet('tailnet-cli-barrier')
  const ada = await claimWithPasskey(server, await server.device(ADA))
  const ws = ada.workspaceId
  const project = (await ada.browser.post(`/api/workspaces/${ws}/projects`, { name: 'Site' })).json.project
  const benDevice = await server.device(BEN)
  const { browser: ben } = await joinByInvite(server, ada, benDevice, 'admin')
  const startLogin = async () =>
    (
      await fetch(`http://127.0.0.1:${server.localPort}/api/v1/device/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'laptop' }),
      })
    ).json()
  const approve = async (browser, headers = {}, code = null) =>
    browser.post(
      '/api/device/approve',
      { code: code || (await startLogin()).userCode, workspaceId: ws, projectId: project.id, scopes: ['read'] },
      { headers },
    )
  // Off (the default): the identity is enough, and the audit entry says how it was approved.
  assert.equal((await approve(ben)).status, 200)
  const entry = JSON.parse(server.db.prepare("SELECT detail FROM audit_log WHERE action = 'token_created' ORDER BY id DESC").get().detail)
  assert.deepEqual(
    { approvedBy: entry.approvedBy, signedInBy: entry.signedInBy },
    { approvedBy: 'tailnet identity', signedInBy: 'tailnet' },
  )
  // On: no header, any header, as a browser or as the command line: refused.
  assert.equal((await call(ada.browser, 'PATCH', `/api/workspaces/${ws}/step-up`, { cliApproval: true })).status, 200)
  const waiting = (await startLogin()).userCode
  for (const headers of [
    {},
    { 'X-Shapewall-Client': 'cli' },
    { 'X-Shapewall-Client': 'browser' },
    { 'User-Agent': 'Mozilla/5.0 Chrome/140' },
  ]) {
    const refused = await approve(ben, headers, waiting)
    assert.equal(refused.status, 403, JSON.stringify(headers))
    assert.equal(refused.json.error.code, 'passkey_required')
    assert.equal(refused.json.error.stepUp, 'cliApproval')
  }
  // The owner's passkey session approves; her own tailnet session asks for the passkey, and with it approves.
  assert.equal((await approve(ada.browser, {}, waiting)).status, 200)
  const adaTailnet = (await server.device(ADA)).browser()
  await me(adaTailnet)
  const second = (await startLogin()).userCode
  const asked = await approve(adaTailnet, {}, second)
  assert.equal(asked.json.error.code, 'reauth_required')
  assert.match(asked.json.error.message, /only with a passkey, in the browser/)
  await reauth({ browser: adaTailnet, authenticator: ada.authenticator })
  assert.equal((await approve(adaTailnet, {}, second)).status, 200)
  const last = JSON.parse(server.db.prepare("SELECT detail FROM audit_log WHERE action = 'token_created' ORDER BY id DESC").get().detail)
  assert.equal(last.approvedBy, undefined, 'a passkey stood behind that one')
})

test('a tailnet session is stored so that a build from before tailnet sign-in cannot use it, and what it has open is cut when it ends', async () => {
  const server = await tailnet('tailnet-downgrade')
  const adaDevice = await server.device(ADA)
  const ada = await claimWithPasskey(server, adaDevice)
  const phone = adaDevice.browser()
  await me(phone)
  const sha = (value) => createHash('sha256').update(value).digest('hex')
  const token = phone.jar.get('__Host-sw_session')
  const rows = server.db.prepare('SELECT token_hash, tailnet_login FROM sessions ORDER BY tailnet_login').all()
  // An older build looks a cookie up by the hash of the token (its readSession): it finds the passkey session only.
  const olderBuildFinds = (cookie) => rows.find((row) => row.token_hash === sha(cookie)) || null
  assert.equal(olderBuildFinds(token), null)
  assert.ok(olderBuildFinds(ada.browser.jar.get('__Host-sw_session')))
  assert.ok(rows.some((row) => row.token_hash === sha(`tailnet:${token}`) && row.tailnet_login === 'ada@example.com'))
  // Nor can a row be read the other way round in this build: the login column and the hash must agree.
  server.db.prepare('UPDATE sessions SET tailnet_login = NULL WHERE token_hash = ?').run(sha(`tailnet:${token}`))
  assert.equal((await phone.get(`/api/workspaces/${ada.workspaceId}`)).status, 401)
  server.db
    .prepare("UPDATE sessions SET tailnet_login = 'ada@example.com' WHERE token_hash = ?")
    .run(sha(ada.browser.jar.get('__Host-sw_session')))
  assert.equal((await ada.browser.get(`/api/workspaces/${ada.workspaceId}`)).status, 401)

  // Open responses of tailnet sessions (live streams) are cut: by person on unlink, all of them when trust is suspended.
  const { createGuards } = await import('../src/hosted/guards.js')
  const session = (id) => ({
    user: { id, tailnet_login: `${id}@example.com` },
    session: { via: 'tailnet', tailnet_login: `${id}@example.com` },
  })
  const guards = createGuards({
    db: server.db,
    auth: { readSession: (cookie) => (cookie ? session(cookie) : null) },
    tailnet: { identityOf: (req) => ({ login: `${req.who}@example.com` }) },
    SESSION_COOKIE: 'sw_session',
    siteOf: () => ({ origin: TAILNET_ORIGIN }),
    rateLimiter: null,
    quotas: null,
    now: () => new Date(),
    iso: () => new Date().toISOString(),
    log: () => {},
  })
  const open = (who) => {
    const res = new EventEmitter()
    res.destroyed = false
    res.destroy = () => {
      res.destroyed = true
      res.emit('close')
    }
    const req = { who, headers: { cookie: `sw_session=${who}`, 'tailscale-user-login': `${who}@example.com` } }
    res.req = req
    guards.needSession(req, res, () => {})
    return res
  }
  const [one, two, three] = [open('ada'), open('ben'), open('ada')]
  three.emit('close') // answered and done: nothing to cut
  guards.cutTailnetSessions('ben')
  assert.deepEqual([one.destroyed, two.destroyed, three.destroyed], [false, true, false])
  guards.cutTailnetSessions()
  assert.deepEqual([one.destroyed, two.destroyed, three.destroyed], [true, true, false])
  // The watch cuts them when the serve config goes wrong.
  let cuts = 0
  server.app.locals.cutTailnetSessions = () => (cuts += 1)
  server.tailscale.state.status.TUN = false
  await server.tailnetWatch()
  assert.equal(cuts, 1)
  assert.ok(server.lines.some((line) => /^Tailnet sign-in is suspended: tailscaled runs in userspace-networking mode/.test(line)))
  await server.tailnetWatch()
  assert.equal(cuts, 1, 'once, when it is suspended')
  server.tailscale.state.status.TUN = true
  server.facts.now = { ...plainFacts(), tailscaled: [{ pid: 1, uid: 0, argv: ['tailscaled', '--socks5-server=localhost:1055'] }] }
  await server.tailnetWatch()
  assert.equal(server.tailnet.suspended().includes('SOCKS5'), false, 'the first reason stays until it is right again')
  server.facts.now = plainFacts()
  await server.tailnetWatch()
  assert.equal(server.tailnet.suspended(), null)
})

test('the serve secret is in no error either: tailscale quoting its arguments back does not leak it', async () => {
  const fake = fakeTailscale()
  let secret = null
  const run = async (command, args) => {
    if (args[0] === 'serve' && args.includes('--bg')) {
      secret = /\/_ts\/(.+)$/.exec(args.at(-1))[1]
      return { code: 1, stdout: '', stderr: `invalid argument: ${args.at(-1)}` }
    }
    return fake.run(command, args)
  }
  const failure = await startHosted({
    dataDir: tempDir('tailnet-secret-error'),
    port: 0,
    env: {},
    out: () => {},
    exitOnStop: false,
    tailscale: { httpsPort: 443, funnel: null, run, watchMs: 0 },
    tailnetSignIn: true,
    tailnetProof: { trusted: () => true },
    tailnetFacts: plainFacts,
  }).catch((error) => error)
  assert.match(failure.message, /tailscale serve --https=443 failed/)
  assert.ok(secret && secret.length === 43)
  assert.equal(failure.message.includes(secret), false)
})
