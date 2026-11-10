// Checks what a process inside the starter agent's container can reach.
// `shapewall agent doctor` runs it in a container started exactly like the
// agent's; the opt-in integration test runs it as the agent's test command.
//
//   node probe.js [--out FILE] [--host-home DIR] [--allowed host:port] [--denied host:port]
//
// Prints one JSON line (and writes it to --out): each check with ok and detail.

import dns from 'node:dns/promises'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'

const TIMEOUT_MS = 4000

function arg(name, argv = process.argv) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : null
}

const withTimeout = (promise, ms = TIMEOUT_MS) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), ms))])

function statusField(name) {
  try {
    const line = fs
      .readFileSync('/proc/self/status', 'utf8')
      .split('\n')
      .find((item) => item.startsWith(`${name}:`))
    return line ? line.split(':')[1].trim() : null
  } catch {
    return null
  }
}

function tcp(host, port) {
  return withTimeout(
    new Promise((resolve) => {
      const socket = net.connect({ host, port })
      socket.once('connect', () => {
        socket.destroy()
        resolve({ connected: true })
      })
      socket.once('error', (error) => resolve({ connected: false, code: error.code }))
    }),
  )
}

// CONNECT through the proxy in HTTPS_PROXY: the status code it answers.
function viaProxy(target) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
  if (!proxy) return Promise.resolve({ status: null, code: 'no proxy set' })
  const url = new URL(proxy)
  return withTimeout(
    new Promise((resolve) => {
      const req = http.request({ host: url.hostname, port: url.port, method: 'CONNECT', path: target, agent: false })
      req.once('connect', (res, socket) => {
        socket.destroy()
        resolve({ status: res.statusCode })
      })
      req.once('response', (res) => {
        res.resume()
        resolve({ status: res.statusCode })
      })
      req.once('error', (error) => resolve({ status: null, code: error.code }))
      req.end()
    }),
    8000,
  )
}

// CONNECT to an allowed host:port, then a TLS ClientHello for another name:
// the proxy must close the tunnel before anything comes back.
function wrongName(target, servername) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
  if (!proxy) return Promise.resolve({ closed: false, detail: 'no proxy set' })
  const url = new URL(proxy)
  return withTimeout(
    new Promise((resolve) => {
      const req = http.request({ host: url.hostname, port: url.port, method: 'CONNECT', path: target, agent: false })
      req.once('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy()
          resolve({ closed: true, detail: `CONNECT -> ${res.statusCode}` })
          return
        }
        let got = 0
        socket.on('data', (chunk) => (got += chunk.length))
        const secure = tls.connect({ socket, servername, rejectUnauthorized: false })
        secure.once('secureConnect', () => {
          secure.destroy()
          resolve({ closed: false, detail: 'a TLS session came up' })
        })
        secure.once('error', (error) => {
          const closed = got === 0
          resolve({
            closed,
            detail: closed
              ? `closed by the proxy (${error.code || error.message})`
              : `the far end answered (${error.code || error.message})`,
          })
        })
      })
      req.once('response', (res) => {
        res.resume()
        resolve({ closed: true, detail: `CONNECT -> ${res.statusCode}` })
      })
      req.once('error', (error) => resolve({ closed: false, detail: error.code }))
      req.end()
    }),
    8000,
  )
}

// The agent process (in a run; none under the doctor): nothing else in the
// container may open its stdout or its memory.
function agentChannel() {
  let pids = []
  try {
    pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid)
  } catch {
    return { ok: false, detail: '/proc unreadable' }
  }
  for (const pid of pids) {
    let cmdline = ''
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    } catch {
      continue
    }
    if (!cmdline.includes('\0agent\0sandbox')) continue
    const tries = []
    for (const [file, flags] of [
      [`/proc/${pid}/fd/1`, 'w'],
      [`/proc/${pid}/mem`, 'r'],
    ]) {
      try {
        fs.closeSync(fs.openSync(file, flags))
        return { ok: false, detail: `opened ${file}` }
      } catch (error) {
        tries.push(`${file.split('/').slice(3).join('/')} ${error.code}`)
      }
    }
    return { ok: true, detail: `agent pid ${pid}: ${tries.join(', ')}` }
  }
  return { ok: true, detail: 'no agent process here' }
}

function writable(file) {
  try {
    fs.writeFileSync(file, 'x')
    fs.rmSync(file, { force: true })
    return true
  } catch {
    return false
  }
}

