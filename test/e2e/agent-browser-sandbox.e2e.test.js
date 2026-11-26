// The agent browser inside the OS sandbox (Linux: bubblewrap through the
// sandbox runtime, plus nsenter for the bridge). Real Chromium: the allowed
// loopback app loads; an off-list host fails at the proxy, and srt's own
// proxy refuses what its list does not hold; Chromium has its own network
// namespace and no view of the home folder or the checkout; its profile is
// the session folder; nothing is left after dispose.
//
// Skipped (with a notice) where the sandbox or the bridge is not available;
// SHAPEWALL_SANDBOX_TEST=1 (CI's sandbox job) makes that a failure on Linux.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createAgentBrowser, browserSandboxPlan, launchDirFor, SANDBOX_PROXY_PORT } from '../../src/agent/agent-browser.js'
import { upstreamDialer } from '../../src/agent/browser-egress.js'
import { acquireSandbox, closeSandbox } from '../../src/agent/sandbox-exec.js'
import { tempDir } from '../helpers.js'

const plan = browserSandboxPlan()
const required = process.env.SHAPEWALL_SANDBOX_TEST === '1' && process.platform === 'linux'
const box = { skip: plan.use || required ? false : `no OS sandbox for the browser here (${plan.why})`, timeout: 120_000 }
if (!plan.use && !required) console.log(`# agent-browser-sandbox: skipped, no OS sandbox for the browser here (${plan.why})`)

