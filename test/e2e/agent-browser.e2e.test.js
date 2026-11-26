// The agent's throwaway browser against a loopback fixture app: the app is
// reachable, nothing off the allowlist is (another loopback port, a public
// host, a redirect, a WebSocket, a worker, a popup, file:/data:/blob:), the
// profile folder is gone afterwards, and a logged-in profile is only one
// Shapewall made.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { browserTools, createAgentBrowser, sweepAgentBrowserDirs, browserRoot } from '../../src/agent/agent-browser.js'
import { markBrowserProfile } from '../../src/agent/capabilities.js'
import { tempDir } from '../helpers.js'

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'agent-browser-child.mjs')

let app, other, appOrigin, otherOrigin, otherPort, appPort, tmpRoot
const otherHits = []
const page = (title, body = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`

function server(handler) {
  const s = http.createServer(handler)
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(s)))
}

before(async () => {
  tmpRoot = tempDir('agent-browser')
  other = await server((req, res) => {
    otherHits.push(req.url)
    res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' })
    res.end(page('Other'))
  })
  otherPort = other.address().port
  otherOrigin = `http://127.0.0.1:${otherPort}`
  new WebSocketServer({ server: other }).on('connection', () => otherHits.push('ws'))
  app = await server((req, res) => {
    const url = new URL(req.url, 'http://app')
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: url.searchParams.get('to') })
      return res.end()
    }
    if (url.pathname === '/worker.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      return res.end(`fetch(${JSON.stringify(otherOrigin + '/from-worker')}).then(() => postMessage('sent'), () => postMessage('failed'))`)
    }
    if (url.pathname === '/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      return res.end('self.addEventListener("fetch", () => {})')
    }
    if (url.pathname === '/api') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"ok":true}')
    }
    if (url.pathname === '/storage') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end(
        page('Storage', '<p id="out"></p><script>out.textContent = document.cookie + "|" + (localStorage.getItem("seed") || "-")</script>'),
      )
    }
    if (url.pathname === '/form') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end(
        page(
          'Form',
          '<input id="name"><button id="go" onclick="document.getElementById(\'said\').textContent = \'Hi \' + document.getElementById(\'name\').value">Go</button><p id="said"></p><script>console.error("fixture console error")</script>',
        ),
      )
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(page('Fixture app', '<p>Hello from the fixture.</p>'))
  })
  appPort = app.address().port
  appOrigin = `http://127.0.0.1:${appPort}`
  new WebSocketServer({ server: app }).on('connection', (socket) => socket.on('message', (data) => socket.send('echo:' + data)))
})