export async function probe(argv = process.argv) {
  const checks = {}
  const check = (name, ok, detail) => (checks[name] = { ok: Boolean(ok), detail })
  const uid = process.getuid()
  check('not root', uid !== 0, `uid ${uid}`)
  const caps = statusField('CapEff')
  check('no capabilities', caps !== null && /^0+$/.test(caps), `CapEff ${caps}`)
  const nnp = statusField('NoNewPrivs')
  check('no new privileges', nnp === '1', `NoNewPrivs ${nnp}`)
  check(
    'read-only root',
    !writable('/opt/shapewall-probe') && !writable('/etc/shapewall-probe') && !writable('/shapewall-probe'),
    'writes to /, /etc and /opt fail',
  )
  check('worktree writable', writable('/work/.shapewall-probe'), '/work')
  const hostHome = arg('host-home', argv)
  check(
    'no host home',
    !hostHome || !fs.existsSync(hostHome),
    hostHome ? `${hostHome} ${fs.existsSync(hostHome) ? 'exists' : 'absent'}` : 'not checked',
  )
  check('no ssh keys', !fs.existsSync(path.join(process.env.HOME || '/tmp/home', '.ssh')), `${process.env.HOME}/.ssh`)
  const sockets = ['/var/run/docker.sock', '/run/docker.sock', '/run/podman/podman.sock', '/var/run/podman/podman.sock'].filter((file) =>
    fs.existsSync(file),
  )
  check('no runtime socket', sockets.length === 0 && !process.env.XDG_RUNTIME_DIR && !process.env.DOCKER_HOST, sockets.join(', ') || 'none')
  let mounts = []
  try {
    mounts = fs
      .readFileSync('/proc/self/mounts', 'utf8')
      .split('\n')
      .map((line) => line.split(' ')[1])
      .filter(
        (point) => point && (point === '/work' || point.startsWith('/work/') || point.startsWith('/home') || point.startsWith('/root')),
      )
  } catch {
    mounts = ['unreadable']
  }
  check('only the worktree mounted', mounts.length === 1 && mounts[0] === '/work', mounts.join(', '))
  const names = Object.keys(process.env).sort()
  const expected =
    /^(HOME|TMPDIR|CI|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|NODE_USE_ENV_PROXY|npm_config_cache|npm_config_update_notifier|PLAYWRIGHT_BROWSERS_PATH|SHAPEWALL_SANDBOX|PATH|HOSTNAME|container|TERM|LANG|LC_ALL|FORCE_COLOR|NO_COLOR|NODE_VERSION|YARN_VERSION|DEBIAN_FRONTEND|NODE_ENV|_)$/
  const unexpected = names.filter((name) => !expected.test(name))
  check(
    'no host environment',
    unexpected.length === 0,
    unexpected.length ? `unexpected: ${unexpected.join(', ')}` : `${names.length} fixed names`,
  )
  const direct = await tcp('1.1.1.1', 443)
  check('no direct egress', !direct.connected, direct.connected ? 'connected to 1.1.1.1:443' : direct.timeout ? 'timed out' : direct.code)
  let resolved = null
  try {
    resolved = await withTimeout(dns.lookup('example.com'))
  } catch (error) {
    resolved = { code: error.code }
  }
  check(
    'no outside DNS',
    !resolved?.address,
    resolved?.address ? `example.com -> ${resolved.address}` : resolved?.timeout ? 'timed out' : resolved?.code,
  )
  // The host itself, by its gateway names and the network's .1 address, on a
  // port something listens on there (--host-port).
  const hostPort = Number(arg('host-port', argv)) || null
  if (hostPort) {
    const own = Object.values(os.networkInterfaces())
      .flat()
      .find((item) => item && item.family === 'IPv4' && !item.internal)?.address
    const targets = ['host.containers.internal', 'host.docker.internal', own ? own.replace(/\.\d+$/, '.1') : null].filter(Boolean)
    const reached = []
    for (const host of targets) {
      const result = await tcp(host, hostPort)
      if (result.connected) reached.push(host)
    }
    check(
      'no host access',
      reached.length === 0,
      reached.length ? `reached ${reached.join(', ')}:${hostPort}` : `${targets.join(', ')} port ${hostPort} unreachable`,
    )
  }
  const denied = arg('denied', argv) || 'example.com:443'
  const refused = await viaProxy(denied)
  check('proxy refuses other hosts', refused.status === 403, `CONNECT ${denied} -> ${refused.status ?? refused.code ?? 'timeout'}`)
  const allowed = arg('allowed', argv)
  if (allowed) {
    const passed = await viaProxy(allowed)
    check('proxy passes allowed hosts', passed.status === 200, `CONNECT ${allowed} -> ${passed.status ?? passed.code ?? 'timeout'}`)
    const wrong = await wrongName(allowed, 'not-allowed.example')
    check('proxy refuses another TLS name', wrong.closed, `${allowed} with SNI not-allowed.example: ${wrong.detail ?? 'timeout'}`)
  }
  const channel = agentChannel()
  check('agent channel closed', channel.ok, channel.detail)
  const report = { ok: Object.values(checks).every((item) => item.ok), checks }
  const out = arg('out', argv)
  if (out) fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  return report
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  probe().then(
    (report) => {
      process.stdout.write(`${JSON.stringify(report)}\n`)
      process.exit(0)
    },
    (error) => {
      process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
      process.exit(1)
    },
  )
}