let app, other, appOrigin, otherOrigin, tmpRoot, marker
const otherHits = []
const page = (title) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`
function server(handler) {
  const s = http.createServer(handler)
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(s)))
}

before(async () => {
  // Under the home folder, as a real checkout is.
  tmpRoot = tempDir('agent-browser-sandbox')
  marker = path.join(tmpRoot, 'checkout-marker.txt')
  fs.writeFileSync(marker, 'the person checkout')
  other = await server((req, res) => {
    otherHits.push(req.url)
    res.end(page('Other'))
  })
  otherOrigin = `http://127.0.0.1:${other.address().port}`
  app = await server((req, res) => {
    const url = new URL(req.url, 'http://app')
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: url.searchParams.get('to') })
      return res.end()
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(page('Fixture app'))
  })
  appOrigin = `http://127.0.0.1:${app.address().port}`
})
after(async () => {
  await closeSandbox()
  app?.close()
  other?.close()
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function processesFor(dir) {
  const out = []
  for (const pid of fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      if (cmd.includes(dir)) out.push({ pid: Number(pid), cmd: cmd.split('\0') })
    } catch {
      // gone
    }
  }
  return out
}
const bridges = (dir) => processesFor(path.basename(dir)).filter((proc) => proc.cmd.includes('ns-bridge'))
async function until(check, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}
const caps = (extra = {}) => ({ on: true, allow: [appOrigin], auth: null, profile: null, realChrome: false, ...extra })

test('inside the OS sandbox: the app loads, an off-list host fails at the proxy, no home folder, nothing left', box, async () => {
  const agent = createAgentBrowser({ browser: caps(), tmpRoot })
  assert.equal(agent.isolation().planned, 'os-sandbox')
  let dir
  try {
    const opened = await agent.navigate(appOrigin + '/')
    assert.equal(opened.status, 200)
    assert.equal(opened.title, 'Fixture app')
    assert.equal(agent.isolation().now, 'os-sandbox')
    dir = agent.dir

    // Chromium: launched through the sandbox, its profile the session folder,
    // its proxy the bridge in its own namespace, no CDP port.
    const procs = processesFor(dir).filter((proc) => /chrom/i.test(proc.cmd[0]))
    const main = procs.find((proc) => proc.cmd.some((arg) => arg.startsWith('--user-data-dir=')))
    assert.ok(main, 'Chromium runs with the session folder')
    assert.equal(
      main.cmd.find((arg) => arg.startsWith('--user-data-dir=')),
      `--user-data-dir=${path.join(dir, 'profile')}`,
    )
    assert.ok(main.cmd.includes(`--proxy-server=http://127.0.0.1:${SANDBOX_PROXY_PORT}`))
    assert.ok(main.cmd.includes('--remote-debugging-pipe'))
    assert.ok(!main.cmd.some((arg) => arg.startsWith('--remote-debugging-port')), 'no CDP port')
    const ownNet = fs.readlinkSync('/proc/self/ns/net')
    for (const proc of procs) assert.notEqual(fs.readlinkSync(`/proc/${proc.pid}/ns/net`), ownNet, 'its own network namespace')

    // Its view of the files: the home folder (and the checkout in it) is not there.
    const view = (file) => path.join(`/proc/${main.pid}/root`, file)
    assert.ok(fs.existsSync(marker), 'the marker is on this machine')
    assert.equal(fs.existsSync(view(marker)), false, 'not inside the sandbox')
    assert.equal(fs.existsSync(view(path.join(os.homedir(), '.bashrc'))), false)
    assert.ok(fs.existsSync(view(path.join(dir, 'profile'))), 'the session folder is')
    // From a page, straight through Playwright past the tool's file: refusal:
    // the route refuses it first; the view above shows it would find nothing.
    const p = await agent.page()
    await assert.rejects(p.goto('file://' + marker), /ERR_BLOCKED_BY_CLIENT|ERR_FILE_NOT_FOUND|interrupted/)
    await p.goto(appOrigin + '/').catch(() => {})

    // An off-list host: a redirect from the app (the route never sees it) is
    // refused by the egress proxy, and never reaches the other server.
    agent.consoleErrors()
    const redirected = await p.evaluate(
      (to) =>
        fetch('/redirect?to=' + encodeURIComponent(to)).then(
          (r) => r.status,
          () => 'failed',
        ),
      otherOrigin + '/redirected',
    )
    assert.notEqual(redirected, 200)
    assert.deepEqual(otherHits, [], 'the other server saw nothing')
    assert.ok(agent.consoleErrors().blocked.some((entry) => entry.by === 'proxy' || entry.by === 'route'))
    await assert.rejects(agent.navigate(otherOrigin + '/'), /not on this browser's allowlist/)
  } finally {
    await agent.dispose()
  }
  assert.equal(fs.existsSync(dir), false, 'the session folder is gone')
  assert.equal(fs.existsSync(launchDirFor(path.basename(dir))), false, 'the launch folder is gone')
  assert.ok(await until(() => processesFor(dir).length === 0), 'Chromium and the sandbox are gone')
  assert.ok(await until(() => bridges(dir).length === 0), 'the bridge is gone')
})

test("srt's own proxy refuses an address:port its list does not hold", box, async () => {
  const { box: srt, release } = await acquireSandbox()
  try {
    const id = 'shapewall-e2e-' + Math.random().toString(36).slice(2, 14)
    srt.registerCommandNetworkLists(id, { allowedDomains: [`${new URL(appOrigin).hostname}:${new URL(appOrigin).port}`] })
    const dial = upstreamDialer({
      port: srt.getProxyPort(),
      username: `srt.${Buffer.from(id).toString('base64')}`,
      password: srt.getProxyAuthToken(),
    })
    const ok = await dial('127.0.0.1', Number(new URL(appOrigin).port))
    ok.destroy()
    await assert.rejects(dial('127.0.0.1', Number(new URL(otherOrigin).port)), /refused/)
    srt.unregisterCommandNetworkLists(id)
    await assert.rejects(dial('127.0.0.1', Number(new URL(appOrigin).port)), /refused/, 'gone with its list')
  } finally {
    release()
  }
})

test('a dev server port added live reaches the sandboxed browser; taken off, it does not', box, async () => {
  const dev = await server((req, res) => res.end(page('Dev server')))
  const port = dev.address().port
  const agent = createAgentBrowser({ browser: caps(), tmpRoot })
  try {
    await agent.navigate(appOrigin + '/')
    const token = agent.registerSpawned(port)
    assert.equal(await agent.allowSessionOrigin(token), true)
    assert.equal((await agent.navigate(`http://127.0.0.1:${port}/`)).title, 'Dev server')
    agent.revokeSpawned(token)
    await assert.rejects(agent.navigate(`http://127.0.0.1:${port}/`), /not on this browser's allowlist/)
    const p = await agent.page()
    await p.goto(appOrigin + '/')
    const after = await p.evaluate(
      (url) =>
        fetch(url).then(
          (r) => r.status,
          () => 'failed',
        ),
      `http://127.0.0.1:${port}/x`,
    )
    assert.equal(after, 'failed')
  } finally {
    await agent.dispose()
    dev.close()
  }
})
