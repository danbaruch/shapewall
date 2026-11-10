import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { createApp, stopChildren } from '../../src/server/app.js'
import { registerProject, projectId } from '../../src/local-projects.js'
import { writeServeState } from '../../src/serve-state.js'
import { ROOT_DIR, demoSetup, listen } from './helpers.js'

let browser
let projects
const apps = []
let env

before(async () => {
  projects = await Promise.all(['local-switch-alpha', 'local-switch-beta'].map(demoSetup))
  env = { ...process.env, XDG_CONFIG_HOME: path.join(projects[0].dir, 'settings'), SHAPEWALL_AGENT_SETTINGS_FILE: '' }
  for (const [index, project] of projects.entries()) {
    project.config.title = index ? 'Beta project' : 'Alpha project'
    // Persist the title: the other server reads this config from the index.
    const raw = JSON.parse(fs.readFileSync(project.config.file))
    raw.title = project.config.title
    fs.writeFileSync(project.config.file, JSON.stringify(raw))
    const app = createApp({ config: project.config, env, chat: false })
    const server = await listen(app)
    project.url = `http://127.0.0.1:${server.address().port}/`
    writeServeState(project.config, project.url)
    registerProject(project.config, env)
    apps.push({ app, server })
  }
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist/client/index.html')), 'build the client first')
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
  for (const { app, server } of apps) {
    stopChildren(app)
    await new Promise((resolve) => server.close(resolve))
  }
  for (const project of projects || []) await project.close()
})

for (const width of [1440, 390])
  test(`local projects at ${width}px: switch between isolated servers and back`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      await page.goto(projects[0].url)
      await page.locator('[data-sw-picker]').waitFor()
      await page.locator('[data-sw-picker]').click()
      const beta = page.locator(`[data-sw-local-project="${projectId(projects[1].config.file)}"]`)
      await beta.waitFor()
      assert.match(await beta.textContent(), /Beta project/)
      await beta.click()
      await page.waitForURL(projects[1].url)
      await page.locator('[data-sw-picker]').click()
      await page.locator(`[data-sw-local-project="${projectId(projects[0].config.file)}"]`).click()
      await page.waitForURL(projects[0].url)
      await page.locator('[data-sw-picker]').waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
