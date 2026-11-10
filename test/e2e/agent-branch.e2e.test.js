// Agent branch mode in a real browser: turn it on in the chat settings, fix a
// comment (the scripted ACP fixture in its "branch" mode, which also checks
// it runs in the worktree and cannot write to the checkout), see "Fix ready
// on branch", Apply (the checkout changes, the page is recaptured with before
// and after), Discard with its confirm, and the conflict message. No model calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import { loadConfig } from '../../src/config.js'
import { runCapture } from '../../src/capture/capture.js'
import { createApp, stopChildren } from '../../src/server/app.js'
import { createComment, getComment, currentVersion } from '../../src/store.js'
import { tempDir } from '../helpers.js'
import { ROOT_DIR, listen } from './helpers.js'

const fixture = path.join(ROOT_DIR, 'test/fixtures/acp-fix.mjs')
const token = 'branch-owner-token'
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
for (const key of Object.keys(gitEnv)) if (key.startsWith('GIT_') && key !== 'GIT_CONFIG_NOSYSTEM') delete gitEnv[key]
const sh = (cwd, ...args) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: gitEnv,
  }).trim()

test('branch mode: turn on, fix, Fix ready on branch, Apply with recapture, Discard, and a conflict that changes nothing', async () => {
  const dir = tempDir('branch-browser')
  const source = path.join(dir, 'index.html')
  const original = '<!doctype html><html><body><h1>Original branch heading</h1></body></html>\n'
  fs.writeFileSync(source, original)
  const site = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end(fs.readFileSync(source))
  })
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
  const raw = {
    title: 'Branch wall',
    id: 'branchy',
    baseUrl: `http://127.0.0.1:${site.address().port}`,
    viewports: { desktop: { width: 1440, height: 900 } },
    pages: [{ id: 'home', path: '/', title: 'Home' }],
  }
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(raw))
  fs.writeFileSync(path.join(dir, '.gitignore'), '.shapewall/\nprivate/\n')
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, 'config', 'user.name', 'Branch Person')
  sh(dir, 'config', 'user.email', 'branch@example.com')
  sh(dir, 'add', '.')
  sh(dir, 'commit', '-q', '-m', 'start')
  const config = loadConfig(file)
  const board = config.boards[0]
  let browser
  let server
  let app
  try {
    await runCapture({ config, log: () => {} })
    const privateDir = path.join(dir, 'private')
    fs.mkdirSync(privateDir, { mode: 0o700 })
    const env = { ...process.env, XDG_CONFIG_HOME: privateDir, SHAPEWALL_AGENT_SETTINGS_FILE: path.join(privateDir, 'agents.json') }
    delete env.SHAPEWALL_AGENT_BRANCH_MODE
    delete env.SHAPEWALL_AGENT_BRANCH_PREFIX
    app = createApp({ config, env, settingsToken: token, agentAcp: `${process.execPath} ${fixture} branch`, agentLimits: { burst: 100 } })
    server = await listen(app)
    const url = `http://127.0.0.1:${server.address().port}/?board=branchy#settings-token=${token}`
    browser = await chromium.launch()
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      // The conflict is a 409 the page shows; the browser logs the failed request too.
      if (message.type() === 'error' && !/409/.test(message.text())) errors.push(message.text())
    })
    const open = async () => {
      await page.goto(url)
      await page.waitForSelector('[data-sw-node="home"]')
    }
    const fixFromBoard = async (comment) => {
      await open()
      await page.locator(`[data-sw-comment="${comment.id}"]`).first().click()
      await page.locator(`[data-sw-fix-agent="${comment.id}"]`).click()
      await page.locator('[data-sw-chat-branch-apply]').last().waitFor({ timeout: 30000 })
      assert.equal(getComment(config, board.id, comment.id).agentStatus, 'branch-ready')
    }
    const newComment = (body, x) => createComment(config, board, { pageId: 'home', viewport: 'desktop', x, y: 10, body, author: 'Owner' })

    // Turn it on from the chat settings.
    await open()
    await page.click('[data-sw-chat-toggle]')
    await page.click('[data-sw-chat-settings]')
    await page.locator('[data-sw-chat-branch-mode="off"]').waitFor()
    await page.click('[data-sw-chat-branch-mode-switch]')
    await page.locator('[data-sw-chat-branch-mode="on"]').waitFor()
    assert.match(
      await page.locator('[data-sw-chat-branch-mode="on"]').textContent(),
      /Uncommitted changes in your checkout are not carried over/,
    )
    await page.keyboard.press('Escape')

    // Fix: the checkout is untouched, the thread says where the fix waits.
    const first = await newComment('Fix the branch heading', 20)
    const before = currentVersion(config, board.id, 'home', 'desktop')
    await fixFromBoard(first)
    assert.equal(fs.readFileSync(source, 'utf8'), original)
    const name = getComment(config, board.id, first.id).agentBranch
    assert.match(name, /^shapewall\/comment-\d+-fix-the-branch-heading$/)
    assert.equal(await page.locator('[data-sw-chat-branch-copy]').last().getAttribute('data-sw-chat-branch-copy'), name)
    assert.ok((await page.locator('[data-sw-chat-summary-recapture]').count()) === 0, 'nothing to recapture before Apply')
    await open()
    await page.locator(`[data-sw-comment="${first.id}"]`).first().click()
    const chip = page.locator(`[data-sw-thread="${first.id}"] [data-sw-agent-status="branch-ready"]`)
    await chip.waitFor()
    assert.match(await chip.textContent(), new RegExp(`Fix ready on branch\\s*${name.replace('/', '\\/')}`))

    // Apply: the checkout gets the fix and the page is recaptured with before and after.
    await page.locator(`[data-sw-fix-agent-open="${first.id}"]`).click()
    await page.locator('[data-sw-chat-branch-apply]').last().click()
    await page.locator('[data-sw-chat-branch="applied"]').last().waitFor({ timeout: 30000 })
    assert.match(fs.readFileSync(source, 'utf8'), /Fixed fixture heading/)
    assert.equal(
      sh(dir, 'log', '-1', '--format=%an <%ae>%n%s'),
      `Branch Person <branch@example.com>\nFix comment #${first.id}: Fix the branch heading`,
    )
    assert.equal(sh(dir, 'status', '--porcelain', '--untracked-files=no'), '')
    assert.equal(sh(dir, 'branch', '--list', 'shapewall/*'), '', 'the branch is gone after Apply')
    let saved
    for (let attempt = 0; attempt < 100; attempt++) {
      saved = getComment(config, board.id, first.id)
      if (saved.agentStatus === 'done') break
      await page.waitForTimeout(100)
    }
    assert.equal(saved.agentStatus, 'done', JSON.stringify(saved))
    assert.notEqual(currentVersion(config, board.id, 'home', 'desktop'), before)
    assert.ok(saved.replies.some((reply) => /Before and after/.test(reply.body)))
    await open()
    await page.locator(`[data-sw-comment="${first.id}"]`).first().click()
    await page.waitForSelector('[data-sw-before-after="ready"]')
    assert.equal(
      fs.existsSync(path.join(dir, '.shapewall', 'agent-worktrees')) &&
        fs.readdirSync(path.join(dir, '.shapewall', 'agent-worktrees')).length,
      0,
    )

    // Discard asks first, then deletes the branch; the checkout stays as it is.
    fs.writeFileSync(source, original)
    sh(dir, 'commit', '-q', '-am', 'back to the original')
    const head = sh(dir, 'rev-parse', 'HEAD')
    const second = await newComment('Try another heading', 40)
    await fixFromBoard(second)
    await page.locator('[data-sw-chat-branch-discard]').last().click()
    await page.locator('[data-sw-chat-branch-discard-confirm]').click()
    await page.locator('[data-sw-chat-branch="discarded"]').last().waitFor({ timeout: 15000 })
    assert.equal(sh(dir, 'branch', '--list', 'shapewall/*'), '')
    assert.equal(sh(dir, 'rev-parse', 'HEAD'), head)
    assert.equal(getComment(config, board.id, second.id).agentStatus, 'needs-human')

    // A conflict: the checkout changed the same line since. Apply explains and changes nothing.
    const third = await newComment('One more heading', 60)
    await fixFromBoard(third)
    fs.writeFileSync(source, '<!doctype html><html><body><h1>Changed by hand</h1></body></html>\n')
    sh(dir, 'commit', '-q', '-am', 'by hand')
    const moved = sh(dir, 'rev-parse', 'HEAD')
    await page.locator('[data-sw-chat-branch-apply]').last().click()
    const error = page.locator('[data-sw-chat-branch-error]').last()
    await error.waitFor({ timeout: 15000 })
    assert.match(await error.textContent(), /conflicts with your checkout in index\.html\. Nothing was changed/)
    assert.equal(sh(dir, 'rev-parse', 'HEAD'), moved)
    assert.match(fs.readFileSync(source, 'utf8'), /Changed by hand/)
    assert.equal(sh(dir, 'status', '--porcelain', '--untracked-files=no'), '')
    assert.equal(getComment(config, board.id, third.id).agentStatus, 'branch-ready', 'still waiting on its branch')
    assert.equal(await page.getByText('Files in your own checkout changed').count(), 0, 'nothing wrote to the checkout during a turn')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
    if (process.env.SHAPEWALL_SHOTS) {
      fs.mkdirSync(process.env.SHAPEWALL_SHOTS, { recursive: true })
      await page.screenshot({ path: path.join(process.env.SHAPEWALL_SHOTS, 'agent-branch.png') })
    }
    assert.deepEqual(errors, [])
    await context.close()
  } finally {
    await browser?.close()
    if (app) stopChildren(app)
    if (server) await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => site.close(resolve))
  }
})