after(async () => {
  app.closeAllConnections()
  other.closeAllConnections()
  await new Promise((resolve) => app.close(resolve))
  await new Promise((resolve) => other.close(resolve))
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

const caps = (extra = {}) => ({ on: true, allow: [appOrigin], auth: null, profile: null, realChrome: false, ...extra })

// Chromium processes whose command line names `dir`.
function chromiumFor(dir) {
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
// A page.goto right after a blocked load can race Chromium's error page.
async function reload(p, url) {
  for (let i = 0; ; i += 1) {
    try {
      return await p.goto(url)
    } catch (error) {
      if (i >= 3 || !/interrupted by another navigation/.test(error.message)) throw error
      await p.waitForTimeout(200)
    }
  }
}
async function until(check, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

test('the fixture app is reachable; another loopback port and a public host are not', async () => {
  const agent = createAgentBrowser({ browser: caps(), tmpRoot })
  try {
    const opened = await agent.navigate(appOrigin + '/')
    assert.equal(opened.status, 200)
    assert.equal(opened.title, 'Fixture app')
    await assert.rejects(agent.navigate(otherOrigin + '/'), /not on this browser's allowlist/)
    await assert.rejects(agent.navigate('https://example.com/'), /not on this browser's allowlist/)
    await assert.rejects(agent.navigate('file:///etc/hostname'), /Only http and https/)
    await assert.rejects(agent.navigate('data:text/html,hi'), /Only http and https/)
    // A relative path opens on the current origin.
    assert.equal((await agent.navigate('/form')).title, 'Form')

    // Past the tool's own check: straight through Playwright, the route still refuses.
    const p = await agent.page()
    await assert.rejects(p.goto(otherOrigin + '/direct'), /ERR_BLOCKED_BY_CLIENT|ERR_FAILED/)
    await assert.rejects(p.goto('https://example.com/'), /ERR_BLOCKED_BY_CLIENT|ERR_FAILED/)
    await reload(p, appOrigin + '/')

    const tried = await p.evaluate(
      async ({ other }) => {
        const attempt = async (fn) => {
          try {
            return await fn()
          } catch (error) {
            return 'failed:' + String(error).slice(0, 40)
          }
        }
        const out = {}
        out.fetch = await attempt(() => fetch(other + '/fetch').then((r) => r.status))
        out.public = await attempt(() => fetch('https://example.com/').then((r) => r.status))
        out.xhr = await new Promise((resolve) => {
          const xhr = new XMLHttpRequest()
          xhr.open('GET', other + '/xhr')
          xhr.onload = () => resolve(xhr.status)
          xhr.onerror = () => resolve('failed')
          xhr.send()
        })
        out.redirect = await attempt(() => fetch('/redirect?to=' + encodeURIComponent(other + '/redirected')).then((r) => r.status))
        out.image = await new Promise((resolve) => {
          const img = new Image()
          img.onload = () => resolve('loaded')
          img.onerror = () => resolve('failed')
          img.src = other + '/image.png'
        })
        out.beacon = navigator.sendBeacon(other + '/beacon', 'x')
        out.ws = await new Promise((resolve) => {
          const ws = new WebSocket(other.replace('http', 'ws') + '/ws')
          ws.onopen = () => resolve('open')
          ws.onerror = () => resolve('failed')
          ws.onclose = () => resolve('closed')
        })
        out.okWs = await new Promise((resolve) => {
          const ws = new WebSocket(location.origin.replace('http', 'ws') + '/ws')
          ws.onopen = () => ws.send('ping')
          ws.onmessage = (event) => resolve(event.data)
          ws.onerror = () => resolve('failed')
        })
        out.worker = await new Promise((resolve) => {
          const worker = new Worker('/worker.js')
          worker.onmessage = (event) => resolve(event.data)
          setTimeout(() => resolve('timeout'), 5000)
        })
        out.serviceWorker = await attempt(() =>
          navigator.serviceWorker ? navigator.serviceWorker.register('/sw.js').then(() => 'registered') : 'none',
        )
        const frame = document.createElement('iframe')
        frame.src = other + '/frame'
        document.body.append(frame)
        await new Promise((resolve) => setTimeout(resolve, 800))
        out.ok = await fetch('/api').then((r) => r.json())
        return out
      },
      { other: otherOrigin },
    )
    assert.deepEqual(tried.ok, { ok: true }, 'the app itself answers')
    assert.match(String(tried.fetch), /^failed/)
    assert.match(String(tried.public), /^failed/)
    assert.equal(tried.xhr, 'failed')
    assert.match(String(tried.redirect), /^failed/)
    assert.equal(tried.image, 'failed')
    assert.notEqual(tried.ws, 'open')
    assert.equal(tried.okWs, 'echo:ping', 'a WebSocket to the app works')
    assert.equal(tried.worker, 'failed')
    assert.notEqual(tried.serviceWorker, 'registered')

    // A navigation that redirects off the list, and a form-less top-level move.
    // The proxy answers the off-list hop itself (403); the page never reaches it.
    const hop = await agent.navigate('/redirect?to=' + encodeURIComponent(otherOrigin + '/nav-redirect')).catch((error) => ({ error }))
    assert.ok(hop.error || hop.status === 403, JSON.stringify(hop))
    assert.notEqual(hop.title, 'Other')
    await reload(p, appOrigin + '/')
    await p.evaluate((other) => {
      location.href = other + '/assigned'
    }, otherOrigin)
    await p.waitForTimeout(800)
    assert.notEqual(new URL(p.url()).origin, otherOrigin)

    const log = agent.consoleErrors()
    assert.ok(log.blocked.length >= 5, JSON.stringify(log.blocked))
    assert.ok(
      log.blocked.some((entry) => entry.by === 'proxy'),
      'the redirect was stopped at the proxy',
    )
    await p.waitForTimeout(300)
    assert.deepEqual(otherHits, [], 'nothing reached the off-list port')
  } finally {
    await agent.close()
  }
})

test('popups off the list are closed; file:, data: and blob: navigations go back to about:blank', async () => {
  const agent = createAgentBrowser({ browser: caps(), tmpRoot })
  try {
    await agent.navigate(appOrigin + '/')
    const p = await agent.page()
    const context = p.context()
    const popup = context.waitForEvent('page')
    await p.evaluate((other) => window.open(other + '/popup'), otherOrigin)
    const opened = await popup
    assert.ok(await until(() => opened.isClosed(), 8000), 'the off-list popup was closed')

    const good = context.waitForEvent('page')
    await p.evaluate(() => window.open('/form'))
    const kept = await good
    await kept.waitForLoadState('load')
    assert.equal(kept.isClosed(), false)
    assert.ok(await until(async () => (await agent.page()) === kept, 5000), 'an allowed popup becomes the page the tools drive')
    await kept.close()

    const main = await agent.page()
    await reload(main, appOrigin + '/')
    await main.evaluate(() => {
      const blob = new Blob(['<h1>blob page</h1>'], { type: 'text/html' })
      location.href = URL.createObjectURL(blob)
    })
    assert.ok(await until(() => main.url() === 'about:blank', 8000), `blob: page left: ${main.url()}`)
    await reload(main, appOrigin + '/')
    await main.evaluate(() => {
      location.href = 'data:text/html,<h1>data page</h1>'
    })
    await main.waitForTimeout(500)
    assert.ok(!main.url().startsWith('data:'))
    // Shapewall's own code driving the page cannot land on file: either.
    await main.goto('file:///etc/hostname').catch(() => {})
    assert.ok(
      await until(() => ['about:blank', 'chrome-error://chromewebdata/'].includes(main.url()), 8000),
      `file: page left: ${main.url()}`,
    )
    assert.deepEqual(otherHits, [])
  } finally {
    await agent.close()
  }
})

test('an allowed name is pinned to the address it had at start; a public name pointing at loopback is refused', async () => {
  let lookups = 0
  const lookup = async (host) => {
    lookups += 1
    if (host === 'app.test' || host === 'rebind.example') return [{ address: '127.0.0.1', family: 4 }]
    throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
  }
  const agent = createAgentBrowser({
    browser: caps({ allow: [`http://app.test:${appPort}`, `http://rebind.example:${appPort}`, 'http://169.254.169.254'] }),
    tmpRoot,
    lookup,
  })
  try {
    const opened = await agent.navigate(`http://app.test:${appPort}/`)
    assert.equal(opened.title, 'Fixture app', 'app.test resolves only through the pinned address')
    await agent.navigate(`http://app.test:${appPort}/form`)
    assert.equal(lookups, 2, 'each name is looked up once, at start')
    const refused = agent.refused().map((entry) => entry.origin)
    assert.ok(refused.includes(`http://rebind.example:${appPort}`))
    assert.ok(refused.includes('http://169.254.169.254'))
    await assert.rejects(agent.navigate(`http://rebind.example:${appPort}/`), /allowlist/)
  } finally {
    await agent.close()
  }
})

test('nothing remains after close, after a browser crash, a SIGTERM or a SIGKILL; no CDP port', async () => {
  const root = browserRoot(tmpRoot)
  const agent = createAgentBrowser({ browser: caps(), tmpRoot })
  await agent.navigate(appOrigin + '/')
  const dir = agent.dir
  assert.ok(fs.existsSync(dir))
  const procs = chromiumFor(dir)
  assert.ok(procs.length, 'Chromium runs with the session folder')
  for (const proc of procs) {
    assert.ok(!proc.cmd.some((arg) => arg.startsWith('--remote-debugging-port')), 'no CDP port')
    assert.ok(!proc.cmd.some((arg) => arg.startsWith('--remote-debugging-address')))
  }
  assert.ok(procs.some((proc) => proc.cmd.includes('--remote-debugging-pipe')))
  await agent.close()
  assert.equal(fs.existsSync(dir), false)
  assert.ok(await until(() => chromiumFor(dir).length === 0), 'Chromium is gone')

  // A crash: the browser process dies under the agent.
  const crashing = createAgentBrowser({ browser: caps(), tmpRoot })
  await crashing.navigate(appOrigin + '/')
  const crashDir = crashing.dir
  const main = chromiumFor(crashDir).find((proc) => proc.cmd.some((arg) => arg.startsWith('--user-data-dir')))
  process.kill(main.pid, 'SIGKILL')
  assert.ok(await until(() => !fs.existsSync(crashDir)), 'the folder went with the crash')
  assert.equal(crashing.open, false)
  // The next call starts a fresh browser.
  assert.equal((await crashing.navigate(appOrigin + '/')).status, 200)
  await crashing.close()

  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const child = spawn(process.execPath, [CHILD, tmpRoot, appOrigin], { stdio: ['ignore', 'pipe', 'inherit'] })
    const line = await new Promise((resolve, reject) => {
      let text = ''
      child.stdout.on('data', (chunk) => {
        text += chunk
        if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0]))
      })
      child.on('exit', (code) => reject(new Error(`child exited ${code}`)))
    })
    assert.ok(fs.existsSync(line.dir))
    const exited = new Promise((resolve) => child.on('exit', resolve))
    child.kill(signal)
    await exited
    assert.ok(await until(() => chromiumFor(line.dir).length === 0), `Chromium is gone after ${signal}`)
    if (signal === 'SIGTERM') assert.equal(fs.existsSync(line.dir), false, 'removed at SIGTERM')
    else {
      // A SIGKILL runs no code; the next start sweeps the folder.
      assert.equal(fs.existsSync(line.dir), true)
      assert.deepEqual(sweepAgentBrowserDirs({ root }), [line.dir])
      assert.equal(fs.existsSync(line.dir), false)
    }
  }
  assert.deepEqual(fs.readdirSync(root), [], 'no session folder left')
})

test('a recorded login loads into the throwaway context, kept to the allowed origins', async () => {
  const checkout = tempDir('agent-browser-checkout')
  fs.mkdirSync(path.join(checkout, '.shapewall-auth'))
  fs.writeFileSync(
    path.join(checkout, '.shapewall-auth', 'main.auth.json'),
    JSON.stringify({
      cookies: [
        { name: 'session', value: 'fixture', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' },
        { name: 'elsewhere', value: 'no', domain: '.example.com', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' },
      ],
      origins: [
        { origin: appOrigin, localStorage: [{ name: 'seed', value: 'signed-in' }] },
        { origin: 'https://example.com', localStorage: [{ name: 'seed', value: 'leak' }] },
      ],
    }),
  )
  const agent = createAgentBrowser({ browser: caps({ auth: 'main' }), tmpRoot, checkout })
  try {
    await agent.navigate(appOrigin + '/storage')
    const read = await agent.text('#out')
    assert.equal(read.text, 'session=fixture|signed-in')
    const cookies = await (await agent.page()).context().cookies()
    assert.deepEqual(
      cookies.map((cookie) => cookie.name),
      ['session'],
    )
  } finally {
    await agent.close()
    fs.rmSync(checkout, { recursive: true, force: true })
  }
})

test('a persistent profile only when Shapewall made it, checked again right before launch', async () => {
  const base = tempDir('agent-browser-profiles')
  try {
    const chrome = path.join(base, 'google-chrome', 'Default')
    fs.mkdirSync(chrome, { recursive: true })
    await assert.rejects(
      createAgentBrowser({ browser: caps({ profile: chrome }), tmpRoot }).navigate(appOrigin + '/'),
      /Refused the browser profile/,
    )
    const unmarked = path.join(base, 'plain')
    fs.mkdirSync(unmarked)
    await assert.rejects(
      createAgentBrowser({ browser: caps({ profile: unmarked }), tmpRoot }).navigate(appOrigin + '/'),
      /Refused the browser profile/,
    )
    // Marked when the policy was saved, then the marker went away: refused at launch.
    const changed = markBrowserProfile(path.join(base, 'changed'))
    const later = createAgentBrowser({ browser: caps({ profile: changed }), tmpRoot })
    fs.rmSync(path.join(changed, '.shapewall-agent-profile'))
    await assert.rejects(later.navigate(appOrigin + '/'), /Refused the browser profile/)

    const profile = markBrowserProfile(path.join(base, 'agent-profile'))
    const agent = createAgentBrowser({ browser: caps({ profile }), tmpRoot })
    await agent.navigate(appOrigin + '/')
    assert.ok(chromiumFor(profile).length, 'Chromium runs on the marked profile')
    await agent.close()
    assert.ok(fs.existsSync(path.join(profile, '.shapewall-agent-profile')), 'the persistent profile stays')
    assert.deepEqual(fs.readdirSync(browserRoot(tmpRoot)), [], 'the session folder is still removed')
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('the browser_* tools: page data comes back quoted, screenshots are capped PNGs, errors are tool errors', async () => {
  const agent = createAgentBrowser({ browser: caps(), tmpRoot, screenshotMaxBytes: 20000 })
  const tools = Object.fromEntries(browserTools(agent).map((tool) => [tool.name, tool]))
  try {
    const nav = await tools.browser_navigate.handler({ url: appOrigin + '/form' })
    assert.equal(nav.isError, undefined)
    assert.match(nav.content[0].text, /^<shapewall-data source="agent-browser" trust="untrusted" tool="browser_navigate">/)
    const off = await tools.browser_navigate.handler({ url: otherOrigin + '/' })
    assert.equal(off.isError, true)
    assert.match(off.content[0].text, /allowlist/)
    await tools.browser_type.handler({ selector: '#name', text: 'Dan' })
    await tools.browser_click.handler({ selector: '#go' })
    const said = await tools.browser_text.handler({ selector: '#said' })
    assert.match(said.content[0].text, /Hi Dan/)
    const shot = await tools.browser_screenshot.handler({})
    assert.equal(shot.content[0].type, 'image')
    assert.equal(shot.content[0].mimeType, 'image/png')
    const png = Buffer.from(shot.content[0].data, 'base64')
    assert.equal(png.subarray(1, 4).toString(), 'PNG')
    assert.ok(png.length <= 20000, `screenshot ${png.length} bytes`)
    const log = await tools.browser_console.handler({})
    assert.match(log.content[0].text, /fixture console error/)
    const missing = await tools.browser_click.handler({ selector: '#nope' })
    assert.equal(missing.isError, true)
    const dir = agent.dir
    await tools.browser_close.handler({})
    assert.equal(fs.existsSync(dir), false)
  } finally {
    await agent.close()
  }
})

test('a dev server joins live, only through the token of one the tool host started, even mid-launch', async () => {
  const agent = createAgentBrowser({ browser: caps({ allow: [] }), tmpRoot })
  try {
    await assert.rejects(agent.allowSessionOrigin(appOrigin), /Not a dev server this session started/)
    await agent.allowSessionOrigin(agent.registerSpawned(appPort))
    assert.equal((await agent.navigate(appOrigin + '/')).status, 200)
    await agent.allowSessionOrigin(agent.registerSpawned(otherPort))
    assert.equal((await agent.navigate(otherOrigin + '/')).title, 'Other')
  } finally {
    await agent.close()
    otherHits.length = 0
  }
  // Added while the browser is still starting: not lost.
  for (const delay of [0, 50, 300]) {
    const racing = createAgentBrowser({ browser: caps(), tmpRoot })
    try {
      const starting = racing.page()
      await new Promise((resolve) => setTimeout(resolve, delay))
      await racing.allowSessionOrigin(racing.registerSpawned(otherPort))
      await starting
      assert.ok(racing.allowed().includes(otherOrigin), `added after ${delay} ms`)
      assert.equal((await racing.navigate(otherOrigin + '/')).title, 'Other')
    } finally {
      await racing.close()
      otherHits.length = 0
    }
  }
})

test('loopback stays behind the proxy with PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK set', async () => {
  const saved = process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK
  process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1'
  const agent = createAgentBrowser({ browser: caps(), tmpRoot })
  try {
    await agent.navigate(appOrigin + '/')
    const flags = chromiumFor(agent.dir).flatMap((proc) => proc.cmd.filter((arg) => arg.startsWith('--proxy-bypass-list')))
    assert.ok(flags.length && flags.every((flag) => flag === '--proxy-bypass-list=<-loopback>'), JSON.stringify(flags))
    const p = await agent.page()
    const hop = await p.goto(appOrigin + '/redirect?to=' + encodeURIComponent(otherOrigin + '/env-redirect')).then(
      (response) => response?.status(),
      (error) => error.message,
    )
    assert.notEqual(hop, 200)
    const fetched = await p
      .evaluate(
        (to) =>
          fetch('/redirect?to=' + encodeURIComponent(to)).then(
            (r) => r.status,
            () => 'failed',
          ),
        otherOrigin + '/env-fetch',
      )
      .catch(() => 'failed')
    assert.equal(fetched, 'failed')
    assert.deepEqual(otherHits, [], 'nothing reached the off-list port')
  } finally {
    await agent.close()
    if (saved === undefined) delete process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK
    else process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = saved
  }
})

test('without Chromium sandbox only with allowNoSandbox, and the tool output says so', async () => {
  const { chromium } = await import('playwright')
  const starts = []
  // Chromium's sandbox "cannot start" here: a forced launch error.
  const forced = {
    launchPersistentContext(dir, options) {
      starts.push(options.chromiumSandbox)
      if (options.chromiumSandbox) return Promise.reject(new Error('No usable sandbox! (forced by the test)'))
      return chromium.launchPersistentContext(dir, options)
    },
  }
  const refusing = createAgentBrowser({ browser: caps(), tmpRoot, chromium: forced, chromiumSandbox: true })
  await assert.rejects(refusing.navigate(appOrigin + '/'), /stays off/)
  assert.deepEqual(starts, [true])
  const agent = createAgentBrowser({ browser: caps({ allowNoSandbox: true }), tmpRoot, chromium: forced, chromiumSandbox: true })
  try {
    const tools = Object.fromEntries(browserTools(agent).map((tool) => [tool.name, tool]))
    const nav = await tools.browser_navigate.handler({ url: appOrigin + '/' })
    assert.equal(nav.isError, undefined)
    assert.match(
      nav.content.at(-1).text,
      /^Shapewall: Chromium's own sandbox could not start on this machine; this browser runs without it/,
    )
    assert.deepEqual(starts, [true, true, false])
  } finally {
    await agent.dispose()
  }
  assert.deepEqual(fs.readdirSync(browserRoot(tmpRoot)), [])
})

test('a tool call racing dispose: it ends, nothing restarts, nothing is left', async () => {
  const agent = createAgentBrowser({ browser: caps(), tmpRoot })
  await agent.navigate(appOrigin + '/')
  const inFlight = agent.navigate(appOrigin + '/form').then(
    () => 'done',
    (error) => error.message,
  )
  const disposing = agent.dispose()
  const after = agent.screenshot().then(
    () => 'shot',
    (error) => error.message,
  )
  await disposing
  await inFlight
  assert.match(await after, /ended with its task/)
  assert.equal(agent.open, false)
  await assert.rejects(agent.navigate(appOrigin + '/'), /ended with its task/)
  assert.deepEqual(fs.readdirSync(browserRoot(tmpRoot)), [])

  // dispose() while the browser is still starting: it never serves a call.
  const starting = createAgentBrowser({ browser: caps(), tmpRoot })
  const first = starting.navigate(appOrigin + '/').then(
    () => 'served',
    (error) => error.message,
  )
  await new Promise((resolve) => setTimeout(resolve, 50))
  await starting.dispose()
  assert.match(await first, /ended with its task/)
  assert.equal(starting.open, false)
  assert.ok(await until(() => fs.readdirSync(browserRoot(tmpRoot)).length === 0), 'its folder went too')
})
