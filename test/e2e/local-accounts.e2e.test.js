import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import { createApp, stopChildren } from '../../src/server/app.js'
import { openDatabase } from '../../src/hosted/db.js'
import { demoSetup } from './helpers.js'

let browser
before(async () => {
  browser = await chromium.launch()
})
after(async () => {
  await browser?.close()
})

async function authenticator(context, page) {
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  return { cdp, authenticatorId }
}

test('Tailscale owner enrolls through a fixed HTTPS origin without an owner token in the browser', async () => {
  const setup = await demoSetup('tailscale-account-ui')
  const db = await openDatabase(path.join(setup.dir, 'accounts.sqlite'))
  const key = path.join(setup.dir, 'fixture-key.pem')
  const cert = path.join(setup.dir, 'fixture-cert.pem')
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=fixture.example.ts.net'],
    { stdio: 'ignore' },
  )
  const tailscale = { host: 'fixture.example.ts.net', ownerLogin: 'owner@example.test' }
  const holder = {}
  // Simulate the trusted Tailscale local proxy, overwriting inbound identity.
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    req.headers['tailscale-user-login'] = tailscale.ownerLogin
    holder.app(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `https://${tailscale.host}:${server.address().port}`
  holder.app = createApp({
    config: setup.config,
    chat: true,
    settingsToken: 'fixture-owner-not-in-browser',
    env: { HOME: setup.dir, XDG_CONFIG_HOME: setup.dir, PATH: '' },
    allowedHosts: new Set([tailscale.host]),
    remote: { tailscale },
    localAccounts: { db, origin },
  })
  const tlsBrowser = await chromium.launch({ args: ['--host-resolver-rules=MAP fixture.example.ts.net 127.0.0.1', '--no-proxy-server'] })
  const context = await tlsBrowser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await authenticator(context, page)
  try {
    await page.goto(`${origin}/account`)
    await page.locator('[data-sw-local-account-name]').fill('Owner Fixture')
    await page.locator('[data-sw-local-account-handle]').fill('owner-fixture')
    await page.locator('[data-sw-local-account-create]').click()
    await page.locator('[data-sw-recovery-codes]').waitFor()
    assert.equal(await page.locator('[data-sw-recovery-code-item]').count(), 10)
    await page.locator('#saved').click()
    await page.locator('[data-sw-codes-done]').click()
    await page.locator('[data-sw-profile-photo]').waitFor()
    assert.equal(await page.locator('[data-sw-passkey]').count(), 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1)
    assert.equal(await page.evaluate(() => sessionStorage.getItem('shapewall-settings-token')), null)
    assert.equal(await page.evaluate(async () => (await (await fetch('/api/agent/settings')).json()).editable), false)
    assert.equal(
      await page.evaluate(
        async () =>
          (
            await fetch('/api/agent/settings', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ settings: { backend: 'acp', acpCommand: 'untrusted' } }),
            })
          ).status,
      ),
      403,
    )
    assert.deepEqual(errors, [])
    if (process.env.SHAPEWALL_SHOTS) {
      fs.mkdirSync(process.env.SHAPEWALL_SHOTS, { recursive: true })
      await page.screenshot({ path: path.join(process.env.SHAPEWALL_SHOTS, 'tailscale-first-owner.png'), fullPage: true })
    }
  } finally {
    await tlsBrowser.close()
    stopChildren(holder.app)
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    db.close()
    await setup.close()
  }
})

