// The hosted server reached over a plain SSH tunnel, for people who do not
// use Tailscale: `ssh -L 4700:127.0.0.1:4700 server`, then the browser at
// the tunnel's own end. The server is started for that origin with no TLS
// (`--origin http://shapewall.localhost:<port>`, or plain
// `http://localhost:<port>`); both are secure contexts, so passkeys work.
// This starts the real command and uses a real browser at each origin,
// which is exactly what the browser end of such a tunnel sees (the tunnel
// itself is ssh's business).
//
// Why a host name of its own (shapewall.localhost): cookies are not kept
// apart by port. At plain localhost the session cookie also goes to any
// other web server on the same machine's localhost; at shapewall.localhost
// it goes to that name only. Both are tested; the docs lead with the name.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { chromium } from 'playwright'
import { tempDir } from '../helpers.js'
import { ROOT_DIR } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const CLI = path.join(ROOT_DIR, 'bin', 'shapewall.js')
let browser
const children = []

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port: found } = probe.address()
      probe.close(() => resolve(found))
    })
  })

// `shapewall hosted` as the docs say: no TLS, no proxy, loopback only, for the origin the tunnel's browser end has.
async function startFor(hostName) {
  const port = await freePort()
  const dataDir = tempDir(`hosted-ssh-e2e-${hostName.replace(/\W/g, '-')}`)
  const origin = `http://${hostName}:${port}`
  const lines = []
  const child = spawn(process.execPath, [CLI, 'hosted', '--data', dataDir, '--port', String(port), '--origin', origin], {
    env: { ...process.env, SHAPEWALL_HOSTED_SECRET: '', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  await new Promise((resolve, reject) => {
    const seen = (chunk) => {
      for (const line of String(chunk).split('\n')) if (line.trim()) lines.push(line)
      // The setup link is written right after the listening line: wait for the line that names it.
      if (lines.some((line) => /one-time setup link is in/.test(line))) resolve()
    }
    child.stdout.on('data', seen)
    child.stderr.on('data', seen)
    child.once('exit', (code) => reject(new Error(`shapewall hosted exited (${code}): ${lines.join(' | ')}`)))
  })
  return { port, dataDir, origin, lines }
}

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'console', 'console.html')), 'run "npm run build" before this e2e test')
  browser = await chromium.launch()
})
after(async () => {
  await browser?.close()
  for (const child of children) {
    if (child.exitCode !== null) continue
    const gone = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGINT')
    await gone
  }
})

// Another web server on the same machine's localhost (somebody's dev server): what does it get sent?
async function neighbour() {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req.headers.cookie || '')
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<p>another server</p>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, seen, close: () => new Promise((resolve) => server.close(resolve)) }
}

async function signUpAndIn(hostName, shot) {
  const { port, dataDir, origin, lines } = await startFor(hostName)
  assert.ok(
    lines.some((line) => line.includes(`is listening on 127.0.0.1:${port} for ${origin}`)),
    lines.join(' | '),
  )
  const setupLink = fs.readFileSync(path.join(dataDir, 'setup-link'), 'utf8').trim()
  assert.ok(setupLink.startsWith(`${origin}/signup#setup=`), 'the setup link is for the tunnel origin')
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  const other = await neighbour()
  try {
    await page.goto(setupLink)
    assert.equal(await page.evaluate(() => window.isSecureContext), true, `${origin} is a secure context: passkeys work`)
    await page.waitForSelector('[data-sw-signup-handle]')
    await page.fill('[data-sw-signup-handle]', 'ada')
    await page.fill('[data-sw-signup-name]', 'Ada')
    await page.click('[data-sw-signup-submit]')
    await page.waitForSelector('[data-sw-recovery-codes]')
    await page.click('#saved')
    await page.click('[data-sw-codes-done]')
    await page.waitForURL(/\/w\/ws_/)
    const me = await page.evaluate(() => fetch('/auth/me').then((response) => response.json()))
    assert.equal(me.user.handle, 'ada')
    assert.equal(me.rpId, hostName, 'the passkey belongs to this host name')
    assert.equal(me.via, 'passkey')
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `ssh-${shot}-signed-up.png`), animations: 'disabled' })
    // The session cookie on plain http: not Secure (it would not be sent), HttpOnly, and for this host only.
    const session = (await context.cookies(origin)).find((cookie) => /sw_session/.test(cookie.name))
    assert.ok(session, 'a session cookie')
    assert.deepEqual([session.httpOnly, session.sameSite, session.domain], [true, 'Lax', hostName])
    // Sign out, and in again: the passkey is offered by the handle field, and the virtual authenticator picks it.
    await page.evaluate(() =>
      fetch('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(
        (response) => response.ok,
      ),
    )
    await page.goto(`${origin}/signin`)
    await page.waitForURL(/\/w\/ws_/, { timeout: 15000 }).catch(async (error) => {
      throw new Error(`${error.message} | page: ${page.url()} | ${(await page.textContent('main')).slice(0, 400)}`)
    })
    const again = await page.evaluate(() => fetch('/auth/me').then((response) => response.json()))
    assert.equal(again.user.handle, 'ada')
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `ssh-${shot}-signed-in-again.png`), animations: 'disabled' })
    // The same server by its IP address is another origin: no session there.
    const byAddress = await page.evaluate(
      (url) =>
        fetch(url, { credentials: 'include' })
          .then((response) => response.status)
          .catch(() => 0),
      `http://127.0.0.1:${port}/api/workspaces`,
    )
    assert.notEqual(byAddress, 200)
    // Another web server on this machine's localhost, on another port: is the session cookie sent to it?
    const visit = await context.newPage()
    await visit.goto(`http://localhost:${other.port}/`)
    await visit.close()
    assert.deepEqual(errors, [])
    return { sentToNeighbour: other.seen.some((cookie) => /sw_session/.test(cookie)) }
  } finally {
    await other.close()
    await context.close()
  }
}

test('over an SSH tunnel, at a host name of its own: http://shapewall.localhost:<port> starts without TLS, sign-up and sign-in with a passkey work, and the session cookie stays with that name', async () => {
  const result = await signUpAndIn('shapewall.localhost', 'name')
  assert.equal(result.sentToNeighbour, false, 'another server on localhost does not get the session cookie')
})

test('over an SSH tunnel, at plain http://localhost:<port>: sign-up and sign-in work too, and the session cookie goes to every port of localhost', async () => {
  const result = await signUpAndIn('localhost', 'plain')
  // Cookies are not kept apart by port: this is the caveat the docs state, pinned here so it stays true to them.
  assert.equal(result.sentToNeighbour, true, 'another server on localhost is sent the session cookie')
})
