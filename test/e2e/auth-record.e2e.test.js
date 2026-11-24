// Controlled local sign-in only. No external account, password or personal profile.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright'
import { normalizeConfig } from '../../src/config.js'
import { recordCaptureAuth } from '../../src/auth/record.js'
import { runCapture } from '../../src/capture/capture.js'
import { tempDir } from '../helpers.js'

async function fixture(t) {
  const site = http.createServer(async (req, res) => {
    const authorized = (req.headers.cookie || '').includes('fixture-session=fictional-test-session')
    if (req.url === '/session' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      assert.equal(new URLSearchParams(body).get('account'), 'fictional-reviewer')
      res.writeHead(303, { 'Set-Cookie': 'fixture-session=fictional-test-session; HttpOnly; SameSite=Lax; Path=/', Location: '/private' })
      res.end()
    } else if (req.url === '/private') {
      res.writeHead(authorized ? 200 : 401, { 'Content-Type': 'text/html' })
      res.end(
        authorized
          ? '<!doctype html><h1>Signed in fixture</h1><script>localStorage.setItem("fixture-preference", "fixture-only-value")</script>'
          : '<!doctype html><h1>Sign in required</h1>',
      )
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(
        '<!doctype html><form action="/session" method="post"><label>Fixture account<input name="account"></label><button>Sign in to fixture</button></form>',
      )
    }
  })
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => site.close(resolve)))
  const origin = `http://127.0.0.1:${site.address().port}`
  const dir = tempDir('auth-record-browser')
  const config = normalizeConfig(
    {
      title: 'Fictional auth fixture',
      id: 'fixture',
      baseUrl: origin,
      pages: [{ id: 'private', path: '/private', title: 'Private fixture' }],
      viewports: { desktop: { width: 640, height: 480, deviceScaleFactor: 1, isMobile: false, hasTouch: false } },
      waitFor: 0,
      timeouts: { page: 10000, settle: 100 },
    },
    { dir, file: path.join(dir, 'shapewall.config.json') },
  )
  return { origin, config }
}

test('manual-finish recording loads a protected capture using saved cookies and localStorage', async (t) => {
  const { origin, config } = await fixture(t)
  const output = []
  let browser
  let requestedOptions
  const recorded = await recordCaptureAuth({
    config,
    url: `${origin}/login?fixture-token=never-print-this-query`,
    timeoutMs: 20000,
    out: (line) => output.push(line),
    // Production requests a headed isolated browser. This test alone uses headless Chromium.
    launch: async (options) => {
      requestedOptions = options
      browser = await chromium.launch({ ...options, headless: true })
      return browser
    },
    finish: async ({ page, context }) => {
      assert.equal((await context.cookies()).length, 0, 'new profile starts without existing account cookies')
      await page.getByLabel('Fixture account').fill('fictional-reviewer')
      await page.getByRole('button', { name: 'Sign in to fixture' }).click()
      await page.getByRole('heading', { name: 'Signed in fixture' }).waitFor()
    },
  })
  assert.equal(requestedOptions.headless, false)
  assert.equal(browser.isConnected(), false, 'the recording browser closes after saving')
  assert.doesNotMatch(output.join('\n'), /never-print|fictional-test-session|127\.0\.0\.1|http:/)
  const state = JSON.parse(fs.readFileSync(recorded.file, 'utf8'))
  assert.equal(state.cookies.find((cookie) => cookie.name === 'fixture-session').value, 'fictional-test-session')
  assert.equal(state.origins[0].localStorage.find((item) => item.name === 'fixture-preference').value, 'fixture-only-value')
  if (process.platform !== 'win32') assert.equal(fs.statSync(recorded.file).mode & 0o777, 0o600)
  const capturing = { ...config, auth: { storageState: recorded.file, loginScript: null } }
  const result = await runCapture({ config: capturing, log: () => {} })
  assert.equal(result.failed, 0)
  const html = fs.readFileSync(path.join(result.dir, 'private.desktop.html'), 'utf8')
  assert.match(html, /Signed in fixture/)
  assert.doesNotMatch(html, /Sign in required/)
})

test('closing the real isolated recording browser discards state', async (t) => {
  const { origin, config } = await fixture(t)
  let browser
  await assert.rejects(
    recordCaptureAuth({
      config,
      url: `${origin}/login`,
      timeoutMs: 10000,
      launch: async (options) => {
        browser = await chromium.launch({ ...options, headless: true })
        return browser
      },
      finish: async () => {
        await browser.close()
      },
    }),
    { code: 'auth_cancelled' },
  )
  assert.equal(fs.existsSync(path.join(config.dir, '.shapewall-auth', 'fixture.auth.json')), false)
  assert.equal(fs.existsSync(path.join(config.dir, '.shapewall-auth', '.record.lock')), false)
})