for (const width of [1440, 390, 320])
  test(`local passkey account, profile photo and second browser at ${width}px`, async () => {
    const setup = await demoSetup(`local-account-ui-${width}`)
    const db = await openDatabase(path.join(setup.dir, 'accounts.sqlite'))
    const holder = {}
    const server = http.createServer((req, res) => holder.app(req, res))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://localhost:${server.address().port}`
    holder.app = createApp({
      config: setup.config,
      chat: false,
      settingsToken: 'fixture-owner',
      env: { HOME: setup.dir, XDG_CONFIG_HOME: setup.dir, PATH: '' },
      localAccounts: { db, origin },
    })
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
    const other = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    const errors = []
    const hostedLegalRequests = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/legal') hostedLegalRequests.push(request.url())
    })
    const auth = await authenticator(context, page)
    try {
      await page.goto(`${origin}/console#settings-token=fixture-owner`)
      await page.locator('[data-sw-local-console]').waitFor()
      assert.equal(await page.locator('[data-sw-local-project]').count(), setup.config.boards.length)
      await page.locator('[data-sw-profile-menu]').click()
      await page.locator('[data-sw-profile-item="account"]').click()
      await page.locator('[data-sw-local-account-name]').fill('Fixture Reviewer')
      await page.locator('[data-sw-local-account-handle]').fill('fixture-reviewer')
      await page.locator('[data-sw-local-account-create]').click()
      await page.locator('[data-sw-recovery-codes]').waitFor()
      assert.equal(await page.locator('[data-sw-recovery-code-item]').count(), 10)
      assert.equal(await page.locator('[data-sw-codes-done]').isDisabled(), true)
      await page.locator('#saved').click()
      await page.locator('[data-sw-codes-done]').click()
      await page.locator('[data-sw-profile-photo]').waitFor()
      assert.equal(await page.locator('[data-sw-passkey]').count(), 1)
      assert.equal((await other.request.get(`${origin}/api/boards`)).status(), 401)
      const png = new PNG({ width: 64, height: 96 })
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i] = 30
        png.data[i + 1] = 140
        png.data[i + 2] = 190
        png.data[i + 3] = 255
      }
      await page
        .locator('[data-sw-profile-photo-file]')
        .setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: PNG.sync.write(png) })
      await page.getByText('Profile photo saved.', { exact: true }).waitFor()
      const photo = page.locator('[data-sw-profile-photo] img')
      await photo.waitFor()
      assert.equal(await photo.evaluate((img) => img.complete && img.naturalWidth === 256), true)
      await page.reload()
      await page.locator('[data-sw-profile-photo] img').waitFor()
      await page
        .locator('[data-sw-profile-photo-file]')
        .setInputFiles({ name: 'bad.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') })
      await page.getByText('Choose a PNG, JPEG or WebP image.', { exact: true }).waitFor()
      assert.equal(await page.locator('[data-sw-profile-photo] img').count(), 1)
      await page.locator('[data-sw-profile-name]').fill('Updated Fixture')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.getByText('Name saved', { exact: true }).waitFor()
      await page.goto(`${origin}/console`)
      await page.locator('[data-sw-local-console]').waitFor()
      await page.locator('[data-sw-profile-menu]').click()
      await page.locator('[data-sw-profile-item="account"]').click()
      await page.locator('[data-sw-profile-photo]').waitFor()
      assert.equal(await page.locator('[data-sw-profile-name]').inputValue(), 'Updated Fixture')
      assert.equal(await page.locator('select').count(), 0)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      if (process.env.SHAPEWALL_SHOTS) {
        fs.mkdirSync(process.env.SHAPEWALL_SHOTS, { recursive: true })
        await page.screenshot({ path: path.join(process.env.SHAPEWALL_SHOTS, `local-account-${width}.png`), fullPage: true })
      }
      const { credentials } = await auth.cdp.send('WebAuthn.getCredentials', { authenticatorId: auth.authenticatorId })
      const second = await other.newPage()
      const otherAuth = await authenticator(other, second)
      await otherAuth.cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: otherAuth.authenticatorId, enabled: false })
      for (const credential of credentials)
        await otherAuth.cdp.send('WebAuthn.addCredential', { authenticatorId: otherAuth.authenticatorId, credential })
      // Presence stays off until the button's own ceremony starts, so the
      // passkey autofill request (which the click aborts) cannot sign in
      // first. The authenticator never answers a request made while presence
      // is off, so the button's options request is held until it is back on.
      const autofillOptions = second.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/auth/login/options'))
      await second.goto(`${origin}/account`)
      await autofillOptions
      let presenceOn
      let buttonAsked
      const presence = new Promise((resolve) => (presenceOn = resolve))
      const buttonOptions = new Promise((resolve) => (buttonAsked = resolve))
      await second.route('**/auth/login/options', async (route) => {
        buttonAsked()
        await presence
        await route.continue()
      })
      await second.locator('[data-sw-passkey-signin]').click()
      await buttonOptions
      await otherAuth.cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: otherAuth.authenticatorId, enabled: true })
      presenceOn()
      await second.locator('[data-sw-profile-photo] img').waitFor()
      assert.equal((await other.request.get(`${origin}/api/boards`)).status(), 200)
      await second.locator('[data-sw-profile-photo-remove]').click()
      await second.getByText('Profile photo removed.', { exact: true }).waitFor()
      await page.reload()
      await page.locator('[data-sw-profile-photo]').waitFor()
      assert.equal(await page.locator('[data-sw-profile-photo] img').count(), 0)
      await auth.cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: auth.authenticatorId, enabled: false })
      await page.locator('[data-sw-profile-menu]').click()
      await page.locator('[data-sw-profile-item="sign-out"]').click()
      await page.locator('[data-sw-passkey-signin]').waitFor()
      assert.equal((await context.request.get(`${origin}/api/boards`)).status(), 401)
      await page.goto(`${origin}/?board=${setup.config.boards[0].id}`)
      await page.locator('[data-sw-passkey-signin]').waitFor()
      assert.equal(new URL(page.url()).pathname, '/signin')
      assert.deepEqual(hostedLegalRequests, [], 'local account screens do not request hosted operator policies')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
      await other.close()
      stopChildren(holder.app)
      await new Promise((resolve) => server.close(resolve))
      db.close()
      await setup.close()
    }
  })
