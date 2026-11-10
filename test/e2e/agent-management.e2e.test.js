// Full account owner -> isolated host settings -> phone native chat path.
// The HTTPS proxy and ACP adapter are explicit fictional fixtures only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { chromium } from 'playwright'
import { createApp, stopChildren } from '../../src/server/app.js'
import { createAgentManagement } from '../../src/agent/manage.js'
import { openDatabase } from '../../src/hosted/db.js'
import { registerProject, projectsFile } from '../../src/local-projects.js'
import { writeServeState } from '../../src/serve-state.js'
import { ROOT_DIR, demoSetup } from './helpers.js'

test(
  'Tailscale account enrollment, isolated host profile setup and phone chat preserve the protected board',
  { timeout: 60000 },
  async () => {
    const setup = await demoSetup('management-owner-ui')
    const db = await openDatabase(path.join(setup.dir, 'accounts.sqlite'))
    const bin = path.join(setup.dir, 'bin')
    fs.mkdirSync(bin)
    const stub = path.join(ROOT_DIR, 'test', 'fixtures', 'acp-stub.mjs')
    fs.writeFileSync(path.join(bin, 'codex-acp'), `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`, { mode: 0o755 })
    const env = { HOME: setup.dir, XDG_CONFIG_HOME: setup.dir, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
    const key = path.join(setup.dir, 'fixture-key.pem'),
      cert = path.join(setup.dir, 'fixture-cert.pem')
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=fixture.example.ts.net'],
      { stdio: 'ignore' },
    )
    const tailscale = { host: 'fixture.example.ts.net', ownerLogin: 'owner@example.test' }
    const holder = {}
    const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
      req.headers['tailscale-user-login'] = tailscale.ownerLogin
      holder.app(req, res)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `https://${tailscale.host}:${server.address().port}`
    holder.app = createApp({
      config: setup.config,
      env,
      settingsToken: 'fixture-board-owner-unused',
      allowedHosts: new Set([tailscale.host]),
      remote: { tailscale },
      localAccounts: { db, origin },
    })
    registerProject(setup.config, env)
    writeServeState(setup.config, origin + '/')
    const serveFile = path.join(setup.config.outputDir, 'serve.json'),
      serveBefore = fs.readFileSync(serveFile, 'utf8'),
      indexBefore = fs.readFileSync(projectsFile(env), 'utf8')
    const { app: manager } = createAgentManagement({ config: setup.config, env, token: 'fixture-manager-owner' })
    const manageServer = manager.listen(0, '127.0.0.1')
    await once(manageServer, 'listening')
    const manageOrigin = `http://127.0.0.1:${manageServer.address().port}`
    const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP fixture.example.ts.net 127.0.0.1', '--no-proxy-server'] })
    const phone = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 900 },
      isMobile: true,
      hasTouch: true,
      reducedMotion: 'reduce',
    })
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
    const page = await phone.newPage(),
      settings = await desktop.newPage(),
      errors = []
    for (const tab of [page, settings]) tab.on('pageerror', (error) => errors.push(error.message))
    try {
      const cdp = await phone.newCDPSession(page)
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
      await page.goto(origin + '/account')
      await page.locator('[data-sw-local-account-name]').fill('Owner Fixture')
      await page.locator('[data-sw-local-account-handle]').fill('owner-fixture')
      await page.locator('[data-sw-local-account-create]').click()
      await page.locator('[data-sw-recovery-codes]').waitFor()
      await page.locator('#saved').click()
      await page.locator('[data-sw-codes-done]').click()
      await page.locator('[data-sw-profile-photo]').waitFor()
      await settings.goto(manageOrigin + '/#settings-token=fixture-manager-owner')
      await settings.locator('[data-sw-agent-management]').waitFor()
      assert.equal(await settings.locator('[data-sw-agent-project-root]').textContent(), fs.realpathSync(setup.config.dir))
      await settings.locator('[data-sw-profile-connect="codex"]').click()
      await settings.locator('[data-sw-settings-confirm-root]').waitFor()
      assert.equal(await settings.locator('[data-sw-settings-confirm-root]').textContent(), fs.realpathSync(setup.config.dir))
      await settings.locator('[data-sw-settings-confirm]').click()
      await settings.getByText(/Handshake ok, login not checked:/).waitFor()
      assert.equal(await settings.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0)
      for (const width of [1280, 390, 320]) {
        await settings.setViewportSize({ width, height: 900 })
        await settings.locator('[data-sw-agent-project-root]').scrollIntoViewIfNeeded()
        assert.equal(await settings.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        if (width < 600) assert.ok((await settings.locator('[data-sw-profile-connect="codex"]').boundingBox()).height >= 44)
        if (process.env.SHAPEWALL_SHOTS) {
          fs.mkdirSync(process.env.SHAPEWALL_SHOTS, { recursive: true })
          await settings.screenshot({ path: path.join(process.env.SHAPEWALL_SHOTS, `host-management-${width}.png`) })
        }
      }
      await page.goto(origin + '/?board=' + setup.config.boards[0].id)
      await page.locator('[data-sw-toolbar="compact"] [data-sw-menu]').click()
      await page.locator('[role="dialog"] [data-sw-chat-toggle]').click()
      await page.locator('[data-sw-chat-input]').fill('permission')
      await page.locator('[data-sw-chat-send]').click()
      await page.locator('[data-sw-chat-card="permission"][data-state="pending"] [data-sw-chat-permission-option="allow"]').click()
      await page.locator('[data-sw-chat-message="assistant"][data-status="done"]').waitFor()
      assert.match(await page.locator('[data-sw-chat-message="assistant"]').last().textContent(), /Permission: allow/)
      const readonly = await page.evaluate(async () => await (await fetch('/api/agent/settings')).json())
      assert.equal(readonly.editable, false)
      assert.equal(readonly.project, undefined)
      assert.equal(
        await page.evaluate(
          async () =>
            (
              await fetch('/api/agent/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{"settings":{}}',
              })
            ).status,
        ),
        403,
      )
      assert.equal(fs.readFileSync(serveFile, 'utf8'), serveBefore)
      assert.equal(fs.readFileSync(projectsFile(env), 'utf8'), indexBefore)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1)
      assert.deepEqual(errors, [])
      if (process.env.SHAPEWALL_SHOTS)
        await page.screenshot({ path: path.join(process.env.SHAPEWALL_SHOTS, 'phone-owner-native-chat.png') })
    } finally {
      await browser.close()
      manager.locals.close()
      manageServer.closeAllConnections()
      await new Promise((r) => manageServer.close(r))
      stopChildren(holder.app)
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
      db.close()
      await setup.close()
    }
  },
)
