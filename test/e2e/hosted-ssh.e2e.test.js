// The hosted server reached over a plain SSH tunnel, for people who do not
// use Tailscale: `ssh -L 4700:127.0.0.1:4700 server`, then
// http://localhost:4700 in the browser. The server is started for that
// origin with no TLS (`--origin http://localhost:<port>`); localhost is a
// secure context, so passkeys work. This starts the real command and uses a
// real browser at the localhost origin, which is exactly what the browser
// end of such a tunnel sees (the tunnel itself is ssh's business).

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { chromium } from 'playwright'
import { tempDir } from '../helpers.js'
import { ROOT_DIR } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const CLI = path.join(ROOT_DIR, 'bin', 'shapewall.js')
let child
let browser
let port
let dataDir
const lines = []

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port: found } = probe.address()
      probe.close(() => resolve(found))
    })
  })

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'console', 'console.html')), 'run "npm run build" before this e2e test')
  port = await freePort()
  dataDir = tempDir('hosted-ssh-e2e')
  // As the docs say: no TLS, no proxy, loopback only, the origin a tunnel's browser end has.
  child = spawn(process.execPath, [CLI, 'hosted', '--data', dataDir, '--port', String(port), '--origin', `http://localhost:${port}`], {
    env: { ...process.env, SHAPEWALL_HOSTED_SECRET: '', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const ready = new Promise((resolve, reject) => {
    const seen = (chunk) => {
      for (const line of String(chunk).split('\n')) if (line.trim()) lines.push(line)
      if (lines.some((line) => /is listening on/.test(line))) resolve()
    }
    child.stdout.on('data', seen)
    child.stderr.on('data', seen)
    child.once('exit', (code) => reject(new Error(`shapewall hosted exited (${code}): ${lines.join(' | ')}`)))
  })
  await ready
  browser = await chromium.launch()
})
after(async () => {
  await browser?.close()
  if (child && child.exitCode === null) {
    const gone = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGINT')
    await gone
  }
})

test('over an SSH tunnel: the server starts for http://localhost:<port> without TLS, and sign-up and sign-in with a passkey work there', async () => {
  const origin = `http://localhost:${port}`
  assert.ok(
    lines.some((line) => line.includes(`is listening on 127.0.0.1:${port} for ${origin}`)),
    lines.join(' | '),
  )
  // Loopback only: the tunnel is the way in.
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
  try {
    await page.goto(setupLink)
    assert.equal(await page.evaluate(() => window.isSecureContext), true, 'http://localhost is a secure context: passkeys work')
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
    assert.equal(me.rpId, 'localhost')
    assert.equal(me.via, 'passkey')
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'ssh-1-signed-up.png'), animations: 'disabled' })
    // The session cookie on plain http to localhost: not Secure (it would not be sent), still HttpOnly.
    const cookies = await context.cookies(origin)
    const session = cookies.find((cookie) => /sw_session/.test(cookie.name))
    assert.ok(session, 'a session cookie')
    assert.deepEqual([session.httpOnly, session.sameSite], [true, 'Lax'])
    // Sign out, and in again with the passkey.
    await page.evaluate(() =>
      fetch('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(
        (response) => response.ok,
      ),
    )
    await page.goto(`${origin}/signin`)
    await page.waitForSelector('[data-sw-passkey-signin]')
    // The passkey is offered by the handle field's autofill, and the virtual authenticator picks it at once.
    await page.waitForURL(/\/w\/ws_/, { timeout: 15000 }).catch(async (error) => {
      throw new Error(error.message + ' | page: ' + page.url() + ' | ' + (await page.textContent('main')).slice(0, 400))
    })
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'ssh-2-signed-in-again.png'), animations: 'disabled' })
    const again = await page.evaluate(() => fetch('/auth/me').then((response) => response.json()))
    assert.equal(again.user.handle, 'ada')
    // The same server by its IP address is another origin: no session there, and no passkey for it.
    const byAddress = await page.evaluate(
      (url) =>
        fetch(url, { credentials: 'include' })
          .then((response) => response.status)
          .catch(() => 0),
      `http://127.0.0.1:${port}/api/workspaces`,
    )
    assert.notEqual(byAddress, 200)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
