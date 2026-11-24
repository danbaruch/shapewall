// End to end: GitHub connect on the board, against a stub GitHub API (no
// real GitHub calls). "GitHub issue" on a comment opens an issue and shows
// its link; a signed webhook for a merged pull request resolves the comment,
// and the board shows the PR, the fix and the reply. Desktop and phone.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createHmac } from 'node:crypto'
import { chromium } from 'playwright'
import { runCapture } from '../../src/capture/capture.js'
import { normalizeConfig } from '../../src/config.js'
import { createApp } from '../../src/server/app.js'
import { createComment, getComment } from '../../src/store.js'
import { ROOT_DIR, demoSetup, listen } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const TOKEN = 'ghp_e2e_not_a_real_token'
const SECRET = 'e2e-webhook-secret'
let setup
let config
let stub
let server
let browser
let boardUrl
const issues = []

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the e2e tests')
  setup = await demoSetup('github-e2e')
  const raw = JSON.parse(fs.readFileSync(setup.config.file, 'utf8'))
  raw.github = { repo: 'acme/site' }
  fs.writeFileSync(setup.config.file, JSON.stringify(raw, null, 2))
  config = normalizeConfig(raw, { dir: setup.dir, file: setup.config.file })
  await runCapture({ config, only: ['pricing'], log: () => {} })
  stub = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end('{"message":"Bad credentials"}')
      if (req.method === 'POST' && req.url === '/repos/acme/site/issues') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const number = 100 + issues.length
        issues.push(body)
        return res
          .writeHead(201)
          .end(JSON.stringify({ number, html_url: `https://github.com/acme/site/issues/${number}`, title: body.title }))
      }
      res.writeHead(404).end('{"message":"Not Found"}')
    })
  })
  await listen(stub)
  const app = createApp({
    config,
    env: {
      SHAPEWALL_GITHUB_API_URL: `http://127.0.0.1:${stub.address().port}`,
      GITHUB_TOKEN: TOKEN,
      SHAPEWALL_GITHUB_WEBHOOK_SECRET: SECRET,
    },
  })
  server = await listen(app)
  boardUrl = `http://127.0.0.1:${server.address().port}/`
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})

after(async () => {
  await browser?.close()
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  await new Promise((resolve) => (stub ? stub.close(resolve) : resolve()))
  await setup?.close()
})

async function mergedWebhook(commentId, number) {
  const body = JSON.stringify({
    action: 'closed',
    repository: { full_name: 'acme/site' },
    pull_request: {
      number,
      html_url: `https://github.com/acme/site/pull/${number}`,
      title: 'Bolder Plus button',
      body: `Fixes shapewall#${commentId}`,
      state: 'closed',
      merged_at: '2026-11-04T12:00:00Z',
    },
  })
  const response = await fetch(`${boardUrl}api/github/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
    },
    body,
  })
  assert.equal(response.status, 200)
  return response.json()
}

test('phone comment link opens after the board renders before the comments response', async () => {
  const comment = await createComment(config, config.boards[0], {
    pageId: 'pricing',
    viewport: 'desktop',
    x: 50,
    y: 30,
    body: 'Delayed comment response',
    author: 'Robin',
  })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  await page.route('**/api/boards/demo/comments', async (route) => {
    const response = await route.fetch()
    await gate
    await route.fulfill({ response })
  })
  try {
    await page.goto(`${boardUrl}?filter=all&c=${comment.id}`)
    await page.waitForSelector('[data-sw-node="pricing"]')
    // Give layout/effects two rendered frames with comments still pending.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await page.locator(`[data-sw-selected-comment="${comment.id}"]`).count(), 0)
    release()
    await page.waitForSelector(`[data-sw-selected-comment="${comment.id}"]`)
    assert.equal(new URL(page.url()).searchParams.get('c'), String(comment.id))
  } finally {
    release()
    await context.close()
  }
})

for (const [name, contextOptions] of [
  ['desktop', { viewport: { width: 1440, height: 900 } }],
  ['phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
]) {
  test(`GitHub issue from a comment and a merged PR resolving it (${name})`, async () => {
    const comment = await createComment(config, config.boards[0], {
      pageId: 'pricing',
      viewport: 'desktop',
      x: 50,
      y: 30,
      body: `Make the Plus button stand out (${name})`,
      author: 'Robin',
    })
    const context = await browser.newContext(contextOptions)
    const page = await context.newPage()
    const errors = []
    page.on('console', (message) => message.type() === 'error' && errors.push(message.text()))
    page.on('pageerror', (error) => errors.push(error.message))
    // On a phone the comments live in a sheet: open it, then the comment.
    const openComment = async () => {
      await page.goto(`${boardUrl}?filter=all&c=${comment.id}`)
      // The link opens the thread: at its pin, or as a sheet on a phone.
      await page.waitForSelector(`[data-sw-selected-comment="${comment.id}"]`)
    }
    try {
      await openComment()
      // Create an issue is in the thread's more menu.
      await page.click(`[data-sw-thread-menu="${comment.id}"]`)
      const button = page.locator(`[role="menu"] [data-sw-github-issue="${comment.id}"]`).first()
      await button.waitFor()
      // Measured once the menu's open animation has finished.
      await page.waitForFunction(() =>
        document
          .querySelector('[role="menu"]')
          ?.getAnimations({ subtree: true })
          .every((item) => item.playState === 'finished'),
      )
      if (name === 'phone') assert.ok((await button.boundingBox()).height >= 44, 'touch target')
      await button.click()
      const issueLink = page.locator('[data-sw-github-issue-link]').first()
      await issueLink.waitFor()
      const number = Number(await issueLink.getAttribute('data-sw-github-issue-link'))
      assert.equal(await issueLink.getAttribute('href'), `https://github.com/acme/site/issues/${number}`)
      assert.equal(await page.locator(`[data-sw-github-issue="${comment.id}"]`).count(), 0, 'the button goes once there is an issue')
      const sent = issues.at(-1)
      assert.match(sent.title, /^Pricing: Make the Plus button stand out/)
      assert.match(sent.body, new RegExp(`api/boards/demo/captures/pricing\\.desktop\\.png`))
      assert.match(sent.body, new RegExp(`\\?board=demo&filter=all&c=${comment.id}`))
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `github-issue-${name}.png`) })

      const result = await mergedWebhook(comment.id, 7 + comment.id)
      assert.equal(result.merged.length, 1)
      assert.equal(getComment(config, 'demo', comment.id).status, 'resolved')
      await openComment()
      const pull = page.locator(`[data-sw-github-pull="${7 + comment.id}"]`).first()
      await pull.waitFor()
      assert.equal(await pull.getAttribute('data-sw-github-pull-state'), 'merged')
      await page.locator(`[data-sw-reopen="${comment.id}"]`).first().waitFor()
      assert.ok(await page.locator('[data-sw-fix-ref]').first().isVisible())
      assert.match(await page.locator('[data-sw-replies]').first().innerText(), /Merged pull request #\d+ \(Bolder Plus button\)/)
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `github-merged-${name}.png`) })
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
}
