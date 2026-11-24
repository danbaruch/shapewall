// The host-only sharing dialog uses the real push/import pipeline and the
// migration banner keeps captures available while local comments are locked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { saveCredential } from '../../src/remote/credentials.js'
import { createApp } from '../../src/server/app.js'
import { createComment } from '../../src/store.js'
import { loadConfig } from '../../src/config.js'
import { createBrowser, createProject, signUp, startHostedServer, writeLocalCaptures } from '../hosted-helpers.js'
import { SAMPLE, tempDir } from '../helpers.js'
import { listen } from './helpers.js'

for (const width of [1440, 390])
  test(`share a local board through the dialog at ${width}px`, { timeout: 60000 }, async () => {
    const hosted = await startHostedServer(`bridge-ui-${width}`)
    let browser, server
    try {
      const owner = await signUp(hosted, { handle: `bridge${width}` })
      const project = await createProject(owner, owner.workspaceId, 'Shared fixture')
      const device = createBrowser(hosted.port, hosted.origin)
      const started = await device.post('/api/v1/device/start', { name: 'UI fixture', purpose: 'import' })
      const approved = await owner.browser.post('/api/device/approve', {
        code: started.json.userCode,
        workspaceId: owner.workspaceId,
        projectId: project.id,
        scopes: ['read', 'push', 'import'],
      })
      assert.equal(approved.status, 200, approved.text)
      const polled = await device.post('/api/v1/device/poll', { deviceCode: started.json.deviceCode })
      const dir = tempDir(`bridge-ui-${width}`)
      const file = path.join(dir, 'shapewall.config.json')
      fs.writeFileSync(file, JSON.stringify(SAMPLE))
      const config = loadConfig(file)
      writeLocalCaptures(config, 'sample')
      await createComment(config, config.boards[0], {
        pageId: 'home',
        viewport: 'desktop',
        x: 15,
        y: 25,
        body: 'Move this comment',
        author: 'Local reviewer',
      })
      const env = { XDG_CONFIG_HOME: path.join(dir, 'owner-config') }
      if (width === 390) saveCredential(hosted.origin, { token: polled.json.token, scopes: ['read', 'push', 'import'] }, env)
      let destinationId = project.id
      const app = createApp({
        config,
        settingsToken: 'ui-fixture-settings-capability',
        chat: false,
        env,
        log: () => {},
      })
      server = await listen(app)
      browser = await chromium.launch()
      const context = await browser.newContext({ viewport: { width, height: 900 } })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text())
      })
      await page.addInitScript(() => localStorage.setItem('shapewall.tip.board', '1'))
      await page.goto(`http://127.0.0.1:${server.address().port}/#settings-token=ui-fixture-settings-capability`)
      await page.waitForSelector('[data-sw-profile-menu]')
      await page.click('[data-sw-profile-menu]')
      await page.click('[data-sw-profile-item="share"]')
      await page.fill('[data-sw-share-remote]', hosted.origin)
      await page.click('[data-sw-share-start]')
      if (width === 1440) {
        // The actual UI handoff: no preexisting login, create a destination
        // project, and opt in to the unchecked one-time import grant.
        await page.waitForFunction(() => /[A-Z]{4}-[A-Z]{4}/.test(document.querySelector('[data-sw-share-progress]')?.textContent || ''))
        const code = (await page.locator('[data-sw-share-progress]').innerText()).match(/[A-Z]{4}-[A-Z]{4}/)[0]
        await context.addCookies(
          [...owner.browser.jar].map(([name, value]) => ({ name, value, url: hosted.origin, httpOnly: true, sameSite: 'Lax' })),
        )
        const approvalPage = await context.newPage()
        await approvalPage.goto(`${hosted.origin}/device`)
        await approvalPage.fill('[data-sw-device-code]', code)
        await approvalPage.click('[data-sw-device-lookup]')
        await approvalPage.waitForSelector('#device-scope-import')
        assert.equal(await approvalPage.locator('#device-scope-import').getAttribute('aria-checked'), 'false')
        await approvalPage.click('[data-sw-device-project]')
        await approvalPage.getByRole('option', { name: 'Create a project', exact: true }).click()
        await approvalPage.fill('[data-sw-device-new-project]', 'Created in browser')
        await approvalPage.click('#device-scope-import')
        await approvalPage.click('[data-sw-device-approve]')
        await approvalPage.waitForSelector('[data-sw-device-done="approved"]')
        destinationId = hosted.db.prepare('SELECT id FROM projects WHERE name=?').get('Created in browser').id
        await approvalPage.close()
      }
      await page.waitForSelector('[data-sw-share-done]', { timeout: 30000 })
      if (process.env.SHAPEWALL_SHOTS) {
        fs.mkdirSync(process.env.SHAPEWALL_SHOTS, { recursive: true })
        await page.screenshot({
          path: path.join(process.env.SHAPEWALL_SHOTS, `bridge-dialog-${width}.png`),
          fullPage: true,
          animations: 'disabled',
        })
      }
      await page.click('[aria-label="Close"]')
      await page.waitForSelector('[data-sw-migration-banner]')
      assert.match(await page.locator('[data-sw-migration-banner]').innerText(), /Local comments are read-only/)
      const first = hosted.db.prepare('SELECT * FROM comments WHERE project_id=?').get(destinationId)
      assert.equal(first.body, 'Move this comment')
      assert.equal(first.author_user_id, null)
      assert.equal(await page.locator('[data-sw-comment-mode]').count(), 0, 'comment mode stays hidden after move')
      await page.click('[data-sw-local-comments]')
      await page.waitForFunction(() =>
        document.querySelector('[data-sw-migration-banner]')?.textContent.includes('This local copy is independent'),
      )
      assert.ok(await page.locator('[data-sw-comment-mode]').count())
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
      if (process.env.SHAPEWALL_SHOTS) {
        fs.mkdirSync(process.env.SHAPEWALL_SHOTS, { recursive: true })
        await page.screenshot({
          path: path.join(process.env.SHAPEWALL_SHOTS, `bridge-${width}.png`),
          fullPage: true,
          animations: 'disabled',
        })
      }
      assert.deepEqual(errors, [])
      await context.close()
    } finally {
      await browser?.close()
      if (server)
        await new Promise((resolve) => {
          server.closeAllConnections?.()
          server.close(resolve)
        })
      await hosted.close()
    }
  })
